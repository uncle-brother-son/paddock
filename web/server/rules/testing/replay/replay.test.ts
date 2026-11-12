import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { buildRecording, compareRecordings, type Difference, type RawRun, type Recording } from './compare'
import { oldSide, readGolden, replay, startReplay, writeGolden, type ReplayEnvironment, type ReplayOptions, type ReplaySide } from './harness'
import { scenarios } from './scenarios'

// W20a (W20 review, run 5's timing): each test here takes about 0.2 s alone, but one stalled past the default 5 s once
// under full-suite load. 15 s is three times the worst stall seen; a stall past it is no longer load, so capture which
// step it was in before rerunning.
vi.setConfig({ testTimeout: 15_000 })

// To re-record after a deliberate change to an old function or scenario:
//   UPDATE_GOLDEN=1 npm run test:unit -- server/rules/testing/replay
const updating = process.env.UPDATE_GOLDEN === '1'

const byName = (name: string) => {
  const scenario = scenarios.find((s) => s.name === name)
  if (!scenario) throw new Error(`No scenario ${name}`)
  return scenario
}

const CASH = 'cash-booking-two-guests-addon'
const CARD = 'saved-card-product-gift-card-store-credit'

describe('replay of the old functions', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  const run = (name: string, options?: ReplayOptions, side = oldSide) => replay(environment, byName(name), side, options)

  /** The differences a tampered run shows against a clean one. */
  async function differencesFrom(name: string, tamper: (db: Db, stripe: FakeStripe) => Promise<void>): Promise<Difference[]> {
    const clean = await run(name)
    return compareRecordings(clean, await run(name, { tamper }))
  }

  describe.each(scenarios.map((s) => s.name))('%s', (name) => {
    it('gives the same recording every time', async () => {
      const first = await run(name)
      expect(compareRecordings(first, await run(name))).toEqual([])
    })

    it('matches its golden file', async () => {
      const recording = await run(name)
      if (updating) writeGolden(recording)
      const golden = readGolden(name)
      expect(golden, `No golden file for ${name}: run with UPDATE_GOLDEN=1.`).not.toBeNull()
      expect(compareRecordings(golden as Recording, recording)).toEqual([])
    })
  })

  describe('what the five scenarios prove they ran', () => {
    it('cash: the order is paid and the seat count moved', async () => {
      const { tables, stripeCalls } = await run(CASH)
      expect(tables['orders']?.added[0]).toMatchObject({ payment_status: 'paid', order_total: '45.00', payment_method: 'cash' })
      expect(tables['booking_guests']?.added.map((g) => g['guest_name'])).toEqual(['Sam Test', 'Alex Guest'])
      expect(tables['sessions']?.changed[0]).toMatchObject({ total_booked: [0, 2] })
      expect(stripeCalls).toEqual([])
    })

    it('saved card: Stripe got the remainder, through the real legacy route', async () => {
      const { stripeCalls, tables } = await run(CARD)
      expect(stripeCalls).toHaveLength(1)
      expect(stripeCalls[0]).toMatchObject({
        method: 'paymentIntents.create',
        params: { amount: 4400, currency: 'gbp', customer: 'cus_seed', payment_method: 'pm_seed', off_session: true, confirm: true },
      })
      expect(tables['customers']?.changed[0]).toMatchObject({ store_credit_balance: ['30.00', '15.00'] })
      expect(tables['gift_cards']?.changed[0]).toMatchObject({ remaining_balance: ['40.00', '30.00'] })
      expect(tables['product_variants']?.changed[0]).toMatchObject({ stock_quantity: [5, 3] })
    })

    it('reader: pending first, then paid', async () => {
      const { results, tables } = await run('reader-booking-then-finalise')
      expect(results[1]).toMatchObject({ finalised: true })
      expect(tables['orders']?.added[0]).toMatchObject({ payment_status: 'paid', stripe_payment_intent_id: 'pi_fake_0001' })
    })

    it('membership: a subscription, a membership row and a dated credit period', async () => {
      const { stripeCalls, tables } = await run('membership-on-saved-card')
      expect(stripeCalls.map((c) => c.method)).toEqual(['prices.retrieve', 'customers.update', 'subscriptions.create'])
      expect(stripeCalls[2]?.idempotencyKey).toBe('replay-membership-key')
      expect(tables['customer_memberships']?.added[0]).toMatchObject({ start_date: '2026-11-10', next_renewal_date: '2026-12-10' })
      expect(tables['membership_credit_periods']?.added).toHaveLength(1)
    })

    it('decline: the staff words come through and every table ends as it began', async () => {
      const { results, tables } = await run('saved-card-declined-rolls-back')
      expect(results[0]).toMatchObject({ success: false, reason: 'charge_failed', message: 'Failed to charge saved card: Your card was declined.' })
      expect(tables).toEqual({})
    })
  })

  describe('a deliberate difference is caught', () => {
    it('row order: the two guests swapped, with every value the same', async () => {
      const differences = await differencesFrom(CASH, async (db) => {
        await db.query(`
          UPDATE booking_guests g SET created_at = o.swapped
          FROM (SELECT id, CASE WHEN row_number() OVER (ORDER BY created_at) = 1
                                THEN max(created_at) OVER () ELSE min(created_at) OVER () END AS swapped
                FROM booking_guests) o
          WHERE g.id = o.id`)
      })
      expect(differences.map((d) => d.path)).toContain('.tables.booking_guests.added[0].guest_name')
    })

    it('row order: every row given one created_at, as a real transaction would', async () => {
      const differences = await differencesFrom(CASH, async (db) => {
        await db.query(`UPDATE booking_guests SET created_at = (SELECT min(created_at) FROM booking_guests)`)
      })
      expect(differences).toContainEqual({ path: '.tables.booking_guests.tied', expected: 0, actual: 2 })
    })

    it('money: a penny on one row', async () => {
      const differences = await differencesFrom(CASH, async (db) => {
        await db.query(`UPDATE bookings SET price_paid = price_paid + 0.01`)
      })
      expect(differences.map((d) => d.path)).toContain('.tables.bookings.added[0].price_paid')
    })

    it('a row that should not exist', async () => {
      const differences = await differencesFrom(CASH, async (db) => {
        await db.query(`INSERT INTO stock_adjustments (variant_id, change_amount, reason)
                        SELECT id, -1, 'sale' FROM product_variants`)
      })
      expect(differences.map((d) => d.path).join()).toContain('.tables.stock_adjustments')
    })

    it('a row that went missing', async () => {
      const differences = await differencesFrom(CASH, async (db) => {
        await db.query(`DELETE FROM addon_order_lines`)
      })
      expect(differences.map((d) => d.path)).toContain('.tables.addon_order_lines')
    })

    it('a change to a table the scenario never touches', async () => {
      const differences = await differencesFrom(CASH, async (db) => {
        await db.query(`UPDATE gift_cards SET remaining_balance = 39`)
      })
      expect(differences.map((d) => d.path)).toContain('.tables.gift_cards')
    })

    it('a timestamp set where the old code left it empty', async () => {
      const differences = await differencesFrom(CASH, async (db) => {
        await db.query(`UPDATE bookings SET cancelled_at = now()`)
      })
      expect(differences).toContainEqual({ path: '.tables.bookings.added[0].cancelled_at', expected: null, actual: '<set>' })
    })

    it('a Stripe call too many', async () => {
      const differences = await differencesFrom(CARD, async (_, stripe) => {
        await stripe.prices.retrieve('price_seed_monthly')
      })
      expect(differences.map((d) => d.path)).toContain('.stripeCalls[1]')
    })

    it('a different amount sent to Stripe', async () => {
      const differences = await differencesFrom(CARD, async (_, stripe) => {
        ;(stripe.calls[0]?.params as { amount: number }).amount = 4401
      })
      expect(differences).toContainEqual({ path: '.stripeCalls[0].params.amount', expected: 4400, actual: 4401 })
    })

    it('Stripe calls in a different order', async () => {
      const clean = await run('membership-on-saved-card')
      const swapped = await run('membership-on-saved-card', {
        tamper: async (_, stripe) => {
          stripe.calls.reverse()
        },
      })
      expect(compareRecordings(clean, swapped).map((d) => d.path)).toContain('.stripeCalls[0].method')
    })

    it('different words for staff', async () => {
      const reworded = (db: Db, stripe: FakeStripe): ReplaySide => {
        const side = oldSide(db, stripe)
        return {
          ...side,
          async call(action, params) {
            return { ...((await side.call(action, params)) as object), message: 'Something else.' }
          },
        }
      }
      const clean = await run('saved-card-declined-rolls-back')
      const changed = await run('saved-card-declined-rolls-back', undefined, reworded)
      expect(compareRecordings(clean, changed).map((d) => d.path)).toEqual(['.results[0].message'])
    })
  })

  describe('what must not count as a difference', () => {
    it('timestamps moving, with the order kept', async () => {
      const differences = await differencesFrom(CASH, async (db) => {
        await db.query(`UPDATE booking_guests SET created_at = created_at + interval '1 hour'`)
      })
      expect(differences).toEqual([])
    })

    it('a row written and put back', async () => {
      const differences = await differencesFrom(CASH, async (db) => {
        await db.query(`UPDATE gift_cards SET remaining_balance = remaining_balance`)
      })
      expect(differences).toEqual([])
    })
  })

  describe('allowed differences', () => {
    const allowance = { name: 'A penny of rounding', decision: 'a test', path: /^\.tables\.bookings\.added\[0\]\.price_paid$/ }

    it('lets through the one named difference and nothing else', async () => {
      const clean = await run(CASH)
      const changed = await run(CASH, {
        tamper: async (db) => {
          await db.query(`UPDATE bookings SET price_paid = price_paid + 0.01`)
          await db.query(`UPDATE orders SET order_total = order_total + 0.01`)
        },
      })
      expect(compareRecordings(clean, changed, [allowance]).map((d) => d.path)).toEqual(['.tables.orders.added[0].order_total'])
    })

    it('fails when an allowed difference no longer happens, so stale ones get removed', async () => {
      const clean = await run(CASH)
      expect(compareRecordings(clean, clean, [allowance])).toEqual([
        { path: '(allowed difference not seen: A penny of rounding)', expected: 'a test', actual: undefined },
      ])
    })
  })
})

describe('buildRecording', () => {
  const ORDER = '20000000-0000-4000-8000-000000000001'
  const OTHER = '20000000-0000-4000-8000-000000000002'
  const SEEDED = '10000000-0000-4000-8000-000000000005'
  const base: RawRun = { scenario: 't', before: {}, after: {}, results: [], stripeCalls: [] }
  const order = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    customer_id: SEEDED,
    order_total: '20',
    created_at: '2026-11-10T09:00:00.000Z',
    ...extra,
  })

  it('labels generated ids everywhere and leaves seeded ones', () => {
    const recording = buildRecording({
      ...base,
      before: { customers: [{ id: SEEDED }] },
      after: { customers: [{ id: SEEDED }], orders: [order(ORDER)] },
      results: [{ orderId: ORDER, text: `Order ${ORDER}`, customer: SEEDED }],
      stripeCalls: [{ method: 'm', params: { metadata: { order_id: ORDER } }, idempotencyKey: `${ORDER}:charge` }],
    })
    expect(recording.results).toEqual([{ orderId: 'orders#1', text: 'Order orders#1', customer: SEEDED }])
    expect(recording.stripeCalls[0]).toEqual({ method: 'm', params: { metadata: { order_id: 'orders#1' } }, idempotencyKey: 'orders#1:charge' })
  })

  it('names an id with no row left, such as a rolled-back order', () => {
    expect(buildRecording({ ...base, results: [{ a: ORDER, b: OTHER, c: ORDER }] }).results).toEqual([{ a: 'gone#1', b: 'gone#2', c: 'gone#1' }])
  })

  it('compares money to the penny, whichever way it is written', () => {
    const a = buildRecording({ ...base, after: { orders: [order(ORDER, { order_total: '20' })] }, results: [{ amount: 0.1 + 0.2 }] })
    const b = buildRecording({ ...base, after: { orders: [order(OTHER, { order_total: '20.00' })] }, results: [{ amount: 0.3 }] })
    expect(compareRecordings(a, b)).toEqual([])
  })

  it('labels gift card codes wherever they appear', () => {
    const card = { id: ORDER, code: 'ABCD-EFGH', created_at: '2026-11-10T09:00:00.000Z' }
    const recording = buildRecording({ ...base, after: { gift_cards: [card] }, results: [{ giftCardCode: 'ABCD-EFGH' }] })
    expect(recording.results).toEqual([{ giftCardCode: '<code#1>' }])
    expect(recording.tables['gift_cards']?.added[0]?.['code']).toBe('<code#1>')
  })

  it('tidies times inside json', () => {
    const row = order(ORDER, { reader_payment: { started_at: '2026-11-10T09:00:00.123+00:00', day: '2026-11-10' } })
    expect(buildRecording({ ...base, after: { orders: [row] } }).tables['orders']?.added[0]?.['reader_payment']).toEqual({
      started_at: '<time>',
      day: '2026-11-10',
    })
  })

  it('counts tied rows, and gives them a fixed order whatever their ids', () => {
    const first = buildRecording({
      ...base,
      after: { orders: [order(ORDER, { order_total: '1' }), order(OTHER, { order_total: '2' })] },
    })
    const second = buildRecording({
      ...base,
      after: { orders: [order(OTHER, { order_total: '2' }), order(ORDER, { order_total: '1' })] },
    })
    expect(first.tables['orders']?.tied).toBe(2)
    expect(compareRecordings(first, second)).toEqual([])
  })

  it('refuses a table the catalog does not have', () => {
    expect(() => buildRecording({ ...base, after: { nonsense: [] } })).toThrow('no table nonsense')
  })
})
