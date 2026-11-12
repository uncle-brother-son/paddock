import { vi } from 'vitest'
import type { Db, SqlParam } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'

/**
 * Runs the old functions' Worker calls through the real legacy routes, with only their edges
 * swapped: Stripe's SDK becomes the fake, and supabase-js becomes a small stand-in over the same
 * test database. So the fake sees exactly what Stripe would, at the same boundary server/stripe
 * uses, and an old run and a new run can be compared call for call.
 */

const API_KEY = 'replay-legacy-key'

type Route = { POST: (request: never) => Promise<Response> }

const ROUTES: Record<string, () => Promise<unknown>> = {
  '/api/payments/charge-saved-card': () => import('@/app/api/payments/charge-saved-card/route'),
  '/api/payments/refund-order': () => import('@/app/api/payments/refund-order/route'),
  '/api/memberships/cancel-subscription': () => import('@/app/api/memberships/cancel-subscription/route'),
  // W16: deleted from app/; the test-only copy of the old order code still calls them (legacy-order/README.md).
  '/api/memberships/create-subscription': () => import('../legacy-order/routes/memberships/create-subscription/route'),
  '/api/terminal/resolve-saved-card': () => import('../legacy-order/routes/terminal/resolve-saved-card/route'),
  '/api/terminal/create-payment-intent': () => import('@/app/api/terminal/create-payment-intent/route'),
  '/api/terminal/payment-intent': () => import('@/app/api/terminal/payment-intent/route'),
}

/** The /api/v1/staff routes the old functions call, beyond the quote shadow's own. */
const STAFF_ROUTES: Record<string, () => Promise<unknown>> = {
  '/api/v1/staff/payments/refunds': () => import('@/app/api/v1/staff/payments/refunds/route'),
  // W14: the wrappers ask the Worker first (the terminal and the saved card; createOrder and the reader's finalise
  // and cancel when a test runs the staff app's own thin calls). The quote shadow is gone (W16).
  '/api/v1/staff/orders': () => import('@/app/api/v1/staff/orders/route'),
  '/api/v1/staff/terminal/connection-token': () => import('@/app/api/v1/staff/terminal/connection-token/route'),
  '/api/v1/staff/terminal/setup-intents': () => import('@/app/api/v1/staff/terminal/setup-intents/route'),
  // W14b: the Orders page (the manual reconcile run, the stuck list and the manual close).
  '/api/v1/staff/orders/reconcile': () => import('@/app/api/v1/staff/orders/reconcile/route'),
  '/api/v1/staff/orders/stuck': () => import('@/app/api/v1/staff/orders/stuck/route'),
  '/api/v1/staff/orders/stuck/close': () => import('@/app/api/v1/staff/orders/stuck/close/route'),
}

/** W14: the staff routes with an id in the path, and the path's parameters. */
const STAFF_PATTERNS: Array<{ pattern: RegExp; load: () => Promise<unknown>; params: (match: RegExpMatchArray) => Record<string, string> }> = [
  { pattern: /^\/api\/v1\/staff\/orders\/([^/]+)\/finalise$/, load: () => import('@/app/api/v1/staff/orders/[orderId]/finalise/route'), params: (m) => ({ orderId: m[1] ?? '' }) },
  { pattern: /^\/api\/v1\/staff\/orders\/([^/]+)\/cancel$/, load: () => import('@/app/api/v1/staff/orders/[orderId]/cancel/route'), params: (m) => ({ orderId: m[1] ?? '' }) },
  { pattern: /^\/api\/v1\/staff\/customers\/([^/]+)\/saved-card$/, load: () => import('@/app/api/v1/staff/customers/[customerId]/saved-card/route'), params: (m) => ({ customerId: m[1] ?? '' }) },
  // W18: the staff app's thin setBookingSpecialRequests and setBookingStatus.
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/special-requests$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/special-requests/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
  { pattern: /^\/api\/v1\/staff\/bookings\/([^/]+)\/status$/, load: () => import('@/app/api/v1/staff/bookings/[bookingId]/status/route'), params: (m) => ({ bookingId: decodeURIComponent(m[1] ?? '') }) },
]

function staffRoute(path: string): { load: () => Promise<unknown>; params: Record<string, string> } | null {
  const exact = STAFF_ROUTES[path]
  if (exact) return { load: exact, params: {} }
  for (const { pattern, load, params } of STAFF_PATTERNS) {
    const match = path.match(pattern)
    if (match) return { load, params: params(match) }
  }
  return null
}

const active: { stripe: FakeStripe | null; db: Db | null } = { stripe: null, db: null }

/** The parts of supabase-js the legacy routes use: select, update and insert, by equal columns. */
class SupabaseQuery {
  private filters: Array<[string, unknown]> = []
  private columns = '*'
  private write: { kind: 'update' | 'insert'; row: Record<string, unknown> } | null = null

  constructor(private readonly table: string) {}

  select(columns = '*') {
    this.columns = columns
    return this
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, value])
    return this
  }
  update(row: Record<string, unknown>) {
    this.write = { kind: 'update', row }
    return this
  }
  insert(row: Record<string, unknown>) {
    this.write = { kind: 'insert', row }
    return this
  }

  private async rows(): Promise<Record<string, unknown>[]> {
    const db = active.db as Db
    const params: SqlParam[] = []
    const bind = (value: unknown) => {
      params.push(value as SqlParam)
      return `$${params.length}`
    }
    // Test data only: the table and column names are literals from the legacy routes.
    let sql: string
    if (this.write?.kind === 'insert') {
      const names = Object.keys(this.write.row)
      const values = Object.values(this.write.row).map(bind)
      sql = `INSERT INTO ${this.table} (${names.join(', ')}) VALUES (${values.join(', ')}) RETURNING *`
    } else if (this.write?.kind === 'update') {
      const sets = Object.entries(this.write.row).map(([name, value]) => `${name} = ${bind(value)}`)
      const where = this.filters.map(([name, value]) => `${name} = ${bind(value)}`)
      sql = `UPDATE ${this.table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING *`
    } else {
      const where = this.filters.map(([name, value]) => `${name} = ${bind(value)}`)
      sql = `SELECT ${this.columns} FROM ${this.table} WHERE ${where.join(' AND ')}`
    }
    return db.query(sql, params)
  }

  async single() {
    try {
      const rows = await this.rows()
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'Expected one row.' } }
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } }
    }
  }

  then<T>(resolve: (value: { data: unknown; error: { message: string } | null }) => T, reject?: (reason: unknown) => T) {
    return this.rows()
      .then((data) => ({ data, error: null }), (err: Error) => ({ data: null, error: { message: err.message } }))
      .then(resolve, reject)
  }
}

let installed = false

/** Must run before any route is imported, so the routes pick up the stand-ins. */
function install(): void {
  if (installed) return
  installed = true
  vi.doMock('stripe', async () => {
    const actual = await vi.importActual<typeof import('stripe')>('stripe')
    class StripeStandIn {
      static errors = actual.default.errors
      static createFetchHttpClient = () => undefined
      constructor() {
        if (!active.stripe) throw new Error('No fake Stripe is bound.')
        return active.stripe
      }
    }
    return { ...actual, default: StripeStandIn }
  })
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({ from: (table: string) => new SupabaseQuery(table) }),
  }))
  // The staff routes open the same test database. A test file that mocks this itself keeps its own,
  // which points at the same database.
  vi.doMock('@/server/db/connection', () => ({
    openRequestDb: () => active.db,
    closeRequestDb: () => {},
  }))
}

export interface LegacyCall {
  path: string
  method?: string
  body?: unknown
}

/** A stand-in for paddockBackendApi2.rawRequest: like the real one, it never throws on a non-2xx. */
export function bindLegacyRoutes(db: Db, stripe: FakeStripe) {
  install()
  active.db = db
  active.stripe = stripe
  vi.stubEnv('RETOOL_API_KEY', API_KEY)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://replay.test')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'replay')
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_replay')

  return async function rawRequest({ path, method = 'POST', body }: LegacyCall): Promise<{ data: unknown }> {
    const load = ROUTES[path]
    if (!load) throw new Error(`The replay harness has no legacy route ${path}.`)
    const route = (await load()) as Route
    const request = new Request(`http://replay.test${path}`, {
      method,
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const response = await route.POST(request as never)
    return { data: await response.json() }
  }
}

export interface StaffCall {
  path: string
  method?: string
  headers?: Record<string, string>
  queryParams?: Record<string, string>
  body?: unknown
}

/**
 * A stand-in for paddockWorkerV1.rawRequest, running the real /api/v1/staff route. The resource
 * adds the key, as the "Paddock Worker v1" resource does; callWorker adds who is acting. Uses the
 * key a test file already set, so its own routes keep working.
 */
export function bindStaffRoutes() {
  install()
  let key = process.env.STAFF_API_KEY
  if (!key) {
    key = 'replay-staff-key'
    vi.stubEnv('STAFF_API_KEY', key)
  }
  const staffKey = key
  return async function rawRequest({ path, method = 'GET', headers = {}, queryParams, body }: StaffCall): Promise<{ data: unknown }> {
    const found = staffRoute(path)
    if (!found) throw new Error(`The replay harness has no staff route ${path}.`)
    const route = (await found.load()) as Record<string, (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>>
    const handler = route[method]
    if (!handler) throw new Error(`${path} has no ${method}.`)
    const url = new URL(`http://replay.test${path}`)
    for (const [name, value] of Object.entries(queryParams ?? {})) url.searchParams.set(name, value)
    const response = await handler(
      new Request(url, {
        method,
        headers: { ...headers, authorization: `Bearer ${staffKey}`, 'content-type': 'application/json' },
        ...(method !== 'GET' && body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      { params: Promise.resolve(found.params) }
    )
    return { data: await response.json() }
  }
}
