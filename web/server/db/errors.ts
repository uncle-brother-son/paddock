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

export function queryTimeoutError(what: string): DbTimeoutError {
  return new DbTimeoutError(TIMEOUT_MESSAGE, `Client-side timeout: ${what}`)
}
