import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BasketQuoteOutput } from '@/contracts'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { POST as quoteRoute } from '@/app/api/v1/staff/quotes/basket/route'
import { POST as parityRoute } from '@/app/api/v1/staff/parity/route'
import { POST as promoRoute } from '@/app/api/v1/staff/promo-codes/validate/route'
import { POST as dryRunRoute } from '@/app/api/v1/staff/orders/dry-run/route'
import { compareRecordings, type AllowedDifference, type Recording } from './compare'
import { backendDir, oldSide, readGolden, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { ORDER_SCENARIOS } from './order-differences'
import { DRY_RUN_DIFFERENCES, QUOTE_DIFFERENCES, SCREEN_DIFFERENCE } from './quote-differences'
import { ID, PROMO, scenarios } from './scenarios'

// The real old createOrder with its shadow switched on, talking to the real quote, dry-run and
// parity routes on the same database. So each scenario proves three things: what the quote says
// equals what the order writes, except the agreed fixes; the Worker's own order, run and rolled back,
// writes what the old one did, for everything W06 builds; and the shadow changes nothing about the order.

const KEY = 'test-staff-api-key'
const QUOTE_PATH = '/api/v1/staff/quotes/basket'
const PARITY_PATH = '/api/v1/staff/parity'
const DRY_RUN_PATH = '/api/v1/staff/orders/dry-run'
const QUOTE = 'createOrder.quote'
const DRY_RUN = 'createOrder.dryRun'
const CARD_ORDER = 'saved-card-product-gift-card-store-credit'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

interface ParityRow {
  action: string
  matches: boolean
  diff: Array<{ path: string; oldValue: unknown; newValue: unknown }> | null
  old_result: unknown
  new_result: unknown
}

interface WorkerCall {
  path: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

const ROUTES: Record<string, (request: Request) => Promise<Response>> = {
  [QUOTE_PATH]: quoteRoute,
  [PARITY_PATH]: parityRoute,
  [DRY_RUN_PATH]: dryRunRoute,
  '/api/v1/staff/promo-codes/validate': promoRoute,
}

async function realWorker({ path, method, headers, body }: WorkerCall): Promise<{ data: unknown }> {
  const route = ROUTES[path]
  if (!route) throw new Error(`No route ${path}`)
  const response = await route(
    new Request(`https://worker.test${path}`, {
      method,
      headers: { ...headers, authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body ?? {}),
    })
  )
  return { data: await response.json() }
}

/** An id with no row left is numbered as it's met, and the shadow's rows are met first. */
const withoutGoneNumbers = (recording: Recording): Recording => JSON.parse(JSON.stringify(recording).replace(/gone#\d+/g, 'gone')) as Recording

/** Golden files show the order alone, so the shadow's own rows aren't part of the comparison. */
function withoutShadowRows(recording: Recording): Recording {
  const tables = Object.entries(recording.tables).filter(([name]) => name !== 'parity_log' && name !== 'api_idempotency')
  return withoutGoneNumbers({ ...recording, tables: Object.fromEntries(tables) })
}

describe('the quote shadow, through the real routes', () => {
  let environment: ReplayEnvironment
  let quotes: BasketQuoteOutput[]

  beforeAll(async () => {
    process.env.STAFF_API_KEY = KEY
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  type DataQuery = (sql: string, params?: unknown[]) => Promise<{ data: unknown[] }>

  /**
   * Runs a scenario with `worker` standing in for the Worker, keeping what the shadow recorded.
   * `data` wraps the old side's paddockData (W09: a read-back that takes its time).
   */
  async function run(scenario: Scenario, worker: (call: WorkerCall) => Promise<{ data: unknown }> = realWorker, data?: (query: DataQuery) => DataQuery) {
    let parity: ParityRow[] = []
    const actions: string[] = []
    quotes = []
    const recording = await replay(
      environment,
      scenario,
      (db: Db, stripe: FakeStripe) => {
        const oldOne = oldSide(db, stripe)
        if (data) {
          const resource = (globalThis as unknown as { paddockData: { query: DataQuery } }).paddockData
          vi.stubGlobal('paddockData', { query: data(resource.query) })
        }
        const side = {
          ...oldOne,
          call(action: string, params: unknown) {
            actions.push(action)
            return oldOne.call(action, params)
          },
        }
        // The harness's own staff routes (a refund look-up) answer what these don't.
        const harness = (globalThis as unknown as { paddockWorkerV1: { rawRequest(call: WorkerCall): Promise<{ data: unknown }> } }).paddockWorkerV1
        vi.stubGlobal('paddockWorkerV1', {
          async rawRequest(call: WorkerCall) {
            const answer = call.path in ROUTES ? await worker(call) : await harness.rawRequest(call)
            const body = answer.data as { ok?: boolean; data?: BasketQuoteOutput }
            if (call.path === QUOTE_PATH && body.ok && body.data) quotes.push(body.data)
            return answer
          },
        })
        return side
      },
      {
        tamper: async (db) => {
          parity = await db.query<ParityRow>(`SELECT action, matches, diff, old_result, new_result FROM parity_log ORDER BY at`)
        },
      }
    )
    return { recording, parity, actions, quoteRows: parity.filter((row) => row.action === QUOTE), dryRunRows: parity.filter((row) => row.action === DRY_RUN) }
  }

  const byName = (name: string): Scenario => {
    const scenario = scenarios.find((s) => s.name === name)
    if (!scenario) throw new Error(`No scenario ${name}`)
    return scenario
  }

  /** The differences in the log that nobody decided on, and any allowance that didn't happen. */
  function undecided(parity: ParityRow[], allowed: readonly AllowedDifference[]): string[] {
    const seen = new Set<AllowedDifference>()
    const left: string[] = []
    for (const entry of parity.flatMap((row) => row.diff ?? [])) {
      const allowance = allowed.find((a) => a.path.test(entry.path))
      if (allowance) seen.add(allowance)
      else left.push(`${entry.path}: wrote ${JSON.stringify(entry.oldValue)}, quoted ${JSON.stringify(entry.newValue)}`)
    }
    return [...left, ...allowed.filter((a) => !seen.has(a)).map((a) => `(not seen: ${a.name})`)]
  }

  /** Orders the quote can't foresee the answer to (a decline, no customer, a changed cash figure), so it records nothing. */
  const notCompared = new Set([
    'saved-card-declined-rolls-back',
    'q24-card-declined-rolls-back',
    'w06-refused-no-customer',
    'w06-refused-cash-figure-changed',
    'w06-refused-cash-not-confirmed',
    'w06-refused-cash-but-nothing-owed',
    'w08-refused-event-cash-figure-changed',
    'w09-refused-promo-cash-figure-changed',
    'w09-refused-cash-figure-before-the-store-credit-over-the-total',
    'w09-refused-cash-figure-before-the-gift-card-over-the-total',
    'w09-half-penny-store-credit',
  ])

  describe.each(scenarios.map((s) => s.name))('%s', (name) => {
    it('the quote and the dry run equal what the order wrote, except the agreed fixes', async () => {
      const { quoteRows, dryRunRows, actions } = await run(byName(name))
      const allowed = QUOTE_DIFFERENCES[name] ?? []
      expect(undecided(quoteRows, allowed)).toEqual([])
      if (notCompared.has(name)) expect(quoteRows).toEqual([])
      else if (allowed.length === 0) expect(quoteRows.map((row) => [row.action, row.matches])).toEqual([[QUOTE, true]])
      else expect(quoteRows.map((row) => row.matches)).toEqual([false])

      // The dry run's own decided differences (from W07); every other row it leaves must be a match.
      const dryRunAllowed = DRY_RUN_DIFFERENCES[name] ?? []
      expect(undecided(dryRunRows, dryRunAllowed)).toEqual([])
      if (dryRunAllowed.length === 0) expect(dryRunRows.map((row) => row.matches)).not.toContain(false)
      // A single order in the order route's scope has its row; any other single order is one the Worker can't take yet.
      const singleOrder = actions.length === 1 && actions[0] === 'createOrder'
      if (ORDER_SCENARIOS.includes(name)) expect(dryRunRows.map((row) => row.matches)).toEqual([dryRunAllowed.length === 0])
      else if (singleOrder) expect(dryRunRows).toEqual([])
    })

    it('the shadow changes nothing about the order', async () => {
      const { recording } = await run(byName(name))
      const golden = withoutGoneNumbers(readGolden(name) as Recording)
      expect(compareRecordings(golden, withoutShadowRows(recording))).toEqual([])
    })
  })

  it('every decision has a scenario that shows it', () => {
    const decisions = Object.values(QUOTE_DIFFERENCES).flatMap((list) => list.map((a) => a.decision))
    expect([...new Set([...decisions, SCREEN_DIFFERENCE.decision])].sort()).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'].map((q) => `W03-decisions ${q}`))
  })

  it('a match is logged with only its timing, so a count proves the shadow ran', async () => {
    const { quoteRows, dryRunRows } = await run(byName('cash-booking-two-guests-addon'))
    expect(quoteRows).toEqual([{ action: QUOTE, matches: true, diff: null, old_result: null, new_result: { timing: expect.anything() } }])
    expect(dryRunRows).toEqual([{ action: DRY_RUN, matches: true, diff: null, old_result: null, new_result: { timing: expect.anything() } }])
  })

  describe('timing', () => {
    const timingOf = (row: ParityRow | undefined) => (row?.new_result as { timing: Record<string, number | null> }).timing

    it('a match records each step, in whole milliseconds and nothing else', async () => {
      const { quoteRows } = await run(byName('cash-booking-two-guests-addon'))
      const timing = timingOf(quoteRows[0])
      expect(Object.keys(timing).sort()).toEqual(['orderMs', 'quoteMs', 'readBackMs', 'totalMs'])
      for (const value of Object.values(timing)) expect(Number.isInteger(value)).toBe(true)
    })

    it('the steps are measured separately: a slow quote shows as the quote, and adds to the total', async () => {
      const { quoteRows } = await run(byName('cash-booking-two-guests-addon'), async (call) => {
        if (call.path === QUOTE_PATH) vi.setSystemTime(Date.now() + 1_234)
        return realWorker(call)
      })
      const timing = timingOf(quoteRows[0])
      expect(timing['quoteMs']).toBeGreaterThanOrEqual(1_234)
      expect(timing['orderMs']).toBeLessThan(1_234)
      expect(timing['totalMs']).toBeGreaterThanOrEqual((timing['quoteMs'] ?? 0) + (timing['orderMs'] ?? 0) + (timing['readBackMs'] ?? 0))
    })

    it('a difference carries it beside the figures, and it stays out of the diff', async () => {
      const { parity } = await run(byName('q5-buy-new-keeps-address-and-requests'))
      expect(timingOf(parity[0])['readBackMs']).toEqual(expect.any(Number))
      expect(parity[0]?.diff?.map((d) => d.path).join()).not.toContain('timing')
    })

    it('a refusal has nothing to read back', async () => {
      const { quoteRows } = await run(byName('refused-out-of-stock'))
      expect(quoteRows.map((row) => row.matches)).toEqual([true])
      expect(timingOf(quoteRows[0])['readBackMs']).toBeNull()
    })

    it('a failed comparison still says how long it took', async () => {
      const { parity } = await run(byName(CARD_ORDER), async (call) => {
        if (call.path !== QUOTE_PATH) return realWorker(call)
        return { data: { ok: false, requestId: 'r', error: { code: 'INTERNAL', message: 'It broke.' } } }
      })
      expect(parity[0]?.matches).toBe(false)
      expect(timingOf(parity[0])['quoteMs']).toEqual(expect.any(Number))
    })
  })

  describe('Q24: the screen previews what the order gives, to the penny', () => {
    const booking = { key: 'booking', itemType: 'booking', amount: 100, isMemberPriced: false }
    const addon = { key: 'addon:0', itemType: 'addon', amount: 5, isMemberPriced: false }
    const product = { key: 'product:0', itemType: 'product', amount: 24, isMemberPriced: false }
    const membership = { key: 'membership', itemType: 'membership', amount: 40, isMemberPriced: false }

    // The lines are what CheckoutDialog's promoLinesInfo builds for each basket.
    it.each([
      ['private only, percentage', 'q24-percent-promo-on-a-private-booking', PROMO.percent, [booking], 10],
      ['private only, fixed', 'q24-fixed-promo-on-a-private-booking', PROMO.fixed, [booking], 5],
      ['a fixed code bigger than the private price', 'q24-fixed-promo-bigger-than-the-private-price', PROMO.big, [booking], 100],
      ['private and other items, percentage', 'q24-percent-promo-on-private-and-other-items', PROMO.percent, [booking, addon, product], 12.9],
      ['private and other items, fixed', 'q24-fixed-promo-on-private-and-other-items', PROMO.fixed, [booking, addon, product], 5],
      ['private and a membership, a big fixed code', 'q24-big-fixed-promo-on-private-and-a-membership', PROMO.big, [booking, product, membership], 150],
    ])('%s', async (_, scenario, code, lines, expected) => {
      const { quoteRows, dryRunRows, recording } = await run(byName(scenario))
      expect(quoteRows.map((row) => row.matches)).toEqual([true])
      // W09: a promo order the Worker can take (in cash, or nothing owed) has its dry run compared too.
      expect(dryRunRows.map((row) => row.matches)).toEqual(ORDER_SCENARIOS.includes(scenario) ? [true] : [])

      const answer = await realWorker({
        path: '/api/v1/staff/promo-codes/validate',
        method: 'POST',
        headers: { 'x-staff-email': REPLAY_USER.email },
        body: { code, customerId: ID.customer, lines },
      })
      const screen = (answer.data as { data: { discountTotal: number; perLine: Array<{ key: string; discount: number }> } }).data
      const order = recording.tables['orders']?.added[0] as { discount_amount: string }
      expect(screen.discountTotal).toBe(expected)
      expect(Number(order.discount_amount)).toBe(expected)
      expect(quotes[0]?.totals.promoDiscount).toBe(expected)
      expect(quotes[0]?.promo?.perLine).toEqual(screen.perLine)
    })
  })

  it('a difference is logged with both sets of figures and no customer details', async () => {
    const { parity } = await run(byName('q5-buy-new-keeps-address-and-requests'))
    const logged = JSON.stringify(parity)
    expect(parity[0]?.matches).toBe(false)
    expect(parity[0]?.old_result).toMatchObject({ figures: { hasShippingAddress: false } })
    expect(parity[0]?.new_result).toMatchObject({ figures: { hasShippingAddress: true } })
    for (const text of ['Mill Lane', 'HX7', 'Sam Test', 'sam@example.com', 'Step-free']) expect(logged).not.toContain(text)
  })

  describe('finding 17: free text stays out of parity_log', () => {
    const REASON = 'Regular at the Tuesday session, Sam Test agreed this'
    it('a refusal message is compared and not kept: only whether it matched', async () => {
      const { quoteRows: parity } = await run(byName('refused-out-of-stock'), async (call) => {
        const answer = await realWorker(call)
        if (call.path !== QUOTE_PATH) return answer
        const body = answer.data as { data: BasketQuoteOutput }
        const problems = body.data.problems.map((problem) => ({ ...problem, message: 'Sam Test has no stock' }))
        return { data: { ...body, data: { ...body.data, problems } } }
      })
      expect(parity[0]?.matches).toBe(false)
      expect(parity[0]?.new_result).toMatchObject({ messagesMatch: false, overrideReasonsMatch: true })
      expect(JSON.stringify(parity)).not.toContain('Sam Test')
      expect(parity[0]?.old_result).toMatchObject({ refusal: { message: null } })
    })

    it('an override reason is compared and not kept', async () => {
      const { parity } = await run(byName(CARD_ORDER), async (call) => {
        const answer = await realWorker(call)
        if (call.path !== QUOTE_PATH) return answer
        const body = answer.data as { data: BasketQuoteOutput }
        const lines = body.data.lines.map((line) => ({ ...line, priceOverrideReason: REASON }))
        return { data: { ...body, data: { ...body.data, lines } } }
      })
      expect(parity[0]?.matches).toBe(false)
      expect(parity[0]?.new_result).toMatchObject({ messagesMatch: true, overrideReasonsMatch: false })
      expect(JSON.stringify(parity)).not.toContain('Sam Test')
    })
  })

  describe('finding 12: an order that has already taken 40 seconds (20 until W09)', () => {
    const slowing = (ms: number) => async (call: WorkerCall) => {
      if (call.path === QUOTE_PATH) vi.setSystemTime(Date.now() + ms)
      return realWorker(call)
    }

    it('is answered straight away: nothing is read back or recorded, and the order is as it would be', async () => {
      const name = 'cash-booking-two-guests-addon'
      const { parity, recording } = await run(byName(name), slowing(40_001))
      expect(parity).toEqual([])
      expect(compareRecordings(withoutGoneNumbers(readGolden(name) as Recording), withoutShadowRows(recording))).toEqual([])
    })

    it('under the limit it still compares', async () => {
      const { quoteRows, dryRunRows } = await run(byName('cash-booking-two-guests-addon'), slowing(39_000))
      expect(quoteRows.map((row) => row.matches)).toEqual([true])
      expect(dryRunRows.map((row) => row.matches)).toEqual([true])
    })
  })

  it('a price that changes between the quote and the order is caught', async () => {
    const { parity } = await run(byName(CARD_ORDER), async (call) => {
      const answer = await realWorker(call)
      if (call.path === QUOTE_PATH) await environment.database.db.query(`UPDATE session_bands SET price = '21.00' WHERE id = $1`, [ID.band])
      return answer
    })
    expect(parity.map((row) => row.matches)).toEqual([false])
    expect(parity[0]?.diff?.map((d) => d.path)).toContain('figures.orderTotal')
  })

  it('a refusal the quote did not foresee is logged', async () => {
    const scenario = byName('refused-out-of-stock')
    const blind = async (call: WorkerCall) => {
      const answer = await realWorker(call)
      if (call.path !== QUOTE_PATH) return answer
      const body = answer.data as { data: BasketQuoteOutput }
      return { data: { ...body, data: { ...body.data, problems: [] } } }
    }
    const { quoteRows: parity } = await run(scenario, blind)
    expect(parity.map((row) => row.matches)).toEqual([false])
    expect(parity[0]?.old_result).toMatchObject({ refusal: { reason: 'insufficient_stock' } })
  })

  describe('a shadow that fails changes nothing', () => {
    const name = CARD_ORDER
    const unchanged = async (worker: (call: WorkerCall) => Promise<{ data: unknown }>) => {
      const { recording } = await run(byName(name), worker)
      expect(compareRecordings(withoutGoneNumbers(readGolden(name) as Recording), withoutShadowRows(recording))).toEqual([])
    }

    it('the Worker is down', async () => {
      await unchanged(async () => {
        throw new Error('connection refused')
      })
    })

    it('the Worker answers with nonsense', async () => {
      await unchanged(async () => ({ data: '<html>Bad gateway</html>' }))
    })

    it('the Worker refuses the quote, and that is logged as a failed comparison', async () => {
      const { parity } = await run(byName(name), async (call) => {
        if (call.path !== QUOTE_PATH) return realWorker(call)
        return { data: { ok: false, requestId: 'r', error: { code: 'INTERNAL', message: 'It broke.' } } }
      })
      expect(parity.map((row) => row.matches)).toEqual([false])
      expect(JSON.stringify(parity[0]?.diff)).toContain('It broke.')
    })

    it('recording fails', async () => {
      await unchanged(async (call) => {
        if (call.path === PARITY_PATH) throw new Error('connection refused')
        return realWorker(call)
      })
    })

    it('the Worker never answers: the order goes ahead after 5 seconds', { timeout: 15_000 }, async () => {
      await unchanged((call) => (call.path === QUOTE_PATH ? new Promise(() => undefined) : realWorker(call)))
    })
  })

  it('the quoted card figure is what Stripe was asked for, even when it declined', async () => {
    const { recording } = await run(byName('saved-card-declined-rolls-back'))
    expect(recording.stripeCalls[0]?.params).toMatchObject({ amount: Math.round((quotes[0]?.totals.toCollect.card ?? 0) * 100) })
  })

  it('the quoted reader figure is what the reader was asked for', async () => {
    const { recording } = await run(byName('membership-on-the-reader'))
    const intent = recording.stripeCalls.find((call) => call.method === 'paymentIntents.create')
    expect(intent?.params).toMatchObject({ amount: Math.round((quotes[0]?.totals.toCollect.reader ?? 0) * 100) })
  })

  it('Q6: the quote shows the discount the order gives, which the old screen left out', async () => {
    const { parity } = await run(byName('q6-promo-on-buy-new-seats'))
    expect(parity.map((row) => row.matches)).toEqual([true])

    // What the screen asked for: the membership's line only, as it leaves out buy-new seats.
    const answer = await realWorker({
      path: '/api/v1/staff/promo-codes/validate',
      method: 'POST',
      headers: { 'x-staff-email': REPLAY_USER.email },
      body: { code: PROMO.percent, customerId: ID.customer, lines: [{ key: 'membership', itemType: 'membership', amount: 40, isMemberPriced: false }] },
    })
    const screen = (answer.data as { data: { discountTotal: number } }).data.discountTotal
    expect(screen).toBe(4)
    expect(quotes[0]?.totals.promoDiscount).toBe(6)
    expect(SCREEN_DIFFERENCE.path.test('promoDiscount')).toBe(true)
  })

  // --- Brief W06: the dry run beside the quote

  describe('the dry run', () => {
    const CASH = 'cash-booking-two-guests-addon'
    type DryRunBody = { ok: boolean; data?: { order: unknown; rows: { booking: { price_paid: number; seats: Array<Record<string, unknown>> } | null } } }
    const timingOf = (row: ParityRow | undefined) => (row?.new_result as { timing: Record<string, number | null> }).timing

    /** The real Worker, with the dry run's answer changed by `change`. */
    const changingTheDryRun = (change: (body: DryRunBody) => DryRunBody) => async (call: WorkerCall) => {
      const answer = await realWorker(call)
      return call.path === DRY_RUN_PATH ? { data: change(answer.data as DryRunBody) } : answer
    }

    it('records each step of its own, in whole milliseconds', async () => {
      const { dryRunRows } = await run(byName(CASH))
      const timing = timingOf(dryRunRows[0])
      expect(Object.keys(timing).sort()).toEqual(['dryRunMs', 'orderMs', 'quoteMs', 'readBackMs', 'totalMs'])
      for (const value of Object.values(timing)) expect(Number.isInteger(value)).toBe(true)
    })

    it('is asked beside the quote: a slow dry run shows as the dry run, not the quote', async () => {
      const { quoteRows, dryRunRows } = await run(byName(CASH), async (call) => {
        if (call.path === DRY_RUN_PATH) vi.setSystemTime(Date.now() + 1_234)
        return realWorker(call)
      })
      expect(timingOf(dryRunRows[0])['dryRunMs']).toBeGreaterThanOrEqual(1_234)
      expect(timingOf(dryRunRows[0])['orderMs']).toBeLessThan(1_234)
      expect(timingOf(quoteRows[0])['totalMs']).toBeGreaterThanOrEqual(1_234)
    })

    it('a difference in the rows is caught, with no customer details kept', async () => {
      const { dryRunRows } = await run(
        byName(CASH),
        changingTheDryRun((body) => ({ ...body, data: body.data && { ...body.data, rows: { ...body.data.rows, booking: body.data.rows.booking && { ...body.data.rows.booking, price_paid: 41 } } } }))
      )
      expect(dryRunRows.map((row) => row.matches)).toEqual([false])
      expect(dryRunRows[0]?.diff).toEqual([{ path: 'rows.booking.price_paid', oldValue: 40, newValue: 41 }])
      const logged = JSON.stringify(dryRunRows)
      for (const text of ['Sam Test', 'Alex Guest', 'sam@example.com', '1990-01-01']) expect(logged).not.toContain(text)
      expect(dryRunRows[0]?.new_result).toMatchObject({ freeTextMatches: true })
    })

    it('two seats the other way round are caught', async () => {
      const { dryRunRows } = await run(
        byName(CASH),
        changingTheDryRun((body) => {
          const booking = body.data?.rows.booking
          if (!booking) return body
          return { ...body, data: { ...(body.data as NonNullable<DryRunBody['data']>), rows: { ...(body.data as NonNullable<DryRunBody['data']>).rows, booking: { ...booking, seats: [...booking.seats].reverse() } } } }
        })
      )
      expect(dryRunRows.map((row) => row.matches)).toEqual([false])
      expect(dryRunRows[0]?.diff?.map((d) => d.path)).toContain('rows.booking.seats.0.guest_type')
    })

    it('a different name is compared and not kept: only whether it matched', async () => {
      const { dryRunRows } = await run(
        byName(CASH),
        changingTheDryRun((body) => {
          const booking = body.data?.rows.booking
          if (!booking) return body
          const seats = booking.seats.map((seat, i) => (i === 1 ? { ...seat, guest_name: 'Somebody Else' } : seat))
          return { ...body, data: { ...(body.data as NonNullable<DryRunBody['data']>), rows: { ...(body.data as NonNullable<DryRunBody['data']>).rows, booking: { ...booking, seats } } } }
        })
      )
      expect(dryRunRows.map((row) => row.matches)).toEqual([false])
      expect(dryRunRows[0]?.diff).toEqual([])
      expect(dryRunRows[0]?.new_result).toMatchObject({ freeTextMatches: false })
      expect(JSON.stringify(dryRunRows)).not.toContain('Somebody Else')
    })

    it('a refusal is compared with the order\'s, words left out', async () => {
      const { dryRunRows } = await run(byName('refused-session-full'))
      expect(dryRunRows.map((row) => row.matches)).toEqual([true])
    })

    it('an order the dry run refused is caught', async () => {
      const { dryRunRows } = await run(byName(CASH), async (call) => {
        if (call.path !== DRY_RUN_PATH) return realWorker(call)
        await environment.database.db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
        const answer = await realWorker(call)
        await environment.database.db.query('UPDATE sessions SET total_booked = 0 WHERE id = $1', [ID.session])
        return answer
      })
      expect(dryRunRows.map((row) => row.matches)).toEqual([false])
      expect(dryRunRows[0]?.new_result).toMatchObject({ refusal: { reason: 'insufficient_capacity' } })
    })

    it('out of its scope it records nothing more', async () => {
      const { quoteRows, dryRunRows } = await run(byName(CARD_ORDER))
      expect(quoteRows).toHaveLength(1)
      expect(dryRunRows).toEqual([])
    })

    describe('a dry run that fails changes nothing, and says so', () => {
      const unchanged = async (worker: (call: WorkerCall) => Promise<{ data: unknown }>) => {
        const { recording, dryRunRows } = await run(byName(CASH), worker)
        expect(compareRecordings(withoutGoneNumbers(readGolden(CASH) as Recording), withoutShadowRows(recording))).toEqual([])
        return dryRunRows
      }

      it('the Worker refuses it with a fault', async () => {
        const rows = await unchanged(async (call) =>
          call.path === DRY_RUN_PATH ? { data: { ok: false, requestId: 'r', error: { code: 'INTERNAL', message: 'It broke.' } } } : realWorker(call)
        )
        expect(rows.map((row) => row.matches)).toEqual([false])
        expect(JSON.stringify(rows[0]?.diff)).toContain('It broke.')
      })

      it('the Worker answers with nonsense', async () => {
        const rows = await unchanged(async (call) => (call.path === DRY_RUN_PATH ? { data: '<html>Bad gateway</html>' } : realWorker(call)))
        expect(rows.map((row) => row.matches)).toEqual([false])
      })

      it('the Worker never answers: the order goes ahead after 5 seconds', { timeout: 15_000 }, async () => {
        const rows = await unchanged((call) => (call.path === DRY_RUN_PATH ? new Promise(() => undefined) : realWorker(call)))
        expect(rows.map((row) => row.matches)).toEqual([false])
        expect(JSON.stringify(rows[0]?.diff)).toContain("didn't answer in time")
      })
    })

    it('an order that has already taken 40 seconds is answered straight away: neither is recorded', async () => {
      const { parity, recording } = await run(byName(CASH), async (call) => {
        if (call.path === DRY_RUN_PATH) vi.setSystemTime(Date.now() + 40_001)
        return realWorker(call)
      })
      expect(parity).toEqual([])
      expect(compareRecordings(withoutGoneNumbers(readGolden(CASH) as Recording), withoutShadowRows(recording))).toEqual([])
    })

    describe('W07: what products, postage, passes and gift cards write', () => {
      type Rows = Record<string, unknown> & { order: Record<string, unknown>; customer_address: Record<string, unknown> | null; gift_cards: Array<Record<string, unknown>>; stock: Array<Record<string, unknown>>; stock_adjustments: Array<Record<string, unknown>>; session_passes: Array<Record<string, unknown>> }
      type W07Body = { ok: boolean; data?: { order: Record<string, unknown>; rows: Rows } }
      /** The real Worker, with the dry run's rows or answer changed. */
      const changing = (change: (data: NonNullable<W07Body['data']>) => NonNullable<W07Body['data']>) => async (call: WorkerCall) => {
        const answer = await realWorker(call)
        if (call.path !== DRY_RUN_PATH) return answer
        const body = answer.data as W07Body
        return { data: { ...body, data: body.data && change(body.data) } }
      }
      const GIFT = 'w07-gift-card-custom-amount-picked-up-in-cash'
      const SAVED = 'w07-delivery-address-saved-to-the-customer'
      const PASS = 'w07-pass-on-its-own-in-cash'
      const PRODUCT = 'w07-pickup-product-in-cash'

      it('a gift card is compared by its format and count, and no code reaches parity_log', async () => {
        const { dryRunRows } = await run(byName(GIFT))
        expect(dryRunRows.map((row) => row.matches)).toEqual([true])
        const caught = await run(byName(GIFT), changing((data) => ({ ...data, order: { ...data.order, giftCardCode: 'NOT-A-CODE' } })))
        expect(caught.dryRunRows[0]?.diff).toEqual([{ path: 'result.giftCardCodeLooksRight', oldValue: true, newValue: false }])
        const fewer = await run(byName(GIFT), changing((data) => ({ ...data, rows: { ...data.rows, gift_cards: [] } })))
        expect(fewer.dryRunRows.map((row) => row.matches)).toEqual([false])
        for (const rows of [dryRunRows, caught.dryRunRows, fewer.dryRunRows]) expect(JSON.stringify(rows)).not.toMatch(/PWC-|NOT-A-CODE/)
      })

      it('a gift card\'s recipient and message are compared and not kept', async () => {
        const { dryRunRows } = await run(
          byName(GIFT),
          changing((data) => ({ ...data, rows: { ...data.rows, gift_cards: data.rows.gift_cards.map((card) => ({ ...card, recipient_name: 'Somebody Else' })) } }))
        )
        expect(dryRunRows.map((row) => row.matches)).toEqual([false])
        expect(dryRunRows[0]?.diff).toEqual([])
        expect(dryRunRows[0]?.new_result).toMatchObject({ freeTextMatches: false })
        for (const text of ['Somebody Else', 'Ali Friend', 'ali@example.com', 'Happy birthday']) expect(JSON.stringify(dryRunRows)).not.toContain(text)
      })

      it('the delivery address and the address saved to the customer are compared and not kept', async () => {
        const { dryRunRows } = await run(byName(SAVED))
        expect(dryRunRows.map((row) => row.matches)).toEqual([true])
        const moved = await run(
          byName(SAVED),
          changing((data) => ({ ...data, rows: { ...data.rows, customer_address: { ...data.rows.customer_address, line1: '2 Mill Lane' } } }))
        )
        expect(moved.dryRunRows.map((row) => row.matches)).toEqual([false])
        expect(moved.dryRunRows[0]?.new_result).toMatchObject({ freeTextMatches: false })
        const unsaved = await run(
          byName(SAVED),
          changing((data) => ({ ...data, rows: { ...data.rows, customer_address: { ...data.rows.customer_address, line1: null } } }))
        )
        expect(unsaved.dryRunRows[0]?.diff).toEqual([{ path: 'rows.customer_address.line1', oldValue: '<set>', newValue: null }])
        for (const rows of [dryRunRows, moved.dryRunRows, unsaved.dryRunRows]) {
          for (const text of ['Mill Lane', 'HX7', 'Hebden', 'Sam Test']) expect(JSON.stringify(rows)).not.toContain(text)
        }
      })

      it('the stock, the ledger and a pass are compared', async () => {
        const stock = await run(byName(PRODUCT), changing((data) => ({ ...data, rows: { ...data.rows, stock: data.rows.stock.map((row) => ({ ...row, stock_quantity: 4 })) } })))
        expect(stock.dryRunRows[0]?.diff).toEqual([{ path: 'rows.stock.0.stock_quantity', oldValue: 3, newValue: 4 }])
        const ledger = await run(byName(PRODUCT), changing((data) => ({ ...data, rows: { ...data.rows, stock_adjustments: [] } })))
        expect(ledger.dryRunRows[0]?.diff?.map((d) => d.path)).toEqual(['rows.stock_adjustments.0'])
        const pass = await run(byName(PASS), changing((data) => ({ ...data, rows: { ...data.rows, session_passes: data.rows.session_passes.map((row) => ({ ...row, sessions_remaining: 4 })) } })))
        expect(pass.dryRunRows[0]?.diff).toEqual([{ path: 'rows.session_passes.0.sessions_remaining', oldValue: 5, newValue: 4 }])
      })

      describe('W07a (S1): the shadow keeps only the keys its own read-back has', () => {
        const EVERY_KIND = 'w07-every-kind-in-cash'
        const FREE_TEXT = ['7 Canal Street', 'Todmorden', 'Ali Friend', 'ali@example.com', '07700 900123', 'Mill Lane', '1990-01-01', 'Happy birthday']
        /** A later Worker's read-back: free text in keys this version has never heard of, at every level. */
        const withUnknownKeys = (data: NonNullable<W07Body['data']>): NonNullable<W07Body['data']> => {
          const rows = data.rows as Rows & { lines: Array<Record<string, unknown>>; booking: (Record<string, unknown> & { seats: Array<Record<string, unknown>>; addons: Array<Record<string, unknown>> }) | null }
          return {
            ...data,
            rows: {
              ...rows,
              attendees: [{ name: 'Ali Friend', email: 'ali@example.com', date_of_birth: '1990-01-01' }],
              order: { ...rows.order, billing_address: '7 Canal Street, Todmorden' },
              lines: rows.lines.map((line) => ({ ...line, buyer_email: 'ali@example.com' })),
              booking: rows.booking && {
                ...rows.booking,
                emergency_contact: 'Ali Friend 07700 900123',
                seats: rows.booking.seats.map((seat) => ({ ...seat, phone: '07700 900123' })),
                addons: rows.booking.addons.map((addon) => ({ ...addon, note: 'Mill Lane' })),
              },
              stock: rows.stock.map((row) => ({ ...row, warehouse: 'Mill Lane' })),
              stock_adjustments: rows.stock_adjustments.map((row) => ({ ...row, staff_name: 'Ali Friend' })),
              session_passes: rows.session_passes.map((row) => ({ ...row, holder: 'Ali Friend' })),
              gift_cards: rows.gift_cards.map((card) => ({ ...card, recipient_phone: '07700 900123', delivery_note: 'Happy birthday' })),
              customer_address: rows.customer_address && { ...rows.customer_address, county: 'Todmorden' },
            },
          }
        }
        // attendees, billing_address, emergency_contact, county; one per line (5), seat (1), add-on (1), stock (1), ledger row (1), pass (1); two per gift card (1)
        const UNKNOWN_KEYS = 4 + 5 + 1 + 1 + 1 + 1 + 1 + 2

        it("the shadow's key lists are exactly the keys the read-back returns, section by section", async () => {
          let rows: Rows | undefined
          let w09Rows: Rows | undefined
          // W08's every kind: W07's with an event, so every section has a row; W09's worst basket for the promo, store credit and gift card paid with.
          await run(byName('w08-every-kind-in-cash'), changing((data) => {
            rows = data.rows
            return data
          }))
          await run(byName('w09-worst-basket'), changing((data) => {
            w09Rows = data.rows
            return data
          }))
          const paid = w09Rows as Rows & { promo_redemptions: unknown[]; store_credit_transactions: unknown[]; gift_card_redemptions: unknown[] }
          const shadow = (await import(/* @vite-ignore */ path.join(backendDir, 'shared/orderQuoteShadow.ts'))) as { ORDER_ROWS_KEYS: Record<string, readonly string[]> }
          const keys = (value: unknown) => Object.keys(value as object).sort()
          const all = rows as Rows & { lines: unknown[]; booking: { seats: unknown[]; addons: unknown[] }; event_booking: { attendees: unknown[] } }
          const sections: Record<string, unknown> = {
            rows: all,
            order: all.order,
            line: all.lines[0],
            booking: all.booking,
            seat: all.booking.seats[0],
            addon: all.booking.addons[0],
            stock: all.stock[0],
            ledgerRow: all.stock_adjustments[0],
            pass: all.session_passes[0],
            giftCard: all.gift_cards[0],
            customerAddress: all.customer_address,
            eventBooking: all.event_booking,
            attendee: all.event_booking.attendees[0],
            promoRedemption: paid.promo_redemptions[0],
            storeCreditTransaction: paid.store_credit_transactions[0],
            giftCardRedemption: paid.gift_card_redemptions[0],
          }
          expect(keys(paid)).toEqual(keys(all))
          expect(Object.keys(shadow.ORDER_ROWS_KEYS).sort()).toEqual(Object.keys(sections).sort())
          for (const [section, value] of Object.entries(sections)) {
            expect(value, `${section} is in the basket`).toBeTruthy()
            expect([...(shadow.ORDER_ROWS_KEYS[section] ?? [])].sort(), section).toEqual(keys(value))
          }
        })

        it('an extra free-text field never reaches parity_log; how many were dropped does, on a match', async () => {
          const { dryRunRows } = await run(byName(EVERY_KIND), changing(withUnknownKeys))
          expect(dryRunRows).toEqual([{ action: DRY_RUN, matches: true, diff: null, old_result: null, new_result: { timing: expect.anything(), droppedKeys: UNKNOWN_KEYS } }])
          for (const text of FREE_TEXT) expect(JSON.stringify(dryRunRows)).not.toContain(text)
        })

        it('and on a difference: the diff and both sides hold none of it, only the count', async () => {
          const { dryRunRows } = await run(
            byName(EVERY_KIND),
            changing((data) => {
              const changed = withUnknownKeys(data)
              return { ...changed, rows: { ...changed.rows, stock: changed.rows.stock.map((row) => ({ ...row, stock_quantity: 99 })) } }
            })
          )
          expect(dryRunRows.map((row) => row.matches)).toEqual([false])
          expect(dryRunRows[0]?.diff).toEqual([{ path: 'rows.stock.0.stock_quantity', oldValue: 3, newValue: 99 }])
          expect(dryRunRows[0]?.new_result).toMatchObject({ droppedKeys: UNKNOWN_KEYS, freeTextMatches: true })
          for (const text of FREE_TEXT) expect(JSON.stringify(dryRunRows)).not.toContain(text)
          for (const key of ['attendees', 'billing_address', 'emergency_contact', 'county', 'recipient_phone', 'buyer_email']) expect(JSON.stringify(dryRunRows)).not.toContain(key)
        })

        it('a section in a shape this version does not know is dropped whole, and counted', async () => {
          const { dryRunRows } = await run(
            byName(SAVED),
            changing((data) => ({ ...data, rows: { ...data.rows, customer_address: '7 Canal Street, Todmorden' as unknown as Rows['customer_address'] } }))
          )
          expect(dryRunRows.map((row) => row.matches)).toEqual([false])
          expect(dryRunRows[0]?.new_result).toMatchObject({ droppedKeys: 1 })
          for (const text of FREE_TEXT) expect(JSON.stringify(dryRunRows)).not.toContain(text)
        })

        it('a reply with nothing unknown records no count', async () => {
          const { dryRunRows } = await run(byName(EVERY_KIND))
          expect(dryRunRows).toEqual([{ action: DRY_RUN, matches: true, diff: null, old_result: null, new_result: { timing: expect.anything() } }])
        })
      })

      it("an old order that warned (its address save failed after it was paid) is caught: the Worker's order never warns", async () => {
        const db = environment.database.db
        const failCustomers = async (on: boolean) => {
          await db.query('RESET ROLE')
          if (on) {
            await db.query(`CREATE OR REPLACE FUNCTION public.fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'connection lost'; END $$`)
            await db.query('CREATE TRIGGER fail_write BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.fail_write()')
          } else {
            await db.query('DROP TRIGGER IF EXISTS fail_write ON public.customers')
          }
          await db.query('SET ROLE paddock_worker')
        }
        try {
          // The dry run runs whole first; only the old order's own save then fails.
          const { dryRunRows } = await run(byName(SAVED), async (call) => {
            const answer = await realWorker(call)
            if (call.path === DRY_RUN_PATH) await failCustomers(true)
            return answer
          })
          expect(dryRunRows.map((row) => row.matches)).toEqual([false])
          expect(dryRunRows[0]?.diff?.map((d) => d.path)).toContain('result.hasWarning')
        } finally {
          await failCustomers(false)
        }
      })
    })

    describe('W08: what an event writes', () => {
      type Attendee = Record<string, unknown> & { name: string; email: string | null; date_of_birth: string | null; unit_price: number }
      type EventBookingRows = Record<string, unknown> & { event_places_booked: number; attendees: Attendee[] }
      type W08Body = { ok: boolean; data?: { order: Record<string, unknown>; rows: Record<string, unknown> & { event_booking: EventBookingRows | null } } }
      /** The real Worker, with the dry run's rows or answer changed. */
      const changing = (change: (data: NonNullable<W08Body['data']>) => NonNullable<W08Body['data']>) => async (call: WorkerCall) => {
        const answer = await realWorker(call)
        if (call.path !== DRY_RUN_PATH) return answer
        const body = answer.data as W08Body
        return { data: { ...body, data: body.data && change(body.data) } }
      }
      /** The dry run's event booking changed by `change`. */
      const changingTheEvent = (change: (booking: EventBookingRows) => EventBookingRows) =>
        changing((data) => ({ ...data, rows: { ...data.rows, event_booking: data.rows.event_booking && change(data.rows.event_booking) } }))
      const WORST = 'w08-worst-basket'
      const EVENT = 'event-with-a-guest-in-cash'
      // Every attendee's name, email and date of birth in the worst basket, and its address.
      const ATTENDEE_TEXT = ['Sam Test', 'Alex Guest', 'Bea Guest', 'sam@example.com', 'alex@example.com', 'bea@example.com', '1990-01-01', 'Mill Lane']

      it('an event order is a match, and no attendee name, email or date of birth reaches parity_log', async () => {
        const { dryRunRows } = await run(byName(WORST))
        expect(dryRunRows).toEqual([{ action: DRY_RUN, matches: true, diff: null, old_result: null, new_result: { timing: expect.anything() } }])
        for (const text of ATTENDEE_TEXT) expect(JSON.stringify(dryRunRows)).not.toContain(text)
      })

      it('a different name, email or date of birth is compared and not kept: only whether they matched', async () => {
        for (const change of [
          (a: Attendee, i: number) => (i === 1 ? { ...a, name: 'Somebody Else' } : a),
          (a: Attendee, i: number) => (i === 2 ? { ...a, email: 'someone@example.com' } : a),
          (a: Attendee, i: number) => (i === 0 ? { ...a, date_of_birth: '1991-09-09' } : a),
        ]) {
          const { dryRunRows } = await run(byName(WORST), changingTheEvent((booking) => ({ ...booking, attendees: booking.attendees.map(change) })))
          expect(dryRunRows.map((row) => row.matches)).toEqual([false])
          expect(dryRunRows[0]?.diff).toEqual([])
          expect(dryRunRows[0]?.new_result).toMatchObject({ freeTextMatches: false })
          for (const text of [...ATTENDEE_TEXT, 'Somebody Else', 'someone@example.com', '1991-09-09']) expect(JSON.stringify(dryRunRows)).not.toContain(text)
        }
      })

      it('an email or a date of birth that is there on one side only shows as just that, with neither value', async () => {
        const { dryRunRows } = await run(byName(WORST), changingTheEvent((booking) => ({ ...booking, attendees: booking.attendees.map((a, i) => (i === 0 ? { ...a, email: null, date_of_birth: null } : a)) })))
        expect(dryRunRows[0]?.diff).toEqual([
          { path: 'rows.event_booking.attendees.0.date_of_birth', oldValue: '<set>', newValue: null },
          { path: 'rows.event_booking.attendees.0.email', oldValue: '<set>', newValue: null },
        ])
        for (const text of ATTENDEE_TEXT) expect(JSON.stringify(dryRunRows)).not.toContain(text)
      })

      it("the event's places, an attendee's price and the attendees' order are compared", async () => {
        const places = await run(byName(EVENT), changingTheEvent((booking) => ({ ...booking, event_places_booked: 3 })))
        expect(places.dryRunRows[0]?.diff).toEqual([{ path: 'rows.event_booking.event_places_booked', oldValue: 2, newValue: 3 }])
        const price = await run(byName(EVENT), changingTheEvent((booking) => ({ ...booking, attendees: booking.attendees.map((a, i) => (i === 1 ? { ...a, unit_price: 30 } : a)) })))
        expect(price.dryRunRows[0]?.diff).toEqual([{ path: 'rows.event_booking.attendees.1.unit_price', oldValue: 40, newValue: 30 }])
        const reversed = await run(byName(EVENT), changingTheEvent((booking) => ({ ...booking, attendees: [...booking.attendees].reverse() })))
        expect(reversed.dryRunRows[0]?.diff?.map((d) => d.path)).toContain('rows.event_booking.attendees.0.attendee_type')
      })

      it('an event booking missing from either the rows or the answer is caught', async () => {
        const rows = await run(byName(EVENT), changing((data) => ({ ...data, rows: { ...data.rows, event_booking: null } })))
        expect(rows.dryRunRows.map((row) => row.matches)).toEqual([false])
        expect(rows.dryRunRows[0]?.diff?.map((d) => d.path)).toEqual(['rows.event_booking'])
        const answer = await run(byName(EVENT), changing((data) => ({ ...data, order: { ...data.order, eventBookingId: null } })))
        expect(answer.dryRunRows[0]?.diff).toEqual([{ path: 'result.hasEventBooking', oldValue: true, newValue: false }])
        for (const text of ATTENDEE_TEXT) expect(JSON.stringify([...rows.dryRunRows, ...answer.dryRunRows])).not.toContain(text)
      })

      it("an event refusal's words, which name the attendee, are compared and not kept", async () => {
        const { dryRunRows, quoteRows } = await run(byName('w08-refused-event-account-holder-with-no-date-of-birth'))
        expect(dryRunRows.map((row) => row.matches)).toEqual([true])
        expect(quoteRows.map((row) => row.matches)).toEqual([true])
        expect(JSON.stringify([...dryRunRows, ...quoteRows])).not.toContain('Sam Test')
      })

      it('keys this version does not know, in the event booking and on each attendee, are dropped unread and counted', async () => {
        const { dryRunRows } = await run(
          byName(WORST),
          changingTheEvent((booking) => ({
            ...booking,
            emergency_contact: 'Ali Friend 07700 900123',
            attendees: booking.attendees.map((a) => ({ ...a, phone: '07700 900123', dietary_note: 'Ali Friend' })),
          }))
        )
        // One on the booking, two on each of three attendees.
        expect(dryRunRows).toEqual([{ action: DRY_RUN, matches: true, diff: null, old_result: null, new_result: { timing: expect.anything(), droppedKeys: 7 } }])
        for (const text of [...ATTENDEE_TEXT, 'Ali Friend', '07700 900123', 'emergency_contact', 'dietary_note', 'phone']) expect(JSON.stringify(dryRunRows)).not.toContain(text)
      })

      it('the publish-then-deploy window: a Worker from before W08 (no event booking in its rows or answer) leaves one false row per order, with no values in it', async () => {
        // Release rule (W07 review B1): this staff app is published first, so until the Worker is
        // deployed its dry run answers in W07's shape. An event is NOT_BUILT there, so records nothing.
        const olderWorker = changing((data) => {
          const rows: Record<string, unknown> = { ...data.rows }
          delete rows['event_booking']
          const order: Record<string, unknown> = { ...data.order }
          delete order['eventBookingId']
          return { ...data, order, rows: rows as typeof data.rows }
        })
        const placed = await run(byName('cash-booking-two-guests-addon'), olderWorker)
        expect(placed.dryRunRows.map((row) => row.matches)).toEqual([false])
        expect(placed.dryRunRows[0]?.diff).toEqual([{ path: 'rows.event_booking', oldValue: null }])
        for (const text of ['Sam Test', 'Alex Guest', 'sam@example.com', '1990-01-01']) expect(JSON.stringify(placed.dryRunRows)).not.toContain(text)
        const refused = await run(byName('refused-session-full'), olderWorker)
        expect(refused.dryRunRows.map((row) => row.matches)).toEqual([true])
      })
    })

    describe('W09: what a promo code, store credit and a gift card write', () => {
      type W09Rows = Record<string, unknown> & {
        promo_redemptions: Array<Record<string, unknown>>
        store_credit_transactions: Array<Record<string, unknown> & { note: string | null }>
        gift_card_redemptions: Array<Record<string, unknown>>
        customer_store_credit_balance: number | null
        booking: (Record<string, unknown> & { seats: unknown }) | null
        event_booking: (Record<string, unknown> & { attendees: unknown }) | null
      }
      type W09Body = { ok: boolean; data?: { order: Record<string, unknown> & { payment: Record<string, unknown> }; rows: W09Rows } }
      /** The real Worker, with the dry run's rows or answer changed. */
      const changing = (change: (data: NonNullable<W09Body['data']>) => NonNullable<W09Body['data']>) => async (call: WorkerCall) => {
        const answer = await realWorker(call)
        if (call.path !== DRY_RUN_PATH) return answer
        const body = answer.data as W09Body
        return { data: { ...body, data: body.data && change(body.data) } }
      }
      const changingRows = (change: (rows: W09Rows) => W09Rows) => changing((data) => ({ ...data, rows: change(data.rows) }))
      const WORST = 'w09-worst-basket'
      const NOTE = 'Store credit redeemed at checkout.'
      // The worst basket's free text, its store credit note, and gift card codes: the seed card's own, and the start of the app's.
      const FREE_TEXT = ['Sam Test', 'Alex Guest', 'Bea Guest', 'sam@example.com', 'alex@example.com', 'bea@example.com', '1990-01-01', 'Mill Lane', 'HX7', NOTE, 'SEEDCARD', 'PWC-']
      const notIn = (rows: ParityRow[], texts: readonly string[]) => {
        for (const text of texts) expect(JSON.stringify(rows)).not.toContain(text)
      }
      const UNREADABLE = "The dry run's rows were not in a shape this version can read, so they were not compared."
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      /** The old side's two read-backs (the quote's figures and ORDER_ROWS_SQL), both of the order by its id. */
      const isReadBack = (sql: string) => /^\s*WITH o AS \(SELECT \* FROM orders WHERE id = \$1\)/.test(sql)

      it('the worst basket is a match, quote and dry run, and nothing of it reaches parity_log', async () => {
        const { dryRunRows, quoteRows } = await run(byName(WORST))
        expect(dryRunRows).toEqual([{ action: DRY_RUN, matches: true, diff: null, old_result: null, new_result: { timing: expect.anything() } }])
        expect(quoteRows.map((row) => row.matches)).toEqual([true])
        notIn([...dryRunRows, ...quoteRows], FREE_TEXT)
      })

      it('on a difference both sides are kept whole: the note only as whether it was there, no gift card code anywhere', async () => {
        const { dryRunRows } = await run(byName(WORST), changingRows((rows) => ({ ...rows, customer_store_credit_balance: 19 })))
        expect(dryRunRows.map((row) => row.matches)).toEqual([false])
        expect(dryRunRows[0]?.diff).toEqual([{ path: 'rows.customer_store_credit_balance', oldValue: 20, newValue: 19 }])
        expect(dryRunRows[0]?.old_result).toMatchObject({
          rows: {
            store_credit_transactions: [{ amount: -10, balance_after: 20, note: '<set>' }],
            gift_card_redemptions: [{ gift_card_id: ID.giftCard, amount_used: 20, card_remaining_balance: 20, card_redeemed: false }],
            promo_redemptions: [{ promo_code_id: ID.promoFixed, discount_amount: 5 }],
          },
        })
        expect(dryRunRows[0]?.new_result).toMatchObject({ freeTextMatches: true })
        notIn(dryRunRows, FREE_TEXT)
      })

      it('a different store credit note is compared and not kept: only whether it matched', async () => {
        const other = 'Goodwill for Sam Test [ref 6f1c2d3e-0000-4000-8000-000000000000]'
        const { dryRunRows } = await run(byName(WORST), changingRows((rows) => ({ ...rows, store_credit_transactions: rows.store_credit_transactions.map((t) => ({ ...t, note: other })) })))
        expect(dryRunRows.map((row) => row.matches)).toEqual([false])
        expect(dryRunRows[0]?.diff).toEqual([])
        expect(dryRunRows[0]?.new_result).toMatchObject({ freeTextMatches: false })
        notIn(dryRunRows, [...FREE_TEXT, other, 'Goodwill', '6f1c2d3e'])
        const gone = await run(byName(WORST), changingRows((rows) => ({ ...rows, store_credit_transactions: rows.store_credit_transactions.map((t) => ({ ...t, note: null })) })))
        expect(gone.dryRunRows[0]?.diff).toEqual([{ path: 'rows.store_credit_transactions.0.note', oldValue: '<set>', newValue: null }])
        notIn(gone.dryRunRows, FREE_TEXT)
      })

      it("each figure is compared: the promo's use, the store credit taken, the gift card used and its balance after, and the customer's balance", async () => {
        const cases: Array<[(rows: W09Rows) => W09Rows, string]> = [
          [(rows) => ({ ...rows, promo_redemptions: rows.promo_redemptions.map((r) => ({ ...r, discount_amount: 4 })) }), 'rows.promo_redemptions.0.discount_amount'],
          [(rows) => ({ ...rows, promo_redemptions: [] }), 'rows.promo_redemptions.0'],
          [(rows) => ({ ...rows, store_credit_transactions: rows.store_credit_transactions.map((t) => ({ ...t, amount: -9 })) }), 'rows.store_credit_transactions.0.amount'],
          [(rows) => ({ ...rows, store_credit_transactions: rows.store_credit_transactions.map((t) => ({ ...t, balance_after: 21 })) }), 'rows.store_credit_transactions.0.balance_after'],
          [(rows) => ({ ...rows, gift_card_redemptions: rows.gift_card_redemptions.map((r) => ({ ...r, amount_used: 19 })) }), 'rows.gift_card_redemptions.0.amount_used'],
          [(rows) => ({ ...rows, gift_card_redemptions: rows.gift_card_redemptions.map((r) => ({ ...r, card_remaining_balance: 21 })) }), 'rows.gift_card_redemptions.0.card_remaining_balance'],
          [(rows) => ({ ...rows, gift_card_redemptions: rows.gift_card_redemptions.map((r) => ({ ...r, card_redeemed: true })) }), 'rows.gift_card_redemptions.0.card_redeemed'],
          [(rows) => ({ ...rows, customer_store_credit_balance: 30 }), 'rows.customer_store_credit_balance'],
        ]
        for (const [change, path] of cases) {
          const { dryRunRows } = await run(byName(WORST), changingRows(change))
          expect(dryRunRows.map((row) => row.matches), path).toEqual([false])
          expect(dryRunRows[0]?.diff?.map((d) => d.path), path).toEqual([path])
          notIn(dryRunRows, FREE_TEXT)
        }
      })

      it('keys this version does not know, on each new row, are dropped unread and counted, a gift card code among them', async () => {
        const { dryRunRows } = await run(
          byName(WORST),
          changingRows((rows) => ({
            ...rows,
            promo_redemptions: rows.promo_redemptions.map((r) => ({ ...r, typed_as: 'fiver for Sam Test' })),
            store_credit_transactions: rows.store_credit_transactions.map((t) => ({ ...t, customer_email: 'sam@example.com' })),
            gift_card_redemptions: rows.gift_card_redemptions.map((r) => ({ ...r, code: 'SEEDCARD' })),
          }))
        )
        expect(dryRunRows).toEqual([{ action: DRY_RUN, matches: true, diff: null, old_result: null, new_result: { timing: expect.anything(), droppedKeys: 3 } }])
        notIn(dryRunRows, [...FREE_TEXT, 'typed_as', 'customer_email', 'fiver'])
      })

      it('W08 review L1: a list in a shape this version cannot read records a false row with no values, not nothing', async () => {
        const unreadable: Array<[string, (rows: W09Rows) => W09Rows]> = [
          ['attendees as text', (rows) => ({ ...rows, event_booking: rows.event_booking && { ...rows.event_booking, attendees: 'Sam Test, Alex Guest' } })],
          ['an attendee that is not a row', (rows) => ({ ...rows, event_booking: rows.event_booking && { ...rows.event_booking, attendees: [null, 'Alex Guest'] } })],
          ['seats as text', (rows) => ({ ...rows, booking: rows.booking && { ...rows.booking, seats: 'Sam Test' } })],
          ['store credit as text', (rows) => ({ ...rows, store_credit_transactions: NOTE as unknown as W09Rows['store_credit_transactions'] })],
          ['a store credit row that is not a row', (rows) => ({ ...rows, store_credit_transactions: [null] as unknown as W09Rows['store_credit_transactions'] })],
          ['gift card redemptions as text', (rows) => ({ ...rows, gift_card_redemptions: 'SEEDCARD' as unknown as W09Rows['gift_card_redemptions'] })],
          ['a promo redemption that is a number', (rows) => ({ ...rows, promo_redemptions: [7] as unknown as W09Rows['promo_redemptions'] })],
          ['the lines as null', (rows) => ({ ...rows, lines: null })],
          // Not a list: knownRowsOnly keeps it, and reducing its free text throws, which is caught the same way.
          ['the order as null', (rows) => ({ ...rows, order: null })],
        ]
        for (const [what, change] of unreadable) {
          const { dryRunRows, quoteRows, recording } = await run(byName(WORST), changingRows(change))
          expect(dryRunRows, what).toEqual([{ action: DRY_RUN, matches: false, diff: [{ path: '', oldValue: null, newValue: UNREADABLE }], old_result: null, new_result: { timing: expect.anything() } }])
          expect(quoteRows.map((row) => row.matches), what).toEqual([true])
          notIn(dryRunRows, FREE_TEXT)
          expect(compareRecordings(withoutGoneNumbers(readGolden(WORST) as Recording), withoutShadowRows(recording)), what).toEqual([])
        }
      })

      it('the publish-then-deploy window: a Worker from before W09 leaves one false row per order, whose only value is the balance', async () => {
        // Release rule (W07 review B1): this staff app is published first, so until the Worker is deployed its
        // dry run answers in W08's shape: none of the four new sections, and no gift card or store credit in the
        // answer. A promo, store credit or gift card order is NOT_BUILT there, so records nothing.
        const olderWorker = changing((data) => {
          const rows: Record<string, unknown> = { ...data.rows }
          for (const key of ['promo_redemptions', 'store_credit_transactions', 'gift_card_redemptions', 'customer_store_credit_balance']) delete rows[key]
          const payment: Record<string, unknown> = { ...data.order.payment }
          delete payment['giftCardApplied']
          delete payment['storeCreditApplied']
          return { ...data, order: { ...data.order, payment }, rows: rows as W09Rows }
        })
        const placed = await run(byName('cash-booking-two-guests-addon'), olderWorker)
        expect(placed.dryRunRows.map((row) => row.matches)).toEqual([false])
        expect(placed.dryRunRows[0]?.diff).toEqual([
          { path: 'rows.customer_store_credit_balance', oldValue: 30 },
          { path: 'rows.gift_card_redemptions', oldValue: [] },
          { path: 'rows.promo_redemptions', oldValue: [] },
          { path: 'rows.store_credit_transactions', oldValue: [] },
        ])
        expect(placed.dryRunRows[0]?.new_result).toMatchObject({ freeTextMatches: true })
        notIn(placed.dryRunRows, ['Sam Test', 'Alex Guest', 'sam@example.com', '1990-01-01'])
        const refused = await run(byName('refused-session-full'), olderWorker)
        expect(refused.dryRunRows.map((row) => row.matches)).toEqual([true])
      })

      describe('the 40-second skip (W03-decisions, "W08 release calls")', () => {
        // Date is faked in the replay; the waits here are real, so they are timed with performance.now().
        it('an order that finished just inside 40 seconds is still read back and recorded, and answered within 5 seconds of it', { timeout: 30_000 }, async () => {
          const started = performance.now()
          const { quoteRows, dryRunRows } = await run(
            byName(CASH),
            async (call) => {
              if (call.path === DRY_RUN_PATH) vi.setSystemTime(Date.now() + 39_900)
              if (call.path === PARITY_PATH) await sleep(1_800)
              return realWorker(call)
            },
            (query) => async (sql, params) => {
              if (isReadBack(sql)) await sleep(2_800)
              return query(sql, params)
            }
          )
          const elapsed = performance.now() - started
          expect(quoteRows.map((row) => row.matches)).toEqual([true])
          expect(dryRunRows.map((row) => row.matches)).toEqual([true])
          // 2.8 s to read back and 1.8 s to record, side by side for the quote and the dry run.
          expect(elapsed).toBeGreaterThan(4_600)
          expect(elapsed).toBeLessThan(5_500)
        })

        it('with neither the read-back nor the record answering, it gives up after 3 + 2 seconds, and the order is as it would be', { timeout: 30_000 }, async () => {
          const started = performance.now()
          const { parity, recording } = await run(
            byName(CASH),
            async (call) => {
              if (call.path === DRY_RUN_PATH) vi.setSystemTime(Date.now() + 39_900)
              if (call.path === PARITY_PATH) return new Promise(() => undefined)
              return realWorker(call)
            },
            (query) => async (sql, params) => (isReadBack(sql) ? new Promise(() => undefined) : query(sql, params))
          )
          const elapsed = performance.now() - started
          expect(parity).toEqual([])
          expect(elapsed).toBeGreaterThan(4_900)
          expect(elapsed).toBeLessThan(6_000)
          expect(compareRecordings(withoutGoneNumbers(readGolden(CASH) as Recording), withoutShadowRows(recording))).toEqual([])
        })
      })
    })

    it('reads the old order back with the Worker\'s own query, word for word', async () => {
      const { ORDER_ROWS_SQL: worker } = await import('@/server/rules/orders/order-rows')
      const shadow = (await import(/* @vite-ignore */ path.join(backendDir, 'shared/orderQuoteShadow.ts'))) as { ORDER_ROWS_SQL: string }
      expect(shadow.ORDER_ROWS_SQL).toBe(worker)
    })
  })
})
