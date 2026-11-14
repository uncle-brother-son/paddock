import 'server-only'
import type { z } from 'zod'
import type { ApiErrorBody, ApiErrorCode } from '@/contracts'
import { DbError } from '@/server/db'

export const ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORISED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 422,
  PAYMENT_FAILED: 402,
  PAYMENT_NEEDS_AUTHENTICATION: 402,
  SESSION_FULL: 409,
  DAY_ALREADY_BOOKED: 409,
  EVENT_SOLD_OUT: 409,
  EVENT_NOT_OPEN: 409,
  OUT_OF_STOCK: 409,
  TOTAL_CHANGED: 409,
  AGE_CONFIRMATION_REQUIRED: 422,
  CUSTOMER_NOT_LINKED: 403,
  EMAIL_NEEDS_CODE: 403,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_BUILT: 501,
  // Stripe, upstream, gave no clear answer (or the order couldn't be finished after it did).
  PAYMENT_UNCONFIRMED: 502,
  // Switched off, as NOT_BUILT: this kind of order isn't taken here yet.
  ORDER_PATH_OFF: 501,
  // W17: the same for a booking change.
  BOOKING_PATH_OFF: 501,
  // W27: the same for an order refund or an event cancel that gives money back (step E).
  REFUND_PATH_OFF: 501,
}

/** Shown when something unexpected fails. The real error goes to the log only. */
export const INTERNAL_MESSAGE = 'Something went wrong and the action may not have finished. Check before trying again.'

export interface ApiErrorExtras {
  field?: string
  item?: string
  details?: unknown
  /** For the log only, never the response. */
  logDetail?: string
}

/** The way to fail on purpose. `message` is plain English and specific: staff see it as it is. */
export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly field: string | undefined
  readonly item: string | undefined
  readonly details: unknown
  readonly logDetail: string | undefined

  constructor(code: ApiErrorCode, message: string, extras: ApiErrorExtras = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = ERROR_HTTP_STATUS[code]
    this.field = extras.field
    this.item = extras.item
    this.details = extras.details
    this.logDetail = extras.logDetail
  }

  toBody(): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.field !== undefined ? { field: this.field } : {}),
      ...(this.item !== undefined ? { item: this.item } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    }
  }
}

/** Any thrown value as an ApiError. Unknown throws become INTERNAL with the safe message. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof DbError) {
    return new ApiError('INTERNAL', err.message, { logDetail: `${err.name}: ${err.detail ?? err.message}` })
  }
  const logDetail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return new ApiError('INTERNAL', INTERNAL_MESSAGE, { logDetail })
}

/** A zod failure as VALIDATION, naming the first field at fault. */
export function validationError(error: z.ZodError): ApiError {
  const issues = error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
  const first = issues[0]
  if (!first) return new ApiError('VALIDATION', 'The request was not valid.')
  return new ApiError('VALIDATION', first.field ? `${first.field}: ${first.message}` : first.message, {
    ...(first.field ? { field: first.field } : {}),
    details: { issues },
  })
}
