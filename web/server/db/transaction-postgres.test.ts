import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'

// W06 N2: BEGIN and the transaction's time limits go to Postgres as one simple-protocol message.
// On real Postgres 17.6, through the real driver: what is opened that way must be a real
// transaction, with the limits set for it alone.

let pg: RealPostgres
let db: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  db = pg.connect()
})
afterAll(() => pg.stop())

interface Inside {
  pid: number
  statement_timeout: string
  lock_timeout: string
  idle_timeout: string
}

const INSIDE = `SELECT pg_backend_pid() AS pid,
  current_setting('statement_timeout') AS statement_timeout,
  current_setting('lock_timeout') AS lock_timeout,
  current_setting('idle_in_transaction_session_timeout') AS idle_timeout`

describe('BEGIN with the time limits, in one round trip', () => {
  it('opens a real transaction: its time limits hold, now() stays put, and a throw keeps nothing', async () => {
    // Each run starts its own server, so a fixed table name is safe.
    await pg.admin.unsafe('CREATE TABLE n2_kept (id int); GRANT ALL ON n2_kept TO paddock_worker')

    const seen: { first?: Inside; nowAt?: string[] } = {}
    await expect(
      db.transaction(async (tx) => {
        seen.first = (await tx.query<Inside>(INSIDE))[0]
        const before = (await tx.query<{ at: string }>('SELECT now()::text AS at'))[0]?.at as string
        await tx.query('SELECT pg_sleep(0.02)')
        const after = (await tx.query<{ at: string }>('SELECT now()::text AS at'))[0]?.at as string
        seen.nowAt = [before, after]
        await tx.query('INSERT INTO n2_kept VALUES (1)')
        throw new Error('roll it back')
      })
    ).rejects.toThrow('roll it back')

    expect(seen.first).toMatchObject({ statement_timeout: '8s', lock_timeout: '5s', idle_timeout: '15s' })
    // now() is the transaction's start: the same in two statements 20 ms apart only inside one.
    expect(seen.nowAt?.[0]).toBe(seen.nowAt?.[1])
    expect((await pg.admin.unsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM n2_kept'))[0]?.n).toBe(0)
  })

  it('sets the limits for the transaction only: its connection is back to the server default after COMMIT', async () => {
    const inside = await db.transaction(async (tx) => (await tx.query<Inside>(INSIDE))[0] as Inside)
    const after = (
      await db.query<{ pid: number; lock_timeout: string }>("SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock_timeout")
    )[0]
    expect(after?.pid).toBe(inside.pid)
    expect(inside.lock_timeout).toBe('5s')
    expect(after?.lock_timeout).toBe('0')
  })
})
