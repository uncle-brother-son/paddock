import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { audit } from '@/server/audit'
import { claimIdempotencyKey, completeIdempotencyKey, type IdempotencyScope } from '@/server/http/idempotency'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'

// Every jsonb column the Worker writes through this driver, read back from the live schema: the
// audit log and the idempotent response (W16: the parity log has no writer since the shadow went).
// The legacy routes write through supabase-js and PostgREST, so they never reach the driver.
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
