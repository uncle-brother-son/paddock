// New in W17 (D-plan 4.2, brief W17 item 3): a booking change paid on the saved card is a flow, as a reader one is
// (W12): its record is a pending_reader_payments row with `method: 'card'`, written by the change's C1 before any
// Stripe call; the charge is keyed from that row's id and names it in its metadata (`pending_id`); then C2 (W12's flow
// finalise, which now writes the card's order) or, on a definite refusal, the undo (W12's flow undo). Each is one
// transaction that locks the flow's row first and re-checks it, so a second press, reconcile and a race each end in
// one outcome. Replaces bookingCardCharge's started and finished rows, pressFinished, earlierCardCharge's resume,
// reverseTakenPayment and the 24-hour key look-ups (D-plan "five things" 1). No route yet: W19 (Settle) is the first
// change to start a card flow, and adds reconcile's card part.
import 'server-only'
import Stripe from 'stripe'
import type { Db, Tx } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { ORDER_STRIPE_LIMITS } from '@/server/stripe/limits'
import { readStripeFailure } from '@/server/stripe/outcome'
import {
  AUTHENTICATION_NEEDED_MESSAGE,
  chargeFailedMessage,
  MIN_SEND_MS,
  pence,
  STRIPE_ACCESS_REFUSED_MESSAGE,
  type ChargeAnswer,
  type CollectTiming,
} from '@/server/rules/orders/collect-saved-card'
import {
  finaliseFlowInTransaction,
  isWorkerCardFlow,
  readFlow,
  undoFlowInTransaction,
  type FlowFinaliseOutcome,
  type FlowRow,
  type FlowSnapshot,
  type ReaderFlow,
} from '@/server/rules/orders/reader-flow'
import type { ReaderRouteOptions } from '@/server/rules/orders/reader-order'
import { CARD_FLOW_CHARGED_WITHOUT_RECORD_MESSAGE, CARD_FLOW_PAID_NOT_FINISHED_MESSAGE, CHANGE_PAYMENT_UNCONFIRMED_MESSAGE } from './failure-messages'

/** The Stripe steps of a flow, each keyed `<pendingId>:<step>` (W12-7). */
export const FLOW_CHARGE_STEP = 'charge'
export const FLOW_READER_INTENT_STEP = 'reader-intent'

/** The key for a flow's one saved-card charge: the same on every send, from any press or reconcile. */
export const flowChargeKey = (pendingId: string): string => stripeIdempotencyKey(pendingId, FLOW_CHARGE_STEP)
/** The key for a reader flow's intent (W19 writes reader flows pending-first too). */
export const flowReaderIntentKey = (pendingId: string): string => stripeIdempotencyKey(pendingId, FLOW_READER_INTENT_STEP)

/**
 * What every Stripe call of a flow says it is for: the old metadata (`flow`, `record_id`, which finalise checks) and
 * the record's own id, which the old flows never had: reconcile finds a payment whose answer was lost by it, and
 * flowPaymentMismatch refuses a payment naming another record.
 */
export const flowMetadata = (row: Pick<FlowRow, 'id' | 'flow' | 'record_id'>): Record<'flow' | 'record_id' | 'pending_id', string> => ({
  flow: row.flow,
  record_id: row.record_id,
  pending_id: row.id,
})

/** A card flow's record: the old flow snapshot (what C2 and the undo read) plus what the charge needs. */
export type CardFlowSnapshot = FlowSnapshot & {
  method: 'card'
  channel: 'staff'
  request_id: string
  /** The customer's Stripe customer and saved card, as C1 read them under the customer's lock. */
  stripe_customer_id: string
  payment_method_id: string
  /** The mode of the Stripe key the charge goes with (true for live), for reconcile's "not found" rule (W12). */
  livemode: boolean
}

export interface NewFlowRecord {
  flow: ReaderFlow
  /** The booking (Move, Settle and Add Guest all record the booking). */
  recordId: string
  /** The card's part, in pounds: what Stripe takes and C2 checks, to the penny. */
  expectedAmount: number
  snapshot: CardFlowSnapshot | (FlowSnapshot & { method: 'reader'; channel: 'staff'; request_id: string; livemode: boolean })
}

/**
 * Writes a flow's record, pending, with no PaymentIntent yet: C1's last write, in C1's transaction (bug 14's rule:
 * the record exists before anything is asked of Stripe). Answers its id, which every key of the flow is built from.
 */
export async function writeFlowRecord(tx: Tx, record: NewFlowRecord): Promise<string> {
  const row = (
    await tx.query<{ id: string }>(
      `INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status, created_at, updated_at)
       VALUES ($1::text, $2::uuid, NULL, $3::numeric, $4::jsonb, 'pending', clock_timestamp(), clock_timestamp())
       RETURNING id`,
      [record.flow, record.recordId, record.expectedAmount, JSON.stringify(record.snapshot)]
    )
  )[0]
  if (!row) throw new Error('The flow record was not written.')
  return row.id
}

/**
 * The charge's request, built only from the record, so every send (this press's retry, a second press, reconcile)
 * is exactly the same request under the same key. Stripe refuses a key reused with different parameters.
 */
export function cardFlowChargeRequest(row: FlowRow & { snapshot: CardFlowSnapshot }): Stripe.PaymentIntentCreateParams {
  return {
    amount: pence(Number.parseFloat(row.expected_amount)),
    currency: 'gbp',
    customer: row.snapshot.stripe_customer_id,
    payment_method: row.snapshot.payment_method_id,
    off_session: true,
    confirm: true,
    description: row.snapshot.description,
    metadata: flowMetadata(row),
  }
}

const accessRefused = (err: unknown): boolean =>
  err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError

/**
 * Charges the saved card for the flow, once, under `<pendingId>:charge`, outside any transaction. The rules are the
 * order's (collect-saved-card.ts): a PaymentIntent back is Stripe's answer, which C2 checks; a definite refusal (or a
 * 401/403 on the first send) means nothing was taken; anything else is retried once with the same key and request,
 * then is unclear (never undone here). With `timing`, the second send gets only the time left.
 */
export async function chargeCardFlow(stripe: StripeClient, row: FlowRow & { snapshot: CardFlowSnapshot }, timing?: CollectTiming): Promise<ChargeAnswer> {
  const request = cardFlowChargeRequest(row)
  const key = flowChargeKey(row.id)
  let last: { detail: string; stripeCode: string | null } = { detail: '', stripeCode: null }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let options: Stripe.RequestOptions = { idempotencyKey: key }
    if (attempt === 2 && timing) {
      const left = Math.floor(timing.deadline - timing.now())
      if (left < MIN_SEND_MS) return { outcome: 'unknown', detail: `${last.detail} (not sent again: ${left} ms left before the deadline)`, stripeCode: last.stripeCode, attempts: 1 }
      options = { idempotencyKey: key, timeout: Math.min(ORDER_STRIPE_LIMITS.timeoutMs, left) }
    }
    try {
      return { outcome: 'answered', paymentIntent: await stripe.paymentIntents.create(request, options), attempts: attempt }
    } catch (err) {
      const failure = readStripeFailure(err)
      if (accessRefused(err) && attempt === 1) {
        return { outcome: 'definite', needsAuthentication: false, message: STRIPE_ACCESS_REFUSED_MESSAGE, stripeCode: failure.code ?? 'access_refused', attempts: attempt }
      }
      if (failure.outcome === 'definite') {
        const needsAuthentication = failure.code === 'authentication_required'
        return {
          outcome: 'definite',
          needsAuthentication,
          message: needsAuthentication ? AUTHENTICATION_NEEDED_MESSAGE : chargeFailedMessage(failure.message),
          stripeCode: failure.code,
          attempts: attempt,
        }
      }
      last = { detail: failure.message, stripeCode: failure.code }
    }
  }
  return { outcome: 'unknown', ...last, attempts: 2 }
}

export type CardFlowOutcome =
  /** C2 recorded the payment (now, or by an earlier press or reconcile). */
  | { outcome: 'finished'; pendingId: string; orderId: string | null; paymentIntentId: string | null; alreadyFinished: boolean }
  /** Stripe refused the charge: nothing was taken. `undone` false: the undo failed and reconcile undoes it. */
  | { outcome: 'declined'; pendingId: string; message: string; needsAuthentication: boolean; stripeCode: string | null; undone: boolean }
  /**
   * Held for reconcile, never undone here: no clear answer (Q35), the card paid and C2 couldn't record it (W6-3), a
   * payment that doesn't check out, or a charge that landed on a flow already undone (reconcile refunds it).
   */
  | {
      outcome: 'held'
      pendingId: string
      reason: 'payment_unconfirmed' | 'paid_not_finished' | 'payment_mismatch' | 'charged_without_record'
      message: string
      detail: string
    }
  /** Nothing to do: the record is gone, already undone, or not a Worker card flow. */
  | { outcome: 'not_open'; pendingId: string; state: 'gone' | 'cancelled' | 'not_card' }

export interface CardFlowOptions extends Pick<ReaderRouteOptions, 'actor' | 'requestId'> {
  timing?: CollectTiming
}

const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

/**
 * After C1 has committed a card flow's record: charge, then C2 or the undo. Safe to run again at any point, by a
 * second press or by reconcile: the same key gets Stripe's first answer back, so the card is charged at most once,
 * and C2 and the undo each re-check the row under its lock, so the change is finished or undone at most once.
 */
export async function settleCardFlow(db: Db, stripe: StripeClient, pendingId: string, options: CardFlowOptions): Promise<CardFlowOutcome> {
  const row = await readFlow(db, pendingId)
  if (!row) return { outcome: 'not_open', pendingId, state: 'gone' }
  if (!isWorkerCardFlow(row.snapshot)) return { outcome: 'not_open', pendingId, state: 'not_card' }
  if (row.status === 'cancelled') return { outcome: 'not_open', pendingId, state: 'cancelled' }
  const card = row as FlowRow & { snapshot: CardFlowSnapshot }
  const actor = { actor: options.actor, requestId: options.requestId }

  if (row.status === 'finalised') {
    const recorded = row.payment_intent_id
      ? (await db.query<{ id: string }>('SELECT id FROM orders WHERE stripe_payment_intent_id = $1 LIMIT 1', [row.payment_intent_id]))[0]?.id ?? null
      : null
    return { outcome: 'finished', pendingId, orderId: recorded, paymentIntentId: row.payment_intent_id, alreadyFinished: true }
  }

  let answer: ChargeAnswer
  try {
    answer = await chargeCardFlow(stripe, card, options.timing)
  } catch (err) {
    return { outcome: 'held', pendingId, reason: 'payment_unconfirmed', message: CHANGE_PAYMENT_UNCONFIRMED_MESSAGE, detail: explain(err) }
  }

  if (answer.outcome === 'unknown') {
    return { outcome: 'held', pendingId, reason: 'payment_unconfirmed', message: CHANGE_PAYMENT_UNCONFIRMED_MESSAGE, detail: `${answer.stripeCode ?? 'no code'}: ${answer.detail}` }
  }

  if (answer.outcome === 'definite') {
    let undone = false
    try {
      const result = await undoFlowInTransaction(db, pendingId, { ...actor, why: `The saved card was refused: ${answer.stripeCode ?? 'no code'}. ${answer.message}` })
      // Already undone or gone: nothing is left held either way.
      undone = result.undone || result.reason !== 'already_finalised'
    } catch {
      // Nothing was taken, so the refusal is still the answer; the record stays pending for reconcile's undo.
      undone = false
    }
    return { outcome: 'declined', pendingId, message: answer.message, needsAuthentication: answer.needsAuthentication, stripeCode: answer.stripeCode, undone }
  }

  const paymentIntent = answer.paymentIntent
  let finalised: FlowFinaliseOutcome
  try {
    finalised = await finaliseFlowInTransaction(db, pendingId, paymentIntent, actor)
  } catch (err) {
    return { outcome: 'held', pendingId, reason: 'paid_not_finished', message: CARD_FLOW_PAID_NOT_FINISHED_MESSAGE, detail: `C2 failed after ${paymentIntent.id}: ${explain(err)}` }
  }
  if (finalised.finalised) return { outcome: 'finished', pendingId, orderId: finalised.orderId, paymentIntentId: paymentIntent.id, alreadyFinished: finalised.alreadyFinalised }
  if (finalised.reason === 'charged_without_record') {
    return { outcome: 'held', pendingId, reason: 'charged_without_record', message: CARD_FLOW_CHARGED_WITHOUT_RECORD_MESSAGE, detail: `${paymentIntent.id} succeeded for a flow already undone` }
  }
  return { outcome: 'held', pendingId, reason: 'payment_mismatch', message: CHANGE_PAYMENT_UNCONFIRMED_MESSAGE, detail: `${paymentIntent.id}: ${finalised.reason} (${paymentIntent.status})` }
}

/**
 * The card flow's undo on its own (reconcile, W19, once Stripe shows nothing was taken; or a decline the press
 * couldn't undo). W12's flow undo: one transaction, the row first, safe twice.
 */
export function undoCardFlow(db: Db, pendingId: string, options: Pick<ReaderRouteOptions, 'actor' | 'requestId'> & { why: string }) {
  return undoFlowInTransaction(db, pendingId, options)
}
