import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { FakeStripe } from '@/server/stripe/fake'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
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

  it('hands one reconcile run to ctx.waitUntil, as the system, from the env bindings; logs its counts; closes the database', async () => {
    const stripe = new FakeStripe()
    const seen = depsFor(stripe)
    const worker = withScheduled({ fetch: async () => new Response('') }, seen.deps)
    const waited: Array<Promise<unknown>> = []
    await worker.scheduled({ scheduledTime: Date.parse('2026-11-10T12:05:00Z'), cron: '*/5 * * * *' }, env, { waitUntil: (promise) => waited.push(promise) })
    expect(waited).toHaveLength(1)
    const result = await waited[0]
    expect(result).toEqual({ checked: 0, finalised: 0, undone: 0, refunds: 0, left: 0, deferred: 0, oldLeftAlone: { orders: 0, flows: 0 }, stripeRefused: false, items: [] })
    expect(seen.opened).toEqual([env.HYPERDRIVE.connectionString])
    expect(seen.secrets).toEqual([env.STRIPE_SECRET_KEY])
    expect(seen.closed()).toBe(1)
    expect(seen.logged).toEqual([
      { event: 'reconcile.run', requestId: 'reconcile-2026-11-10T12:05:00.000Z', checked: 0, finalised: 0, undone: 0, refunds: 0, left: [], deferred: 0, oldLeftAlone: { orders: 0, flows: 0 }, stripeRefused: false },
    ])
    // Found nothing: no Stripe call at all.
    expect(stripe.calls).toEqual([])
  })

  it('runs as the system, with the scheduled bounds (50 items, 120 s), no press deadline', async () => {
    const seen = depsFor(new FakeStripe())
    const asked: ReconcileOptions[] = []
    await runScheduledReconcile(env, Date.parse('2026-11-10T12:10:00Z'), { ...seen.deps, reconcile: (db, stripe, options) => (asked.push(options), reconcile(db, stripe, options)) })
    expect(asked).toEqual([{ actor: { type: 'system', id: null }, requestId: 'reconcile-2026-11-10T12:10:00.000Z', maxItems: 50, budgetMs: 120_000 }])
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
