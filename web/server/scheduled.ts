// The schedule (W03-plan 2.5, brief W12 item 4): Cloudflare runs the Worker's `scheduled` handler every 5
// minutes (wrangler.jsonc "triggers"), and it runs reconcile inside the Worker, with no HTTP hop and no new
// secret: the database comes from the Hyperdrive binding and Stripe from the Worker's own secret, both read
// from the handler's `env` (OpenNext copies env into process.env only inside its fetch handler, which a
// scheduled run doesn't go through). custom-worker.ts, the Worker's entry point, wraps OpenNext's generated
// fetch handler with this, as OpenNext documents for a custom worker.
import 'server-only'
import { createDb, type Db } from '@/server/db'
import { createPostgresDriver } from '@/server/db/postgres-driver'
import { pruneClientSecrets } from '@/server/http/idempotency'
import { reconcile, SCHEDULED_LIMITS, type ReconcileResult } from '@/server/rules/orders/reconcile'
import { createStripeClient, ORDER_STRIPE_LIMITS, type StripeClient } from '@/server/stripe/client'

/** What the scheduled handler reads from the Worker's bindings and secrets. */
export interface ScheduledEnv {
  HYPERDRIVE?: { connectionString: string }
  STRIPE_SECRET_KEY?: string
}

export interface ScheduledController {
  scheduledTime: number
  cron?: string
}

export interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void
}

export interface ScheduledDeps {
  openDb(connectionString: string): Db
  stripe(secretKey: string): StripeClient
  /** One JSON line per run to the Worker's logs (Workers Logs are on in wrangler.jsonc). */
  log(entry: Record<string, unknown>): void
  reconcile: typeof reconcile
}

export const SCHEDULED_DEPS: ScheduledDeps = {
  openDb: (connectionString) => createDb(createPostgresDriver(connectionString)),
  // The order's limits: 10 s a call, no SDK retries (a scheduled run has no Retool limit, but a hung call
  // would hold up every item after it).
  stripe: (secretKey) => createStripeClient(secretKey, ORDER_STRIPE_LIMITS),
  log: (entry) => console.log(JSON.stringify(entry)),
  reconcile,
}

/**
 * One scheduled run: reconcile as the system, within SCHEDULED_LIMITS, then a log line with the counts.
 * A missing binding or secret is logged and the run does nothing (nothing can be checked without them).
 */
export async function runScheduledReconcile(env: ScheduledEnv, scheduledTime: number, deps: ScheduledDeps = SCHEDULED_DEPS): Promise<ReconcileResult | null> {
  const requestId = `reconcile-${new Date(scheduledTime).toISOString()}`
  const connectionString = env.HYPERDRIVE?.connectionString
  const secretKey = env.STRIPE_SECRET_KEY
  if (!connectionString || !secretKey) {
    deps.log({ event: 'reconcile.not_run', requestId, missing: [connectionString ? null : 'HYPERDRIVE', secretKey ? null : 'STRIPE_SECRET_KEY'].filter(Boolean) })
    return null
  }
  const db = deps.openDb(connectionString)
  try {
    // W14 (W11-9): stored client secrets past the pending window. Never stops the run.
    try {
      const pruned = await pruneClientSecrets(db)
      if (pruned > 0) deps.log({ event: 'idempotency.secrets_pruned', requestId, pruned })
    } catch (err) {
      deps.log({ event: 'idempotency.secrets_not_pruned', requestId, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
    }
    const result = await deps.reconcile(db, deps.stripe(secretKey), { actor: { type: 'system', id: null }, requestId, ...SCHEDULED_LIMITS })
    const { items, ...counts } = result
    deps.log({ event: 'reconcile.run', requestId, ...counts, left: items.filter((item) => item.outcome === 'left').map((item) => ({ kind: item.kind, id: item.id, reason: item.reason })) })
    return result
  } catch (err) {
    deps.log({ event: 'reconcile.failed', requestId, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
    throw err
  } finally {
    await db.close()
  }
}

type FetchHandler = (request: Request, env: never, ctx: never) => Promise<Response>

/**
 * The Worker: OpenNext's fetch handler unchanged, and `scheduled` added. The run is handed to
 * `ctx.waitUntil`, so the platform keeps the Worker for it (a Cron Trigger's wall-time limit is 15 minutes;
 * SCHEDULED_LIMITS ends a run in about 3).
 */
export function withScheduled<H extends { fetch: FetchHandler }>(openNext: H, deps: ScheduledDeps = SCHEDULED_DEPS) {
  return {
    fetch: openNext.fetch,
    async scheduled(controller: ScheduledController, env: ScheduledEnv, ctx: ScheduledContext): Promise<void> {
      ctx.waitUntil(runScheduledReconcile(env, controller.scheduledTime, deps))
    },
  }
}
