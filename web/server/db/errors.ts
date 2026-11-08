import 'server-only'

/**
 * Database failures whose messages are written here, so they are safe to show to staff. The route
 * wrapper passes them through as INTERNAL; anything else thrown by the driver stays in the log.
 */
export class DbError extends Error {
  /** The driver's own error text, for the log only. */
  readonly detail?: string

  constructor(message: string, detail?: string) {
    super(message)
    this.name = new.target.name
    if (detail !== undefined) this.detail = detail
  }
}

/** A query or connection took too long, or was stopped by a lock or statement timeout. */
export class DbTimeoutError extends DbError {}

/** The database can't be reached, or the connection isn't configured. */
export class DbUnavailableError extends DbError {}

/** COMMIT didn't come back, so the change may or may not have been saved. */
export class DbCommitUnknownError extends DbError {}

const TIMEOUT_MESSAGE = 'The database took too long to respond. Check whether the action completed before trying again.'
const UNAVAILABLE_MESSAGE = 'The database could not be reached. Please try again in a moment.'

// postgres.js connection failures, then Postgres / Hyperdrive error codes.
const UNAVAILABLE_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '58000', // Hyperdrive: e.g. "Failed to acquire a connection from the pool."
])
const TIMEOUT_CODES = new Set([
  '57014', // query_canceled: statement_timeout
  '55P03', // lock_not_available: lock_timeout or NOWAIT
  '40P01', // deadlock_detected
  '25P03', // idle_in_transaction_session_timeout
])

// Workers socket failures have no code, only this text (seen on workerd with the database down).
const UNAVAILABLE_TEXT = /connection attempt failed|network connection lost/i

/** Turns a driver error into a DbError when it is a timeout or connection failure; else leaves it. */
export function classifyDbError(err: unknown): unknown {
  if (err instanceof DbError) return err
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : ''
  const detail = typeof code === 'string' ? `${code}: ${message}` : message
  if (typeof code === 'string' && TIMEOUT_CODES.has(code)) return new DbTimeoutError(TIMEOUT_MESSAGE, detail)
  if ((typeof code === 'string' && UNAVAILABLE_CODES.has(code)) || UNAVAILABLE_TEXT.test(message)) {
    return new DbUnavailableError(UNAVAILABLE_MESSAGE, detail)
  }
  return err
}

/**
 * Postgres broke a deadlock by aborting this transaction (40P01), so all of it was rolled back.
 * Postgres's advice is to run it again; only work that calls nothing outside the database may.
 */
export function isDeadlock(err: unknown): boolean {
  return err instanceof DbTimeoutError && (err.detail ?? '').startsWith('40P01:')
}

export function queryTimeoutError(what: string): DbTimeoutError {
  return new DbTimeoutError(TIMEOUT_MESSAGE, `Client-side timeout: ${what}`)
}

/**
 * What Postgres said about a statement it refused, for a rule to turn into its own reason once the
 * transaction has rolled back (a failed statement ends the transaction, so it can't be caught and
 * carried on from). Null for anything that isn't a Postgres refusal, such as a timeout.
 */
export interface PostgresRefusal {
  /** The SQLSTATE, e.g. 23P01 for an exclusion constraint, P0001 for a RAISE EXCEPTION. */
  code: string
  /** The constraint that refused it, when there was one. */
  constraint: string | null
  /** The text Postgres raised: a trigger's own words for a RAISE EXCEPTION. */
  message: string
  /** Where it was raised, e.g. "PL/pgSQL function quote_booking(uuid,uuid,integer) line 15 at RAISE". */
  where: string | null
}

export function postgresRefusal(err: unknown): PostgresRefusal | null {
  if (err instanceof DbError || !(err instanceof Error)) return null
  const fields = err as Error & { code?: unknown; constraint_name?: unknown; where?: unknown }
  if (typeof fields.code !== 'string' || !/^[0-9A-Z]{5}$/.test(fields.code)) return null
  return {
    code: fields.code,
    constraint: typeof fields.constraint_name === 'string' ? fields.constraint_name : null,
    message: err.message,
    where: typeof fields.where === 'string' ? fields.where : null,
  }
}
