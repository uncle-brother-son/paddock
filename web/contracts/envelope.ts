import { z } from 'zod'
import { apiErrorCodeSchema } from './errors'

/** The `error` object of a failed response. `message` is plain English: staff see it as it is. */
export const apiErrorBodySchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  /** The input field at fault, e.g. "guests.0.email". */
  field: z.string().optional(),
  /** The basket line or item at fault. */
  item: z.string().optional(),
  details: z.unknown().optional(),
})
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>

export const apiFailureSchema = z.object({
  ok: z.literal(false),
  error: apiErrorBodySchema,
  requestId: z.string(),
})
export type ApiFailure = z.infer<typeof apiFailureSchema>

export type ApiSuccess<TData> = { ok: true; data: TData; requestId: string }

/** Every /api/v1 response body. */
export type ApiEnvelope<TData> = ApiSuccess<TData> | ApiFailure
