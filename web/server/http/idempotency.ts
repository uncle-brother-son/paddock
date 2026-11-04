import 'server-only'
import type { Queryable } from '@/server/db'
import { ApiError } from './errors'

/**
 * Stops a double click or a retry from running a write twice. The frontend creates one key per
 * user action and sends it as Idempotency-Key.
 *
 * The first call claims the key in api_idempotency before the handler runs, and stores the
 * response after it, whether that is a success or a failure: once a handler has started, a retry
 * with the same key gets that same answer and never re-runs it. A new attempt is a new key.
 *
 * A row can stay 'in_progress' if the Worker dies part way. Its key then answers CONFLICT until
 * the row is purged, on purpose: nothing can tell how far the handler got.
 */

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/
const STRIPE_STEP = /^[A-Za-z0-9_.-]{1,64}$/

export interface IdempotencyScope {
  actorType: 'staff' | 'customer' | 'public'
  actorId: string
  endpoint: string
  key: string
}

export interface StoredResponse {
  status: number
  body: unknown
}

/** The Idempotency-Key header, which an idempotent route requires. */
export function readIdempotencyKey(headers: Headers): string {
  const key = headers.get('idempotency-key')
  if (!key) {
    throw new ApiError('VALIDATION', 'This request needs an Idempotency-Key header.', { field: 'Idempotency-Key' })
  }
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new ApiError('VALIDATION', 'The Idempotency-Key header must be 16 to 128 letters, digits, hyphens or underscores.', {
      field: 'Idempotency-Key',
    })
  }
  return key
}

/** JSON with object keys sorted at every level, so key order never changes the hash. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, sortKeys(source[key])])
  )
}

export async function hashRequest(input: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(input)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface IdempotencyRow {
  request_hash: string
  status: 'in_progress' | 'done'
  response: unknown
  http_status: number | null
}

/**
 * Claims the key. Returns null when this call owns it and should run the handler, or the stored
 * response when the same request has already finished. Throws CONFLICT while it is still running
 * and IDEMPOTENCY_MISMATCH when the key was used for a different request.
 */
export async function claimIdempotencyKey(
  db: Queryable,
  scope: IdempotencyScope,
  requestHash: string
): Promise<StoredResponse | null> {
  const claimed = await db.query<{ key: string }>(
    `INSERT INTO api_idempotency (actor_type, actor_id, endpoint, key, request_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'in_progress')
     ON CONFLICT (actor_type, actor_id, endpoint, key) DO NOTHING
     RETURNING key`,
    [scope.actorType, scope.actorId, scope.endpoint, scope.key, requestHash]
  )
  if (claimed.length > 0) return null

  const rows = await db.query<IdempotencyRow>(
    `SELECT request_hash, status, response, http_status FROM api_idempotency
     WHERE actor_type = $1 AND actor_id = $2 AND endpoint = $3 AND key = $4`,
    [scope.actorType, scope.actorId, scope.endpoint, scope.key]
  )
  const existing = rows[0]
  if (!existing) {
    throw new ApiError('CONFLICT', 'This request is already being processed')
  }
  if (existing.request_hash !== requestHash) {
    throw new ApiError('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.')
  }
  if (existing.status !== 'done' || existing.http_status === null) {
    throw new ApiError('CONFLICT', 'This request is already being processed')
  }
  return { status: existing.http_status, body: existing.response }
}

/** Stores the handler's final response against the claimed key. */
export async function completeIdempotencyKey(db: Queryable, scope: IdempotencyScope, response: StoredResponse): Promise<void> {
  await db.query(
    `UPDATE api_idempotency SET status = 'done', response = $1, http_status = $2
     WHERE actor_type = $3 AND actor_id = $4 AND endpoint = $5 AND key = $6`,
    [response.body as { [key: string]: unknown }, response.status, scope.actorType, scope.actorId, scope.endpoint, scope.key]
  )
}

/**
 * The idempotency key for one Stripe call inside a request. It stays the same however many times
 * the request is retried, and differs between the steps of one request (e.g. 'charge', 'refund').
 */
export function stripeIdempotencyKey(requestKey: string, step: string): string {
  if (!STRIPE_STEP.test(step)) throw new Error(`Invalid Stripe idempotency step: ${step}`)
  return `${requestKey}:${step}`
}
