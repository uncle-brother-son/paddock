import { isHtmlErrorPage } from './isHtmlErrorPage'
import type { ApiEnvelope, ApiErrorBody } from './workerContracts'

/**
 * The one way a backend function calls the Worker's /api/v1/staff routes, through the
 * "Paddock Worker v1" resource (which holds Authorization: Bearer <STAFF_API_KEY>). It adds who
 * is acting and a request id, and returns `data` from the Worker's standard response.
 *
 * Failures are thrown with the Worker's plain-English message, which staff see as it is, and the
 * code and request id in brackets for support.
 *
 * Writes need an idempotency key so a double click or retry can't run twice. The FRONTEND creates
 * one per user action and passes it through the function's params:
 *
 *   // frontend, inside the dialog: one key per press of the button
 *   const idempotencyKey = crypto.randomUUID()
 *   await cancelBooking({ bookingId, idempotencyKey }, { skipCache: true })
 *
 *   // backend function
 *   export default async function cancelBooking(req: { params: CancelBookingParams; user: User }) {
 *     return callWorker<CancelBookingOutput>(req.user, {
 *       path: '/api/v1/staff/bookings/cancel',
 *       method: 'POST',
 *       body: { bookingId: req.params.bookingId },
 *       idempotencyKey: req.params.idempotencyKey,
 *     })
 *   }
 *
 * A retry of the same action reuses the key. Pressing the button again after a shown failure is a
 * new action, so it gets a new key.
 *
 * Time limits: rawRequest has none of its own, so a hung Worker would leave a screen loading
 * forever. Reads pass `timeoutMs: READ_TIMEOUT_MS`. NEVER give a write a timeoutMs, and there is
 * deliberately no default: a write that times out may still finish, and it must never look as if
 * it failed when it may have gone through. "Read" means changes nothing, whatever the method, so
 * the POST quotes count as reads.
 */

/** How long a read waits for the Worker before staff are told to try again. */
export const READ_TIMEOUT_MS = 15_000

const TIMED_OUT_MESSAGE = "The booking system didn't answer in time. Please try again."

export interface CallWorkerOptions {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  queryParams?: Record<string, string>
  idempotencyKey?: string
  /** Reads only: see the header. Leave out for writes. */
  timeoutMs?: number
}

/** The error callWorker throws. `message` already has the code and request id in brackets. */
export class WorkerError extends Error {
  readonly code: string
  readonly requestId: string
  readonly field: string | undefined
  readonly item: string | undefined
  readonly details: unknown

  constructor(body: Pick<ApiErrorBody, 'message' | 'field' | 'item' | 'details'> & { code: string }, requestId: string) {
    super(`${body.message} (${body.code}, request ${requestId})`)
    this.name = 'WorkerError'
    this.code = body.code
    this.requestId = requestId
    this.field = body.field
    this.item = body.item
    this.details = body.details
  }
}

/** A response that isn't the standard shape, or a call that never got one. */
function noAnswer(reason: string, requestId: string): WorkerError {
  return new WorkerError({ code: 'WORKER_UNREACHABLE', message: reason }, requestId)
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (value === null || typeof value !== 'object') return false
  const ok = (value as Record<string, unknown>)['ok']
  if (ok === true) return 'data' in value
  if (ok !== false) return false
  const error = (value as Record<string, unknown>)['error']
  return error !== null && typeof error === 'object' && typeof (error as Record<string, unknown>)['message'] === 'string'
}

function unwrap<TOut>(body: unknown, requestId: string): TOut {
  if (isHtmlErrorPage(body)) {
    throw noAnswer(
      'The Worker returned an HTML page instead of a JSON response: the "Paddock Worker v1" resource is very likely misconfigured.',
      requestId
    )
  }
  if (!isEnvelope(body)) {
    throw noAnswer('The Worker sent a response the staff app could not read.', requestId)
  }
  if (body.ok) return body.data as TOut
  throw new WorkerError(body.error, body.requestId ?? requestId)
}

async function send<TOut>(user: User, options: CallWorkerOptions, requestId: string): Promise<TOut> {
  const { path, method = 'GET', body, queryParams, idempotencyKey } = options

  let response: { data: unknown }
  try {
    response = await paddockWorkerV1.rawRequest<unknown>({
      path,
      method,
      headers: {
        'X-Staff-Email': user.email,
        'X-Request-Id': requestId,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(queryParams ? { queryParams } : {}),
      ...(body !== undefined ? { body } : {}),
    })
  } catch (err) {
    // rawRequest doesn't normally throw on a non-2xx status, but the REST client can, with the
    // parsed body attached: recover the Worker's own error from it when it's there.
    const failure = err as { response?: { data?: unknown }; data?: unknown } | null
    const attached = failure?.response?.data ?? failure?.data
    if (isEnvelope(attached)) return unwrap<TOut>(attached, requestId)
    throw noAnswer(`Could not reach the Worker: ${err instanceof Error ? err.message : String(err)}`, requestId)
  }
  return unwrap<TOut>(response.data, requestId)
}

/** Fails with the "didn't answer in time" error if `work` takes longer than `ms`. An answer that
 *  arrives later is ignored. */
async function withinTimeLimit<T>(work: Promise<T>, ms: number, requestId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(noAnswer(TIMED_OUT_MESSAGE, requestId)), ms)
  })
  try {
    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

export async function callWorker<TOut>(user: User, options: CallWorkerOptions): Promise<TOut> {
  const requestId = crypto.randomUUID()
  const work = send<TOut>(user, options, requestId)
  return options.timeoutMs === undefined ? work : withinTimeLimit(work, options.timeoutMs, requestId)
}
