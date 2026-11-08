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
import { W06_SCENARIOS } from './order-differences'
import { QUOTE_DIFFERENCES, SCREEN_DIFFERENCE } from './quote-differences'
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

  /** Runs a scenario with `worker` standing in for the Worker, keeping what the shadow recorded. */
  async function run(scenario: Scenario, worker: (call: WorkerCall) => Promise<{ data: unknown }> = realWorker) {
    let parity: ParityRow[] = []
    const actions: string[] = []
    quotes = []
    const recording = await replay(
      environment,
      scenario,
      (db: Db, stripe: FakeStripe) => {
        const oldOne = oldSide(db, stripe)
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
  ])

  describe.each(scenarios.map((s) => s.name))('%s', (name) => {
    it('the quote and the dry run equal what the order wrote, except the agreed fixes', async () => {
      const { quoteRows, dryRunRows, actions } = await run(byName(name))
      const allowed = QUOTE_DIFFERENCES[name] ?? []
      expect(undecided(quoteRows, allowed)).toEqual([])
      if (notCompared.has(name)) expect(quoteRows).toEqual([])
      else if (allowed.length === 0) expect(quoteRows.map((row) => [row.action, row.matches])).toEqual([[QUOTE, true]])
      else expect(quoteRows.map((row) => row.matches)).toEqual([false])

      // Brief W06: no decided differences for the dry run, so every row it leaves must be a match.
      expect(undecided(dryRunRows, [])).toEqual([])
      expect(dryRunRows.map((row) => row.matches)).not.toContain(false)
      // A single order in W06's scope has its match; any other single order is one the Worker can't take yet.
      const singleOrder = actions.length === 1 && actions[0] === 'createOrder'
      if (W06_SCENARIOS.includes(name)) expect(dryRunRows.map((row) => row.matches)).toEqual([true])
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
      const { parity } = await run(byName('refused-out-of-stock'))
      expect(parity.map((row) => row.matches)).toEqual([true])
      expect(timingOf(parity[0])['readBackMs']).toBeNull()
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
      const { parity, recording } = await run(byName(scenario))
      expect(parity.map((row) => row.matches)).toEqual([true])

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
      const { parity } = await run(byName('refused-out-of-stock'), async (call) => {
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

  describe('finding 12: an order that has already taken 20 seconds', () => {
    const slowing = (ms: number) => async (call: WorkerCall) => {
      if (call.path === QUOTE_PATH) vi.setSystemTime(Date.now() + ms)
      return realWorker(call)
    }

    it('is answered straight away: nothing is read back or recorded, and the order is as it would be', async () => {
      const name = 'cash-booking-two-guests-addon'
      const { parity, recording } = await run(byName(name), slowing(20_001))
      expect(parity).toEqual([])
      expect(compareRecordings(withoutGoneNumbers(readGolden(name) as Recording), withoutShadowRows(recording))).toEqual([])
    })

    it('under the limit it still compares', async () => {
      const { quoteRows, dryRunRows } = await run(byName('cash-booking-two-guests-addon'), slowing(19_000))
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
    const { parity } = await run(scenario, blind)
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

    it('an order that has already taken 20 seconds is answered straight away: neither is recorded', async () => {
      const { parity, recording } = await run(byName(CASH), async (call) => {
        if (call.path === DRY_RUN_PATH) vi.setSystemTime(Date.now() + 20_001)
        return realWorker(call)
      })
      expect(parity).toEqual([])
      expect(compareRecordings(withoutGoneNumbers(readGolden(CASH) as Recording), withoutShadowRows(recording))).toEqual([])
    })

    it('reads the old order back with the Worker\'s own query, word for word', async () => {
      const { ORDER_ROWS_SQL: worker } = await import('@/server/rules/orders/order-rows')
      const shadow = (await import(/* @vite-ignore */ path.join(backendDir, 'shared/orderQuoteShadow.ts'))) as { ORDER_ROWS_SQL: string }
      expect(shadow.ORDER_ROWS_SQL).toBe(worker)
    })
  })
})
