import { vi } from 'vitest'
import type { Db, SqlParam, Tx } from '@/server/db'
import { createRouteFactory, type RouteDeps } from './route'
import type { RequestLogEntry } from './log'

export const STAFF_KEY = 'test-staff-api-key'

export const staffRow = {
  id: 'staff-1',
  email: 'jo@example.com',
  role: 'manager',
  can_issue_refunds: true,
  can_manage_pricing: false,
  active: true,
}

interface IdempotencyRow {
  key: string
  request_hash: string
  status: string
  response: unknown
  http_status: number | null
}

/** A fake database that answers the staff lookup and keeps api_idempotency in memory. */
export function fakeDb(options: { staff?: unknown[]; failIdempotencyUpdate?: boolean } = {}) {
  const idempotency = new Map<string, IdempotencyRow>()
  const scopeKey = (params: readonly SqlParam[]) => params.slice(0, 4).join('|')

  const query = vi.fn(async (sql: string, params: readonly SqlParam[] = []): Promise<unknown[]> => {
    if (sql.includes('FROM staff')) return options.staff ?? [staffRow]
    if (sql.startsWith('INSERT INTO api_idempotency')) {
      const id = scopeKey(params)
      if (idempotency.has(id)) return []
      idempotency.set(id, {
        key: params[3] as string,
        request_hash: params[4] as string,
        status: 'in_progress',
        response: null,
        http_status: null,
      })
      return [{ key: params[3] }]
    }
    if (sql.startsWith('SELECT request_hash')) {
      const row = idempotency.get(scopeKey(params))
      return row ? [row] : []
    }
    if (sql.startsWith('UPDATE api_idempotency')) {
      if (options.failIdempotencyUpdate) throw new Error('database went away')
      const row = idempotency.get(scopeKey(params.slice(2)))
      if (row) {
        row.status = 'done'
        // The real column is jsonb: what comes back is a JSON round trip of what went in.
        row.response = JSON.parse(JSON.stringify(params[0]))
        row.http_status = params[1] as number
      }
      return []
    }
    return []
  })

  const db = {
    query,
    transaction: async <T>(fn: (tx: Tx) => Promise<T>) => fn(db as unknown as Tx),
    close: vi.fn().mockResolvedValue(undefined),
  }
  return { db: db as unknown as Db, query, idempotency, close: db.close }
}

export function testRouteFactory(db: Db, overrides: Partial<RouteDeps> = {}) {
  const logs: RequestLogEntry[] = []
  const closeDb = vi.fn()
  const defineRoute = createRouteFactory({
    openDb: () => db,
    closeDb,
    staffApiKey: () => STAFF_KEY,
    tokenVerifier: () => async () => ({ authUserId: 'auth-1' }),
    log: (entry) => logs.push(entry),
    now: () => 1000,
    validateOutput: true,
    ...overrides,
  })
  return { defineRoute, logs, closeDb }
}

export function staffRequest(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Request {
  return new Request(`https://worker.test${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${STAFF_KEY}`, 'x-staff-email': 'jo@example.com', ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}
