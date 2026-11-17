import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { cancelMembership, undoMembershipCancel, type CancelOptions } from './cancel'
import { MEMBERSHIP_CANCEL_DIALOG_WORDS, MEMBERSHIP_CANCEL_NEW_WORDS } from './failure-messages'
import { checkAfterClosing, checksDue, settleLeftStep } from './left'

// Brief W40 item 1 (W36 review S1) on real Postgres 17.6, each press on its own connection: two changes to one
// membership at the same instant. Each race holds the first press's M1 open, after its writes, until Postgres reports
// the second as waiting on the membership's row, so none can pass by timing. The control runs the old route's own
// steps (no lock, no check) the same way, and goes wrong.
// W40d (W40c review S3): in the two races between a cancel and an undo, the first press's Stripe call is held as well,
// until the second press has answered. Without that the order after M1 commits was left to timing: Postgres doesn't
// queue a new lock request behind a woken waiter, so the first press's own `done` (the fake answers at once) could
// take the membership's row before the second press did, and the second then found no step still being sent.

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
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w40-race@example.com', can_issue_refunds: true })
  plan = await fixtures.plan(first, { level: 'core', sessions_included: 4 })
})
afterAll(() => pg.stop())

/** A monthly member started long ago, renewing in 20 days, on a Stripe subscription the fake holds. */
async function member(stripe: FakeStripe, fields: Record<string, unknown> = {}): Promise<{ membership: string; subscription: string }> {
  subscriptions += 1
  const subscription = `sub_race_${subscriptions}`
  const customer = await fixtures.customer(first)
  const membership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', subscription_status: 'active', stripe_subscription_id: subscription, ...fields })
  await first.query("UPDATE customer_memberships SET start_date = (now() AT TIME ZONE 'Europe/London')::date - 200, next_renewal_date = (now() AT TIME ZONE 'Europe/London')::date + 20 WHERE id = $1", [membership])
  stripe.addPrice('price_race', 4000, 'month')
  stripe.addSubscription(subscription, 'cus_race', 'price_race')
  return { membership, subscription }
}

const paramsOf = (call: { params: unknown } | undefined): Record<string, unknown> => (call?.params ?? {}) as Record<string, unknown>
const options = (stripe: FakeStripe): CancelOptions => ({ actor: { channel: 'staff', id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe })

type Outcome<T> = { answered: T } | { refused: string; message: string }
async function outcome<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { answered: await work }
  } catch (err) {
    if (err instanceof ApiError) return { refused: String((err.details as { reason?: unknown } | undefined)?.reason ?? err.code), message: err.message }
    throw err
  }
}

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

/** Runs `held` and keeps its M1 open, starts `waiter`, checks Postgres reports it waiting on the membership's row, then lets both finish. */
async function race<A, B>(held: (db: Db) => Promise<A>, waiter: (db: Db) => Promise<B>): Promise<{ held: Outcome<A>; waiter: Outcome<B> }> {
  const holding = heldOpen(first)
  const heldWork = outcome(held(holding.db))
  const holder = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
  let settled = false
  const waiting = outcome(waiter(second)).finally(() => {
    settled = true
  })
  const blocked = await blockedBy(holder)
  expect(settled).toBe(false)
  expect(await waitingOn(pg, blocked)).toEqual(['customer_memberships'])
  holding.finish()
  return { held: await heldWork, waiter: await waiting }
}

/**
 * W40d (S3): the fake as the first press reaches it, its first `subscriptions.retrieve` held until `release`. The
 * press's step stays open and inside its window meanwhile, as it is in production while Stripe is being asked.
 */
function heldAtStripe(stripe: FakeStripe): { stripe: FakeStripe; release(): void } {
  const gate = deferred()
  let held = false
  const real = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const subscriptions = {
    ...real,
    retrieve: async (...args: unknown[]) => {
      if (!held) {
        held = true
        await gate.promise
      }
      return (real['retrieve'] as (...a: unknown[]) => Promise<unknown>)(...args)
    },
  }
  return { stripe: new Proxy(stripe, { get: (target, prop) => (prop === 'subscriptions' ? subscriptions : Reflect.get(target, prop)) }), release: () => gate.resolve() }
}

const lastDay = async (membership: string) => (await third.query<{ ends: string | null }>('SELECT cancel_effective_date::text AS ends FROM customer_memberships WHERE id = $1', [membership]))[0]?.ends ?? null
const rowsOf = async (membership: string, action: string) => (await third.query<{ details: Record<string, unknown> }>('SELECT details FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY at, id', [membership, action])).map((row) => row.details)
const updates = (stripe: FakeStripe, subscription: string) => stripe.calls.filter((call) => call.method === 'subscriptions.update' && paramsOf(call)['id'] === subscription).map((call) => paramsOf(call)['cancel_at'])

describe('two presses on one membership at the same instant (W36 review S1)', () => {
  it("two cancels: the second waits on the membership's row, then finds the cancel scheduled and is refused. One change, one audit row, one step, one send", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { membership, subscription } = await member(stripe)
    const result = await race(
      (db) => cancelMembership(db, membership, options(stripe)),
      (db) => cancelMembership(db, membership, options(stripe))
    )
    expect(result.held).toMatchObject({ answered: { stripeUpdated: true } })
    expect(result.waiter).toEqual({ refused: 'already_cancelling', message: MEMBERSHIP_CANCEL_DIALOG_WORDS.already_cancelling })
    expect(await rowsOf(membership, 'membership.cancel_scheduled')).toHaveLength(1)
    expect((await rowsOf(membership, 'membership.step_left')).map((details) => details['state'])).toEqual(['left', 'done'])
    expect(updates(stripe, subscription)).toHaveLength(1)
    expect(await lastDay(membership)).not.toBeNull()
  })

  it("a cancel and an undo: the undo waits for the cancel's M1, then finds its step still being sent and is refused. Stripe and the membership end the same: cancelled", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { membership, subscription } = await member(stripe)
    // W40d (S3): the cancel is still at Stripe until the undo has answered.
    const atStripe = heldAtStripe(stripe)
    let sentBeforeTheUndoAnswered: number | undefined
    const result = await race(
      (db) => cancelMembership(db, membership, options(atStripe.stripe)),
      (db) =>
        undoMembershipCancel(db, membership, options(stripe)).finally(() => {
          sentBeforeTheUndoAnswered = stripe.calls.length
          atStripe.release()
        })
    )
    expect(sentBeforeTheUndoAnswered).toBe(0)
    expect(result.held).toMatchObject({ answered: { stripeUpdated: true } })
    expect(result.waiter).toEqual({ refused: 'still_sending', message: MEMBERSHIP_CANCEL_NEW_WORDS.stillSending })
    expect(await lastDay(membership)).not.toBeNull()
    expect(stripe.subscriptionSettings(subscription)?.cancelAt).toEqual(expect.any(Number))
    expect(updates(stripe, subscription)).toHaveLength(1)
    expect(await rowsOf(membership, 'membership.cancel_undone')).toEqual([])
  })

  it("W40d (S3), the other order, which is allowed: the cancel's step is sent and done before the undo is pressed. The undo is taken, and Stripe and the membership end the same: not cancelled", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { membership, subscription } = await member(stripe)
    expect(await outcome(cancelMembership(first, membership, options(stripe)))).toMatchObject({ answered: { stripeUpdated: true } })
    expect((await rowsOf(membership, 'membership.step_left')).map((details) => details['state'])).toEqual(['left', 'done'])
    expect(await outcome(undoMembershipCancel(second, membership, options(stripe)))).toMatchObject({ answered: { membership: { cancel_effective_date: null } } })
    expect(await lastDay(membership)).toBeNull()
    expect(stripe.subscriptionSettings(subscription)?.cancelAt).toBeNull()
    expect(updates(stripe, subscription)).toEqual([expect.any(Number), ''])
    expect((await rowsOf(membership, 'membership.step_left')).map((details) => details['state'])).toEqual(['left', 'done', 'left', 'done'])
  })

  it("an undo and a cancel on a membership scheduled to cancel: the cancel waits, then is refused while the undo's step is still being sent: not cancelled, in both places", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { membership, subscription } = await member(stripe)
    await cancelMembership(third, membership, options(stripe))
    // W40d (S3): the undo is still at Stripe until the cancel has answered.
    const atStripe = heldAtStripe(stripe)
    const sentBefore = stripe.calls.length
    let sentBeforeTheCancelAnswered: number | undefined
    const result = await race(
      (db) => undoMembershipCancel(db, membership, options(atStripe.stripe)),
      (db) =>
        cancelMembership(db, membership, options(stripe)).finally(() => {
          sentBeforeTheCancelAnswered = stripe.calls.length
          atStripe.release()
        })
    )
    expect(sentBeforeTheCancelAnswered).toBe(sentBefore)
    expect(result.held).toMatchObject({ answered: { membership: { cancel_effective_date: null } } })
    expect(result.waiter).toEqual({ refused: 'still_sending', message: MEMBERSHIP_CANCEL_NEW_WORDS.stillSending })
    expect(await lastDay(membership)).toBeNull()
    expect(stripe.subscriptionSettings(subscription)?.cancelAt).toBeNull()
  })

  it("reconcile's row for a step waits for a press's M1 on the same membership, then finds the step replaced and writes nothing for it", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { membership, subscription } = await member(stripe)
    // A cancel whose answer was lost: its step A is open. Aged past the window (the rows' own time, moved back).
    stripe.failNext('subscriptions.update', { kind: 'lost_response' })
    const cancelled = await cancelMembership(third, membership, options(stripe))
    const stepId = String(cancelled.left?.stepId)
    await pg.admin.unsafe("UPDATE audit_log SET at = at - interval '20 minutes' WHERE action = 'membership.step_left' AND entity_id = $1", [membership])
    // The undo's M1 is held open (its step B has replaced A, uncommitted). Reconcile settles A: Stripe shows A's date
    // already, so it goes to write `done`, and must wait for the membership's row.
    const holding = heldOpen(first)
    const undo = outcome(undoMembershipCancel(holding.db, membership, options(stripe)))
    const holder = await holding.pid
    let settled = false
    const settling = settleLeftStep(second, stripe, stepId, { actor: { type: 'system', id: null }, requestId: 'run-race' }, undefined).finally(() => {
      settled = true
    })
    const blocked = await blockedBy(holder)
    expect(settled).toBe(false)
    expect(await waitingOn(pg, blocked)).toEqual(['customer_memberships'])
    holding.finish()
    expect(await undo).toMatchObject({ answered: { membership: { cancel_effective_date: null } } })
    // A was replaced while reconcile waited: no `done` for it, and the newest (the undo's) is what Stripe ends showing.
    expect(await settling).toMatchObject({ kind: 'closed' })
    const states = (await rowsOf(membership, 'membership.step_left')).filter((details) => details['stepId'] === stepId).map((details) => details['state'])
    expect(states).toEqual(['left', 'replaced'])
    expect(stripe.subscriptionSettings(subscription)?.cancelAt).toBeNull()
    expect(await lastDay(membership)).toBeNull()
  })

  it("W40c: two runs' checks of one subscription at the same instant. The second waits on the membership's row, then finds the closing covered and leaves nothing: one step left again, one check row", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { membership, subscription } = await member(stripe)
    const cancelled = await cancelMembership(third, membership, options(stripe))
    expect(cancelled.stripeUpdated).toBe(true)
    // Its step closed 30 minutes ago (the rows' own time, moved back), and a late clear has landed over the cancel since.
    await pg.admin.unsafe("UPDATE audit_log SET at = at - interval '30 minutes' WHERE action = 'membership.step_left' AND entity_id = $1", [membership])
    stripe.setSubscription(subscription, { cancelAt: null })
    const due = (await checksDue(third)).find((one) => one.membershipId === membership)
    expect(due).toMatchObject({ subscriptionId: subscription, kind: 'cancel_at', unreadTooLong: false })
    expect(due?.stepIds).toHaveLength(1)
    if (!due) return
    const by = (requestId: string) => ({ actor: { type: 'system' as const, id: null }, requestId })
    // Run A's check has read Stripe, left the wish again and written its row, uncommitted. Run B's has read Stripe too.
    const holding = heldOpen(first)
    const one = checkAfterClosing(holding.db, stripe, due, by('run-a'), undefined)
    const holder = await holding.pid
    let settled = false
    const two = checkAfterClosing(second, stripe, due, by('run-b'), undefined).finally(() => {
      settled = true
    })
    const blocked = await blockedBy(holder)
    expect(settled).toBe(false)
    expect(await waitingOn(pg, blocked)).toEqual(['customer_memberships'])
    holding.finish()
    expect(await one).toMatchObject({ kind: 'listed', outcome: 'left_again' })
    expect(await two).toEqual({ kind: 'wait', detail: 'checked by another run meanwhile' })
    const steps = await rowsOf(membership, 'membership.step_left')
    expect(steps.filter((details) => details['leftAgainFor'] === due.stepIds[0])).toHaveLength(1)
    expect(steps.filter((details) => details['state'] === 'left')).toHaveLength(2)
    expect(await rowsOf(membership, 'membership.step_check')).toMatchObject([{ steps: due.stepIds, outcome: 'left_again', wish: due.stepIds[0] }])
    // Nothing more is due for it until the step left again closes.
    expect((await checksDue(third)).filter((again) => again.membershipId === membership)).toEqual([])
    expect(updates(stripe, subscription)).toHaveLength(1)
  })

  it("the control, the old routes' own steps (no lock, no check): a cancel and an undo at once each write, and the last write wins whatever Stripe was sent last", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { membership, subscription } = await member(stripe)
    // The old cancel: Stripe, then the row. The old undo: Stripe, then the row. Interleaved as two tabs can.
    await stripe.subscriptions.update(subscription, { cancel_at: 1900000000 })
    await stripe.subscriptions.update(subscription, { cancel_at: '' })
    await second.query('UPDATE customer_memberships SET cancel_effective_date = NULL WHERE id = $1', [membership])
    await first.query("UPDATE customer_memberships SET cancel_effective_date = '2030-03-16' WHERE id = $1", [membership])
    // The membership says it ends; Stripe will renew it for ever.
    expect(await lastDay(membership)).toBe('2030-03-16')
    expect(stripe.subscriptionSettings(subscription)?.cancelAt).toBeNull()
  })
})
