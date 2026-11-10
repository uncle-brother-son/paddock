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
] as const

export const apiErrorCodeSchema = z.enum(ERROR_CODES)
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>
