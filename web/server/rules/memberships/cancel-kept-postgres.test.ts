import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { fakeStripeErrors, FakeStripe } from '@/server/stripe/fake'
import { cancelMembership, type CancelOptions } from './cancel'
import { syncCancelDateUnlessWanted, type CancelDateParams } from './cancel-kept'
import { openSteps } from './left'

// Brief W47r-e item 1 on real Postgres 17.6, each side on its own connection: Stripe's update notice for a
// subscription with no end, and Cancel pressed here, at the same instant. The notice's write looks for an open cancel
// step and calls the sync function in one transaction under the membership's row lock, the lock Cancel's M1 holds
// while it writes the last day and leaves its step. Each race holds the first side's transaction open, after its
// writes, until Postgres reports the second as waiting on the membership's row, so neither can pass by timing.
// Whichever is first, the cancel's last day is the one left on the row. (The harness is cancel-postgres.test.ts's.)

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let staffId: string
let plan: string
let subscriptions = 0

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w47re-race@example.com', can_issue_refunds: true })
  plan = await fixtures.plan(first, { level: 'core', sessions_included: 4 })
})
afterAll(() => pg.stop())

/** A monthly member started long ago, renewing in 20 days, on a Stripe subscription the fake holds. */
async function member(stripe: FakeStripe, fields: { cancel_effective_date?: string } = {}): Promise<{ membership: string; subscription: string }> {
  subscriptions += 1
  const subscription = `sub_kept_${subscriptions}`
  const customer = await fixtures.customer(first)
  const membership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', subscription_status: 'active', stripe_subscription_id: subscription })
  await first.query("UPDATE customer_memberships SET start_date = (now() AT TIME ZONE 'Europe/London')::date - 200, next_renewal_date = (now() AT TIME ZONE 'Europe/London')::date + 20 WHERE id = $1", [membership])
  if (fields.cancel_effective_date) await first.query('UPDATE customer_memberships SET cancel_effective_date = $1::date WHERE id = $2', [fields.cancel_effective_date, membership])
  stripe.addPrice('price_kept', 4000, 'month')
  stripe.addSubscription(subscription, 'cus_kept', 'price_kept')
  return { membership, subscription }
}

const options = (stripe: FakeStripe): CancelOptions => ({ actor: { channel: 'staff', id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe })
/** What the webhook gives the write for a subscription Stripe shows with no end. */
const noEnd = (subscription: string): CancelDateParams => ({ p_stripe_subscription_id: subscription, p_cancel_at_period_end: false, p_cancel_at: null, p_period_end: new Date(Date.now() + 20 * 86_400_000).toISOString() })
const day = async (days: number) => (await third.query<{ d: string }>("SELECT ((now() AT TIME ZONE 'Europe/London')::date + $1::int)::text AS d", [days]))[0]?.d as string
const lastDay = async (membership: string) => (await third.query<{ ends: string | null }>('SELECT cancel_effective_date::text AS ends FROM customer_memberships WHERE id = $1', [membership]))[0]?.ends ?? null
const openCancelSteps = async (membership: string) => (await openSteps(third)).filter((step) => step.membershipId === membership && step.kind === 'cancel_at')

/** `db`, with its first transaction held open after its work is done (every write made, nothing committed) until `finish`. */
function heldOpen(db: Db): { db: Db; pid: Promise<number>; finish(): void } {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    announce = resolve
  })
  let count = 0
  const held = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
      return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
        count += 1
        if (count > 1) return target.transaction(work)
        return target.transaction(async (tx) => {
          const result = await work(tx)
          announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
          await release.promise
          return result
        })
      }
    },
  })
  return { db: held, pid, finish: () => release.resolve() }
}

async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/** Runs `held` and keeps its first transaction open, starts `waiter`, checks Postgres reports it waiting on the membership's row, then lets both finish. */
async function race<A, B>(held: (db: Db) => Promise<A>, waiter: (db: Db) => Promise<B>): Promise<{ held: A; waiter: B }> {
  const holding = heldOpen(first)
  const heldWork = held(holding.db)
  const holder = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
  let settled = false
  const waiting = waiter(second).finally(() => {
    settled = true
  })
  const blocked = await blockedBy(holder)
  expect(settled).toBe(false)
  expect(await waitingOn(pg, blocked)).toEqual(['customer_memberships'])
  holding.finish()
  return { held: await heldWork, waiter: await waiting }
}

describe("Stripe's update notice (no end) and Cancel pressed here, at the same instant, on real Postgres", () => {
  it("Cancel first, its M1 not yet committed: the notice's write waits for the membership's row, then finds the cancel's step and keeps the last day", async () => {
    const stripe = new FakeStripe()
    const { membership, subscription } = await member(stripe)
    // Stripe gives the cancel's send no answer, so its step stays open.
    stripe.failNext('subscriptions.update', { kind: 'error', error: fakeStripeErrors.server() })
    const result = await race(
      (db) => cancelMembership(db, membership, options(stripe)),
      (db) => syncCancelDateUnlessWanted(db, noEnd(subscription))
    )
    const cancelled = result.held.membership.cancel_effective_date
    expect(cancelled).toBe(await day(19))
    const [step] = await openCancelSteps(membership)
    expect(result.waiter).toEqual({ kept: { membershipId: membership, lastDay: cancelled, stepId: step?.id, stepState: 'left', stepLastDay: cancelled } })
    expect(await lastDay(membership)).toBe(cancelled)
  })

  it("the notice first, clearing a last day no step asks for, not yet committed: Cancel waits for the membership's row, then finds no cancel scheduled and writes its own last day and step. The cancel is not lost", async () => {
    const stripe = new FakeStripe()
    const { membership, subscription } = await member(stripe, { cancel_effective_date: await day(5) })
    stripe.failNext('subscriptions.update', { kind: 'error', error: fakeStripeErrors.server() })
    const result = await race(
      (db) => syncCancelDateUnlessWanted(db, noEnd(subscription)),
      (db) => cancelMembership(db, membership, options(stripe))
    )
    expect(result.held).toEqual({ data: { found: true, action: 'cancel_cleared', cancel_effective_date: null } })
    const cancelled = result.waiter.membership.cancel_effective_date
    expect(cancelled).toBe(await day(19))
    expect(await lastDay(membership)).toBe(cancelled)
    expect((await openCancelSteps(membership)).map((step) => typeof step.want.cancelAt)).toEqual(['number'])
    // And the next notice with no end keeps it.
    expect(await syncCancelDateUnlessWanted(third, noEnd(subscription))).toMatchObject({ kept: { membershipId: membership, lastDay: cancelled, stepState: 'left' } })
    expect(await lastDay(membership)).toBe(cancelled)
  })
})
