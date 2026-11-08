import { expect } from 'vitest'
import type { Db, Tx } from '@/server/db'
import type { RealPostgres } from './real-postgres'

/** The refusal a claim gives. Thrown so that db.transaction rolls back, as the order code will. */
export class Refused extends Error {
  constructor(
    readonly reason: string,
    readonly balance?: string | number
  ) {
    super(reason)
  }
}

export type Outcome<T> = { won: T } | { refused: Refused }

/** One attempt in its own transaction. Anything but a refusal is a test failure, so it is rethrown. */
export async function attempt<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<Outcome<T>> {
  try {
    return { won: await db.transaction(work) }
  } catch (err) {
    if (err instanceof Refused) return { refused: err }
    throw err
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const backendPid = async (tx: Tx) => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number

export type Race = <T>(
  claim: (tx: Tx, who: 'first' | 'second') => Promise<T>,
  firstEnds: 'commit' | 'rollback',
  /** The table whose row the second must be waiting on, checked in pg_locks. */
  waitsOn?: string
) => Promise<{ first: Outcome<T>; second: Outcome<T> }>

/**
 * What a blocked session is waiting on, from pg_locks. A session waiting for a row lock holds the
 * row's tuple lock (granted) while it waits for the holder's transaction, so the tuple locks name
 * the table; a wait on an advisory lock (the one-a-day trigger's) shows as 'advisory'. Waits on an
 * uncommitted index entry (an exclusion constraint) show neither, so this returns [] for them.
 */
export async function waitingOn(pg: RealPostgres, pid: number): Promise<string[]> {
  const rows = await pg.admin.unsafe<{ waited_on: string }[]>(
    `SELECT DISTINCT relation::regclass::text AS waited_on FROM pg_locks WHERE pid = $1 AND locktype = 'tuple'
     UNION
     SELECT 'advisory' FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
    [pid]
  )
  return rows.map((row) => row.waited_on).sort()
}

/**
 * The race with its timing fixed. The first transaction makes its claim and stays open. The second
 * makes the same claim, and Postgres must report it as blocked by the first. Only then does the
 * first finish, by committing or rolling back, and the second carries on with what it finds.
 */
export function makeRace(pg: RealPostgres, first: Db, second: Db): Race {
  /** Waits until Postgres itself reports a session blocked by `holder`, and returns that session. */
  async function sessionBlockedBy(holder: number): Promise<number> {
    const giveUpAt = Date.now() + 4_000
    while (Date.now() < giveUpAt) {
      const rows = await pg.admin.unsafe<{ pid: number }[]>(
        `SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
        [holder]
      )
      if (rows[0]) return rows[0].pid
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('The second transaction never waited on the first.')
  }

  return async (claim, firstEnds, waitsOn) => {
    const finish = deferred()
    let announce: (pid: number) => void = () => {}
    const claimed = new Promise<number>((resolve) => {
      announce = resolve
    })

    const holder = attempt(first, async (tx) => {
      const result = await claim(tx, 'first')
      announce(await backendPid(tx))
      await finish.promise
      if (firstEnds === 'rollback') throw new Refused('first_rolled_back')
      return result
    })
    // If the first claim fails, this rejects rather than waiting for ever.
    const holderPid = await Promise.race([claimed, holder.then(() => Promise.reject(new Error('The first claim ended early.')))])

    let waiterPid = 0
    let waiterSettled = false
    const waiter = attempt(second, async (tx) => {
      waiterPid = await backendPid(tx)
      return claim(tx, 'second')
    }).finally(() => {
      waiterSettled = true
    })

    const blocked = await sessionBlockedBy(holderPid)
    expect(blocked).toBe(waiterPid)
    expect(waiterSettled).toBe(false)
    if (waitsOn !== undefined) expect(await waitingOn(pg, waiterPid)).toEqual([waitsOn])

    finish.resolve()
    return { first: await holder, second: await waiter }
  }
}
