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
// W19 (W17 review S1): saved-card flows (Settle first). Never charged here: the customer's payments are listed and
// matched by `metadata.pending_id` (reconcileCardFlow), then C2 or the undo, or left held.
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
// W21 (D-plan 4.10): booking refund claims (server/rules/bookings/refunds.ts) a press left held (a card refund with no
// clear answer, or one that went and couldn't be recorded). Never sends a refund: it lists the refunds on each planned
// PaymentIntent, matches `metadata.claim_id`, and runs the claim's R2 with what it found; a part Stripe never received
// ends as money owed on the booking, live or cancelled (W26b: never store credit; Refund the rest or It already arrived).
//
// W28 (E-plan 4.9): an order refund's claim (server/rules/orders/refund-lines.ts) is settled the same way: its one card
// part looked for by `metadata.claim_id`, never sent; found, R2; not found or refused, the money owed on the order.
// W30: and an event booking's claim (server/rules/events/cancel-places.ts), whose card part is on the order that paid
// for the booking: found, R2; not found or refused, the places stay cancelled and the money is owed on that order.
//
// W32 (lead call L7): a card refund Stripe answered `pending` (a finished claim's, or a compensation's) is read each
// run until it ends (refund-watch-settle.ts): succeeded ends the watch; failed or cancelled puts its money back as owed
// on its booking or order (or, with nothing to owe it on, lists it for a person); 30 days ends the watch for a person.
// Never a send. A watched payment's automatic refund is keyed by its own PaymentIntent (audit row 30).
// W32a (lead calls 1 and 2; W32 review S1 to S4): every card refund is watched for 50 days, `succeeded` ones read once a
// day; the due list picks the ones read longest ago, inside the run's budget; a read that ends nothing is not an item
// and is counted nowhere (`refundsWaiting` says how many are still on their way); a late payment's automatic refund is
// handed to the same watch once Stripe has given it an id; and a late refund keeps the key its `started` row recorded.
//
// W41 (F-plan 4.4 and 4.10): a payment date change still pending past the window (reconcilePaymentDateChange). Never
// charges: the customer's payments are listed and matched by `metadata.change_id`. None: the change is ended. One
// paid: the subscription is read, and the date already as asked means P2; else the date move is sent again (it sets
// a value, so it is safe to repeat) and, if Stripe refuses it, the charge is refunded once under its key and watched.
// W41a (W41 review B1 to B3): before the move is sent again the press's checks on the subscription are run again,
// and a failure (Stripe has renewed it since, say) refunds the charge instead; a refund reconcile sends goes under a
// key of the run's own; and a refund on the payment is the change's own only when its metadata names the change.
//
// W47r ("Try the payment again now"): a past-due membership's payment tried again from the desk and still open
// (reconcilePaymentRetry; memberships/retry-payment.ts, settlePaymentRetry). It only reads: the invoice and
// its payment. Paid: the webhook's own `invoice.paid` write, and the record ends. Not paid with nothing still going:
// the record ends, nothing taken. A payment still at the bank or waiting on the customer: left, for as long as it
// takes. Never a send of any kind. W47r-a: a record is read as soon as the press has written its `held` row, without
// waiting for the window (a payment that went through is recorded at the next run, before the lapse sweep can take
// the member's bookings); inside the window it is never ended as not taken. Paid after the subscription had ended:
// left for a person (`paid_after_end`), who refunds it in Stripe and presses Mark refunded (close-stuck.ts).
// W47r-c: paid BEFORE the subscription ended (the write's own time rule) was owed: the record ends paid.
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
import type { CancelReaderOrderOutput, FinaliseReaderOrderOutput } from '@/contracts'
import { readStripeFailure } from '@/server/stripe/outcome'
import { CHANGED_ELSEWHERE, CHANGED_ELSEWHERE_DAYS, CHANGED_ELSEWHERE_WHERE, FINAL_FINDINGS, type ChangedElsewhereFinding } from './changed-elsewhere'
import { OLD_MEMBERSHIP_CANCELLED_NOTE } from './failure-messages'
import { sendCardSteps } from '@/server/rules/customers/card-steps'
import { finaliseOrder, MEMBERSHIP_DEFINITE, membershipPrecheck, type FinaliseOptions, type FinaliseOutcome } from './finalise-order'
import { pence } from './collect-saved-card'
import {
  balanceToPutBack,
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
import {
  cancelReaderFlow,
  finaliseFlowInTransaction,
  FLOW_CHARGE_WITHOUT_RECORD,
  FLOW_PAYMENT_WATCHED,
  FlowUndoBlocked,
  isWorkerCardFlow,
  readFlow,
  undoFlowInTransaction,
  type FlowRow,
} from './reader-flow'
import { cancelReaderOrder, finaliseReaderOrderFound, otherModeMessage, settleIntent, type ReaderRouteOptions } from './reader-order'
import { undoOrder } from './undo-order'
import { CLAIMS_DUE_SQL, claimRefusal, findCardPart, finishClaim, readClaim, type CardPart, type Claim } from '@/server/rules/bookings/refunds'
import { finishEventClaim } from '@/server/rules/events/cancel-places'
import { EVENT_BOOKING_CLAIMS_DUE_SQL, ORDER_CLAIMS_DUE_SQL, readEventBookingClaim, readOrderClaim, stepEClaimRefusal, type EventBookingClaim, type OrderClaim } from '@/server/rules/refunds/claims'
import { finishOrderClaim } from './refund-lines'
import { refundSeen, WATCH_DAYS, WATCH_READ_HOURS, WATCHES_DUE_SQL, WATCHES_WAITING_SQL, watchLateRefund, type RefundSeen, type WatchDue } from '@/server/rules/refunds/refund-watch'
import { checkWatchedRefund } from '@/server/rules/refunds/refund-watch-settle'
import { PAYMENT_WATCH_DAYS, WATCHED_PAYMENTS_COUNT_SQL, WATCHED_PAYMENTS_DUE_SQL } from './payment-watch'
import { cancelRefundedSubscription, cancelSubscriptionsAfterRefund, LEFT_BY_REFUND, refundCancelsDue, type RefundCancelDue } from './refund-subscription'
import { checkAfterClosing, checksDue, LEAVE_AGAIN_DUE_SQL, leaveAgainLater, settleLeftStep, STEP_NOT_LEFT_AGAIN, stepsDue, type CheckDue, type OpenStep } from '@/server/rules/memberships/left'
import {
  checkProduct,
  openChanges,
  openCreates,
  openPlanSteps,
  planStepDue,
  productChecksDue,
  settleOpenChange,
  settleOpenCreate,
  settlePlanStep,
  type OpenChange,
  type OpenCreate,
  type OpenPlanStep,
  type ProductCheckDue,
} from '@/server/rules/catalog/plan-stripe'
import { endMembershipWithoutSubscription, membershipsToEnd } from '@/server/rules/memberships/no-subscription'
import { checkStillLive, MAX_STILL_LIVE_READS_PER_RUN, MEMBERSHIP_STILL_LIVE, stillLiveDue, stillLiveKey, type StillLiveDue } from '@/server/rules/memberships/still-live'
import {
  checkSubscription,
  dateIsMoved,
  failPaymentDateChange,
  finishFound,
  moveAndFinish,
  NOTHING_TAKEN,
  PAYMENT_DATE_CHANGES_DUE_SQL,
  paymentStillGoingReason,
  PAYMENT_DATE_METADATA,
  PAYMENT_DATE_RECONCILE_ENTITY,
  paymentMatches,
  readPaymentDateChange,
  refundAndFail,
  type ChangeOutcome,
} from '@/server/rules/memberships/payment-date'
import { PAYMENT_RETRIES_DUE_SQL, PAYMENT_RETRY_RECONCILE_ENTITY, settlePaymentRetry } from '@/server/rules/memberships/retry-payment'

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
 * - W32, a watched refund: the list of its payment's refunds (10, one page) + the transaction that ends the watch
 *   and puts a failure back (13) ≈ 23 s. A put-back with a customer balance to restore adds two calls (20).
 *   W32a: a read that ends nothing writes one `checked` row instead (13), so the same 23 s; a late refund's row is
 *   written with its watch in the one transaction it already had.
 * - W36, a membership's left step: the read of what is open (8), the subscription read and its update (20), its
 *   `done` or `refused` row (13) and the run's row (13) ≈ 54 s. Never a charge or a refund.
 * - W41, W41a, a payment date change (W41 review "For later" 1): the record's read (8), the customer's payments
 *   (10), that payment's refunds (10), the subscription read (10), the move (10), the refund sent twice (20), the
 *   `refunding` mark (13), the transaction that ends the record and writes the watch (13) and the run's row (13)
 *   ≈ 107 s; with a ten-page payments list ≈ 197 s. The longest item there is. Never a charge.
 * - W40c, a closed step's check: the reads that find the newest wish (a few, 8 each at worst), one subscription read
 *   (10), its row and any step it leaves in one transaction (13) and, only when it leaves one, the run's row (13):
 *   under a left step's 54 s. Never a send.
 * So a run ends by about 120 + 107 ≈ 227 s (under 4 minutes), before the next run; with ten-page lists by
 * about 120 + 197 ≈ 317 s, just over the 5-minute schedule, so two runs can then overlap. Overlap is safe (no
 * leases: T2 and the undo lock and re-check; the refund's first row is written once under an advisory lock), and
 * either way it is far inside 15 minutes. Two runs at once on one payment date change: each sends the move under its
 * own key, and it sets a value, so twice is once; each sends the refund under its own key with no amount, so the
 * second gets "already refunded" (taken as refunded) and the charge is never given back twice; and P2, the mark and
 * the record's ending each lock the membership and the row and look again, so one writes and the other finds it done.
 * The caps stay.
 */
export const SCHEDULED_LIMITS = { maxItems: 50, budgetMs: 120_000 }

/** W40 (W36 review L3): the most memberships' left steps one run sends (memberships/left.ts). */
export const MAX_STEPS_PER_RUN = 10
/**
 * W40c: the most closed steps' checks one run reads (memberships/left.ts, `checkAfterClosing`), oldest closing first;
 * the rest wait for the next run. Small, and its own, so the checks can never take a staff run's ten items from the
 * steps and watched refunds after them.
 */
export const MAX_STEP_CHECKS_PER_RUN = 5
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
export const MANUAL_LIMITS = {
  maxItems: 10,
  budgetMs: 15_000,
  stripeDeadlineMs: 20_000,
  /**
   * W32a: staff's run reads the watched refunds read longest ago whatever their last read was (inside its 10 items,
   * after everything else), so Resolve now can find a refund that failed without waiting for its daily read.
   */
  watchReadHours: 0,
}

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
  /** W32: how many days a refund is watched before the watch ends for a person (WATCH_DAYS; the tests shorten it). */
  watchDays?: number
  /** W32a: how many hours since its last read before a watched refund that reads `succeeded` is read again (WATCH_READ_HOURS). */
  watchReadHours?: number
  /** W47: how many days a payment is watched before a read Stripe can't find it on ends its watch for a person (PAYMENT_WATCH_DAYS; the tests shorten it). */
  paymentWatchDays?: number
  /**
   * W42a: ORDER_SWITCH, for one thing only: whether an order this run finalises also leaves card steps for the
   * customer's memberships (`card_moves`; finalise-order.ts). Absent: the Worker's environment, as the routes read
   * it. The scheduled run passes its own, because its environment isn't copied into process.env (server/scheduled.ts).
   * Nothing else in a run asks the switch: it settles whatever was started.
   * W42b: read once when the run starts (`runSwitch`) and given to every T2 the run reaches (`t2By`).
   */
  orderSwitch?: string | null
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
  /**
   * W21: `claim` is a booking refund's claim. W28: or an order refund's. W30: or an event booking's.
   * W36: `step` is a membership's Stripe step left after its database change (memberships/left.ts).
   * W41: `date_change` is a membership's payment date change still pending (memberships/payment-date.ts).
   * W47r: `payment_retry` is a membership payment tried again from the desk, still open (memberships/retry-payment.ts).
   */
  kind: 'order' | 'flow' | 'refund' | 'claim' | 'step' | 'date_change' | 'payment_retry' | 'plan'
  id: string
  outcome: ItemOutcome
  reason?: string
  /** What staff need to know (a finalised order's save-card warning, W03a later 6 / R6). */
  warning?: string
  detail?: string
  /** W12a (S1): what Stripe shows for an order the old screens moved out of pending. */
  finding?: ChangedElsewhereFinding
  /**
   * W25: more for a left item's `order.reconcile` row, for the manual close to act on (never in the run's answer): a
   * claim's per-part findings (`parts`, W21 review L4), a card flow's payments still at the bank (`payments`, L5).
   */
  record?: Record<string, unknown>
}

/**
 * W25 (W21 review L4): what reconcile found in Stripe for one planned card part of a claim it left for a person, kept
 * on its `order.reconcile` row (`parts`). The close records each `went` part as gone and puts only the others owed.
 */
export interface ClaimPartFinding {
  orderId: string
  amount: number
  found: 'went' | 'none' | 'several' | 'mismatch'
  /** W32: a `went` part's refund, so the close records it and has it watched (W32a: whatever its status), as R2 does. */
  refundId?: string
  refundStatus?: string | null
  /** What Stripe showed: the refunds' ids for `several`, the amounts for `mismatch`. */
  detail?: string
}

export interface ReconcileResult {
  checked: number
  finalised: number
  undone: number
  refunds: number
  left: number
  /** Over the run's bounds: left for the next run. */
  deferred: number
  /** Stripe refused the key (401/403): nothing more was tried, and an alert row was recorded. */
  stripeRefused: boolean
  /**
   * W32a (W32 review S2): watched card refunds still on their way at Stripe (not `succeeded`, not ended), read this run
   * or not. Nothing to do for them, so they are in neither `refunds` nor `left`: Resolve now says "N refunds waiting on
   * Stripe".
   */
  refundsWaiting: number
  /**
   * W47 (W25 review L1): card payments still watched after their booking change was undone by hand. Nothing to do for
   * them: each is a line of its own on the stuck list, and none is counted in `left`.
   */
  paymentsWatched: number
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

/** What a non-refund item's `order.reconcile` rows are written against. */
type ReconcileEntity = 'order' | 'reader_payment' | 'refund_claim' | 'membership_step' | 'plan_change' | typeof PAYMENT_DATE_RECONCILE_ENTITY | typeof PAYMENT_RETRY_RECONCILE_ENTITY

interface Run {
  db: Db
  stripe: StripeClient
  timing: StripeTiming | undefined
  options: ReconcileOptions
  /**
   * W42b (W42a review S1): ORDER_SWITCH as this run has it, settled once when the run starts (`runSwitch`) and given
   * to every T2 the run reaches (`t2By`). No T2 of a run reads the environment for itself.
   */
  orderSwitch: string | null
  /** Each action's row: `order.reconcile`, actor system (or the staff member). */
  record(entityType: ReconcileEntity, entityId: string, details: Record<string, unknown>): Promise<void>
  /**
   * W12a (W12 review L7): the automatic refund's rows are always the system's, even on a staff member's
   * manual run (the refund is automatic by Wayne's decision; the button only runs it sooner). On a manual
   * run the row names who ran it (`runBy`); the staff member stays the actor of the run's other rows.
   */
  refundEntry(entityType: 'order' | 'reader_payment', entityId: string, details: Record<string, unknown>): AuditEntry
  recordRefund(entityType: 'order' | 'reader_payment', entityId: string, details: Record<string, unknown>): Promise<void>
}

/** The item as the run answers it: without what is only for its audit row. */
function forTheAnswer(item: ReconcileItem): ReconcileItem {
  if (!item.record) return item
  const answered = { ...item }
  delete answered.record
  return answered
}

const left = (kind: ReconcileItem['kind'], id: string, reason: string, detail?: string, record?: Record<string, unknown>): ReconcileItem => ({
  kind,
  id,
  outcome: 'left',
  reason,
  ...(detail ? { detail } : {}),
  ...(record ? { record } : {}),
})

interface PendingOrder {
  id: string
  customer_id: string
  since: string
  reader_payment: PendingSnapshot
}

/**
 * W42b (W42a review S1): the run's ORDER_SWITCH, read once, here, when the run starts. The scheduled run gives its
 * own (its environment isn't in process.env: server/scheduled.ts). A run started by a request (staff's Resolve now)
 * gives none, and the request's environment is read here, as its route would read it. This is the only place a run
 * reads the environment for the switch.
 */
const runSwitch = (options: Pick<ReconcileOptions, 'orderSwitch'>): string | null => (options.orderSwitch === undefined ? (process.env.ORDER_SWITCH ?? null) : options.orderSwitch)

/** Who a run's T2 is by, and the run's switch: always given, so T2 never falls back to the environment (W42b). */
interface RunT2 {
  actor: ReconcileOptions['actor']
  requestId: string
  orderSwitch: string | null
}
const t2By = (run: Run): RunT2 => ({ actor: run.options.actor, requestId: run.options.requestId, orderSwitch: run.orderSwitch })

// W42b: the three ways a run reaches T2, each given the run's switch by its type. Nothing else in this file calls
// finaliseOrder, cancelReaderOrder or finaliseReaderOrderFound (reconcile.test.ts holds that), so a new path can't
// leave the switch out.
/** T2 itself, for an order the run finalises without the reader's steps. */
const runT2 = (run: Run, orderId: string, paymentIntent: Stripe.PaymentIntent | null, more: Pick<FinaliseOptions, 'subscription' | 'subscriptionMadeHere'> = {}): Promise<FinaliseOutcome> =>
  finaliseOrder(run.db, orderId, paymentIntent, { ...t2By(run), ...more })
/** The reader's cancel (which finalises instead when the tap went through), with the run's deadline. */
const runReaderCancel = (run: Run, orderId: string, more: Pick<ReaderRouteOptions, 'subscriptionFound'>): Promise<CancelReaderOrderOutput> =>
  // W13 (W12a N1): the run's own deadline, not the press's 30 s.
  cancelReaderOrder(run.db, run.stripe, orderId, { ...t2By(run), ...(run.timing ? { timing: run.timing } : {}), ...more })
/** The reader's finalise for a succeeded intent the run found by listing. */
const runReaderFinalise = (run: Run, orderId: string, snapshot: ReaderSnapshot, paymentIntent: Stripe.PaymentIntent, more: Pick<ReaderRouteOptions, 'subscriptionFound'>): Promise<FinaliseReaderOrderOutput> =>
  finaliseReaderOrderFound(run.db, run.stripe, orderId, snapshot, paymentIntent, { ...t2By(run), ...more }, run.timing)

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
    const outcome = await runT2(run, orderId, paymentIntent)
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
  // W42b (W42a review S1): with the run's switch, as every T2 of a run. This is the usual way a held reader order is
  // finished, and without the switch its T2 read an environment a scheduled run doesn't have.
  const answer = await runReaderCancel(run, order.id, subscriptionFound !== undefined ? { subscriptionFound } : {})
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
  const result = await runReaderFinalise(run, orderId, snapshot, paymentIntent, subscriptionFound !== undefined ? { subscriptionFound } : {})
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
  // W32 (R6, R7): what the first invoice did to the customer's Stripe balance, put back with the rest.
  return { subscriptionId: live[0]?.id ?? null, refunds, ...balanceToPutBack(found.subscriptions) }
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
    const outcome = await runT2(run, order.id, paid, { subscription, subscriptionMadeHere: true })
    // W42a: the membership this run's T2 wrote follows the customer's saved card: its step, left by T2, is sent now
    // (never throws; unsent, it is listed and a later run sends it past its window).
    if (outcome.finalised && outcome.cardSteps) await sendCardSteps(run.db, run.stripe, outcome.cardSteps, { actor: run.options.actor, requestId: run.options.requestId, timing: run.timing })
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

/**
 * PaymentIntent statuses that took nothing and can take nothing without a new confirm, which only the press could send
 * (and only within its first hour): a decline leaves `requires_payment_method`; a cancelled one is `canceled`.
 */
const CARD_NOTHING_TAKEN: ReadonlySet<string> = new Set(['requires_payment_method', 'canceled'])

/**
 * W19 (W17 review S1, D-plan 4.10): a saved-card flow (Settle; later Move and Add Guest). Reconcile never sends its
 * charge: only the press that wrote the record does, once. It lists the customer's payments and matches
 * `metadata.pending_id`:
 * - one that succeeded: C2 with it (a second one succeeding can't happen under one key, and is left for a person);
 * - none, or only declined or cancelled ones, once past the window: nothing was taken, so the undo;
 * - anything else (processing, waiting on the bank, a list Stripe didn't answer): left held for the next run.
 * A charge that succeeds on a flow already undone is kept by C2 for the automatic refund, as for the reader.
 */
async function reconcileCardFlow(run: Run, row: FlowRow): Promise<ReconcileItem> {
  const found = await findIntents(run.stripe, run.timing, {
    customer: row.snapshot.stripe_customer_id ?? null,
    since: row.created_at,
    matches: (intent) => intent.metadata?.['pending_id'] === row.id,
  })
  if (found.kind === 'unclear') return left('flow', row.id, 'unclear', found.detail)
  if (found.intents.length === 0 && !sameMode(row.snapshot.livemode, run.stripe.keyLivemode)) return left('flow', row.id, 'other_mode')
  const succeeded = found.intents.filter((intent) => intent.status === 'succeeded')
  if (succeeded.length > 1) return left('flow', row.id, 'several_payments', succeeded.map((intent) => intent.id).join(', '))
  const paid = succeeded[0]
  const stillGoing = found.intents.filter((intent) => intent.status !== 'succeeded' && !CARD_NOTHING_TAKEN.has(intent.status))
  if (!paid && stillGoing.length > 0) {
    // W25 (W21 review L5): the payments' ids are kept on the row, so a close by hand can have them watched.
    return left('flow', row.id, 'payment_processing', stillGoing.map((intent) => `${intent.id} ${intent.status}`).join(', '), { payments: stillGoing.map((intent) => intent.id) })
  }
  try {
    if (paid) {
      const outcome = await finaliseFlowInTransaction(run.db, row.id, paid, run.options)
      if (outcome.finalised) return outcome.alreadyFinalised ? { kind: 'flow', id: row.id, outcome: 'settled_elsewhere', detail: 'finalised' } : { kind: 'flow', id: row.id, outcome: 'finalised', detail: paid.id }
      return left('flow', row.id, outcome.reason, paid.id)
    }
    const why =
      found.intents.length === 0
        ? 'Stripe has no payment for this saved-card change'
        : `Stripe's payments for this saved-card change took nothing: ${found.intents.map((intent) => `${intent.id} ${intent.status}`).join(', ')}`
    const undone = await undoFlowInTransaction(run.db, row.id, { ...run.options, why })
    if (undone.undone) return { kind: 'flow', id: row.id, outcome: 'undone', detail: why, ...(undone.problems.length > 0 ? { warning: undone.problems.join('; ') } : {}) }
    return { kind: 'flow', id: row.id, outcome: 'settled_elsewhere', detail: undone.reason }
  } catch (err) {
    // A database fault: nothing was written (one transaction). Never refunded for it (W6-3); the next run tries again.
    // W25: a move the customer's other booking stops going back is said plainly (`undo_blocked`).
    return left('flow', row.id, paid ? 'finalise_failed' : err instanceof FlowUndoBlocked ? 'undo_blocked' : 'undo_failed', err instanceof Error ? err.message : String(err))
  }
}

async function reconcileFlow(run: Run, row: FlowRow): Promise<ReconcileItem> {
  // W19: a saved-card flow is listed and matched, never charged, whatever its row holds (reconcileCardFlow).
  if (isWorkerCardFlow(row.snapshot)) return reconcileCardFlow(run, row)
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
    return left('flow', row.id, settled.kind === 'succeeded' ? 'finalise_failed' : err instanceof FlowUndoBlocked ? 'undo_blocked' : 'undo_failed', err instanceof Error ? err.message : String(err))
  }
}

// --- A payment date change still pending (W41, F-plan 4.4 and 4.10)

/** One page of a payment's refunds, newest first: a payment date charge has at most one, so a page is all of them. */
async function refundsOf(stripe: StripeClient, timing: StripeTiming | undefined, paymentIntentId: string): Promise<{ kind: 'found'; refunds: Stripe.Refund[] } | { kind: 'unclear'; detail: string }> {
  try {
    const listed = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: LIST_PAGE }, sendOptions(timing))
    return { kind: 'found', refunds: listed.data }
  } catch (err) {
    return { kind: 'unclear', detail: readStripeFailure(err).message }
  }
}

/**
 * W41: a payment date change whose press left it pending (memberships/payment-date.ts). Never charges (FB1): only the
 * press that wrote the record sends its charge. The customer's payments are listed and matched by
 * `metadata.change_id`:
 * - none, or only declined or cancelled ones: nothing was taken, so the record is ended (`undone`);
 * - one still at the bank, more than one paid, or one of another amount: left (`payment_processing`, or for a person);
 * - one paid; the payment's refunds are listed:
 *   - a refund of the change's own (W41a B3: only one whose `metadata.change_id` names it), or the `refunding` mark
 *     with none of its own: the refund is recorded, watched, and the record ended. With the mark and none of its
 *     own, the refund is sent first, under a key of this run's own (W41a B2: Stripe replays a 500 it saved against
 *     the press's key for ever). It names no amount, so it gives back whatever is left: the whole charge, or the rest
 *     after a part someone refunded by hand; a charge already refunded in full is refunded;
 *   - no mark, and a refund nobody here made: left for a person (`refunded_elsewhere`), so the date is never moved
 *     for a charge that was given back;
 *   - else the subscription is read: the date as asked means P2 (`finalised`). If not, the press's own checks on the
 *     subscription are run again first (W41a B1): Stripe may have renewed it since the press, or a cancel been set,
 *     and a date moved then would be moved over a month already paid for. A check that fails means the change didn't
 *     happen: the charge is refunded (as a refused move's) with the check's words. Passed, the date move is sent
 *     again (it sets a value; a key of this run's own) and then P2, or, refused, the refund.
 * A record the Worker didn't start, or whose refund Stripe refused for good, is left for a person with no call made.
 */
async function reconcilePaymentDateChange(run: Run, changeId: string): Promise<ReconcileItem> {
  const kind = 'date_change' as const
  const change = await readPaymentDateChange(run.db, changeId)
  if (!change || change.status !== 'pending') return { kind, id: changeId, outcome: 'settled_elsewhere', detail: change?.status ?? 'gone' }
  const s = change.started
  if (!s) return left(kind, changeId, 'not_started_here')
  if (change.refundRefused) return left(kind, changeId, 'refund_refused', change.paymentIntentId ?? undefined)
  const started = { ...change, started: s }
  const by = { actor: run.options.actor, requestId: run.options.requestId }
  const answer = (outcome: ChangeOutcome, paymentIntentId: string): ReconcileItem => {
    if (outcome.kind === 'done') return outcome.already ? { kind, id: changeId, outcome: 'settled_elsewhere', detail: 'done' } : { kind, id: changeId, outcome: 'finalised', detail: paymentIntentId }
    if (outcome.kind === 'failed') return { kind, id: changeId, outcome: 'undone', detail: outcome.detail }
    if (outcome.kind === 'not_open') return { kind, id: changeId, outcome: 'settled_elsewhere', detail: outcome.status }
    return left(kind, changeId, outcome.reason, outcome.detail)
  }

  const found = await findIntents(run.stripe, run.timing, { customer: s.stripeCustomerId, since: change.createdAt, matches: (intent) => intent.metadata?.[PAYMENT_DATE_METADATA] === change.id })
  if (found.kind === 'unclear') return left(kind, changeId, 'unclear', found.detail)
  if (found.intents.length === 0 && !sameMode(s.livemode ?? undefined, run.stripe.keyLivemode)) return left(kind, changeId, 'other_mode')
  const succeeded = found.intents.filter((intent) => intent.status === 'succeeded')
  if (succeeded.length > 1) return left(kind, changeId, 'several_payments', succeeded.map((intent) => intent.id).join(', '))
  const paid = succeeded[0]
  const stillGoing = found.intents.filter((intent) => intent.status !== 'succeeded' && !NOTHING_TAKEN.has(intent.status))
  // W47: the reason says what it is waiting for (the bank, or a payment that must be cancelled in Stripe).
  if (!paid && stillGoing.length > 0) return left(kind, changeId, paymentStillGoingReason(stillGoing.map((intent) => intent.status)), stillGoing.map((intent) => `${intent.id} ${intent.status}`).join(', '))

  if (!paid) {
    const why =
      found.intents.length === 0
        ? 'Stripe has no payment for this payment date change: nothing was charged'
        : `Stripe's payments for this payment date change took nothing: ${found.intents.map((intent) => `${intent.id} ${intent.status}`).join(', ')}`
    try {
      const failed = await failPaymentDateChange(run.db, change, by, { at: 'reconcile', message: `${why}. The payment date has not changed.` })
      return failed ? { kind, id: changeId, outcome: 'undone', detail: why } : { kind, id: changeId, outcome: 'settled_elsewhere', detail: 'ended' }
    } catch (err) {
      return left(kind, changeId, 'fail_failed', err instanceof Error ? err.message : String(err))
    }
  }
  if (!paymentMatches(paid, s)) return left(kind, changeId, 'amount_mismatch', `${paid.id}: ${paid.amount_received} ${paid.currency} taken, ${pence(s.amount)} gbp asked`)

  const refunds = await refundsOf(run.stripe, run.timing, paid.id)
  if (refunds.kind === 'unclear') return left(kind, changeId, 'unclear', refunds.detail)
  // W41a B3: a refund is the change's own only by its metadata, which every refund made here carries.
  const own = refunds.refunds.find((refund) => refund.metadata?.[PAYMENT_DATE_METADATA] === change.id)
  if (refunds.refunds.length > 0 && !own && !change.refunding) return left(kind, changeId, 'refunded_elsewhere', refunds.refunds.map((refund) => `${refund.id} ${String(refund.status)}`).join(', '))
  if (own || change.refunding) {
    const known = own && own.status !== 'failed' && own.status !== 'canceled' ? { refundId: own.id, status: own.status, amountPence: own.amount } : undefined
    // W41a B2: with none of its own just listed, the refund goes under this run's key.
    return answer(await refundAndFail(run.db, run.stripe, started, paid.id, change.refunding?.stripeSaid ?? 'Stripe refused to move the payment date', by, run.timing, known, run.options.requestId), paid.id)
  }

  let subscription: Stripe.Subscription
  try {
    subscription = await run.stripe.subscriptions.retrieve(s.subscriptionId, undefined, sendOptions(run.timing))
  } catch (err) {
    const failure = readStripeFailure(err)
    return failure.code === 'resource_missing' ? left(kind, changeId, 'subscription_missing', `${paid.id}: ${failure.message}`) : left(kind, changeId, 'unclear', failure.message)
  }
  if (dateIsMoved(subscription, s)) return answer(await finishFound(run.db, started, paid.id, by), paid.id)
  // W41a B1: the press's checks again, on the subscription just read, before the move is sent again.
  const checked = checkSubscription(subscription, s)
  if (!checked.ok) return answer(await refundAndFail(run.db, run.stripe, started, paid.id, checked.message.replace(/\.+$/, ''), by, run.timing, undefined, run.options.requestId), paid.id)
  return answer(await moveAndFinish(run.db, run.stripe, started, paid.id, by, run.timing, 'reconcile', run.options.requestId), paid.id)
}

/**
 * W47r: a past-due membership's payment tried again from the desk, still open past the window
 * (memberships/retry-payment.ts). The run only reads Stripe for it: the invoice, and its payment.
 * - paid: the webhook's own `invoice.paid` write is run (it changes nothing when the notice, or the press, already
 *   made it), and the record ends (`finalised`);
 * - not paid, and nothing of it still going: the record ends with nothing taken (`undone`);
 * - a payment still at the bank or waiting on the customer, or Stripe not readable: left, and read again next run,
 *   with no limit. Nothing here ever sends, and nothing closes it by hand.
 */
async function reconcilePaymentRetry(run: Run, retryId: string): Promise<ReconcileItem> {
  const kind = 'payment_retry' as const
  const settled = await settlePaymentRetry(run.db, run.stripe, retryId, { actor: run.options.actor, requestId: run.options.requestId }, run.timing, run.options.windowMinutes ?? RECONCILE_WINDOW_MINUTES)
  if (settled.kind === 'closed') return { kind, id: retryId, outcome: 'settled_elsewhere', detail: 'ended' }
  if (settled.kind === 'paid') return { kind, id: retryId, outcome: 'finalised', detail: settled.detail }
  if (settled.kind === 'not_taken') return { kind, id: retryId, outcome: 'undone', detail: settled.detail }
  return left(kind, retryId, settled.reason, settled.detail)
}

// --- A payment watched after its flow was undone by hand (W25, W21 review L5)

interface WatchedPayment {
  entity_id: string
  payment_intent_id: string
  livemode: boolean | null
  flow: string | null
  record_id: string | null
  /** W47: it has been watched for the watch's days (PAYMENT_WATCH_DAYS), so a read Stripe still can't find it on ends it (W47a: only that). */
  past_window: boolean | null
}

/**
 * W25 (W21 review L5): a saved-card payment that was still at the bank when a person undid its change by hand. Read
 * again each run (settleIntent: read it, and cancel it when Stripe allows, so nothing more can be taken for a change
 * that is gone). If it went through, it is recorded exactly as C2 records a payment for a flow already undone
 * (`reader_payment.charge_without_record`), and the automatic refund gives it back from the next run. Cancelled, or it
 * took nothing: the watch ends. Anything unclear: watched again next run. Never refunds here, never charges.
 * W47 (W25 review L1, L2): a read that ends nothing is no item of the run (null): the payment is on the stuck list as a
 * line of its own with nothing to do, and counted in `paymentsWatched`, never in `left`. Once it has been watched for
 * the watch's days and Stripe still can't find it with the key in use (the other Stripe mode, or a record that never
 * said which mode), the watch ends `expired` and is left for a person, once, with what Stripe said.
 * W47a (W47 review S2): only then. W47 ended the watch on any unclear read past its days, which included a payment
 * Stripe reads perfectly well and still shows as `processing`: its watch ended, nothing read it again, and had it
 * gone through after a person pressed Mark sorted, the money would have been taken with nothing recorded or refunded.
 * A payment Stripe can read and that hasn't ended stays watched for as long as it takes. So does one whose read got
 * no answer this run: a read that failed says nothing about the payment, and the next run reads it again.
 * W47b (W47a "Noticed" 2): an expired watch comes back here when Mark sorted finds the payment in Stripe after all
 * (close-stuck.ts hands it back; payment-watch.ts no longer counts its `expired` rows). It is then read as any
 * watched payment: gone through, recorded and refunded automatically; nothing taken, ended; still at the bank,
 * watched; not found again (it is past its days), `expired` again for a person.
 */
async function checkWatchedPayment(run: Run, due: WatchedPayment): Promise<ReconcileItem | null> {
  const id = due.entity_id
  const settled = await settleIntent(run.stripe, { payment_intent_id: due.payment_intent_id, livemode: due.livemode ?? undefined }, run.timing)
  const entry = { actorType: run.options.actor.type, actorId: run.options.actor.id, entityType: 'reader_payment', entityId: id, requestId: run.options.requestId }
  if (settled.kind === 'unclear') {
    if (due.past_window !== true || settled.cause !== 'not_found') return null
    await run.db.transaction((tx) =>
      audit.recordAll(tx, [{ ...entry, action: FLOW_PAYMENT_WATCHED, details: { state: 'expired', paymentIntentId: due.payment_intent_id, days: run.options.paymentWatchDays ?? PAYMENT_WATCH_DAYS, detail: settled.message } }])
    )
    return left('flow', id, 'payment_watch_expired', `${due.payment_intent_id}: ${settled.message}`)
  }
  if (settled.kind === 'succeeded') {
    const amount = settled.paymentIntent.amount_received
    await run.db.transaction((tx) =>
      audit.recordAll(tx, [
        { ...entry, action: FLOW_PAYMENT_WATCHED, details: { state: 'landed', paymentIntentId: due.payment_intent_id, amount } },
        { ...entry, action: FLOW_CHARGE_WITHOUT_RECORD, details: { paymentIntentId: due.payment_intent_id, amount, flow: due.flow, recordId: due.record_id, watched: true } },
      ])
    )
    return left('flow', id, 'charged_without_record', due.payment_intent_id)
  }
  await run.db.transaction((tx) =>
    audit.recordAll(tx, [{ ...entry, action: FLOW_PAYMENT_WATCHED, details: { state: 'nothing_taken', paymentIntentId: due.payment_intent_id, status: settled.status } }])
  )
  return { kind: 'flow', id, outcome: 'settled_elsewhere', detail: `watched payment ${due.payment_intent_id} took nothing (${settled.status})` }
}

// --- A booking refund's claim held by its press (W21, D-plan 4.10)

/**
 * Each planned card part looked for in Stripe (never sent): a refund naming the claim that succeeded or is pending
 * went; none, or one that failed or was cancelled, never went. Then R2 with that: what went recorded on its lines, the
 * plan's store credit given, what never went owed on the booking. Left for a person: the claim's mode isn't the key's
 * (nothing can be trusted as "not found"), more than one refund names a part, or a refund's amount isn't the part's.
 * Left for the next run: a list Stripe didn't answer, or R2 failing in the database (nothing kept: one transaction).
 * W25 (W21 review L4): every part is looked at before the claim is left for a person, and what was found for each is
 * kept on the left row (`parts`), so the close by hand records the parts that went and puts only the others owed.
 * W26a (Wayne, 14 Nov): a claim marked refused (`booking.refund_refused`: Stripe refused a part, and the press couldn't
 * finish), or whose part Stripe shows as a failed or cancelled refund, ends with what never went owed on the booking,
 * live or cancelled, never store credit, with Stripe's reason on the finished row. W26b (Wayne, 14 Nov): "not found"
 * (no mark and no such refund) ends owed on a cancelled booking too; only the plan's own store credit is given.
 */
async function reconcileClaim(run: Run, claim: Claim): Promise<ReconcileItem> {
  const { plan, livemode } = claim.details
  if (typeof livemode === 'boolean' && livemode !== run.stripe.keyLivemode) return left('claim', claim.id, 'other_mode')
  const went: CardPart[] = []
  const refunds: RefundSeen[] = []
  const never: CardPart[] = []
  const parts: ClaimPartFinding[] = []
  let forAPerson: { reason: 'several_refunds' | 'refund_mismatch'; detail: string } | null = null
  /** W26a: Stripe shows a refund for a part that failed or was cancelled: a refusal, as the press's mark is. */
  let refusedInStripe: string | null = null
  for (const part of plan.card) {
    const found = await findCardPart(run.stripe, claim.id, part, run.timing)
    // Stripe didn't answer for this part: nothing is concluded about any part until a run reads them all.
    if (found.kind === 'unclear') return left('claim', claim.id, 'unclear', found.detail)
    const finding = { orderId: part.orderId, amount: part.amount }
    if (found.kind === 'several') {
      parts.push({ ...finding, found: 'several', detail: found.ids.join(', ') })
      forAPerson ??= { reason: 'several_refunds', detail: found.ids.join(', ') }
    } else if (found.kind === 'mismatch') {
      parts.push({ ...finding, found: 'mismatch', detail: found.detail })
      forAPerson ??= { reason: 'refund_mismatch', detail: found.detail }
    } else if (found.kind === 'went') {
      parts.push({ ...finding, found: 'went', refundId: found.refund.id, refundStatus: found.refund.status })
      went.push(part)
      refunds.push(refundSeen(part, found.refund))
    } else if (found.kind === 'refused') {
      parts.push({ ...finding, found: 'none', detail: found.detail })
      never.push(part)
      refusedInStripe ??= found.detail
    } else {
      parts.push({ ...finding, found: 'none' })
      never.push(part)
    }
  }
  if (forAPerson) return left('claim', claim.id, forAPerson.reason, forAPerson.detail, { parts })
  const owed = Math.round(never.reduce((total, part) => total + part.amount, 0) * 100) / 100
  try {
    const refused = (await claimRefusal(run.db, claim)) ?? refusedInStripe
    const output = await finishClaim(run.db, claim, { went, refunds, owed, ...(refused !== null ? { refused } : {}) }, { actor: run.options.actor, requestId: run.options.requestId, how: 'reconcile' })
    if (!output) return { kind: 'claim', id: claim.id, outcome: 'settled_elsewhere', detail: 'finished' }
    const detail = `card ${went.map((part) => `${part.orderId} £${part.amount.toFixed(2)}`).join(', ') || 'none'} recorded; £${owed.toFixed(2)} owed; £${output.storeCreditRefundedAmount.toFixed(2)} to store credit`
    return { kind: 'claim', id: claim.id, outcome: 'finalised', detail }
  } catch (err) {
    return left('claim', claim.id, 'finish_failed', err instanceof Error ? err.message : String(err))
  }
}

/**
 * W28 (E-plan 4.9): an order refund's claim held by its press, settled as a booking's (reconcileClaim), with its one
 * card part. Never sends a refund: the refunds on the order's PaymentIntent are listed and matched by
 * `metadata.claim_id`. Found: R2 (the card money on its lines, the plan's store credit, the order's status). None, or
 * a refund that failed or was cancelled, or the press's refusal mark: the card money is left on the order as still to
 * refund (Q39), never store credit, with Stripe's reason when there is one. Left for a person: the other Stripe mode,
 * more than one refund, a refund of another amount. Left for the next run: Stripe didn't answer, or R2 failed.
 */
async function reconcileOrderClaim(run: Run, claim: OrderClaim): Promise<ReconcileItem> {
  const { plan, livemode } = claim.details
  if (typeof livemode === 'boolean' && livemode !== run.stripe.keyLivemode) return left('claim', claim.id, 'other_mode')
  const went: CardPart[] = []
  const refunds: RefundSeen[] = []
  const never: CardPart[] = []
  const parts: ClaimPartFinding[] = []
  let refusedInStripe: string | null = null
  for (const part of plan.card) {
    const found = await findCardPart(run.stripe, claim.id, part, run.timing)
    if (found.kind === 'unclear') return left('claim', claim.id, 'unclear', found.detail)
    const finding = { orderId: part.orderId, amount: part.amount }
    if (found.kind === 'several') return left('claim', claim.id, 'several_refunds', found.ids.join(', '), { parts: [{ ...finding, found: 'several', detail: found.ids.join(', ') }] })
    if (found.kind === 'mismatch') return left('claim', claim.id, 'refund_mismatch', found.detail, { parts: [{ ...finding, found: 'mismatch', detail: found.detail }] })
    if (found.kind === 'went') {
      parts.push({ ...finding, found: 'went', refundId: found.refund.id, refundStatus: found.refund.status })
      went.push(part)
      refunds.push(refundSeen(part, found.refund))
    } else {
      parts.push({ ...finding, found: 'none', ...(found.kind === 'refused' ? { detail: found.detail } : {}) })
      never.push(part)
      if (found.kind === 'refused') refusedInStripe ??= found.detail
    }
  }
  const owed = Math.round(never.reduce((total, part) => total + part.amount, 0) * 100) / 100
  try {
    const refused = (await stepEClaimRefusal(run.db, claim)) ?? refusedInStripe
    const finished = await finishOrderClaim(run.db, claim, { went, refunds, owed, ...(refused !== null ? { refused } : {}) }, { actor: run.options.actor, requestId: run.options.requestId, how: 'reconcile' })
    if (!finished) return { kind: 'claim', id: claim.id, outcome: 'settled_elsewhere', detail: 'finished' }
    let detail = `card ${went.map((part) => `${part.orderId} £${part.amount.toFixed(2)}`).join(', ') || 'none'} recorded; £${owed.toFixed(2)} owed on the order; £${finished.storeCreditRefunded.toFixed(2)} to store credit`
    // W29 (E-plan 4.3): the money is settled, so a refunded membership's subscription is cancelled now, last, as the
    // press would have. R2 recorded it as left: one that can't be confirmed cancelled is retried on the next run.
    try {
      const cancels = await cancelSubscriptionsAfterRefund(run.db, run.stripe, claim, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
      if (cancels.length > 0) detail += `; ${cancels.map((cancel) => `subscription ${cancel.subscriptionId} ${cancel.cancelled ? 'cancelled' : `left: ${cancel.left}`}`).join('; ')}`
    } catch (err) {
      detail += `; subscription cancel left: ${err instanceof Error ? err.message : String(err)}`
    }
    return { kind: 'claim', id: claim.id, outcome: 'finalised', detail }
  } catch (err) {
    return left('claim', claim.id, 'finish_failed', err instanceof Error ? err.message : String(err))
  }
}

/**
 * W30 (E-plan 4.9): an event booking's claim held by its press (places cancelled with a card refund), settled as an
 * order's (reconcileOrderClaim), with its one card part on the order that paid for the booking. Never sends a refund:
 * the refunds on that order's PaymentIntent are listed and matched by `metadata.claim_id`. Found: R2 (the money on the
 * places and the event line, the plan's store credit, the order's status). None, or a refund that failed or was
 * cancelled, or the press's refusal mark: the places stay cancelled and the card money is left on the booking's order
 * as still to refund (Q39), never store credit. Left for a person: the other Stripe mode, more than one refund, a
 * refund of another amount. Left for the next run: Stripe didn't answer, or R2 failed.
 */
async function reconcileEventClaim(run: Run, claim: EventBookingClaim): Promise<ReconcileItem> {
  const { plan, livemode } = claim.details
  if (typeof livemode === 'boolean' && livemode !== run.stripe.keyLivemode) return left('claim', claim.id, 'other_mode')
  const went: CardPart[] = []
  const refunds: RefundSeen[] = []
  const never: CardPart[] = []
  let refusedInStripe: string | null = null
  for (const part of plan.card) {
    const found = await findCardPart(run.stripe, claim.id, part, run.timing)
    if (found.kind === 'unclear') return left('claim', claim.id, 'unclear', found.detail)
    const finding = { orderId: part.orderId, amount: part.amount }
    if (found.kind === 'several') return left('claim', claim.id, 'several_refunds', found.ids.join(', '), { parts: [{ ...finding, found: 'several', detail: found.ids.join(', ') }] })
    if (found.kind === 'mismatch') return left('claim', claim.id, 'refund_mismatch', found.detail, { parts: [{ ...finding, found: 'mismatch', detail: found.detail }] })
    if (found.kind === 'went') {
      went.push(part)
      refunds.push(refundSeen(part, found.refund))
    } else {
      never.push(part)
      if (found.kind === 'refused') refusedInStripe ??= found.detail
    }
  }
  const owed = Math.round(never.reduce((total, part) => total + part.amount, 0) * 100) / 100
  try {
    const refused = (await stepEClaimRefusal(run.db, claim)) ?? refusedInStripe
    const finished = await finishEventClaim(run.db, claim, { went, refunds, owed, ...(refused !== null ? { refused } : {}) }, { actor: run.options.actor, requestId: run.options.requestId, how: 'reconcile' })
    if (!finished) return { kind: 'claim', id: claim.id, outcome: 'settled_elsewhere', detail: 'finished' }
    const detail = `card ${went.map((part) => `${part.orderId} £${part.amount.toFixed(2)}`).join(', ') || 'none'} recorded; £${owed.toFixed(2)} owed on the event booking's order; £${finished.storeCreditRefunded.toFixed(2)} to store credit`
    return { kind: 'claim', id: claim.id, outcome: 'finalised', detail }
  } catch (err) {
    return left('claim', claim.id, 'finish_failed', err instanceof Error ? err.message : String(err))
  }
}

/**
 * W21: one held claim settled now, as a run settles it, whatever its age, with its `order.reconcile` row: what staff's
 * Resolve now does for it once the claim is past the window. For the replay (a scenario whose next step comes after
 * the staff member checked the Orders page, Q35's words) and the tests.
 */
export async function reconcileClaimNow(db: Db, stripeClient: StripeClient, claimId: string, options: Pick<ReconcileOptions, 'actor' | 'requestId'>): Promise<ReconcileItem> {
  const record: Run['record'] = async (entityType, entityId, details) => {
    await db.transaction((tx) =>
      audit.recordAll(tx, [{ actorType: options.actor.type, actorId: options.actor.id, action: 'order.reconcile', entityType, entityId, requestId: options.requestId, details }])
    )
  }
  const run: Run = {
    db,
    stripe: stripeClient,
    timing: undefined,
    options: { ...options, maxItems: 1, budgetMs: 0 },
    orderSwitch: runSwitch({}),
    record,
    refundEntry: (entityType, entityId, details) => ({ actorType: 'system', actorId: null, action: 'order.reconcile', entityType, entityId, requestId: options.requestId, details }),
    recordRefund: () => Promise.resolve(),
  }
  const claim = await readClaim(db, claimId)
  // W28: an order refund's claim, when it isn't a booking's.
  const orderClaim = claim ? null : await readOrderClaim(db, claimId)
  // W30: an event booking's claim, when it is neither.
  const eventClaim = claim || orderClaim ? null : await readEventBookingClaim(db, claimId)
  if (!claim && !orderClaim && !eventClaim) return { kind: 'claim', id: claimId, outcome: 'settled_elsewhere', detail: 'gone' }
  const item = claim ? await reconcileClaim(run, claim) : orderClaim ? await reconcileOrderClaim(run, orderClaim) : await reconcileEventClaim(run, eventClaim as EventBookingClaim)
  if (item.outcome !== 'settled_elsewhere') {
    await record('refund_claim', claimId, { outcome: item.outcome, ...(item.reason ? { reason: item.reason } : {}), detail: item.detail ?? null, ...(item.record ?? {}) })
  }
  return forTheAnswer(item)
}

// --- The automatic refund of a late payment (W03-decisions, "W12 calls")

export interface LateRefundDue {
  entity_type: 'order' | 'reader_payment'
  entity_id: string
  payment_intent_id: string
  /** The last `order.reconcile` refund row for it, if any. */
  state: { refund?: { state?: string; refundId?: string; key?: string } } | null
  /** W32 (W25 review L3): a payment a manual close left watched (checkWatchedPayment's `watched` row). */
  watched?: boolean | null
}

/**
 * Payments that succeeded on an order or flow already undone (T2 recorded each: `order.charge_without_order`,
 * `reader_payment.charge_without_record`) and whose refund isn't settled yet. Settled means Stripe confirmed
 * it, or it failed and is listed for a person. W32a (W32 review S3): or its refund is watched (refund-watch.ts): once
 * Stripe has given the refund an id it is the watch's to read, for the watch's days, and a failure is the watch's line.
 */
export const LATE_REFUNDS_DUE_SQL = `
WITH charged AS (
  SELECT a.entity_type, a.entity_id, a.details->>'paymentIntentId' AS payment_intent_id, min(a.at) AS first_at,
         bool_or(COALESCE(a.details->>'watched', 'false') = 'true') AS watched
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
SELECT c.entity_type, c.entity_id, c.payment_intent_id, l.state, c.watched
FROM charged c
LEFT JOIN latest l ON l.entity_type = c.entity_type AND l.entity_id = c.entity_id AND l.payment_intent_id = c.payment_intent_id
WHERE (l.state IS NULL OR l.state->'refund'->>'state' NOT IN ('confirmed', 'failed'))
  AND NOT EXISTS (
    SELECT 1 FROM audit_log w
    WHERE w.action = 'refund.watch' AND w.entity_type = 'refund_watch' AND w.entity_id = l.state->'refund'->>'refundId'
  )
ORDER BY c.first_at`

/** What a late payment's refund says it is for, in its metadata. */
const LATE_REFUND_REASON = 'paid_after_undone'

/**
 * The refund's key: `<orderId>:refund-charge` (a saved card) or `:refund-reader`, or the flow's row id's.
 * W32 (W25 review L3, the W26 audit's row 30): a watched payment's refund is keyed by its own PaymentIntent
 * (`<paymentIntentId>:refund-watched`). A flow closed by hand can leave more than one payment watched; under the
 * flow's one key the second refund was a different request, which Stripe refuses for the key, so it was listed for a
 * person though nothing was wrong with it. Each payment still has one key, so each is refunded once at most.
 * W32a (W32 review S4): the key already recorded on the payment's `started` (or `sent`) row is the one used again, so a
 * refund started under one key is never tried under another; the key is worked out only for a first send.
 */
function refundKey(due: LateRefundDue, paymentIntent: Stripe.PaymentIntent): string {
  const recorded = due.state?.refund?.key
  if (typeof recorded === 'string' && recorded !== '') return recorded
  if (due.watched === true) return stripeIdempotencyKey(due.payment_intent_id, 'refund-watched')
  const reader = due.entity_type === 'reader_payment' || Boolean(paymentIntent.metadata?.['flow'])
  return stripeIdempotencyKey(due.entity_id, reader ? 'refund-reader' : 'refund-charge')
}

/**
 * Refunds a late payment in full, once: the refund's row is written (and committed) before it is sent,
 * under the key built from the order's (or flow's) id, so a second send, from this run or the next, is
 * Stripe's same refund. Stripe's answer: succeeded, confirmed; pending, listed until a later run sees it
 * succeed; failed or refused, listed for a person; unclear, sent again next run with the same key. A
 * refund already made by hand (`charge_already_refunded`) counts as confirmed.
 * W32a (W32 review S3): a refund Stripe accepted (`succeeded` or `pending`) is handed to the refund watch with the row
 * that records its id, in one transaction, and this path never reads it again: the watch does, for its days, so a
 * refund answered `succeeded` that fails later is found, and one refund is one line.
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
    // W32a: only a row from before the watch took these over gets here (a watched refund is no longer due).
    if (listed?.status === 'succeeded') {
      await recordRefundWatched(run, due, listed, { outcome: 'refund_confirmed', refund: { ...base, state: 'confirmed', refundId: listed.id, amount: listed.amount } })
      return item('refund_confirmed')
    }
    if (listed && (listed.status === 'failed' || listed.status === 'canceled')) {
      await run.recordRefund(due.entity_type, id, { outcome: 'refund_failed', refund: { ...base, state: 'failed', refundId: listed.id, status: listed.status } })
      return item('refund_failed', 'refund_failed')
    }
    if (listed) await recordRefundWatched(run, due, listed, null)
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
      await recordRefundWatched(run, due, earlier, { outcome: 'refund_confirmed', refund: { ...base, state: 'confirmed', key, refundId: earlier.id, amount: earlier.amount, alreadyRefunded: true } })
      return item('refund_confirmed', undefined, 'already refunded under its key')
    }
    if (earlier && (earlier.status === 'failed' || earlier.status === 'canceled')) {
      await run.recordRefund(due.entity_type, id, { outcome: 'refund_failed', refund: { ...base, state: 'failed', key, refundId: earlier.id, status: earlier.status } })
      return item('refund_failed', 'refund_failed')
    }
    if (earlier) {
      await recordRefundWatched(run, due, earlier, { outcome: 'refund_pending', refund: { ...base, state: 'sent', key, refundId: earlier.id, status: earlier.status } })
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
    await recordRefundWatched(run, due, refund, { outcome: 'refund_confirmed', refund: { ...base, state: 'confirmed', key, refundId: refund.id, amount: refund.amount } })
    return item('refund_confirmed')
  }
  if (refund.status === 'failed' || refund.status === 'canceled') {
    await run.recordRefund(due.entity_type, id, { outcome: 'refund_failed', refund: { ...base, state: 'failed', key, refundId: refund.id, status: refund.status } })
    return item('refund_failed', 'refund_failed')
  }
  await recordRefundWatched(run, due, refund, { outcome: 'refund_pending', refund: { ...base, state: 'sent', key, refundId: refund.id, status: refund.status } })
  return item('refund_pending', 'refund_pending')
}

/**
 * W32a (W32 review S3): a late refund Stripe accepted, handed to the refund watch (once: watchLateRefund finds a watch
 * already there, a compensation's for the same refund included) in the transaction that writes its row (`details`;
 * null when only the watch is wanted). So a row that names an accepted refund always has a watch beside it, and
 * LATE_REFUNDS_DUE_SQL then leaves the payment to the watch. The watch's rows are the system's, as the refund's are.
 */
async function recordRefundWatched(run: Run, due: LateRefundDue, refund: Pick<Stripe.Refund, 'id' | 'amount' | 'status'>, details: Record<string, unknown> | null): Promise<void> {
  await run.db.transaction(async (tx) => {
    await watchLateRefund(
      tx,
      { refundId: refund.id, paymentIntentId: due.payment_intent_id, amountPence: refund.amount, status: refund.status },
      { type: due.entity_type, id: due.entity_id },
      run.stripe.keyLivemode,
      { actor: { type: 'system', id: null }, requestId: run.options.requestId }
    )
    if (details) await audit.recordAll(tx, [run.refundEntry(due.entity_type, due.entity_id, details)])
  })
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
  -- W29: never a refunded membership's subscription (this retry also refunds the first invoice; a refund's own claim
  -- gave that money back). Those are retryRefundCancel's.
  AND l.found IS DISTINCT FROM '${LEFT_BY_REFUND}'
ORDER BY l.at, l.entity_id`

/**
 * W29 (E-plan 4.3 and 4.9; bug E10): a refunded membership's subscription whose cancel was refused, got no clear
 * answer, or was never tried (the press died between the refund and the cancel). Cancelled again, checked: cancelling
 * twice is harmless, and one a person cancelled in Stripe reads as cancelled. Nothing else is sent: never a refund.
 * Left again, it stays on the stuck list for the next run.
 * W36 (lead call L7; W29 review L2, the W35 audit's row 11): refused by Stripe for good, it is recorded as `refused`
 * and left for a person (`subscription_cancel_refused`): still listed, and not due again.
 */
async function retryRefundCancel(run: Run, due: RefundCancelDue): Promise<ReconcileItem> {
  const cancel = await cancelRefundedSubscription(run.db, run.stripe, due, { actor: run.options.actor, requestId: run.options.requestId }, run.timing, { refusedIsForGood: true })
  if (cancel.cancelled) return { kind: 'order', id: due.orderId, outcome: 'undone', detail: `subscription ${due.subscriptionId} cancelled: its membership was refunded` }
  if (cancel.refused) return left('order', due.orderId, 'subscription_cancel_refused', `subscription ${due.subscriptionId}: ${cancel.left}`)
  return left('order', due.orderId, 'subscription_cancel_left', `subscription ${due.subscriptionId}: ${cancel.left}`)
}

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

// --- A membership's Stripe step left after its database change (W36, F-plan 4.10 item 2, lead call L7)

// W40b: the reason on a run's row for a newest step's wish it could not leave again (the database failed). W46: it
// lives in memberships/left.ts with the list of what is due, so the stuck list can read both; still exported from here.
export { STEP_NOT_LEFT_AGAIN }

/**
 * One open step (memberships/left.ts): a membership's cancel date to set or clear on its subscription, or its
 * subscription to move to a replaced card. Read first, sent only if Stripe doesn't already show it. Done: `finalised`
 * (what the action started is finished). Refused by Stripe for good: left for a person (`step_refused`), and not due
 * again. No clear answer: left for the next run (`step_left`). Never a charge or a refund.
 */
async function sendLeftStep(run: Run, due: OpenStep): Promise<ReconcileItem> {
  const settled = await settleLeftStep(run.db, run.stripe, due.id, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
  const what = `${due.kind} on subscription ${due.subscriptionId}`
  if (settled.kind === 'done') return { kind: 'step', id: due.id, outcome: 'finalised', detail: `${what}: ${settled.detail}` }
  // W40 (S1): `detail` when a newer step had replaced it and that one was settled instead.
  if (settled.kind === 'closed') return { kind: 'step', id: due.id, outcome: 'settled_elsewhere', detail: settled.detail ?? 'closed' }
  if (settled.kind === 'refused') return left('step', due.id, 'step_refused', `${what}: ${settled.message}`)
  // W40b: an error, not a step still to send: the newer step's wish could not be left again. The row names that step
  // (`leaveAgain`), and every later run tries again until it is settled (LEAVE_AGAIN_DUE_SQL, memberships/left.ts).
  if (settled.kind === 'not_left_again') return left('step', due.id, STEP_NOT_LEFT_AGAIN, settled.message, { leaveAgain: settled.stepId })
  return left('step', due.id, 'step_left', `${what}: ${settled.message}`)
}

/**
 * W40b: one of those, tried again: the wish is left again (or its open step marked) only while the step it stands
 * for is still the newest. Nothing is asked of Stripe. Settled either way (`settled_elsewhere`, with what was done),
 * so it is not due again; if the database fails again it is reported again, and the next run tries.
 */
async function retryLeaveAgain(run: Run, stepId: string): Promise<ReconcileItem> {
  try {
    const detail = await leaveAgainLater(run.db, stepId, { actor: run.options.actor, requestId: run.options.requestId })
    return { kind: 'step', id: stepId, outcome: 'settled_elsewhere', detail, record: { leaveAgain: stepId } }
  } catch (err) {
    return left('step', stepId, STEP_NOT_LEFT_AGAIN, `step ${stepId}: not left again yet (${err instanceof Error ? err.message : String(err)})`, { leaveAgain: stepId })
  }
}

// --- A membership plan's Stripe side (W57, G-plan 4.7): never a charge or a refund

/**
 * W57: a plan price change held (or left past its window with no answer): its new price looked for in Stripe by the
 * record's id. Found: D2, then the old price archived and the members' moves sent (`finalised`). None: failed, the
 * plan keeps its price (`undone`: what the press started is put back as it was). No clear read: left.
 */
async function settlePlanChange(run: Run, open: OpenChange): Promise<ReconcileItem> {
  const settled = await settleOpenChange(run.db, run.stripe, open, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
  if (settled.kind === 'done') return { kind: 'plan', id: open.change.changeId, outcome: 'finalised', detail: settled.detail }
  if (settled.kind === 'failed') return { kind: 'plan', id: open.change.changeId, outcome: 'undone', detail: settled.detail }
  if (settled.kind === 'closed') return { kind: 'plan', id: open.change.changeId, outcome: 'settled_elsewhere', detail: 'closed' }
  return left('plan', open.change.changeId, 'plan_change_held', settled.detail)
}

/** W57 (GB20): a plan left half made: what is missing found or made under the same keys, then finished; refused for good: failed. */
async function settlePlanCreate(run: Run, open: OpenCreate): Promise<ReconcileItem> {
  const settled = await settleOpenCreate(run.db, run.stripe, open, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
  if (settled.kind === 'done') return { kind: 'plan', id: open.plan.planId, outcome: 'finalised', detail: settled.detail }
  if (settled.kind === 'failed') return { kind: 'plan', id: open.plan.planId, outcome: 'undone', detail: settled.detail }
  if (settled.kind === 'closed') return { kind: 'plan', id: open.plan.planId, outcome: 'settled_elsewhere', detail: 'closed' }
  return left('plan', open.plan.planId, 'plan_create_held', settled.detail)
}

/** W57: a plan step (an old price to archive, the product on or off sale) past its press's window. */
async function sendPlanStepNow(run: Run, step: OpenPlanStep): Promise<ReconcileItem> {
  const settled = await settlePlanStep(run.db, run.stripe, step.id, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
  if (settled.kind === 'done') return { kind: 'plan', id: step.id, outcome: 'finalised', detail: `${step.kind} for plan ${step.planId}: ${settled.detail}` }
  if (settled.kind === 'closed') return { kind: 'plan', id: step.id, outcome: 'settled_elsewhere', detail: settled.detail }
  if (settled.kind === 'refused') return left('plan', step.id, 'plan_step_refused', `${step.kind} for plan ${step.planId}: ${settled.detail}`)
  return left('plan', step.id, 'plan_step_left', `${step.kind} for plan ${step.planId}: ${settled.detail}`)
}

/** W57: a plan's product checked once more after its product steps closed: no item unless it leaves a step again. */
async function checkPlanProduct(run: Run, due: ProductCheckDue): Promise<ReconcileItem | null> {
  const checked = await checkProduct(run.db, run.stripe, due, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
  if (checked.kind !== 'left_again') return null
  return left('plan', due.planId, 'plan_product_differs', checked.detail)
}

// --- A closed step, checked once more (W40c)

/** W40c: the reasons on a run's row for a wish a check left again: Stripe showed something else, or could not be read for 2 hours (W40d; a day before). */
export const STEP_CHECK_DISAGREED = 'step_check_disagreed'
export const STEP_CHECK_UNREAD = 'step_check_unread'
/** W46: the reason for a wish a check left for a person because the membership's own last day and the one Stripe gives differ. */
export const STEP_CHECK_ROW_DIFFERS = 'step_check_row_differs'

/**
 * W40c: one subscription's closed steps, checked once more against Stripe (memberships/left.ts, `checkAfterClosing`):
 * one read, never a send. No item unless it leaves the newest wish again, as a watched refund's read is none unless
 * it ends for a person: then the item is the new step, left, with why (Stripe showed something else; Stripe can't
 * find the subscription or has ended it, or (W40d) still shows something else after the check's own left-again step
 * was sent, each `step_refused` as any step for a person; no clear read in 2 hours; W46: the membership's own last
 * day is not the one Stripe gives, `step_check_row_differs`, a refused step that is never sent).
 */
async function checkClosedSteps(run: Run, due: CheckDue): Promise<ReconcileItem | null> {
  const checked = await checkAfterClosing(run.db, run.stripe, due, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
  if (checked.kind !== 'listed') return null
  const reason = checked.outcome === 'left_again' ? STEP_CHECK_DISAGREED : checked.outcome === 'unread' ? STEP_CHECK_UNREAD : checked.outcome === 'row_differs' ? STEP_CHECK_ROW_DIFFERS : 'step_refused'
  return left('step', checked.stepId, reason, `${due.kind} on subscription ${due.subscriptionId}: checked after closing: ${checked.detail}`)
}

// --- A membership with no subscription, past its last day (W46)

/**
 * W46 (W45a "Noticed" 8): one membership with no Stripe subscription whose last day has passed, marked cancelled
 * (memberships/no-subscription.ts). No Stripe call. `finalised` when it was ended (the run's row says so); one that is
 * no longer due under its lock is nothing to report.
 */
async function endWithoutSubscription(run: Run, membershipId: string): Promise<ReconcileItem> {
  const ended = await endMembershipWithoutSubscription(run.db, membershipId, { actor: run.options.actor, requestId: run.options.requestId })
  if (!ended.ended) return { kind: 'step', id: membershipId, outcome: 'settled_elsewhere', detail: 'closed' }
  return {
    kind: 'step',
    id: membershipId,
    outcome: 'finalised',
    detail: `membership ${membershipId} has no Stripe subscription and its last day (${ended.lastDay}) has passed: marked cancelled${ended.bookingsFlagged > 0 ? `, ${ended.bookingsFlagged} credit booking${ended.bookingsFlagged === 1 ? '' : 's'} after that day now payment needed` : ''}`,
  }
}

// --- A membership past its last day whose subscription is still live in Stripe (W47r-e)

/**
 * W47r-e (brief item 3; W47r-d "Noticed" 3): one membership whose last day has passed and which has not ended here,
 * read in Stripe (memberships/still-live.ts): one read, never a send. No item unless this read lists it, as a closed
 * step's check is none unless it leaves a wish again: then the item is the line, left for a person, with why. A read
 * that finds it listed already, ended in Stripe, being ended by Stripe, or unreadable is nothing to report.
 */
async function checkLivePastLastDay(run: Run, due: StillLiveDue, now: () => number): Promise<ReconcileItem | null> {
  const checked = await checkStillLive(run.db, run.stripe, due, { actor: run.options.actor, requestId: run.options.requestId }, run.timing, now)
  if (checked.kind !== 'listed') return null
  return left('step', checked.listingId, MEMBERSHIP_STILL_LIVE, `membership ${due.membershipId} ended here on ${checked.lastDay}, and Stripe shows its subscription ${due.subscriptionId} ${checked.status}: listed for a person`)
}

// --- Steps and checks taken by when they were last tried (W46)

/**
 * W46 (W45 audit rows 25 and 31; W40 review L6, W40c review L2 and L3). A run sends at most MAX_STEPS_PER_RUN steps
 * and reads at most MAX_STEP_CHECKS_PER_RUN checks, and they were taken oldest first: ones Stripe never answers
 * stayed at the front and held the rest behind them for as long as they were due. Now a run that could not try
 * every step and check that was due writes one row naming the ones it did try, and the next runs take first the ones
 * not tried since (oldest first, as before), then the rest by when they were last tried, longest ago first. A run
 * that tries everything writes nothing, so in ordinary use there is no row and the order is the old one.
 */
export const STEPS_TRIED_ACTION = 'reconcile.steps_tried'
/** How far back a run looks for those rows: a step not named in a day of them counts as never tried. */
const TRIED_LOOK_BACK_HOURS = 24

/** The rows of the last day, newest first (a run every five minutes is 288 a day). */
const TRIED_SQL = `
SELECT details, at FROM audit_log
WHERE action = '${STEPS_TRIED_ACTION}' AND entity_type = 'reconcile' AND at > now() - interval '${TRIED_LOOK_BACK_HOURS} hours'
ORDER BY at DESC
LIMIT 300`

/** A check has no id of its own: its membership, subscription and kind. */
const checkKey = (due: Pick<CheckDue, 'membershipId' | 'subscriptionId' | 'kind'>): string => `${due.membershipId}|${due.subscriptionId}|${due.kind}`

interface LastTried {
  steps: Map<string, number>
  checks: Map<string, number>
  /** W47r-e: memberships past their last day read in Stripe (still-live.ts), by membership and subscription. */
  live: Map<string, number>
}

/** When each step and check was last tried by a run that recorded it. A failed read is "never": the old order. */
async function lastTried(db: Db): Promise<LastTried> {
  const tried: LastTried = { steps: new Map(), checks: new Map(), live: new Map() }
  let rows: Array<{ details: { steps?: unknown; checks?: unknown; live?: unknown } | null; at: string | Date }>
  try {
    rows = await db.query(TRIED_SQL)
  } catch {
    return tried
  }
  // Newest first: the first time a key is met is the last time it was tried.
  for (const row of rows) {
    const at = new Date(row.at).getTime()
    for (const [list, into] of [[row.details?.steps, tried.steps], [row.details?.checks, tried.checks], [row.details?.live, tried.live]] as const) {
      if (!Array.isArray(list)) continue
      for (const key of list) if (typeof key === 'string' && !into.has(key)) into.set(key, at)
    }
  }
  return tried
}

/** Never tried first, in the order given (oldest first); then by when last tried, longest ago first. The sort is stable. */
export function byLastTried<T>(due: readonly T[], keyOf: (item: T) => string, tried: ReadonlyMap<string, number>): T[] {
  return [...due].sort((a, b) => (tried.get(keyOf(a)) ?? 0) - (tried.get(keyOf(b)) ?? 0))
}

// --- A watched card refund (W32, lead call L7; W32a, lead call 1: every card refund)

/**
 * W32: one watched refund (refund-watch.ts) read again: a finished claim's card refund, one of step C's compensation
 * refunds, or (W32a) a late payment's automatic refund. Never a send. Failed or cancelled: its money goes back as owed
 * on its booking or order, or, with nothing to owe it on, is left as a line for a person (`refund_failed`). Still going
 * after the watch's days: the watch ends for a person (`refund_failed`, `watch_expired`). Its rows are the watch's own
 * (`refund.watch`), written with whatever is put back, so the run writes no `order.reconcile` row for it.
 * W32a (W32 review S2): a read that ends nothing for a person is no item at all (null): still going, `succeeded` so
 * far, a watch that ends quietly at the end of its days, no answer, the other mode, a refund claim open on its subject,
 * or ended by another run. It is counted in neither `refunds` nor `left`; `refundsWaiting` counts the ones still going.
 */
async function checkWatch(run: Run, due: WatchDue): Promise<ReconcileItem | null> {
  const id = due.details.refundId
  const item = (outcome: ItemOutcome, reason?: string, detail?: string): ReconcileItem => ({ kind: 'refund', id, outcome, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) })
  const checked = await checkWatchedRefund(run.db, run.stripe, due, { actor: run.options.actor, requestId: run.options.requestId }, run.timing)
  if (checked.outcome === 'failed') {
    return item('refund_failed', 'refund_failed_later', checked.owed > 0 ? `the refund ${checked.status}: £${checked.owed.toFixed(2)} is owed again` : `the refund ${checked.status}: left for a person`)
  }
  if (checked.outcome === 'expired') return item('refund_failed', 'watch_expired', checked.detail)
  return null
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

/** W19: the Worker's flows, reader and saved card (a record with its `method` and `request_id`). */
const FLOWS_DUE_SQL = `
SELECT id FROM pending_reader_payments
WHERE status = 'pending' AND snapshot->>'method' IN ('reader', 'card') AND (snapshot->>'request_id') IS NOT NULL
  AND created_at < now() - make_interval(mins => $1::int)
ORDER BY created_at, id`

/** The audit entity a non-refund item's `order.reconcile` rows are written against (W21: a claim's own id). */
const entityTypeOf = (kind: ReconcileItem['kind']): ReconcileEntity =>
  kind === 'order'
    ? 'order'
    : kind === 'claim'
      ? 'refund_claim'
      : kind === 'step'
        ? 'membership_step'
        : kind === 'date_change'
          ? PAYMENT_DATE_RECONCILE_ENTITY
          : kind === 'payment_retry'
            ? PAYMENT_RETRY_RECONCILE_ENTITY
            : kind === 'plan'
              ? 'plan_change'
              : 'reader_payment'

/** W25: what a left row carries for the close (a claim's `parts`, a card flow's `payments`), as one comparable string. */
function recordKey(record: { parts?: unknown; payments?: unknown } | undefined): string {
  const parts = Array.isArray(record?.parts) ? (record.parts as Array<Partial<ClaimPartFinding>>).map((part) => `${part.orderId ?? ''}:${part.found ?? ''}`).join(',') : ''
  const payments = Array.isArray(record?.payments) ? (record.payments as unknown[]).map(String).join(',') : ''
  return `${parts}|${payments}`
}

/**
 * What makes a left item's row worth writing again: its reason, for a changed-elsewhere order its finding (W12a), and
 * (W25) what it carries for the close.
 */
const leftKey = (reason: string | undefined, finding: Partial<ChangedElsewhereFinding> | undefined, record?: { parts?: unknown; payments?: unknown }): string =>
  `${reason ?? ''}|${finding?.state ?? ''}|${finding?.amount ?? ''}|${recordKey(record)}`

/**
 * The latest reconcile row for an entity that isn't a refund's: so a left item is recorded once per reason
 * (and per finding), not every run.
 */
async function lastLeft(db: Db, entityType: string, entityId: string): Promise<string | null> {
  const row = (
    await db.query<{ details: { outcome?: string; reason?: string; finding?: Partial<ChangedElsewhereFinding>; parts?: unknown; payments?: unknown } }>(
      `SELECT details FROM audit_log WHERE entity_type = $1 AND entity_id = $2 AND action = 'order.reconcile' AND NOT (details ? 'refund')
       ORDER BY at DESC LIMIT 1`,
      [entityType, entityId]
    )
  )[0]
  return row?.details.outcome === 'left' ? leftKey(row.details.reason, row.details.finding, row.details) : null
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
    orderSwitch: runSwitch(options),
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
  const claims = await db.query<{ id: string }>(CLAIMS_DUE_SQL, [window])
  const orderClaims = await db.query<{ id: string }>(ORDER_CLAIMS_DUE_SQL, [window])
  const eventClaims = await db.query<{ id: string }>(EVENT_BOOKING_CLAIMS_DUE_SQL, [window])
  const watchedPayments = await db.query<WatchedPayment>(WATCHED_PAYMENTS_DUE_SQL, [options.paymentWatchDays ?? PAYMENT_WATCH_DAYS])
  // W41: payment date changes still pending past the window.
  const paymentDates = await db.query<{ id: string }>(PAYMENT_DATE_CHANGES_DUE_SQL, [window])
  // W47r: payments tried again from the desk, still open. W47r-a: held by the press, or (with no `held` row) past the window.
  const paymentRetries = await db.query<{ id: string }>(PAYMENT_RETRIES_DUE_SQL, [window])
  const refundCancels = await refundCancelsDue(db, SUBSCRIPTIONS_LEFT_SQL)
  // W40 (W36 review L3): at most MAX_STEPS_PER_RUN steps a run, oldest first, so steps Stripe keeps giving no answer
  // on can never take a whole run's items from the watched refunds after them. The rest wait for the next run.
  // W46: taken by when they were last tried (never tried first, then longest ago), so steps Stripe never answers
  // can't hold the front of the queue (byLastTried).
  const tried = await lastTried(db)
  const stepsWaiting = byLastTried(await stepsDue(db), (step) => step.id, tried.steps)
  const steps = stepsWaiting.slice(0, MAX_STEPS_PER_RUN)
  // W40b: wishes an earlier run could not leave again. No Stripe call, and there is one only after a database failure.
  const leaveAgains = await db.query<{ step_id: string }>(LEAVE_AGAIN_DUE_SQL)
  // W40c: closed steps due their one check against Stripe, oldest closing first, at most MAX_STEP_CHECKS_PER_RUN a run.
  // W46: by when they were last tried, as the steps.
  const checksWaiting = byLastTried(await checksDue(db), checkKey, tried.checks)
  const checks = checksWaiting.slice(0, MAX_STEP_CHECKS_PER_RUN)
  // W46: memberships with no subscription whose last day has passed (memberships/no-subscription.ts). No Stripe call.
  const endings = await membershipsToEnd(db)
  // W47r-e: memberships past their last day that have not ended here, each read in Stripe (still-live.ts): at most
  // MAX_STILL_LIVE_READS_PER_RUN a run, by when they were last read, as the checks. A read each, never a send.
  const liveWaiting = byLastTried(await stillLiveDue(db), stillLiveKey, tried.live)
  const live = liveWaiting.slice(0, MAX_STILL_LIVE_READS_PER_RUN)
  // W57 (G-plan 4.7): a plan's Stripe side past its press's window: price changes held, plans half made, plan steps
  // (an old price to archive, the product on or off sale) not refused, and products due their check.
  const planChanges = (await openChanges(db)).filter((open) => !open.inWindow)
  const planCreates = (await openCreates(db)).filter((open) => !open.inWindow)
  // W57a (W57 review S2): an old price is archived only once no pending order names it (planStepDue).
  const planSteps = (await openPlanSteps(db)).filter(planStepDue)
  const productChecks = await productChecksDue(db)
  /** W46: the steps and checks this run got to, for the row that orders the next runs. W47r-e: and the memberships read (`live`). */
  const triedNow = { steps: [] as string[], checks: [] as string[], live: [] as string[] }
  // W32a (W32 review S1): the list itself picks the watches due a read, the one read longest ago first, and no more than
  // a run can take.
  const watches = await db.query<WatchDue>(WATCHES_DUE_SQL, [options.watchDays ?? WATCH_DAYS, options.watchReadHours ?? WATCH_READ_HOURS, options.maxItems])

  /** `watch`: a read that is no item unless it ends for a person: a watched refund's (W32a), a closed step's check (W40c), a watched payment's (W47). */
  type Work = { kind: ReconcileItem['kind']; id: string; watch?: true; go: () => Promise<ReconcileItem | null> }
  const checkWork = (): Work[] =>
    checks.map((due) => ({
      kind: 'step' as const,
      id: due.stepIds[0] ?? due.membershipId,
      watch: true as const,
      go: () => {
        triedNow.checks.push(checkKey(due))
        return checkClosedSteps(run, due)
      },
    }))
  // W47r-e: with the checks, wherever they go: the same kind of work (one read, an item only when it lists).
  const liveWork = (): Work[] =>
    live.map((due) => ({
      kind: 'step' as const,
      id: due.membershipId,
      watch: true as const,
      go: () => {
        triedNow.live.push(stillLiveKey(due))
        return checkLivePastLastDay(run, due, now)
      },
    }))
  const work: Work[] = [
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
    // W25 (W21 review L5): payments watched since their change was undone by hand.
    // W47: a read that ends nothing is no item (`watch`), so nothing "waits" on it and it is never counted as left.
    ...watchedPayments.map((due) => ({ kind: 'flow' as const, id: due.entity_id, watch: true as const, go: () => checkWatchedPayment(run, due) })),
    // W21: booking refund claims held by their press.
    ...claims.map((due) => ({
      kind: 'claim' as const,
      id: due.id,
      go: async () => {
        const claim = await readClaim(db, due.id)
        if (!claim) return { kind: 'claim' as const, id: due.id, outcome: 'settled_elsewhere' as const, detail: 'gone' }
        return reconcileClaim(run, claim)
      },
    })),
    // W28: order refund claims held by their press.
    ...orderClaims.map((due) => ({
      kind: 'claim' as const,
      id: due.id,
      go: async () => {
        const claim = await readOrderClaim(db, due.id)
        if (!claim) return { kind: 'claim' as const, id: due.id, outcome: 'settled_elsewhere' as const, detail: 'gone' }
        return reconcileOrderClaim(run, claim)
      },
    })),
    // W30: event booking claims (places cancelled with a card refund) held by their press.
    ...eventClaims.map((due) => ({
      kind: 'claim' as const,
      id: due.id,
      go: async () => {
        const claim = await readEventBookingClaim(db, due.id)
        if (!claim) return { kind: 'claim' as const, id: due.id, outcome: 'settled_elsewhere' as const, detail: 'gone' }
        return reconcileEventClaim(run, claim)
      },
    })),
    // W41 (F-plan 4.10 item 1): payment date changes held, each one of the run's items inside its budget. With the
    // rest that is waiting on a customer's money, before the put-backs and the steps.
    ...paymentDates.map((due) => ({ kind: 'date_change' as const, id: due.id, go: () => reconcilePaymentDateChange(run, due.id) })),
    // W47r: payments tried again from the desk, held. Reads only. With the date changes: a member's money may have moved.
    ...paymentRetries.map((due) => ({ kind: 'payment_retry' as const, id: due.id, go: () => reconcilePaymentRetry(run, due.id) })),
    // W13c (L3): a subscription left live, which Stripe would bill again next month. W14b (W13c review L4): last, so
    // a row that never settles can't keep a run from the pending orders and flows.
    ...putBacks.map((due) => ({
      kind: 'order' as const,
      id: due.entity_id,
      go: () =>
        retryPutBack(run, { orderId: due.entity_id, subscriptionId: due.subscription_id, invoicePaymentIntentId: due.invoice_payment_intent_id, amountPaid: due.amount_paid }),
    })),
    // W29: a refunded membership's subscription still to cancel. Last, as the put-backs: a cancel Stripe keeps
    // refusing can't keep a run from anything else.
    ...refundCancels.map((due) => ({ kind: 'order' as const, id: due.orderId, go: () => retryRefundCancel(run, due) })),
    // W46: memberships with no subscription past their last day: a database change each, before anything that reads Stripe.
    ...endings.map((membershipId) => ({ kind: 'step' as const, id: membershipId, go: () => endWithoutSubscription(run, membershipId) })),
    // W36: memberships' Stripe steps left to do. After everything that is waiting on money, as the left cancels: a
    // step Stripe keeps giving no answer on can't keep a run from anything else.
    // W40c: closed steps' checks, before the run's own steps: a read each, and a wish left again here is inside its
    // window, so this run's sends leave it alone. Its id is the first closed step it covers.
    // W46 (W40c review L2): on staff's run the steps go first. It takes no new item after 15 seconds, and five slow
    // reads for checks could use that up before the step staff pressed Resolve now for. Either order is safe: a step
    // is read as open again before it is sent, and a wish a check leaves is inside its window either way.
    ...(options.actor.type === 'staff' ? [] : [...checkWork(), ...liveWork()]),
    // W40b: before the steps, so a wish left again here is in place before this run's own sends.
    ...leaveAgains.map((due) => ({ kind: 'step' as const, id: due.step_id, go: () => retryLeaveAgain(run, due.step_id) })),
    ...steps.map((due) => ({
      kind: 'step' as const,
      id: due.id,
      go: () => {
        triedNow.steps.push(due.id)
        return sendLeftStep(run, due)
      },
    })),
    ...(options.actor.type === 'staff' ? [...checkWork(), ...liveWork()] : []),
    // W57 (G-plan 4.7): after F's steps, a plan's Stripe side: a held change first (members wait on it), then a plan
    // half made, then the plan steps, then the product checks (a read each, an item only when one leaves a step).
    ...planChanges.map((open) => ({ kind: 'plan' as const, id: open.change.changeId, go: () => settlePlanChange(run, open) })),
    ...planCreates.map((open) => ({ kind: 'plan' as const, id: open.plan.planId, go: () => settlePlanCreate(run, open) })),
    ...planSteps.map((step) => ({ kind: 'plan' as const, id: step.id, go: () => sendPlanStepNow(run, step) })),
    ...productChecks.map((due) => ({ kind: 'plan' as const, id: due.planId, watch: true as const, go: () => checkPlanProduct(run, due) })),
    // W32: watched card refunds, read until they end. Last of all: a refund is watched for weeks, and must never keep
    // a run from anything that is waiting to be settled.
    ...watches.map((due) => ({ kind: 'refund' as const, id: due.details.refundId, watch: true as const, go: () => checkWatch(run, due) })),
  ]
  /** What still waits from `index` on. A watch's read is never "waiting": nothing is held up by it, and it is due again next run. */
  const waitingFrom = (index: number): number => work.slice(index).filter((next) => !next.watch).length

  const result: ReconcileResult = { checked: 0, finalised: 0, undone: 0, refunds: 0, left: 0, deferred: 0, stripeRefused: false, refundsWaiting: 0, paymentsWatched: 0, items: [] }
  // W32a: every read uses one of the run's items, a watch's included, though a watch's quiet read is not counted as checked.
  let used = 0
  for (const [index, next] of work.entries()) {
    if (used >= options.maxItems || now() - started >= options.budgetMs) {
      result.deferred = waitingFrom(index)
      break
    }
    used += 1
    let item: ReconcileItem | null
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
      const acted = item !== null && item.kind !== 'refund' && (item.outcome === 'finalised' || item.outcome === 'undone')
      if (item !== null && acted) {
        result.checked += 1
        await run.record(entityTypeOf(item.kind), item.id, { outcome: item.outcome, detail: item.detail ?? null, ...(item.warning ? { warning: item.warning } : {}) })
        if (item.outcome === 'finalised') result.finalised += 1
        if (item.outcome === 'undone') result.undone += 1
        result.items.push(forTheAnswer(item))
      }
      result.deferred = waitingFrom(acted ? index + 1 : index)
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
    // W32a (W32 review S2): a watched refund's read that ended nothing for a person.
    if (item === null) continue
    result.checked += 1
    if (item.kind !== 'refund') {
      const entityType = entityTypeOf(item.kind)
      if (item.outcome === 'left') {
        // W13a (S3): on a staff run past its Stripe deadline, the row is written without first reading the last
        // one (a read outside a transaction, bounded only by the client's 10 s), so the run stays 10 s inside
        // Retool's 60 s; at worst a reason already recorded is recorded again.
        const pastDeadline = timing !== undefined && now() >= timing.deadline
        if (pastDeadline || (await lastLeft(db, entityType, item.id)) !== leftKey(item.reason, item.finding, item.record)) {
          await run.record(entityType, item.id, { outcome: 'left', reason: item.reason, detail: item.detail ?? null, ...(item.finding ? { finding: item.finding } : {}), ...(item.record ?? {}) })
        }
      } else if (item.outcome !== 'settled_elsewhere' || (item.kind === 'step' && item.detail !== 'closed')) {
        // W40 (S1): a step a newer one had replaced is recorded with what was done about the newer one.
        // W40b: with what the item carries for its row (a step's `leaveAgain`), as a left item's.
        await run.record(entityType, item.id, { outcome: item.outcome, detail: item.detail ?? null, ...(item.warning ? { warning: item.warning } : {}), ...(item.record ?? {}) })
      }
    }
    if (item.outcome === 'finalised') result.finalised += 1
    if (item.outcome === 'undone') result.undone += 1
    if (item.outcome.startsWith('refund_')) result.refunds += 1
    // W32a (W32 review S2): a refund still on its way is nothing for a person: only one that failed (or whose watch ran out) is.
    if (item.outcome === 'left' || item.outcome === 'refund_failed') result.left += 1
    result.items.push(forTheAnswer(item))
  }
  // W40 (L3): steps over the run's cap wait for the next run, as anything over its bounds does.
  result.deferred += stepsWaiting.length - steps.length
  // W46: a run that could not get to every step and check that was due says which it did try, so the next runs take
  // the others first. Only a note for the order: a run that can't write it is answered all the same.
  if (
    (triedNow.steps.length > 0 || triedNow.checks.length > 0 || triedNow.live.length > 0) &&
    (triedNow.steps.length < stepsWaiting.length || triedNow.checks.length < checksWaiting.length || triedNow.live.length < liveWaiting.length)
  ) {
    try {
      await db.transaction((tx) =>
        audit.recordAll(tx, [{ actorType: options.actor.type, actorId: options.actor.id, action: STEPS_TRIED_ACTION, entityType: 'reconcile', entityId: options.requestId, requestId: options.requestId, details: triedNow }])
      )
    } catch {
      // The next run takes them oldest first, as before W46.
    }
  }
  try {
    result.refundsWaiting = (await db.query<{ waiting: number }>(WATCHES_WAITING_SQL))[0]?.waiting ?? 0
    // W47: the payments still watched after this run (one that ended this run is no longer counted).
    result.paymentsWatched = (await db.query<{ watched: number }>(WATCHED_PAYMENTS_COUNT_SQL))[0]?.watched ?? 0
  } catch {
    // Only a count for the screen: the run's work is done and recorded, and is answered without it.
  }
  return result
}
