import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { createDb, type Db } from '@/server/db/client'
import { createPostgresDriver } from '@/server/db/postgres-driver'

export interface TestDatabase {
  /** The Worker's real Db and driver, connected as a role set up like paddock_worker. */
  db: Db
  /** Straight to PGlite, for what the worker login can't do (dropping a table). */
  pg: PGlite
  stop(): Promise<void>
}

/**
 * A real Postgres (PGlite) with the live schema for the rules (testing/schema.sql), reached over a
 * socket through the real driver, so column types and parameters behave as in production.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const pg = await PGlite.create({ extensions: { uuid_ossp } })
  await pg.exec(`
    CREATE SCHEMA extensions;
    CREATE EXTENSION "uuid-ossp" SCHEMA extensions;
    SET search_path = public, extensions;
  `)
  await pg.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))
  await pg.exec(`
    CREATE ROLE paddock_worker LOGIN BYPASSRLS NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public, extensions TO paddock_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO paddock_worker;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO paddock_worker;
    SET ROLE paddock_worker;
  `)

  const server = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 20 })
  await server.start()
  const db = createDb(createPostgresDriver(`postgres://postgres:postgres@${server.getServerConn()}/postgres`))

  return {
    db,
    pg,
    async stop() {
      await db.close()
      await server.stop()
      await pg.close()
    },
  }
}

/**
 * Makes now() in a rule's SQL return a fixed instant, by putting a stand-in ahead of pg_catalog on
 * the search path. PGlite is one session, so this holds for every connection until unfreezeNow.
 * Views and database functions keep the real now(): they were bound when they were created.
 */
export async function freezeNow(pg: PGlite, instant: string): Promise<void> {
  await pg.exec(`
    RESET ROLE;
    CREATE SCHEMA IF NOT EXISTS frozen_clock;
    CREATE OR REPLACE FUNCTION frozen_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT '${instant}'::timestamptz $$;
    GRANT USAGE ON SCHEMA frozen_clock TO paddock_worker;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA frozen_clock TO paddock_worker;
    SET search_path = frozen_clock, pg_catalog, public, extensions;
    SET ROLE paddock_worker;
  `)
}

export async function unfreezeNow(pg: PGlite): Promise<void> {
  await pg.exec('RESET ROLE; SET search_path = public, extensions; SET ROLE paddock_worker;')
}

/** Ids in a known order, for tie-break tests: rows go in high id first, so storage order is wrong. */
export const LOW_ID = '00000000-0000-4000-8000-00000000000a'
export const HIGH_ID = 'ffffffff-0000-4000-8000-00000000000b'

/** Inserts one row and returns its id. Test data only: the table and column names are literals. */
export async function insert(db: Db, table: string, row: Record<string, unknown>): Promise<string> {
  const columns = Object.keys(row)
  const placeholders = columns.map((_, i) => `$${i + 1}`)
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`
  const rows = await db.query<{ id: string }>(sql, Object.values(row) as never[])
  return rows[0]?.id as string
}

let counter = 0
const next = () => ++counter

export const fixtures = {
  serviceType: (db: Db, row: Record<string, unknown> = {}) =>
    insert(db, 'service_types', { name: `Sauna ${next()}`, booking_type: 'public', ...row }),

  band: (db: Db, row: Record<string, unknown> = {}) =>
    // The counter spelled in letters: session_bands.code allows only a-z and underscores.
    insert(db, 'session_bands', { code: `band_${String(next()).replace(/\d/g, (digit) => 'abcdefghij'.charAt(Number(digit)))}`, name: 'Core', price: '20.00', ...row }),

  session: (db: Db, row: Record<string, unknown>) =>
    insert(db, 'sessions', { start_time: '2030-06-15 10:00:00+00', end_time: '2030-06-15 11:00:00+00', type: 'public', capacity: 10, ...row }),

  customer: (db: Db, row: Record<string, unknown> = {}) =>
    insert(db, 'customers', { first_name: 'Sam', last_name: 'Test', email: `sam${next()}@example.com`, date_of_birth: '1990-01-01', ...row }),

  plan: (db: Db, row: Record<string, unknown> = {}) =>
    insert(db, 'membership_plans', { name: `Plan ${next()}`, level: 'core', ...row }),

  membership: (db: Db, row: Record<string, unknown>) =>
    insert(db, 'customer_memberships', { start_date: '2026-01-01', subscription_status: 'active', ...row }),

  booking: (db: Db, row: Record<string, unknown>) =>
    insert(db, 'bookings', { price_paid: '0', status: 'confirmed', ...row }),

  passType: (db: Db, row: Record<string, unknown> = {}) =>
    insert(db, 'session_pass_types', { name: `Pass ${next()}`, level: 'all_access', ...row }),

  pass: (db: Db, row: Record<string, unknown>) =>
    insert(db, 'customer_session_passes', { sessions_remaining: 5, expiry_date: '2099-01-01', ...row }),

  event: (db: Db, row: Record<string, unknown> = {}) =>
    insert(db, 'events', {
      name: `Event ${next()}`,
      starts_at: '2099-06-15 18:00:00+00',
      ends_at: '2099-06-15 20:00:00+00',
      refund_cutoff_at: '2099-06-14 18:00:00+00',
      capacity: 10,
      access: 'public',
      active: true,
      price_public: '40.00',
      price_pre_herd: '30.00',
      price_herd: '20.00',
      ...row,
    }),

  promo: (db: Db, row: Record<string, unknown> = {}) =>
    insert(db, 'promo_codes', { code: `CODE-${next()}`, discount_type: 'percentage', discount_value: '10', ...row }),

  redemption: (db: Db, row: Record<string, unknown>) =>
    insert(db, 'promo_code_redemptions', { order_id: crypto.randomUUID(), discount_amount: '1', ...row }),
}
