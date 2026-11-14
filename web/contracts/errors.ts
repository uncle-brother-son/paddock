import { z } from 'zod'

/**
 * Every error code an /api/v1 endpoint can return. The website and the staff app branch on these,
 * so add to the list rather than renaming. The HTTP status for each is in server/http/errors.ts.
 */
export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHORISED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_MISMATCH',
  'PAYMENT_FAILED',
  'PAYMENT_NEEDS_AUTHENTICATION',
  'SESSION_FULL',
  'DAY_ALREADY_BOOKED',
  'EVENT_SOLD_OUT',
  'EVENT_NOT_OPEN',
  'OUT_OF_STOCK',
  'TOTAL_CHANGED',
  'AGE_CONFIRMATION_REQUIRED',
  'CUSTOMER_NOT_LINKED',
  'EMAIL_NEEDS_CODE',
  'RATE_LIMITED',
  'INTERNAL',
  /** Step C, until the slice that builds it: the order holds something the Worker can't sell yet. Nothing was touched. */
  'NOT_BUILT',
  /**
   * Step C (W10, W03-plan 2.5): the order is held pending because its card payment isn't settled: Stripe
   * gave no clear answer, or the card was charged and the order couldn't be finished. Nothing is undone;
   * reconcile decides. Never take payment again for it.
   */
  'PAYMENT_UNCONFIRMED',
  /**
   * Step C (W14, W03-plan 3.2): the order's kind is switched off on the Worker (the ORDER_SWITCH secret), so
   * nothing was touched. The staff app's createOrder runs the old code; anything else must never fall back.
   */
  'ORDER_PATH_OFF',
  /**
   * Step D (W17, D-plan 4.9, lead call L1): this kind of booking change is switched off on the Worker (the
   * ORDER_SWITCH secret's `booking_changes`, `reader_flows`, `reader`, `saved_card`), so nothing was touched. An emergency
   * stop, not a fallback: the staff app never falls back to old code for it. It covers each booking change once its
   * slice (W19 / W20 / W24) moves it to the Worker: until then the old Retool booking flows on the reader read no switch.
   */
  'BOOKING_PATH_OFF',
  /**
   * Step E (W27, E-plan 4.10, lead call L3): this kind of refund is switched off on the Worker (the ORDER_SWITCH
   * secret's `order_refunds` for an order's lines and money owed on an order, `event_cancels` for an event cancel that
   * gives money back), so nothing was touched. An emergency stop, not a fallback. No route answers it until W28 and W30.
   */
  'REFUND_PATH_OFF',
] as const

export const apiErrorCodeSchema = z.enum(ERROR_CODES)
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>
