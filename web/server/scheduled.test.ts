import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { FakeStripe } from '@/server/stripe/fake'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { lapseSweep, type LapseSweepOptions } from '@/server/rules/bookings/lapse-sweep'
import { reconcile, type ReconcileOptions } from '@/server/rules/orders/reconcile'
import { runScheduledReconcile, withScheduled, type ScheduledDeps } from './scheduled'

// W12 item 4: the scheduled handler (server/scheduled.ts) the custom worker adds, tested as Cloudflare calls
// it: `scheduled(controller, env, ctx)`, with the database from env.HYPERDRIVE and Stripe from
// env.STRIPE_SECRET_KEY, here PGlite with the live schema and FakeStripe through the handler's deps.

let database: TestDatabase
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
})
afterAll(() => database.stop())

function depsFor(stripe: FakeStripe) {
  const opened: string[] = []
  const secrets: string[] = []
  const logged: Array<Record<string, unknown>> = []
  let closed = 0
  const deps: ScheduledDeps = {
    openDb(connectionString) {
      opened.push(connectionString)
      // The handler closes what it opened; the test database stays open for the next test.
      return Object.assign(Object.create(database.db) as Db, { close: async () => void (closed += 1) })
    },
    stripe(secretKey) {
      secrets.push(secretKey)
      return stripe
    },
    log: (entry) => logged.push(entry),
    reconcile,
    lapseSweep,
  }
  return { deps, opened, secrets, logged, closed: () => closed }
}

const env = { HYPERDRIVE: { connectionString: 'postgres://hyperdrive.test/paddock' }, STRIPE_SECRET_KEY: 'sk_test_scheduled' }

describe('the scheduled handler', () => {
  it("passes every request to OpenNext's own fetch handler, unchanged", async () => {
    const fetch = vi.fn(async () => new Response('from OpenNext'))
    const worker = withScheduled({ fetch })
    expect(worker.fetch).toBe(fetch)
  })

  it("W59 (W35 audit row 33): the run's log names every item by its outcome, a refund that failed later too, and keeps the count of those left", async () => {
    const stripe = new FakeStripe()
    const seen = depsFor(stripe)
    const answer = {
      refundsWaiting: 0, paymentsWatched: 0, checked: 2, finalised: 0, undone: 0, refunds: 1, left: 1, deferred: 0, stripeRefused: false,
      items: [
        { kind: 'refund_watch', id: 'claim-1', outcome: 'refund_failed', reason: 'failed_later' },
        { kind: 'order', id: 'order-1', outcome: 'left', reason: 'several_payments' },
      ],
    } as unknown as Awaited<ReturnType<typeof reconcile>>
    const worker = withScheduled({ fetch: async () => new Response('') }, { ...seen.deps, reconcile: async () => answer })
    const waited: Array<Promise<unknown>> = []
    await worker.scheduled({ scheduledTime: Date.parse('2026-11-10T12:05:00Z'), cron: '*/5 * * * *' }, env, { waitUntil: (promise) => waited.push(promise) })
    await waited[0]
    expect(seen.logged.find((entry) => entry['event'] === 'reconcile.run')).toMatchObject({
      leftCount: 1,
      left: [{ kind: 'order', id: 'order-1', reason: 'several_payments' }],
      handled: { refund_failed: [{ kind: 'refund_watch', id: 'claim-1', reason: 'failed_later' }] },
    })
  })

  it('hands one reconcile run to ctx.waitUntil, as the system, from the env bindings; logs its counts; closes the database', async () => {
    const stripe = new FakeStripe()
    const seen = depsFor(stripe)
    const worker = withScheduled({ fetch: async () => new Response('') }, seen.deps)
    const waited: Array<Promise<unknown>> = []
    await worker.scheduled({ scheduledTime: Date.parse('2026-11-10T12:05:00Z'), cron: '*/5 * * * *' }, env, { waitUntil: (promise) => waited.push(promise) })
    expect(waited).toHaveLength(1)
    const result = await waited[0]
    // W47, a named difference: `paymentsWatched` (payments still watched after their change was undone by hand).
    expect(result).toEqual({ refundsWaiting: 0, paymentsWatched: 0, checked: 0, finalised: 0, undone: 0, refunds: 0, left: 0, deferred: 0, stripeRefused: false, items: [] })
    expect(seen.opened).toEqual([env.HYPERDRIVE.connectionString])
    expect(seen.secrets).toEqual([env.STRIPE_SECRET_KEY])
    expect(seen.closed()).toBe(1)
    expect(seen.logged).toEqual([
      // W32a: the log line carries how many watched refunds are still on their way at Stripe.
      // W47, a named difference: and how many payments are still watched.
      { event: 'reconcile.run', requestId: 'reconcile-2026-11-10T12:05:00.000Z', checked: 0, finalised: 0, undone: 0, refunds: 0, leftCount: 0, left: [], handled: {}, deferred: 0, stripeRefused: false, refundsWaiting: 0, paymentsWatched: 0 },
    ])
    // Found nothing: no Stripe call at all.
    expect(stripe.calls).toEqual([])
  })

  it('runs as the system, with the scheduled bounds (50 items, 120 s), no press deadline', async () => {
    const seen = depsFor(new FakeStripe())
    const asked: ReconcileOptions[] = []
    await runScheduledReconcile(env, Date.parse('2026-11-10T12:10:00Z'), { ...seen.deps, reconcile: (db, stripe, options) => (asked.push(options), reconcile(db, stripe, options)) })
    // W42a: the switch is passed from the handler's env (a scheduled run's isn't copied into process.env). Unset here: null, every kind off.
    // W67 (L-new): and the day's interval reads, which only the scheduled run makes.
    expect(asked).toEqual([{ actor: { type: 'system', id: null }, requestId: 'reconcile-2026-11-10T12:10:00.000Z', maxItems: 50, budgetMs: 120_000, orderSwitch: null, readIntervals: true }])
  })

  it("W42a: the run is given the Worker's ORDER_SWITCH secret from the handler's env, for `card_moves` on an order it finalises", async () => {
    const seen = depsFor(new FakeStripe())
    const asked: ReconcileOptions[] = []
    await runScheduledReconcile({ ...env, ORDER_SWITCH: 'no_stripe,membership,card_moves' }, Date.parse('2026-11-10T12:15:00Z'), { ...seen.deps, reconcile: (db, stripe, options) => (asked.push(options), reconcile(db, stripe, options)) })
    expect(asked.map((options) => options.orderSwitch)).toEqual(['no_stripe,membership,card_moves'])
  })

  // --- W43 (brief items 1 and 2): the lapse sweep runs before reconcile, handed the switch from the handler's env.

  /** A member's credit seat awaiting payment, its deadline a minute ago. */
  async function lapsedBooking(): Promise<{ bookingId: string; sessionId: string }> {
    const serviceType = await fixtures.serviceType(database.db)
    const customerId = await fixtures.customer(database.db)
    const sessionId = await fixtures.session(database.db, { service_type_id: serviceType, total_booked: 1 })
    const bookingId = await fixtures.booking(database.db, {
      session_id: sessionId,
      customer_id: customerId,
      status: 'payment_needed',
      redemption_source: 'membership_credit',
      payment_due_by: new Date(Date.now() - 60_000).toISOString(),
      start_time: '2030-06-15 10:00:00+00',
      end_time: '2030-06-15 11:00:00+00',
    })
    await insert(database.db, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Mo Member', unit_price: '20', pay_by: 'membership_credit' })
    return { bookingId, sessionId }
  }
  const statusOf = async (bookingId: string) => (await database.db.query<{ status: string; cancel_reason: string | null }>('SELECT status, cancel_reason FROM bookings WHERE id = $1', [bookingId]))[0]

  it('W43: the lapse sweep is run before reconcile, handed the switch from the env (never process.env), the run\'s time in its request id, and the scheduled cap', async () => {
    const seen = depsFor(new FakeStripe())
    const order: string[] = []
    const asked: LapseSweepOptions[] = []
    vi.stubEnv('ORDER_SWITCH', 'lapse_sweep')
    try {
      // The environment names the kind; the handler's env doesn't: the sweep is told it is off.
      await runScheduledReconcile(env, Date.parse('2026-11-10T12:20:00Z'), {
        ...seen.deps,
        lapseSweep: (db, options) => (order.push('sweep'), asked.push(options), lapseSweep(db, options)),
        reconcile: (db, stripe, options) => (order.push('reconcile'), reconcile(db, stripe, options)),
      })
      await runScheduledReconcile({ ...env, ORDER_SWITCH: 'no_stripe,lapse_sweep' }, Date.parse('2026-11-10T12:25:00Z'), {
        ...seen.deps,
        lapseSweep: (db, options) => (order.push('sweep'), asked.push(options), lapseSweep(db, options)),
        reconcile: (db, stripe, options) => (order.push('reconcile'), reconcile(db, stripe, options)),
      })
    } finally {
      vi.unstubAllEnvs()
    }
    expect(order).toEqual(['sweep', 'reconcile', 'sweep', 'reconcile'])
    expect(asked).toEqual([
      { requestId: 'lapse-sweep-2026-11-10T12:20:00.000Z', orderSwitch: null, maxItems: 50 },
      { requestId: 'lapse-sweep-2026-11-10T12:25:00.000Z', orderSwitch: 'no_stripe,lapse_sweep', maxItems: 50 },
    ])
    // Nothing was due: the sweep logs nothing, and the run's log is reconcile's line alone.
    expect(seen.logged.map((entry) => entry['event'])).toEqual(['reconcile.run', 'reconcile.run'])
  })

  it("W43: a booking past its deadline is left by a run whose switch doesn't name `lapse_sweep`, and lapsed by one that does, with a log line; no Stripe call", async () => {
    const stripe = new FakeStripe()
    const seen = depsFor(stripe)
    const { bookingId, sessionId } = await lapsedBooking()
    await runScheduledReconcile({ ...env, ORDER_SWITCH: 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows' }, Date.parse('2026-11-10T12:30:00Z'), seen.deps)
    expect(await statusOf(bookingId)).toEqual({ status: 'payment_needed', cancel_reason: null })
    expect(seen.logged.map((entry) => entry['event'])).toEqual(['reconcile.run'])

    await runScheduledReconcile({ ...env, ORDER_SWITCH: 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,lapse_sweep' }, Date.parse('2026-11-10T12:35:00Z'), seen.deps)
    expect(await statusOf(bookingId)).toEqual({ status: 'cancelled', cancel_reason: 'membership_lapsed' })
    expect((await database.db.query<{ total_booked: number }>('SELECT total_booked FROM sessions WHERE id = $1', [sessionId]))[0]?.total_booked).toBe(0)
    expect(seen.logged.slice(1)).toEqual([
      { event: 'lapse_sweep.run', requestId: 'reconcile-2026-11-10T12:35:00.000Z', lapsed: 1, left: 0, failed: 0, storeCreditRefunded: 0, more: false, notLapsed: [] },
      expect.objectContaining({ event: 'reconcile.run', requestId: 'reconcile-2026-11-10T12:35:00.000Z' }),
    ])
    const rows = await database.db.query<{ actor_type: string; request_id: string }>("SELECT actor_type, request_id FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action = 'booking.lapsed'", [bookingId])
    expect(rows).toEqual([{ actor_type: 'system', request_id: 'lapse-sweep-2026-11-10T12:35:00.000Z' }])
    expect(stripe.calls).toEqual([])
  })

  it('W43: a sweep that throws is logged and never stops reconcile; a booking it left or failed on is named in its log line', async () => {
    const seen = depsFor(new FakeStripe())
    let reconciled = 0
    const counting: ScheduledDeps['reconcile'] = (db, stripe, options) => ((reconciled += 1), reconcile(db, stripe, options))
    await runScheduledReconcile({ ...env, ORDER_SWITCH: 'lapse_sweep' }, 0, { ...seen.deps, reconcile: counting, lapseSweep: async () => Promise.reject(new Error('sweep broke')) })
    await runScheduledReconcile({ ...env, ORDER_SWITCH: 'lapse_sweep' }, 0, {
      ...seen.deps,
      reconcile: counting,
      lapseSweep: async () => ({
        ran: true,
        lapsed: 1,
        left: 1,
        failed: 1,
        storeCreditRefunded: 20,
        more: true,
        items: [
          { bookingId: 'b1', outcome: 'lapsed', kind: 'cancel_credit', back: true, kept: null, storeCreditRefunded: 20, addonCreditsReturned: 0 },
          { bookingId: 'b2', outcome: 'left', reason: 'reader_payment_open' },
          { bookingId: 'b3', outcome: 'failed', error: 'Error: no' },
        ],
      }),
    })
    expect(reconciled).toBe(2)
    expect(seen.logged.filter((entry) => String(entry['event']).startsWith('lapse_sweep'))).toEqual([
      { event: 'lapse_sweep.failed', requestId: 'reconcile-1970-01-01T00:00:00.000Z', error: 'Error: sweep broke' },
      {
        event: 'lapse_sweep.run',
        requestId: 'reconcile-1970-01-01T00:00:00.000Z',
        lapsed: 1,
        left: 1,
        failed: 1,
        storeCreditRefunded: 20,
        more: true,
        notLapsed: [
          { id: 'b2', outcome: 'left', reason: 'reader_payment_open' },
          { id: 'b3', outcome: 'failed', reason: 'Error: no' },
        ],
      },
    ])
  })

  it("W43: scheduled.ts never reads process.env (the run's switch is the handler's env)", () => {
    const source = readFileSync(path.join(__dirname, 'scheduled.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/process\.env/)
    expect(code).toMatch(/deps\.lapseSweep\(db, \{ requestId: `lapse-sweep-\$\{new Date\(scheduledTime\)\.toISOString\(\)\}`, orderSwitch: env\.ORDER_SWITCH \?\? null, maxItems: SCHEDULED_LIMITS\.maxItems \}\)/)
    const sweep = readFileSync(path.join(__dirname, 'rules/bookings/lapse-sweep.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(sweep).not.toMatch(/process\.env/)
  })

  it('with a binding or the secret missing: logs it and runs nothing', async () => {
    const seen = depsFor(new FakeStripe())
    expect(await runScheduledReconcile({ STRIPE_SECRET_KEY: 'sk_test_x' }, 0, seen.deps)).toBeNull()
    expect(await runScheduledReconcile({ HYPERDRIVE: { connectionString: 'x' } }, 0, seen.deps)).toBeNull()
    expect(seen.opened).toEqual([])
    expect(seen.logged.map((entry) => entry['missing'])).toEqual([['HYPERDRIVE'], ['STRIPE_SECRET_KEY']])
  })

  it('a run that throws is logged, the database still closed, and the error left to the platform', async () => {
    const stripe = new FakeStripe()
    const seen = depsFor(stripe)
    const broken = { ...seen.deps, openDb: () => Object.assign(Object.create(database.db) as Db, { query: async () => Promise.reject(new Error('no database')), close: async () => undefined }) }
    await expect(runScheduledReconcile(env, 0, broken)).rejects.toThrow('no database')
    // W14 (W11-9): the secrets' pruning fails first, is logged, and never stops the run.
    expect(seen.logged).toEqual([
      { event: 'idempotency.secrets_not_pruned', requestId: 'reconcile-1970-01-01T00:00:00.000Z', error: 'Error: no database' },
      { event: 'reconcile.failed', requestId: 'reconcile-1970-01-01T00:00:00.000Z', error: 'Error: no database' },
    ])
  })

  it('W14 (W11-9): a run takes stored client secrets out once they are past the pending window', async () => {
    const stripe = new FakeStripe()
    const seen = depsFor(stripe)
    await database.db.query(
      `INSERT INTO api_idempotency (key, actor_type, actor_id, endpoint, request_hash, status, response, http_status, created_at)
       VALUES ('w14-secret-key-0001', 'staff', 's1', 'POST /api/v1/staff/terminal/setup-intents', 'h', 'done', $1, 200, now() - interval '1 hour')`,
      [{ ok: true, data: { clientSecret: 'seti_secret', setupIntentId: 'seti_1', stripeCustomerId: 'cus_1' } } as { [key: string]: unknown }]
    )
    await runScheduledReconcile(env, 0, seen.deps)
    const [row] = await database.db.query<{ response: { data: Record<string, unknown> } }>(`SELECT response FROM api_idempotency WHERE key = 'w14-secret-key-0001'`)
    expect(row?.response.data).toEqual({ setupIntentId: 'seti_1', stripeCustomerId: 'cus_1' })
    expect(seen.logged[0]).toMatchObject({ event: 'idempotency.secrets_pruned', pruned: 1 })
  })
})

describe('the wiring', () => {
  const webDir = path.resolve(__dirname, '..')
  const read = (file: string) => readFileSync(path.join(webDir, file), 'utf8')

  it("wrangler.jsonc: main is the custom worker, the cron is every 5 minutes, server-only is aliased, Hyperdrive keeps its localConnectionString (W01)", () => {
    const config = read('wrangler.jsonc')
    expect(config).toMatch(/"main": "custom-worker\.ts"/)
    expect(config).toMatch(/"crons": \["\*\/5 \* \* \* \*"\]/)
    expect(config).toMatch(/"server-only": "\.\/node_modules\/next\/dist\/compiled\/server-only\/empty\.js"/)
    expect(config).toMatch(/"localConnectionString": "postgres:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres"/)
  })

  it("custom-worker.ts: OpenNext's generated worker wrapped with the schedule, and its Durable Object classes passed on", () => {
    const worker = read('custom-worker.ts')
    expect(worker).toContain("import { default as openNext } from './.open-next/worker.js'")
    expect(worker).toContain('export default withScheduled(openNext)')
    expect(worker).toContain("export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js'")
  })
})
