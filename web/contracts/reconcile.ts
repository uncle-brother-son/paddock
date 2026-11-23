import { z } from 'zod'

/**
 * The Orders page's routes (W12, moved here from server/rules/orders/reconcile-contracts.ts in W14b, so the
 * staff app's generated contracts carry them): the reader flows' finalise and cancel, the manual reconcile
 * run, the stuck list, and W14b's manual close.
 */

const id = z.guid()

// --- POST /api/v1/staff/reader-flows/:pendingId/finalise and /cancel (W12; the staff app's flow wrappers since W19)

export const readerFlowInputSchema = z.object({ pendingId: id })
export type ReaderFlowInput = z.infer<typeof readerFlowInputSchema>

/** finaliseReaderPayment's answer, as data, in the old shape; W12's new reasons are in reader-flow.ts. */
export const finaliseReaderFlowOutputSchema = z.object({
  finalised: z.boolean(),
  pendingId: z.string().optional(),
  flow: z.string().optional(),
  recordId: z.string().optional(),
  paymentIntentId: z.string().optional(),
  alreadyFinalised: z.boolean().optional(),
  paymentNotSucceeded: z.boolean().optional(),
  piStatus: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  warning: z.string().optional(),
})
export type FinaliseReaderFlowOutput = z.infer<typeof finaliseReaderFlowOutputSchema>

/** cancelReaderPayment's answer, as data, in the old shape. */
export const cancelReaderFlowOutputSchema = z.object({
  cancelled: z.boolean(),
  pendingId: z.string().optional(),
  flow: z.string().optional(),
  recordId: z.string().optional(),
  alreadyDone: z.boolean().optional(),
  finalisedInstead: z.boolean().optional(),
  finaliseResult: finaliseReaderFlowOutputSchema.optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  warning: z.string().optional(),
})
export type CancelReaderFlowOutput = z.infer<typeof cancelReaderFlowOutputSchema>

// --- POST /api/v1/staff/orders/reconcile (W12: the Orders page's Resolve now, for Worker items)

export const reconcileRunInputSchema = z.object({})
export type ReconcileRunInput = z.infer<typeof reconcileRunInputSchema>

/** W12a (S1): what Stripe shows for a Worker order the old screens moved out of pending (changed-elsewhere.ts). */
export const changedElsewhereFindingSchema = z.object({
  state: z.enum(['taken', 'nothing_taken', 'open', 'unclear', 'other_mode']),
  amount: z.number(),
  paymentIntentIds: z.array(z.string()),
})
export type ChangedElsewhereFindingOutput = z.infer<typeof changedElsewhereFindingSchema>

export const reconcileItemSchema = z.object({
  /**
   * W21: `claim` is a booking refund's claim (server/rules/bookings/refunds.ts) held for reconcile. W28: or an order refund's.
   * W36: `step` is a membership's Stripe step left after its database change (server/rules/memberships/left.ts).
   * W41: `date_change` is a membership's payment date change still pending (server/rules/memberships/payment-date.ts).
   * W47r: `payment_retry` is a past-due membership's payment tried again from the desk, with no clear answer yet
   * (server/rules/memberships/retry-payment.ts). The run only reads Stripe for it.
   * W57: `plan` is a membership plan's Stripe side (server/rules/catalog/plan-stripe.ts): a price change held, a plan
   * half made, an old price to archive or the product on or off sale. Last, so the older values keep their order.
   */
  kind: z.enum(['order', 'flow', 'refund', 'claim', 'step', 'date_change', 'payment_retry', 'plan']),
  id: z.string(),
  outcome: z.enum(['finalised', 'undone', 'settled_elsewhere', 'refund_pending', 'refund_confirmed', 'refund_failed', 'left']),
  reason: z.string().optional(),
  warning: z.string().optional(),
  detail: z.string().optional(),
  finding: changedElsewhereFindingSchema.optional(),
})
export type ReconcileItemOutput = z.infer<typeof reconcileItemSchema>

export const reconcileRunOutputSchema = z.object({
  checked: z.number(),
  finalised: z.number(),
  undone: z.number(),
  refunds: z.number(),
  left: z.number(),
  deferred: z.number(),
  stripeRefused: z.boolean(),
  /**
   * W32a (W32 review S2): watched card refunds still on their way at Stripe. Nothing to do for them: they are in neither
   * `refunds` nor `left`. Absent from a Worker before W32a.
   */
  refundsWaiting: z.number().optional(),
  /**
   * W47 (W25 review L1): card payments still watched after their booking change was undone by hand: each is a line of
   * its own on the stuck list with nothing to do, and none is counted in `left`. Absent from a Worker before W47.
   */
  paymentsWatched: z.number().optional(),
  items: z.array(reconcileItemSchema),
})
export type ReconcileRunOutput = z.infer<typeof reconcileRunOutputSchema>

// --- GET /api/v1/staff/orders/stuck (W12: the Orders page's stuck list)

/**
 * W14b: what the manual close (POST /api/v1/staff/orders/stuck/close) can do for a listed item, if anything:
 * - `held_order`: a Worker order still pending that reconcile left for a person (`changed_since`, or a
 *   membership's `compensation_unfinished`): gives back what the order still holds that old code didn't, then
 *   removes the order;
 * - `changed_elsewhere`: a Worker order the old screens moved out of pending: recorded as sorted;
 * - `subscription_left`: a membership subscription left live for an order: recorded as sorted once a person has
 *   cancelled it (and refunded its first payment) in Stripe;
 * - `late_refund` (W14c, W14b N1): a late payment's automatic refund that Stripe refused, once a person has refunded
 *   it by hand: recorded as refunded. `orderId` is then the order's or the flow's id, as the refund lists it.
 * - `held_flow` (W21, W19 review later 1): a booking change's card or reader flow reconcile left for a person (more
 *   than one payment, a payment that doesn't match, the other Stripe mode, or a payment still processing after a
 *   day): W12's undo gives back everything the change held, and any payment found is named for a person to refund.
 *   `orderId` is the flow's pending id.
 * - `held_claim` (W21): a booking refund's claim reconcile left for a person: its card parts not yet recorded go on
 *   the booking as money still to refund (It already arrived, or Refund the rest), the rest as R2 gives it. `orderId`
 *   is the claim's id. W28: an order refund's claim too, with the money left on the order.
 * - `refund_watch` (W32): a card refund Stripe accepted and then failed, or one still pending when its watch ran out
 *   (`watched` on the list): recorded as sorted once a person has dealt with it. Nothing moves. `orderId` is the
 *   watch's id.
 * - `left_step` (W36, F-plan 4.10, lead call L7): a membership's Stripe step that Stripe refused for good (`steps` on
 *   the list): recorded as sorted once a person has put Stripe right by hand. Nothing moves. `orderId` is the step's id.
 * - `held_payment_date` (W41, F-plan 4.10): a membership's payment date change the automatic check has left for a
 *   person (`paymentDates` on the list): recorded as not finished, with what Stripe last showed, so the membership can
 *   be changed again. Nothing is sent to Stripe. `orderId` is the change's id.
 * - `payment_watch` (W47; W25 review L2): a payment watched after its booking change was undone by hand, whose watch
 *   ran out with Stripe still giving no clear answer (`watchedPayments` on the list): recorded as sorted once a person
 *   has looked at the payment in Stripe. Nothing moves. `orderId` is the watch's id. W47b: sorted only when Stripe
 *   still can't find the payment; when it can, the payment is handed back to the automatic check instead (answered
 *   `closed: true` with `reason: 'handed_back'`: the line for a person is gone, and the payment is watched again).
 * - `retry_paid_after_end` (W47r-a; the W47r review's S1): a membership payment tried again from the desk that was
 *   taken after the membership's subscription had ended (`paymentRetries` on the list, reason `paid_after_end`), once
 *   a person has refunded it in Stripe: Mark refunded. The payment's refunds are read in Stripe first, and it is
 *   refused unless Stripe shows the payment refunded in full. Nothing is sent. `orderId` is the retry's id.
 *   W47r-b: also the close of an invoice Stripe took a payment for after its subscription had ended, found by
 *   Stripe's notice or by a press that charged nothing (listed in `paymentRetries` the same way). `orderId` is then
 *   that line's `retryId`. W47r-c: and of a renewal Stripe took on a subscription still live there for a membership
 *   that had ended here (the same line).
 * - `paid_after_end_owed` (W47r-d): the second close of that same line (`closeOwed` on it), Mark as owed: the payment
 *   was for a period the member had, so there is nothing to refund. Recorded with the reason given. Stripe is not
 *   called and nothing is sent. `orderId` is the line's `retryId`.
 */
export const stuckCloseKindSchema = z.enum([
  'held_order',
  'changed_elsewhere',
  'subscription_left',
  'late_refund',
  'held_flow',
  'held_claim',
  'refund_watch',
  'left_step',
  'held_payment_date',
  'payment_watch',
  'retry_paid_after_end',
  'paid_after_end_owed',
  /**
   * W57: a membership plan's Stripe step that Stripe refused for good (`plans` on the list: an old price to archive,
   * or the plan's product on or off sale), once a person has put Stripe right by hand: recorded as sorted. Nothing is
   * sent. `orderId` is the step's id. Last, so the older values keep their order.
   */
  'plan_step',
  /**
   * W66a (Wayne's Q62): a membership whose subscription renews in Stripe at another interval than the membership says
   * (`steps` on the list, `what: 'frequency_mismatch'`), once a person has looked: recorded as sorted, with the reason.
   * Nothing is sent. `orderId` is the line's id (`stepId`). Last, so the older values keep their order.
   */
  'frequency_mismatch',
  /**
   * W70a (the W70 audit's L2): a membership plan deleted in Sanity that a price change kept on sale here (`plans` on the
   * list, `what: 'sanity_delete'`), once a person has looked: recorded as sorted, with the reason. The plan is not
   * changed. `orderId` is the line's id (`lineId`). Last, so the older values keep their order.
   */
  'sanity_delete',
])
export type StuckCloseKind = z.infer<typeof stuckCloseKindSchema>

export const stuckCloseTargetSchema = z.object({
  kind: stuckCloseKindSchema,
  orderId: z.string(),
  subscriptionId: z.string().optional(),
  /** W14c: a `late_refund`'s payment. */
  paymentIntentId: z.string().optional(),
})
export type StuckCloseTarget = z.infer<typeof stuckCloseTargetSchema>

export const stuckListInputSchema = z.object({ olderThanMinutes: z.coerce.number().int().min(1).optional() })
export type StuckListInput = z.infer<typeof stuckListInputSchema>

export const stuckOrderSchema = z.object({
  orderId: z.string(),
  customerName: z.string(),
  amount: z.number(),
  paymentIntentId: z.string().nullable(),
  createdAt: z.string(),
  ageMinutes: z.number(),
  /** 'reader' or 'card' for an order the Worker made; null for a pending order with no mark of the Worker's. */
  method: z.enum(['reader', 'card']).nullable(),
  reason: z.string(),
  words: z.string(),
  paymentStatus: z.string().optional(),
  finding: changedElsewhereFindingSchema.nullable().optional(),
  /** W14b: what the manual close does for it; absent when nothing can be closed by hand. */
  close: stuckCloseTargetSchema.optional(),
})
export type StuckOrderOutput = z.infer<typeof stuckOrderSchema>

export const stuckFlowSchema = z.object({
  pendingId: z.string(),
  flow: z.enum(['move', 'settle', 'add_guest']),
  recordId: z.string(),
  customerName: z.string(),
  amount: z.number(),
  createdAt: z.string(),
  ageMinutes: z.number(),
  reason: z.string(),
  words: z.string(),
  /** W21: a Worker flow reconcile left for a person can be closed by hand (`held_flow`). */
  close: stuckCloseTargetSchema.optional(),
})
export type StuckFlowOutput = z.infer<typeof stuckFlowSchema>

/**
 * W21: a booking refund's claim with no clear end yet (a card refund with no clear answer, or one that went and
 * couldn't be recorded), once older than the window. `amount` is the card money it planned to send.
 */
export const stuckClaimSchema = z.object({
  claimId: z.string(),
  /** The booking a booking refund's claim is on; null for an order refund's (W28). */
  bookingId: z.string().nullable(),
  /** W28: the order an order refund's claim is on; null for a booking's. W30: for an event booking's claim, the order that paid for it. */
  orderId: z.string().nullable(),
  /** W30: the event booking an event place cancel's claim is on, and its event (for the attendee list); absent for the others. */
  eventBookingId: z.string().nullable().optional(),
  eventId: z.string().nullable().optional(),
  customerName: z.string(),
  amount: z.number(),
  createdAt: z.string(),
  ageMinutes: z.number(),
  reason: z.string(),
  words: z.string(),
  close: stuckCloseTargetSchema.optional(),
})
export type StuckClaimOutput = z.infer<typeof stuckClaimSchema>

export const stuckRefundSchema = z.object({
  kind: z.enum(['order', 'flow']),
  id: z.string(),
  paymentIntentId: z.string(),
  amount: z.number(),
  state: z.enum(['started', 'sent', 'failed', 'waiting']),
  words: z.string(),
  /** W14c (W14b N1): a failed refund can be recorded as refunded by hand (`late_refund`). */
  close: stuckCloseTargetSchema.optional(),
})
export type StuckRefundOutput = z.infer<typeof stuckRefundSchema>

export const stuckWarningSchema = z.object({
  kind: z.enum(['order', 'flow']),
  id: z.string(),
  at: z.string(),
  warning: z.string(),
  /** W14b: a subscription left live can be recorded as sorted (`subscription_left`). */
  close: stuckCloseTargetSchema.optional(),
})
export type StuckWarningOutput = z.infer<typeof stuckWarningSchema>

/**
 * W32: a card refund Stripe accepted (W32a: whatever its first status) whose watch has ended badly: it `failed` afterwards (its money is back
 * on the booking or order as money still to refund, or, with nothing to owe it on, is for a person to give back), or
 * it was still pending when the watch ran out (`expired`). Listed until a person marks it sorted (`refund_watch`).
 */
export const stuckWatchedSchema = z.object({
  watchId: z.string(),
  refundId: z.string(),
  paymentIntentId: z.string(),
  /** What the refund was for: a booking's, an order's or an event booking's refund, or an order that couldn't be completed. */
  on: z.enum(['booking', 'order', 'event_booking', 'compensation']),
  bookingId: z.string().nullable(),
  orderId: z.string().nullable(),
  eventBookingId: z.string().nullable(),
  eventId: z.string().nullable(),
  customerName: z.string().nullable(),
  amount: z.number(),
  /** What went back on the booking or order as money still to refund (0: nothing could be, so a person gives it back). */
  owed: z.number(),
  state: z.enum(['failed', 'expired']),
  at: z.string(),
  words: z.string(),
  close: stuckCloseTargetSchema.optional(),
})
export type StuckWatchedOutput = z.infer<typeof stuckWatchedSchema>

/**
 * W36 (F-plan 4.10): a membership's Stripe step left to do after its database change (a cancel date set or cleared,
 * or its subscription moved to a replaced card): still being sent by the automatic check (`left`), or refused by
 * Stripe for good and listed for a person (`refused`, with `close`).
 */
export const stuckStepSchema = z.object({
  stepId: z.string(),
  membershipId: z.string(),
  subscriptionId: z.string(),
  /** What the step sets on the subscription. W57: `price`, a member moved to their plan's new price (last, so the older values keep their order). */
  step: z.enum(['cancel_at', 'payment_method', 'price']),
  /**
   * W40: what it is, for the screen: a cancel date to set (`cancel_date`, with `lastDay`), a cancel date to clear
   * (`clear_cancel_date`: an undo), or the card to charge (`card`).
   * W47r-e: or `still_live`: a membership whose last day here (`lastDay`) has passed while its subscription is still
   * live in Stripe, found by the automatic check. Not a step: `stepId` is the line's own id, `state` is `refused`
   * (for a person: a manager cancels the subscription in Stripe) and there is no `close`; it goes once Stripe has
   * ended the subscription. Last in the list, so the older values keep their order.
   * W57: or `plan_price`, a member's move to their plan's new price from their next renewal (step `price`).
   * W66a (Wayne's Q62): or `frequency_mismatch`: a membership whose subscription renews in Stripe at another interval
   * than the membership says, found by the automatic check's daily read. Not a step: `stepId` is the line's own id,
   * `step` is `price` (a price change would pass the member by), `state` is `refused` (for a person) and `close` is
   * Mark sorted (`frequency_mismatch`). Last in the list, so the older values keep their order.
   */
  what: z.enum(['cancel_date', 'clear_cancel_date', 'card', 'still_live', 'plan_price', 'frequency_mismatch']),
  /** `cancel_date`: the membership's last day of access the step sets (YYYY-MM-DD, London). `still_live`: the last day that has passed. */
  lastDay: z.string().optional(),
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  state: z.enum(['left', 'refused']),
  at: z.string(),
  words: z.string(),
  close: stuckCloseTargetSchema.optional(),
})
export type StuckStepOutput = z.infer<typeof stuckStepSchema>

/**
 * W41 (F-plan 4.10): a membership's payment date change still pending past the window: held for the automatic check
 * (which never charges), or left by it for a person (with `close`). `amount` is the part-month charge.
 */
export const stuckPaymentDateSchema = z.object({
  changeId: z.string(),
  membershipId: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  /** The payment date asked for (YYYY-MM-DD). */
  newRenewalDate: z.string(),
  amount: z.number(),
  /** The part-month charge's payment, once known. */
  paymentIntentId: z.string().nullable(),
  createdAt: z.string(),
  ageMinutes: z.number(),
  /** What it is waiting on. */
  reason: z.string(),
  words: z.string(),
  close: stuckCloseTargetSchema.optional(),
})
export type StuckPaymentDateOutput = z.infer<typeof stuckPaymentDateSchema>

/**
 * W47r: a past-due membership's payment tried again from the desk ("Try the payment again now") that got no clear
 * answer: held for the automatic check, which only reads Stripe (it never charges) until Stripe says how the payment
 * ended. `amount` is what was still to pay on the invoice. It has no `close`, and nothing ends it by hand, with one
 * exception (W47r-a): the reason `paid_after_end`, a payment taken after the membership's subscription had ended,
 * which a person refunds in Stripe and then closes with Mark refunded (`close`, kind `retry_paid_after_end`).
 * W47r-b: any invoice paid at or after the moment its subscription ended is listed here the same way (reason
 * `paid_after_end`, the same `close`), whether or not a press at the desk took the payment: one Stripe's own retry
 * took, or one the customer approved late, is found by Stripe's notice. For those `retryId` is the line's own id,
 * `amount` is what Stripe took for the invoice, and no card is named (`cardBrand` and `cardLast4` are null).
 * W47r-c: a renewal Stripe takes on a subscription that is still live there, for a membership that has ended here (a
 * cancel that never reached Stripe), is listed the same way, on or after the membership's last day; its `words` add
 * checking that the subscription is cancelled in Stripe. And a retry's own money taken BEFORE the end is not held
 * (it was owed): only money taken at or after the end is listed with `paid_after_end`.
 * W47r-d: with migration 031 that covers a membership whose last day has passed after Cancel was pressed here (its
 * row keeps `active` until Stripe ends the subscription). An invoice paid before its subscription ended in Stripe is
 * listed too when the membership's last day here shows the payment was on or after it. And the line has a second
 * close, `closeOwed` (kind `paid_after_end_owed`): Mark as owed, for a payment that was for a period the member had.
 */
export const stuckPaymentRetrySchema = z.object({
  retryId: z.string(),
  membershipId: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  invoiceId: z.string(),
  amount: z.number(),
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  createdAt: z.string(),
  ageMinutes: z.number(),
  /** What it is waiting on. */
  reason: z.string(),
  words: z.string(),
  /** W47r-a: Mark refunded, only for the reason `paid_after_end`. */
  close: stuckCloseTargetSchema.optional(),
  /**
   * W47r-d: Mark as owed, beside Mark refunded and only where it is. A field of its own and optional: a staff app
   * from before W47r-d reads the line exactly as before, and one with W47r-d's types still reads an older Worker's.
   */
  closeOwed: stuckCloseTargetSchema.optional(),
})
export type StuckPaymentRetryOutput = z.infer<typeof stuckPaymentRetrySchema>

/**
 * W47 (W25 review L1, L2): a card payment that was still at the bank when a person undid its booking change by hand.
 * `watching`: the automatic check reads it every run and refunds it if it goes through: nothing to do. `expired`: the
 * watch ran out with Stripe still giving no clear answer, so it is for a person (with `close`).
 */
export const stuckWatchedPaymentSchema = z.object({
  watchId: z.string(),
  /** The undone change's record (a flow's pending id). */
  pendingId: z.string(),
  paymentIntentId: z.string(),
  flow: z.string().nullable(),
  /** The booking the change was on. */
  recordId: z.string().nullable(),
  customerName: z.string().nullable(),
  /** When the watch began. */
  since: z.string(),
  state: z.enum(['watching', 'expired']),
  words: z.string(),
  close: stuckCloseTargetSchema.optional(),
})
export type StuckWatchedPaymentOutput = z.infer<typeof stuckWatchedPaymentSchema>

/**
 * W47 (W46 review L2): Stripe's notices (webhook events) the Worker couldn't take in: in error, or never finished, for
 * over an hour, and any live one ignored because Stripe had no such subscription. One line for all of them. `count`
 * is 0 with `oldestAt` null only when the notices couldn't be read at all (the words say so).
 */
export const stuckWebhookNoticeSchema = z.object({
  count: z.number(),
  oldestAt: z.string().nullable(),
  words: z.string(),
})
export type StuckWebhookNoticeOutput = z.infer<typeof stuckWebhookNoticeSchema>

/**
 * W57 (G-plan 4.7): a membership plan's own line: a price change held for the automatic check (`price_change`), a
 * plan whose Stripe set-up didn't finish (`plan_create`), or a plan step (the product on or off sale, an old price to
 * archive) left past its window or refused by Stripe for good (that one with `close`, kind `plan_step`). A member's
 * move to a new price is a membership step (`steps`, `plan_price`).
 * W70a (the W70 audit's L2): or a plan deleted in Sanity that a price change kept on sale here (`sanity_delete`, state
 * `refused`, with `close`, kind `sanity_delete`). Last in the list, so the older values keep their order.
 */
export const stuckPlanSchema = z.object({
  lineId: z.string(),
  planId: z.string(),
  planName: z.string().nullable(),
  what: z.enum(['price_change', 'plan_create', 'product_on', 'product_off', 'archive_price', 'sanity_delete']),
  state: z.enum(['left', 'refused']),
  at: z.string(),
  words: z.string(),
  close: stuckCloseTargetSchema.optional(),
})
export type StuckPlanOutput = z.infer<typeof stuckPlanSchema>

export const stuckListOutputSchema = z.object({
  checkout: z.array(stuckOrderSchema),
  flows: z.array(stuckFlowSchema),
  /** W21: booking refunds held for reconcile. */
  claims: z.array(stuckClaimSchema),
  refunds: z.array(stuckRefundSchema),
  warnings: z.array(stuckWarningSchema),
  /**
   * W32: refunds that failed after Stripe accepted them, and watches that ran out. A field of its own, so the staff
   * app published before W32 (which copies the fields it knows) reads the list exactly as before.
   */
  watched: z.array(stuckWatchedSchema),
  /**
   * W36: memberships' Stripe steps left to do. A field of its own, as `watched`: the staff app published before the
   * slice that shows it reads the list exactly as before. None can exist until W40.
   */
  steps: z.array(stuckStepSchema),
  /**
   * W41: payment date changes held. A field of its own, as `watched` and `steps`: the staff app published before W41
   * reads the list exactly as before. Optional, so a staff app with W41's types still reads an older Worker's list.
   */
  paymentDates: z.array(stuckPaymentDateSchema).optional(),
  /**
   * W47: payments watched after their change was undone by hand. A field of its own and optional, as `paymentDates`:
   * a staff app with W47's types still reads an older Worker's list, and an older staff app reads this one as before.
   */
  watchedPayments: z.array(stuckWatchedPaymentSchema).optional(),
  /** W47: Stripe's notices in error for over an hour, as one line; null with none. Optional, as `watchedPayments`. */
  webhook: stuckWebhookNoticeSchema.nullable().optional(),
  /**
   * W47r: payments tried again from the desk that got no clear answer. A field of its own and optional, as
   * `paymentDates`: a staff app with W47r's types still reads an older Worker's list, and an older staff app reads
   * this one as before.
   */
  paymentRetries: z.array(stuckPaymentRetrySchema).optional(),
  /**
   * W57: membership plans' own lines. A field of its own and optional, as `paymentRetries`: a staff app with W57's
   * types still reads an older Worker's list, and an older staff app reads this one as before.
   */
  plans: z.array(stuckPlanSchema).optional(),
  alert: z.object({ at: z.string(), words: z.string() }).nullable(),
})
export type StuckListOutput = z.infer<typeof stuckListOutputSchema>

// --- POST /api/v1/staff/orders/stuck/close (W14b: the manual close; Issue refunds)

export const closeStuckInputSchema = z
  .object({
    kind: stuckCloseKindSchema,
    orderId: id,
    subscriptionId: z.string().trim().min(1).optional(),
    paymentIntentId: z.string().trim().min(1).optional(),
    /** Why staff are closing it, kept on the audit row. */
    reason: z.string().trim().min(5, 'Say why you are closing it (at least 5 characters).').max(500),
  })
  .refine((input) => input.kind !== 'subscription_left' || input.subscriptionId !== undefined, {
    message: 'Name the subscription to record as sorted.',
    path: ['subscriptionId'],
  })
  .refine((input) => input.kind !== 'late_refund' || input.paymentIntentId !== undefined, {
    message: 'Name the payment whose refund was made by hand.',
    path: ['paymentIntentId'],
  })
export type CloseStuckInput = z.infer<typeof closeStuckInputSchema>

/**
 * The close's answer, as data: closed (or closed already, by an earlier press), or refused with nothing
 * changed. `message` is staff's words either way. For a `held_order`: what was given back, and what was left
 * as old code left it (the booking's places, its pass session and add-ons are never given back here).
 */
export const closeStuckOutputSchema = z.object({
  closed: z.boolean(),
  alreadyClosed: z.boolean().optional(),
  kind: stuckCloseKindSchema,
  orderId: z.string(),
  reason: z.string().optional(),
  message: z.string(),
  givenBack: z.array(z.string()).optional(),
  leftAsFound: z.array(z.string()).optional(),
})
export type CloseStuckOutput = z.infer<typeof closeStuckOutputSchema>
