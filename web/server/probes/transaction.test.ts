import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/v1/staff/probes/transaction/route'
import type { Db, Tx } from '@/server/db'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { probeTransaction, type ProbeTransactionOutput } from './transaction'

const KEY = 'test-staff-api-key'
const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

let t: TestDatabase
let adminId: string

const staff = (email: string, row: Record<string, unknown>) =>
  insert(t.db, 'staff', { first_name: 'A', last_name: 'B', email, role: 'staff', active: true, ...row })

beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  t = await startTestDatabase({ schema: 'live' })
  holder.db = t.db
  adminId = await staff('admin@example.com', { role: 'admin' })
  await staff('manager@example.com', { role: 'manager', can_issue_refunds: true, can_manage_pricing: true })
  await staff('gone@example.com', { role: 'admin', active: false })
})

afterAll(() => t.stop())

function call(email: string, body: unknown = {}, key: string | null = KEY) {
  return POST(
    new Request('https://worker.test/api/v1/staff/probes/transaction', {
      method: 'POST',
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'x-staff-email': email },
      body: JSON.stringify(body),
    })
  )
}

const rowsLeft = async () => {
  const count = async (sql: string) => Number((await t.pg.query<{ n: number }>(sql)).rows[0]?.n)
  return {
    idempotency: await count('SELECT count(*)::int AS n FROM api_idempotency'),
    audit: await count('SELECT count(*)::int AS n FROM audit_log'),
  }
}

describe('POST /api/v1/staff/probes/transaction', () => {
  it('passes for an admin, and nothing is kept', async () => {
    const response = await call('admin@example.com', { statements: 5 })
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as { data: ProbeTransactionOutput }
    expect(data.passed).toBe(true)
    expect(data.inside).toMatchObject({
      idempotencyRows: 1,
      auditRows: 1,
      oneConnection: true,
      nowFixed: true,
      statementTimeout: '8s',
      lockTimeout: '5s',
      idleTimeout: '15s',
    })
    expect(data.after).toEqual({ idempotencyRows: 0, auditRows: 0 })
    expect(await rowsLeft()).toEqual({ idempotency: 0, audit: 0 })
  })

  it('runs 40 statements unless told otherwise, and reports every timing', async () => {
    const { data } = (await (await call('admin@example.com')).json()) as { data: ProbeTransactionOutput }
    expect(Object.keys(data.timingsMs).sort()).toEqual(
      ['auditWrite', 'idempotencyClaim', 'open', 'rollback', 'rowLock', 'statementAverage', 'statementSlowest', 'statements', 'total'].sort()
    )
    expect(data.timingsMs.total).toBeGreaterThanOrEqual(data.timingsMs.statements)
  })

  it.each([
    ['a manager, with every switch on', 'manager@example.com', 403],
    ['an inactive admin', 'gone@example.com', 403],
    ['nobody we know', 'stranger@example.com', 401],
  ])('refuses %s', async (_, email, status) => {
    expect((await call(email)).status).toBe(status)
    expect(await rowsLeft()).toEqual({ idempotency: 0, audit: 0 })
  })

  it('refuses a call with no staff key', async () => {
    expect((await call('admin@example.com', {}, null)).status).toBe(401)
  })

  it.each([[0], [61], ['forty']])('refuses %s statements', async (statements) => {
    expect((await call('admin@example.com', { statements })).status).toBe(400)
  })
})

describe('probeTransaction', () => {
  const probe = (db: Db) => probeTransaction({ db, staffId: adminId, requestId: crypto.randomUUID(), statements: 1 })

  it('fails if the rows survive, which is the whole point of it', async () => {
    // A database whose transactions commit whatever happens.
    const leaky: Db = {
      query: (sql, params) => t.db.query(sql, params),
      close: () => t.db.close(),
      transaction: <T>(fn: (tx: Tx) => Promise<T>) =>
        t.db.transaction(async (tx) => {
          try {
            return await fn(tx)
          } catch {
            return undefined as T
          }
        }),
    }
    const result = await probe(leaky)
    expect(result.passed).toBe(false)
    expect(result.after).toEqual({ idempotencyRows: 1, auditRows: 1 })
    await t.pg.exec(`DELETE FROM api_idempotency; DELETE FROM audit_log;`)
  })

  it('gives the real error if the transaction itself fails, and still keeps nothing', async () => {
    await t.pg.exec(`RESET ROLE; ALTER TABLE audit_log RENAME TO audit_log_hidden; SET ROLE paddock_worker;`)
    await expect(probe(t.db)).rejects.toThrow('audit_log')
    await t.pg.exec(`RESET ROLE; ALTER TABLE audit_log_hidden RENAME TO audit_log; SET ROLE paddock_worker;`)
    expect(await rowsLeft()).toEqual({ idempotency: 0, audit: 0 })
  })
})
