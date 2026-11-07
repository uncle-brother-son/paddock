import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BasketQuoteOutput } from '@/contracts'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { POST as quoteRoute } from '@/app/api/v1/staff/quotes/basket/route'
import { POST as parityRoute } from '@/app/api/v1/staff/parity/route'
import { POST as promoRoute } from '@/app/api/v1/staff/promo-codes/validate/route'
import { compareRecordings, type AllowedDifference, type Recording } from './compare'
import { oldSide, readGolden, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { QUOTE_DIFFERENCES, SCREEN_DIFFERENCE } from './quote-differences'
import { ID, PROMO, scenarios } from './scenarios'

// The real old createOrder with its shadow switched on, talking to the real quote and parity routes
// on the same database. So each scenario proves two things: what the quote says equals what the
// order writes, except the agreed fixes, and the shadow changes nothing about the order.

const KEY = 'test-staff-api-key'
const QUOTE_PATH = '/api/v1/staff/quotes/basket'
const PARITY_PATH = '/api/v1/staff/parity'
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
    quotes = []
    const recording = await replay(
      environment,
      scenario,
      (db: Db, stripe: FakeStripe) => {
        const side = oldSide(db, stripe)
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
    return { recording, parity }
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

  const notCompared = new Set(['saved-card-declined-rolls-back', 'q24-card-declined-rolls-back'])

  describe.each(scenarios.map((s) => s.name))('%s', (name) => {
    it('the quote equals what the order wrote, except the agreed fixes', async () => {
      const { parity } = await run(byName(name))
      const allowed = QUOTE_DIFFERENCES[name] ?? []
      expect(undecided(parity, allowed)).toEqual([])
      if (notCompared.has(name)) expect(parity).toEqual([])
      else if (allowed.length === 0) expect(parity.map((row) => [row.action, row.matches])).toEqual([['createOrder.quote', true]])
      else expect(parity.map((row) => row.matches)).toEqual([false])
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
    const { parity } = await run(byName('cash-booking-two-guests-addon'))
    expect(parity).toEqual([{ action: 'createOrder.quote', matches: true, diff: null, old_result: null, new_result: { timing: expect.anything() } }])
  })

  describe('timing', () => {
    const timingOf = (row: ParityRow | undefined) => (row?.new_result as { timing: Record<string, number | null> }).timing

    it('a match records each step, in whole milliseconds and nothing else', async () => {
      const { parity } = await run(byName('cash-booking-two-guests-addon'))
      const timing = timingOf(parity[0])
      expect(Object.keys(timing).sort()).toEqual(['orderMs', 'quoteMs', 'readBackMs', 'totalMs'])
      for (const value of Object.values(timing)) expect(Number.isInteger(value)).toBe(true)
    })

    it('the steps are measured separately: a slow quote shows as the quote, and adds to the total', async () => {
      const { parity } = await run(byName('cash-booking-two-guests-addon'), async (call) => {
        if (call.path === QUOTE_PATH) vi.setSystemTime(Date.now() + 1_234)
        return realWorker(call)
      })
      const timing = timingOf(parity[0])
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
      const { parity } = await run(byName('cash-booking-two-guests-addon'), slowing(19_000))
      expect(parity.map((row) => row.matches)).toEqual([true])
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
})
