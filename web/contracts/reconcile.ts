import { z } from 'zod'

/**
 * The Orders page's routes (W12, moved here from server/rules/orders/reconcile-contracts.ts in W14b, so the
 * staff app's generated contracts carry them): the reader flows' finalise and cancel, the manual reconcile
 * run, the stuck list, and W14b's manual close.
 */

const id = z.guid()

// --- POST /api/v1/staff/reader-flows/:pendingId/finalise and /cancel (W12; nothing calls them until step D)

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
  /** W21: `claim` is a booking refund's claim (server/rules/bookings/refunds.ts) held for reconcile. */
  kind: z.enum(['order', 'flow', 'refund', 'claim']),
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
  oldLeftAlone: z.object({ orders: z.number(), flows: z.number() }),
  stripeRefused: z.boolean(),
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
 *   is the claim's id.
 */
export const stuckCloseKindSchema = z.enum(['held_order', 'changed_elsewhere', 'subscription_left', 'late_refund', 'held_flow', 'held_claim'])
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
  /** 'reader' or 'card' for an order the Worker made; null for the old checkout's. */
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
  madeBy: z.enum(['worker', 'old']),
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
  bookingId: z.string(),
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

export const stuckListOutputSchema = z.object({
  checkout: z.array(stuckOrderSchema),
  flows: z.array(stuckFlowSchema),
  /** W21: booking refunds held for reconcile. */
  claims: z.array(stuckClaimSchema),
  refunds: z.array(stuckRefundSchema),
  warnings: z.array(stuckWarningSchema),
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
