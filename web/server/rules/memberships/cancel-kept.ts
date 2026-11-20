// New in W47r-e (brief item 1; W47r-d report "Noticed" 1, fix a): a cancel pressed here is never undone by Stripe.
//
// Cancel writes the membership's last day and leaves a Stripe step to set the same end on the subscription
// (cancel.ts, left.ts). Until Stripe has that end, its `customer.subscription.updated` notice shows a subscription
// with no end, and the webhook's sync (membership_sync_cancel_at_period_end) copied that onto the row: the last day
// was cleared. Stripe sends that notice at every renewal, about an hour before it takes the money, so a cancel that
// never reached Stripe was wiped just before the renewal it was meant to stop, and the payment was then recorded as
// any member's (migration 031 goes by the last day, and found none).
//
// So when Stripe shows no end, the notice's write is made here, on the Worker's own connection, in one transaction
// under the membership's row lock (the lock Cancel and Undo hold while they write the day and leave their step):
// - the membership has a last day, has not ended, and a cancel step that wants an end is still open (left, being
//   sent, marked, or refused by Stripe and listed for a person): nothing is written. The last day stays, and the step
//   settles it: sent again by the automatic check, or closed by a person with Mark sorted.
// - anything else: the database's own function is called in the same transaction, exactly as the webhook calls it,
//   and its answer is the notice's answer, as before. That covers an Undo pressed here (its step wants no end, and
//   M1 cleared the day already), a cancel that finished (its step is closed `done`), one Stripe refused at the press
//   (put back, `undone`), one a person marked sorted, and a membership with no step at all.
// One transaction, so a Cancel pressed between the look at the steps and the write can't be missed: it waits for
// this lock, or this waits for its.
import 'server-only'
import type { CancelDateKept, SyncCancelDate } from '@/app/api/stripe/webhook/dispatch'
import type { Db } from '@/server/db'
import { openSteps, stepWhat } from './left'

/** What the sync function is given, as the webhook names them (dispatch.ts, cancelDateWrite). */
export type CancelDateParams = Parameters<SyncCancelDate>[0]

/** `kept`: the last day left alone, and the open step that asks for it. `data`: the sync function's own answer. */
export type CancelDateSynced = { kept: CancelDateKept } | { data: unknown }

/** The membership of a subscription, locked as the sync function locks it. */
const LOCK_SQL = 'SELECT id::text AS id FROM customer_memberships WHERE stripe_subscription_id = $1::text ORDER BY id FOR UPDATE'
/** Read in its own statement, after the lock (server/rules/README.md, "Locks before reads"). */
const FACTS_SQL = 'SELECT subscription_status AS status, cancel_effective_date::text AS last_day FROM customer_memberships WHERE id::text = $1'
const SYNC_SQL =
  'SELECT public.membership_sync_cancel_at_period_end(p_stripe_subscription_id => $1::text, p_cancel_at_period_end => $2::boolean, p_cancel_at => $3::timestamptz, p_period_end => $4::timestamptz) AS data'

/**
 * The update notice's write for a subscription Stripe shows with no end. Answers `kept` when the membership's last
 * day was left alone for an open cancel step, else the sync function's own answer (`data`). Throws when the database
 * fails: the notice is then an error, and Stripe sends it again.
 */
export async function syncCancelDateUnlessWanted(db: Db, params: CancelDateParams): Promise<CancelDateSynced> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.query<{ id: string }>(LOCK_SQL, [params.p_stripe_subscription_id])
    if (locked) {
      const [facts] = await tx.query<{ status: string | null; last_day: string | null }>(FACTS_SQL, [locked.id])
      if (facts && facts.last_day !== null && facts.status !== 'cancelled') {
        // Open: its `left` row has no closing row (done, sorted, replaced, undone). The newest wish for a
        // subscription and kind is the only one open; an Undo's step wants no end and is not one of these.
        const wanted = (await openSteps(tx)).filter(
          (step) => step.membershipId === locked.id && step.subscriptionId === params.p_stripe_subscription_id && step.kind === 'cancel_at' && typeof step.want.cancelAt === 'number'
        )
        const step = wanted.at(-1)
        if (step) {
          return { kept: { membershipId: locked.id, lastDay: facts.last_day, stepId: step.id, stepState: step.refused ? ('refused' as const) : ('left' as const), stepLastDay: stepWhat(step).lastDay ?? null } }
        }
      }
    }
    const rows = await tx.query<{ data: unknown }>(SYNC_SQL, [params.p_stripe_subscription_id, params.p_cancel_at_period_end, params.p_cancel_at, params.p_period_end])
    const data = rows[0]?.data ?? null
    return { data: typeof data === 'string' ? (JSON.parse(data) as unknown) : data }
  })
}
