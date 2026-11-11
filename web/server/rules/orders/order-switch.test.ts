import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as dryRunRoute } from '@/app/api/v1/staff/orders/dry-run/route'
import { POST as quoteRoute } from '@/app/api/v1/staff/quotes/basket/route'
import type { Db } from '@/server/db'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ALL_KINDS_ON, orderInput, postOrder } from '@/server/rules/testing/replay/order-side'
import { ID, paidSeat, seed } from '@/server/rules/testing/replay/scenarios'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { kindsOn, ORDER_KINDS, orderKind, orderPathOff } from './order-switch'

// Brief W14a: the switch (W03-plan 3.2) and the staff app's createOrder wrapper with its fallback. The
// rule is tested by what it does; the route and the wrapper on PGlite with the replay seed.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const cash = (amount: number) => ({ method: 'cash', confirmedCashAmount: amount })
/** One seat for Sam, paid in cash: £20 in the seed. */
const cashSeat = { customerId: ID.customer, booking: paidSeat(), payment: cash(20) }

describe('which kind a basket is', () => {
  const cases: Array<[string, Parameters<typeof orderKind>[0], string]> = [
    ['cash', { payment: { method: 'cash' } }, 'no_stripe'],
    ['no method (nothing owed, or gift card and store credit alone)', { payment: {} }, 'no_stripe'],
    ['no payment at all', {}, 'no_stripe'],
    ['the saved card', { payment: { method: 'card' } }, 'saved_card'],
    ['the reader', { payment: { method: 'reader' } }, 'reader'],
    ['a membership on the saved card', { membershipPlanId: ID.plan, payment: { method: 'card' } }, 'membership'],
    ['a membership on the reader', { membershipPlanId: ID.plan, payment: { method: 'reader' } }, 'membership'],
    ['a membership paid wholly by gift card or store credit', { membershipPlanId: ID.plan, payment: {} }, 'membership'],
    ['a membership in cash (the order refuses it)', { membershipPlanId: ID.plan, payment: { method: 'cash' } }, 'membership'],
  ]
  it.each(cases)('%s', (_, input, kind) => {
    expect(orderKind(input)).toBe(kind)
  })
})

describe('what ORDER_SWITCH turns on', () => {
  it('empty, unset or only words it does not know: every kind off', () => {
    for (const value of [undefined, null, '', '   ', 'cash,card', 'NO-STRIPE']) expect([...kindsOn(value)]).toEqual([])
  })
  it('comma or space separated, any case', () => {
    expect([...kindsOn('no_stripe, Saved_Card reader')].sort()).toEqual(['no_stripe', 'reader', 'saved_card'])
    expect([...kindsOn(ORDER_KINDS.join(' '))].sort()).toEqual([...ORDER_KINDS].sort())
  })
  it('a kind off answers ORDER_PATH_OFF naming it; on, nothing', () => {
    const off = orderPathOff({ payment: { method: 'card' } }, 'no_stripe reader membership')
    expect(off).toMatchObject({ code: 'ORDER_PATH_OFF', status: 501, details: { kind: 'saved_card' } })
    expect(orderPathOff({ payment: { method: 'card' } }, 'saved_card')).toBeNull()
    // reader_flows turns no order on.
    expect(orderPathOff({ payment: { method: 'cash' } }, 'reader_flows')).not.toBeNull()
  })
})

describe('the order route and the switch', () => {
  let environment: ReplayEnvironment
  let db: Db

  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    db = environment.database.db
    holder.db = db
  })
  afterAll(() => environment.stop())

  async function freshSeed(): Promise<void> {
    await replay(environment, { name: 'seed only', seed, run: async () => {} }, oldSide)
  }
  const COUNTS = {
    orders: 'SELECT count(*) AS n FROM orders',
    bookings: 'SELECT count(*) AS n FROM bookings',
    audit_log: 'SELECT count(*) AS n FROM audit_log',
  } as const
  const count = async (table: keyof typeof COUNTS) => Number((await db.query<{ n: string }>(COUNTS[table]))[0]?.n ?? 0)
  const businessRows = async () => ({
    orders: await count('orders'),
    bookings: await count('bookings'),
    audit: await count('audit_log'),
    sessions: (await db.query<{ total_booked: number }>('SELECT total_booked FROM sessions WHERE id = $1', [ID.session]))[0]?.total_booked,
  })
  const headers = { authorization: 'Bearer test-staff-api-key', 'x-staff-email': REPLAY_USER.email, 'content-type': 'application/json' }

  const baskets: Array<[string, Record<string, unknown>]> = [
    ['no_stripe', cashSeat],
    ['saved_card', { customerId: ID.customer, booking: paidSeat(), payment: { method: 'card' } }],
    ['reader', { customerId: ID.customer, booking: paidSeat(), payment: { method: 'reader' } }],
    ['membership', { customerId: ID.customer, membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', payment: { method: 'card' } }],
  ]

  it.each(baskets)('%s off: ORDER_PATH_OFF before anything is touched (only the answer stored against the key)', async (kind, basket) => {
    await freshSeed()
    const before = await businessRows()
    const everyOtherKind = ORDER_KINDS.filter((other) => other !== kind).join(',')
    const answer = await postOrder(orderInput(basket), { orderSwitch: everyOtherKind })
    expect(answer.status).toBe(501)
    expect(answer.body).toMatchObject({ ok: false, error: { code: 'ORDER_PATH_OFF', details: { kind } } })
    expect(await businessRows()).toEqual(before)
    const stored = await db.query<{ code: string }>(`SELECT response->'error'->>'code' AS code FROM api_idempotency WHERE endpoint = 'POST /api/v1/staff/orders'`)
    expect(stored.map((row) => row.code)).toEqual(['ORDER_PATH_OFF'])
  })

  it.each(baskets)('%s on (alone): never ORDER_PATH_OFF', async (kind, basket) => {
    await freshSeed()
    const answer = await postOrder(orderInput(basket), { orderSwitch: kind })
    expect(JSON.stringify(answer.body)).not.toContain('ORDER_PATH_OFF')
  })

  it('no_stripe on: the order is placed', async () => {
    await freshSeed()
    const answer = await postOrder(orderInput(cashSeat), { orderSwitch: 'no_stripe' })
    expect(answer.body).toMatchObject({ ok: true, data: { status: 'paid' } })
    expect(await count('orders')).toBe(1)
  })

  it('unset is every kind off', async () => {
    await freshSeed()
    const before = process.env.ORDER_SWITCH
    delete process.env.ORDER_SWITCH
    try {
      const { POST } = await import('@/app/api/v1/staff/orders/route')
      const response = await POST(new Request('https://worker.test/api/v1/staff/orders', { method: 'POST', headers: { ...headers, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(orderInput(cashSeat)) }))
      expect(response.status).toBe(501)
    } finally {
      if (before !== undefined) process.env.ORDER_SWITCH = before
    }
    expect(await count('orders')).toBe(0)
  })

  it('a retry with the same key stays on the old code after the kind is switched on (the stored answer replays)', async () => {
    await freshSeed()
    const key = crypto.randomUUID()
    const first = await postOrder(orderInput(cashSeat), { key, orderSwitch: '' })
    const second = await postOrder(orderInput(cashSeat), { key, orderSwitch: ALL_KINDS_ON })
    expect(first.body).toMatchObject({ ok: false, error: { code: 'ORDER_PATH_OFF' } })
    expect(second.body).toEqual(first.body)
    expect(await count('orders')).toBe(0)
  })

  it('the dry run and the quote ignore the switch', async () => {
    await freshSeed()
    const before = process.env.ORDER_SWITCH
    process.env.ORDER_SWITCH = ''
    try {
      const body = JSON.stringify(orderInput(cashSeat))
      const dryRun = await dryRunRoute(new Request('https://worker.test/api/v1/staff/orders/dry-run', { method: 'POST', headers, body }))
      expect(((await dryRun.json()) as { ok: boolean }).ok).toBe(true)
      const quote = await quoteRoute(new Request('https://worker.test/api/v1/staff/quotes/basket', { method: 'POST', headers, body }))
      expect((await quote.json()) as unknown).toMatchObject({ ok: true, data: { totals: { amountDue: 20 } } })
    } finally {
      if (before === undefined) delete process.env.ORDER_SWITCH
      else process.env.ORDER_SWITCH = before
    }
    expect(await count('orders')).toBe(0)
  })
})

// --- The staff app's createOrder wrapper (W03-plan 3.2), through the real route on the same database.

describe('the staff app createOrder wrapper', () => {
  const createOrderFile = path.join(staffAppDir(), 'backend/paddock/createOrder.ts')
  let environment: ReplayEnvironment
  let db: Db

  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    db = environment.database.db
    holder.db = db
  })
  afterAll(() => environment.stop())
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  type Wrapper = (req: { params: unknown; user: typeof REPLAY_USER }) => Promise<Record<string, unknown>>
  /** Seeds, binds the old side (every kind off unless `orderSwitch` says otherwise), and runs `work` as one scenario. */
  async function run(orderSwitch: string, work: (createOrder: Wrapper) => Promise<void>): Promise<void> {
    await replay(
      environment,
      {
        name: 'wrapper',
        seed,
        run: async () => {
          vi.stubEnv('ORDER_SWITCH', orderSwitch)
          const createOrder = ((await import(/* @vite-ignore */ createOrderFile)) as { default: Wrapper }).default
          await work(createOrder)
        },
      },
      oldSide
    )
  }
  const count = async (sql: string) => Number((await db.query<{ n: string }>(sql))[0]?.n ?? 0)
  const orders = () => count('SELECT count(*) AS n FROM orders')
  /** The Worker's T1 writes order.create; the old createOrder writes no audit row for an order. */
  const workerOrders = () => count("SELECT count(*) AS n FROM audit_log WHERE action = 'order.create'")

  it('kind off: the old code runs, once, and the Worker kept nothing but the answer for the key', async () => {
    let answer: Record<string, unknown> = {}
    await run('', async (createOrder) => {
      answer = await createOrder({ params: { ...cashSeat, idempotencyKey: crypto.randomUUID() }, user: REPLAY_USER })
      // Before the replay takes the switch's own rows out: the one ORDER_PATH_OFF answer.
      expect(await count(`SELECT count(*) AS n FROM api_idempotency WHERE response->'error'->>'code' = 'ORDER_PATH_OFF'`)).toBe(1)
    })
    expect(answer).toMatchObject({ success: true, paymentMethodUsed: 'cash', cardAmount: 20 })
    expect(await orders()).toBe(1)
    expect(await workerOrders()).toBe(0)
  })

  it('kind on: the Worker only, in createOrder\'s shape', async () => {
    let answer: Record<string, unknown> = {}
    await run('no_stripe', async (createOrder) => {
      answer = await createOrder({ params: { ...cashSeat, idempotencyKey: crypto.randomUUID(), confirmed: { amountDue: 20, toCollect: 20 } }, user: REPLAY_USER })
    })
    expect(answer).toMatchObject({ success: true, paymentMethodUsed: 'cash', cardAmount: 20, cardCharged: false })
    expect(typeof answer['orderId']).toBe('string')
    expect(await orders()).toBe(1)
    expect(await workerOrders()).toBe(1)
  })

  it('kind on, the same key twice (an answer lost): one order, the same answer', async () => {
    const answers: Array<Record<string, unknown>> = []
    await run('no_stripe', async (createOrder) => {
      const params = { ...cashSeat, idempotencyKey: crypto.randomUUID() }
      answers.push(await createOrder({ params, user: REPLAY_USER }))
      answers.push(await createOrder({ params, user: REPLAY_USER }))
    })
    expect(answers[1]).toEqual(answers[0])
    expect(await orders()).toBe(1)
  })

  it('kind on, a refusal: the old shape, with the old words to compose, and a definite answer', async () => {
    let answer: Record<string, unknown> = {}
    await run('no_stripe', async (createOrder) => {
      answer = await createOrder({ params: { ...cashSeat, payment: cash(18), idempotencyKey: crypto.randomUUID() }, user: REPLAY_USER })
    })
    expect(answer).toMatchObject({
      success: false,
      stage: 'payment',
      reason: 'cash_amount_changed',
      message: 'The amount due has changed to £20.00. Check it with the customer and confirm again.',
      amountDueTotal: 20,
      workerCode: 'TOTAL_CHANGED',
    })
    expect(await orders()).toBe(0)
  })

  it('no answer from the Worker: no fallback, the no-answer words (W14a2), no order', async () => {
    let answer: Record<string, unknown> = {}
    await run('', async (createOrder) => {
      vi.stubGlobal('paddockWorkerV1', {
        rawRequest: async () => {
          throw new Error('connect ECONNREFUSED')
        },
      })
      answer = await createOrder({ params: { ...cashSeat, idempotencyKey: crypto.randomUUID() }, user: REPLAY_USER })
    })
    expect(answer).toEqual({
      success: false,
      reason: 'worker_unreachable',
      message:
        "Complete Order didn't get an answer, so the order may or may not have gone through. Don't take any payment. Check the Orders page before trying again. If the booking system can't be reached, note the customer's details and check the Orders page before adding the order once it's back.",
      workerCode: 'WORKER_UNREACHABLE',
    })
    expect(await orders()).toBe(0)
  })

  it('any other failure (the Worker may have acted): no fallback', async () => {
    for (const code of ['INTERNAL', 'CONFLICT', 'PAYMENT_UNCONFIRMED', 'NOT_BUILT']) {
      let answer: Record<string, unknown> = {}
      await run('', async (createOrder) => {
        vi.stubGlobal('paddockWorkerV1', {
          rawRequest: async () => ({ data: { ok: false, error: { code, message: `Worker says ${code}` }, requestId: 'r1' } }),
        })
        answer = await createOrder({ params: { ...cashSeat, idempotencyKey: crypto.randomUUID() }, user: REPLAY_USER })
      })
      expect(answer).toMatchObject({ success: false, workerCode: code })
      expect(await orders()).toBe(0)
    }
  })
})
