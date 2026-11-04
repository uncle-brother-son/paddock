import { describe, it, expect, vi } from 'vitest'
import { createDb, type DbDriver, type ReservedSession, type SqlParam } from './client'
import { DbCommitUnknownError, DbTimeoutError, DbUnavailableError } from './errors'

type Responder = (sql: string, params: readonly SqlParam[]) => unknown

/** Records every statement, on the pool or on a reserved connection. */
function fakeDriver(respond: Responder = () => []) {
  const log: Array<{ on: 'pool' | 'reserved'; sql: string; params: readonly SqlParam[] }> = []
  const released = vi.fn()
  const closed = vi.fn().mockResolvedValue(undefined)
  const run =
    (on: 'pool' | 'reserved') =>
    async <Row>(sql: string, params: readonly SqlParam[]): Promise<Row[]> => {
      log.push({ on, sql, params })
      return respond(sql, params) as Row[]
    }
  const reserve = vi.fn(async (): Promise<ReservedSession> => ({ run: run('reserved'), release: released }))
  const driver: DbDriver = { run: run('pool'), reserve, close: closed }
  const statements = () => log.filter((entry) => entry.on === 'reserved').map((entry) => entry.sql.split(/\s/)[0])
  return { driver, log, released, reserve, closed, statements }
}

describe('db.query', () => {
  it('passes the SQL and params straight to the driver and returns typed rows', async () => {
    const fake = fakeDriver(() => [{ id: 'a' }])
    const db = createDb(fake.driver)

    const rows = await db.query<{ id: string }>('SELECT id FROM staff WHERE email = $1', ['x@example.com'])

    expect(rows).toEqual([{ id: 'a' }])
    expect(fake.log).toEqual([{ on: 'pool', sql: 'SELECT id FROM staff WHERE email = $1', params: ['x@example.com'] }])
  })

  it('fails fast with a clear error when a query never comes back', async () => {
    vi.useFakeTimers()
    try {
      const driver: DbDriver = { run: () => new Promise(() => {}), reserve: vi.fn(), close: vi.fn() }
      const pending = createDb(driver).query('select 1')
      const check = expect(pending).rejects.toBeInstanceOf(DbTimeoutError)
      await vi.advanceTimersByTimeAsync(10_000)
      await check
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a Postgres statement timeout and a lost connection as database errors', async () => {
    const timedOut = fakeDriver(() => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    })
    await expect(createDb(timedOut.driver).query('select 1')).rejects.toBeInstanceOf(DbTimeoutError)

    const lost = fakeDriver(() => {
      throw Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' })
    })
    await expect(createDb(lost.driver).query('select 1')).rejects.toBeInstanceOf(DbUnavailableError)

    const noSocket = fakeDriver(() => {
      throw new Error('connection attempt failed')
    })
    await expect(createDb(noSocket.driver).query('select 1')).rejects.toBeInstanceOf(DbUnavailableError)
  })

  it('leaves other database errors as they are', async () => {
    const unique = Object.assign(new Error('duplicate key'), { code: '23505' })
    const fake = fakeDriver(() => {
      throw unique
    })
    await expect(createDb(fake.driver).query('select 1')).rejects.toBe(unique)
  })
})

describe('db.transaction', () => {
  it('runs BEGIN, the timeouts, the work and COMMIT on one reserved connection, then releases it', async () => {
    const fake = fakeDriver()
    const db = createDb(fake.driver)

    const result = await db.transaction(async (tx) => {
      await tx.query('UPDATE a SET b = $1', [1])
      return 'done'
    })

    expect(result).toBe('done')
    expect(fake.statements()).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'COMMIT'])
    expect(fake.log.every((entry) => entry.on === 'reserved')).toBe(true)
    expect(fake.released).toHaveBeenCalledTimes(1)
  })

  it('sets the timeouts for this transaction only', async () => {
    const fake = fakeDriver()
    await createDb(fake.driver).transaction(async () => {})

    const setTimeouts = fake.log[1]?.sql ?? ''
    expect(setTimeouts).toContain("set_config('statement_timeout', '8000', true)")
    expect(setTimeouts).toContain("set_config('lock_timeout', '5000', true)")
    expect(setTimeouts).toContain("set_config('idle_in_transaction_session_timeout', '15000', true)")
  })

  it('rolls back on any throw, rethrows it and releases the connection', async () => {
    const fake = fakeDriver()
    const boom = new Error('boom')

    await expect(
      createDb(fake.driver).transaction(async (tx) => {
        await tx.query('UPDATE a SET b = 1')
        throw boom
      })
    ).rejects.toBe(boom)

    expect(fake.statements()).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'ROLLBACK'])
    expect(fake.released).toHaveBeenCalledTimes(1)
  })

  it('never reports success after a failed statement, even if the handler swallowed the error', async () => {
    // Postgres answers COMMIT on a failed transaction with ROLLBACK and no error.
    const failed = Object.assign(new Error('duplicate key'), { code: '23505' })
    const fake = fakeDriver((sql) => {
      if (sql.startsWith('INSERT')) throw failed
      return []
    })

    await expect(
      createDb(fake.driver).transaction(async (tx) => {
        await tx.query('INSERT INTO a VALUES (1)').catch(() => {})
        return 'looks fine'
      })
    ).rejects.toBe(failed)

    expect(fake.statements()).toEqual(['BEGIN', 'SELECT', 'INSERT', 'ROLLBACK'])
  })

  it('does not open a second transaction for a nested call on tx', async () => {
    const fake = fakeDriver()

    await createDb(fake.driver).transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        expect(inner).toBe(tx)
        await inner.query('UPDATE a SET b = 1')
      })
    })

    expect(fake.reserve).toHaveBeenCalledTimes(1)
    expect(fake.statements()).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'COMMIT'])
  })

  it('joins the running transaction when a helper calls db.transaction or db.query inside one', async () => {
    const fake = fakeDriver()
    const db = createDb(fake.driver)
    const helper = () => db.transaction(async (tx) => tx.query('UPDATE helper SET a = 1'))

    await db.transaction(async () => {
      await helper()
      await db.query('SELECT 1 FROM helper')
    })

    expect(fake.reserve).toHaveBeenCalledTimes(1)
    expect(fake.log.every((entry) => entry.on === 'reserved')).toBe(true)
    expect(fake.statements()).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'SELECT', 'COMMIT'])
  })

  it('rolls back everything when a nested transaction fails, even if the outer code catches it', async () => {
    const fake = fakeDriver()
    const inner = new Error('inner failed')

    await expect(
      createDb(fake.driver).transaction(async (tx) => {
        await tx.transaction(async () => {
          throw inner
        }).catch(() => {})
        return 'carried on'
      })
    ).rejects.toBe(inner)

    expect(fake.statements()).toEqual(['BEGIN', 'SELECT', 'ROLLBACK'])
  })

  it('keeps separate transactions apart once the first has finished', async () => {
    const fake = fakeDriver()
    const db = createDb(fake.driver)

    await db.transaction(async () => {})
    await db.transaction(async () => {})
    await db.query('select 1')

    expect(fake.reserve).toHaveBeenCalledTimes(2)
    expect(fake.log.at(-1)?.on).toBe('pool')
  })

  it('refuses a tx used after its transaction finished', async () => {
    const fake = fakeDriver()
    let leaked: { query(sql: string): Promise<unknown> } | undefined

    await createDb(fake.driver).transaction(async (tx) => {
      leaked = tx
    })

    await expect(leaked?.query('select 1')).rejects.toThrow('already finished')
  })

  it('says the outcome is unknown when COMMIT fails, and keeps that connection out of use', async () => {
    const fake = fakeDriver((sql) => {
      if (sql === 'COMMIT') throw Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' })
      return []
    })

    await expect(createDb(fake.driver).transaction(async () => 'x')).rejects.toBeInstanceOf(DbCommitUnknownError)
    expect(fake.released).not.toHaveBeenCalled()
  })

  it('keeps a connection out of use when ROLLBACK fails, and still reports the first error', async () => {
    const fake = fakeDriver((sql) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed')
      return []
    })
    const boom = new Error('boom')

    await expect(
      createDb(fake.driver).transaction(async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(fake.released).not.toHaveBeenCalled()
  })

  it('fails with a database error when no connection can be reserved', async () => {
    const fake = fakeDriver()
    fake.reserve.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'CONNECT_TIMEOUT' }))

    await expect(createDb(fake.driver).transaction(async () => 'x')).rejects.toBeInstanceOf(DbUnavailableError)
  })
})

describe('tx.selectForUpdate', () => {
  async function lockedSql(sql: string, options?: { of?: string; noWait?: boolean }) {
    const fake = fakeDriver()
    await createDb(fake.driver).transaction(async (tx) => {
      await tx.selectForUpdate(sql, ['id-1'], options)
    })
    return fake.log[2]
  }

  it('adds FOR UPDATE and keeps the params', async () => {
    const statement = await lockedSql('SELECT * FROM customer_memberships WHERE id = $1;')
    expect(statement?.sql).toBe('SELECT * FROM customer_memberships WHERE id = $1\nFOR UPDATE')
    expect(statement?.params).toEqual(['id-1'])
  })

  it('locks one table of a join with `of`, and can refuse to wait', async () => {
    const statement = await lockedSql('SELECT p.id FROM periods p JOIN plans x ON true WHERE p.id = $1', {
      of: 'p',
      noWait: true,
    })
    expect(statement?.sql).toContain('\nFOR UPDATE OF p NOWAIT')
  })

  it('refuses anything that is not a plain SELECT, and an unsafe alias', async () => {
    const db = createDb(fakeDriver().driver)
    await expect(db.transaction((tx) => tx.selectForUpdate('UPDATE a SET b = 1'))).rejects.toThrow('takes a SELECT')
    await expect(db.transaction((tx) => tx.selectForUpdate('SELECT 1 FOR UPDATE'))).rejects.toThrow('adds the FOR UPDATE')
    await expect(db.transaction((tx) => tx.selectForUpdate('SELECT 1', [], { of: 'p; drop table a' }))).rejects.toThrow(
      'plain table alias'
    )
  })
})
