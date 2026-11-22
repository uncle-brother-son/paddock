import { vi } from 'vitest'
import type { Db, SqlParam } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { bindReplayDatabase, bindStaffRoutes as bindWorkerStaffRoutes } from '../sweep/staff-routes'

/**
 * Runs the old functions' Worker calls through the real legacy routes, with only their edges
 * swapped: Stripe's SDK becomes the fake, and supabase-js becomes a small stand-in over the same
 * test database. So the fake sees exactly what Stripe would, at the same boundary server/stripe
 * uses, and an old run and a new run can be compared call for call.
 */

const API_KEY = 'replay-legacy-key'

type Route = { POST: (request: never) => Promise<Response> }

const ROUTES: Record<string, () => Promise<unknown>> = {
  // W25: deleted from app/; the test-only copy of the old step D functions still calls it (legacy-order/README.md).
  '/api/payments/charge-saved-card': () => import('../legacy-order/routes/payments/charge-saved-card/route'),
  // W34: deleted from app/; the test-only copies of the old step D and step E functions still call them.
  '/api/payments/refund-order': () => import('../legacy-order/routes/payments/refund-order/route'),
  '/api/memberships/cancel-subscription': () => import('../legacy-order/routes/memberships/cancel-subscription/route'),
  // W36: the three legacy membership routes the old step F functions call, from the frozen copy (legacy-account/README.md).
  // W44: deleted from app/; step F's golden files keep replaying through the copy.
  '/api/memberships/cancel': () => import('../legacy-account/routes/memberships/cancel/route'),
  '/api/memberships/undo-cancel': () => import('../legacy-account/routes/memberships/undo-cancel/route'),
  '/api/memberships/change-payment-date': () => import('../legacy-account/routes/memberships/change-payment-date/route'),
  // W48: the seven legacy catalogue routes the old step G functions call, from the frozen copy (legacy-admin/README.md),
  // so step G's golden files keep replaying now that W61 has deleted the live ones from app/api/catalog.
  '/api/catalog/toggle-active': () => import('../legacy-admin/routes/catalog/toggle-active/route'),
  '/api/catalog/update-price': () => import('../legacy-admin/routes/catalog/update-price/route'),
  '/api/catalog/update-tier-price': () => import('../legacy-admin/routes/catalog/update-tier-price/route'),
  '/api/catalog/create-variant': () => import('../legacy-admin/routes/catalog/create-variant/route'),
  '/api/catalog/sync-stripe': () => import('../legacy-admin/routes/catalog/sync-stripe/route'),
  '/api/catalog/create-gift-card-preset': () => import('../legacy-admin/routes/catalog/create-gift-card-preset/route'),
  '/api/catalog/update-gift-card-preset-price': () => import('../legacy-admin/routes/catalog/update-gift-card-preset-price/route'),
  // W16: deleted from app/; the test-only copy of the old order code still calls them (legacy-order/README.md).
  '/api/memberships/create-subscription': () => import('../legacy-order/routes/memberships/create-subscription/route'),
  '/api/terminal/resolve-saved-card': () => import('../legacy-order/routes/terminal/resolve-saved-card/route'),
  // W25: these two as well.
  '/api/terminal/create-payment-intent': () => import('../legacy-order/routes/terminal/create-payment-intent/route'),
  '/api/terminal/payment-intent': () => import('../legacy-order/routes/terminal/payment-intent/route'),
}

const active: { stripe: FakeStripe | null; db: Db | null } = { stripe: null, db: null }

/**
 * The parts of supabase-js the legacy routes use: select, update and insert, by equal columns. W48: and what the
 * legacy update-price route's member look-up adds: `.in(column, values)` and `.not(column, 'is', null)`.
 */
class SupabaseQuery {
  private filters: Array<[string, unknown]> = []
  /** W48: conditions that aren't "equals": each a SQL fragment and the values it binds, in order. */
  private conditions: Array<{ sql: (bind: (value: unknown) => string) => string }> = []
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
  in(column: string, values: unknown[]) {
    this.conditions.push({ sql: (bind) => `${column} IN (${values.map(bind).join(', ')})` })
    return this
  }
  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is' || value !== null) throw new Error("The supabase stand-in has only modelled .not(column, 'is', null).")
    this.conditions.push({ sql: () => `${column} IS NOT NULL` })
    return this
  }
  update(row: Record<string, unknown>) {
    this.write = { kind: 'update', row: withoutUndefined(row) }
    return this
  }
  insert(row: Record<string, unknown>) {
    this.write = { kind: 'insert', row: withoutUndefined(row) }
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
      const where = [...this.filters.map(([name, value]) => `${name} = ${bind(value)}`), ...this.conditions.map((condition) => condition.sql(bind))]
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

/** W48: a field set to `undefined` is not sent, as supabase-js's JSON body leaves it out (create-variant's `price_override`). */
const withoutUndefined = (row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))

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
  // The staff routes open the same test database (W64: bound in ../sweep/staff-routes.ts, bindLegacyRoutes below).
}

export interface LegacyCall {
  path: string
  method?: string
  body?: unknown
}

/** A stand-in for paddockBackendApi2.rawRequest: like the real one, it never throws on a non-2xx. */
export function bindLegacyRoutes(db: Db, stripe: FakeStripe) {
  install()
  bindReplayDatabase(db)
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

/**
 * A stand-in for paddockWorkerV1.rawRequest (W64: ../sweep/staff-routes.ts), with the one /api/v1/staff route only the
 * frozen copies call: W34 deleted it from app/; the old refund code's look-up by key (shared/stripeRefundLookup in the
 * frozen copies) still calls it.
 */
export function bindStaffRoutes() {
  return bindWorkerStaffRoutes(undefined, {
    '/api/v1/staff/payments/refunds': () => import('../legacy-order/routes/v1/staff/payments/refunds/route'),
  })
}
