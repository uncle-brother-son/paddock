import type { Db } from '@/server/db'

// W49 + W54: how step G's route tests press a real route (app/api/v1/staff/...): the shared key, the signed-in
// email, a press key, and the path's parameters, as Next hands them over. Test code only.

export const ADMIN_TEST_KEY = 'test-staff-api-key'

export type AdminErrorBody = { code: string; message: string; field?: string; details?: { reason?: string; message?: string; action?: string } }
export interface AdminAnswer<T = unknown> {
  status: number
  replayed: boolean
  ok: boolean
  data: T | undefined
  error: AdminErrorBody | undefined
  /** `details.reason` of a refusal, for a short expectation. */
  reason: string | undefined
}

export type AdminRouteHandler = (request: Request, context?: { params?: Promise<Record<string, string | string[] | undefined>> }) => Promise<Response>

export interface AdminPressOptions {
  /** The signed-in email (X-Staff-Email). Null sends none. */
  email?: string | null
  /** The press's key (Idempotency-Key). Left out, a new one; null sends none. */
  key?: string | null
  /** The shared key. Left out, the right one. */
  bearer?: string
  params?: Record<string, string>
  body?: unknown
}

/** One press of a route, answered as the staff app's callWorker would read it. */
export async function pressRoute<T = unknown>(handler: AdminRouteHandler, method: 'GET' | 'POST', options: AdminPressOptions = {}): Promise<AdminAnswer<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.bearer ?? ADMIN_TEST_KEY}`, 'content-type': 'application/json' }
  if (options.email !== null && options.email !== undefined) headers['x-staff-email'] = options.email
  const key = options.key === undefined ? crypto.randomUUID() : options.key
  if (method === 'POST' && key !== null) headers['idempotency-key'] = key
  const request = new Request('https://worker.test/api/v1/staff/under-test', { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) })
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) })
  const body = (await response.json()) as { ok: boolean; data?: T; error?: AdminErrorBody }
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', ok: body.ok, data: body.data, error: body.error, reason: body.error?.details?.reason }
}

export interface AdminAuditRow {
  action: string
  actor_type: string
  actor_id: string | null
  entity_type: string
  entity_id: string
  request_id: string | null
  details: { before?: unknown; after?: unknown; key?: string } & Record<string, unknown>
}

/** Every audit row, oldest first. */
export const auditRowsOf = (db: Db): Promise<AdminAuditRow[]> => db.query<AdminAuditRow>('SELECT action, actor_type, actor_id, entity_type, entity_id, request_id, details FROM audit_log ORDER BY at, id')
