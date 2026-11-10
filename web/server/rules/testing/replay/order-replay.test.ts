import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { staffSees } from '@/server/rules/orders/failure-messages'
import { compareRecordings, type Recording } from './compare'
import { readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { NEW_SIDE_CONFIRMS, NOT_BUILT_SCENARIOS, ORDER_SCENARIOS, orderDifferences, OUTCOME_DIFFERS } from './order-differences'
import { newOrderSide, type OrderAnswer } from './order-side'
import { ID, scenarios } from './scenarios'

// The order route's parity proof (W03-plan 3.1 layer 1): each scenario in W06's to W08's scope runs
// from the same seed through the new order route, and its rows (in the order the app reads them), its
// answer and its money must match what the old createOrder wrote, saved in the golden file, except the
// differences named in order-differences.ts. A golden file is the old function's own recording, so
// this still holds the route to it after the old code goes.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
// W10: the order route charges each run's own FakeStripe (stripe-binding.ts).
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('./stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const byName = (name: string): Scenario => {
  const scenario = scenarios.find((s) => s.name === name)
  if (!scenario) throw new Error(`No scenario ${name}`)
  return scenario
}

describe('the order route against the old createOrder', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  async function runNew(name: string): Promise<{ recording: Recording; answers: OrderAnswer[] }> {
    const answers: OrderAnswer[] = []
    const confirms = NEW_SIDE_CONFIRMS[name]
    const recording = await replay(
      environment,
      byName(name),
      newOrderSide(answers, (input) => (confirms ? { ...input, confirmed: { ...input.confirmed, toCollect: confirms.toCollect } } : input))
    )
    return { recording, answers }
  }

  describe.each(ORDER_SCENARIOS)('%s', (name) => {
    it('writes what the old function wrote, in the same order, and answers the same', async () => {
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()
      const { recording, answers } = await runNew(name)
      const placed = answers[0]?.body.ok === true
      expect(compareRecordings(golden, recording, orderDifferences(placed, name))).toEqual([])
    })

    it.skipIf(OUTCOME_DIFFERS.includes(name))('tells staff what the screen told them', async () => {
      const golden = readGolden(name) as Recording
      const old = golden.results[0] as { success: boolean; reason?: string; message?: string; amountDueTotal?: number }
      const { answers } = await runNew(name)
      const body = answers[0]?.body
      if (old.success) {
        expect(body?.ok).toBe(true)
        return
      }
      expect(body?.ok).toBe(false)
      if (body && !body.ok) expect(body.error.message).toBe(staffSees({ reason: old.reason as string, message: old.message, amountDueTotal: old.amountDueTotal }))
    })
  })

  describe('row order', () => {
    it('the seats keep their order, though now() does not move inside the transaction', async () => {
      const { recording } = await runNew('w06-a-full-public-party')
      expect(recording.tables['booking_guests']?.tied).toBe(0)
      expect(recording.tables['booking_guests']?.added.map((seat) => seat['guest_type'])).toEqual([
        'account_holder',
        'additional_guest',
        'additional_guest',
        'additional_guest',
        'additional_guest',
        'additional_guest',
      ])
    })

    it('the order lines and the booking add-ons keep theirs', async () => {
      const lines = (await runNew('w06-booking-and-a-standalone-addon-in-cash')).recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'addon'])
      const addons = (await runNew('w06-two-addon-credits-on-one-membership')).recording.tables['addon_order_lines']
      expect(addons?.tied).toBe(0)
      expect(addons?.added.map((line) => line['sku_at_purchase'])).toEqual(['TOWEL', 'ROBE'])
    })

    it('the two audit rows are in order: created, then paid', async () => {
      const audit = (await runNew('cash-booking-two-guests-addon')).recording.tables['audit_log']
      expect(audit?.tied).toBe(0)
      expect(audit?.added.map((row) => row['action'])).toEqual(['order.create', 'order.paid'])
    })
  })

  describe('W07: the outcome the address decision changes', () => {
    it('a failed address save: the old order was kept with a warning; the new one is refused, with nothing kept', async () => {
      const golden = readGolden('w07-address-save-fails') as Recording
      expect(golden.results[0]).toMatchObject({ success: true, warning: expect.stringContaining("saving the delivery address to the customer's profile failed") })
      expect(golden.tables['orders']?.added).toMatchObject([{ payment_status: 'paid', payment_method: 'cash' }])
      const { recording, answers } = await runNew('w07-address-save-fails')
      expect(answers[0]?.status).toBe(500)
      expect(answers[0]?.body).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong and the action may not have finished. Check before trying again.' } })
      expect(Object.keys(recording.tables)).toEqual(['api_idempotency'])
    })
  })

  describe('W10: the outcome W03-plan 2.5 changes', () => {
    it('an unclear answer: the old order was rolled back as a decline; the new one is held pending with its claims, never undone', async () => {
      const golden = readGolden('w10-unclear-answer') as Recording
      expect(golden.results[0]).toMatchObject({ success: false, reason: 'charge_failed', message: 'Failed to charge saved card: An error occurred with our API.' })
      expect(golden.stripeCalls).toHaveLength(1)
      expect(golden.tables).toEqual({})
      const { recording, answers } = await runNew('w10-unclear-answer')
      expect(answers[0]?.status).toBe(502)
      expect(answers[0]?.body).toMatchObject({ ok: false, error: { code: 'PAYMENT_UNCONFIRMED', details: { stage: 'payment', reason: 'payment_unconfirmed' } } })
      // The same request twice under the same key: Stripe kept the 500 against it.
      expect(recording.stripeCalls.map((call) => call.idempotencyKey)).toEqual(['orders#1:charge', 'orders#1:charge'])
      expect(recording.tables['orders']?.added).toMatchObject([{ payment_status: 'pending', payment_method: 'card' }])
      expect(recording.tables['customers']?.changed).toEqual([{ id: ID.customer, store_credit_balance: ['30.00', '20.00'] }])
      expect(recording.tables['sessions']?.changed).toEqual([{ id: ID.session, total_booked: [0, 1] }])
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create'])
    })
  })

  describe('W10: row order', () => {
    it("the card order's rows keep createOrder's order, and its audit rows come create, then paid", async () => {
      const { recording } = await runNew('w10-card-every-kind')
      const lines = recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'event', 'addon', 'product', 'session_pass', 'gift_card'])
      expect(recording.tables['booking_guests']?.tied).toBe(0)
      expect(recording.tables['event_attendees']?.tied).toBe(0)
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create', 'order.paid'])
    })
  })

  describe('W07: row order', () => {
    it('every kind of line in createOrder\'s order, and the booking line among them', async () => {
      const lines = (await runNew('w07-every-kind-in-cash')).recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'addon', 'product', 'session_pass', 'gift_card'])
    })

    it('a buy-new pass comes before the booking it pays for, and postage last', async () => {
      const { recording } = await runNew('w07-worst-basket')
      expect(recording.tables['order_line_items']?.tied).toBe(0)
      expect(recording.tables['order_line_items']?.added.map((line) => line['item_type'])).toEqual(['session_pass', 'booking', 'product', 'product', 'gift_card', 'postage'])
      expect(recording.tables['stock_adjustments']?.tied).toBe(0)
      expect(recording.tables['stock_adjustments']?.added.map((row) => row['variant_id'])).toEqual([ID.candleVariant, ID.mugVariant])
    })

    it('two lines of one variant: two ledger rows in line order, one claim', async () => {
      const { recording } = await runNew('w07-two-lines-of-one-variant-take-the-last-stock')
      expect(recording.tables['stock_adjustments']?.added.map((row) => row['change_amount'])).toEqual([-2, -3])
      expect(recording.tables['product_variants']?.changed).toEqual([{ id: ID.variant, stock_quantity: [5, 0] }])
    })
  })

  describe('W08: row order', () => {
    it('the attendees in place order, the account holder first though listed second, none tied', async () => {
      const { recording } = await runNew('w08-event-account-holder-listed-second')
      expect(recording.tables['event_attendees']?.tied).toBe(0)
      expect(recording.tables['event_attendees']?.added.map((row) => [row['attendee_type'], row['name']])).toEqual([
        ['account_holder', 'Sam Test'],
        ['guest', 'Alex Guest'],
      ])
    })

    it("the event's line after the booking's, before the add-ons, as createOrder wrote them", async () => {
      const lines = (await runNew('w08-every-kind-in-cash')).recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'event', 'addon', 'product', 'session_pass', 'gift_card'])
      expect(lines?.added[1]).toMatchObject({ event_booking_id: 'event_bookings#1', quantity: 2, unit_price: '40.00', line_total: '80.00' })
    })

    it('the worst basket: booking, event, product, gift card, postage; three attendees in place order', async () => {
      const { recording } = await runNew('w08-worst-basket')
      expect(recording.tables['order_line_items']?.added.map((line) => line['item_type'])).toEqual(['booking', 'event', 'product', 'gift_card', 'postage'])
      expect(recording.tables['event_attendees']?.tied).toBe(0)
      expect(recording.tables['event_attendees']?.added.map((row) => row['name'])).toEqual(['Sam Test', 'Alex Guest', 'Bea Guest'])
      expect(recording.tables['events']?.changed).toEqual([{ id: ID.event, places_booked: [0, 3] }])
    })
  })

  describe.each(Object.entries(NOT_BUILT_SCENARIOS))('%s is not built yet', (name, parts) => {
    it('answers NOT_BUILT, naming what, before anything is written', async () => {
      const { recording, answers } = await runNew(name)
      expect(answers[0]?.status).toBe(501)
      expect(answers[0]?.body).toMatchObject({ ok: false, error: { code: 'NOT_BUILT', details: { notBuilt: parts } } })
      expect(Object.keys(recording.tables)).toEqual(['api_idempotency'])
    })
  })
})
