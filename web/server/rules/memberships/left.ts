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
// Nothing calls `leaveStep` until W40, so the list and reconcile find none until then.
import 'server-only'
import type Stripe from 'stripe'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
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

/** `left`: recorded, to send. `refused`: Stripe said no for good. The rest close it. */
export type StepState = 'left' | 'refused' | 'done' | 'sorted' | 'replaced' | 'undone'
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
 * with the database change put back). `detail` says why, in a few words.
 */
export function stepEndEntry(step: LeftStep, state: Extract<StepState, 'done' | 'undone'>, by: StepBy, detail?: string): AuditEntry {
  return entry(step, state, by, detail ? { detail } : {})
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
       r.detail IS NOT NULL AS refused, r.detail AS refusal,
       c.id AS customer_id, NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS customer_name
FROM audit_log s
LEFT JOIN LATERAL (
  SELECT COALESCE(f.details->>'detail', '') AS detail
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
    customerId: row.customer_id,
    customerName: row.customer_name,
  }
}

/** Every open step, oldest first: the stuck list's. */
export async function openSteps(db: Queryable): Promise<OpenStep[]> {
  return (await db.query<OpenStepRow>(OPEN_STEPS_SQL)).map(openStep).filter((step): step is OpenStep => step !== null)
}

/** The open steps reconcile sends again, oldest first: those Stripe hasn't refused for good. */
export async function stepsDue(db: Queryable): Promise<OpenStep[]> {
  return (await openSteps(db)).filter((step) => !step.refused)
}

/** One open step by its id, or null when it is closed or was never recorded. */
async function openStepById(db: Queryable, stepId: string): Promise<OpenStep | null> {
  const rows = await db.query<OpenStepRow>(OPEN_STEP_BY_ID_SQL, [stepId])
  return rows[0] ? openStep(rows[0]) : null
}

/** What the stuck list says for an open step. */
export function stepWords(step: Pick<OpenStep, 'kind' | 'subscriptionId' | 'refused'>): string {
  return LEFT_STEP_WORDS[step.kind][step.refused ? 'refused' : 'left'](step.subscriptionId)
}

// --- Writing

/**
 * Records a Stripe step to do, in the action's transaction (`tx`), and closes as `replaced` any step still open
 * for the same subscription and kind. The caller holds the membership's row lock, so two actions on one membership
 * can't each leave a step the other doesn't see. Returns the step, for the send that follows the commit.
 */
export async function leaveStep(tx: Tx, step: Omit<LeftStep, 'id'>, by: StepBy): Promise<LeftStep> {
  if (!isStepKind(step.kind)) throw new Error(`Unknown step kind: ${String(step.kind)}`)
  if (!step.membershipId || !step.subscriptionId) throw new Error('A step needs its membership and its subscription.')
  const left: LeftStep = { ...step, want: checkWant(step.kind, step.want), id: crypto.randomUUID() }
  const older = (await openSteps(tx)).filter((open) => open.membershipId === left.membershipId && open.subscriptionId === left.subscriptionId && open.kind === left.kind)
  await audit.recordAll(tx, [...older.map((open) => entry(open, 'replaced', by, { replacedBy: left.id })), entry(left, 'left', by)])
  return left
}

// --- Sending

export type StepAnswer =
  /** Stripe shows what was asked. `sent` is false when it already did (or the subscription has ended, which settles it). */
  | { kind: 'done'; sent: boolean; detail: string }
  /** Stripe answered and said no: sending again can't help. */
  | { kind: 'refused'; message: string }
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

const stepParams = (step: Pick<LeftStep, 'kind' | 'want'>): Stripe.SubscriptionUpdateParams =>
  step.kind === 'cancel_at' ? { cancel_at: step.want.cancelAt ?? '' } : { default_payment_method: step.want.paymentMethod as string }

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
    if (failure.code === 'resource_missing') return { kind: 'refused', message: `Stripe can't find subscription ${step.subscriptionId} with the key in use.` }
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
    return failure.outcome === 'definite' ? { kind: 'refused', message: failure.message } : { kind: 'unclear', message: unclear(err) }
  }
}

export type SettledStep =
  | { kind: 'done'; detail: string }
  /** Stripe refused for good: recorded, listed for a person, not sent again. */
  | { kind: 'refused'; message: string }
  /** Still to do: the next run tries again. */
  | { kind: 'left'; message: string }
  /** Closed by something else since it was listed (sorted, replaced, done by its press). */
  | { kind: 'closed' }

/**
 * Reconcile's turn at one open step: read again (it may have been closed since the run listed it), then sent as
 * trySendStep, under a key of this run. Done writes the `done` row; a refusal the `refused` row, once. An answer
 * that can't be recorded leaves the step as it was: the next run reads Stripe, finds it done, and writes it then.
 */
export async function settleLeftStep(db: Db, stripe: StripeClient, stepId: string, by: StepBy, timing: StripeTiming | undefined): Promise<SettledStep> {
  const step = await openStepById(db, stepId)
  if (!step) return { kind: 'closed' }
  if (step.refused) return { kind: 'refused', message: step.refusal ?? '' }
  const answer = await trySendStep(stripe, step, timing, by.requestId)
  if (answer.kind === 'unclear') return { kind: 'left', message: answer.message }
  try {
    await db.transaction((tx) =>
      audit.recordAll(tx, [answer.kind === 'done' ? entry(step, 'done', by, { detail: answer.detail, sent: answer.sent }) : entry(step, 'refused', by, { detail: answer.message })])
    )
  } catch (err) {
    return { kind: 'left', message: `${answer.kind === 'done' ? 'done in Stripe' : 'refused by Stripe'}, not recorded yet (${unclear(err)})` }
  }
  return answer.kind === 'done' ? { kind: 'done', detail: answer.detail } : { kind: 'refused', message: answer.message }
}

// --- Sorted by a person

export type SortedStep =
  | { closed: true; alreadyClosed?: true; message: string }
  | { closed: false; reason: 'not_listed' | 'still_trying'; message: string }

/**
 * A person records a refused step as sorted, once Stripe has been put right by hand. Nothing is sent and nothing
 * else changes. A step the automatic check is still sending is refused (`still_trying`); one already closed by an
 * earlier press of this answers that it was; anything else no longer listed is refused (`not_listed`).
 */
export async function sortLeftStep(db: Db, stepId: string, why: string, by: StepBy): Promise<SortedStep> {
  return db.transaction(async (tx) => {
    // One close of one step at a time; reconcile's own rows never wait on this.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`step-left:${stepId}`])
    const step = await openStepById(tx, stepId)
    if (!step) {
      const sorted = await tx.query(SORTED_BEFORE_SQL, [stepId])
      return sorted.length > 0 ? { closed: true as const, alreadyClosed: true as const, message: LEFT_STEP_WORDS.sorted } : { closed: false as const, reason: 'not_listed' as const, message: LEFT_STEP_WORDS.notListed }
    }
    if (!step.refused) return { closed: false as const, reason: 'still_trying' as const, message: LEFT_STEP_WORDS.stillTrying }
    await audit.recordAll(tx, [entry(step, 'sorted', by, { byHand: { why } })])
    return { closed: true as const, message: LEFT_STEP_WORDS.sorted }
  })
}
