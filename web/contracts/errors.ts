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
] as const

export const apiErrorCodeSchema = z.enum(ERROR_CODES)
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>
