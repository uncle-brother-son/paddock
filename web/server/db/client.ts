import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { classifyDbError, DbCommitUnknownError, queryTimeoutError } from './errors'

/**
 * The Worker's database access. One Db per request (a Workers connection can't outlive its
 * request; see connection.ts). SQL always goes in as text with $1, $2 placeholders and the values
 * as params, never built from values: ESLint rejects a template or concatenation here.
 *
 * Writes that must be all-or-nothing go in db.transaction(). Stripe calls never go inside one
 * (they'd hold a database connection for as long as Stripe takes).
 */

// Client-side limits. The server-side ones below fire first, so Postgres stops the work and the
// client limit only catches a connection that has gone quiet altogether.
export const QUERY_TIMEOUT_MS = 10_000
export const CONNECT_TIMEOUT_MS = 6_000
export const ROLLBACK_TIMEOUT_MS = 3_000

// Applied to every transaction with is_local = true, so nothing leaks into Hyperdrive's pooled
// connections after COMMIT or ROLLBACK.
export const STATEMENT_TIMEOUT_MS = 8_000
export const LOCK_TIMEOUT_MS = 5_000
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000

// BEGIN and the time limits go to Postgres as one message, so opening a transaction is one round
// trip (about 20 ms through Hyperdrive), not two. A BEGIN inside a multi-statement message opens a
// real transaction block that stays open after the message. Constants only: no values in the text.
const BEGIN_WITH_TIMEOUTS = `BEGIN;
SELECT set_config('statement_timeout', '${STATEMENT_TIMEOUT_MS}', true),
       set_config('lock_timeout', '${LOCK_TIMEOUT_MS}', true),
       set_config('idle_in_transaction_session_timeout', '${IDLE_IN_TRANSACTION_TIMEOUT_MS}', true)`

export type SqlParam =
  | string
  | number
  | boolean
  | null
  | Date
  | readonly SqlParam[]
  | { readonly [key: string]: unknown }

/** What the Db needs from a Postgres driver. postgres-driver.ts is the real one; tests use a fake. */
export interface DriverSession {
  run<Row>(sql: string, params: readonly SqlParam[]): Promise<Row[]>
}
export interface ReservedSession extends DriverSession {
  /**
   * Several statements in one round trip, with no parameters (Postgres's simple query protocol).
   * Only for the client's own fixed text: BEGIN with the transaction's time limits.
   */
  runScript(sql: string): Promise<void>
  release(): void
}
export interface DbDriver extends DriverSession {
  /** One connection held for this caller alone, for a transaction. */
  reserve(): Promise<ReservedSession>
  close(): Promise<void>
}

export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<Row[]>
}

export interface LockOptions {
  /** The table alias to lock when the SELECT joins others, as in `FOR UPDATE OF p`. */
  of?: string
  /** Fail straight away instead of waiting for the lock. */
  noWait?: boolean
}

export interface Tx extends Queryable {
  /** Joins this transaction: a nested call never opens a second one. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  /** Runs a SELECT with FOR UPDATE added, holding those rows until the transaction ends. */
  selectForUpdate<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlParam[],
    options?: LockOptions
  ): Promise<Row[]>
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  close(): Promise<void>
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(queryTimeoutError(what)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

const LOCK_ALIAS = /^[a-z_][a-z0-9_]*$/i

class Transaction implements Tx {
  finished = false
  /** The first failure inside the transaction. Set once, it forces a rollback: Postgres answers
   *  COMMIT on a failed transaction with ROLLBACK and no error, so a handler that caught the
   *  failure and carried on would otherwise be told its writes were saved. */
  failure: unknown = undefined
  failed = false

  constructor(
    readonly owner: DbClient,
    private readonly session: ReservedSession
  ) {}

  async query<Row = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<Row[]> {
    if (this.finished) {
      throw new Error('This transaction has already finished. Use the tx passed to the callback, inside the callback.')
    }
    try {
      return await withTimeout(this.session.run<Row>(sql, params), QUERY_TIMEOUT_MS, 'query in a transaction')
    } catch (err) {
      const classified = classifyDbError(err)
      this.markFailed(classified)
      throw classified
    }
  }

  async selectForUpdate<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlParam[] = [],
    options: LockOptions = {}
  ): Promise<Row[]> {
    const select = sql.trim().replace(/;$/, '')
    if (!/^select\b/i.test(select)) throw new Error('selectForUpdate takes a SELECT statement.')
    if (/\bfor\s+(no\s+key\s+)?(update|share)\b/i.test(select)) {
      throw new Error('selectForUpdate adds the FOR UPDATE clause itself.')
    }
    if (options.of !== undefined && !LOCK_ALIAS.test(options.of)) {
      throw new Error('selectForUpdate `of` must be a plain table alias.')
    }
    const lockClause = ['FOR UPDATE', options.of ? `OF ${options.of}` : '', options.noWait ? 'NOWAIT' : '']
      .filter(Boolean)
      .join(' ')
    const locked = `${select}\n${lockClause}`
    return this.query<Row>(locked, params)
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await fn(this)
    } catch (err) {
      // A nested failure fails the whole transaction, even if the outer code catches it.
      this.markFailed(err)
      throw err
    }
  }

  private markFailed(err: unknown): void {
    if (this.failed) return
    this.failed = true
    this.failure = err
  }
}

const activeTransaction = new AsyncLocalStorage<Transaction>()

/**
 * Whether db.transaction() called here would join a transaction already open on this db rather
 * than open its own. Work that wants to run its transaction again (after a deadlock) may only do
 * so when it opened it: a joined one belongs to the caller, and has already failed.
 */
export function inOpenTransaction(db: Db): boolean {
  const tx = activeTransaction.getStore()
  return tx !== undefined && tx.owner === db && !tx.finished
}

class DbClient implements Db {
  constructor(private readonly driver: DbDriver) {}

  private joinable(): Transaction | undefined {
    const tx = activeTransaction.getStore()
    return tx && tx.owner === this && !tx.finished ? tx : undefined
  }

  async query<Row = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<Row[]> {
    // Inside a transaction, a helper using db must see that transaction's writes and locks, not
    // run on a second connection.
    const tx = this.joinable()
    if (tx) return tx.query<Row>(sql, params)
    try {
      return await withTimeout(this.driver.run<Row>(sql, params), QUERY_TIMEOUT_MS, 'query')
    } catch (err) {
      throw classifyDbError(err)
    }
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const running = this.joinable()
    if (running) return running.transaction(fn)

    let session: ReservedSession
    try {
      session = await withTimeout(this.driver.reserve(), CONNECT_TIMEOUT_MS, 'connecting')
    } catch (err) {
      throw classifyDbError(err)
    }

    const tx = new Transaction(this, session)
    // A connection left in an unknown state is never released; it is closed with the request.
    let safeToRelease = true

    const rollback = async () => {
      try {
        await withTimeout(session.run('ROLLBACK', []), ROLLBACK_TIMEOUT_MS, 'ROLLBACK')
      } catch {
        // The connection is closed at the end of the request, which ends the transaction anyway.
        safeToRelease = false
      }
    }

    try {
      try {
        await withTimeout(session.runScript(BEGIN_WITH_TIMEOUTS), QUERY_TIMEOUT_MS, 'BEGIN and setting transaction timeouts')
      } catch (err) {
        await rollback()
        throw classifyDbError(err)
      }

      let result: T
      try {
        result = await activeTransaction.run(tx, () => fn(tx))
      } catch (err) {
        await rollback()
        throw err
      }

      if (tx.failed) {
        await rollback()
        throw tx.failure
      }

      try {
        await withTimeout(session.run('COMMIT', []), QUERY_TIMEOUT_MS, 'COMMIT')
      } catch (err) {
        safeToRelease = false
        const detail = err instanceof Error ? err.message : String(err)
        throw new DbCommitUnknownError(
          'The database did not confirm the change. Check whether it was saved before trying again.',
          detail
        )
      }
      return result
    } finally {
      tx.finished = true
      if (safeToRelease) session.release()
    }
  }

  close(): Promise<void> {
    return this.driver.close()
  }
}

export function createDb(driver: DbDriver): Db {
  return new DbClient(driver)
}
