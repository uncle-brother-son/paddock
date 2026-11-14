import { z } from 'zod'

/**
 * Step E (new in W27, E-plan 4.5, 4.7 and 4.8): the order refund routes, ahead of the slices that build them (W28
 * order refunds, W29 membership lines). Field names match the Retool function's params and result (refundOrder), so
 * the staff app's function becomes a thin call with the same name and result shape. Input is loose wherever the old
 * function answered for itself (a method is any string, the line ids any array), so the rule refuses with the old
 * reason and words instead of zod giving a generic VALIDATION (W02's lesson). `confirmed` is new: the figure staff
 * were shown (Q18), checked to half a penny before any money moves.
 * Nothing calls these routes yet (dark); each slice firms up its own output when it builds the route.
 *
 *   GET  /api/v1/staff/orders/:orderId/refund-figures        new: the dialog's sums (E1)
 *   POST /api/v1/staff/orders/:orderId/refunds               refundOrder
 *   POST /api/v1/staff/orders/:orderId/refunds/owed          new: Refund the rest on an order (Q39)
 *   POST /api/v1/staff/orders/:orderId/refunds/owed-arrived  new: It already arrived on an order (Q39)
 */

const id = z.guid()
/** Pounds, as the screens send them. Any number: the rule refuses a bad one with the old words. */
const pounds = z.number()
/** The staff app sends empty or missing optional text in both forms. */
const looseText = z.string().nullish()
/** 'card' (the original card, the rest to store credit), 'credit' (store credit) or, from W28, 'cash' (Q26). A string, for the old reason. */
const refundMethod = z.string()

const orderInPath = { orderId: id }

/** A card refund the press couldn't get a clear answer on (or couldn't record yet): held for reconcile, as step D's. */
const heldOrderRefundSchema = z.object({ claimId: z.string(), reason: z.string(), message: z.string() })

// --- GET /api/v1/staff/orders/:orderId/refund-figures

/** One line as the dialog lists it: what it cost, and what refunding it would give back now. */
export const orderRefundLineFiguresSchema = z.object({
  lineItemId: id,
  itemType: z.string(),
  /** The line's total as sold, before its promo discount. */
  lineTotal: z.number(),
  /** Its promo discount. */
  discount: z.number(),
  /** Card money the line has already had back (an earlier refund that stopped after its card part). */
  cardRefunded: z.number(),
  /** What refunding it gives back now: its total, less its discount, less the card money it has had back (E1). */
  refundable: z.number(),
  /** Already refunded: it can't be chosen. */
  refunded: z.boolean(),
  /** Why the line can't be refunded as things stand (the old reason and words), or null. */
  blocked: z.object({ reason: z.string(), message: z.string() }).nullable(),
})
export type OrderRefundLineFigures = z.infer<typeof orderRefundLineFiguresSchema>

/**
 * What the Refund Line Items dialog shows and sends back (Q18): each line's figure, what the order's card can still
 * take, the cash that can be handed back (Q26), and any money owed on the order (Q39).
 */
export const orderRefundFiguresSchema = z.object({
  orderId: id,
  paymentStatus: z.string(),
  lines: z.array(orderRefundLineFiguresSchema),
  /** The order's card money still refundable: a Card refund is capped here, the rest goes to store credit. */
  cardLeft: z.number(),
  /** The cash paid on the order less cash already handed back (Q26). */
  cashLeft: z.number(),
  /** Money still to refund on the order (Q39): Refund the rest and It already arrived act on it. */
  refundOwed: z.number(),
  /** Why no refund can start on the order as things stand (a payment or a refund still open: E2, `refund_open`), or null. */
  blocked: z.object({ reason: z.string(), message: z.string() }).nullable(),
})
export type OrderRefundFigures = z.infer<typeof orderRefundFiguresSchema>

export const orderRefundFiguresRouteInputSchema = z.object(orderInPath)

// --- POST /api/v1/staff/orders/:orderId/refunds (refundOrder)

export const orderRefundConfirmedSchema = z.object({
  /** The selected lines' total to give back, as the dialog showed it (Q18). Half a penny either way passes. */
  amount: pounds,
})
export type OrderRefundConfirmed = z.infer<typeof orderRefundConfirmedSchema>

/** refundOrder's params, with `confirmed`. Loose: the rule answers the old reasons for a missing or wrong value. */
export const refundOrderInputSchema = z.object({
  lineItemIds: z.array(z.string()).optional(),
  refundMethod: refundMethod.optional(),
  /** A yes or no for every selected product line, keyed by line item id. */
  restock: z.record(z.string(), z.boolean()).optional(),
  confirmed: orderRefundConfirmedSchema.optional(),
})
export type RefundOrderInput = z.infer<typeof refundOrderInputSchema>
export const refundOrderRouteInputSchema = refundOrderInputSchema.extend(orderInPath)

/**
 * refundOrder's answer once the claim (R1) has committed, in the old function's fields. `held`: a card refund got no
 * clear answer (or went and couldn't be recorded yet), so the claim is held for reconcile and nothing more is sent by
 * any press. `refundOwed`: money left on the order as still to refund (Q39). A refusal before anything moved is an
 * ApiError whose details carry the old reason and words (`orderRefundRefusalDetailsSchema`).
 */
export const refundOrderOutputSchema = z.object({
  refundedAmount: z.number(),
  refundMethod: z.string(),
  cardRefundedAmount: z.number().optional(),
  storeCreditRefundedAmount: z.number().optional(),
  /** Q26: cash handed back. */
  cashRefundedAmount: z.number().optional(),
  /** The customer's store credit balance after the refund (store credit part only). */
  storeCreditBalance: z.number().optional(),
  orderPaymentStatus: z.string().optional(),
  refundOwed: z.number().optional(),
  warning: z.string().optional(),
  held: heldOrderRefundSchema.optional(),
})
export type RefundOrderOutput = z.infer<typeof refundOrderOutputSchema>

// --- POST /api/v1/staff/orders/:orderId/refunds/owed and /owed-arrived (Q39)

/** Refund the rest on an order: gives what is owed to the card, store credit or cash. */
export const orderRefundOwedInputSchema = z.object({ amount: pounds, refundMethod })
export type OrderRefundOwedInput = z.infer<typeof orderRefundOwedInputSchema>
export const orderRefundOwedRouteInputSchema = orderRefundOwedInputSchema.extend(orderInPath)

/**
 * It already arrived on an order: what is owed reached the customer after all; no money moves. Any amount up to what
 * is owed (the W26 audit's row 31), with a reason.
 */
export const orderOwedArrivedInputSchema = z.object({ amount: pounds, reason: looseText })
export type OrderOwedArrivedInput = z.infer<typeof orderOwedArrivedInputSchema>
export const orderOwedArrivedRouteInputSchema = orderOwedArrivedInputSchema.extend(orderInPath)

/** What the two owed actions answer: what went where, and what is still owed on the order after. */
export const orderOwedOutputSchema = z.object({
  cardRefundedAmount: z.number(),
  storeCreditRefundedAmount: z.number(),
  cashRefundedAmount: z.number().optional(),
  storeCreditBalance: z.number().optional(),
  refundOwed: z.number(),
  warning: z.string().optional(),
  held: heldOrderRefundSchema.optional(),
})
export type OrderOwedOutput = z.infer<typeof orderOwedOutputSchema>

// --- A refusal (an ApiError's `details`)

/**
 * A refused order refund: the old function's reason and the words staff see (server/rules/refunds/failure-messages.ts),
 * so the thin wrapper puts the old result shape back (`success: false, reason, message`). With the new `figures` when
 * the confirmed amount no longer fits (Q18).
 */
export const orderRefundRefusalDetailsSchema = z.object({
  reason: z.string(),
  message: z.string(),
  action: z.enum(['refund', 'refund_owed', 'owed_arrived']),
  figures: orderRefundFiguresSchema.optional(),
  /** REFUND_PATH_OFF: the switch kinds that are off. */
  kinds: z.array(z.string()).optional(),
})
export type OrderRefundRefusalDetails = z.infer<typeof orderRefundRefusalDetailsSchema>
