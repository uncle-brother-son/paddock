import { NextRequest } from 'next/server'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db, SqlParam, Tx } from '@/server/db'
import { cancelMembership, undoMembershipCancel, type CancelOptions } from '@/server/rules/memberships/cancel'
import { openSteps } from '@/server/rules/memberships/left'
import { reconcile } from '@/server/rules/orders/reconcile'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { subscriptionUpdatedEvent } from '@/server/rules/testing/webhook'
import { fakeStripeErrors, FakeStripe } from '@/server/stripe/fake'
import { POST } from './route'

// Brief W66 item 1 (H-plan 4.2): the Stripe webhook's route itself, on real Postgres 17.6, against reconcile on the
// same membership, each on its own connection. The route now makes every database step on the Worker's own
// connection (database.ts), where it went through Supabase's client until W66. What must hold, both ways round: the
// two take turns on the membership's row (Postgres reports the second waiting on `customer_memberships`), the event
// is processed once, the step reconcile sends is closed once, and the membership's last day is the one Stripe and the
// press agree on. Each race holds the first side's transaction open, after its writes, until Postgres reports the
// other waiting on the row, so neither can pass by timing. (The harness is cancel-kept-postgres.test.ts's.)

vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown, stripe: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/stripe/client')>()),
  createStripeClient: () => holder.stripe,
}))

const WEBHOOK_SECRET = 'whsec_w66_route_race'

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let staffId: string
let plan: string
let subscriptions = 0

beforeAll(async () => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_w66_route_race')
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET)
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w66-route-race@example.com', can_issue_refunds: true })
  plan = await fixtures.plan(first, { level: 'core', sessions_included: 4 })
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await pg.stop()
})

/** A monthly member started long ago, renewing in 20 days, on a Stripe subscription the fake holds. */
async function member(stripe: FakeStripe): Promise<{ membership: string; subscription: string }> {
  subscriptions += 1
  const subscription = `sub_route_${subscriptions}`
  const customer = await fixtures.customer(first)
  const membership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', subscription_status: 'active', stripe_subscription_id: subscription })
  await first.query("UPDATE customer_memberships SET start_date = (now() AT TIME ZONE 'Europe/London')::date - 200, next_renewal_date = (now() AT TIME ZONE 'Europe/London')::date + 20 WHERE id = $1", [membership])
  stripe.addPrice('price_route', 4000, 'month')
  stripe.addSubscription(subscription, 'cus_route', 'price_route')
  return { membership, subscription }
}

const options = (stripe: FakeStripe): CancelOptions => ({ actor: { channel: 'staff', id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe })
const lastDay = async (membership: string) => (await third.query<{ ends: string | null }>('SELECT cancel_effective_date::text AS ends FROM customer_memberships WHERE id = $1', [membership]))[0]?.ends ?? null
const openStepsOf = async (membership: string) => (await openSteps(third)).filter((step) => step.membershipId === membership)
/** The press's window over (left.ts, `in_window`): reconcile now sends the step. */
const pastTheWindow = (membership: string) => pg.admin.unsafe("UPDATE audit_log SET at = at - interval '30 minutes' WHERE action = 'membership.step_left' AND entity_id = $1", [membership])
const eventRow = async (eventId: string) => (await third.query<{ outcome: string | null; detail: Record<string, unknown> | null; error: string | null }>('SELECT outcome, detail, error FROM stripe_webhook_events WHERE event_id = $1', [eventId]))[0]

/** The event as Stripe posts it, signed with the endpoint's secret. */
async function posted(event: Stripe.Event): Promise<Response> {
  const payload = JSON.stringify(event)
  const signature = new Stripe('sk_test_w66_route_race').webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
  return POST(new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': signature } }))
}

const reconcileNow = (db: Db, stripe: FakeStripe) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })

const LOCKS_MEMBERSHIP = /customer_memberships[\s\S]*FOR (NO KEY )?UPDATE/i

/**
 * `db`, with the first transaction that locks a membership's row held open after its work is done (every write made,
 * nothing committed) until `finish`. Other transactions run as usual.
 */
function heldAtTheMembership(db: Db): { db: Db; pid: Promise<number>; finish(): void } {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    announce = resolve
  })
  let held = false
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
      return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> =>
        target.transaction(async (tx) => {
          let locked = false
          const watched = new Proxy(tx, {
            get(inner, name, innerReceiver) {
              if (name !== 'query') return Reflect.get(inner, name, innerReceiver) as unknown
              return <Row>(sql: string, params?: readonly SqlParam[]) => {
                if (LOCKS_MEMBERSHIP.test(sql)) locked = true
                return inner.query<Row>(sql, params)
              }
            },
          })
          const result = await work(watched)
          if (locked && !held) {
            held = true
            announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
            await release.promise
          }
          return result
        })
    },
  })
  return { db: proxy, pid, finish: () => release.resolve() }
}

async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 6_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/** Runs `held` on `first` with its membership transaction kept open, starts `waiter` on `second`, checks Postgres reports it waiting on the membership's row, then lets both finish. */
async function race<A, B>(held: (db: Db) => Promise<A>, waiter: (db: Db) => Promise<B>): Promise<{ held: A; waiter: B }> {
  const holding = heldAtTheMembership(first)
  const heldWork = held(holding.db)
  const holderPid = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
  let settled = false
  const waiting = waiter(second).finally(() => {
    settled = true
  })
  const blocked = await blockedBy(holderPid)
  expect(settled).toBe(false)
  expect(await waitingOn(pg, blocked)).toEqual(['customer_memberships'])
  holding.finish()
  return { held: await heldWork, waiter: await waiting }
}

describe("Stripe's webhook route and reconcile on the same membership, at the same instant, on real Postgres (W66)", () => {
  it("reconcile first: it sends a cancel's left step and closes it under the membership's row lock, not yet committed; the route's update notice (Stripe now showing the end) waits for the row, then writes the same last day. One event processed, the step closed once", async () => {
    const stripe = new FakeStripe()
    holder.stripe = stripe
    const { membership, subscription } = await member(stripe)
    // Cancel pressed here; Stripe gives its send no answer, so the step is left for reconcile.
    stripe.failNext('subscriptions.update', { kind: 'error', error: fakeStripeErrors.server() })
    const cancelled = (await cancelMembership(first, membership, options(stripe))).membership.cancel_effective_date
    expect(await openStepsOf(membership)).toHaveLength(1)
    await pastTheWindow(membership)

    const event = subscriptionUpdatedEvent(subscription, { cancelAt: null, periodEnd: Math.floor(Date.now() / 1000) + 20 * 86_400 })
    const result = await race(
      (db) => reconcileNow(db, stripe),
      async (db) => {
        holder.db = db
        return posted(event)
      }
    )
    expect(result.waiter.status).toBe(200)
    expect(await result.waiter.json()).toEqual({ received: true })
    expect(await eventRow(event.id)).toEqual({ outcome: 'processed', detail: { found: true, action: 'unchanged', cancel_effective_date: cancelled }, error: null })
    expect(await lastDay(membership)).toBe(cancelled)
    expect(await openStepsOf(membership)).toEqual([])
    expect(stripe.calls.filter((call) => call.method === 'subscriptions.update' && (call.params as { id?: unknown }).id === subscription)).toHaveLength(2)

    // Sent again by Stripe: a duplicate, nothing written.
    holder.db = second
    const again = await posted(event)
    expect(await again.json()).toEqual({ received: true, duplicate: true })
  })

  it("the route first: Undo pressed here and its step left; Stripe already shows no end, and the route's update notice writes under the membership's row lock, not yet committed; reconcile's close of the Undo's step waits for the row. The last day stays cleared, the event processed once, the step closed once", async () => {
    const stripe = new FakeStripe()
    holder.stripe = stripe
    const { membership, subscription } = await member(stripe)
    await cancelMembership(first, membership, options(stripe))
    expect(await lastDay(membership)).not.toBeNull()
    // Undo pressed; Stripe gives its send no answer, so the step is left for reconcile.
    stripe.failNext('subscriptions.update', { kind: 'error', error: fakeStripeErrors.server() })
    await undoMembershipCancel(first, membership, options(stripe))
    expect(await lastDay(membership)).toBeNull()
    expect(await openStepsOf(membership)).toHaveLength(1)
    await pastTheWindow(membership)
    // The send's answer was lost on the way back, but it landed: Stripe shows no end.
    await stripe.subscriptions.update(subscription, { cancel_at: '' })

    const event = subscriptionUpdatedEvent(subscription, { cancelAt: null, periodEnd: Math.floor(Date.now() / 1000) + 20 * 86_400 })
    const result = await race(
      async (db) => {
        holder.db = db
        return posted(event)
      },
      (db) => reconcileNow(db, stripe)
    )
    expect(result.held.status).toBe(200)
    expect(await eventRow(event.id)).toEqual({ outcome: 'processed', detail: { found: true, action: 'unchanged', cancel_effective_date: null }, error: null })
    expect(await lastDay(membership)).toBeNull()
    expect(await openStepsOf(membership)).toEqual([])
  })
})
