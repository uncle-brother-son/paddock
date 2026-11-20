import type { Db, SqlParam, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import type { AdminActor } from '@/server/rules/admin/refusal'
import { deferred } from './race'
import type { RealPostgres } from './real-postgres'

// W49 + W54: how step G's race tests run two real presses at once on real Postgres. The first press is the rule
// itself, stopped inside its transaction straight after a chosen statement; the second is started only then, and the
// first is let go only once Postgres itself reports the second as blocked by it. So no race can pass by timing.
// Test code only.

export interface HeldPress {
  /** The client to give the first press: its transaction stops, still open, after the first statement that matches. */
  db: Db
  /** Resolves, with the first press's backend pid, once it is stopped there. */
  holding: Promise<number>
  /** Lets the first press carry on to its commit. */
  release(): void
}

/** A client whose transaction stops, still open, straight after the first statement `matches`, until `release()`. */
export function holdingAfter(db: Db, matches: (sql: string) => boolean): HeldPress {
  const gate = deferred()
  let announce: (pid: number) => void = () => {}
  const holding = new Promise<number>((resolve) => {
    announce = resolve
  })
  let stopped = false
  const stopping = (tx: Tx): Tx =>
    new Proxy(tx, {
      get(inner, property, receiver) {
        if (property !== 'query') return Reflect.get(inner, property, receiver) as unknown
        return async (sql: string, params?: readonly SqlParam[]) => {
          const answer = await inner.query(sql, params)
          if (!stopped && matches(sql.trim().replace(/\s+/g, ' '))) {
            stopped = true
            announce((await inner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
            await gate.promise
          }
          return answer
        }
      },
    })
  const held = new Proxy(db, {
    get(inner, property, receiver) {
      if (property !== 'transaction') return Reflect.get(inner, property, receiver) as unknown
      return <R>(fn: (tx: Tx) => Promise<R>) => inner.transaction((tx) => fn(stopping(tx)))
    },
  })
  return { db: held, holding, release: gate.resolve }
}

/** Waits until Postgres reports some session blocked by `holder`, and answers that session's pid. */
export async function sessionBlockedBy(pg: RealPostgres, holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('The second press never waited on the first.')
}

/** A press's outcome as a test reads it: its answer, or the reason it was refused (anything else is rethrown). */
export type PressOutcome<T> = { answered: T } | { refused: string }
export const outcomeOf = <T>(press: Promise<T>): Promise<PressOutcome<T>> =>
  press.then(
    (answered) => ({ answered }),
    (err: unknown) => {
      const reason = err instanceof ApiError ? (err.details as { reason?: unknown } | undefined)?.reason : undefined
      if (typeof reason === 'string') return { refused: reason }
      throw err
    }
  )

/** The options of one press by a staff member with every permission. */
export const pressBy = (id: string, role: AdminActor['role'] = 'admin'): { actor: AdminActor; requestId: string; pressKey: string } => ({
  actor: { type: 'staff', id, role, canManagePricing: true, canIssueRefunds: true },
  requestId: crypto.randomUUID(),
  pressKey: crypto.randomUUID(),
})
