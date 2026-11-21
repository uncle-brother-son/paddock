import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { ORDER_ADMIN_NEW_WORDS, ORDER_PAYMENT_METHOD_LABELS } from '@/server/rules/orders/admin-failure-messages'
import { isW53Scenario, pathsPinnedBy, W53_DECISIONS, W53_DIFFERING, w53Differences } from './admin-differences'
import { adminRowProblems, adminStoredAnswerProblems, comparableAdmin, newAdminSide, STEP_G_ACTIONS_MOVED, STEP_G_AUDIT_ROWS, W53_ACTIONS, W53_FLAGS, W53_READS, type AnsweredPaidBy } from './admin-side'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { ID } from './scenarios'
import { w48Scenarios } from './w48-scenarios'

// W53 (brief "Parity and tests"; G-plan 4.9 items 3 and 4): the orders family (W48's recordings of the old functions)
// through the staff app's thin functions and the Worker's routes, as the screens press them. GB14's own recording
// (every read, by an inactive account and by a sign-in with no staff row) is replayed in admin-replay.test.ts, where
// W49 + W54 put it: its named difference now names W53's two reads too.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: readonly AllowedDifference[]) => compareRecordings(comparableAdmin(golden), comparableAdmin(recording), named)

const everyStepGScenario = w48Scenarios()
const families = everyStepGScenario.filter((scenario) => isW53Scenario(scenario.name))

type AuditRow = Row & { action?: string; details?: { after?: Record<string, unknown> | null; fulfilled?: boolean; key?: string } }
const ownAuditRows = (recording: Recording): AuditRow[] => ((recording.tables['audit_log']?.added ?? []) as AuditRow[]).filter((row) => row.action === 'order_line.fulfilled_set')

describe("step G's side of the replay: Orders and fulfilment (W53)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  const scenario = (name: string): Scenario => {
    const found = everyStepGScenario.find((one) => one.name === name)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const golden = (name: string) => readGolden(name) as Recording
  const named = (name: string): readonly AllowedDifference[] => w53Differences(name, golden(name))
  const runNew = (name: string, options: Parameters<typeof newAdminSide>[0] = {}, replayOptions: Parameters<typeof replay>[3] = {}) => replay(environment, scenario(name), newAdminSide(options), replayOptions)
  const left = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)
  /** Every path on which a recording differs from its golden file, with nothing allowed. */
  const rawPaths = (name: string, recording: Recording): string[] => left(name, recording, []).sort()
  /** Every path the recording's named differences pin. */
  const pinnedPaths = (name: string): string[] => named(name).flatMap((difference) => [...pathsPinnedBy(difference)]).sort()

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it('matches its golden file, with its named differences only; its audit rows, stored answers and paid-by words are right', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const paidBy: AnsweredPaidBy[] = []
      const recording = await replay(environment, one, newAdminSide({ calls, paidBy }))
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      // Every call of a moved function went through the staff app's thin function and the Worker, and there was one.
      expect(calls.filter((call) => STEP_G_ACTIONS_MOVED.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => W53_ACTIONS.has(call.action))).toBe(true)
      if (process.env.W53_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W53_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: adminRowProblems(recording), stored: adminStoredAnswerProblems(recording), audit: recording.tables['audit_log']?.added ?? [], paidBy, results: recording.results })}\n`
        )
        return
      }
      expect(adminRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(adminStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
      // Each recording's raw differences are exactly the paths its named differences pin: a path put back to what the
      // old code recorded would be one path short (a pin only bites where the new side differs).
      expect(rawPaths(name, recording)).toEqual(pinnedPaths(name))
      // L9: every order the list answered says how it was paid, from what its row records: the method's own words;
      // "Store credit" for an order with no method that store credit paid for; never anything else.
      const labels: Record<string, string> = ORDER_PAYMENT_METHOD_LABELS
      for (const said of paidBy) {
        if (typeof said.paymentMethod === 'string') expect(said.label, JSON.stringify(said)).toBe(labels[said.paymentMethod])
        else expect([null, labels['store_credit'], labels['nothingToPay']], JSON.stringify(said)).toContain(said.label)
      }
    })
  })

  it('the family is whole: every order recording W48 made is replayed here, and every named difference is for a recording that exists', () => {
    expect(families.map((one) => one.name).sort()).toEqual(
      [
        'w48-gb22-an-order-whose-booking-needs-payment-reads-complete',
        'w48-gb22-an-order-with-money-owed-is-needs-action',
        'w48-order-line-fulfilled-and-undo',
        'w48-order-line-fulfilled-who-may',
        'w48-order-lines-read',
        'w48-orders-read',
      ].sort()
    )
    expect(W53_READS.size).toBe(2)
    expect(W53_FLAGS.size).toBe(1)
    expect(W53_ACTIONS.size).toBe(3)
    expect(W53_DIFFERING.every((name) => families.some((one) => one.name === name))).toBe(true)
    // Two match their golden files exactly (the order list, read ten ways; GB22's second half, as it has been since
    // W47). Four have named differences: the line read's working columns, the tick's words and who may press it, and
    // GB22's first half.
    expect(families.filter((one) => named(one.name).length === 0).map((one) => one.name).sort()).toEqual(['w48-gb22-an-order-with-money-owed-is-needs-action', 'w48-orders-read'])
    expect([...W53_DIFFERING].sort()).toEqual(
      ['w48-gb22-an-order-whose-booking-needs-payment-reads-complete', 'w48-order-line-fulfilled-and-undo', 'w48-order-line-fulfilled-who-may', 'w48-order-lines-read'].sort()
    )
    expect(Object.keys(W53_DECISIONS).sort()).toEqual(['GB22', 'NAMED_COLUMNS', 'NO_STAFF_ROW', 'WORDS'])
  })

  describe('field for field', () => {
    it('the order list answers every field the old `o.*` gave, under each of the ten ways the recording reads it; only the paid-by words are new', async () => {
      const name = 'w48-orders-read'
      const paidBy: AnsweredPaidBy[] = []
      const recording = await runNew(name, { paidBy })
      expect(rawPaths(name, recording)).toEqual([])
      const first = (golden(name).results[2] as Array<Record<string, unknown>>)[0] ?? {}
      expect(Object.keys(first).sort()).toEqual(
        [
          'computed_status',
          'created_at',
          'customer_email',
          'customer_first_name',
          'customer_id',
          'customer_last_name',
          'discount_amount',
          'id',
          'order_source',
          'order_total',
          'payment_method',
          'payment_status',
          'promo_code',
          'reader_payment',
          'refund_owed_amount',
          'shipping_address',
          'shipping_status',
          'stripe_payment_intent_id',
          'tracking_number',
          'updated_at',
        ].sort()
      )
      // Both orders were paid in cash, and say so.
      expect(paidBy.length).toBeGreaterThan(0)
      expect(new Set(paidBy.map((said) => said.label))).toEqual(new Set([ORDER_PAYMENT_METHOD_LABELS.cash]))
    })

    it("every kind of line's name and the two summary sentences are the golden file's, word for word", async () => {
      const name = 'w48-order-lines-read'
      const recording = await runNew(name)
      const names = (result: unknown) => (result as Array<{ item_type: string; item_name: string }>).map((line) => [line.item_type, line.item_name])
      const lines = [recording.results[1], recording.results[3], recording.results[5]].flatMap(names)
      expect(lines).toEqual([golden(name).results[1], golden(name).results[3], golden(name).results[5]].flatMap(names))
      // A seat, soap... every kind the recording sells has its own name.
      expect(new Set(lines.map(([kind]) => kind))).toEqual(new Set(['booking', 'product', 'addon', 'session_pass', 'gift_card', 'postage', 'event']))
      const summaries = (result: unknown) => (result as Array<{ event_cancellation_summary: unknown; addon_refund_summary: unknown }>).map((line) => [line.event_cancellation_summary, line.addon_refund_summary])
      expect([recording.results[1], recording.results[3], recording.results[5]].flatMap(summaries)).toEqual([golden(name).results[1], golden(name).results[3], golden(name).results[5]].flatMap(summaries))
    })
  })

  describe('what the old function never recorded is now recorded (nothing said who marked a line fulfilled)', () => {
    it('fulfilled and back each have their row: who, the line, its order, the state as set and which way it was pressed; a refused press leaves none', async () => {
      const recording = await runNew('w48-order-line-fulfilled-and-undo')
      const rows = ownAuditRows(recording)
      expect(rows.map((row) => [row.action, row.details?.fulfilled, row.details?.after?.['fulfillment_status']])).toEqual([
        ['order_line.fulfilled_set', true, 'fulfilled'],
        ['order_line.fulfilled_set', false, 'pending'],
      ])
      expect(rows.every((row) => row['actor_type'] === 'staff' && row['actor_id'] === ID.staff && row['entity_type'] === 'order_line_item' && typeof row.details?.key === 'string')).toBe(true)
      // The two refused presses (a line that isn't a product, a line that isn't there) wrote none: two rows, four presses.
      expect(((recording.tables['audit_log']?.added ?? []) as Row[]).filter((row) => STEP_G_AUDIT_ROWS.has(String(row['action'])))).toHaveLength(2)
    })
  })

  describe('a deliberate difference is caught', () => {
    it('in what staff are told: a field dropped from the order list, a line name a letter out, a status put back to the old code\'s', async () => {
      const list = 'w48-orders-read'
      const withoutTotal = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'refund_owed_amount'))
      const dropped = await runNew(list, { adjust: (action, answer) => (action === 'getOrders' && Array.isArray(answer) ? (answer as Array<Record<string, unknown>>).map(withoutTotal) : answer) })
      expect(left(list, dropped).length).toBeGreaterThan(0)
      expect(left(list, dropped).every((path) => path.endsWith('.refund_owed_amount'))).toBe(true)

      const lines = 'w48-order-lines-read'
      const renamed = await runNew(lines, {
        adjust: (action, answer) => (action === 'getOrderLineItems' && Array.isArray(answer) ? (answer as Array<Record<string, unknown>>).map((line, i) => (i === 0 ? { ...line, item_name: `${String(line['item_name'])}!` } : line)) : answer),
      })
      expect(left(lines, renamed)).toEqual(['.results[1][0].item_name', '.results[3][0].item_name', '.results[5][0].item_name'])

      // GB22: the allowance is pinned to Needs action. The old code's "complete" on that order is a difference again.
      const gb22 = 'w48-gb22-an-order-whose-booking-needs-payment-reads-complete'
      const asBefore = await runNew(gb22, {
        adjust: (action, answer) => (action === 'getOrders' && Array.isArray(answer) ? (answer as Array<Record<string, unknown>>).map((order) => ({ ...order, computed_status: 'complete' })) : answer),
      })
      expect(left(gb22, asBefore).some((path) => path.includes('allowed difference not seen'))).toBe(true)
    })

    it('in a row: a line left fulfilled after the undo, a refused tick that lands anyway', async () => {
      const name = 'w48-order-line-fulfilled-and-undo'
      const leftFulfilled = await runNew(name, {}, { tamper: async (db) => void (await db.query("UPDATE order_line_items SET fulfillment_status = 'fulfilled' WHERE item_type = 'product'")) })
      expect(left(name, leftFulfilled)).toEqual(['.tables.order_line_items.added[0].fulfillment_status'])
      const onASeat = await runNew(name, {}, { tamper: async (db) => void (await db.query("UPDATE order_line_items SET fulfillment_status = 'fulfilled' WHERE item_type = 'booking'")) })
      expect(left(name, onASeat).length).toBe(1)
    })

    it('in what was set aside: a tick with no audit row, a second row for one press', async () => {
      const name = 'w48-order-line-fulfilled-and-undo'
      const noRow = await runNew(name, {}, { tamper: async (db) => void (await db.query("DELETE FROM audit_log WHERE id = (SELECT id FROM audit_log WHERE action = 'order_line.fulfilled_set' ORDER BY at LIMIT 1)")) })
      expect(adminRowProblems(noRow)).toEqual(['order_line.fulfilled_set: 1 rows for 2 presses answered with a success'])
      const twice = await runNew(name, {}, {
        tamper: async (db) =>
          void (await db.query(
            "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) SELECT actor_type, actor_id, action, entity_type, entity_id, request_id, details FROM audit_log WHERE action = 'order_line.fulfilled_set' ORDER BY at LIMIT 1"
          )),
      })
      expect(adminRowProblems(twice)).toEqual(['order_line.fulfilled_set: 3 rows for 2 presses answered with a success'])
    })

    it('an allowance nobody needs fails: GB22\'s on the recording that matches exactly', async () => {
      const exact = 'w48-orders-read'
      const recording = await runNew(exact)
      expect(left(exact, recording, [])).toEqual([])
      const unneeded = named('w48-gb22-an-order-whose-booking-needs-payment-reads-complete')
      expect(unneeded.length).toBeGreaterThan(0)
      expect(left(exact, recording, unneeded)).toEqual(unneeded.map(() => expect.stringContaining('allowed difference not seen')))
    })

    it("the words the tick's refusals now carry are the Worker's own", async () => {
      const recording = await runNew('w48-order-line-fulfilled-and-undo')
      expect(recording.results[5]).toEqual({ updated: false, reason: 'not_a_product_line', message: ORDER_ADMIN_NEW_WORDS.notAProductLine })
      expect(recording.results[6]).toEqual({ updated: false, reason: 'not_found', message: ORDER_ADMIN_NEW_WORDS.lineNotFound })
    })
  })
})
