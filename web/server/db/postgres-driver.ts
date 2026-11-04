import 'server-only'
import postgres from 'postgres'
import type { DbDriver, DriverSession, ReservedSession, SqlParam } from './client'

// Hyperdrive pools the real connections, so a client per request is cheap. Workers allow six open
// connections per request; five leaves room for the Stripe and Supabase fetches beside it.
const MAX_CONNECTIONS = 5
const CONNECT_TIMEOUT_SECONDS = 5
/** How long sql.end() waits for anything still running before it drops the sockets. */
const CLOSE_TIMEOUT_SECONDS = 2

/**
 * Column values come back in the same form the staff app's Retool resource gives, so ported code
 * and shadow comparisons see the same thing: date as "2026-11-04", timestamp and timestamptz as
 * "2026-11-04T19:56:05.983Z", numeric and bigint as strings, int as a number, json as an object.
 * postgres.js would otherwise give Date objects for all three date types. Strings passed as
 * parameters go to Postgres as they are, so a London wall-clock value is never reinterpreted.
 */
export function parseDate(raw: string): string {
  return raw
}

export function parseTimestamp(raw: string): string {
  return toIso(`${raw.replace(' ', 'T')}Z`, raw)
}

export function parseTimestamptz(raw: string): string {
  return toIso(raw, raw)
}

function toIso(value: string, raw: string): string {
  const parsed = new Date(value)
  // "infinity" and BC dates have no ISO form: keep Postgres's own text.
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString()
}

export function serializeDateParam(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

const pgTypes = {
  paddockDate: { to: 1082, from: [1082], serialize: serializeDateParam, parse: parseDate },
  paddockTimestamp: { to: 1114, from: [1114], serialize: serializeDateParam, parse: parseTimestamp },
  paddockTimestamptz: { to: 1184, from: [1184], serialize: serializeDateParam, parse: parseTimestamptz },
}

type PostgresClient = postgres.Sql<Record<string, unknown>>

async function run<Row>(sql: PostgresClient, text: string, params: readonly SqlParam[]): Promise<Row[]> {
  // unsafe() is the driver's name for "text plus parameters". The values still travel separately
  // from the SQL. prepare: true lets Hyperdrive reuse the prepared statement.
  const rows = await sql.unsafe(text, params as never[], { prepare: true })
  return Array.from(rows) as Row[]
}

function sessionOn(sql: PostgresClient): DriverSession {
  return { run: (text, params) => run(sql, text, params) }
}

export function createPostgresDriver(connectionString: string): DbDriver {
  const sql = postgres(connectionString, {
    max: MAX_CONNECTIONS,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    // Left on: without the array types, a JS array bound to `= ANY($1::uuid[])` is sent as
    // "a,b" and array columns come back as text. It costs one small query per request.
    fetch_types: true,
    prepare: true,
    types: pgTypes,
    onnotice: () => {},
  }) as unknown as PostgresClient

  return {
    ...sessionOn(sql),
    async reserve(): Promise<ReservedSession> {
      const reserved = await sql.reserve()
      return { ...sessionOn(reserved as unknown as PostgresClient), release: () => reserved.release() }
    },
    close: () => sql.end({ timeout: CLOSE_TIMEOUT_SECONDS }),
  }
}
