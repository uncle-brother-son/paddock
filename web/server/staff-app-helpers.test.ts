import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { Queryable } from '@/server/db'
import { authenticateStaff } from './auth/staff'

// The staff app has no test runner, so its Worker helpers are tested here, from its checkout
// beside this repo (the same place export:contracts writes to). Skipped when it isn't there.
const appDir = process.env.RETOOL_APP_DIR ?? path.resolve(__dirname, '../../../paddock-retool-app')
const shared = path.join(appDir, 'backend/paddock/shared')

const load = (name: string) => import(/* @vite-ignore */ path.join(shared, name))

const user = { email: 'jo@example.com' }
const success = (data: unknown) => ({ data: { ok: true, data, requestId: 'worker-request' } })
const refusal = (code: string, message: string) => ({
  data: { ok: false, error: { code, message }, requestId: 'worker-request' },
})

describe.skipIf(!existsSync(shared))('staff app helpers', () => {
  const rawRequest = vi.fn()

  beforeEach(() => {
    rawRequest.mockReset()
    vi.stubGlobal('paddockWorkerV1', { rawRequest })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('inactive staff', () => {
    const INACTIVE = 'This staff account is inactive. Ask an admin to reactivate it.'
    const row = (active: boolean | null) => ({
      id: 'staff-1',
      email: 'jo@example.com',
      role: 'admin',
      can_issue_refunds: true,
      can_manage_pricing: true,
      active,
    })

    /** A staff table of the given rows, honouring the `AND active = true` filter. */
    function stubStaffTable(rows: Array<ReturnType<typeof row>>) {
      const query = vi.fn(async (sql: string) => ({
        data: sql.includes('AND active = true') ? rows.filter((r) => r.active === true) : rows,
      }))
      vi.stubGlobal('paddockData', { query })
      return query
    }

    const guards = async () => {
      const access = await load('staffAccess')
      const ids = await load('resolveStaffId')
      const pricing = await load('pricingStaff')
      return {
        getStaffAccessRow: access.getStaffAccessRow,
        requireStaffAdmin: access.requireStaffAdmin,
        requireCanIssueRefunds: access.requireCanIssueRefunds,
        resolveStaffId: ids.resolveStaffId,
        requireStaffId: ids.requireStaffId,
        requireCanManagePricing: pricing.requireCanManagePricing,
      } as Record<string, (email: string) => Promise<unknown>>
    }

    it('every lookup gives the same refusal, with active off or unset', async () => {
      for (const active of [false, null]) {
        stubStaffTable([row(active)])
        for (const [name, guard] of Object.entries(await guards())) {
          await expect(guard('jo@example.com'), name).rejects.toThrow(INACTIVE)
        }
      }
    })

    it('every lookup filters on active', async () => {
      const query = stubStaffTable([row(true)])
      for (const guard of Object.values(await guards())) await guard('jo@example.com')
      expect(query.mock.calls.every(([sql]) => sql.includes('AND active = true'))).toBe(true)
    })

    it('active staff pass, with one query', async () => {
      const query = stubStaffTable([row(true)])
      const { getStaffAccessRow, resolveStaffId } = await guards()

      expect(await getStaffAccessRow?.('jo@example.com')).toMatchObject({ id: 'staff-1' })
      expect(await resolveStaffId?.('jo@example.com')).toBe('staff-1')
      expect(query).toHaveBeenCalledTimes(2)
    })

    it('an unknown email keeps its own outcome, not the inactive refusal', async () => {
      stubStaffTable([])
      const { getStaffAccessRow, resolveStaffId, requireStaffId, requireStaffAdmin, requireCanManagePricing } = await guards()

      expect(await getStaffAccessRow?.('x@example.com')).toBeNull()
      expect(await resolveStaffId?.('x@example.com')).toBeNull()
      await expect(requireStaffId?.('x@example.com')).rejects.toThrow('No staff record matches')
      await expect(requireStaffAdmin?.('x@example.com')).rejects.toThrow('No staff record matches')
      await expect(requireCanManagePricing?.('x@example.com')).rejects.toThrow('No staff record matches')
    })

    it('getStaffRowAnyStatus still shows the screen an inactive row', async () => {
      stubStaffTable([row(false)])
      const { getStaffRowAnyStatus } = await load('staffAccess')

      expect(await getStaffRowAnyStatus('jo@example.com')).toMatchObject({ active: false })
    })

    // Every function W01c added the check to. Called as an inactive account with empty params,
    // each must refuse straight away: no write, no Worker call.
    const guarded = [
      'addServiceTypeScheduleSlot',
      'chargeSavedCard',
      'createBooking',
      'createCustomer',
      'createOneOffSession',
      'createTerminalPaymentIntent',
      'createTerminalSetupIntent',
      'deleteServiceTypeScheduleSlot',
      'generateUpcomingSessions',
      'getTerminalConnectionToken',
      'saveCustomerCardOnFile',
      'setAddonLinePrepared',
      'setBookingCheckedIn',
      'setBookingSpecialRequests',
      'setBookingStatus',
      'setEventAttendeeCheckIn',
      'setEventAttendeeWaiver',
      'setEventAttendeesCheckIn',
      'setGiftCardPickedUp',
      'setGiftCardShipped',
      'setGuestWaiverStatus',
      'setOrderLineItemFulfilled',
      'setSessionStartTime',
      'unblockSession',
    ]

    it.each(guarded)('%s refuses before anything is written or charged', async (name) => {
      const query = stubStaffTable([row(false)])
      const worker = vi.fn()
      vi.stubGlobal('paddockBackendApi2', { rawRequest: worker })
      const { default: fn } = await import(/* @vite-ignore */ path.join(appDir, `backend/paddock/${name}`))

      await expect(fn({ params: {}, user })).rejects.toThrow(INACTIVE)

      expect(worker).not.toHaveBeenCalled()
      expect(query.mock.calls.every(([sql]) => /^\s*SELECT/i.test(sql))).toBe(true)
    })

    it('the unguarded versions used inside payment flows do no staff lookup', async () => {
      const query = stubStaffTable([row(false)])
      const worker = vi.fn().mockResolvedValue({ data: { paymentIntentId: 'pi_1' } })
      vi.stubGlobal('paddockBackendApi2', { rawRequest: worker })
      const { chargeSavedCardUnguarded } = await load('../chargeSavedCard')

      await chargeSavedCardUnguarded({ params: { customerId: 'c', amount: 1, description: 'd' } })

      expect(worker).toHaveBeenCalledTimes(1)
      expect(query).not.toHaveBeenCalled()
    })

    it('uses the same wording as the Worker', async () => {
      const { INACTIVE_STAFF_MESSAGE } = await load('staffAccess')
      const db = { query: async () => [row(false)] } as unknown as Queryable
      const headers = new Headers({ authorization: 'Bearer key', 'x-staff-email': 'jo@example.com' })

      await expect(authenticateStaff(headers, db, 'key')).rejects.toThrow(INACTIVE_STAFF_MESSAGE)
    })
  })

  describe('at least one active admin', () => {
    const MESSAGE = 'There must always be at least one active admin. Make someone else an active admin first.'
    const admin = { user: { email: 'admin@example.com' } }

    /** The caller is an active admin; the guarded UPDATE answers with `updated`. */
    function stubDb(updated: unknown[], targetExists = true) {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM staff WHERE email')) return { data: [{ id: 'a', role: 'admin', active: true }] }
        if (sql.includes('UPDATE staff')) return { data: updated }
        return { data: targetExists ? [{ id: 't' }] : [] }
      })
      vi.stubGlobal('paddockData', { query })
      return query
    }

    const setStaffPermission = async () => (await load('../setStaffPermission')).default
    const setStaffRole = async () => (await load('../setStaffRole')).default

    it('refuses when the guarded update changed nothing and the staff member exists', async () => {
      stubDb([])
      await expect((await setStaffPermission())({ params: { staffId: 't', field: 'active', value: false }, ...admin })).rejects.toThrow(MESSAGE)
      await expect((await setStaffRole())({ params: { staffId: 't', role: 'staff' }, ...admin })).rejects.toThrow(MESSAGE)
    })

    it('answers null, as before, for a staff member who does not exist', async () => {
      stubDb([], false)
      expect(await (await setStaffPermission())({ params: { staffId: 't', field: 'active', value: false }, ...admin })).toBeNull()
      expect(await (await setStaffRole())({ params: { staffId: 't', role: 'staff' }, ...admin })).toBeNull()
    })

    it('counts and locks inside the one statement that makes the change', async () => {
      const query = stubDb([{ id: 't', active: false }])
      await (await setStaffPermission())({ params: { staffId: 't', field: 'active', value: false }, ...admin })
      await (await setStaffRole())({ params: { staffId: 't', role: 'manager' }, ...admin })

      const updates = query.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes('UPDATE staff'))
      expect(updates).toHaveLength(2)
      for (const sql of updates) {
        expect(sql).toContain('FOR UPDATE')
        expect(sql).toContain('other_admins')
      }
    })

    it('adding an admin or switching someone on needs no guard', async () => {
      const query = stubDb([{ id: 't' }])
      await (await setStaffPermission())({ params: { staffId: 't', field: 'active', value: true }, ...admin })
      await (await setStaffRole())({ params: { staffId: 't', role: 'admin' }, ...admin })

      expect(query.mock.calls.some(([sql]) => sql.includes('FOR UPDATE'))).toBe(false)
    })
  })

  describe('callWorker', () => {
    it('adds who is acting and a request id, and returns data', async () => {
      const { callWorker } = await load('callWorker')
      rawRequest.mockResolvedValue(success({ id: 'x' }))

      const data = await callWorker(user, { path: '/api/v1/staff/whoami' })

      expect(data).toEqual({ id: 'x' })
      const call = rawRequest.mock.calls[0]?.[0]
      expect(call).toMatchObject({ path: '/api/v1/staff/whoami', method: 'GET' })
      expect(call.headers['X-Staff-Email']).toBe('jo@example.com')
      expect(call.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/)
      expect(call.headers['Idempotency-Key']).toBeUndefined()
      expect(call).not.toHaveProperty('body')
    })

    it('passes the body, query and idempotency key through', async () => {
      const { callWorker } = await load('callWorker')
      rawRequest.mockResolvedValue(success(null))

      await callWorker(user, {
        path: '/x',
        method: 'POST',
        body: { a: 1 },
        queryParams: { q: '1' },
        idempotencyKey: 'key-from-the-frontend',
      })

      expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({
        method: 'POST',
        body: { a: 1 },
        queryParams: { q: '1' },
        headers: { 'Idempotency-Key': 'key-from-the-frontend' },
      })
    })

    it("throws the Worker's message with the code and request id in brackets", async () => {
      const { callWorker, WorkerError } = await load('callWorker')
      rawRequest.mockResolvedValue(refusal('SESSION_FULL', 'That session is now full.'))

      const err = await callWorker(user, { path: '/x' }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(WorkerError)
      expect((err as Error).message).toBe('That session is now full. (SESSION_FULL, request worker-request)')
      expect(err).toMatchObject({ code: 'SESSION_FULL', requestId: 'worker-request' })
    })

    it('guards against an HTML page instead of JSON', async () => {
      const { callWorker } = await load('callWorker')
      rawRequest.mockResolvedValue({ data: { message: '<!DOCTYPE html><html></html>' } })

      await expect(callWorker(user, { path: '/x' })).rejects.toThrow('HTML page')
    })

    it('does not mistake any other shape for success', async () => {
      const { callWorker } = await load('callWorker')
      for (const data of [{ success: true }, 'text', null, { ok: true }, { ok: false }]) {
        rawRequest.mockResolvedValue({ data })
        await expect(callWorker(user, { path: '/x' })).rejects.toThrow('could not read')
      }
    })

    it("recovers the Worker's error when the client throws with the body attached", async () => {
      const { callWorker } = await load('callWorker')
      rawRequest.mockRejectedValue(Object.assign(new Error('403'), { response: refusal('FORBIDDEN', 'Admins only.') }))

      await expect(callWorker(user, { path: '/x' })).rejects.toThrow('Admins only. (FORBIDDEN, request worker-request)')
    })

    it('says so when the Worker cannot be reached', async () => {
      const { callWorker } = await load('callWorker')
      rawRequest.mockRejectedValue(new Error('socket hang up'))

      await expect(callWorker(user, { path: '/x' })).rejects.toThrow('Could not reach the Worker: socket hang up')
    })
  })

  describe('stableDiff', () => {
    it('ignores key order, at every level', async () => {
      const { stableDiff } = await load('stableDiff')
      expect(stableDiff({ a: 1, b: { c: 2, d: [3] } }, { b: { d: [3], c: 2 }, a: 1 })).toEqual([])
    })

    it('counts array order and length', async () => {
      const { stableDiff } = await load('stableDiff')
      expect(stableDiff(['a', 'b'], ['b', 'a'])).toHaveLength(2)
      expect(stableDiff(['a'], ['a', 'b'])).toEqual([{ path: '1', oldValue: undefined, newValue: 'b' }])
    })

    it('compares money in pence', async () => {
      const { stableDiff } = await load('stableDiff')
      expect(stableDiff({ price: '12.50' }, { price: 12.5 })).toEqual([])
      expect(stableDiff({ price: '12.50' }, { price: '12.5' })).toEqual([])
      expect(stableDiff({ price: '0.10' }, { price: 0.1 })).toEqual([])
      expect(stableDiff({ price: '12.50' }, { price: '12.51' })).toEqual([
        { path: 'price', oldValue: '12.50', newValue: '12.51' },
      ])
    })

    it('does not treat ordinary text as money', async () => {
      const { stableDiff } = await load('stableDiff')
      expect(stableDiff('2026-11-04', '2026-11-05')).toHaveLength(1)
      expect(stableDiff('abc', 'ABC')).toHaveLength(1)
    })

    it('treats undefined as a missing key, but null as a value', async () => {
      const { stableDiff } = await load('stableDiff')
      expect(stableDiff({ a: 1, b: undefined }, { a: 1 })).toEqual([])
      expect(stableDiff({ a: 1, b: null }, { a: 1 })).toEqual([{ path: 'b', oldValue: null, newValue: undefined }])
    })

    it('gives the full path, and stops at 50 differences', async () => {
      const { stableDiff } = await load('stableDiff')
      expect(stableDiff({ rows: [{ a: 'x' }] }, { rows: [{ a: 'y' }] })[0].path).toBe('rows.0.a')
      const many = (value: string) => Array.from({ length: 80 }, () => value)
      expect(stableDiff(many('a'), many('b'))).toHaveLength(50)
    })
  })

  describe('shadowCompare', () => {
    const parityCalls = () => rawRequest.mock.calls.filter(([options]) => options.path === '/api/v1/staff/parity')

    it('runs only the old function while the flag is off', async () => {
      const { shadowCompare } = await load('shadowCompare')
      const newFn = vi.fn()

      expect(await shadowCompare(user, 'flagOff', async () => 'old', newFn)).toBe('old')
      expect(newFn).not.toHaveBeenCalled()
      expect(rawRequest).not.toHaveBeenCalled()
    })

    it('returns the old result and records nothing when the two match', async () => {
      const { shadowCompare, SHADOW_ACTIONS } = await load('shadowCompare')
      SHADOW_ACTIONS.matching = true

      const result = await shadowCompare(user, 'matching', async () => ({ price: '5.00' }), async () => ({ price: 5 }))

      expect(result).toEqual({ price: '5.00' })
      expect(parityCalls()).toHaveLength(0)
    })

    it('still returns the old result, and records a mismatch through the Worker', async () => {
      const { shadowCompare, SHADOW_ACTIONS } = await load('shadowCompare')
      SHADOW_ACTIONS.different = true
      rawRequest.mockResolvedValue(success({ recorded: true }))

      const result = await shadowCompare(user, 'different', async () => ({ price: '5.00' }), async () => ({ price: '6.00' }))

      expect(result).toEqual({ price: '5.00' })
      const body = parityCalls()[0]?.[0].body
      expect(body).toMatchObject({
        action: 'different',
        oldResult: { price: '5.00' },
        newResult: { price: '6.00' },
        matches: false,
        diff: [{ path: 'price', oldValue: '5.00', newValue: '6.00' }],
      })
      expect(parityCalls()[0]?.[0].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('records a failed Worker call as a mismatch and keeps it from the screen', async () => {
      const { shadowCompare, SHADOW_ACTIONS } = await load('shadowCompare')
      SHADOW_ACTIONS.failing = true
      rawRequest.mockResolvedValue(success({ recorded: true }))

      const result = await shadowCompare(user, 'failing', async () => 'old', async () => {
        throw new Error('Worker down')
      })

      expect(result).toBe('old')
      expect(parityCalls()[0]?.[0].body.diff[0].newValue).toBe('Worker down')
    })

    it('does not break the screen when recording fails', async () => {
      const { shadowCompare, SHADOW_ACTIONS } = await load('shadowCompare')
      SHADOW_ACTIONS.cannotRecord = true
      rawRequest.mockRejectedValue(new Error('down'))

      expect(await shadowCompare(user, 'cannotRecord', async () => 'old', async () => 'new')).toBe('old')
    })

    it('passes on a failure of the old function, and records that the Worker answered', async () => {
      const { shadowCompare, SHADOW_ACTIONS } = await load('shadowCompare')
      SHADOW_ACTIONS.oldFails = true
      rawRequest.mockResolvedValue(success({ recorded: true }))

      await expect(
        shadowCompare(
          user,
          'oldFails',
          async () => {
            throw new Error('old failed')
          },
          async () => 'new'
        )
      ).rejects.toThrow('old failed')

      expect(parityCalls()[0]?.[0].body).toMatchObject({
        action: 'oldFails',
        oldResult: { error: 'old failed' },
        newResult: 'new',
        diff: [{ path: '', oldValue: 'old failed', newValue: 'new' }],
      })
    })

    it('the same failure on both sides is not a mismatch', async () => {
      const { shadowCompare, SHADOW_ACTIONS } = await load('shadowCompare')
      SHADOW_ACTIONS.bothFail = true

      await expect(
        shadowCompare(
          user,
          'bothFail',
          async () => {
            throw new Error('Not configured.')
          },
          async () => {
            throw new Error('Not configured. (INTERNAL, request abc)')
          }
        )
      ).rejects.toThrow('Not configured.')

      expect(parityCalls()).toHaveLength(0)
    })
  })
})
