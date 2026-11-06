import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { audit } from '@/server/audit'
import { claimIdempotencyKey, completeIdempotencyKey, type IdempotencyScope } from '@/server/http/idempotency'
import { recordParity } from '@/server/parity'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'

// Every jsonb column the Worker writes through this driver, read back from the live schema: the
// audit log, the parity log and the idempotent response. The legacy routes write through
// supabase-js and PostgREST, so they never reach the driver.
describe('what the Worker stores in jsonb columns', () => {
  let t: TestDatabase

  beforeAll(async () => {
    t = await startTestDatabase({ schema: 'live' })
  })
  afterAll(() => t.stop())

  describe('audit_log.details', () => {
    const details = async (requestId: string) =>
      (
        await t.db.query<{ t: string; v: unknown }>(
          'SELECT jsonb_typeof(details) AS t, details AS v FROM audit_log WHERE request_id = $1',
          [requestId]
        )
      )[0]
    const record = (requestId: string, extra: { details?: { readonly [key: string]: unknown } } = {}) =>
      t.db.transaction((tx) =>
        audit.record(tx, {
          actorType: 'system',
          actorId: null,
          action: 'test.write',
          entityType: 'test',
          entityId: crypto.randomUUID(),
          requestId,
          ...extra,
        })
      )

    it('stores an object, nested values included', async () => {
      const value = { from: 10, to: { amount: 12.5, lines: [1, { note: null }] } }
      await record('audit-object', { details: value })
      expect(await details('audit-object')).toStrictEqual({ t: 'object', v: value })
    })

    it('stores an empty object when there are no details', async () => {
      await record('audit-none')
      expect(await details('audit-none')).toStrictEqual({ t: 'object', v: {} })
    })
  })

  describe('parity_log', () => {
    const row = async (requestId: string) =>
      (
        await t.db.query<Record<string, unknown>>(
          `SELECT jsonb_typeof(old_result) AS old_type, old_result, jsonb_typeof(new_result) AS new_type, new_result,
                  jsonb_typeof(diff) AS diff_type, diff
           FROM parity_log WHERE request_id = $1`,
          [requestId]
        )
      )[0]

    const stores = async (name: string, value: unknown, type: string) => {
      await recordParity(t.db, { action: 'test', oldResult: value, newResult: value, matches: false, diff: value }, name)
      expect(await row(name)).toStrictEqual({
        old_type: type,
        old_result: value,
        new_type: type,
        new_result: value,
        diff_type: type,
        diff: value,
      })
    }

    it('stores an object', () => stores('parity-object', { a: { b: [1, null] } }, 'object'))
    it('stores an array of diff entries', () => stores('parity-array', [{ path: '', oldValue: null, newValue: 'x' }], 'array'))
    it('stores an empty array', () => stores('parity-empty', [], 'array'))
    it('stores a number', () => stores('parity-number', 12.5, 'number'))
    it('stores a result that is a plain string', () => stores('parity-string', 'hello', 'string'))
    it('stores an empty string', () => stores('parity-blank', '', 'string'))
    it('keeps a string that looks like JSON a string', () => stores('parity-looks-json', '{"a":1}', 'string'))
    it('keeps a string that looks like a number a string', () => stores('parity-looks-number', '123', 'string'))
    it('stores a boolean', () => stores('parity-boolean', true, 'boolean'))
    it('stores an array of booleans', () => stores('parity-booleans', [true, false], 'array'))

    it('stores null and a missing value as SQL NULL', async () => {
      await recordParity(t.db, { action: 'test', oldResult: null, newResult: undefined, matches: true, diff: null }, 'parity-null')
      expect(await row('parity-null')).toStrictEqual({
        old_type: null,
        old_result: null,
        new_type: null,
        new_result: null,
        diff_type: null,
        diff: null,
      })
    })
  })

  describe('api_idempotency.response', () => {
    const scope: IdempotencyScope = {
      actorType: 'staff',
      actorId: crypto.randomUUID(),
      endpoint: 'POST /test',
      key: 'response-key',
    }

    it('stores the response body as an object and replays it unchanged', async () => {
      const body = { ok: true, data: { amount: '12.50', lines: [{ id: 1, note: null }] }, requestId: 'r1' }
      expect(await claimIdempotencyKey(t.db, scope, 'hash')).toBeNull()
      await completeIdempotencyKey(t.db, scope, { status: 200, body })

      const rows = await t.db.query<{ t: string }>(
        'SELECT jsonb_typeof(response) AS t FROM api_idempotency WHERE key = $1',
        [scope.key]
      )
      expect(rows[0]).toStrictEqual({ t: 'object' })
      expect(await claimIdempotencyKey(t.db, scope, 'hash')).toStrictEqual({ status: 200, body })
    })
  })
})
