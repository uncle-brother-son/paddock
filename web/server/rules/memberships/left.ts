// New in W36 (F-plan 4.1, 4.2 item 4, 4.10; lead calls L6 and L7): a Stripe step left to do after the database change.
//
// Two of step F's actions change the database first and Stripe second, with a step that is safe to repeat: a
// membership's cancel date set or cleared on its subscription (W40), and a subscription moved to a customer's
// replaced card (W42). Neither moves money, so nothing is held: the step is recorded, sent, and sent again until
// Stripe shows what was asked. The pattern is W29's for a refunded membership's subscription
// (orders/refund-subscription.ts), with the ending W35's audit asked for (row 11): a step Stripe refuses for good
// stops being retried and becomes a line for a person.
//
// - Written (`leaveStep`): in the action's own transaction, with the database change, one `membership.step_left`
//   row (`left`) that carries everything a later send needs. No new table (L6). The caller holds the membership's
//   lock. A step still open for the same subscription and kind is closed as `replaced`: the newest wins (an undo
//   after a cancel that was never confirmed; a second card before the first was moved).
// - Sent (`trySendStep`): after the transaction. Stripe's subscription is read first, and nothing is sent when it
//   already shows what was asked (or has ended, where that settles it). A send carries a key from the step's id.
//   Stripe never throws out of here: the answer is done, refused for good, or unclear.
// - Listed (`OPEN_STEPS_SQL`, `openSteps`): every step with no closing row, for the stuck list, with whether Stripe
//   has refused it.
// - Sent again (`stepsDue`, `settleLeftStep`): reconcile, every run, for each open step Stripe hasn't refused. Done:
//   a `done` row closes it. Refused for good (Stripe answered, and said no): a `refused` row, after which it is
//   listed for a person and never sent again (L7). Unclear: nothing is written, and the next run tries again.
// - Sorted (`sortLeftStep`): a person, once they have put Stripe right by hand: a `sorted` row closes a refused
//   step. One still being sent can't be sorted: the automatic check owns it.
// - The press (W40, W42) uses `trySendStep` itself and writes its own ending with `stepEndEntry`: `done`, or
//   `undone` in the transaction that puts its database change back after a refusal (F-plan 4.3).
//
// W40 (W36 review S1): sends to one subscription take turns.
// - Reconcile sends a step only once it is older than the press's window (PROCESSING_MINUTES, as orders and flows),
//   so it never races the press that left it (`stepsDue`, and `settleLeftStep` itself).
// - A new cancel or undo is refused while a step of the same kind on that subscription is still inside the window
//   (`stepStillBeingSent`, asked by the action under the membership's lock).
// - After its send, reconcile looks again under the membership's lock: if a newer step has replaced the one it sent,
//   it writes nothing for the old one and settles the newest instead (reads Stripe, and sends the newest's wish if
//   Stripe no longer shows it).
// - W40a (W40 review S1): that alone left a gap. When the newest step was already closed `done` by its own press,
//   and the run's send of it isn't confirmed, or the run's own send of the replaced step got no clear answer (it can
//   still land in Stripe later), a stale send could be the last word with every step closed and nothing listed. The
//   newest step's wish is then left again as a new step (`leaveAgain`): it is listed, a new press waits its window,
//   and the next run past the window reads Stripe after any late send has landed and sends the wish again if needed.
//   A newest step still open is left open in the second case, for the same later read.
// - W40a: "newest" is the end of the chain of `replacedBy` links and, past a step that is closed without a link (a
//   press's `done`, or a put-back), the latest step left after it (`newestOf`): a closed step is never linked to the
//   next press's step, and without this a later press would be missed.
// - A press Stripe refuses puts its database change back; if its step had replaced one still open, that wish is
//   left again (`stepEndEntry` with `replacedBy`), because the database shows it once more.
// - W40b: two more. (1) A newest step that is still open when the run's send of the replaced step got no clear
//   answer is given a mark (a `stale_send` row, `keepForALaterRead`). Its own press, finishing later, finds the mark
//   and leaves the wish again instead of closing the step `done` (`recordStepDone`). (2) If the transaction that
//   leaves a wish again (or writes the mark) fails, the run reports the item as left with the reason
//   `step_not_left_again`, its row names the step, and every later run tries again until it is settled
//   (`leaveAgainLater`; reconcile.ts lists what is due from its own rows).
//
// - W40c: the net under all of that. Every step that closes, however it closes, is checked once more: 20 minutes
//   later (the window and a margin) reconcile reads its subscription and sets it against the newest wish for that
//   subscription and kind (`checksDue`, `checkAfterClosing`). Stripe showing something else leaves the newest wish
//   again as a new step, which is listed and sent by the next run past its window. W40a's and W40b's marks and
//   retries stay: they get it right sooner, without waiting for the check.
//
// What is guaranteed, and what isn't (W40c; W40d after the W40c review).
// Guaranteed, while the database takes the writes named here:
// - A change is never only in the database: the step is written in the same transaction, and it stays listed until
//   Stripe shows the wish, a person sorts it, or a newer change replaces it.
// - Stripe ends on the newest wish, or a line is listed, unless a person has taken the wish over (next point).
//   Whatever order the sends landed in, and whatever a press or a run did or failed to do about it at the time, the
//   first run 20 minutes after the last step for a subscription closed reads Stripe: so within the window, the margin
//   and one run (15 + 5 + 5 minutes) of that closing, with Stripe answering. If Stripe doesn't show the newest wish,
//   the wish is left again and listed in that same run, and sent by the first run past its own window (15 minutes
//   more). A subscription Stripe can't find, or has ended with an undo still wanted, is listed for a person.
// - A sorted wish is a person's (W40d). A step is marked sorted only after Stripe refused it for good and a person
//   put Stripe right by hand, perhaps to something other than the wish. From then on that wish is never read, held
//   to Stripe or sent again: its check is one `checked` row with no read. A press made after it has a step of its
//   own, and that wish is checked as any other.
// - The same change never goes out over and over (W40d). When the check has left a wish again, that step was sent
//   and closed `done`, and the next check still finds Stripe showing something else (a Stripe that stores a value
//   differently from the one sent, say), the wish is not left to send again: it is listed for a person, as a refused
//   step with Mark sorted.
// - No send of an older wish can land after that read: a press sends inside its own request, and a run sends a
//   step's wish only seconds after reading that step as open or as the newest. Every Stripe client that sends a step
//   (the press's route, staff's run and the scheduled run) is made with ORDER_STRIPE_LIMITS: 10 seconds a call and no
//   retries by the SDK. So a send has an answer, or is given up, within seconds, and nothing is still on its way for
//   a step that closed 20 minutes ago. A client made with the SDK's own limits (80 seconds, with retries) would
//   stretch that, so none may send a step. A new press has a step of its own, which is checked in its turn.
// - The check never sends, never writes a row about a read before making it (the rows for a newest step still open,
//   for a sorted wish and for no wish at all need no read, and say so), and never leaves a wish over a newer change
//   or twice: its row and the step it leaves are one transaction under the membership's lock, after looking again.
// - A check with no clear read is tried again every run, and after 2 hours the wish is left again, so it is listed.
// - A run reads at most 5 checks, oldest closing first: with more due than that, the rest are read by the next runs.
// - The two legacy routes (cancel and undo, which stay until W44) protect themselves (W40d, `stepsUnsettled`): each
//   refuses, before it reads or sends anything, while the membership has a step that is open, or closed and not yet
//   checked. So a change made through them is never taken for a stale send and put back by the check, with
//   `membership_changes` on or off (reconcile and the check never ask the switch).
// Not guaranteed:
// - Anything while the database refuses writes: a check that can't write its row leaves nothing, and is due again.
// - A change made to the subscription outside this code (in Stripe's dashboard, say) more than 20 minutes after the
//   last step closed. Nothing reads Stripe then. The webhook copies Stripe's date onto the membership, so the profile
//   shows it, but no line is listed. Inside the 20 minutes the check puts the newest wish back.
// - Stripe unreadable for hours: nothing is listed until 2 hours have passed with no clear read.
// - A send that lands more than 20 minutes after its step closed: see the 10 second limit above.
// - A wish with no step: a membership with no subscription has none, and neither has a change made through the two
//   legacy routes. Their guard is a read before the change, not a lock: a press in the new screen in the same moment
//   as a legacy change is not stopped by it.
import 'server-only'
import type Stripe from 'stripe'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { PROCESSING_MINUTES } from '@/server/rules/orders/pending-order'
import { LEFT_STEP_WORDS } from './failure-messages'

export const STEP_LEFT_ACTION = 'membership.step_left'
export const STEP_LEFT_ENTITY = 'membership'

/** What a step sets on the subscription: when it ends (`cancel_at`, set or cleared), or the card it charges. */
export const STEP_KINDS = ['cancel_at', 'payment_method'] as const
export type StepKind = (typeof STEP_KINDS)[number]

/**
 * What Stripe should show once the step is done. `cancel_at`: `cancelAt`, the moment it ends in seconds, or null for
 * no end (an undo). `payment_method`: `paymentMethod`, the card's id.
 */
export interface StepWant {
  cancelAt?: number | null
  paymentMethod?: string
}

/**
 * `left`: recorded, to send. `refused`: Stripe said no for good. `stale_send` (W40b): a mark on an open step, not an
 * ending: a run's send of the step this one replaced got no clear answer and may still land. The rest close it.
 */
export type StepState = 'left' | 'refused' | 'done' | 'sorted' | 'replaced' | 'undone' | 'stale_send'
const CLOSING_STATES: readonly StepState[] = ['done', 'sorted', 'replaced', 'undone']

export interface LeftStep {
  id: string
  membershipId: string
  subscriptionId: string
  kind: StepKind
  want: StepWant
}

/** An open step as the list reads it. */
export interface OpenStep extends LeftStep {
  /** When it was recorded. */
  at: string
  /** Stripe has refused it for good: listed for a person, never sent again. */
  refused: boolean
  /** What Stripe said when it refused. */
  refusal: string | null
  /** W40 (W36 review L2): the refusal was that Stripe can't find the subscription with the key in use. */
  missing: boolean
  /** W40 (S1): recorded less than PROCESSING_MINUTES ago: its press may still be sending it, so reconcile leaves it. */
  inWindow: boolean
  customerId: string | null
  customerName: string | null
}

type Actor = { type: 'staff' | 'customer' | 'system'; id: string | null }
export interface StepBy {
  actor: Actor
  requestId: string
}

const isStepKind = (value: unknown): value is StepKind => (STEP_KINDS as readonly unknown[]).includes(value)

/** A fault in the caller, never a refusal: a step that doesn't say what it wants could never be told done. */
function checkWant(kind: StepKind, want: StepWant): StepWant {
  if (kind === 'cancel_at') {
    if (!('cancelAt' in want) || !(want.cancelAt === null || (Number.isInteger(want.cancelAt) && (want.cancelAt as number) > 0))) {
      throw new Error('A cancel_at step needs cancelAt: the moment the subscription ends, in whole seconds, or null for no end.')
    }
    return { cancelAt: want.cancelAt ?? null }
  }
  if (typeof want.paymentMethod !== 'string' || want.paymentMethod.trim() === '') throw new Error('A payment_method step needs paymentMethod: the card to charge.')
  return { paymentMethod: want.paymentMethod }
}

/** One `membership.step_left` row. */
function entry(step: LeftStep, state: StepState, by: StepBy, extra: Record<string, unknown> = {}): AuditEntry {
  return {
    actorType: by.actor.type,
    actorId: by.actor.id,
    action: STEP_LEFT_ACTION,
    entityType: STEP_LEFT_ENTITY,
    entityId: step.membershipId,
    requestId: by.requestId,
    details: { stepId: step.id, kind: step.kind, state, subscriptionId: step.subscriptionId, want: step.want, ...extra },
  }
}

/**
 * The row that ends a step, for a caller that ends it in a transaction of its own (the press: `done`, or `undone`
 * with the database change put back). `detail` says why, in a few words. `replacedBy` (W40): the step left in the
 * same transaction for the wish this one had replaced, so the chain of steps for a subscription stays whole.
 */
export function stepEndEntry(step: LeftStep, state: Extract<StepState, 'done' | 'undone'>, by: StepBy, detail?: string, replacedBy?: string): AuditEntry {
  return entry(step, state, by, { ...(detail ? { detail } : {}), ...(replacedBy ? { replacedBy } : {}) })
}

// --- Listing

/**
 * Every open step: its `left` row (one per step, written by leaveStep) with no closing row after it, and whether
 * Stripe has refused it (its latest `refused` row's words). Closing is for good, so "no closing row" needs no order
 * of rows: two rows written in the same millisecond can't hide one. Oldest first.
 */
export const OPEN_STEPS_SQL = `
SELECT s.entity_id AS membership_id, s.details->>'stepId' AS step_id, s.details->>'kind' AS kind,
       s.details->>'subscriptionId' AS subscription_id, s.details->'want' AS want, s.at,
       r.detail IS NOT NULL AS refused, r.detail AS refusal, COALESCE(r.missing, false) AS missing,
       s.at > now() - interval '${PROCESSING_MINUTES} minutes' AS in_window,
       c.id AS customer_id, NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS customer_name
FROM audit_log s
LEFT JOIN LATERAL (
  SELECT COALESCE(f.details->>'detail', '') AS detail, (f.details->>'missing') = 'true' AS missing
  FROM audit_log f
  WHERE f.action = '${STEP_LEFT_ACTION}' AND f.entity_type = '${STEP_LEFT_ENTITY}' AND f.entity_id = s.entity_id
    AND f.details->>'stepId' = s.details->>'stepId' AND f.details->>'state' = 'refused'
  ORDER BY f.at DESC
  LIMIT 1
) r ON true
LEFT JOIN customer_memberships cm ON cm.id::text = s.entity_id
LEFT JOIN customers c ON c.id = cm.customer_id
WHERE s.action = '${STEP_LEFT_ACTION}' AND s.entity_type = '${STEP_LEFT_ENTITY}' AND s.details->>'state' = 'left'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${STEP_LEFT_ACTION}' AND e.entity_type = '${STEP_LEFT_ENTITY}' AND e.entity_id = s.entity_id
      AND e.details->>'stepId' = s.details->>'stepId'
      AND e.details->>'state' IN (${CLOSING_STATES.map((state) => `'${state}'`).join(', ')})
  )
ORDER BY s.at, s.details->>'stepId'`

/** One open step by its id (`$1`). */
const OPEN_STEP_BY_ID_SQL = `SELECT o.* FROM (${OPEN_STEPS_SQL}) o WHERE o.step_id = $1`

/** Whether a step (`$1`) was marked sorted by a person. */
const SORTED_BEFORE_SQL = `
SELECT 1 FROM audit_log
WHERE action = '${STEP_LEFT_ACTION}' AND entity_type = '${STEP_LEFT_ENTITY}' AND details->>'stepId' = $1 AND details->>'state' = 'sorted'
LIMIT 1`

interface OpenStepRow {
  membership_id: string
  step_id: string
  kind: string
  subscription_id: string
  want: StepWant | null
  at: string | Date
  refused: boolean
  refusal: string | null
  missing: boolean
  in_window: boolean
  customer_id: string | null
  customer_name: string | null
}

const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString())

function openStep(row: OpenStepRow): OpenStep | null {
  // A row this file didn't write (a kind from a later Worker, say) is left alone rather than guessed at.
  if (!isStepKind(row.kind)) return null
  return {
    id: row.step_id,
    membershipId: row.membership_id,
    subscriptionId: row.subscription_id,
    kind: row.kind,
    want: row.want ?? {},
    at: iso(row.at),
    refused: row.refused,
    refusal: row.refused ? (row.refusal ?? '') : null,
    missing: row.refused && row.missing === true,
    inWindow: row.in_window === true,
    customerId: row.customer_id,
    customerName: row.customer_name,
  }
}

/** Every open step, oldest first: the stuck list's. */
export async function openSteps(db: Queryable): Promise<OpenStep[]> {
  return (await db.query<OpenStepRow>(OPEN_STEPS_SQL)).map(openStep).filter((step): step is OpenStep => step !== null)
}

/**
 * The open steps reconcile sends again, oldest first: those Stripe hasn't refused for good, and (W40, S1) only once
 * they are older than the press's window, so a run never sends a step its own press may still be sending.
 */
export async function stepsDue(db: Queryable): Promise<OpenStep[]> {
  return (await openSteps(db)).filter((step) => !step.refused && !step.inWindow)
}

/**
 * W40 (S1): whether a step of this kind on this subscription is still inside the press's window and not refused: the
 * press that left it may still be sending it, and reconcile hasn't taken it over yet. The action asks under the
 * membership's lock, before it leaves a step of its own, and refuses the new change if so.
 */
export async function stepStillBeingSent(tx: Queryable, subscriptionId: string, kind: StepKind): Promise<boolean> {
  return (await openSteps(tx)).some((step) => step.subscriptionId === subscriptionId && step.kind === kind && !step.refused && step.inWindow)
}

/** One open step by its id, or null when it is closed or was never recorded. */
async function openStepById(db: Queryable, stepId: string): Promise<OpenStep | null> {
  const rows = await db.query<OpenStepRow>(OPEN_STEP_BY_ID_SQL, [stepId])
  return rows[0] ? openStep(rows[0]) : null
}

/** What the stuck list says for an open step. W40 (L2): a subscription Stripe can't find has its own words. */
export function stepWords(step: Pick<OpenStep, 'kind' | 'subscriptionId' | 'refused'> & { missing?: boolean }): string {
  return LEFT_STEP_WORDS[step.kind][step.refused ? (step.missing ? 'missing' : 'refused') : 'left'](step.subscriptionId)
}

/**
 * W40: what an open step is, for the stuck list: a cancel date to set, with the membership's last day of access it
 * sets (the London date of `cancelAt`, less a day: the cancel's own sum backwards); a cancel date to clear; or a card.
 */
export function stepWhat(step: Pick<OpenStep, 'kind' | 'want'>): { what: 'cancel_date' | 'clear_cancel_date' | 'card'; lastDay?: string } {
  if (step.kind === 'payment_method') return { what: 'card' }
  const cancelAt = step.want.cancelAt
  if (typeof cancelAt !== 'number') return { what: 'clear_cancel_date' }
  // London's date a day before the end: the day before midnight is the same London date as a second before it.
  const lastDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date((cancelAt - 1) * 1000))
  return { what: 'cancel_date', lastDay }
}

// --- Writing

/**
 * Records a Stripe step to do, in the action's transaction (`tx`), and closes as `replaced` any step still open
 * for the same subscription and kind. The caller holds the membership's row lock, so two actions on one membership
 * can't each leave a step the other doesn't see. Returns the step, for the send that follows the commit.
 */
export async function leaveStep(tx: Tx, step: Omit<LeftStep, 'id'>, by: StepBy): Promise<LeftStep> {
  return (await leaveStepReplacing(tx, step, by)).step
}

/**
 * leaveStep, also answering the open steps it closed as `replaced` (W40): a press Stripe then refuses leaves their
 * wish again when it puts its own database change back. `extra` (W40a): more for the `left` row's details.
 */
export async function leaveStepReplacing(tx: Tx, step: Omit<LeftStep, 'id'>, by: StepBy, extra: Record<string, unknown> = {}): Promise<{ step: LeftStep; replaced: OpenStep[] }> {
  if (!isStepKind(step.kind)) throw new Error(`Unknown step kind: ${String(step.kind)}`)
  if (!step.membershipId || !step.subscriptionId) throw new Error('A step needs its membership and its subscription.')
  const left: LeftStep = { ...step, want: checkWant(step.kind, step.want), id: crypto.randomUUID() }
  const older = (await openSteps(tx)).filter((open) => open.membershipId === left.membershipId && open.subscriptionId === left.subscriptionId && open.kind === left.kind)
  await audit.recordAll(tx, [...older.map((open) => entry(open, 'replaced', by, { replacedBy: left.id })), entry(left, 'left', by, extra)])
  return { step: left, replaced: older }
}

// --- Sending

export type StepAnswer =
  /** Stripe shows what was asked. `sent` is false when it already did (or the subscription has ended, which settles it). */
  | { kind: 'done'; sent: boolean; detail: string }
  /** Stripe answered and said no: sending again can't help. `missing` (W40, L2): it can't find the subscription. */
  | { kind: 'refused'; message: string; missing?: true }
  /** No clear answer (or no time left to ask): safe to send again. */
  | { kind: 'unclear'; message: string }

const idOf = (value: string | { id: string } | null | undefined): string | null => (typeof value === 'string' ? value : (value?.id ?? null))

/** Whether the subscription already shows what the step wants. */
export function stepIsDone(subscription: Pick<Stripe.Subscription, 'cancel_at' | 'default_payment_method'>, step: Pick<LeftStep, 'kind' | 'want'>): boolean {
  if (step.kind === 'cancel_at') return (subscription.cancel_at ?? null) === (step.want.cancelAt ?? null)
  return idOf(subscription.default_payment_method) === step.want.paymentMethod
}

/**
 * A subscription Stripe has already ended can't be changed. Whether that settles the step: an end date or a card
 * for a subscription that will never renew is moot (done); clearing the end date of one that has ended can't be done
 * at all (refused: a person decides what the membership should now say).
 */
function endedAnswer(step: Pick<LeftStep, 'kind' | 'want' | 'subscriptionId'>): StepAnswer {
  if (step.kind === 'cancel_at' && step.want.cancelAt === null) {
    return { kind: 'refused', message: `Subscription ${step.subscriptionId} has already ended in Stripe, so its cancellation can't be undone there.` }
  }
  return { kind: 'done', sent: false, detail: 'the subscription has already ended in Stripe' }
}

/**
 * What is sent. W40 (W36 review L1): a cancel date goes with `proration_behavior: 'none'`, so setting or clearing an
 * end that falls inside a paid period never makes Stripe bill or credit a part period.
 */
const stepParams = (step: Pick<LeftStep, 'kind' | 'want'>): Stripe.SubscriptionUpdateParams =>
  step.kind === 'cancel_at' ? { cancel_at: step.want.cancelAt ?? '', proration_behavior: 'none' } : { default_payment_method: step.want.paymentMethod as string }

/**
 * The key a send carries: from the step's id (F-plan 4.2 item 4). `attempt` (reconcile's run) makes a later send a
 * request of its own: Stripe replays a saved 500 for a repeated key, which would otherwise keep a retry from ever
 * settling, and the step is safe to send twice (it is read first, and sets a value Stripe already has or doesn't).
 */
export function stepKey(step: Pick<LeftStep, 'id' | 'kind'>, attempt?: string): string {
  const key = stripeIdempotencyKey(step.id, step.kind.replace('_', '-'))
  return attempt ? `${key}:${attempt}` : key
}

const unclear = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Reads the subscription and, only if it doesn't already show what the step wants, sends the change. Writes nothing.
 * Never throws for Stripe.
 */
export async function trySendStep(stripe: StripeClient, step: Pick<LeftStep, 'id' | 'kind' | 'want' | 'subscriptionId'>, timing: StripeTiming | undefined, attempt?: string): Promise<StepAnswer> {
  let now: Stripe.Subscription
  try {
    now = await stripe.subscriptions.retrieve(step.subscriptionId, undefined, sendOptions(timing))
  } catch (err) {
    if (err instanceof NoTimeLeft) return { kind: 'unclear', message: err.message }
    const failure = readStripeFailure(err)
    // As cancelSubscriptionChecked: a subscription the key can't find is for a person (deleted, or the other mode's).
    if (failure.code === 'resource_missing') return { kind: 'refused', missing: true, message: `Stripe can't find subscription ${step.subscriptionId} with the key in use.` }
    return { kind: 'unclear', message: `not read (${failure.message})` }
  }
  if (now.status === 'canceled') return endedAnswer(step)
  if (stepIsDone(now, step)) return { kind: 'done', sent: false, detail: 'Stripe already showed it' }
  try {
    await stripe.subscriptions.update(step.subscriptionId, stepParams(step), sendOptions(timing, { idempotencyKey: stepKey(step, attempt) }))
    return { kind: 'done', sent: true, detail: 'sent' }
  } catch (err) {
    if (err instanceof NoTimeLeft) return { kind: 'unclear', message: err.message }
    const failure = readStripeFailure(err)
    if (failure.outcome !== 'definite') return { kind: 'unclear', message: unclear(err) }
    return { kind: 'refused', message: failure.message, ...(failure.code === 'resource_missing' ? { missing: true as const } : {}) }
  }
}

export type SettledStep =
  | { kind: 'done'; detail: string }
  /** Stripe refused for good: recorded, listed for a person, not sent again. */
  | { kind: 'refused'; message: string }
  /** Still to do: the next run tries again. */
  | { kind: 'left'; message: string }
  /** Closed by something else since it was listed (sorted, replaced, done by its press). `detail`: what was done about a newer step. */
  | { kind: 'closed'; detail?: string }
  /**
   * W40b: a newer step (`stepId`) had replaced it, and that step's wish could not be left again (or marked) because
   * the database failed. An error for the run to report; the next run tries again (`leaveAgainLater`).
   */
  | { kind: 'not_left_again'; stepId: string; message: string }

/** The membership's row lock, which every action that leaves a step holds: an ending is written under it. */
async function lockMembership(tx: Tx, membershipId: string): Promise<void> {
  await tx.query('SELECT id FROM customer_memberships WHERE id::text = $1 FOR NO KEY UPDATE', [membershipId])
}

/** The step that took this one's place (`replacedBy` on its `replaced` row, or on a press's `undone` row), if any. */
const SUCCESSOR_SQL = `
SELECT details->>'replacedBy' AS replaced_by FROM audit_log
WHERE action = '${STEP_LEFT_ACTION}' AND entity_type = '${STEP_LEFT_ENTITY}' AND details->>'stepId' = $1 AND details->>'replacedBy' IS NOT NULL
LIMIT 1`

/**
 * W40a: for a step (`$1`) that is closed, the latest step left after it for the same membership, subscription and
 * kind. Only asked for a closed step with no link. Their times can be trusted here, where an open step's can't: a
 * press is taken only once the step before it has its ending written (M1 refuses while one is open inside its
 * window, and waits for the membership's lock), so its own `left` row is written in a later transaction.
 */
const LATER_STEP_SQL = `
SELECT n.details->>'stepId' AS step_id
FROM audit_log s
JOIN audit_log n ON n.action = '${STEP_LEFT_ACTION}' AND n.entity_type = '${STEP_LEFT_ENTITY}' AND n.entity_id = s.entity_id
  AND n.details->>'state' = 'left' AND n.details->>'subscriptionId' = s.details->>'subscriptionId'
  AND n.details->>'kind' = s.details->>'kind' AND n.at > s.at
WHERE s.action = '${STEP_LEFT_ACTION}' AND s.entity_type = '${STEP_LEFT_ENTITY}' AND s.details->>'state' = 'left' AND s.details->>'stepId' = $1
  AND EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${STEP_LEFT_ACTION}' AND e.entity_type = '${STEP_LEFT_ENTITY}' AND e.details->>'stepId' = s.details->>'stepId'
      AND e.details->>'state' IN (${CLOSING_STATES.map((state) => `'${state}'`).join(', ')})
  )
ORDER BY n.at DESC, n.details->>'stepId' DESC
LIMIT 1`

/**
 * The newest step in this one's chain: itself, unless it has been replaced, and then whatever replaced that, to the
 * end. Followed by the rows' own links first, never by the times of open steps: two transactions' clocks can disagree
 * about which came first, the links can't. W40a: a step closed with no link (its press marked it `done`, or put it
 * back) is not linked to the next press's step, so past one the latest step left after it is taken (LATER_STEP_SQL).
 */
export async function newestOf(db: Queryable, stepId: string): Promise<string> {
  let newest = stepId
  // A chain is as long as the presses made while Stripe gave no answer; the bound only stops a loop in bad data.
  for (let hops = 0; hops < 50; hops += 1) {
    const [next] = await db.query<{ replaced_by: string | null }>(SUCCESSOR_SQL, [newest])
    const after = next?.replaced_by ?? (await db.query<{ step_id: string }>(LATER_STEP_SQL, [newest]))[0]?.step_id
    if (!after || after === newest) return newest
    newest = after
  }
  return newest
}

/** A step by its id, open or closed: its `left` row, and the state of the row that closed it (null while open). */
const STEP_BY_ID_SQL = `
SELECT s.entity_id AS membership_id, s.details->>'stepId' AS step_id, s.details->>'kind' AS kind,
       s.details->>'subscriptionId' AS subscription_id, s.details->'want' AS want,
       (SELECT e.details->>'state' FROM audit_log e
        WHERE e.action = '${STEP_LEFT_ACTION}' AND e.entity_type = '${STEP_LEFT_ENTITY}' AND e.details->>'stepId' = s.details->>'stepId'
          AND e.details->>'state' IN (${CLOSING_STATES.map((state) => `'${state}'`).join(', ')})
        LIMIT 1) AS closed_as,
       EXISTS (SELECT 1 FROM audit_log f
        WHERE f.action = '${STEP_LEFT_ACTION}' AND f.entity_type = '${STEP_LEFT_ENTITY}' AND f.details->>'stepId' = s.details->>'stepId'
          AND f.details->>'state' = 'refused') AS refused
FROM audit_log s
WHERE s.action = '${STEP_LEFT_ACTION}' AND s.entity_type = '${STEP_LEFT_ENTITY}' AND s.details->>'state' = 'left' AND s.details->>'stepId' = $1`

type Recorded = { kind: 'written' } | { kind: 'closed' } | { kind: 'superseded'; by: string }

/**
 * Writes a step's answer (`done` or `refused`) under the membership's lock, after looking again: nothing is written
 * for a step a newer one has replaced (`superseded`), or one closed meanwhile.
 */
async function recordAnswer(db: Db, step: LeftStep, answer: Exclude<StepAnswer, { kind: 'unclear' }>, by: StepBy): Promise<Recorded> {
  return db.transaction(async (tx) => {
    await lockMembership(tx, step.membershipId)
    const newest = await newestOf(tx, step.id)
    if (newest !== step.id) return { kind: 'superseded' as const, by: newest }
    if (!(await openStepById(tx, step.id))) return { kind: 'closed' as const }
    await audit.recordAll(tx, [
      answer.kind === 'done' ? entry(step, 'done', by, { detail: answer.detail, sent: answer.sent }) : entry(step, 'refused', by, { detail: answer.message, ...(answer.missing ? { missing: true } : {}) }),
    ])
    return { kind: 'written' as const }
  })
}

/** Whether a step (`$1`) carries the mark that a stale send may still land (W40b). */
const STALE_SEND_MARK_SQL = `
SELECT 1 FROM audit_log
WHERE action = '${STEP_LEFT_ACTION}' AND entity_type = '${STEP_LEFT_ENTITY}' AND details->>'stepId' = $1 AND details->>'state' = 'stale_send'
LIMIT 1`

type Kept =
  /** It was closed `done`: its wish is left again as this new step. */
  | { kind: 'left_again'; step: LeftStep }
  /** It is still open: it carries the mark, so its own press leaves the wish again when it finishes. */
  | { kind: 'marked' }
  /** A newer change has been made since: its own step stands, and nothing is written. */
  | { kind: 'newer' }
  /** Closed some other way (put back, sorted by hand): nothing to keep. */
  | { kind: 'closed'; as: string }

/**
 * Keeps the newest step's wish where a later run will read Stripe for it, because a send that is not this step's
 * can still land in Stripe after everything else. One transaction under the membership's lock, and only while the
 * step is still the newest (`newer` otherwise: a newer change has been made, and its own step stands).
 * - W40a (W40 review S1): closed `done` by its own press: the wish is left again as a new step. That step is inside
 *   its window, so a new press waits, the stuck list shows it, and the next run past the window reads Stripe (after
 *   any late send has landed) and sends the wish if Stripe doesn't show it. Its `left` row names the step it stands
 *   for (`leftAgainFor`).
 * - W40b: still open (its press is still at Stripe, or got no answer): a `stale_send` row marks it, once. The press's
 *   own ending (`recordStepDone`) finds the mark and leaves the wish again instead of closing the step `done`. With
 *   no press to finish, the step stays open and a run past its window reads Stripe for it, as for any open step.
 */
async function keepForALaterRead(db: Db, step: LeftStep, by: StepBy, staleStepId: string | null): Promise<Kept> {
  return db.transaction(async (tx) => {
    await lockMembership(tx, step.membershipId)
    if ((await newestOf(tx, step.id)) !== step.id) return { kind: 'newer' as const }
    // Read again under the lock: the press may have closed the step since the run read it.
    const [now] = await tx.query<{ closed_as: string | null }>(STEP_BY_ID_SQL, [step.id])
    if (now?.closed_as === 'done') {
      const again = await leaveStepReplacing(tx, { membershipId: step.membershipId, subscriptionId: step.subscriptionId, kind: step.kind, want: step.want }, by, { leftAgainFor: step.id })
      return { kind: 'left_again' as const, step: again.step }
    }
    if (now && now.closed_as !== null) return { kind: 'closed' as const, as: now.closed_as }
    if ((await tx.query(STALE_SEND_MARK_SQL, [step.id])).length === 0) {
      await audit.recordAll(tx, [entry(step, 'stale_send', by, staleStepId ? { staleStep: staleStepId } : {})])
    }
    return { kind: 'marked' as const }
  })
}

/**
 * W40b: a wish that could not be left again (or marked) when a run first tried, because the database failed, tried
 * again by a later run: the same transaction as then, only while the step it stands for is still the newest. Answers
 * what it did, in a few words. Throws if the database fails again: the run reports it, and the next one tries.
 */
export async function leaveAgainLater(db: Db, stepId: string, by: StepBy): Promise<string> {
  const [row] = await db.query<{ membership_id: string; step_id: string; kind: string; subscription_id: string; want: StepWant | null }>(STEP_BY_ID_SQL, [stepId])
  if (!row || !isStepKind(row.kind)) return `step ${stepId} can't be read: nothing left again`
  const step: LeftStep = { id: row.step_id, membershipId: row.membership_id, subscriptionId: row.subscription_id, kind: row.kind, want: row.want ?? {} }
  const kept = await keepForALaterRead(db, step, by, null)
  if (kept.kind === 'left_again') return `step ${step.id}: its wish left again as step ${kept.step.id}`
  if (kept.kind === 'marked') return `step ${step.id}: still open, marked (a stale send may still land)`
  if (kept.kind === 'newer') return `step ${step.id}: not left again (a newer change has been made since)`
  return `step ${step.id}: not left again (it is ${kept.as})`
}

/** What settleNewest says when the run's own send of the replaced step got no clear answer. */
const STALE_SEND_UNCLEAR = "this run's send of the replaced step got no clear answer and may still land"

/** What settleNewest did, in a few words; `notLeftAgain` (W40b): the step whose wish the database would not take. */
interface NewestSettled {
  detail: string
  notLeftAgain?: string
}

/**
 * W40 (S1): reconcile sent (or read for) a step that a newer one had replaced by the time it looked again. Its send
 * may have landed after the newer step's, so Stripe is read once more for the newest step and its wish sent if
 * Stripe doesn't show it. Still open: its answer is written. Put back, sorted by hand, or refused for a person: left
 * alone. Answers what it did, in a few words.
 * W40a (W40 review S1). `staleUnclear`: the run's own send of the replaced step (`staleStepId`) got no clear answer,
 * so it can still land in Stripe after everything here. Already `done` by its press: nothing more to write only when
 * Stripe shows the wish (or took it again) and no stale send can still land; otherwise the wish is left again as a
 * new step, so it is listed and read again past its window. Still open, with a stale send that can still land: left
 * open for that same later read, whatever Stripe shows now.
 * W40b: and marked first, before Stripe is asked anything, so its own press, finishing after this, leaves the wish
 * again instead of closing the step `done` (`keepForALaterRead`). A wish the database would not take is answered as
 * `notLeftAgain`, for the run to report and the next run to try again.
 */
async function settleNewest(db: Db, stripe: StripeClient, newestId: string, by: StepBy, timing: StripeTiming | undefined, staleUnclear: boolean, staleStepId: string): Promise<NewestSettled> {
  const [row] = await db.query<{ membership_id: string; step_id: string; kind: string; subscription_id: string; want: StepWant | null; closed_as: string | null; refused: boolean }>(STEP_BY_ID_SQL, [newestId])
  if (!row || !isStepKind(row.kind)) return { detail: `replaced by step ${newestId}, which can't be read` }
  const newest: LeftStep = { id: row.step_id, membershipId: row.membership_id, subscriptionId: row.subscription_id, kind: row.kind, want: row.want ?? {} }
  if (row.closed_as !== null && row.closed_as !== 'done') return { detail: `replaced by step ${newest.id}, which is ${row.closed_as}` }
  if (row.closed_as === null && staleUnclear) {
    // W40b: open, and a stale send can still land. The mark goes on before anything else: the press may finish any moment.
    let kept: Kept
    try {
      kept = await keepForALaterRead(db, newest, by, staleStepId)
    } catch (err) {
      return { detail: `replaced by step ${newest.id}: ${STALE_SEND_UNCLEAR}: not marked yet (${unclear(err)})`, notLeftAgain: newest.id }
    }
    // Its press closed it between the run's read and the lock: the wish is left again, and read past its window.
    if (kept.kind === 'left_again') return { detail: `replaced by step ${newest.id}, already done: ${STALE_SEND_UNCLEAR}: its wish left again as step ${kept.step.id}` }
    if (kept.kind === 'newer') return { detail: `replaced by step ${newest.id}: not marked (a newer change has been made since)` }
    if (kept.kind === 'closed') return { detail: `replaced by step ${newest.id}, which is ${kept.as}` }
  }
  if (row.closed_as === null && row.refused) return { detail: `replaced by step ${newest.id}, which Stripe refused: listed for a person` }
  const answer = await trySendStep(stripe, newest, timing, by.requestId)
  const said = answer.kind === 'unclear' ? `no clear answer (${answer.message})` : answer.kind === 'done' ? (answer.sent ? 'sent again' : 'Stripe shows it') : `refused (${answer.message})`
  if (row.closed_as === 'done') {
    if (answer.kind === 'done' && !staleUnclear) return { detail: `replaced by step ${newest.id}, already done: ${said}` }
    const why = answer.kind === 'done' ? `${said}, but ${STALE_SEND_UNCLEAR}` : said
    try {
      const kept = await keepForALaterRead(db, newest, by, staleUnclear ? staleStepId : null)
      return { detail: `replaced by step ${newest.id}, already done: ${why}: ${kept.kind === 'left_again' ? `its wish left again as step ${kept.step.id}` : 'not left again (a newer change has been made since)'}` }
    } catch (err) {
      // W40b: not lost. The run reports it, and the next run tries again.
      return { detail: `replaced by step ${newest.id}, already done: ${why}: not left again yet (${unclear(err)})`, notLeftAgain: newest.id }
    }
  }
  if (answer.kind === 'unclear') return { detail: `replaced by step ${newest.id}, which got no clear answer (${answer.message})` }
  // Open, and Stripe shows its wish now: a stale send that can still land would undo it with the step closed, so it stays open.
  if (answer.kind === 'done' && staleUnclear) return { detail: `replaced by step ${newest.id}: ${said}, left open (${STALE_SEND_UNCLEAR})` }
  try {
    const recorded = await recordAnswer(db, newest, answer, by)
    return { detail: `replaced by step ${newest.id}: ${said}${recorded.kind === 'written' ? '' : ', not recorded (it changed again)'}` }
  } catch (err) {
    return { detail: `replaced by step ${newest.id}: ${said}, not recorded yet (${unclear(err)})` }
  }
}

/** settleNewest's answer as the run's: closed, or (W40b) a wish that could not be left again. */
const settledFor = (settled: NewestSettled): SettledStep =>
  settled.notLeftAgain ? { kind: 'not_left_again', stepId: settled.notLeftAgain, message: settled.detail } : { kind: 'closed', detail: settled.detail }

/**
 * Reconcile's turn at one open step: read again (it may have been closed since the run listed it), then sent as
 * trySendStep, under a key of this run. Done writes the `done` row; a refusal the `refused` row, once. An answer
 * that can't be recorded leaves the step as it was: the next run reads Stripe, finds it done, and writes it then.
 * W40 (S1): a step still inside its press's window is left to the press; and after the send the step is looked at
 * again under the membership's lock, so one a newer step has replaced gets no row and the newest is settled instead
 * (W40a: told whether this run's own send of the replaced step got no clear answer). W40b: `not_left_again` when the
 * newest step's wish had to be left again and the database would not take it.
 */
export async function settleLeftStep(db: Db, stripe: StripeClient, stepId: string, by: StepBy, timing: StripeTiming | undefined): Promise<SettledStep> {
  const step = await openStepById(db, stepId)
  if (!step) return { kind: 'closed' }
  if (step.refused) return { kind: 'refused', message: step.refusal ?? '' }
  if (step.inWindow) return { kind: 'left', message: `recorded less than ${PROCESSING_MINUTES} minutes ago: its press may still be sending it` }
  const answer = await trySendStep(stripe, step, timing, by.requestId)
  // Replaced while this was at Stripe: whatever Stripe said about the old wish, the newest is the one to settle.
  const newest = await newestOf(db, step.id)
  if (newest !== step.id) return settledFor(await settleNewest(db, stripe, newest, by, timing, answer.kind === 'unclear', step.id))
  if (answer.kind === 'unclear') return { kind: 'left', message: answer.message }
  let recorded: Recorded
  try {
    recorded = await recordAnswer(db, step, answer, by)
  } catch (err) {
    return { kind: 'left', message: `${answer.kind === 'done' ? 'done in Stripe' : 'refused by Stripe'}, not recorded yet (${unclear(err)})` }
  }
  if (recorded.kind === 'superseded') return settledFor(await settleNewest(db, stripe, recorded.by, by, timing, false, step.id))
  if (recorded.kind === 'closed') return { kind: 'closed' }
  return answer.kind === 'done' ? { kind: 'done', detail: answer.detail } : { kind: 'refused', message: answer.message }
}

/**
 * The press's own ending for the step it left and sent (W40): `done`, written under the membership's lock and only
 * while the step is still open (nothing can have replaced it inside its window, but a row is never written on trust).
 * Answers whether it was written.
 * W40b: not when the step carries the mark that a stale send may still land (a run's send of the step this one
 * replaced got no clear answer while this press was at Stripe). The wish is then left again as a new step, in the
 * same transaction and only while this step is still the newest: this step is closed as `replaced` by it, the new
 * one is listed, a new press waits its window, and the next run past the window reads Stripe and sends the wish if
 * the stale send has landed over it.
 */
export async function recordStepDone(db: Db, step: LeftStep, by: StepBy, detail: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockMembership(tx, step.membershipId)
    if (!(await openStepById(tx, step.id))) return false
    const marked = (await tx.query(STALE_SEND_MARK_SQL, [step.id])).length > 0
    if (marked && (await newestOf(tx, step.id)) === step.id) {
      await leaveStepReplacing(tx, { membershipId: step.membershipId, subscriptionId: step.subscriptionId, kind: step.kind, want: step.want }, by, { leftAgainFor: step.id })
      return false
    }
    await audit.recordAll(tx, [stepEndEntry(step, 'done', by, detail)])
    return true
  })
}

// --- Checked once more after it closes (W40c)

/** One row per check that ends: which closed steps it covers (`steps`), what it found (`outcome`), and any step it left. */
export const STEP_CHECK_ACTION = 'membership.step_check'
/** How long after a step closes it is checked: the press's window, plus a margin for a send that lands late. */
export const CHECK_MARGIN_MINUTES = 5
export const CHECK_AFTER_MINUTES = PROCESSING_MINUTES + CHECK_MARGIN_MINUTES
/** How long a check may go without a clear read of Stripe before the wish is left again, so it is listed. */
export const CHECK_UNREAD_HOURS = 2

/** A subscription and kind with closed steps no check has covered yet. */
export interface CheckDue {
  membershipId: string
  subscriptionId: string
  kind: StepKind
  /** The closed steps this check covers. */
  stepIds: string[]
  /** The oldest of them closed more than CHECK_UNREAD_HOURS ago. */
  unreadTooLong: boolean
}

const closingStates = CLOSING_STATES.map((state) => `'${state}'`).join(', ')

/**
 * Every closed step no check row covers, once its closing is older than CHECK_AFTER_MINUTES, grouped by membership,
 * subscription and kind: one read of Stripe covers them all. "No check row", never "no later check row": whether a
 * row names the step, not which row came last. No upper age: a closing that was never read is still due, and is
 * listed once it is older than CHECK_UNREAD_HOURS. Oldest closing first.
 */
const CHECKS_DUE_SQL = `
SELECT e.entity_id AS membership_id, e.details->>'subscriptionId' AS subscription_id, e.details->>'kind' AS kind,
       jsonb_agg(DISTINCT e.details->>'stepId') AS step_ids,
       min(e.at) < now() - interval '${CHECK_UNREAD_HOURS} hours' AS unread_too_long
FROM audit_log e
WHERE e.action = '${STEP_LEFT_ACTION}' AND e.entity_type = '${STEP_LEFT_ENTITY}' AND e.details->>'state' IN (${closingStates})
  AND e.at < now() - interval '${CHECK_AFTER_MINUTES} minutes'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log c
    WHERE c.action = '${STEP_CHECK_ACTION}' AND c.entity_type = '${STEP_LEFT_ENTITY}' AND c.entity_id = e.entity_id
      AND c.details->'steps' ? (e.details->>'stepId')
  )
GROUP BY e.entity_id, e.details->>'subscriptionId', e.details->>'kind'
ORDER BY min(e.at), e.entity_id, e.details->>'subscriptionId', e.details->>'kind'`

/** The same, for one membership (`$1`), subscription (`$2`) and kind (`$3`): asked again under the membership's lock. */
const CHECK_DUE_FOR_SQL = `SELECT d.step_ids FROM (${CHECKS_DUE_SQL}) d WHERE d.membership_id = $1 AND d.subscription_id = $2 AND d.kind = $3`

interface CheckDueRow {
  membership_id: string
  subscription_id: string
  kind: string
  step_ids: string[] | null
  unread_too_long: boolean
}

/** The checks due, oldest closing first. Rows of a kind this file doesn't know are left alone. */
export async function checksDue(db: Queryable): Promise<CheckDue[]> {
  return (await db.query<CheckDueRow>(CHECKS_DUE_SQL)).flatMap((row) =>
    isStepKind(row.kind) && row.step_ids && row.step_ids.length > 0
      ? [{ membershipId: row.membership_id, subscriptionId: row.subscription_id, kind: row.kind, stepIds: row.step_ids, unreadTooLong: row.unread_too_long === true }]
      : []
  )
}

/** A step (`$1`) as the check reads it: how it was closed (null while open), and whether that was inside the last CHECK_AFTER_MINUTES. */
const STEP_FOR_CHECK_SQL = `
SELECT s.entity_id AS membership_id, s.details->>'stepId' AS step_id, s.details->>'kind' AS kind,
       s.details->>'subscriptionId' AS subscription_id, s.details->'want' AS want,
       e.state AS closed_as, COALESCE(e.recent, false) AS closed_recently,
       EXISTS (SELECT 1 FROM audit_log f
        WHERE f.action = '${STEP_LEFT_ACTION}' AND f.entity_type = '${STEP_LEFT_ENTITY}' AND f.details->>'stepId' = s.details->>'stepId'
          AND f.details->>'state' = 'refused') AS refused
FROM audit_log s
LEFT JOIN LATERAL (
  SELECT c.details->>'state' AS state, c.at > now() - interval '${CHECK_AFTER_MINUTES} minutes' AS recent
  FROM audit_log c
  WHERE c.action = '${STEP_LEFT_ACTION}' AND c.entity_type = '${STEP_LEFT_ENTITY}' AND c.details->>'stepId' = s.details->>'stepId'
    AND c.details->>'state' IN (${closingStates})
  ORDER BY c.at DESC, c.details->>'state'
  LIMIT 1
) e ON true
WHERE s.action = '${STEP_LEFT_ACTION}' AND s.entity_type = '${STEP_LEFT_ENTITY}' AND s.details->>'state' = 'left' AND s.details->>'stepId' = $1`

/**
 * For a step (`$1`) its press put back, the step left before it for the same membership, subscription and kind. Their
 * times can be trusted, as LATER_STEP_SQL's: a press that is put back with no link replaced nothing still open, so the
 * step before it had its ending written before this one was left.
 */
const EARLIER_STEP_SQL = `
SELECT p.details->>'stepId' AS step_id
FROM audit_log s
JOIN audit_log p ON p.action = '${STEP_LEFT_ACTION}' AND p.entity_type = '${STEP_LEFT_ENTITY}' AND p.entity_id = s.entity_id
  AND p.details->>'state' = 'left' AND p.details->>'subscriptionId' = s.details->>'subscriptionId'
  AND p.details->>'kind' = s.details->>'kind' AND p.at < s.at
WHERE s.action = '${STEP_LEFT_ACTION}' AND s.entity_type = '${STEP_LEFT_ENTITY}' AND s.details->>'state' = 'left' AND s.details->>'stepId' = $1
ORDER BY p.at DESC, p.details->>'stepId' DESC
LIMIT 1`

/**
 * W40d: whether a step (`$1`) is one a check left again (a check row names it as `leftAgain`) that was then sent and
 * closed `done` (its `done` row says `sent`). A check that finds Stripe differing from such a wish has seen Stripe
 * take the change and show something else: sending it once more can't help.
 */
const CHECK_LEFT_AND_SENT_SQL = `
SELECT 1 FROM audit_log c
JOIN audit_log d ON d.action = '${STEP_LEFT_ACTION}' AND d.entity_type = '${STEP_LEFT_ENTITY}' AND d.entity_id = c.entity_id
  AND d.details->>'stepId' = c.details->>'leftAgain' AND d.details->>'state' = 'done' AND d.details->>'sent' = 'true'
WHERE c.action = '${STEP_CHECK_ACTION}' AND c.entity_type = '${STEP_LEFT_ENTITY}' AND c.details->>'leftAgain' = $1
LIMIT 1`

/**
 * W40d (W40c review S2): whether a membership (`$1`) has a step no check row names: one still open (a check row only
 * ever names closed steps), or one closed and not checked yet. The same test as OPEN_STEPS_SQL and CHECKS_DUE_SQL
 * together, for one membership, without the check's 20 minute wait: a closing is unsettled from the moment it is
 * written.
 */
const UNSETTLED_STEP_SQL = `
SELECT 1 FROM audit_log s
WHERE s.action = '${STEP_LEFT_ACTION}' AND s.entity_type = '${STEP_LEFT_ENTITY}' AND s.entity_id = $1 AND s.details->>'state' = 'left'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log c
    WHERE c.action = '${STEP_CHECK_ACTION}' AND c.entity_type = '${STEP_LEFT_ENTITY}' AND c.entity_id = s.entity_id
      AND c.details->'steps' ? (s.details->>'stepId')
  )
LIMIT 1`

/**
 * W40d (W40c review S2): whether a membership has a step still open, or closed and not yet checked against Stripe.
 * The two legacy routes ask before they change anything (legacy-guard.ts): while this is true, a change they made
 * would look like a stale send to the check, which would put the step's wish back over it.
 */
export async function stepsUnsettled(db: Queryable, membershipId: string): Promise<boolean> {
  return (await db.query(UNSETTLED_STEP_SQL, [membershipId])).length > 0
}

/** The step whose wish Stripe should show: `closedAs` null while it is open. */
interface WishInForce extends LeftStep {
  closedAs: string | null
  closedRecently: boolean
  refused: boolean
}

/**
 * The newest wish for a step's subscription and kind: the newest step in its chain (`newestOf`), unless its press put
 * it back after Stripe refused it (`undone`: the database shows the wish before it again), and then the step before
 * that, and so on. Null when every step was put back, or one can't be read: there is nothing to hold Stripe to.
 * Never the membership's own row: the webhook copies Stripe's date onto it, so it agrees with a stale send.
 */
async function wishInForce(db: Queryable, stepId: string): Promise<WishInForce | null> {
  let id = await newestOf(db, stepId)
  // As newestOf's: the bound only stops a loop in bad data.
  for (let hops = 0; hops < 50; hops += 1) {
    const [row] = await db.query<{ membership_id: string; step_id: string; kind: string; subscription_id: string; want: StepWant | null; closed_as: string | null; closed_recently: boolean; refused: boolean }>(STEP_FOR_CHECK_SQL, [id])
    if (!row || !isStepKind(row.kind)) return null
    if (row.closed_as !== 'undone') {
      return { id: row.step_id, membershipId: row.membership_id, subscriptionId: row.subscription_id, kind: row.kind, want: row.want ?? {}, closedAs: row.closed_as, closedRecently: row.closed_recently === true, refused: row.refused === true }
    }
    const [earlier] = await db.query<{ step_id: string }>(EARLIER_STEP_SQL, [id])
    if (!earlier) return null
    id = earlier.step_id
  }
  return null
}

type StripeSeen =
  /** Stripe shows the wish, or the subscription has ended where that settles it. */
  | { kind: 'agrees'; detail: string }
  /** Stripe shows something else. */
  | { kind: 'differs'; detail: string }
  /** Stripe can't find the subscription, or it has ended and the wish can't be met: for a person, never sent. */
  | { kind: 'person'; message: string; missing?: true }
  /** No clear answer. */
  | { kind: 'unread'; message: string }

/** One read of the subscription, set against the wish. Never a send, and never throws for Stripe. */
async function readForCheck(stripe: StripeClient, wish: Pick<LeftStep, 'kind' | 'want' | 'subscriptionId'>, timing: StripeTiming | undefined): Promise<StripeSeen> {
  let now: Stripe.Subscription
  try {
    now = await stripe.subscriptions.retrieve(wish.subscriptionId, undefined, sendOptions(timing))
  } catch (err) {
    if (err instanceof NoTimeLeft) return { kind: 'unread', message: err.message }
    const failure = readStripeFailure(err)
    if (failure.code === 'resource_missing') return { kind: 'person', missing: true, message: `Stripe can't find subscription ${wish.subscriptionId} with the key in use.` }
    return { kind: 'unread', message: `not read (${failure.message})` }
  }
  if (now.status === 'canceled') {
    const ended = endedAnswer(wish)
    return ended.kind === 'refused' ? { kind: 'person', message: ended.message } : { kind: 'agrees', detail: 'the subscription has already ended in Stripe' }
  }
  if (stepIsDone(now, wish)) return { kind: 'agrees', detail: 'Stripe shows it' }
  return { kind: 'differs', detail: wish.kind === 'cancel_at' ? `Stripe shows cancel_at ${now.cancel_at ?? 'none'}` : `Stripe shows the card ${idOf(now.default_payment_method) ?? 'none'}` }
}

/** What a check row says it found. */
export type CheckOutcome =
  /** Stripe shows the newest wish, or there is nothing to hold it to (no wish, or W40d: a wish a person marked sorted). */
  | 'checked'
  /** The newest step is still open: it is listed already, and is checked itself when it closes. */
  | 'open'
  /** Stripe showed something else: the newest wish was left again as a new step, to be sent. */
  | 'left_again'
  /**
   * Stripe can't find the subscription, or has ended it, or (W40d) still shows something else after a check's own
   * left-again step was sent and done: the newest wish was left again as a refused step, for a person.
   */
  | 'for_a_person'
  /** No clear read in CHECK_UNREAD_HOURS: the newest wish was left again, so it is listed and read by every run. */
  | 'unread'

export type StepChecked =
  /** A check row was written and nothing is left to do. */
  | { kind: 'checked'; outcome: Extract<CheckOutcome, 'checked' | 'open'>; detail: string }
  /** A check row was written, and the newest wish left again as step `stepId`: it is listed. */
  | { kind: 'listed'; outcome: Exclude<CheckOutcome, 'checked' | 'open'>; stepId: string; detail: string }
  /** Nothing was written: the next run looks again. */
  | { kind: 'wait'; detail: string }

/** What a check leaves with its row: the newest wish again, to send (`send`) or as refused for a person. */
type CheckLeaves = { how: 'send' } | { how: 'refused'; message: string; missing?: true }

/**
 * A check's ending, in one transaction under the membership's lock, after looking again. Nothing is written when
 * another run has covered these closings meanwhile, or when the newest wish is no longer the one Stripe was read for
 * (a press since, or its step closed): the next run looks again. Otherwise one check row naming the closings it
 * covers, and with `leaves` the newest wish left again as a new step in the same transaction (as `keepForALaterRead`
 * does), so two runs at once can't leave it twice and it is never left over a newer change.
 */
async function endCheck(db: Db, due: CheckDue, wish: WishInForce | null, by: StepBy, outcome: CheckOutcome, detail: string, leaves?: CheckLeaves): Promise<StepChecked> {
  return db.transaction(async (tx) => {
    await lockMembership(tx, due.membershipId)
    const [still] = await tx.query<{ step_ids: string[] | null }>(CHECK_DUE_FOR_SQL, [due.membershipId, due.subscriptionId, due.kind])
    const steps = due.stepIds.filter((id) => (still?.step_ids ?? []).includes(id))
    if (steps.length === 0) return { kind: 'wait' as const, detail: 'checked by another run meanwhile' }
    const now = await wishInForce(tx, steps[0] as string)
    if ((now?.id ?? null) !== (wish?.id ?? null) || (now?.closedAs ?? null) !== (wish?.closedAs ?? null)) return { kind: 'wait' as const, detail: 'a change has been made since: not checked yet' }
    const again = wish && leaves ? (await leaveStepReplacing(tx, { membershipId: wish.membershipId, subscriptionId: wish.subscriptionId, kind: wish.kind, want: wish.want }, by, { leftAgainFor: wish.id })).step : null
    await audit.recordAll(tx, [
      ...(again && leaves?.how === 'refused' ? [entry(again, 'refused', by, { detail: leaves.message, ...(leaves.missing ? { missing: true } : {}) })] : []),
      {
        actorType: by.actor.type,
        actorId: by.actor.id,
        action: STEP_CHECK_ACTION,
        entityType: STEP_LEFT_ENTITY,
        entityId: due.membershipId,
        requestId: by.requestId,
        details: { subscriptionId: due.subscriptionId, kind: due.kind, steps, outcome, wish: wish?.id ?? null, ...(again ? { leftAgain: again.id } : {}), detail },
      },
    ])
    if (again && outcome !== 'checked' && outcome !== 'open') return { kind: 'listed' as const, outcome, stepId: again.id, detail }
    return { kind: 'checked' as const, outcome: outcome === 'open' ? ('open' as const) : ('checked' as const), detail }
  })
}

/**
 * W40c: the net under everything above. Every step that closes (done, replaced, put back, sorted by hand, or left
 * again) is checked once more, CHECK_AFTER_MINUTES after it closed, by one read of its subscription set against the
 * newest wish for that subscription and kind. By then no send of an older wish can still be on its way: a press sends
 * inside its own request, and a run sends a step's wish only seconds after reading it as open or as the newest, so
 * any send for a step closed that long ago has landed or never will.
 * - The newest step is still open: nothing is read. It is listed already, and is checked itself when it closes.
 * - The newest step closed inside the last CHECK_AFTER_MINUTES: nothing yet. Its own closing is due soon, and that
 *   one read covers these too.
 * - W40d (W40c review S1): the newest wish is a step a person marked sorted: nothing is read. One `checked` row, and
 *   that wish is never held to Stripe or sent again. A step is sorted only after Stripe refused it for good and a
 *   person put Stripe right by hand, perhaps to something else than the wish (a date Stripe would take); sending the
 *   wish again would undo their fix, or be refused and listed again for ever. No older send can still be on its way:
 *   Stripe had refused the step before the person touched it.
 * - Stripe shows the wish (or has ended the subscription, where that settles it): one `checked` row, and that is all.
 * - Stripe shows something else: the newest wish is left again as a new step. It is listed, a new press waits its
 *   window, and the next run past the window sends it. That step is checked in its turn when it closes.
 * - W40d, the loop guard: Stripe shows something else, and the wish is itself a step a check left again that was then
 *   sent and closed `done`. Stripe took the change and still shows another value, so sending it again would only
 *   repeat: the wish is left again as a step already refused, listed for a person with Mark sorted, and never sent.
 * - Stripe can't find the subscription, or has ended one whose cancellation was undone: the wish is left again as a
 *   step already refused, so it is listed for a person and never sent.
 * - No clear answer: nothing is written, and the next run reads again. After CHECK_UNREAD_HOURS the wish is left
 *   again, so it is listed and every run reads Stripe for it until one read is clear.
 * Stripe is only ever read here, and a row about a read is written after the read, never before.
 */
export async function checkAfterClosing(db: Db, stripe: StripeClient, due: CheckDue, by: StepBy, timing: StripeTiming | undefined): Promise<StepChecked> {
  const first = due.stepIds[0]
  if (!first) return { kind: 'wait', detail: 'nothing to check' }
  const wish = await wishInForce(db, first)
  if (!wish) return endCheck(db, due, null, by, 'checked', "no wish to hold Stripe to: every change was put back, or its step can't be read")
  // Closed as replaced between the two reads above: a press is being made. The next run looks again.
  if (wish.closedAs === 'replaced') return { kind: 'wait', detail: `step ${wish.id} was replaced meanwhile: not checked yet` }
  if (wish.closedAs === null) {
    return endCheck(db, due, wish, by, 'open', wish.refused ? `the newest step ${wish.id} is open and Stripe has refused it: listed for a person` : `the newest step ${wish.id} is still open: listed, and checked when it closes`)
  }
  if (wish.closedRecently) return { kind: 'wait', detail: `the newest step ${wish.id} closed less than ${CHECK_AFTER_MINUTES} minutes ago: checked with it` }
  // W40d (S1): a sorted wish is a person's. Not read, not held to Stripe, never sent again.
  if (wish.closedAs === 'sorted') return endCheck(db, due, wish, by, 'checked', `step ${wish.id} was marked sorted by a person: not held to Stripe`)
  const seen = await readForCheck(stripe, wish, timing)
  if (seen.kind === 'agrees') return endCheck(db, due, wish, by, 'checked', `step ${wish.id}: ${seen.detail}`)
  if (seen.kind === 'differs') {
    // W40d, the loop guard: a check left this wish again, it was sent and closed `done`, and Stripe still differs.
    if (wish.closedAs === 'done' && (await db.query(CHECK_LEFT_AND_SENT_SQL, [wish.id])).length > 0) {
      const message = `Subscription ${wish.subscriptionId} was sent this change again after a check and took it, and ${seen.detail} all the same: it is not sent again.`
      return endCheck(db, due, wish, by, 'for_a_person', `step ${wish.id}: ${message} Left for a person`, { how: 'refused', message })
    }
    return endCheck(db, due, wish, by, 'left_again', `step ${wish.id}: ${seen.detail}, not its wish: left again`, { how: 'send' })
  }
  if (seen.kind === 'person') {
    return endCheck(db, due, wish, by, 'for_a_person', `step ${wish.id}: ${seen.message} Left for a person`, { how: 'refused', message: seen.message, ...(seen.missing ? { missing: true as const } : {}) })
  }
  if (!due.unreadTooLong) return { kind: 'wait', detail: `step ${wish.id}: ${seen.message}` }
  return endCheck(db, due, wish, by, 'unread', `step ${wish.id}: no clear read of Stripe in ${CHECK_UNREAD_HOURS} hours (${seen.message}): left again`, { how: 'send' })
}

// --- Sorted by a person

export type SortedStep =
  | { closed: true; alreadyClosed?: true; message: string }
  | { closed: false; reason: 'not_listed' | 'still_trying'; message: string }

/**
 * A person records a refused step as sorted, once Stripe has been put right by hand. Nothing is sent and nothing
 * else changes. A step the automatic check is still sending is refused (`still_trying`); one already closed by an
 * earlier press of this answers that it was; anything else no longer listed is refused (`not_listed`).
 * `closeRow` (W40, L4): one more row to write with the `sorted` row, in the same transaction.
 */
export async function sortLeftStep(db: Db, stepId: string, why: string, by: StepBy, closeRow?: (step: OpenStep) => AuditEntry): Promise<SortedStep> {
  return db.transaction(async (tx) => {
    // One close of one step at a time; reconcile's own rows never wait on this.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`step-left:${stepId}`])
    const step = await openStepById(tx, stepId)
    if (!step) {
      const sorted = await tx.query(SORTED_BEFORE_SQL, [stepId])
      return sorted.length > 0 ? { closed: true as const, alreadyClosed: true as const, message: LEFT_STEP_WORDS.sorted } : { closed: false as const, reason: 'not_listed' as const, message: LEFT_STEP_WORDS.notListed }
    }
    if (!step.refused) return { closed: false as const, reason: 'still_trying' as const, message: LEFT_STEP_WORDS.stillTrying }
    // W40 (W36 review L4): `closeRow` is the manual close's own `order.close` row, written with the `sorted` row.
    await audit.recordAll(tx, [entry(step, 'sorted', by, { byHand: { why } }), ...(closeRow ? [closeRow(step)] : [])])
    return { closed: true as const, message: LEFT_STEP_WORDS.sorted }
  })
}
