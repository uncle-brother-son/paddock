// New in W40 (F-plan 4.3; brief W40 item 4; bugs FB5, FB6, FB20, FB22; Q33; W35 row 9; W36 review S1 and L1):
// a membership's cancellation scheduled, and undone. Ported from the staff app's setMembershipCancellation.ts, the
// two legacy routes (/api/memberships/cancel, /undo-cancel) and lib/membership-cancellation.ts, with the order
// turned round: the database first, Stripe second.
//
//   M1 (one transaction, under the membership's lock)
//      who may: staff with Issue refunds (FB20), or the membership's own customer (the channel)
//      cancel: found, active, no cancel scheduled, no payment date change in progress, a next renewal date (FB22)
//              that is after today in London (W40a: on the renewal day the payment must go through first)
//      undo:   found, active, a cancel scheduled and not yet passed, no payment date change in progress    (FB5)
//      no step of the last change still being sent to Stripe                                               (S1)
//      the end date: monthly, the later of start + 2 months (clamped: Q33, FB6) and the next renewal;
//                    yearly, the next renewal
//      cancel_effective_date written (the day before the end: the last day of access), or cleared
//      audit row `membership.cancel_scheduled` / `membership.cancel_undone`, with the cancel_at it will send
//      the Stripe step left (memberships/left.ts), when the membership has a subscription
//   then Stripe, only with a subscription, found from the membership's own row and never from its order (row 9):
//      cancel_at set or cleared, with proration_behavior 'none' (L1)
//      went    : the step is marked done
//      refused : M1 put back in one transaction; Stripe's reason, in the old words
//      unclear : the step stays left; reconcile reads the subscription first and sends only if still needed
//
// Nothing here moves money, so nothing is held. The Stripe webhook (customer.subscription.updated) still copies the
// subscription's date onto the membership; cancel.test.ts holds the order of an unrelated event between M1 and the
// Stripe step.
import 'server-only'
import type { MembershipCancelOutput } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Tx } from '@/server/db'
import { accountRefusal } from '@/server/rules/account/refusal'
import { addMonthsToIsoDate, londonWallClockToUtc } from '@/server/rules/time/london-time'
import type { StripeClient } from '@/server/stripe/client'
import { stripeTiming } from '@/server/stripe/deadline'
import { MEMBERSHIP_CANCEL_DIALOG_WORDS, MEMBERSHIP_CANCEL_NEW_WORDS, MEMBERSHIP_CANCEL_WORDS } from './failure-messages'
import { leaveStepReplacing, newestOf, recordStepDone, stepEndEntry, stepStillBeingSent, trySendStep, type LeftStep, type OpenStep, type StepBy } from './left'

export const CANCEL_SCHEDULED_ACTION = 'membership.cancel_scheduled'
export const CANCEL_UNDONE_ACTION = 'membership.cancel_undone'
/** A press Stripe refused, with the membership's date put back as it was. */
export const CANCEL_PUT_BACK_ACTION = 'membership.cancel_put_back'

/** The monthly minimum term: at least this many payments, so the end is never before start + this many months. */
export const MINIMUM_TERM_MONTHS = 2

/**
 * Who is acting, by channel (brief W40 item 4). Staff need Issue refunds, read from the signed-in staff member by
 * the route (FB20). A customer may only change their own membership, and needs no permission. Only the staff routes
 * exist; the website's routes come with the website (lead call L12).
 */
export type CancelActor = { channel: 'staff'; id: string; canIssueRefunds: boolean } | { channel: 'customer'; id: string }

export interface CancelOptions {
  actor: CancelActor
  requestId: string
  /** The request's start, for the Stripe deadline. */
  startedAt: number
  /** Made only when there is a subscription to change. */
  stripe: () => StripeClient
}

export interface MembershipTerm {
  /** customer_memberships.start_date, YYYY-MM-DD. */
  startDate: string
  /** customer_memberships.next_renewal_date, YYYY-MM-DD. */
  nextRenewalDate: string
  billingFrequency: string | null
}

export interface MembershipEnd {
  /** The first day the membership no longer covers. */
  endDate: string
  /** customer_memberships.cancel_effective_date: the last day of access, the day before. */
  cancelEffectiveDate: string
  /** Stripe's `cancel_at`: London midnight at the start of the end date, in seconds. */
  cancelAt: number
}

const dayBefore = (isoDate: string): string => {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10)
}
/** London midnight at the start of a date, in seconds: BST or GMT as that day has it. */
const londonMidnight = (isoDate: string): number => Math.floor(londonWallClockToUtc(`${isoDate}T00:00:00.000Z`).getTime() / 1000)

/**
 * When a cancelled membership ends. Yearly: the next renewal (the year paid for is the term). Anything else is
 * monthly, as the old code took it: the later of the next renewal and the minimum term's end, start + 2 months, where
 * a day the later month doesn't have is that month's last day (Q33). The old sum rolled over instead (FB6): started
 * 31 December, it gave 3 March, where this gives 28 February (29 in a leap year).
 */
export function membershipEnd(term: MembershipTerm): MembershipEnd {
  const minimumTermEnd = addMonthsToIsoDate(term.startDate, MINIMUM_TERM_MONTHS)
  // YYYY-MM-DD compares in date order.
  const endDate = term.billingFrequency === 'yearly' || term.nextRenewalDate >= minimumTermEnd ? term.nextRenewalDate : minimumTermEnd
  return { endDate, cancelEffectiveDate: dayBefore(endDate), cancelAt: londonMidnight(endDate) }
}

interface MembershipFacts {
  id: string
  customer_id: string
  start_date: string
  next_renewal_date: string | null
  billing_frequency: string | null
  subscription_status: string | null
  stripe_subscription_id: string | null
  cancel_effective_date: string | null
  today: string
  payment_date_changing: boolean
}

/**
 * Read in its own statement, after the lock: a statement that waited for a lock still sees the rows as they were
 * when it started (server/rules/README.md, "Locks before reads"). "A payment date change in progress" (W41, brief
 * item 4): a pending record of any age. It holds the membership until the press or reconcile settles it
 * (payment-date.ts); the old rule let one go after 15 minutes.
 */
const FACTS_SQL = `
SELECT cm.id, cm.customer_id, cm.start_date::text AS start_date, cm.next_renewal_date::text AS next_renewal_date,
       cm.billing_frequency, cm.subscription_status, cm.stripe_subscription_id,
       cm.cancel_effective_date::text AS cancel_effective_date,
       (now() AT TIME ZONE 'Europe/London')::date::text AS today,
       EXISTS (SELECT 1 FROM membership_payment_date_changes p
               WHERE p.membership_id = cm.id AND p.status = 'pending') AS payment_date_changing
FROM customer_memberships cm
WHERE cm.id = $1::uuid`

async function lockAndRead(tx: Tx, membershipId: string): Promise<MembershipFacts | null> {
  const locked = await tx.query('SELECT id FROM customer_memberships WHERE id = $1::uuid FOR NO KEY UPDATE', [membershipId])
  if (locked.length === 0) return null
  return (await tx.query<MembershipFacts>(FACTS_SQL, [membershipId]))[0] ?? null
}

type Action = 'cancel' | 'undo_cancel'

/** What M1 did, for the Stripe step and for putting it back. */
interface Recorded {
  membership: MembershipCancelOutput['membership']
  /** The cancel's end. */
  end: MembershipEnd | null
  /** cancel_effective_date before and after M1. */
  before: string | null
  after: string | null
  step: LeftStep | null
  /** Steps still open that this press's step replaced: left again if this press is put back. */
  replaced: OpenStep[]
}

const by = (options: CancelOptions): StepBy => ({ actor: { type: options.actor.channel, id: options.actor.id }, requestId: options.requestId })

/** Who may, before anything is read: staff need Issue refunds, with the old words. */
function checkPermission(action: Action, options: CancelOptions): void {
  if (options.actor.channel === 'staff' && !options.actor.canIssueRefunds) {
    throw accountRefusal('FORBIDDEN', action, 'permission_denied', MEMBERSHIP_CANCEL_WORDS.permissionDenied)
  }
}

/** M1's checks every press shares. A customer asking about someone else's membership is told it isn't found. */
function checkFound(action: Action, facts: MembershipFacts | null, options: CancelOptions): MembershipFacts {
  if (!facts || (options.actor.channel === 'customer' && facts.customer_id !== options.actor.id)) {
    // The old route's own words (the dialog shows its own sentence for this reason).
    throw accountRefusal('NOT_FOUND', action, 'membership_not_found', MEMBERSHIP_CANCEL_WORDS.notFound)
  }
  if (facts.subscription_status !== 'active') throw accountRefusal('CONFLICT', action, 'not_active', MEMBERSHIP_CANCEL_DIALOG_WORDS.not_active)
  return facts
}

/**
 * M1's writes: the date, the audit row with the cancel_at it will send, and the Stripe step when there is a
 * subscription. `cancelAt` is null for an undo.
 */
async function record(tx: Tx, action: Action, facts: MembershipFacts, end: MembershipEnd | null, options: CancelOptions): Promise<Recorded> {
  const after = end?.cancelEffectiveDate ?? null
  const cancelAt = end?.cancelAt ?? null
  const [membership] = await tx.query<MembershipCancelOutput['membership']>(
    `UPDATE customer_memberships SET cancel_effective_date = $1::date, updated_at = now() WHERE id = $2::uuid
     RETURNING id, cancel_effective_date::text AS cancel_effective_date, billing_frequency`,
    [after, facts.id]
  )
  if (!membership) throw new Error(`Membership ${facts.id} was locked but not updated.`)
  const left = facts.stripe_subscription_id
    ? await leaveStepReplacing(tx, { membershipId: facts.id, subscriptionId: facts.stripe_subscription_id, kind: 'cancel_at', want: { cancelAt } }, by(options))
    : null
  await audit.record(tx, {
    actorType: options.actor.channel,
    actorId: options.actor.id,
    action: action === 'cancel' ? CANCEL_SCHEDULED_ACTION : CANCEL_UNDONE_ACTION,
    entityType: 'membership',
    entityId: facts.id,
    requestId: options.requestId,
    details: {
      channel: options.actor.channel,
      cancelAt,
      ...(end ? { endDate: end.endDate } : {}),
      cancelEffectiveDate: { before: facts.cancel_effective_date, after },
      subscriptionId: facts.stripe_subscription_id,
      stepId: left?.step.id ?? null,
    },
  })
  return { membership, end, before: facts.cancel_effective_date, after, step: left?.step ?? null, replaced: left?.replaced ?? [] }
}

/**
 * A press Stripe refused: M1 put back, in one transaction under the membership's lock. The date goes back to what
 * it was only if it is still what M1 wrote (the webhook may have copied Stripe's own date onto it since, and that is
 * then the truth). The step is closed as `undone`; if it had replaced a step still open (an earlier change Stripe
 * never confirmed), that wish is left again, because the database shows it once more (W40a: unless a newer press
 * has replaced this one's step meanwhile).
 */
async function putBack(db: Db, action: Action, recorded: Recorded & { step: LeftStep }, stripeSaid: string, options: CancelOptions): Promise<void> {
  await db.transaction(async (tx) => {
    const facts = await lockAndRead(tx, recorded.step.membershipId)
    const restored = facts !== null && facts.cancel_effective_date === recorded.after
    if (restored) await tx.query('UPDATE customer_memberships SET cancel_effective_date = $1::date, updated_at = now() WHERE id = $2::uuid', [recorded.before, recorded.step.membershipId])
    const earlier = recorded.replaced.at(-1)
    // W40a (W40 review L2): only while this press's step is still the newest. A newer press may have replaced it
    // meanwhile (the automatic check recorded it as refused, so it no longer made a new press wait): that press's
    // wish stands, and the older one left again would replace it.
    const stillNewest = (await newestOf(tx, recorded.step.id)) === recorded.step.id
    const again = earlier && stillNewest ? await leaveStepReplacing(tx, { membershipId: earlier.membershipId, subscriptionId: earlier.subscriptionId, kind: earlier.kind, want: earlier.want }, by(options)) : null
    // leaveStepReplacing closed this press's step as `replaced` by the one left again; with none, it is `undone` here
    // (unless a newer press's step has already closed it as `replaced`).
    await audit.recordAll(tx, [
      ...(again || !stillNewest ? [] : [stepEndEntry(recorded.step, 'undone', by(options), `Stripe refused: ${stripeSaid}`)]),
      {
        actorType: options.actor.channel,
        actorId: options.actor.id,
        action: CANCEL_PUT_BACK_ACTION,
        entityType: 'membership',
        entityId: recorded.step.membershipId,
        requestId: options.requestId,
        details: {
          was: action,
          stripeSaid,
          stepId: recorded.step.id,
          cancelEffectiveDate: { before: recorded.after, after: restored ? recorded.before : (facts?.cancel_effective_date ?? null) },
          restored,
          ...(again ? { leftAgain: again.step.id } : {}),
        },
      },
    ])
  })
}

/**
 * The Stripe step, after M1 has committed. With no subscription there is none (M1 only, as before). Went: the step is
 * marked done. Refused: M1 is put back and the press is refused with Stripe's reason (the old words: Stripe's own,
 * or "Failed to update Stripe subscription" when it gave none). No clear answer: the step stays left, and the answer
 * says so.
 */
async function sendToStripe(db: Db, action: Action, recorded: Recorded, options: CancelOptions): Promise<Pick<MembershipCancelOutput, 'left'> & { stripeUpdated: boolean }> {
  const { step } = recorded
  if (!step) return { stripeUpdated: false }
  const answer = await trySendStep(options.stripe(), step, stripeTiming(options.startedAt))
  if (answer.kind === 'done') {
    // If the row can't be written the step stays open: reconcile reads Stripe, finds it done, and writes it then.
    await recordStepDone(db, step, by(options), answer.detail).catch(() => false)
    return { stripeUpdated: true }
  }
  if (answer.kind === 'unclear') return { stripeUpdated: false, left: { stepId: step.id, message: MEMBERSHIP_CANCEL_NEW_WORDS.left } }
  const stripeSaid = answer.message.trim() || MEMBERSHIP_CANCEL_WORDS.stripeFailed
  await putBack(db, action, { ...recorded, step }, stripeSaid, options)
  throw accountRefusal('CONFLICT', action, 'stripe_refused', stripeSaid)
}

/**
 * setMembershipCancellation, cancel: true. The membership stops renewing at the end of its term; its status stays
 * active and its credits are untouched until then.
 */
export async function cancelMembership(db: Db, membershipId: string, options: CancelOptions): Promise<MembershipCancelOutput> {
  checkPermission('cancel', options)
  const recorded = await db.transaction(async (tx) => {
    const facts = checkFound('cancel', await lockAndRead(tx, membershipId), options)
    if (facts.cancel_effective_date !== null) throw accountRefusal('CONFLICT', 'cancel', 'already_cancelling', MEMBERSHIP_CANCEL_DIALOG_WORDS.already_cancelling)
    if (facts.payment_date_changing) throw accountRefusal('CONFLICT', 'cancel', 'payment_date_changing', MEMBERSHIP_CANCEL_NEW_WORDS.paymentDateChanging)
    // FB22: the old date sum threw on a missing date ("Cannot read properties of null"). Live has none.
    if (!facts.next_renewal_date) throw accountRefusal('CONFLICT', 'cancel', 'no_renewal_date', MEMBERSHIP_CANCEL_NEW_WORDS.noRenewalDate)
    // W40a (Wayne, 16 Nov; W40 review L1): the renewal is due today (or overdue) and its payment hasn't moved the
    // date on yet. The end would be today, a cancel_at already past and a last day of yesterday. YYYY-MM-DD compares
    // in date order; `today` is London's.
    if (facts.next_renewal_date <= facts.today) throw accountRefusal('CONFLICT', 'cancel', 'renewal_due_today', MEMBERSHIP_CANCEL_NEW_WORDS.renewalDueToday)
    if (facts.stripe_subscription_id && (await stepStillBeingSent(tx, facts.stripe_subscription_id, 'cancel_at'))) {
      throw accountRefusal('CONFLICT', 'cancel', 'still_sending', MEMBERSHIP_CANCEL_NEW_WORDS.stillSending)
    }
    const end = membershipEnd({ startDate: facts.start_date, nextRenewalDate: facts.next_renewal_date, billingFrequency: facts.billing_frequency })
    return record(tx, 'cancel', facts, end, options)
  })
  if (!recorded.end) throw new Error(`Membership ${membershipId}'s cancellation was recorded with no end date.`)
  const sent = await sendToStripe(db, 'cancel', recorded, options)
  return { membership: recorded.membership, endDate: recorded.end.endDate, ...sent }
}

/**
 * setMembershipCancellation, cancel: false. Only while the cancellation is still to come: one whose last day has
 * passed is no longer pending (FB5: the old route cleared the date of a membership that had ended, which read as
 * running again, with credits, for no payment).
 */
export async function undoMembershipCancel(db: Db, membershipId: string, options: CancelOptions): Promise<MembershipCancelOutput> {
  checkPermission('undo_cancel', options)
  const recorded = await db.transaction(async (tx) => {
    const facts = checkFound('undo_cancel', await lockAndRead(tx, membershipId), options)
    if (facts.cancel_effective_date === null || facts.cancel_effective_date < facts.today) {
      throw accountRefusal('CONFLICT', 'undo_cancel', 'not_cancelling', MEMBERSHIP_CANCEL_DIALOG_WORDS.not_cancelling)
    }
    // W41 (brief item 4): a pending payment date change holds the membership against an undo too. One can only meet a
    // scheduled cancel that arrived after its P1 (the webhook copying a cancel made in Stripe, or a legacy cancel).
    if (facts.payment_date_changing) throw accountRefusal('CONFLICT', 'undo_cancel', 'payment_date_changing', MEMBERSHIP_CANCEL_NEW_WORDS.paymentDateChanging)
    if (facts.stripe_subscription_id && (await stepStillBeingSent(tx, facts.stripe_subscription_id, 'cancel_at'))) {
      throw accountRefusal('CONFLICT', 'undo_cancel', 'still_sending', MEMBERSHIP_CANCEL_NEW_WORDS.stillSending)
    }
    return record(tx, 'undo_cancel', facts, null, options)
  })
  const sent = await sendToStripe(db, 'undo_cancel', recorded, options)
  // The old undo answered the row alone; `left` is new.
  return { membership: recorded.membership, ...(sent.left ? { left: sent.left } : {}) }
}
