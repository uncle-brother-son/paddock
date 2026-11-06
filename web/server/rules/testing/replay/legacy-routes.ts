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
  '/api/memberships/create-subscription': () => import('@/app/api/memberships/create-subscription/route'),
  '/api/memberships/cancel-subscription': () => import('@/app/api/memberships/cancel-subscription/route'),
  '/api/terminal/create-payment-intent': () => import('@/app/api/terminal/create-payment-intent/route'),
  '/api/terminal/payment-intent': () => import('@/app/api/terminal/payment-intent/route'),
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
