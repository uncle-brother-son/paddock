// reconcile.ts (W03-plan 2.1 and 2.5; new in W12). Settles what the Worker left pending: orders held on the
// saved card or the reader, and reader flows (Move, Settle, Add Guest), once they are older than the
// 15-minute window (Q14), and refunds a payment that succeeded on an order or flow already undone
// (W03-decisions, "W12 calls"). The schedule runs it every 5 minutes (server/scheduled.ts); staff can run it
// from the Orders page (POST /api/v1/staff/orders/reconcile). It runs whatever ORDER_SWITCH says (W10
// review L5), because an order held when a kind is switched off can only be settled here.
//
// It only reads Stripe, cancels an intent nobody can pay any more, and sends the automatic refund. It never
// starts a charge (W03-plan 2.5, "Reconcile never starts a new charge": the customer may be long gone).
// It never takes a lease: T2 and the undo lock their row and re-check it, and every Stripe step is keyed
// or safe to repeat, so the screen, a second reconcile and the old sweep can overlap (2.5, "Races").
//
// Who settles what until W16 (lead, "W12 calls"): only orders and flows the Worker made (their pending
// record carries the Worker's `method` and `request_id`). Anything the old code made is counted and left
// to the old sweep.
//
// W12a (W12 review S1): it also reads Stripe for Worker orders the old screens moved out of `pending`
// while their payment was unconfirmed (changed-elsewhere.ts), and records what it finds. It never acts on
// them: no cancel, refund, finalise or undo.
//
// W13: membership orders. Their subscription is found with `subscriptions.list` by customer, matched by
// `metadata.order_id`. Everything planned succeeded: the old subscription cancelled (Q8: a cancel starts
// nothing), then T2. Part done (a subscription but no charge, or a tap but no subscription): compensate and
// undo (W03-plan 2.5), never a new charge or subscription. An order whose compensation started: finish it.
//
// W13a (W13 review B1): a reader membership's "tap but no subscription" waits while a press of the screen's
// finalise is starting the subscription (left, `subscription_starting`), and once older lists Stripe again after
// the mark before compensating (membership.ts). L1: T2's definite checks before Q8's cancel. A late refund of a
// payment a compensation already refunded under the same key counts as done.
//
// W13c (W13a review L3, first part): a membership subscription a press left live (`order.subscription_left`,
// `left`) for an order no longer pending is put back here, each run until it is: cancelled (checked), its first
// invoice refunded under its key, then a `cancelled` row, which closes the stuck list's warning. W13d (W13c review
// L3): only for an order that no longer exists (gone), never a paid one.
import 'server-only'
import Stripe from 'stripe'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { sendOptions, STRIPE_DEADLINE_MS, stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import type { FinaliseReaderOrderOutput } from '@/contracts'
import { readStripeFailure } from '@/server/stripe/outcome'
import { CHANGED_ELSEWHERE, CHANGED_ELSEWHERE_DAYS, CHANGED_ELSEWHERE_WHERE, FINAL_FINDINGS, type ChangedElsewhereFinding } from './changed-elsewhere'
import { OLD_MEMBERSHIP_CANCELLED_NOTE } from './failure-messages'
import { finaliseOrder, MEMBERSHIP_DEFINITE, membershipPrecheck } from './finalise-order'
import { pence } from './collect-saved-card'
import {
  cancelSubscriptionChecked,
  compensateOrder,
  findOrderSubscriptions,
  retryLeftSubscription,
  subscriptionMismatch,
  type LeftSubscription,
  type MadeSubscription,
  type RefundStep,
  type Taken,
} from './membership'
import { SUBSCRIPTIONS_LEFT_SQL } from './stuck-list'
import { PROCESSING_MINUTES, type CardSnapshot, type PendingSnapshot, type ReaderSnapshot } from './pending-order'
import { cancelReaderFlow, finaliseFlowInTransaction, readFlow, undoFlowInTransaction, type FlowRow } from './reader-flow'
import { cancelReaderOrder, finaliseReaderOrderFound, otherModeMessage, settleIntent } from './reader-order'
import { undoOrder } from './undo-order'

/** Q14: a pending order or flow younger than this may still have staff at the reader. */
export const RECONCILE_WINDOW_MINUTES = PROCESSING_MINUTES

/**
 * The scheduled run's bounds. Cloudflare gives a Cron Trigger that fires more often than hourly 30 s of
 * CPU and 15 minutes of wall time (developers.cloudflare.com/workers/platform/limits, read 10 Nov 2026).
 * Reconcile mostly waits (Stripe, Postgres), so the wall time is what matters: no new item starts after
 * 120 s, and at most 50 items a run; whatever is left waits for the next run (oldest first, so nothing
 * starves). CPU per item is a few milliseconds of JSON.
 *
 * One item's worst case (W12a, correcting W12's "about 70 s", W12 review): each Stripe call at its 10 s
 * limit (no SDK retries), each transaction at its 5 s lock and 8 s statement limits (13 s), each other
 * statement at 8 s, and one page per Stripe list.
 * - Worst: a reader order whose tap lands while reconcile cancels it, with save-card. Its intent on the
 *   record: the order read (8) + read, cancel, read again, then resolveSavedCard's PaymentIntent and
 *   PaymentMethod (5 calls, 50) + T2 (13) + its row (13) ≈ 84 s. Held with no intent (W12a L4): the list,
 *   read, cancel, read again, the two card reads (6 calls, 60) + T2 (13) + its row (13) ≈ 86 s.
 * - A card order: list, read, cancel, read again (40) + the undo or T2 (13) + its row (13) ≈ 66 s. A flow
 *   ≈ 70 s. A late refund: read, the started row (13), the refund, its row (13) ≈ 46 s. A changed-elsewhere
 *   order (W12a S1): the list (10) + the last row's read (8) + its row (13) ≈ 31 s.
 * - A list that pages adds 10 s a page: ten pages (the cap: 1,000 intents of one customer since the order,
 *   or of the club's key in a 12-minute window, far past the club's payments) add 90 s, so ≈ 176 s.
 * - W13c, a left put-back's retry (L3): the subscription read, cancel, read again, the refund twice (50) + its row
 *   (13) + the run's row (13) ≈ 76 s.
 * So a run ends by about 120 + 86 ≈ 206 s (under 3.5 minutes), before the next run; with ten-page lists by
 * about 296 s (just under 5 minutes). Overlap would still be safe (no leases: T2 and the undo lock and
 * re-check; the refund's first row is written once under an advisory lock), and either way it is far inside
 * 15 minutes. The caps stay.
 */
export const SCHEDULED_LIMITS = { maxItems: 50, budgetMs: 120_000 }
/**
 * Staff's run (Retool waits 60 s for a function): no new item after 15 s, at most 10 items, and every
 * Stripe call answered by 20 s from the request's start (each with what is left, at most 10 s, none with
 * under 2 s left: server/stripe/deadline.ts). W13: a membership's T2 can take 18.1 s (the order's lock 5 s,
 * its statement 8 s, and the new membership's credit period, whose insert can wait up to the 5 s lock limit
 * on another transaction's), so the Stripe part ends 5 s sooner than W12's 25 s, and a reader order's
 * finalise or cancel now keeps to the run's deadline too (W12a N1). Worst case: Retool's call (1.2 s) + the
 * reads that find what is due (≈ 0.2 s) + Stripe by 20 s + the last item's T2 (≈ 18.1 s) + its
 * `order.reconcile` row (≤ 8 s statement) ≈ 47.5 s: 12.5 s inside 60 s.
 * W13c: the longest is now a replacing card membership whose check before Q8 (in a transaction, 8.1 s) starts as
 * the last Stripe call answers and finds the order gone or marked: 1.2 + the five reads (≈ 0.25) + 20 + 8.1 + T2
 * 13.1 + its row 8.1 + 0.05 ≈ 50.8 s (9.2 inside). A left put-back's retry (L3): Stripe by 20 + its `cancelled` row
 * 8.1 + the run's row 8.1 ≈ 37.7 s.
 */
export const MANUAL_LIMITS = { maxItems: 10, budgetMs: 15_000, stripeDeadlineMs: 20_000 }

/** Stripe lists 100 at most per page. Ten pages is far past the club's payments in any window. */
const LIST_PAGE = 100
const LIST_MOST_PAGES = 10
/** Clocks: Stripe's `created` and Postgres's time can disagree a little. */
const CLOCK_MARGIN_S = 120
/** Without a customer to list by, how long after the record an intent can have been made (the press's 30 s, with room). */
const WINDOW_AFTER_S = 600

export interface ReconcileOptions {
  /** `system` on the schedule; the staff member on a manual run. */
  actor: { type: 'staff' | 'system'; id: string | null }
  requestId: string
  maxItems: number
  budgetMs: number
  /** A manual run: its Stripe calls end by `stripeDeadlineMs` from here. The schedule has none. */
  startedAt?: number
  /** With `startedAt`: how long after it the Stripe calls must be answered by (default the press's 30 s). */
  stripeDeadlineMs?: number
  now?: () => number
  windowMinutes?: number
}

export type ItemOutcome =
  /** Paid: T2 ran (or the flow's T2). */
  | 'finalised'
  /** Nothing was or can be taken: the one undo (or the flow's) gave everything back. */
  | 'undone'
  /** Someone else settled it first (finalised, undone, cancelled): nothing for reconcile to do. */
  | 'settled_elsewhere'
  /** A late payment's automatic refund: started (row written, sent), confirmed by Stripe, or failed. */
  | 'refund_pending'
  | 'refund_confirmed'
  | 'refund_failed'
  /** Left for a person, or for the next run: `reason` says which. */
  | 'left'

export interface ReconcileItem {
  kind: 'order' | 'flow' | 'refund'
  id: string
  outcome: ItemOutcome
  reason?: string
  /** What staff need to know (a finalised order's save-card warning, W03a later 6 / R6). */
  warning?: string
  detail?: string
  /** W12a (S1): what Stripe shows for an order the old screens moved out of pending. */
  finding?: ChangedElsewhereFinding
}

export interface ReconcileResult {
  checked: number
  finalised: number
  undone: number
  refunds: number
  left: number
  /** Over the run's bounds: left for the next run. */
  deferred: number
  /** Started by the old code: counted, left to the old sweep (until W14 makes it a wrapper of this). */
  oldLeftAlone: { orders: number; flows: number }
  /** Stripe refused the key (401/403): nothing more was tried, and an alert row was recorded. */
  stripeRefused: boolean
  items: ReconcileItem[]
}

// --- A key Stripe refuses (W10 review L4)

interface Watched {
  client: StripeClient
  refused(): { status: number | null; message: string } | null
}

/**
 * The client, watching for a 401 or 403: Stripe refused the key itself (wrong, revoked, the other
 * account) or what it may do. Every item would meet the same, so the run stops and says so once, instead
 * of counting it as "Stripe unavailable" item by item.
 *
 * W12a (W12 review L6): the whole client is watched, every call of every resource at any depth, so a call
 * whose failure the caller swallows (resolveSavedCard's card reads, say) still stops the run.
 */
function watchForRefusedKey(stripe: StripeClient): Watched {
  let refused: { status: number | null; message: string } | null = null
  const note = (err: unknown): void => {
    if (err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError) {
      refused ??= { status: err.statusCode ?? null, message: err.message }
    }
  }
  const watch = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property) {
        const value: unknown = Reflect.get(object, property)
        if (typeof value === 'function') {
          return (...args: unknown[]): unknown => {
            let answer: unknown
            try {
              answer = (value as (...a: unknown[]) => unknown).apply(object, args)
            } catch (err) {
              note(err)
              throw err
            }
            return answer instanceof Promise
              ? answer.catch((err: unknown) => {
                  note(err)
                  throw err
                })
              : answer
          }
        }
        if (value !== null && typeof value === 'object') return watch(value)
        return value
      },
    })
  return { client: watch(stripe), refused: () => refused }
}

// --- Finding an intent nobody wrote down (W11 report, "What W12 must add" (a))

type Found = { kind: 'found'; intents: Stripe.PaymentIntent[] } | { kind: 'unclear'; detail: string }

/**
 * Every intent naming this record, from Stripe's list (never search, which can lag behind a write: Stripe's
 * own advice). It can't miss one:
 * - the intent is only ever made after the record was committed (T1, or step D's flow start), so it was
 *   created no earlier than the record, less a margin for the two clocks;
 * - with a customer: the record names the Stripe customer the intent is made for (a card order always; a
 *   reader order or flow once T1 knew it, or once its intent was written), so the customer's list holds it;
 * - without one: the intent is made inside the press's 30-second Stripe deadline, so it was created within
 *   minutes of the record; the window lists everything the club's key made then, of any customer;
 * - every page is read (up to 1,000 intents; more is answered unclear, and left);
 * - only the key's own mode is listed, so "nothing found" counts only when the record's mode is the key's.
 */
async function findIntents(
  stripe: StripeClient,
  timing: StripeTiming | undefined,
  args: { customer: string | null; since: string; matches: (intent: Stripe.PaymentIntent) => boolean }
): Promise<Found> {
  const from = Math.floor(new Date(args.since).getTime() / 1000) - CLOCK_MARGIN_S
  const created = args.customer ? { gte: from } : { gte: from, lte: from + CLOCK_MARGIN_S + WINDOW_AFTER_S }
  const intents: Stripe.PaymentIntent[] = []
  let startingAfter: string | undefined
  try {
    for (let page = 0; page < LIST_MOST_PAGES; page++) {
      const listed = await stripe.paymentIntents.list(
        { ...(args.customer ? { customer: args.customer } : {}), created, limit: LIST_PAGE, ...(startingAfter ? { starting_after: startingAfter } : {}) },
        sendOptions(timing)
      )
      intents.push(...listed.data.filter(args.matches))
      const last = listed.data.at(-1)
      if (!listed.has_more || !last) return { kind: 'found', intents }
      startingAfter = last.id
    }
  } catch (err) {
    return { kind: 'unclear', detail: readStripeFailure(err).message }
  }
  return { kind: 'unclear', detail: `more than ${LIST_PAGE * LIST_MOST_PAGES} payments to look through` }
}

type Settled = { kind: 'none' } | { kind: 'succeeded'; paymentIntent: Stripe.PaymentIntent } | { kind: 'several' } | { kind: 'unclear'; detail: string }

/**
 * What the intents found add up to: one that succeeded is the payment; any other is cancelled (W11's
 * settleIntent: read it, cancel it, read it again if the cancel fails, so a tap that lands meanwhile is
 * seen). Two that succeeded can't happen under one key, and are left for a person if they do.
 */
async function settleFound(stripe: StripeClient, timing: StripeTiming | undefined, intents: Stripe.PaymentIntent[]): Promise<Settled> {
  const succeeded = intents.filter((intent) => intent.status === 'succeeded')
  if (succeeded.length > 1) return { kind: 'several' }
  if (succeeded[0]) return { kind: 'succeeded', paymentIntent: succeeded[0] }
  for (const intent of intents) {
    if (intent.status === 'canceled') continue
    const settled = await settleIntent(stripe, { payment_intent_id: intent.id, livemode: intent.livemode }, timing)
    if (settled.kind === 'succeeded') return { kind: 'succeeded', paymentIntent: settled.paymentIntent }
    if (settled.kind === 'unclear') return { kind: 'unclear', detail: settled.message }
  }
  return { kind: 'none' }
}

/** "Nothing found" means nothing was taken only with a key of the record's own mode (W11 review L1). */
const sameMode = (recorded: boolean | undefined, key: boolean | null): boolean => typeof recorded === 'boolean' && recorded === key

// --- The run

interface Run {
  db: Db
  stripe: StripeClient
  timing: StripeTiming | undefined
  options: ReconcileOptions
  /** Each action's row: `order.reconcile`, actor system (or the staff member). */
  record(entityType: 'order' | 'reader_payment', entityId: string, details: Record<string, unknown>): Promise<void>
  /**
   * W12a (W12 review L7): the automatic refund's rows are always the system's, even on a staff member's
   * manual run (the refund is automatic by Wayne's decision; the button only runs it sooner). On a manual
   * run the row names who ran it (`runBy`); the staff member stays the actor of the run's other rows.
   */
  refundEntry(entityType: 'order' | 'reader_payment', entityId: string, details: Record<string, unknown>): AuditEntry
  recordRefund(entityType: 'order' | 'reader_payment', entityId: string, details: Record<string, unknown>): Promise<void>
}

const left = (kind: ReconcileItem['kind'], id: string, reason: string, detail?: string): ReconcileItem => ({ kind, id, outcome: 'left', reason, ...(detail ? { detail } : {}) })

interface PendingOrder {
  id: string
  customer_id: string
  since: string
  reader_payment: PendingSnapshot
}

async function undoTheOrder(run: Run, orderId: string, why: string): Promise<ReconcileItem> {
  try {
    const undone = await undoOrder(run.db, orderId, { actor: run.options.actor, requestId: run.options.requestId, why })
    if (undone.undone) return { kind: 'order', id: orderId, outcome: 'undone', detail: why }
    if (undone.reason === 'changed_since') return left('order', orderId, 'changed_since', undone.changed.join('; '))
    if (undone.reason === 'rollback_started') return left('order', orderId, 'old_rollback')
    return { kind: 'order', id: orderId, outcome: 'settled_elsewhere', detail: undone.reason }
  } catch (err) {
    return left('order', orderId, 'undo_failed', err instanceof Error ? err.message : String(err))
  }
}

async function finaliseTheOrder(run: Run, orderId: string, paymentIntent: Stripe.PaymentIntent): Promise<ReconcileItem> {
  try {
    const outcome = await finaliseOrder(run.db, orderId, paymentIntent, { actor: run.options.actor, requestId: run.options.requestId })
    if (outcome.finalised) return outcome.alreadyPaid ? { kind: 'order', id: orderId, outcome: 'settled_elsewhere', detail: 'paid' } : { kind: 'order', id: orderId, outcome: 'finalised', detail: paymentIntent.id }
    // order_gone: T2 recorded the payment for the automatic refund (the refunds step, this run or the next).
    return left('order', orderId, outcome.reason === 'order_gone' ? 'charged_without_order' : outcome.reason, paymentIntent.id)
  } catch (err) {
    // A database fault after the payment: never refunded for it (W6-3); the next run finalises it again.
    return left('order', orderId, 'finalise_failed', err instanceof Error ? err.message : String(err))
  }
}

/**
 * A saved-card order (W10): Stripe's list of the customer's payments, matched by `metadata.order_id`.
 * Succeeded: T2. Nothing found, or only failed or cancelled ones: nothing was taken, and nothing more can
 * be (the charge's key `<orderId>:charge` is only ever sent by the press that placed the order, long
 * finished): the undo. Anything still processing, or unclear: left for the next run.
 */
async function reconcileCardOrder(run: Run, order: PendingOrder, snapshot: CardSnapshot): Promise<ReconcileItem> {
  const found = await findIntents(run.stripe, run.timing, { customer: snapshot.stripe_customer_id, since: order.since, matches: (intent) => intent.metadata?.['order_id'] === order.id })
  if (found.kind === 'unclear') return left('order', order.id, 'unclear', found.detail)
  return settleOrderFromFound(run, order, snapshot, found.intents, 'Stripe has no payment for this card order')
}

async function settleOrderFromFound(run: Run, order: PendingOrder, snapshot: PendingSnapshot, intents: Stripe.PaymentIntent[], nothingWhy: string): Promise<ReconcileItem> {
  if (intents.length === 0 && !sameMode(snapshot.livemode, run.stripe.keyLivemode)) {
    return left('order', order.id, 'other_mode', `the record's mode ${String(snapshot.livemode)}, the key's ${String(run.stripe.keyLivemode)}`)
  }
  const settled = await settleFound(run.stripe, run.timing, intents)
  if (settled.kind === 'unclear') return left('order', order.id, 'unclear', settled.detail)
  if (settled.kind === 'several') return left('order', order.id, 'several_payments', intents.map((intent) => intent.id).join(', '))
  if (settled.kind === 'succeeded') {
    // W12a (W12 review L4): a reader order goes through the reader's finalise, so its card is saved (or R6's warning).
    if (snapshot.method === 'reader') return finaliseHeldReaderOrder(run, order.id, snapshot, settled.paymentIntent)
    return finaliseTheOrder(run, order.id, settled.paymentIntent)
  }
  return undoTheOrder(run, order.id, intents.length === 0 ? nothingWhy : `Stripe's payments for this order were cancelled: ${intents.map((intent) => intent.id).join(', ')}`)
}

/** A reader order whose intent is on its record: as cancel does (W11), by the system. */
async function reconcileReaderOrder(run: Run, order: PendingOrder, snapshot: ReaderSnapshot & { payment_intent_id: string }): Promise<ReconcileItem> {
  // W13: a membership's subscription, found first: reconcile never starts one (a tap with none is refunded).
  let subscriptionFound: MadeSubscription | null | undefined
  if (snapshot.membership) {
    const looked = await subscriptionFoundFor(run, order, snapshot)
    if ('unclear' in looked) return left('order', order.id, 'unclear', looked.unclear)
    if ('several' in looked) return left('order', order.id, 'several_subscriptions', looked.several)
    subscriptionFound = looked.found
  }
  const answer = await cancelReaderOrder(run.db, run.stripe, order.id, {
    actor: run.options.actor,
    requestId: run.options.requestId,
    // W13 (W12a N1): the run's own deadline, not the press's 30 s.
    ...(run.timing ? { timing: run.timing } : {}),
    ...(subscriptionFound !== undefined ? { subscriptionFound } : {}),
  })
  if (answer.cancelled) return answer.alreadyGone ? { kind: 'order', id: order.id, outcome: 'settled_elsewhere', detail: 'gone' } : { kind: 'order', id: order.id, outcome: 'undone', detail: 'the reader payment was cancelled' }
  if (answer.finalisedInstead) return readerFinaliseItem(order.id, answer.finaliseResult, snapshot.payment_intent_id)
  if (answer.reason === 'stripe_error') {
    return left('order', order.id, answer.message === otherModeMessage(snapshot.payment_intent_id) ? 'other_mode' : 'unclear', answer.message)
  }
  if (answer.reason === 'already_paid' || answer.reason === 'already_cancelled') return { kind: 'order', id: order.id, outcome: 'settled_elsewhere', detail: answer.reason }
  if (answer.reason === 'rollback_incomplete') return left('order', order.id, 'undo_failed', answer.message)
  if (answer.reason === 'rollback_started') return left('order', order.id, 'old_rollback', answer.message)
  return left('order', order.id, answer.reason ?? 'unclear', answer.message)
}

/** The reader finalise's answer as reconcile's item. */
function readerFinaliseItem(orderId: string, result: FinaliseReaderOrderOutput | undefined, paymentIntentId: string): ReconcileItem {
  // W13: a membership that couldn't be set up: its tap refunded and the order undone.
  if (result?.rolledBack) return { kind: 'order', id: orderId, outcome: 'undone', detail: `${result.reason ?? ''}: the tap ${paymentIntentId} refunded` }
  if (result?.finalised) {
    return result.alreadyFinalised
      ? { kind: 'order', id: orderId, outcome: 'settled_elsewhere', detail: 'paid' }
      : { kind: 'order', id: orderId, outcome: 'finalised', detail: result.paymentIntentId ?? paymentIntentId, ...(result.warning ? { warning: result.warning } : {}) }
  }
  return left('order', orderId, result?.reason ?? 'finalise_failed', result?.message)
}

/** W12a (W12 review L4): a held reader order's succeeded intent, found by listing: the reader's finalise, with the card step. */
async function finaliseHeldReaderOrder(run: Run, orderId: string, snapshot: ReaderSnapshot, paymentIntent: Stripe.PaymentIntent): Promise<ReconcileItem> {
  // W13: with a membership, never a new subscription: the one found, or none (the tap is then refunded).
  let subscriptionFound: MadeSubscription | null | undefined
  if (snapshot.membership) {
    const looked = await subscriptionFoundFor(run, { id: orderId, customer_id: '', since: '', reader_payment: snapshot }, { ...snapshot, stripe_customer_id: snapshot.stripe_customer_id ?? (typeof paymentIntent.customer === 'string' ? paymentIntent.customer : null) })
    if ('unclear' in looked) return left('order', orderId, 'unclear', looked.unclear)
    if ('several' in looked) return left('order', orderId, 'several_subscriptions', looked.several)
    subscriptionFound = looked.found
  }
  const result = await finaliseReaderOrderFound(
    run.db,
    run.stripe,
    orderId,
    snapshot,
    paymentIntent,
    { actor: run.options.actor, requestId: run.options.requestId, ...(subscriptionFound !== undefined ? { subscriptionFound } : {}) },
    run.timing
  )
  return readerFinaliseItem(orderId, result, paymentIntent.id)
}

/**
 * A reader order held with no intent on its record (W11: its intent's answer was unclear, or the Worker
 * died before writing it): the intents naming it (by `metadata.order_id`), each cancelled unless it
 * succeeded (impossible without the secret, which never reached the screen, but checked; if one did, the
 * reader's finalise, W12a L4); then the undo.
 */
async function reconcileHeldReaderOrder(run: Run, order: PendingOrder, snapshot: ReaderSnapshot): Promise<ReconcileItem> {
  const customer = snapshot.stripe_customer_id ?? null
  const found = await findIntents(run.stripe, run.timing, { customer, since: order.since, matches: (intent) => intent.metadata?.['order_id'] === order.id })
  if (found.kind === 'unclear') return left('order', order.id, 'unclear', found.detail)
  return settleOrderFromFound(run, order, snapshot, found.intents, "Stripe has no reader payment for this order (its intent's answer was never written down)")
}

// --- W13: membership orders

/** The subscriptions and payments naming a membership order, as Stripe's lists show them. */
type MembershipFound =
  | { kind: 'found'; subscriptions: MadeSubscription[]; intents: Stripe.PaymentIntent[] }
  | { kind: 'unclear'; detail: string }

async function findMembershipParts(run: Run, order: PendingOrder, snapshot: PendingSnapshot): Promise<MembershipFound> {
  const customer = snapshot.stripe_customer_id ?? null
  const subscriptions = await findOrderSubscriptions(run.stripe, run.timing, customer, order.id)
  if (subscriptions.kind === 'unclear') return subscriptions
  const intents = await findIntents(run.stripe, run.timing, { customer, since: order.since, matches: (intent) => intent.metadata?.['order_id'] === order.id })
  if (intents.kind === 'unclear') return intents
  return { kind: 'found', subscriptions: subscriptions.subscriptions, intents: intents.intents }
}

/** Everything a membership order took, from what Stripe shows: each live subscription, each payment that succeeded. */
function takenFrom(snapshot: PendingSnapshot, found: Extract<MembershipFound, { kind: 'found' }>): Taken | { several: string } {
  const live = found.subscriptions.filter((subscription) => subscription.status !== 'canceled')
  if (live.length > 1) return { several: live.map((subscription) => subscription.id).join(', ') }
  const refunds: Array<{ step: RefundStep; paymentIntentId: string }> = []
  for (const subscription of found.subscriptions) {
    if (subscription.invoicePaymentIntentId && subscription.amountPaid > 0) refunds.push({ step: 'refund-subscription', paymentIntentId: subscription.invoicePaymentIntentId })
  }
  for (const intent of found.intents) {
    if (intent.status === 'succeeded') refunds.push({ step: snapshot.method === 'reader' ? 'refund-reader' : 'refund-charge', paymentIntentId: intent.id })
  }
  return { subscriptionId: live[0]?.id ?? null, refunds }
}

async function compensateTheOrder(run: Run, orderId: string, taken: Taken, why: string): Promise<ReconcileItem> {
  try {
    const outcome = await compensateOrder(run.db, run.stripe, orderId, taken, why, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
    if (!outcome.settled) return left('order', orderId, 'compensation_unfinished', outcome.left.join('; '))
    if (outcome.undo.undone) return { kind: 'order', id: orderId, outcome: 'undone', detail: `${why}; put back: ${[taken.subscriptionId, ...taken.refunds.map((r) => r.paymentIntentId)].filter(Boolean).join(', ')}` }
    if (outcome.undo.reason === 'changed_since') return left('order', orderId, 'changed_since', `${why}; ${outcome.undo.changed.join('; ')}`)
    return { kind: 'order', id: orderId, outcome: 'settled_elsewhere', detail: outcome.undo.reason }
  } catch (err) {
    return left('order', orderId, 'compensation_unfinished', err instanceof Error ? err.message : String(err))
  }
}

/**
 * A membership order whose compensation started (the mark is on its record): every step again, under the
 * same keys (Stripe answers a key it has seen with its first answer; a refund already made counts as done),
 * then the undo. Whatever its method.
 */
async function resumeCompensation(run: Run, order: PendingOrder, snapshot: PendingSnapshot): Promise<ReconcileItem> {
  const found = await findMembershipParts(run, order, snapshot)
  if (found.kind === 'unclear') return left('order', order.id, 'unclear', found.detail)
  const taken = takenFrom(snapshot, found)
  if ('several' in taken) return left('order', order.id, 'several_subscriptions', taken.several)
  return compensateTheOrder(run, order.id, taken, `Finishing the compensation: ${snapshot.compensation?.why ?? ''}`)
}

/**
 * W13, a saved-card membership order (W03-plan 2.5's table, with the subscription):
 * - no subscription (in the record's mode) and no payment: nothing was taken, the undo;
 * - the subscription, and the charge if one was due, succeeded: the old subscription cancelled (Q8), then T2;
 * - part done (a subscription but the charge not succeeded, or a subscription not what was asked, or the
 *   old subscription's cancel refused): compensate and undo, never a new charge;
 * - anything processing or unclear: left for the next run.
 */
async function reconcileMembershipCardOrder(run: Run, order: PendingOrder, snapshot: CardSnapshot): Promise<ReconcileItem> {
  const membership = snapshot.membership as NonNullable<CardSnapshot['membership']>
  const found = await findMembershipParts(run, order, snapshot)
  if (found.kind === 'unclear') return left('order', order.id, 'unclear', found.detail)
  const taken = takenFrom(snapshot, found)
  if ('several' in taken) return left('order', order.id, 'several_subscriptions', taken.several)
  if (found.intents.some((intent) => intent.status === 'processing')) return left('order', order.id, 'unclear', 'a payment is still processing at Stripe')

  const subscription = found.subscriptions.find((made) => made.status !== 'canceled') ?? null
  if (!subscription) {
    if (found.subscriptions.length === 0 && found.intents.length === 0 && !sameMode(snapshot.livemode, run.stripe.keyLivemode)) {
      return left('order', order.id, 'other_mode', `the record's mode ${String(snapshot.livemode)}, the key's ${String(run.stripe.keyLivemode)}`)
    }
    if (taken.refunds.length === 0) {
      // Nothing was taken: any payment still open is cancelled first (as for a card order), then the undo.
      const open = await settleFound(run.stripe, run.timing, found.intents.filter((intent) => intent.status !== 'succeeded'))
      if (open.kind !== 'none') return left('order', order.id, open.kind === 'unclear' ? 'unclear' : open.kind === 'several' ? 'several_payments' : 'unclear', open.kind === 'unclear' ? open.detail : undefined)
      return undoTheOrder(run, order.id, 'Stripe has no subscription or payment for this membership order')
    }
    return compensateTheOrder(run, order.id, taken, 'Money was taken for this membership order but its subscription is not live')
  }
  const wrong = subscriptionMismatch(subscription, order.id, snapshot.stripe_customer_id, membership)
  if (wrong) return compensateTheOrder(run, order.id, taken, `Its subscription is not what was asked: ${wrong}`)

  let paid: Stripe.PaymentIntent | null = null
  if (pence(snapshot.expected_amount) > 0) {
    const succeeded = found.intents.filter((intent) => intent.status === 'succeeded')
    if (succeeded.length > 1) return left('order', order.id, 'several_payments', succeeded.map((intent) => intent.id).join(', '))
    paid = succeeded[0] ?? null
    if (!paid) {
      // Part done: the subscription yes, the charge no. Reconcile never sends a charge (W03-plan 2.5).
      const open = await settleFound(run.stripe, run.timing, found.intents)
      if (open.kind === 'unclear') return left('order', order.id, 'unclear', open.detail)
      if (open.kind === 'succeeded') {
        paid = open.paymentIntent
        // W13b (W13a N1): it succeeded during this run's cancel attempt, after `taken` was read from the
        // list, so it is added here: a later refusal (Q8's cancel, the check, T2) then refunds it too.
        const charge = paid.id
        if (!taken.refunds.some((refund) => refund.paymentIntentId === charge)) taken.refunds.push({ step: 'refund-charge', paymentIntentId: charge })
      } else return compensateTheOrder(run, order.id, taken, 'Part done: the subscription was made but the card was never charged')
    }
  }

  // W13a (L1): T2's definite checks before Q8's cancel, so a refusal can't follow a confirmed cancel.
  let oldCancelled = false
  if (snapshot.exhausted_membership_stripe_id) {
    let ready: Awaited<ReturnType<typeof membershipPrecheck>>
    try {
      ready = await membershipPrecheck(run.db, order.id, subscription)
    } catch (err) {
      return left('order', order.id, 'finalise_failed', err instanceof Error ? err.message : String(err))
    }
    if (ready.kind === 'refused') return compensateTheOrder(run, order.id, taken, `T2 would refuse the membership (checked before Q8): ${ready.reason}`)
    if (ready.kind === 'ready') {
      const cancelled = await cancelSubscriptionChecked(run.stripe, snapshot.exhausted_membership_stripe_id, run.timing)
      if (cancelled.kind === 'refused') return compensateTheOrder(run, order.id, taken, `The old subscription's cancel was refused: ${cancelled.message}`)
      if (cancelled.kind === 'unclear') return left('order', order.id, 'replaced_unconfirmed', cancelled.message)
      oldCancelled = true
    }
    // Not pending any more (settled elsewhere): no Q8; T2 answers for it below.
  }
  try {
    // W13d (W13c review S-2): the subscription it found is passed as made here, so if another actor undoes the order
    // between this run's list and T2, T2 records it as left and the next run's retry puts it back (the charge is
    // T2's `order.charge_without_order`, for the late refund).
    const outcome = await finaliseOrder(run.db, order.id, paid, { actor: run.options.actor, requestId: run.options.requestId, subscription, subscriptionMadeHere: true })
    if (outcome.finalised) return outcome.alreadyPaid ? { kind: 'order', id: order.id, outcome: 'settled_elsewhere', detail: 'paid' } : { kind: 'order', id: order.id, outcome: 'finalised', detail: subscription.id }
    if (MEMBERSHIP_DEFINITE.has(outcome.reason)) {
      return compensateTheOrder(run, order.id, taken, `T2 refused the membership: ${outcome.reason}${oldCancelled ? `. ${OLD_MEMBERSHIP_CANCELLED_NOTE}` : ''}`)
    }
    return left('order', order.id, outcome.reason === 'order_gone' ? 'charged_without_order' : outcome.reason, subscription.id)
  } catch (err) {
    return left('order', order.id, 'finalise_failed', err instanceof Error ? err.message : String(err))
  }
}

/** W13: a reader membership order: its subscription found first, so a finalise (cancel's "finalise instead") never starts one. */
async function subscriptionFoundFor(run: Run, order: PendingOrder, snapshot: ReaderSnapshot): Promise<{ found: MadeSubscription | null } | { unclear: string } | { several: string }> {
  const listed = await findOrderSubscriptions(run.stripe, run.timing, snapshot.stripe_customer_id ?? null, order.id)
  if (listed.kind === 'unclear') return { unclear: listed.detail }
  const live = listed.subscriptions.filter((subscription) => subscription.status !== 'canceled')
  if (live.length > 1) return { several: live.map((subscription) => subscription.id).join(', ') }
  return { found: live[0] ?? null }
}

async function reconcileOrder(run: Run, order: PendingOrder): Promise<ReconcileItem> {
  const snapshot = order.reader_payment
  if (snapshot.compensation) return resumeCompensation(run, order, snapshot)
  if (snapshot.method === 'card' && snapshot.membership) return reconcileMembershipCardOrder(run, order, snapshot)
  if (snapshot.method === 'card') return reconcileCardOrder(run, order, snapshot)
  if (typeof snapshot.payment_intent_id === 'string') return reconcileReaderOrder(run, order, snapshot as ReaderSnapshot & { payment_intent_id: string })
  return reconcileHeldReaderOrder(run, order, snapshot)
}

// --- Orders the old screens moved out of pending (W12a, W12 review S1)

interface ChangedOrder {
  id: string
  payment_status: string
  since: string
  reader_payment: PendingSnapshot
}

/** What the intents found for the order add up to (changed-elsewhere.ts says what each state means). */
function findingOf(intents: Stripe.PaymentIntent[], snapshot: PendingSnapshot, keyLivemode: boolean | null): ChangedElsewhereFinding {
  const paymentIntentIds = intents.map((intent) => intent.id)
  const succeeded = intents.filter((intent) => intent.status === 'succeeded')
  if (succeeded.length > 0) return { state: 'taken', amount: succeeded.reduce((sum, intent) => sum + intent.amount_received, 0), paymentIntentIds }
  if (intents.some((intent) => intent.status === 'processing')) return { state: 'unclear', amount: 0, paymentIntentIds }
  if (intents.some((intent) => intent.status !== 'canceled')) return { state: 'open', amount: 0, paymentIntentIds }
  if (intents.length === 0 && !sameMode(snapshot.livemode, keyLivemode)) return { state: 'other_mode', amount: 0, paymentIntentIds }
  return { state: 'nothing_taken', amount: 0, paymentIntentIds }
}

/**
 * A Worker order the old screens moved out of pending (the old Cancel & Refund, say) without T2 or the undo:
 * the customer's intents naming it (`metadata.order_id`, listed exactly as for a held order), and what they
 * show is recorded for a person. Read only: nothing is cancelled, refunded, finalised or undone, and the
 * order isn't touched. A final finding (taken, nothing taken) isn't looked for again.
 */
async function readChangedElsewhere(run: Run, order: ChangedOrder): Promise<ReconcileItem> {
  const snapshot = order.reader_payment
  const found = await findIntents(run.stripe, run.timing, { customer: snapshot.stripe_customer_id ?? null, since: order.since, matches: (intent) => intent.metadata?.['order_id'] === order.id })
  const finding: ChangedElsewhereFinding = found.kind === 'unclear' ? { state: 'unclear', amount: 0, paymentIntentIds: [] } : findingOf(found.intents, snapshot, run.stripe.keyLivemode)
  const detail = `the order is ${order.payment_status}; Stripe: ${finding.state}${finding.state === 'taken' ? ` £${(finding.amount / 100).toFixed(2)}` : ''}${found.kind === 'unclear' ? ` (${found.detail})` : ''}`
  return { ...left('order', order.id, CHANGED_ELSEWHERE, detail), finding }
}

// --- Flows

async function reconcileFlow(run: Run, row: FlowRow): Promise<ReconcileItem> {
  // W14b (W12-6, W12a N1 for flows): the run's own deadline, not the press's 30 s, as its orders already do.
  const routeOptions = {
    actor: run.options.actor,
    requestId: run.options.requestId,
    ...(run.timing ? { timing: run.timing } : {}),
  }
  if (typeof row.payment_intent_id === 'string') {
    const answer = await cancelReaderFlow(run.db, run.stripe, row.id, routeOptions)
    if (answer.cancelled) return answer.alreadyDone ? { kind: 'flow', id: row.id, outcome: 'settled_elsewhere', detail: 'cancelled' } : { kind: 'flow', id: row.id, outcome: 'undone', ...(answer.warning ? { warning: answer.warning } : {}) }
    if (answer.finaliseResult) {
      const result = answer.finaliseResult
      if (result.finalised) return result.alreadyFinalised ? { kind: 'flow', id: row.id, outcome: 'settled_elsewhere', detail: 'finalised' } : { kind: 'flow', id: row.id, outcome: 'finalised', detail: result.paymentIntentId ?? row.payment_intent_id }
      return left('flow', row.id, result.reason ?? 'finalise_failed', result.message)
    }
    if (answer.reason === 'already_finalised') return { kind: 'flow', id: row.id, outcome: 'settled_elsewhere', detail: 'finalised' }
    if (answer.reason === 'stripe_error') return left('flow', row.id, answer.message === otherModeMessage(row.payment_intent_id) ? 'other_mode' : 'unclear', answer.message)
    if (answer.reason === 'undo_incomplete') return left('flow', row.id, 'undo_failed', answer.message)
    return left('flow', row.id, answer.reason ?? 'unclear', answer.message)
  }

  // Held with no intent on its row: the intents naming the row (`metadata.pending_id`, which step D's flow
  // intent carries), cancelled unless one succeeded, then the flow's undo.
  const customer = row.snapshot.stripe_customer_id ?? null
  const found = await findIntents(run.stripe, run.timing, { customer, since: row.created_at, matches: (intent) => intent.metadata?.['pending_id'] === row.id })
  if (found.kind === 'unclear') return left('flow', row.id, 'unclear', found.detail)
  if (found.intents.length === 0 && !sameMode(row.snapshot.livemode, run.stripe.keyLivemode)) return left('flow', row.id, 'other_mode')
  const settled = await settleFound(run.stripe, run.timing, found.intents)
  if (settled.kind === 'unclear') return left('flow', row.id, 'unclear', settled.detail)
  if (settled.kind === 'several') return left('flow', row.id, 'several_payments')
  try {
    if (settled.kind === 'succeeded') {
      const outcome = await finaliseFlowInTransaction(run.db, row.id, settled.paymentIntent, run.options)
      if (outcome.finalised) return outcome.alreadyFinalised ? { kind: 'flow', id: row.id, outcome: 'settled_elsewhere', detail: 'finalised' } : { kind: 'flow', id: row.id, outcome: 'finalised', detail: settled.paymentIntent.id }
      return left('flow', row.id, outcome.reason, settled.paymentIntent.id)
    }
    const undone = await undoFlowInTransaction(run.db, row.id, { ...run.options, why: 'Stripe has no reader payment for this change (its intent was never written down)' })
    if (undone.undone) return { kind: 'flow', id: row.id, outcome: 'undone', ...(undone.problems.length > 0 ? { warning: undone.problems.join('; ') } : {}) }
    return { kind: 'flow', id: row.id, outcome: 'settled_elsewhere', detail: undone.reason }
  } catch (err) {
    return left('flow', row.id, settled.kind === 'succeeded' ? 'finalise_failed' : 'undo_failed', err instanceof Error ? err.message : String(err))
  }
}

// --- The automatic refund of a late payment (W03-decisions, "W12 calls")

export interface LateRefundDue {
  entity_type: 'order' | 'reader_payment'
  entity_id: string
  payment_intent_id: string
  /** The last `order.reconcile` refund row for it, if any. */
  state: { refund?: { state?: string; refundId?: string } } | null
}

/**
 * Payments that succeeded on an order or flow already undone (T2 recorded each: `order.charge_without_order`,
 * `reader_payment.charge_without_record`) and whose refund isn't settled yet. Settled means Stripe confirmed
 * it, or it failed and is listed for a person.
 */
export const LATE_REFUNDS_DUE_SQL = `
WITH charged AS (
  SELECT a.entity_type, a.entity_id, a.details->>'paymentIntentId' AS payment_intent_id, min(a.at) AS first_at
  FROM audit_log a
  WHERE a.action IN ('order.charge_without_order', 'reader_payment.charge_without_record')
  GROUP BY 1, 2, 3
),
latest AS (
  SELECT DISTINCT ON (r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId')
         r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId' AS payment_intent_id, r.details AS state
  FROM audit_log r
  WHERE r.action = 'order.reconcile' AND r.details ? 'refund'
  -- A refund's state only moves forward (started, sent, then confirmed or failed), so two rows stamped in
  -- the same millisecond are told apart by it.
  ORDER BY r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId', r.at DESC,
           CASE r.details->'refund'->>'state' WHEN 'confirmed' THEN 3 WHEN 'failed' THEN 3 WHEN 'sent' THEN 2 ELSE 1 END DESC
)
SELECT c.entity_type, c.entity_id, c.payment_intent_id, l.state
FROM charged c
LEFT JOIN latest l ON l.entity_type = c.entity_type AND l.entity_id = c.entity_id AND l.payment_intent_id = c.payment_intent_id
WHERE l.state IS NULL OR l.state->'refund'->>'state' NOT IN ('confirmed', 'failed')
ORDER BY c.first_at`

/** What a late payment's refund says it is for, in its metadata. */
const LATE_REFUND_REASON = 'paid_after_undone'

/** The refund's key: `<orderId>:refund-charge` (a saved card) or `:refund-reader`, or the flow's row id's. */
function refundKey(due: LateRefundDue, paymentIntent: Stripe.PaymentIntent): string {
  const reader = due.entity_type === 'reader_payment' || Boolean(paymentIntent.metadata?.['flow'])
  return stripeIdempotencyKey(due.entity_id, reader ? 'refund-reader' : 'refund-charge')
}

/**
 * Refunds a late payment in full, once: the refund's row is written (and committed) before it is sent,
 * under the key built from the order's (or flow's) id, so a second send, from this run or the next, is
 * Stripe's same refund. Stripe's answer: succeeded, confirmed; pending, listed until a later run sees it
 * succeed; failed or refused, listed for a person; unclear, sent again next run with the same key. A
 * refund already made by hand (`charge_already_refunded`) counts as confirmed.
 */
async function settleLateRefund(run: Run, due: LateRefundDue): Promise<ReconcileItem> {
  const id = due.entity_id
  const item = (outcome: ItemOutcome, reason?: string, detail?: string): ReconcileItem => ({ kind: 'refund', id, outcome, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) })
  const refundState = due.state?.refund
  const base = { paymentIntentId: due.payment_intent_id }

  // Sent before, Stripe said pending: has it landed?
  if (refundState?.state === 'sent' && refundState.refundId) {
    let listed: Stripe.Refund | undefined
    try {
      listed = (await run.stripe.refunds.list({ payment_intent: due.payment_intent_id, limit: 100 }, sendOptions(run.timing))).data.find((refund) => refund.id === refundState.refundId)
    } catch (err) {
      return item('refund_pending', 'unclear', readStripeFailure(err).message)
    }
    if (listed?.status === 'succeeded') {
      await run.recordRefund(due.entity_type, id, { outcome: 'refund_confirmed', refund: { ...base, state: 'confirmed', refundId: listed.id, amount: listed.amount } })
      return item('refund_confirmed')
    }
    if (listed && (listed.status === 'failed' || listed.status === 'canceled')) {
      await run.recordRefund(due.entity_type, id, { outcome: 'refund_failed', refund: { ...base, state: 'failed', refundId: listed.id, status: listed.status } })
      return item('refund_failed', 'refund_failed')
    }
    return item('refund_pending', 'refund_pending')
  }

  let paymentIntent: Stripe.PaymentIntent
  try {
    paymentIntent = await run.stripe.paymentIntents.retrieve(due.payment_intent_id, undefined, sendOptions(run.timing))
  } catch (err) {
    return item('refund_pending', 'unclear', readStripeFailure(err).message)
  }
  const key = refundKey(due, paymentIntent)
  // W13a (B1's side effect): a membership order's compensation refunds a payment under this same key
  // (`<orderId>:refund-reader`, `:refund-charge`) with its own parameters, so this refund, sent with its own,
  // would be refused for the key ("Keys for idempotent requests can only be used with the same parameters")
  // until Stripe forgets it. A refund already made under the key with other parameters counts as this one:
  // done, as `charge_already_refunded` is; pending, listed until Stripe confirms it, as this one would be. (One
  // of this path's own, sent before with no clear answer, is sent again: Stripe answers it with that refund.)
  if (due.entity_type === 'order') {
    let earlier: Stripe.Refund | undefined
    try {
      earlier = (await run.stripe.refunds.list({ payment_intent: due.payment_intent_id, limit: 100 }, sendOptions(run.timing))).data.find(
        (refund) => refund.metadata?.['refund_key'] === key && refund.metadata?.['reason'] !== LATE_REFUND_REASON
      )
    } catch (err) {
      return item('refund_pending', 'unclear', readStripeFailure(err).message)
    }
    if (earlier?.status === 'succeeded') {
      await run.recordRefund(due.entity_type, id, { outcome: 'refund_confirmed', refund: { ...base, state: 'confirmed', key, refundId: earlier.id, amount: earlier.amount, alreadyRefunded: true } })
      return item('refund_confirmed', undefined, 'already refunded under its key')
    }
    if (earlier && (earlier.status === 'failed' || earlier.status === 'canceled')) {
      await run.recordRefund(due.entity_type, id, { outcome: 'refund_failed', refund: { ...base, state: 'failed', key, refundId: earlier.id, status: earlier.status } })
      return item('refund_failed', 'refund_failed')
    }
    if (earlier) {
      await run.recordRefund(due.entity_type, id, { outcome: 'refund_pending', refund: { ...base, state: 'sent', key, refundId: earlier.id, status: earlier.status } })
      return item('refund_pending', 'refund_pending')
    }
  }
  if (!refundState) {
    // Written first, and committed, before anything is sent; once, however many runs get here together.
    await recordStartedOnce(run, due, { outcome: 'refund_started', refund: { ...base, state: 'started', key, amount: paymentIntent.amount_received } })
  }
  let refund: Stripe.Refund
  try {
    refund = await run.stripe.refunds.create(
      { payment_intent: due.payment_intent_id, metadata: { refund_key: key, [due.entity_type === 'order' ? 'order_id' : 'pending_id']: id, reason: LATE_REFUND_REASON } },
      sendOptions(run.timing, { idempotencyKey: key })
    )
  } catch (err) {
    const failure = readStripeFailure(err)
    if (failure.code === 'charge_already_refunded') {
      await run.recordRefund(due.entity_type, id, { outcome: 'refund_confirmed', refund: { ...base, state: 'confirmed', key, alreadyRefunded: true } })
      return item('refund_confirmed', undefined, 'already refunded')
    }
    if (failure.outcome === 'definite' && !(err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError)) {
      await run.recordRefund(due.entity_type, id, { outcome: 'refund_failed', refund: { ...base, state: 'failed', key, message: failure.message, code: failure.code } })
      return item('refund_failed', 'refund_failed', failure.message)
    }
    return item('refund_pending', 'unclear', failure.message)
  }
  if (refund.status === 'succeeded') {
    await run.recordRefund(due.entity_type, id, { outcome: 'refund_confirmed', refund: { ...base, state: 'confirmed', key, refundId: refund.id, amount: refund.amount } })
    return item('refund_confirmed')
  }
  if (refund.status === 'failed' || refund.status === 'canceled') {
    await run.recordRefund(due.entity_type, id, { outcome: 'refund_failed', refund: { ...base, state: 'failed', key, refundId: refund.id, status: refund.status } })
    return item('refund_failed', 'refund_failed')
  }
  await run.recordRefund(due.entity_type, id, { outcome: 'refund_pending', refund: { ...base, state: 'sent', key, refundId: refund.id, status: refund.status } })
  return item('refund_pending', 'refund_pending')
}

/**
 * The refund's first row, written once: two runs at once (the schedule and a staff press) queue on an
 * advisory lock for the payment, and the second, reading after the first commits, finds the row there.
 * Two statements, so the read after the lock has a snapshot that sees the first run's row.
 */
async function recordStartedOnce(run: Run, due: LateRefundDue, details: Record<string, unknown>): Promise<void> {
  await run.db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`late-refund:${due.payment_intent_id}`])
    const there = await tx.query(
      `SELECT 1 FROM audit_log
       WHERE action = 'order.reconcile' AND entity_type = $1 AND entity_id = $2
         AND details->'refund'->>'paymentIntentId' = $3 AND details->'refund'->>'state' = 'started'`,
      [due.entity_type, due.entity_id, due.payment_intent_id]
    )
    if (there.length > 0) return
    await audit.recordAll(tx, [run.refundEntry(due.entity_type, due.entity_id, details)])
  })
}

// --- A subscription a press left live (W13c, W13a review L3)

/**
 * The stuck list's open put-back warnings, for orders that no longer exist (undone, so gone). One on an order still
 * pending is its compensation's: that lists Stripe, cancels it with the rest and, once done, closes the warning;
 * if it stays open after that (the cancel went through but its answer was lost), it is retried here once the order
 * is gone. W13d (W13c review L3): gone only. An order that still exists in any state (paid, or otherwise not
 * pending) is never retried here, so a paying member's subscription can never be cancelled or its first invoice
 * refunded by this retry; its warning stays for a person (the manual close, W14). Oldest first.
 * W14b (W13c review L4): a row whose last answer was a definite refusal (`refused`) is not retried, only listed until
 * a person closes it; and the retries come last in a run, after the orders and flows, so they never starve them.
 */
const SUBSCRIPTIONS_LEFT_DUE_SQL = `
SELECT l.entity_id, l.subscription_id, l.invoice_payment_intent_id, l.amount_paid
FROM (${SUBSCRIPTIONS_LEFT_SQL}) l
WHERE l.state = 'left' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = l.entity_id)
ORDER BY l.at, l.entity_id`

async function retryPutBack(run: Run, due: LeftSubscription): Promise<ReconcileItem> {
  const retried = await retryLeftSubscription(run.db, run.stripe, due, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
  if (retried.kind === 'cancelled') {
    const refunded = retried.refunded.map((refund) => refund.paymentIntentId)
    return { kind: 'order', id: due.orderId, outcome: 'undone', detail: `subscription ${due.subscriptionId} put back: cancelled${refunded.length > 0 ? `, its first invoice ${refunded.join(', ')} refunded` : ''}` }
  }
  if (retried.kind === 'not_this_order') return left('order', due.orderId, 'subscription_not_this_order', retried.detail)
  if (retried.kind === 'refused') return left('order', due.orderId, 'subscription_refused', retried.left.join('; '))
  return left('order', due.orderId, 'subscription_left', retried.left.join('; '))
}

// --- Reading what is due

const ORDERS_DUE_SQL = `
SELECT o.id, o.customer_id, o.reader_payment,
       COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) AS since
FROM orders o
WHERE o.payment_status = 'pending' AND o.reader_payment IS NOT NULL
  AND o.reader_payment->>'method' IN ('card', 'reader')
  AND COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) < now() - make_interval(mins => $1::int)
ORDER BY since, o.id`

/** W12a (S1): changed-elsewhere.ts's orders, less those with a final finding already recorded. Oldest first. */
const CHANGED_ELSEWHERE_DUE_SQL = `
SELECT o.id, o.payment_status, o.reader_payment,
       COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) AS since
FROM orders o
WHERE ${CHANGED_ELSEWHERE_WHERE}
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.entity_type = 'order' AND f.entity_id = o.id::text AND f.action = 'order.reconcile'
      AND f.details->>'reason' = '${CHANGED_ELSEWHERE}' AND f.details->'finding'->>'state' IN (${FINAL_FINDINGS.map((state) => `'${state}'`).join(', ')})
  )
ORDER BY since, o.id`

const FLOWS_DUE_SQL = `
SELECT id FROM pending_reader_payments
WHERE status = 'pending' AND snapshot->>'method' = 'reader' AND (snapshot->>'request_id') IS NOT NULL
  AND created_at < now() - make_interval(mins => $1::int)
ORDER BY created_at, id`

const OLD_DUE_SQL = `
SELECT
  (SELECT count(*)::int FROM orders
   WHERE payment_status = 'pending' AND reader_payment IS NOT NULL
     AND (reader_payment->>'method') IS DISTINCT FROM 'card' AND (reader_payment->>'method') IS DISTINCT FROM 'reader'
     AND COALESCE((reader_payment->>'created_at')::timestamptz, created_at) < now() - make_interval(mins => $1::int)) AS orders,
  (SELECT count(*)::int FROM pending_reader_payments
   WHERE status = 'pending' AND NOT (snapshot->>'method' = 'reader' AND (snapshot->>'request_id') IS NOT NULL)
     AND created_at < now() - make_interval(mins => $2::int)) AS flows`

/** What makes a left item's row worth writing again: its reason, and for a changed-elsewhere order its finding (W12a). */
const leftKey = (reason: string | undefined, finding: Partial<ChangedElsewhereFinding> | undefined): string => `${reason ?? ''}|${finding?.state ?? ''}|${finding?.amount ?? ''}`

/**
 * The latest reconcile row for an entity that isn't a refund's: so a left item is recorded once per reason
 * (and per finding), not every run.
 */
async function lastLeft(db: Db, entityType: string, entityId: string): Promise<string | null> {
  const row = (
    await db.query<{ details: { outcome?: string; reason?: string; finding?: Partial<ChangedElsewhereFinding> } }>(
      `SELECT details FROM audit_log WHERE entity_type = $1 AND entity_id = $2 AND action = 'order.reconcile' AND NOT (details ? 'refund')
       ORDER BY at DESC LIMIT 1`,
      [entityType, entityId]
    )
  )[0]
  return row?.details.outcome === 'left' ? leftKey(row.details.reason, row.details.finding) : null
}

/**
 * One run. Oldest first: the late refunds (money owed to a customer comes first), then the orders, then
 * the flows, then (W14b) the left put-backs; bounded by `maxItems` and `budgetMs` (whatever is over waits for the next run). A key Stripe
 * refuses stops the run with one alert row. Each item is independent: one failing never stops the rest.
 */
export async function reconcile(db: Db, stripeClient: StripeClient, options: ReconcileOptions): Promise<ReconcileResult> {
  const now = options.now ?? Date.now
  const started = now()
  const timing =
    options.startedAt === undefined
      ? undefined
      : { ...stripeTiming(options.startedAt, now), deadline: options.startedAt + (options.stripeDeadlineMs ?? STRIPE_DEADLINE_MS) }
  const watched = watchForRefusedKey(stripeClient)
  const window = options.windowMinutes ?? RECONCILE_WINDOW_MINUTES
  const run: Run = {
    db,
    stripe: watched.client,
    timing,
    options,
    async record(entityType, entityId, details) {
      await db.transaction((tx) =>
        audit.recordAll(tx, [{ actorType: options.actor.type, actorId: options.actor.id, action: 'order.reconcile', entityType, entityId, requestId: options.requestId, details }])
      )
    },
    refundEntry: (entityType, entityId, details) => ({
      actorType: 'system',
      actorId: null,
      action: 'order.reconcile',
      entityType,
      entityId,
      requestId: options.requestId,
      details: options.actor.type === 'system' ? details : { ...details, runBy: { type: options.actor.type, id: options.actor.id } },
    }),
    async recordRefund(entityType, entityId, details) {
      await db.transaction((tx) => audit.recordAll(tx, [run.refundEntry(entityType, entityId, details)]))
    },
  }

  const refunds = await db.query<LateRefundDue>(LATE_REFUNDS_DUE_SQL)
  const putBacks = await db.query<{ entity_id: string; subscription_id: string; invoice_payment_intent_id: string | null; amount_paid: number | null }>(SUBSCRIPTIONS_LEFT_DUE_SQL)
  const orders = await db.query<PendingOrder>(ORDERS_DUE_SQL, [window])
  const changed = await db.query<ChangedOrder>(CHANGED_ELSEWHERE_DUE_SQL, [window, CHANGED_ELSEWHERE_DAYS])
  const flows = await db.query<{ id: string }>(FLOWS_DUE_SQL, [window])
  const old = (await db.query<{ orders: number; flows: number }>(OLD_DUE_SQL, [window, window]))[0] ?? { orders: 0, flows: 0 }

  const work: Array<{ kind: ReconcileItem['kind']; id: string; go: () => Promise<ReconcileItem> }> = [
    ...refunds.map((due) => ({ kind: 'refund' as const, id: due.entity_id, go: () => settleLateRefund(run, due) })),
    ...orders.map((order) => ({ kind: 'order' as const, id: order.id, go: () => reconcileOrder(run, order) })),
    ...changed.map((order) => ({ kind: 'order' as const, id: order.id, go: () => readChangedElsewhere(run, order) })),
    ...flows.map((flow) => ({
      kind: 'flow' as const,
      id: flow.id,
      go: async () => {
        // Read again: an earlier item, or another run, may have settled it.
        const row = await readFlow(db, flow.id)
        if (!row || row.status !== 'pending') return { kind: 'flow' as const, id: flow.id, outcome: 'settled_elsewhere' as const, detail: row?.status ?? 'gone' }
        return reconcileFlow(run, row)
      },
    })),
    // W13c (L3): a subscription left live, which Stripe would bill again next month. W14b (W13c review L4): last, so
    // a row that never settles can't keep a run from the pending orders and flows.
    ...putBacks.map((due) => ({
      kind: 'order' as const,
      id: due.entity_id,
      go: () =>
        retryPutBack(run, { orderId: due.entity_id, subscriptionId: due.subscription_id, invoicePaymentIntentId: due.invoice_payment_intent_id, amountPaid: due.amount_paid }),
    })),
  ]

  const result: ReconcileResult = { checked: 0, finalised: 0, undone: 0, refunds: 0, left: 0, deferred: 0, oldLeftAlone: old, stripeRefused: false, items: [] }
  for (const [index, next] of work.entries()) {
    if (result.checked >= options.maxItems || now() - started >= options.budgetMs) {
      result.deferred = work.length - index
      break
    }
    result.checked += 1
    let item: ReconcileItem
    try {
      item = await next.go()
    } catch (err) {
      item = left(next.kind, next.id, 'unexpected', err instanceof Error ? err.message : String(err))
    }
    const refused = watched.refused()
    if (refused) {
      // The key itself: every item would meet it. Nothing more is tried; one alert row says so. An item
      // that did something before meeting it (W12a L6: a swallowed card read after the payment was found,
      // then T2) keeps its row; one that did nothing is counted as waiting.
      result.stripeRefused = true
      const acted = item.kind !== 'refund' && (item.outcome === 'finalised' || item.outcome === 'undone')
      if (acted) {
        await run.record(item.kind === 'order' ? 'order' : 'reader_payment', item.id, { outcome: item.outcome, detail: item.detail ?? null, ...(item.warning ? { warning: item.warning } : {}) })
        if (item.outcome === 'finalised') result.finalised += 1
        if (item.outcome === 'undone') result.undone += 1
        result.items.push(item)
      } else {
        result.checked -= 1
      }
      result.deferred = acted ? work.length - index - 1 : work.length - index
      await db.transaction((tx) =>
        audit.recordAll(tx, [{
          actorType: options.actor.type,
          actorId: options.actor.id,
          action: 'reconcile.stripe_refused',
          entityType: 'reconcile',
          entityId: options.requestId,
          requestId: options.requestId,
          details: { status: refused.status, message: refused.message, waiting: result.deferred },
        }])
      )
      break
    }
    if (item.kind !== 'refund') {
      const entityType = item.kind === 'order' ? 'order' : 'reader_payment'
      if (item.outcome === 'left') {
        // W13a (S3): on a staff run past its Stripe deadline, the row is written without first reading the last
        // one (a read outside a transaction, bounded only by the client's 10 s), so the run stays 10 s inside
        // Retool's 60 s; at worst a reason already recorded is recorded again.
        const pastDeadline = timing !== undefined && now() >= timing.deadline
        if (pastDeadline || (await lastLeft(db, entityType, item.id)) !== leftKey(item.reason, item.finding)) {
          await run.record(entityType, item.id, { outcome: 'left', reason: item.reason, detail: item.detail ?? null, ...(item.finding ? { finding: item.finding } : {}) })
        }
      } else if (item.outcome !== 'settled_elsewhere') {
        await run.record(entityType, item.id, { outcome: item.outcome, detail: item.detail ?? null, ...(item.warning ? { warning: item.warning } : {}) })
      }
    }
    if (item.outcome === 'finalised') result.finalised += 1
    if (item.outcome === 'undone') result.undone += 1
    if (item.outcome.startsWith('refund_')) result.refunds += 1
    if (item.outcome === 'left' || item.outcome === 'refund_failed' || item.outcome === 'refund_pending') result.left += 1
    result.items.push(item)
  }
  return result
}
