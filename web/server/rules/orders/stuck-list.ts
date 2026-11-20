// Ported from backend/paddock/getStuckReaderPayments.ts (new in W12): what the Orders page lists as
// stuck. Read-only. Beside the old function's two lists (checkout orders and reader flows held pending
// longer than the window), it lists what only the Worker leaves (W10 report N2, W10-3): a saved-card
// order held pending (PAYMENT_UNCONFIRMED), with no reader PaymentIntent for the old list to see; and
// for each item, what reconcile last found, in plain words. Also the automatic refunds of late payments
// until Stripe confirms them, the warnings reconcile finished an order with (W03a later 6, R6), and an
// alert when Stripe refused the key on a recent run (W10 review L4). W12a (W12 review S1): Worker orders the
// old screens moved out of pending while their payment was unconfirmed, with what reconcile found in Stripe.
// W13a: a membership subscription left live for an order that was gone (B1c), with the warnings, until put back.
import 'server-only'
import type { Db } from '@/server/db'
import { CHANGED_ELSEWHERE, CHANGED_ELSEWHERE_DAYS, CHANGED_ELSEWHERE_WHERE, changedElsewhereWords, FINAL_FINDINGS, type ChangedElsewhereFinding } from './changed-elsewhere'
import { CHANGED_SINCE_MESSAGE } from './failure-messages'
import { isWorkerCardFlow, isWorkerFlow, type FlowSnapshot } from './reader-flow'
import type { StuckCloseTarget } from '@/contracts'
import { PROCESSING_MINUTES as RECONCILE_WINDOW_MINUTES } from './pending-order'
import { MEMBERSHIP_REFUND_WORDS } from '@/server/rules/refunds/failure-messages'
import { LEFT_BY_REFUND } from './refund-subscription'
import { LATE_REFUND_STEP, WATCH_DAYS, WATCHES_LISTED_SQL, type WatchDetails } from '@/server/rules/refunds/refund-watch'
import { notLeftAgain, openSteps, stepWhat, stepWords, type StepKind } from '@/server/rules/memberships/left'
import { stillLiveListed } from '@/server/rules/memberships/still-live'
import { LEFT_STEP_WORDS, PAYMENT_DATE_STUCK_WORDS, PAYMENT_RETRY_STUCK_WORDS, PAYMENT_RETRY_WORDS, WEBHOOK_NOTICE_WORDS } from '@/server/rules/memberships/failure-messages'
import { WATCHED_PAYMENT_WORDS, WATCHED_PAYMENTS_LISTED_SQL, type ListedWatchedPayment } from './payment-watch'
import { PAYMENT_DATE_CHANGES_LISTED_SQL, PAYMENT_DATE_CLOSE_REASONS, PAYMENT_DATE_REFUND_WATCH_STEP, paymentDateListedReason, type ListedPaymentDateChange } from '@/server/rules/memberships/payment-date'
import { INVOICES_PAID_AFTER_END_LISTED_SQL, type ListedInvoicePaidAfterEnd } from '@/server/rules/memberships/paid-after-end'
import { formatIsoDate } from '@/server/rules/memberships/payment-date-status'
import { PAID_AFTER_END, PAID_AFTER_END_CLOSE_KIND, PAID_AFTER_END_OWED_KIND, PAYMENT_RETRIES_LISTED_SQL, paymentRetryListedReason, type ListedPaymentRetry } from '@/server/rules/memberships/retry-payment'

/**
 * Words for each reason an item is listed (W12's, W14b: every reason reconcile can leave an order or flow with has
 * its own, saying what staff should do; W12 review L5). A reason with none falls back to `unexpected`.
 */
const TELL_A_MANAGER = "Nothing was changed: don't take payment again, and tell a manager."
/**
 * W14c (W14b review L2): the old rollback on a Worker order. Since W14b nothing finishes it (the old sweep skips Worker
 * orders and the Worker's undo refuses it), so the words no longer send staff to Resolve now. The close says the same.
 */
export const OLD_ROLLBACK_WORDS =
  "The old screens had started cancelling this order and couldn't finish. Nothing more will be changed automatically: don't take payment again, and tell a manager."
export const STUCK_WORDS: Readonly<Record<string, string>> = {
  waiting: 'Waiting for the automatic check, which runs every 5 minutes and settles it if it can. Nothing to do yet.',
  // W25: a pending order or flow with no mark of the Worker's. None can be made any more (the old screens' code is
  // gone) and nothing settles one, so it is listed for a person.
  not_started_here: `The booking system has no record of starting this payment, so the automatic check can't settle it. ${TELL_A_MANAGER}`,
  unclear: "Stripe didn't give a clear answer about this payment. The automatic check tries again every 5 minutes: don't take payment again.",
  other_mode: `Stripe can't find this payment with the payment account the system is using now (it may be in the other Stripe mode, live or test). ${TELL_A_MANAGER}`,
  amount_mismatch: `The amount Stripe took isn't the amount expected. ${TELL_A_MANAGER}`,
  customer_mismatch: `The payment in Stripe was made for a different customer. ${TELL_A_MANAGER}`,
  metadata_mismatch: `The payment in Stripe doesn't name this order. ${TELL_A_MANAGER}`,
  currency_mismatch: `The payment in Stripe isn't in pounds. ${TELL_A_MANAGER}`,
  several_payments: `Stripe has more than one payment for this. ${TELL_A_MANAGER}`,
  changed_since: CHANGED_SINCE_MESSAGE,
  finalise_failed: "The payment went through but the order couldn't be finished yet. The automatic check tries again every 5 minutes: don't take payment again.",
  undo_failed: "This couldn't be cancelled yet (nothing was given back). The automatic check tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  // W25 (W24 noticed): a held move's undo meeting the customer's other booking (reader-flow.ts, FlowUndoBlocked).
  undo_blocked:
    "This move couldn't be undone: the customer now has another booking that clashes with putting this one back (on the same day, or at the same time). Nothing was taken for the move. Move or cancel the other booking, then press Resolve now; or tell a manager.",
  old_rollback: OLD_ROLLBACK_WORDS,
  charged_without_order: 'A payment went through for an order that had already been cancelled. It is being refunded automatically: nothing to do.',
  charged_without_record: 'A payment went through for a change that had already been undone. It is being refunded automatically: nothing to do.',
  payment_not_succeeded: "The payment hasn't gone through. The automatic check tries again every 5 minutes: don't take payment again.",
  unexpected: "Something unexpected stopped the automatic check. It tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  // W13 (W14b: the words say what to do). W14c (W14b review S1): Close order is offered only once Stripe has refused
  // every step left for good (COMPENSATION_REFUSED_WORDS); until then reconcile finishes it, also after a person has
  // done the steps in Stripe by hand (a cancelled subscription reads as cancelled, a refunded payment as refunded).
  compensation_unfinished:
    "This membership order couldn't be set up, and putting back what it took (cancelling its new subscription, refunding its payments) hasn't been confirmed yet. The automatic check tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  several_subscriptions: `Stripe has more than one subscription for this order. ${TELL_A_MANAGER}`,
  replaced_unconfirmed:
    "The new membership is paid for, but the customer's old membership couldn't be confirmed cancelled in Stripe. The automatic check tries again every 5 minutes: if this stays, tell a manager.",
  // W13a.
  subscription_starting:
    "A finalise of this order was setting up its membership in Stripe when the automatic check looked, so it was left alone. The check looks again in 5 minutes: don't take payment again.",
  // W14b (W12 review L5): the reasons that used to fall back to "something unexpected".
  unexpected_state: `This isn't in a state the automatic check expected (it may have been changed on the old screens). ${TELL_A_MANAGER}`,
  paid_by_another_payment: `This order was already paid with a different payment, and Stripe has another payment for it too. ${TELL_A_MANAGER}`,
  not_pending: 'This order is no longer waiting for payment: it was settled or changed elsewhere, so the automatic check leaves it alone. Nothing to do.',
  order_not_found: 'This order no longer exists (it was cancelled or removed in the meantime). Nothing to do.',
  not_a_reader_order: `This order isn't a card-reader order, so the automatic check couldn't settle its payment. ${TELL_A_MANAGER}`,
  intent_unconfirmed: "Its card-reader payment was never confirmed as set up. The automatic check looks for it in Stripe every 5 minutes: don't take payment again.",
  not_a_reader_flow: `This isn't a card reader payment the booking system can finish or cancel. ${TELL_A_MANAGER}`,
  rollback_started: OLD_ROLLBACK_WORDS,
  compensating:
    "This membership order is being reversed (its subscription cancelled, its payments refunded). The automatic check finishes it every 5 minutes: don't take payment again.",
  membership_not_started: "The membership's subscription couldn't be found in Stripe. The automatic check tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  payment_missing: "The membership's payment couldn't be found in Stripe. The automatic check tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  subscription_mismatch: "The membership in Stripe doesn't match this order, so it is being reversed automatically: don't take payment again. If this stays, tell a manager.",
  membership_line_missing: "This membership order is missing its membership, so it is being reversed automatically: don't take payment again. If this stays, tell a manager.",
  membership_row_missing: "This membership order is missing its membership, so it is being reversed automatically: don't take payment again. If this stays, tell a manager.",
  subscription_unconfirmed: "Stripe didn't confirm the membership's subscription. The automatic check looks again every 5 minutes: don't take payment again or start the membership again.",
  // W19: a saved-card change's payment Stripe is still working on (reconcileCardFlow).
  payment_processing: "The card payment for this change is still being processed by the bank. The automatic check looks again every 5 minutes: don't take payment again.",
  // W21: a booking refund's claim (reconcile.ts, reconcileClaim).
  several_refunds: `Stripe has more than one refund for this. ${TELL_A_MANAGER}`,
  refund_mismatch: `A refund in Stripe for this isn't the amount planned. ${TELL_A_MANAGER}`,
  finish_failed: "The refund was found in Stripe but couldn't be recorded on the booking yet. The automatic check tries again every 5 minutes: don't refund it again.",
}

/**
 * W21: a booking refund held for the automatic check (its card refund got no clear answer, or went and couldn't be
 * recorded). Nothing to do by hand while it waits: the check never sends a refund again.
 */
export const CLAIM_WAITING_WORDS =
  "A refund on this booking didn't finish cleanly. The automatic check, every 5 minutes, looks for it in Stripe and finishes it: anything Stripe never received becomes money still to refund on the booking (Refund the rest). Don't refund it again."

/** W28: the same for an order refund's claim (E-plan 4.9): what Stripe never received is left on the order. */
export const ORDER_CLAIM_WAITING_WORDS =
  "A refund on this order didn't finish cleanly. The automatic check, every 5 minutes, looks for it in Stripe and finishes it: anything Stripe never received becomes money still to refund on the order (Refund the rest). Don't refund it again."
/**
 * W30 (E-plan 4.9; W27 review L5): the same for an event booking's claim (places cancelled with a card refund). The
 * cancel's `refund_open` words send staff to the Orders page: this is the line they find there.
 */
export const EVENT_CLAIM_WAITING_WORDS =
  "A refund for cancelled event places didn't finish cleanly. The places are cancelled. The automatic check, every 5 minutes, looks for the refund in Stripe and finishes it: anything Stripe never received becomes money still to refund on the event booking (Refund the rest, on the event's attendee list). Don't refund it again."
/** W30: an event booking claim's own words where a booking claim's name the booking. */
const EVENT_CLAIM_WORDS: Readonly<Record<string, string>> = {
  finish_failed: "The refund was found in Stripe but couldn't be recorded on the event booking yet. The automatic check tries again every 5 minutes: don't refund it again.",
}
/** W28: an order claim's own words where a booking claim's name the booking. */
const ORDER_CLAIM_WORDS: Readonly<Record<string, string>> = {
  finish_failed: "The refund was found in Stripe but couldn't be recorded on the order yet. The automatic check tries again every 5 minutes: don't refund it again.",
}

/**
 * W21 (W19 review later 1): the reasons a Worker flow reconcile left for a person can be closed by hand with
 * (close-stuck.ts imports these): more than one payment, a payment that doesn't match, the other Stripe mode. A payment
 * still processing only once it has been for a day (PROCESSING_CLOSE_HOURS): before that the bank may still finish it.
 */
export const HELD_FLOW_CLOSE_REASONS: ReadonlySet<string> = new Set([
  'several_payments',
  'payment_mismatch',
  'amount_mismatch',
  'metadata_mismatch',
  'currency_mismatch',
  'customer_mismatch',
  'other_mode',
])
export const PROCESSING_CLOSE_HOURS = 24
/** W21: the reasons a held refund claim can be closed by hand with. */
export const HELD_CLAIM_CLOSE_REASONS: ReadonlySet<string> = new Set(['several_refunds', 'refund_mismatch', 'other_mode'])

/** W21: whether a flow's last reconcile reason, at its age, is one a person may close (close-stuck.ts checks it too). */
export function flowClosable(reason: string | undefined, ageMinutes: number): boolean {
  if (!reason) return false
  if (reason === 'payment_processing') return ageMinutes >= PROCESSING_CLOSE_HOURS * 60
  return HELD_FLOW_CLOSE_REASONS.has(reason)
}

/**
 * W19: a saved-card change (Settle) waiting for the automatic check. Nothing to finish or cancel by hand: the check
 * finds the payment in Stripe and finishes the change, or undoes it if nothing was taken.
 */
export const CARD_FLOW_WAITING_WORDS =
  "A saved-card payment for this booking change didn't finish cleanly. The automatic check, every 5 minutes, finds it in Stripe and finishes the change, or undoes it if nothing was taken: don't take payment again."

/**
 * W13a (B1c): a subscription the reader's finalise made for an order that was gone (or being put back), which
 * couldn't be confirmed cancelled and refunded. Listed with the warnings until it is put back. W14b: a person who has
 * put it back by hand marks it sorted; `refused`: Stripe refused a step for good, so the automatic check stopped.
 */
export const SUBSCRIPTION_LEFT_WORDS = (subscriptionId: string): string =>
  `A membership subscription (${subscriptionId}) was started in Stripe for an order that had already been cancelled, and it couldn't be confirmed cancelled yet. The automatic check tries again every 5 minutes. If this stays, cancel it in Stripe by hand and refund its first payment if it took one, then press Mark sorted (needs the Issue refunds permission).`
export const SUBSCRIPTION_REFUSED_WORDS = (subscriptionId: string): string =>
  `A membership subscription (${subscriptionId}) was started in Stripe for an order that had already been cancelled, and Stripe refused to cancel it or refund its first payment, so the automatic check has stopped trying. Cancel it in Stripe by hand and refund its first payment if it took one (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`

/**
 * W14c (W14b review S1): a held compensation whose every step left is a definite refusal by Stripe (a disputed
 * payment's refund, say): reconcile can't finish it, so a person sorts it and closes the order.
 */
export const COMPENSATION_REFUSED_WORDS =
  "This membership order couldn't be set up, and Stripe refused to finish putting back what it took (cancelling its new subscription or refunding a payment), so the automatic check can't finish it. Don't take payment again. Cancel the subscription and refund the payments in Stripe by hand (or tell a manager if Stripe won't), then press Close order (needs the Issue refunds permission)."

/** W13: added to a membership order's words while it is listed: its subscription may be live until it is settled. */
export const MEMBERSHIP_STUCK_NOTE = "This order has a membership: its subscription may be live in Stripe until this is settled, so don't start it again."

export const REFUND_PENDING_WORDS = (amount: number, paymentIntentId: string): string =>
  `A payment of £${amount.toFixed(2)} (${paymentIntentId}) went through after its order or change had been cancelled. It is being refunded automatically: waiting for Stripe to confirm the refund. Nothing to do. Don't refund it by hand.`
/** W14c (W14b N1): a failed refund is closed by hand once a person has refunded it in Stripe (`late_refund`). */
export const REFUND_FAILED_WORDS = (amount: number, paymentIntentId: string): string =>
  `A payment of £${amount.toFixed(2)} (${paymentIntentId}) went through after its order or change had been cancelled, and Stripe refused the automatic refund, so the automatic check has stopped trying. Refund it in Stripe by hand (or tell a manager if Stripe won't), then press Mark refunded (needs the Issue refunds permission).`
export const STRIPE_REFUSED_WORDS =
  "Stripe turned down the club's payment account details, so the automatic check couldn't look at any payments. Nothing has been changed. Tell a manager straight away so the Stripe connection can be fixed."

/**
 * W32: a card refund Stripe accepted and then failed, or one still pending when its watch ran out. Each says what
 * happened to the money and what to do, and ends with Mark sorted (the manual close's `refund_watch`). W32a: a late
 * payment's automatic refund has its own failed line (review S3), and the ran-out line says what to do while Stripe
 * still shows the refund pending (review S5).
 */
const MARK_SORTED = 'Then press Mark sorted (needs the Issue refunds permission).'
const pounds = (amount: number): string => `£${amount.toFixed(2)}`
export const WATCH_WORDS = {
  bookingFailed: (amount: number, refundId: string): string =>
    `A card refund of ${pounds(amount)} on this booking (${refundId}) was accepted by Stripe and then failed, so the money never reached the customer. It is back on the booking as money still to refund: open the booking and use Refund the rest. ${MARK_SORTED}`,
  orderFailed: (amount: number, refundId: string): string =>
    `A card refund of ${pounds(amount)} on this order (${refundId}) was accepted by Stripe and then failed, so the money never reached the customer. It is back on the order as money still to refund: find the order on the Orders page and use Refund the rest. ${MARK_SORTED}`,
  eventFailed: (amount: number, refundId: string): string =>
    `A card refund of ${pounds(amount)} for cancelled event places (${refundId}) was accepted by Stripe and then failed, so the money never reached the customer. The places stay cancelled, and the money is back on the event booking as money still to refund: open the event's attendee list and use Refund the rest. ${MARK_SORTED}`,
  /** W41 (FB3): the refund of a payment date change's part-month charge, after Stripe refused to move the date. */
  paymentDateFailed: (amount: number, paymentIntentId: string): string =>
    `An automatic refund of ${pounds(amount)} (payment ${paymentIntentId}) for a payment date change that Stripe refused was accepted by Stripe and then failed, so the customer has paid for a change that didn't happen and has not had the money back. Refund that payment in Stripe by hand (or tell a manager if Stripe won't). ${MARK_SORTED}`,
  compensationFailed: (amount: number, paymentIntentId: string): string =>
    `An automatic refund of ${pounds(amount)} (payment ${paymentIntentId}) for an order that couldn't be completed was accepted by Stripe and then failed, so the customer has not had the money back. Refund that payment in Stripe by hand (or tell a manager if Stripe won't). ${MARK_SORTED}`,
  /** W32a (W32 review S3): a late payment's automatic refund (its order or change was already cancelled). */
  lateFailed: (amount: number, paymentIntentId: string): string =>
    `An automatic refund of ${pounds(amount)} (payment ${paymentIntentId}) for a payment that went through after its order or change had been cancelled was accepted by Stripe and then failed, so the customer has not had the money back. Refund that payment in Stripe by hand (or tell a manager if Stripe won't). ${MARK_SORTED}`,
  /** Failed, with nothing left to put it on (the booking or order no longer exists). */
  goneFailed: (amount: number, paymentIntentId: string): string =>
    `A card refund of ${pounds(amount)} (payment ${paymentIntentId}) was accepted by Stripe and then failed, so the money never reached the customer, and what it was for no longer exists, so it can't be listed as money still to refund. Give the customer the money back by hand (refund the payment in Stripe, or add store credit), or tell a manager. ${MARK_SORTED}`,
  expired: (amount: number, refundId: string): string =>
    `A card refund of ${pounds(amount)} (${refundId}) has been waiting at Stripe for more than ${WATCH_DAYS} days, so the automatic check has stopped watching it. It is still recorded as refunded. Look at the refund in Stripe: if it went through, there is nothing more to do; if it failed, the customer has not had the money, so give it back by hand (store credit, or a refund in Stripe) and tell a manager. If Stripe still shows it pending, don't give anything back: tell a manager and leave this line until Stripe says how it ended. ${MARK_SORTED}`,
} as const

/** W32: the words for one listed watch. */
export function watchWords(watch: Pick<WatchDetails, 'on' | 'amount' | 'refundId' | 'paymentIntentId' | 'step'>, state: 'failed' | 'expired', owed: number): string {
  if (state === 'expired') return WATCH_WORDS.expired(watch.amount, watch.refundId)
  if (watch.on === 'compensation' && watch.step === PAYMENT_DATE_REFUND_WATCH_STEP) return WATCH_WORDS.paymentDateFailed(watch.amount, watch.paymentIntentId)
  if (watch.on === 'compensation') return watch.step === LATE_REFUND_STEP ? WATCH_WORDS.lateFailed(watch.amount, watch.paymentIntentId) : WATCH_WORDS.compensationFailed(watch.amount, watch.paymentIntentId)
  if (!(owed > 0)) return WATCH_WORDS.goneFailed(watch.amount, watch.paymentIntentId)
  if (watch.on === 'booking') return WATCH_WORDS.bookingFailed(watch.amount, watch.refundId)
  return watch.on === 'order' ? WATCH_WORDS.orderFailed(watch.amount, watch.refundId) : WATCH_WORDS.eventFailed(watch.amount, watch.refundId)
}

/** W14b: the changed-elsewhere findings the close accepts (close-stuck.ts says why). */
const CLOSABLE_FINDINGS: ReadonlySet<string> = new Set([...FINAL_FINDINGS, 'other_mode'])

/** W14b: the reasons a held Worker order can be closed by hand with (close-stuck.ts imports these). */
export const HELD_ORDER_CLOSE_REASONS: ReadonlySet<string> = new Set(['changed_since', 'compensation_unfinished'])

/**
 * W14c (W14b review S1, L3): true when the order's latest `order.compensate` row is held with every step left a
 * definite refusal by Stripe (membership.ts, compensateOrder). `orderIdText` is SQL for the order's id as text. The
 * close (close-stuck.ts) and the list accept `compensation_unfinished` only on that, and only on an order carrying
 * the compensation mark.
 */
export const compensationDefiniteSql = (orderIdText: string): string => `
  COALESCE((SELECT c.details->>'state' = 'held' AND c.details->>'definite' = 'true' FROM audit_log c
            WHERE c.entity_type = 'order' AND c.entity_id = ${orderIdText} AND c.action = 'order.compensate'
            ORDER BY c.at DESC, c.id DESC LIMIT 1), false)`

const wordsFor = (reason: string): string => STUCK_WORDS[reason] ?? STUCK_WORDS['unexpected'] ?? ''

export interface StuckOrder {
  orderId: string
  customerName: string
  amount: number
  paymentIntentId: string | null
  createdAt: string
  ageMinutes: number
  /** 'reader' or 'card' for an order the Worker made; null for a pending order with no mark of the Worker's (`not_started_here`). */
  method: 'reader' | 'card' | null
  reason: string
  words: string
  /** W12a (S1), a changed-elsewhere order only: its payment status now, and what reconcile last found (null: not looked yet). */
  paymentStatus?: string
  finding?: ChangedElsewhereFinding | null
  /** W14b: what the manual close does for it (close-stuck.ts); absent when nothing can be closed by hand. */
  close?: StuckCloseTarget
}

export interface StuckFlow {
  pendingId: string
  flow: 'move' | 'settle' | 'add_guest'
  recordId: string
  customerName: string
  amount: number
  createdAt: string
  ageMinutes: number
  reason: string
  words: string
  /** W21: a Worker flow reconcile left for a person (`held_flow`). */
  close?: StuckCloseTarget
}

export interface StuckClaim {
  claimId: string
  /** The booking a booking refund's claim is on; null for an order refund's (W28). */
  bookingId: string | null
  /** W28: the order an order refund's claim is on; null for a booking's. W30: for an event booking's claim, the order that paid for it. */
  orderId: string | null
  /** W30: the event booking an event place cancel's claim is on, and its event (for the attendee list); absent for the others. */
  eventBookingId?: string | null
  eventId?: string | null
  customerName: string
  /** The card money the claim planned to send. */
  amount: number
  createdAt: string
  ageMinutes: number
  reason: string
  words: string
  close?: StuckCloseTarget
}

export interface StuckRefund {
  kind: 'order' | 'flow'
  id: string
  paymentIntentId: string
  amount: number
  state: 'started' | 'sent' | 'failed' | 'waiting'
  words: string
  /** W14c (W14b N1): a refund Stripe refused can be recorded as refunded by hand. */
  close?: StuckCloseTarget
}

export interface StuckWarning {
  kind: 'order' | 'flow'
  id: string
  at: string
  warning: string
  /** W14b: a subscription left live can be marked sorted once a person has put it back in Stripe. */
  close?: StuckCloseTarget
}

/** W32: a refund that failed after Stripe accepted it, or a watch that ran out (contracts/reconcile.ts, `watched`). */
export interface StuckWatched {
  watchId: string
  refundId: string
  paymentIntentId: string
  on: WatchDetails['on']
  bookingId: string | null
  orderId: string | null
  eventBookingId: string | null
  eventId: string | null
  customerName: string | null
  amount: number
  owed: number
  state: 'failed' | 'expired'
  at: string
  words: string
  close?: StuckCloseTarget
}

/** W36 (F-plan 4.10): a membership's Stripe step left to do after its database change (memberships/left.ts). */
export interface StuckStep {
  stepId: string
  membershipId: string
  subscriptionId: string
  step: StepKind
  /**
   * W40: what it is: a cancel date to set (with `lastDay`), a cancel date to clear, or the card to charge.
   * W47r-e: or `still_live`: not a step at all, but a membership whose last day here (`lastDay`) has passed while
   * Stripe's subscription is still live (memberships/still-live.ts). `stepId` is then the line's own id, `step` is
   * `cancel_at`, `state` is `refused` (it is for a person) and it has no close: it goes when Stripe ends the subscription.
   */
  what: 'cancel_date' | 'clear_cancel_date' | 'card' | 'still_live'
  lastDay?: string
  customerId: string | null
  customerName: string | null
  /** `left`: the automatic check is still sending it. `refused`: Stripe said no for good, so it is for a person. */
  state: 'left' | 'refused'
  at: string
  words: string
  close?: StuckCloseTarget
}

/** W41 (F-plan 4.10): a membership's payment date change still pending past the window (memberships/payment-date.ts). */
export interface StuckPaymentDate {
  changeId: string
  membershipId: string
  customerId: string
  customerName: string
  newRenewalDate: string
  /** The part-month charge, in pounds. */
  amount: number
  paymentIntentId: string | null
  createdAt: string
  ageMinutes: number
  reason: string
  words: string
  close?: StuckCloseTarget
}

/**
 * W47r: a past-due membership's payment tried again from the desk that got no clear answer
 * (memberships/retry-payment.ts). It has no close: only what Stripe shows ends it. W47r-a: but for one taken after
 * the membership's subscription had ended (`paid_after_end`), which carries Mark refunded.
 * W47r-b: an invoice Stripe took a payment for after its subscription had ended, found by Stripe's notice or by a
 * press that charged nothing (memberships/paid-after-end.ts), is listed here too, the same way: reason
 * `paid_after_end`, the same close. `retryId` is then the line's own id, and no card is named.
 * W47r-c: so is a renewal Stripe took on a live subscription for a membership whose row had ended here, with words
 * that add checking the subscription.
 */
export interface StuckPaymentRetry {
  retryId: string
  membershipId: string
  customerId: string
  customerName: string
  invoiceId: string
  /** What was still to pay on the invoice, in pounds. */
  amount: number
  cardBrand: string | null
  cardLast4: string | null
  createdAt: string
  ageMinutes: number
  reason: string
  words: string
  close?: StuckCloseTarget
  /** W47r-d: Mark as owed, beside Mark refunded (only a line listed as `paid_after_end` has either). */
  closeOwed?: StuckCloseTarget
}

/** W47 (W25 review L1, L2): a payment watched after its booking change was undone by hand (payment-watch.ts). */
export interface StuckWatchedPayment {
  watchId: string
  pendingId: string
  paymentIntentId: string
  flow: string | null
  recordId: string | null
  customerName: string | null
  since: string
  /** `watching`: the automatic check has it, nothing to do. `expired`: its watch ran out, so it is for a person. */
  state: 'watching' | 'expired'
  words: string
  close?: StuckCloseTarget
}

/** W47 (W46 review L2): Stripe's notices the Worker couldn't take in, as one line. */
export interface StuckWebhookNotice {
  count: number
  oldestAt: string | null
  words: string
}

export interface StuckListOutput {
  checkout: StuckOrder[]
  flows: StuckFlow[]
  claims: StuckClaim[]
  refunds: StuckRefund[]
  warnings: StuckWarning[]
  watched: StuckWatched[]
  steps: StuckStep[]
  paymentDates: StuckPaymentDate[]
  watchedPayments: StuckWatchedPayment[]
  webhook: StuckWebhookNotice | null
  /** W47r: payments tried again from the desk, held for the automatic check. */
  paymentRetries: StuckPaymentRetry[]
  alert: { at: string; words: string } | null
}

/** How long a finished order's warning stays on the list, and a refused key's alert. */
const WARNINGS_FOR_HOURS = 24
const ALERT_FOR_MINUTES = 30

const ORDERS_SQL = `
SELECT o.id, o.order_total::text AS order_total,
       COALESCE(o.reader_payment->>'payment_intent_id', o.reader_payment->>'charge_payment_intent_id') AS payment_intent_id,
       COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) AS created_at,
       o.reader_payment->>'method' AS method,
       o.reader_payment ? 'membership' AS has_membership,
       o.reader_payment ? 'compensation' AS compensating,
       ${compensationDefiniteSql('o.id::text')} AS compensation_definite,
       c.first_name, c.last_name,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = 'order' AND r.entity_id = o.id::text AND r.action = 'order.reconcile' AND NOT (r.details ? 'refund')
        ORDER BY r.at DESC LIMIT 1) AS last
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.payment_status = 'pending' AND o.reader_payment IS NOT NULL
  AND (o.reader_payment->>'payment_intent_id' IS NOT NULL OR o.reader_payment->>'method' IN ('card', 'reader'))
  AND COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) < now() - make_interval(mins => $1::int)
ORDER BY 4, o.id`

/** W12a (S1): changed-elsewhere.ts's orders, with reconcile's last finding for each, final or not. */
const CHANGED_SQL = `
SELECT o.id, o.order_total::text AS order_total, o.payment_status,
       COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) AS created_at,
       o.reader_payment->>'method' AS method,
       c.first_name, c.last_name,
       (SELECT r.details->'finding' FROM audit_log r
        WHERE r.entity_type = 'order' AND r.entity_id = o.id::text AND r.action = 'order.reconcile' AND r.details->>'reason' = '${CHANGED_ELSEWHERE}'
        ORDER BY r.at DESC LIMIT 1) AS finding
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE ${CHANGED_ELSEWHERE_WHERE}
ORDER BY 4, o.id`

const FLOWS_SQL = `
SELECT p.id, p.flow, p.record_id, p.expected_amount::text AS expected_amount, p.created_at, p.snapshot,
       c.first_name, c.last_name,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = 'reader_payment' AND r.entity_id = p.id::text AND r.action = 'order.reconcile' AND NOT (r.details ? 'refund')
        ORDER BY r.at DESC LIMIT 1) AS last
FROM pending_reader_payments p
JOIN customers c ON c.id = (p.snapshot->>'customer_id')::uuid
WHERE p.status = 'pending' AND p.created_at < now() - make_interval(mins => $1::int)
ORDER BY p.created_at, p.id`

/** W21: Worker refund claims with no finished row, older than the window, with reconcile's last row for each. */
const CLAIMS_SQL = `
SELECT c.id, c.entity_id AS booking_id, c.at AS created_at, c.details, cu.first_name, cu.last_name,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = 'refund_claim' AND r.entity_id = c.id::text AND r.action = 'order.reconcile'
        ORDER BY r.at DESC LIMIT 1) AS last
FROM audit_log c
JOIN bookings b ON b.id::text = c.entity_id
JOIN customers cu ON cu.id = b.customer_id
WHERE c.action = 'booking.refund_claimed' AND c.entity_type = 'booking' AND c.details->>'worker' = 'true'
  AND c.at < now() - make_interval(mins => $1::int)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = 'booking.refund_finished' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at, c.id`

/** W28: the same for order refund claims (`order.refund_claimed`), with the order's customer. */
const ORDER_CLAIMS_SQL = `
SELECT c.id, c.entity_id AS order_id, c.at AS created_at, c.details, cu.first_name, cu.last_name,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = 'refund_claim' AND r.entity_id = c.id::text AND r.action = 'order.reconcile'
        ORDER BY r.at DESC LIMIT 1) AS last
FROM audit_log c
JOIN orders o ON o.id::text = c.entity_id
JOIN customers cu ON cu.id = o.customer_id
WHERE c.action = 'order.refund_claimed' AND c.entity_type = 'order' AND c.details->>'worker' = 'true'
  AND c.at < now() - make_interval(mins => $1::int)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = 'order.refund_finished' AND f.entity_type = 'order' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at, c.id`

/** W30: the same for event booking claims (`event_booking.refund_claimed`), with the booking's customer and event. */
const EVENT_CLAIMS_SQL = `
SELECT c.id, c.entity_id AS event_booking_id, eb.event_id, c.details->>'orderId' AS order_id, c.at AS created_at, c.details, cu.first_name, cu.last_name,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = 'refund_claim' AND r.entity_id = c.id::text AND r.action = 'order.reconcile'
        ORDER BY r.at DESC LIMIT 1) AS last
FROM audit_log c
JOIN event_bookings eb ON eb.id::text = c.entity_id
JOIN customers cu ON cu.id = eb.customer_id
WHERE c.action = 'event_booking.refund_claimed' AND c.entity_type = 'event_booking' AND c.details->>'worker' = 'true'
  AND c.at < now() - make_interval(mins => $1::int)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = 'event_booking.refund_finished' AND f.entity_type = 'event_booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at, c.id`

const REFUNDS_SQL = `
WITH charged AS (
  SELECT a.entity_type, a.entity_id, a.details->>'paymentIntentId' AS payment_intent_id,
         (a.details->>'amount')::numeric AS pence, min(a.at) AS first_at
  FROM audit_log a
  WHERE a.action IN ('order.charge_without_order', 'reader_payment.charge_without_record')
  GROUP BY 1, 2, 3, 4
),
latest AS (
  SELECT DISTINCT ON (r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId')
         r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId' AS payment_intent_id, r.details->'refund'->>'state' AS state,
         r.details->'refund'->>'refundId' AS refund_id
  FROM audit_log r
  WHERE r.action = 'order.reconcile' AND r.details ? 'refund'
  -- A refund's state only moves forward (started, sent, then confirmed or failed; W14c: failed, then confirmed by
  -- hand), so two rows stamped in the same millisecond are told apart by it.
  ORDER BY r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId', r.at DESC,
           CASE r.details->'refund'->>'state' WHEN 'confirmed' THEN 4 WHEN 'failed' THEN 3 WHEN 'sent' THEN 2 ELSE 1 END DESC
)
SELECT c.entity_type, c.entity_id, c.payment_intent_id, c.pence::float8 AS pence, COALESCE(l.state, 'waiting') AS state
FROM charged c
LEFT JOIN latest l ON l.entity_type = c.entity_type AND l.entity_id = c.entity_id AND l.payment_intent_id = c.payment_intent_id
WHERE (l.state IS NULL OR l.state <> 'confirmed')
  -- W32a (W32 review S3): a refund the watch has (refund-watch.ts) is the watch's: nothing while it is on its way, and
  -- the watch's own line if it fails, so one refund is never listed twice.
  AND NOT EXISTS (
    SELECT 1 FROM audit_log w
    WHERE w.action = 'refund.watch' AND w.entity_type = 'refund_watch' AND w.entity_id = l.refund_id
  )
ORDER BY c.first_at`

const WARNINGS_SQL = `
SELECT entity_type, entity_id, at, details->>'warning' AS warning
FROM audit_log
WHERE action = 'order.reconcile' AND details ? 'warning' AND at > now() - make_interval(hours => $1::int)
ORDER BY at DESC`

/**
 * W13a (B1c): each subscription left live for an order that was gone or being compensated (membership.ts,
 * putBackSubscription), until a later row says it is put back: the same row `cancelled`, or the order's
 * compensation done with that subscription cancelled. W13c: one per order and subscription, its latest `left` row
 * (T2 records the subscription as left, then the put-back, or reconcile's retry, may record it left again).
 * Reconcile retries each (L3), from what the row carries. W14b (W13c review L4): a `refused` row (Stripe refused a
 * step for good) is listed the same but never retried; the manual close's `cancelled` row closes either.
 * W29: also a refunded membership's subscription whose cancel hasn't been confirmed (`found: 'refund'`,
 * refund-subscription.ts), listed with its own words and retried by reconcile with a cancel only, never a refund.
 * W36 (lead call L7): one of those Stripe refused for good on a retry is `refused` too: listed, never retried. A
 * `refused` row is always written after the `left` row it follows, so where two share a moment (the tests' clock
 * ticks in whole milliseconds) the `refused` one is the latest.
 */
export const SUBSCRIPTIONS_LEFT_SQL = `
SELECT s.entity_id, s.at, s.details->>'subscriptionId' AS subscription_id,
       s.details->>'invoicePaymentIntentId' AS invoice_payment_intent_id, (s.details->>'amountPaid')::int AS amount_paid,
       s.details->>'state' AS state, s.details->>'found' AS found, s.details->>'claimId' AS claim_id
FROM (
  SELECT DISTINCT ON (entity_id, details->>'subscriptionId') entity_id, at, details
  FROM audit_log
  WHERE action = 'order.subscription_left' AND entity_type = 'order' AND details->>'state' IN ('left', 'refused')
  ORDER BY entity_id, details->>'subscriptionId', at DESC, (details->>'state' = 'refused') DESC
) s
WHERE NOT EXISTS (
    SELECT 1 FROM audit_log d
    WHERE d.entity_type = 'order' AND d.entity_id = s.entity_id AND d.at >= s.at
      AND d.details->>'subscriptionId' = s.details->>'subscriptionId'
      AND ((d.action = 'order.subscription_left' AND d.details->>'state' = 'cancelled')
           OR (d.action = 'order.compensate' AND d.details->>'state' = 'done'))
  )
ORDER BY s.at DESC`

/**
 * W32: who a listed watch's refund was for, and the event of an event booking's: `$1` what it is on, `$2` the booking,
 * order or event booking (as text). No row when it no longer exists.
 */
const WATCH_SUBJECT_SQL = `
SELECT c.first_name, c.last_name, s.event_id
FROM (
  SELECT b.customer_id, NULL::uuid AS event_id FROM bookings b WHERE $1::text = 'booking' AND b.id::text = $2::text
  UNION ALL
  SELECT o.customer_id, NULL::uuid FROM orders o WHERE $1::text IN ('order', 'compensation') AND o.id::text = $2::text
  UNION ALL
  -- W41: a payment date change's compensation refund names the change, which has no order.
  SELECT cm.customer_id, NULL::uuid FROM membership_payment_date_changes pd JOIN customer_memberships cm ON cm.id = pd.membership_id
  WHERE $1::text = 'compensation' AND pd.id::text = $2::text
  UNION ALL
  SELECT eb.customer_id, eb.event_id FROM event_bookings eb WHERE $1::text = 'event_booking' AND eb.id::text = $2::text
) s
JOIN customers c ON c.id = s.customer_id
LIMIT 1`

const ALERT_SQL = `
SELECT at FROM audit_log
WHERE action = 'reconcile.stripe_refused' AND entity_type = 'reconcile' AND at > now() - make_interval(mins => $1::int)
ORDER BY at DESC LIMIT 1`

/**
 * W47 (W46 review L2; W46b "Noticed" 2): Stripe's notices (`stripe_webhook_events`) that need someone told.
 * - In error, or never finished (no outcome), and received more than `$1` minutes ago. A notice that fails is sent
 *   again by Stripe for three days, and its row becomes `processed` when one goes through, so anything still here
 *   after an hour is more than a blip. A wrong Stripe API key at go-live leaves every membership notice like this
 *   (the handler can't read the subscription, so each notice ends in error). W47a (W47 review L4): a wrong webhook
 *   signing secret is not seen here. Its notices fail the signature check before any row is written, so this line
 *   has nothing to count; that one is a go-live check (a live notice's row arrives within the first hour).
 * - A live notice ignored because Stripe had no such subscription. Since W46b a live one is an error instead, so
 *   none is written today; the row says which mode it was (`detail.livemode`, from W47) so that one written by a
 *   later change would show. A test-mode one (or an older row that doesn't say) is not listed: that is test data
 *   since deleted.
 * Only notices received in the last `$2` days: Stripe keeps an event for 30 days, after which it can't be sent again,
 * so an older row can never clear and would hold the line up for ever. `not_latest_invoice` rows are not counted
 * (W46b "Noticed" 3): each is a notice correctly set aside, and belongs in the lead's own query.
 */
export const WEBHOOK_ERROR_MINUTES = 60
export const WEBHOOK_LISTED_DAYS = 30
const WEBHOOK_SQL = `
SELECT count(*)::int AS count, min(received_at) AS oldest
FROM stripe_webhook_events
WHERE received_at > now() - make_interval(days => $2::int)
  AND (((outcome = 'error' OR outcome IS NULL) AND received_at < now() - make_interval(mins => $1::int))
       OR (outcome = 'ignored' AND detail->>'reason' = 'subscription_missing' AND detail->>'livemode' = 'true'))`

interface Last {
  outcome?: string
  reason?: string
}

/** Why an item is listed: what reconcile last found, or that it hasn't looked yet, or that the Worker never started it. */
function reasonFor(madeByWorker: boolean, last: Last | null): string {
  if (!madeByWorker) return 'not_started_here'
  if (last?.outcome === 'left' && last.reason) return last.reason
  return 'waiting'
}

export async function stuckList(db: Db, { olderThanMinutes = RECONCILE_WINDOW_MINUTES, now = Date.now }: { olderThanMinutes?: number; now?: () => number } = {}): Promise<StuckListOutput> {
  const ageMinutes = (iso: string | null): number => (iso ? Math.max(0, Math.round((now() - new Date(iso).getTime()) / 60000)) : 0)
  const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ''))
  // W36: memberships' Stripe steps still open (read once: W46 sets the wishes not left again against them).
  const open = await openSteps(db)

  const orders = await db.query<{
    id: string
    order_total: string
    payment_intent_id: string | null
    created_at: unknown
    method: string | null
    has_membership: boolean | null
    compensating: boolean | null
    compensation_definite: boolean | null
    first_name: string
    last_name: string
    last: Last | null
  }>(ORDERS_SQL, [olderThanMinutes])
  const changed = await db.query<{
    id: string
    order_total: string
    payment_status: string
    created_at: unknown
    method: string
    first_name: string
    last_name: string
    finding: ChangedElsewhereFinding | null
  }>(CHANGED_SQL, [olderThanMinutes, CHANGED_ELSEWHERE_DAYS])
  const flows = await db.query<{
    id: string
    flow: string
    record_id: string
    expected_amount: string
    created_at: unknown
    snapshot: FlowSnapshot
    first_name: string
    last_name: string
    last: Last | null
  }>(FLOWS_SQL, [olderThanMinutes])
  const claims = await db.query<{
    id: string
    booking_id: string
    created_at: unknown
    details: { plan?: { card?: Array<{ amount: number }> } }
    first_name: string
    last_name: string
    last: Last | null
  }>(CLAIMS_SQL, [olderThanMinutes])
  const orderClaims = await db.query<{
    id: string
    order_id: string
    created_at: unknown
    details: { plan?: { card?: Array<{ amount: number }> } }
    first_name: string
    last_name: string
    last: Last | null
  }>(ORDER_CLAIMS_SQL, [olderThanMinutes])
  const eventClaims = await db.query<{
    id: string
    event_booking_id: string
    event_id: string
    order_id: string | null
    created_at: unknown
    details: { plan?: { card?: Array<{ amount: number }> } }
    first_name: string
    last_name: string
    last: Last | null
  }>(EVENT_CLAIMS_SQL, [olderThanMinutes])
  const refunds = await db.query<{ entity_type: string; entity_id: string; payment_intent_id: string; pence: number; state: string }>(REFUNDS_SQL)
  const warnings = await db.query<{ entity_type: string; entity_id: string; at: unknown; warning: string }>(WARNINGS_SQL, [WARNINGS_FOR_HOURS])
  const alert = (await db.query<{ at: unknown }>(ALERT_SQL, [ALERT_FOR_MINUTES]))[0]
  const subscriptionsLeft = await db.query<{ entity_id: string; at: unknown; subscription_id: string; state: string; found: string | null }>(SUBSCRIPTIONS_LEFT_SQL)
  // W41: payment date changes still pending past the window.
  const paymentDates = await db.query<ListedPaymentDateChange>(PAYMENT_DATE_CHANGES_LISTED_SQL, [olderThanMinutes, null])
  // W47r: payments tried again from the desk, still open. W47r-a: the ones a run reads (held by the press, or past the window).
  const paymentRetries = await db.query<ListedPaymentRetry>(PAYMENT_RETRIES_LISTED_SQL, [olderThanMinutes])
  // W47r-b: invoices paid after their subscription had ended, listed by the paid write and not yet marked refunded.
  const invoicesPaidAfterEnd = await db.query<ListedInvoicePaidAfterEnd>(INVOICES_PAID_AFTER_END_LISTED_SQL)
  // W32: refunds that failed after Stripe accepted them, and watches that ran out (few, if ever any: one read each for the name).
  const watches = await db.query<{ id: string; refund_id: string; details: WatchDetails; ended_at: unknown; state: 'failed' | 'expired'; ended: { owed?: number } }>(WATCHES_LISTED_SQL, [null])
  // W47: payments watched after their change was undone by hand, and watches that ran out.
  const watchedPayments = await db.query<ListedWatchedPayment>(WATCHED_PAYMENTS_LISTED_SQL, [null])
  // W47: Stripe's notices in error. A read that fails (the table can't be read) is said on the line, not thrown: the
  // rest of the list is the money, and must still show.
  let webhook: StuckWebhookNotice | null = null
  try {
    const notices = (await db.query<{ count: number; oldest: unknown }>(WEBHOOK_SQL, [WEBHOOK_ERROR_MINUTES, WEBHOOK_LISTED_DAYS]))[0]
    if (notices && notices.count > 0 && notices.oldest) webhook = { count: notices.count, oldestAt: iso(notices.oldest), words: WEBHOOK_NOTICE_WORDS.inError(notices.count, iso(notices.oldest)) }
  } catch {
    webhook = { count: 0, oldestAt: null, words: WEBHOOK_NOTICE_WORDS.unreadable }
  }
  const watched: StuckWatched[] = []
  for (const row of watches) {
    const watch = row.details
    const subject = (await db.query<{ first_name: string; last_name: string; event_id: string | null }>(WATCH_SUBJECT_SQL, [watch.on, watch.subjectId]))[0]
    const owed = Number(row.ended.owed ?? 0)
    watched.push({
      watchId: row.id,
      refundId: watch.refundId,
      paymentIntentId: watch.paymentIntentId,
      on: watch.on,
      bookingId: watch.on === 'booking' ? watch.subjectId : null,
      // W41: a payment date change's compensation refund names its change, not an order.
      orderId: watch.on === 'order' || (watch.on === 'compensation' && watch.step !== PAYMENT_DATE_REFUND_WATCH_STEP) ? watch.subjectId : watch.orderId,
      eventBookingId: watch.on === 'event_booking' ? watch.subjectId : null,
      eventId: subject?.event_id ?? null,
      customerName: subject ? `${subject.first_name} ${subject.last_name}`.trim() : null,
      amount: watch.amount,
      owed,
      state: row.state,
      at: iso(row.ended_at),
      words: watchWords(watch, row.state, owed),
      close: { kind: 'refund_watch', orderId: row.id },
    })
  }

  return {
    checkout: orders.map((row): StuckOrder => {
      const method = row.method === 'reader' || row.method === 'card' ? row.method : null
      const reason = reasonFor(method !== null, row.last)
      const createdAt = iso(row.created_at)
      // W14b: a Worker order reconcile left for a person, with the reason the close acts on (close-stuck.ts). W14c
      // (S1, L3): a compensation only with its mark and once Stripe has refused every step left for good.
      const refusedForGood = row.compensating === true && row.compensation_definite === true
      const closable =
        method !== null && row.last?.outcome === 'left' && HELD_ORDER_CLOSE_REASONS.has(reason) && (reason !== 'compensation_unfinished' || refusedForGood)
      const words = reason === 'compensation_unfinished' && refusedForGood ? COMPENSATION_REFUSED_WORDS : wordsFor(reason)
      return {
        orderId: row.id,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        amount: Number.parseFloat(row.order_total),
        paymentIntentId: row.payment_intent_id,
        createdAt,
        ageMinutes: ageMinutes(createdAt),
        method,
        reason,
        words: row.has_membership ? `${words} ${MEMBERSHIP_STUCK_NOTE}` : words,
        ...(closable ? { close: { kind: 'held_order' as const, orderId: row.id } } : {}),
      }
    }).concat(
      changed.map((row): StuckOrder => {
        const createdAt = iso(row.created_at)
        return {
          orderId: row.id,
          customerName: `${row.first_name} ${row.last_name}`.trim(),
          amount: Number.parseFloat(row.order_total),
          paymentIntentId: null,
          createdAt,
          ageMinutes: ageMinutes(createdAt),
          method: row.method === 'reader' ? 'reader' : 'card',
          reason: CHANGED_ELSEWHERE,
          words: changedElsewhereWords(row.finding),
          paymentStatus: row.payment_status,
          finding: row.finding,
          // W14b: once nothing in Stripe can still be paid for it (or only a person can check: the other mode).
          ...(row.finding && CLOSABLE_FINDINGS.has(row.finding.state) ? { close: { kind: 'changed_elsewhere' as const, orderId: row.id } } : {}),
        }
      })
    ),
    flows: flows.map((row) => {
      // W19: a saved-card flow is the Worker's too (W17 "For W19" 1), with words of its own while it waits.
      const card = isWorkerCardFlow(row.snapshot)
      const madeByWorker = card || isWorkerFlow(row.snapshot)
      const reason = reasonFor(madeByWorker, row.last)
      const createdAt = iso(row.created_at)
      const age = ageMinutes(createdAt)
      // W21: only once reconcile has left it for a person (W19 review later 1).
      const closable = madeByWorker && row.last?.outcome === 'left' && flowClosable(reason, age)
      return {
        pendingId: row.id,
        flow: row.flow as StuckFlow['flow'],
        recordId: row.record_id,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        amount: Number.parseFloat(row.expected_amount),
        createdAt,
        ageMinutes: ageMinutes(createdAt),
        reason,
        words: card && reason === 'waiting' ? CARD_FLOW_WAITING_WORDS : wordsFor(reason),
        ...(closable ? { close: { kind: 'held_flow' as const, orderId: row.id } } : {}),
      }
    }),
    claims: claims.map((row): StuckClaim => {
      const reason = reasonFor(true, row.last)
      const createdAt = iso(row.created_at)
      const amount = Math.round((row.details.plan?.card ?? []).reduce((total, part) => total + Number(part.amount), 0) * 100) / 100
      const closable = row.last?.outcome === 'left' && HELD_CLAIM_CLOSE_REASONS.has(reason)
      return {
        claimId: row.id,
        bookingId: row.booking_id,
        orderId: null,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        amount,
        createdAt,
        ageMinutes: ageMinutes(createdAt),
        reason,
        words: reason === 'waiting' ? CLAIM_WAITING_WORDS : wordsFor(reason),
        ...(closable ? { close: { kind: 'held_claim' as const, orderId: row.id } } : {}),
      }
    }).concat(
      // W28: order refund claims, after the bookings', each oldest first.
      orderClaims.map((row): StuckClaim => {
        const reason = reasonFor(true, row.last)
        const createdAt = iso(row.created_at)
        const amount = Math.round((row.details.plan?.card ?? []).reduce((total, part) => total + Number(part.amount), 0) * 100) / 100
        const closable = row.last?.outcome === 'left' && HELD_CLAIM_CLOSE_REASONS.has(reason)
        return {
          claimId: row.id,
          bookingId: null,
          orderId: row.order_id,
          customerName: `${row.first_name} ${row.last_name}`.trim(),
          amount,
          createdAt,
          ageMinutes: ageMinutes(createdAt),
          reason,
          words: reason === 'waiting' ? ORDER_CLAIM_WAITING_WORDS : (ORDER_CLAIM_WORDS[reason] ?? wordsFor(reason)),
          ...(closable ? { close: { kind: 'held_claim' as const, orderId: row.id } } : {}),
        }
      }),
      // W30: event booking claims (places cancelled with a card refund), after the orders', oldest first.
      eventClaims.map((row): StuckClaim => {
        const reason = reasonFor(true, row.last)
        const createdAt = iso(row.created_at)
        const amount = Math.round((row.details.plan?.card ?? []).reduce((total, part) => total + Number(part.amount), 0) * 100) / 100
        const closable = row.last?.outcome === 'left' && HELD_CLAIM_CLOSE_REASONS.has(reason)
        return {
          claimId: row.id,
          bookingId: null,
          orderId: row.order_id,
          eventBookingId: row.event_booking_id,
          eventId: row.event_id,
          customerName: `${row.first_name} ${row.last_name}`.trim(),
          amount,
          createdAt,
          ageMinutes: ageMinutes(createdAt),
          reason,
          words: reason === 'waiting' ? EVENT_CLAIM_WAITING_WORDS : (EVENT_CLAIM_WORDS[reason] ?? wordsFor(reason)),
          ...(closable ? { close: { kind: 'held_claim' as const, orderId: row.id } } : {}),
        }
      })
    ),
    refunds: refunds.map((row) => {
      const amount = row.pence / 100
      const state = (['started', 'sent', 'failed'].includes(row.state) ? row.state : 'waiting') as StuckRefund['state']
      return {
        kind: row.entity_type === 'order' ? 'order' : 'flow',
        id: row.entity_id,
        paymentIntentId: row.payment_intent_id,
        amount,
        state,
        words: state === 'failed' ? REFUND_FAILED_WORDS(amount, row.payment_intent_id) : REFUND_PENDING_WORDS(amount, row.payment_intent_id),
        // W14c (W14b N1): only a refund Stripe refused; one still on its way is the automatic check's.
        ...(state === 'failed' ? { close: { kind: 'late_refund' as const, orderId: row.entity_id, paymentIntentId: row.payment_intent_id } } : {}),
      }
    }),
    warnings: subscriptionsLeft
      .map(
        (row): StuckWarning => ({
          kind: 'order',
          id: row.entity_id,
          at: iso(row.at),
          warning:
            row.found === LEFT_BY_REFUND
              ? row.state === 'refused'
                ? MEMBERSHIP_REFUND_WORDS.cancelRefusedListed(row.subscription_id)
                : MEMBERSHIP_REFUND_WORDS.cancelLeftListed(row.subscription_id)
              : row.state === 'refused'
                ? SUBSCRIPTION_REFUSED_WORDS(row.subscription_id)
                : SUBSCRIPTION_LEFT_WORDS(row.subscription_id),
          close: { kind: 'subscription_left', orderId: row.entity_id, subscriptionId: row.subscription_id },
        })
      )
      .concat(warnings.map((row) => ({ kind: row.entity_type === 'order' ? 'order' : 'flow', id: row.entity_id, at: iso(row.at), warning: row.warning }))),
    watched,
    // W41 (F-plan 4.10): payment date changes still pending past the window, with what each is waiting on. Only one
    // the automatic check has left for a person can be closed by hand.
    paymentDates: paymentDates.map((row): StuckPaymentDate => {
      const reason = paymentDateListedReason(row)
      const createdAt = iso(row.created_at)
      return {
        changeId: row.id,
        membershipId: row.membership_id,
        customerId: row.customer_id,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        newRenewalDate: row.new_renewal_date,
        amount: Number.parseFloat(row.amount),
        paymentIntentId: row.stripe_payment_intent_id,
        createdAt,
        ageMinutes: ageMinutes(createdAt),
        reason,
        words: PAYMENT_DATE_STUCK_WORDS[reason] ?? wordsFor(reason),
        ...(PAYMENT_DATE_CLOSE_REASONS.has(reason) ? { close: { kind: 'held_payment_date' as const, orderId: row.id } } : {}),
      }
    }),
    // W36 (F-plan 4.10): memberships' Stripe steps left to do. Only one Stripe has refused for good can be closed by hand.
    steps: [
      ...open.map((step) => ({
        stepId: step.id,
        membershipId: step.membershipId,
        subscriptionId: step.subscriptionId,
        step: step.kind,
        // W40: what it is, and for a cancel date the last day of access it sets.
        ...stepWhat(step),
        customerId: step.customerId,
        customerName: step.customerName,
        state: step.refused ? ('refused' as const) : ('left' as const),
        at: step.at,
        words: stepWords(step),
        ...(step.refused ? { close: { kind: 'left_step' as const, orderId: step.id } } : {}),
      })),
      // W46 (W40b "Noticed" 2): a wish a run could not leave again because the database failed. The automatic check
      // tries again every run, so it has no close; it goes once a run has settled it. One whose step is still open is
      // on the list already, above.
      ...(await notLeftAgain(db))
        .filter((step) => !open.some((listed) => listed.id === step.id))
        .map((step) => ({
          stepId: step.id,
          membershipId: step.membershipId,
          subscriptionId: step.subscriptionId,
          step: step.kind,
          ...stepWhat(step),
          customerId: step.customerId,
          customerName: step.customerName,
          state: 'left' as const,
          at: step.at,
          words: LEFT_STEP_WORDS.notLeftAgain(step.subscriptionId),
        })),
      // W47r-e (W47r-d "Noticed" 3): memberships past their last day here whose subscription the automatic check found
      // still live in Stripe. For a person (a manager cancels it in Stripe), with no close: the line goes when Stripe
      // has ended the subscription.
      ...(await stillLiveListed(db)).map((line) => ({
        stepId: line.listingId,
        membershipId: line.membershipId,
        subscriptionId: line.subscriptionId,
        step: 'cancel_at' as const,
        what: 'still_live' as const,
        lastDay: line.lastDay,
        customerId: line.customerId,
        customerName: line.customerName,
        state: 'refused' as const,
        at: line.at,
        words: LEFT_STEP_WORDS.stillLive(line.customerName, line.lastDay),
      })),
    ],
    watchedPayments: watchedPayments.map((row): StuckWatchedPayment => {
      const expired = row.expired !== null
      return {
        watchId: row.id,
        pendingId: row.entity_id,
        paymentIntentId: row.payment_intent_id,
        flow: row.flow,
        recordId: row.record_id,
        customerName: row.first_name !== null && row.last_name !== null ? `${row.first_name} ${row.last_name}`.trim() : null,
        since: iso(row.at),
        state: expired ? 'expired' : 'watching',
        words: expired ? WATCHED_PAYMENT_WORDS.expired(row.payment_intent_id) : WATCHED_PAYMENT_WORDS.watching(row.payment_intent_id),
        // Only one whose watch ran out: one still watched is the automatic check's.
        ...(expired ? { close: { kind: 'payment_watch' as const, orderId: row.id } } : {}),
      }
    }),
    webhook,
    // W47r: payments tried again from the desk that got no clear answer, with what each is waiting on. None can be
    // closed by hand: the automatic check ends each one from what Stripe shows. W47r-a (W47r review S1): but one
    // taken after the subscription had ended, which is for a person: its own words, and Mark refunded.
    // W47r-b: after them, each invoice the paid write listed (Stripe's notice, or a press that charged nothing): the
    // same reason and the same Mark refunded. An invoice a retry's record holds is never among these.
    paymentRetries: [
      ...paymentRetries.map((row): StuckPaymentRetry => {
        const reason = paymentRetryListedReason(row)
        const createdAt = iso(row.created_at)
        const amount = Number.parseFloat(row.amount)
        if (reason === PAID_AFTER_END) {
          return {
            retryId: row.id,
            membershipId: row.membership_id,
            customerId: row.customer_id,
            customerName: `${row.first_name} ${row.last_name}`.trim(),
            invoiceId: row.invoice_id,
            amount,
            cardBrand: row.card_brand,
            cardLast4: row.card_last4,
            createdAt,
            ageMinutes: ageMinutes(createdAt),
            reason,
            words: PAYMENT_RETRY_WORDS.paidAfterEnd(amount, row.card_last4, row.cancelled_here === true),
            close: { kind: PAID_AFTER_END_CLOSE_KIND, orderId: row.id },
            // W47r-d: and Mark as owed, for a payment that was for a period the member had.
            closeOwed: { kind: PAID_AFTER_END_OWED_KIND, orderId: row.id },
          }
        }
        return {
          retryId: row.id,
          membershipId: row.membership_id,
          customerId: row.customer_id,
          customerName: `${row.first_name} ${row.last_name}`.trim(),
          invoiceId: row.invoice_id,
          amount,
          cardBrand: row.card_brand,
          cardLast4: row.card_last4,
          createdAt,
          ageMinutes: ageMinutes(createdAt),
          reason,
          words: PAYMENT_RETRY_STUCK_WORDS[reason] ?? PAYMENT_RETRY_STUCK_WORDS['unclear'] ?? '',
        }
      }),
      ...invoicesPaidAfterEnd.map((row): StuckPaymentRetry => {
        const createdAt = iso(row.created_at)
        const amount = Number.parseFloat(row.amount)
        return {
          retryId: row.id,
          membershipId: row.membership_id,
          customerId: row.customer_id,
          customerName: `${row.first_name} ${row.last_name}`.trim(),
          invoiceId: row.invoice_id,
          amount,
          cardBrand: null,
          cardLast4: null,
          createdAt,
          ageMinutes: ageMinutes(createdAt),
          reason: PAID_AFTER_END,
          // W47r-c: a row ended here with Stripe's subscription still live says so, and adds checking it.
          // W47r-d: one listed by the row's last day after Stripe had ended the subscription names that day.
          words: row.past_last_day ? PAYMENT_RETRY_WORDS.invoicePaidAfterLastDay(amount, formatIsoDate(row.past_last_day)) : PAYMENT_RETRY_WORDS.invoicePaidAfterEnd(amount, row.cancelled_here === true),
          close: { kind: PAID_AFTER_END_CLOSE_KIND, orderId: row.id },
          closeOwed: { kind: PAID_AFTER_END_OWED_KIND, orderId: row.id },
        }
      }),
    ],
    alert: alert ? { at: iso(alert.at), words: STRIPE_REFUSED_WORDS } : null,
  }
}
