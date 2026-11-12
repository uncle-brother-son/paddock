import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { availableSessionsInputSchema, sessionTimeConflictInputSchema } from '@/contracts'
import type { Queryable } from '@/server/db'
import { authenticateStaff } from './auth/staff'
import { staffAppDir } from './rules/testing/staff-app-dir'

// The staff app has no test runner, so its Worker helpers are tested here, from its checkout
// beside this repo (the same place export:contracts writes to).
const appDir = staffAppDir()
const shared = path.join(appDir, 'backend/paddock/shared')

const load = (name: string) => import(/* @vite-ignore */ path.join(shared, name))

const user = { email: 'jo@example.com' }
const success = (data: unknown) => ({ data: { ok: true, data, requestId: 'worker-request' } })
const refusal = (code: string, message: string) => ({
  data: { ok: false, error: { code, message }, requestId: 'worker-request' },
})

describe('staff app helpers', () => {
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
      'createCustomer',
      'createOneOffSession',
      'createTerminalPaymentIntent',
      'deleteServiceTypeScheduleSlot',
      'generateUpcomingSessions',
      'setAddonLinePrepared',
      'setBookingCheckedIn',
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

    // Brief W14a: these three are thin calls to the Worker now, whose defineRoute refuses an inactive account
    // before anything happens. They never touch the database or the legacy routes themselves.
    it.each(['createTerminalSetupIntent', 'getTerminalConnectionToken', 'saveCustomerCardOnFile'])('%s asks only the Worker, which refuses an inactive account', async (name) => {
      const query = stubStaffTable([row(false)])
      const legacy = vi.fn()
      vi.stubGlobal('paddockBackendApi2', { rawRequest: legacy })
      rawRequest.mockResolvedValue(refusal('FORBIDDEN', INACTIVE))
      const { default: fn } = await import(/* @vite-ignore */ path.join(appDir, `backend/paddock/${name}`))

      await expect(fn({ params: { customerId: 'c1', setupIntentId: 'seti_1' }, user })).rejects.toThrow(INACTIVE)

      expect(rawRequest).toHaveBeenCalledTimes(1)
      expect(legacy).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
    })

    // Brief W18: special requests and status are thin calls to the Worker now, whose defineRoute refuses an inactive
    // account (the routes' own tests, bookings/edits.test.ts). Never the database or the legacy routes themselves.
    it.each(['setBookingSpecialRequests', 'setBookingStatus'])('%s asks only the Worker, which refuses an inactive account', async (name) => {
      const query = stubStaffTable([row(false)])
      const legacy = vi.fn()
      vi.stubGlobal('paddockBackendApi2', { rawRequest: legacy })
      rawRequest.mockResolvedValue(refusal('FORBIDDEN', INACTIVE))
      const { default: fn } = await import(/* @vite-ignore */ path.join(appDir, `backend/paddock/${name}`))

      await expect(fn({ params: { bookingId: '11111111-1111-4111-8111-111111111111', status: 'completed', specialRequests: 'x' }, user })).rejects.toThrow(INACTIVE)

      expect(rawRequest).toHaveBeenCalledTimes(1)
      expect(legacy).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
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

  describe('callWorker time limit', () => {
    const hang = () => new Promise<never>(() => {})
    const TIMED_OUT = "The booking system didn't answer in time. Please try again."

    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('throws WORKER_UNREACHABLE when the limit passes, and not before', async () => {
      const { callWorker, WorkerError } = await load('callWorker')
      rawRequest.mockImplementation(hang)
      const settled = vi.fn()

      const call = callWorker(user, { path: '/x', timeoutMs: 1_000 }).catch((e: unknown) => {
        settled()
        return e
      })

      await vi.advanceTimersByTimeAsync(999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      const err = await call
      expect(err).toBeInstanceOf(WorkerError)
      expect(err).toMatchObject({ code: 'WORKER_UNREACHABLE' })
      const requestId = rawRequest.mock.calls[0]?.[0].headers['X-Request-Id']
      expect((err as Error).message).toBe(`${TIMED_OUT} (WORKER_UNREACHABLE, request ${requestId})`)
    })

    it('an answer inside the limit comes back, with no timer left running', async () => {
      const { callWorker } = await load('callWorker')
      rawRequest.mockResolvedValue(success({ id: 'x' }))

      await expect(callWorker(user, { path: '/x', timeoutMs: 1_000 })).resolves.toEqual({ id: 'x' })
      expect(vi.getTimerCount()).toBe(0)
    })

    it("a refusal inside the limit keeps the Worker's own error, with no timer left running", async () => {
      const { callWorker } = await load('callWorker')
      rawRequest.mockResolvedValue(refusal('FORBIDDEN', 'Admins only.'))

      await expect(callWorker(user, { path: '/x', timeoutMs: 1_000 })).rejects.toThrow('Admins only. (FORBIDDEN, request worker-request)')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('a late answer or late failure after the limit changes nothing', async () => {
      const { callWorker } = await load('callWorker')
      for (const finish of ['resolve', 'reject'] as const) {
        const late = Promise.withResolvers<unknown>()
        rawRequest.mockReturnValue(late.promise)

        const call = callWorker(user, { path: '/x', timeoutMs: 1_000 }).catch((e: unknown) => e)
        await vi.advanceTimersByTimeAsync(1_000)
        const err = await call

        if (finish === 'resolve') late.resolve(success({ id: 'late' }))
        else late.reject(new Error('socket hang up'))
        await vi.advanceTimersByTimeAsync(0)
        expect((err as Error).message).toContain(TIMED_OUT)
      }
    })

    it('has no default: a call without timeoutMs sets no timer and keeps waiting', async () => {
      const { callWorker } = await load('callWorker')
      rawRequest.mockImplementation(hang)
      const settled = vi.fn()

      void callWorker(user, { path: '/x', method: 'POST', body: {}, idempotencyKey: 'k' }).finally(settled)

      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(settled).not.toHaveBeenCalled()
    })
  })

  describe('the nine quote and availability reads', () => {
    const customerId = '00000000-0000-4000-8000-000000000001'
    const sessionId = '00000000-0000-4000-8000-000000000002'
    const serviceTypeId = '00000000-0000-4000-8000-000000000003'
    const startTime = '2030-07-01T10:30:00.000Z'
    const endTime = '2030-07-01T11:30:00.000Z'

    interface Read {
      name: string
      params?: Record<string, unknown>
      path: string
      method: 'GET' | 'POST'
      queryParams?: Record<string, string>
      body?: unknown
    }

    const seats = { sessionId, customerId, partySize: 2, newMembershipPlanId: serviceTypeId }
    const event = { eventId: sessionId, customerId, places: 2, accountHolderAttending: true, newMembershipFrequency: 'monthly' }
    const promo = { code: 'TEN', customerId, lines: [{ key: 'seat:0', itemType: 'booking', amount: 20, isMemberPriced: false }] }
    const conflict = { sessionId, serviceTypeId, startTime, endTime }

    const reads: Read[] = [
      { name: 'quoteBookingSeats', params: seats, path: '/api/v1/staff/quotes/booking-seats', method: 'POST', body: seats },
      { name: 'quoteEvent', params: event, path: '/api/v1/staff/quotes/event', method: 'POST', body: event },
      { name: 'validatePromoCode', params: promo, path: '/api/v1/staff/promo-codes/validate', method: 'POST', body: promo },
      {
        name: 'getCustomerCreditOptions',
        params: { customerId },
        path: '/api/v1/staff/customers/credit-options',
        method: 'GET',
        queryParams: { customerId },
      },
      {
        name: 'getAvailableSessions',
        params: { date: '2030-06-15' },
        path: '/api/v1/staff/sessions/available',
        method: 'GET',
        queryParams: { date: '2030-06-15' },
      },
      {
        name: 'checkCustomerDayConflict',
        params: { customerId, sessionId },
        path: '/api/v1/staff/bookings/day-conflict',
        method: 'GET',
        queryParams: { customerId, sessionId },
      },
      { name: 'checkSessionTimeConflict', params: conflict, path: '/api/v1/staff/sessions/time-conflict', method: 'GET', queryParams: conflict },
      { name: 'getPricingConfig', path: '/api/v1/staff/pricing/config', method: 'GET' },
      { name: 'getPostageSettings', path: '/api/v1/staff/postage/settings', method: 'GET' },
    ]
    // The optional filters, on top of one case per function.
    const calls: Read[] = [
      ...reads,
      {
        name: 'getCustomerCreditOptions',
        params: { customerId, sessionId },
        path: '/api/v1/staff/customers/credit-options',
        method: 'GET',
        queryParams: { customerId, sessionId },
      },
      {
        name: 'getAvailableSessions',
        params: { date: '2030-06-15', serviceTypeId },
        path: '/api/v1/staff/sessions/available',
        method: 'GET',
        queryParams: { date: '2030-06-15', serviceTypeId },
      },
    ]

    const wrapper = async (name: string) => (await load(`../${name}`)).default as (req: unknown) => Promise<unknown>
    const run = async (read: Read) => (await wrapper(read.name))({ ...(read.params ? { params: read.params } : {}), user })

    it.each(calls)('$name $queryParams: right path, method and input, as the user, returning data unchanged', async (read) => {
      const query = vi.fn()
      vi.stubGlobal('paddockData', { query })
      const answer = { any: 'shape', nested: [{ price: '20.00' }] }
      rawRequest.mockResolvedValue(success(answer))

      expect(await run(read)).toBe(answer)

      expect(rawRequest).toHaveBeenCalledTimes(1)
      const call = rawRequest.mock.calls[0]?.[0]
      expect(call.path).toBe(read.path)
      expect(call.method).toBe(read.method)
      expect(call.headers['X-Staff-Email']).toBe(user.email)
      expect(call.headers['Idempotency-Key']).toBeUndefined()
      expect(call.queryParams).toEqual(read.queryParams)
      expect(call.body).toEqual(read.body)
      expect(query).not.toHaveBeenCalled()
    })

    it.each(reads)("$name: a Worker error is thrown with the Worker's message", async (read) => {
      rawRequest.mockResolvedValue(refusal('FORBIDDEN', 'This staff account is inactive. Ask an admin to reactivate it.'))

      await expect(run(read)).rejects.toThrow('This staff account is inactive. Ask an admin to reactivate it. (FORBIDDEN, request worker-request)')
    })

    it.each(reads)('$name: gives up at 15 seconds', async (read) => {
      // Loaded first: an import doesn't finish on a frozen clock, so the call would start too late.
      const fn = await wrapper(read.name)
      vi.useFakeTimers()
      try {
        rawRequest.mockImplementation(() => new Promise<never>(() => {}))
        const settled = vi.fn()

        const call = fn({ ...(read.params ? { params: read.params } : {}), user }).catch((e: unknown) => {
          settled()
          return e
        })

        await vi.advanceTimersByTimeAsync(14_999)
        expect(settled).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await call).toMatchObject({ code: 'WORKER_UNREACHABLE' })
      } finally {
        vi.useRealTimers()
      }
    })

    it('messages returned in a field pass through as answers, not errors', async () => {
      const unpriced = { seats: [], band: null, paidTotal: 0, unpriced: true, error: 'No band is assigned to this session.' }
      const blocked = { blockReason: 'event_members_only', blockMessage: 'This event is for members only.', places: [], total: 0, placesLeft: 4 }
      const refused = { ok: false, reason: 'not_found', message: 'That promo code does not exist.' }

      for (const [name, answer] of [['quoteBookingSeats', unpriced], ['quoteEvent', blocked], ['validatePromoCode', refused]] as const) {
        rawRequest.mockResolvedValue(success(answer))
        expect(await (await wrapper(name))({ params: {}, user })).toBe(answer)
      }
    })

    it('none of them reads the database or shadows any more', async () => {
      for (const { name } of reads) {
        const source = readFileSync(path.join(appDir, `backend/paddock/${name}.ts`), 'utf8')
        expect(source, name).not.toContain('paddockData')
        expect(source, name).not.toMatch(/shadow/i)
      }
    })
  })

  describe('date box checks', () => {
    const dateInput = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/dateInput'))
    const anId = '00000000-0000-4000-8000-000000000001'

    it.each(['2026-11-05', '2026-12-31', '2028-02-29', '0001-01-01', '9999-12-31'])('%s is sent, and the Worker accepts it', async (date) => {
      const { isValidIsoDate } = await dateInput()
      expect(isValidIsoDate(date)).toBe(true)
      expect(availableSessionsInputSchema.safeParse({ date }).success).toBe(true)
    })

    it.each([
      ['a cleared box', ''],
      ['a 5 digit year', '12026-01-01'],
      ['a 6 digit year', '123456-01-01'],
      ['a day that does not exist', '2026-02-30'],
      ['29 February outside a leap year', '2027-02-29'],
      ['month 13', '2026-13-01'],
      ['month 0', '2026-00-10'],
      ['day 0', '2026-01-00'],
      ['year 0000, which Postgres refuses', '0000-01-01'],
      ['no leading zeros', '2026-1-5'],
      ['a date with a time', '2026-11-05T10:00'],
      ['stray spaces', ' 2026-11-05'],
    ])('%s is not sent', async (_label, date) => {
      const { isValidIsoDate } = await dateInput()
      expect(isValidIsoDate(date)).toBe(false)
    })

    it.each(['2026-11-05T14:30:00.000Z', '2028-02-29T00:00:00.000Z', '0001-01-01T00:00:00.000Z'])('%s is sent, and the Worker accepts it', async (time) => {
      const { isValidIsoDateTime } = await dateInput()
      expect(isValidIsoDateTime(time)).toBe(true)
      const input = { sessionId: anId, serviceTypeId: anId, startTime: time, endTime: time }
      expect(sessionTimeConflictInputSchema.safeParse(input).success).toBe(true)
    })

    it.each([
      ['a cleared box', ':00.000Z'],
      ['a 5 digit year', '12026-11-05T14:30:00.000Z'],
      ['what toISOString gives past year 9999', '+010000-01-01T00:30:00.000Z'],
      ['a day that does not exist', '2026-02-30T10:00:00.000Z'],
      ['hour 25', '2026-11-05T25:00:00.000Z'],
      ['a time that already had seconds', '2026-11-05T14:30:15:00.000Z'],
    ])('%s is not sent as a time', async (_label, time) => {
      const { isValidIsoDateTime } = await dateInput()
      expect(isValidIsoDateTime(time)).toBe(false)
    })

    it.each([
      ['New Order', 'frontend/components/checkout/BookingSection.tsx'],
      ['Move', 'frontend/components/MoveBookingDialog.tsx'],
    ])('%s checks the date before it loads sessions, and shows the empty list', (_label, file) => {
      const source = readFileSync(path.join(appDir, file), 'utf8')
      const guard = source.indexOf('if (!isValidIsoDate(')
      expect(guard).toBeGreaterThan(-1)
      expect(guard).toBeLessThan(source.indexOf('loadSessions('))
      expect(source.slice(guard, source.indexOf('loadSessions('))).toContain('setSessionsList([])')
    })
  })

  describe('Edit Start Time save check', () => {
    const dateInput = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/dateInput'))

    it.each([
      ['an empty box', '', 'Choose a new start time'],
      ['a 5 digit year', '12026-11-05T14:30', 'Enter a valid date and time.'],
      ['a 6 digit year', '123456-11-05T14:30', 'Enter a valid date and time.'],
      ['a day that does not exist', '2026-02-30T10:00', 'Enter a valid date and time.'],
      ['year 0000', '0000-01-01T10:00', 'Enter a valid date and time.'],
    ])('%s is refused', async (_label, value, message) => {
      const { startTimeSaveError } = await dateInput()
      expect(startTimeSaveError(value)).toBe(message)
    })

    it('a real time saves', async () => {
      const { startTimeSaveError, datetimeLocalToIsoUtc } = await dateInput()
      expect(startTimeSaveError('2026-11-05T14:30')).toBeNull()
      expect(datetimeLocalToIsoUtc('2026-11-05T14:30')).toBe('2026-11-05T14:30:00.000Z')
    })

    it('the dialog runs the check before it saves', () => {
      const source = readFileSync(path.join(appDir, 'frontend/components/EditSessionStartTimeDialog.tsx'), 'utf8')
      const check = source.indexOf('startTimeSaveError(value)')
      expect(check).toBeGreaterThan(-1)
      expect(check).toBeLessThan(source.indexOf('await setSessionStartTime('))
    })
  })

  describe('setSessionStartTime', () => {
    const save = async (startTime: unknown) => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('staff')) {
          return { data: [{ id: 'staff-1', email: user.email, role: 'admin', can_issue_refunds: true, can_manage_pricing: true, active: true }] }
        }
        if (sql.includes('COUNT(*)')) return { data: [{ count: '0' }] }
        if (sql.includes('UPDATE sessions')) return { data: [{ id: 'session-1', start_time: startTime, end_time: startTime }] }
        if (sql.includes('session_bands')) return { data: [] }
        return { data: [{ id: 'session-1', duration: 60 }] }
      })
      vi.stubGlobal('paddockData', { query })
      const fn = (await import(/* @vite-ignore */ path.join(appDir, 'backend/paddock/setSessionStartTime'))).default
      const result = await fn({ params: { sessionId: 'session-1', startTime }, user })
      return { result, sql: query.mock.calls.map(([sql]) => sql as string) }
    }

    it.each([
      ['a 5 digit year, which Postgres would store', '12026-11-05T14:30:00.000Z'],
      ['a day that does not exist', '2026-02-30T10:00:00.000Z'],
      ['year 0000', '0000-01-01T10:00:00.000Z'],
      ['an empty value', ''],
      ['no timezone', '2026-11-05T14:30'],
      ['not a string', 20261105],
    ])('refuses %s with the same words, and writes nothing', async (_label, startTime) => {
      const { result, sql } = await save(startTime)
      expect(result).toEqual({ updated: false, reason: 'invalid_start_time', message: 'Enter a valid date and time.' })
      expect(sql.some((text) => text.includes('UPDATE sessions'))).toBe(false)
      expect(sql.some((text) => text.includes('FROM sessions'))).toBe(false)
    })

    it('saves a real time', async () => {
      const { result, sql } = await save('2026-11-05T14:30:00.000Z')
      expect(result.updated).toBe(true)
      expect(sql.some((text) => text.includes('UPDATE sessions'))).toBe(true)
    })

    it('the screen shows the refusal in the same words', () => {
      const source = readFileSync(path.join(appDir, 'frontend/components/EditSessionStartTimeDialog.tsx'), 'utf8')
      expect(source).toContain("invalid_start_time: 'Enter a valid date and time.'")
    })

    it('agrees with the screen on what is valid', async () => {
      const { isValidIsoDateTime: onScreen } = await import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/dateInput'))
      const { isValidIsoDateTime: onServer } = await load('isoDateTime')
      for (const value of ['2026-11-05T14:30:00.000Z', '2028-02-29T00:00:00.000Z', '0001-01-01T00:00:00.000Z', '12026-11-05T14:30:00.000Z', '2026-02-30T10:00:00.000Z', '2026-11-05T25:00:00.000Z', '0000-01-01T00:00:00.000Z', '']) {
        expect(onServer(value), value).toBe(onScreen(value))
      }
    })
  })

  describe('New Order price checks', () => {
    const readiness = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/quoteReadiness'))
    const BOOKING = "Couldn't get the price for this booking. Please try again."
    const EVENT = "Couldn't get the price for this event. Please try again."
    const LOADING = 'Getting the price…'
    const inputs = { sessionId: 's1', bookingType: 'public', customerId: 'c1', partySize: 2, planId: null }

    describe('booking', () => {
      it('a current, priced quote is used', async () => {
        const { bookingQuoteKey, bookingPriceProblem, currentBookingPrice } = await readiness()
        const key = bookingQuoteKey(inputs)
        const report = { key, status: 'ready', price: 40 }
        expect(bookingPriceProblem(report, key)).toBeNull()
        expect(currentBookingPrice(report, key)).toBe(40)
      })

      it('a free booking is a price, not a missing one', async () => {
        const { bookingQuoteKey, bookingPriceProblem, currentBookingPrice } = await readiness()
        const key = bookingQuoteKey(inputs)
        expect(bookingPriceProblem({ key, status: 'ready', price: 0 }, key)).toBeNull()
        expect(currentBookingPrice({ key, status: 'ready', price: 0 }, key)).toBe(0)
      })

      it.each([
        ['failed', BOOKING],
        ['loading', LOADING],
      ])('a %s quote is refused and gives no price', async (status, message) => {
        const { bookingQuoteKey, bookingPriceProblem, currentBookingPrice } = await readiness()
        const key = bookingQuoteKey(inputs)
        const report = { key, status, price: null }
        expect(bookingPriceProblem(report, key)).toBe(message)
        expect(currentBookingPrice(report, key)).toBeNull()
      })

      it('no report yet is refused, as still loading', async () => {
        const { bookingQuoteKey, bookingPriceProblem } = await readiness()
        expect(bookingPriceProblem(null, bookingQuoteKey(inputs))).toBe(LOADING)
      })

      it.each([
        ['customer', { customerId: 'c2' }],
        ['party size', { partySize: 3 }],
        ['session', { sessionId: 's2' }],
        ['membership being bought', { planId: 'p1' }],
      ])('a quote for another %s is stale, even a good one', async (_label, change) => {
        const { bookingQuoteKey, bookingPriceProblem, currentBookingPrice } = await readiness()
        const report = { key: bookingQuoteKey(inputs), status: 'ready', price: 40 }
        const key = bookingQuoteKey({ ...inputs, ...change })
        expect(bookingPriceProblem(report, key)).toBe(LOADING)
        expect(currentBookingPrice(report, key)).toBeNull()
      })

      it('a private price does not depend on the customer', async () => {
        const { bookingQuoteKey } = await readiness()
        const privateInputs = { ...inputs, bookingType: 'private' }
        expect(bookingQuoteKey({ ...privateInputs, customerId: 'c2' })).toBe(bookingQuoteKey(privateInputs))
        expect(bookingQuoteKey({ ...privateInputs, partySize: 3 })).not.toBe(bookingQuoteKey(privateInputs))
      })

      it('prices that trying again cannot fix say what to do instead', async () => {
        const { bookingQuoteKey, bookingPriceProblem, BAND_UNPRICED_MESSAGE, PRIVATE_PRICE_NOT_SET_MESSAGE } = await readiness()
        const key = bookingQuoteKey(inputs)
        expect(bookingPriceProblem({ key, status: 'unpriced', price: null }, key)).toBe(BAND_UNPRICED_MESSAGE)
        expect(bookingPriceProblem({ key, status: 'no_private_price', price: null }, key)).toBe(PRIVATE_PRICE_NOT_SET_MESSAGE)
      })

      it('no session means nothing to price', async () => {
        const { bookingQuoteKey, bookingPriceProblem } = await readiness()
        const key = bookingQuoteKey({ ...inputs, sessionId: null })
        expect(key).toBeNull()
        expect(bookingPriceProblem(null, key)).toBeNull()
      })
    })

    describe('event', () => {
      const event = { eventId: 'e1', customerId: 'c1', places: 2, attending: true, newMembershipFrequency: null }
      const quote = { blockMessage: null }

      it('a current quote is used', async () => {
        const { eventQuoteKey, currentEventQuote, eventPriceProblem } = await readiness()
        const key = eventQuoteKey(event)
        const report = { key, status: 'ready', quote }
        expect(currentEventQuote(report, key)).toBe(quote)
        expect(eventPriceProblem(report, key)).toBeNull()
      })

      it('a failed quote is refused', async () => {
        const { eventQuoteKey, eventPriceProblem } = await readiness()
        const key = eventQuoteKey(event)
        expect(eventPriceProblem({ key, status: 'failed', quote: null }, key)).toBe(EVENT)
      })

      it('no quote yet is refused, as still loading', async () => {
        const { eventQuoteKey, eventPriceProblem } = await readiness()
        expect(eventPriceProblem(null, eventQuoteKey(event))).toBe(LOADING)
      })

      it('a failure for older inputs is not a failure for these', async () => {
        const { eventQuoteKey, eventPriceProblem } = await readiness()
        const report = { key: eventQuoteKey(event), status: 'failed', quote: null }
        expect(eventPriceProblem(report, eventQuoteKey({ ...event, places: 3 }))).toBe(LOADING)
      })

      it.each([
        ['places', { places: 3 }],
        ['customer', { customerId: 'c2' }],
        ['attending switch', { attending: false }],
        ['membership being bought', { newMembershipFrequency: 'monthly' }],
      ])('a quote for other %s is stale', async (_label, change) => {
        const { eventQuoteKey, currentEventQuote, eventPriceProblem } = await readiness()
        const report = { key: eventQuoteKey(event), status: 'ready', quote }
        const key = eventQuoteKey({ ...event, ...change })
        expect(currentEventQuote(report, key)).toBeNull()
        expect(eventPriceProblem(report, key)).toBe(LOADING)
      })

      it('a blocked event shows its own message, because the total would leave it out', async () => {
        const { eventQuoteKey, eventPriceProblem } = await readiness()
        const key = eventQuoteKey(event)
        expect(eventPriceProblem({ key, status: 'ready', quote: { blockMessage: 'Members only.' } }, key)).toBe('Members only.')
      })

      it('no event means nothing to price', async () => {
        const { eventQuoteKey, eventPriceProblem } = await readiness()
        expect(eventPriceProblem(null, eventQuoteKey({ ...event, eventId: null }))).toBeNull()
      })
    })

    describe('the other values in the total', () => {
      it('membership', async () => {
        const { membershipPriceProblem: problem, MEMBERSHIP_PRICE_MESSAGE, MEMBERSHIP_PRICE_NOT_SET_MESSAGE } = await readiness()
        const plan = { price_monthly: '30.00', price_yearly: null }
        expect(problem(null, undefined, 'monthly', false)).toBeNull()
        expect(problem('p1', plan, 'monthly', false)).toBeNull()
        expect(problem('p1', undefined, 'monthly', false)).toBe(MEMBERSHIP_PRICE_MESSAGE)
        expect(problem('p1', undefined, 'monthly', true)).toBe(LOADING)
        expect(problem('p1', plan, 'yearly', true)).toBe(MEMBERSHIP_PRICE_NOT_SET_MESSAGE)
      })

      it('session pass', async () => {
        const { sessionPassPriceProblem: problem, SESSION_PASS_PRICE_MESSAGE } = await readiness()
        expect(problem(null, undefined, false)).toBeNull()
        expect(problem('t1', { price: '50.00' }, false)).toBeNull()
        expect(problem('t1', { price: '0.00' }, false)).toBeNull()
        expect(problem('t1', undefined, false)).toBe(SESSION_PASS_PRICE_MESSAGE)
        expect(problem('t1', undefined, true)).toBe(LOADING)
        expect(problem('t1', { price: null }, true)).toBe(SESSION_PASS_PRICE_MESSAGE)
      })

      it('postage', async () => {
        const { postagePriceProblem: problem, POSTAGE_PRICE_MESSAGE } = await readiness()
        expect(problem(false, false, true)).toBeNull()
        expect(problem(true, true, false)).toBeNull()
        expect(problem(true, false, false)).toBe(LOADING)
        expect(problem(true, false, true)).toBe(POSTAGE_PRICE_MESSAGE)
        expect(problem(true, true, true)).toBe(POSTAGE_PRICE_MESSAGE)
      })

      it('promo: a discount only counts for the basket it was checked against', async () => {
        const { promoProblem: problem, promoCheckKey, PROMO_CHECK_MESSAGE } = await readiness()
        const key = promoCheckKey('c1', 'SAVE', '[lines]')
        expect(problem(false, null, key)).toBeNull()
        expect(problem(true, { key, status: 'ok' }, key)).toBeNull()
        expect(problem(true, null, key)).toBe(LOADING)
        expect(problem(true, { key, status: 'failed' }, key)).toBe(PROMO_CHECK_MESSAGE)
        expect(problem(true, { key, status: 'ok' }, promoCheckKey('c1', 'SAVE', '[other lines]'))).toBe(LOADING)
        expect(problem(true, { key, status: 'ok' }, promoCheckKey('c2', 'SAVE', '[lines]'))).toBe(LOADING)
      })

      it('only the loading line counts as loading', async () => {
        const { isPriceLoading } = await readiness()
        expect(isPriceLoading(LOADING)).toBe(true)
        expect(isPriceLoading(BOOKING)).toBe(false)
        expect(isPriceLoading(null)).toBe(false)
      })

      it('the first problem wins, and none means null', async () => {
        const { firstProblem } = await readiness()
        expect(firstProblem(null, 'a', 'b')).toBe('a')
        expect(firstProblem(null, null)).toBeNull()
      })
    })

    describe('what the screen does with them', () => {
      const checkout = () => readFileSync(path.join(appDir, 'frontend/components/CheckoutDialog.tsx'), 'utf8')

      it('Continue, Delivery and Complete Order all refuse', () => {
        const source = checkout()
        const body = (name: string) => source.slice(source.indexOf(`function ${name}(`), source.indexOf('\n  }\n', source.indexOf(`function ${name}(`)))
        expect(body('validateBasket')).toContain('return blockingProblem')
        expect(body('handleContinueFromDelivery')).toContain('blockingProblem')
        expect(body('handleContinueFromDelivery')).toContain('postageProblem')
        expect(body('validatePayment')).toContain('firstProblem(blockingProblem, postageProblem)')
      })

      it('both summaries and the payment step show the line instead of a total', () => {
        const source = checkout()
        expect(source.match(/\{summaryProblem \? \(/g)).toHaveLength(2)
        expect(source).toContain('priceProblem={summaryProblem}')
        // Every total on the screen is behind that check.
        expect(source.match(/formatCurrency\(amountDue\.toFixed\(2\)\)/g)).toHaveLength(2)
      })

      it('the cash confirmation is hidden while the amount cannot be trusted', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/checkout/PaymentStep.tsx'), 'utf8')
        expect(source).toContain("state.method === 'cash' && !hasMembership && !priceProblem")
      })

      it('W14a: the promo is the basket quote\'s: a refused code comes off with its words, and Complete Order needs the quote', () => {
        const source = checkout()
        expect(source).not.toContain('proceed with the code')
        expect(source).toContain('const refused = promoRefusal(quote)')
        expect(source).toContain('if (!quote) return PRICE_LOADING_MESSAGE')
      })

      it('a refusal while loading opens the section, so the quote can run', () => {
        const source = checkout()
        expect(source).toContain("bookingProblem === BOOKING_PRICE_MESSAGE || isPriceLoading(bookingProblem)")
        expect(source).toContain("eventProblem === EVENT_PRICE_MESSAGE || isPriceLoading(eventProblem)")
      })

      it('Delivery shows the postage problem itself, loading or failed', async () => {
        const source = checkout()
        const start = source.indexOf('function handleContinueFromDelivery')
        const body = source.slice(start, source.indexOf('\n  }\n', start))
        expect(body).toContain('if (postageProblem) {\n      setErrorMessage(postageProblem)')
        expect(source).not.toContain('Postage prices are not configured yet')
        const { postagePriceProblem, POSTAGE_PRICE_MESSAGE } = await readiness()
        expect(POSTAGE_PRICE_MESSAGE).toBe("Couldn't get the postage price. Please try again.")
        expect(postagePriceProblem(true, false, true)).toBe(POSTAGE_PRICE_MESSAGE)
        expect(postagePriceProblem(true, false, false)).toBe(LOADING)
      })

      describe('no customer chosen', () => {
        const CHOOSE = 'Choose a customer to see the price.'
        const key = 'the-key'

        it('a booking says so, instead of saying the price is coming', async () => {
          const { bookingPriceProblem } = await readiness()
          expect(bookingPriceProblem(null, key, true)).toBe(CHOOSE)
          expect(bookingPriceProblem({ key: 'older', status: 'loading', price: null }, key, true)).toBe(CHOOSE)
          expect(bookingPriceProblem(null, key)).toBe(LOADING)
        })

        it('an event says so', async () => {
          const { eventPriceProblem } = await readiness()
          expect(eventPriceProblem(null, key, true)).toBe(CHOOSE)
          expect(eventPriceProblem(null, key)).toBe(LOADING)
        })

        it('a promo code says so', async () => {
          const { promoProblem } = await readiness()
          expect(promoProblem(true, null, key, true)).toBe(CHOOSE)
          expect(promoProblem(true, null, key)).toBe(LOADING)
        })

        it('nothing selected is still no problem', async () => {
          const { bookingPriceProblem, eventPriceProblem, promoProblem } = await readiness()
          expect(bookingPriceProblem(null, null, true)).toBeNull()
          expect(eventPriceProblem(null, null, true)).toBeNull()
          expect(promoProblem(false, null, key, true)).toBeNull()
        })

        it('it looks like waiting, not an error, and doesn\'t open a section', async () => {
          const { isPriceWaiting, isPriceLoading } = await readiness()
          expect(isPriceWaiting(CHOOSE)).toBe(true)
          expect(isPriceWaiting(LOADING)).toBe(true)
          expect(isPriceWaiting("Couldn't get the postage price. Please try again.")).toBe(false)
          expect(isPriceLoading(CHOOSE)).toBe(false)
        })

        it('New Order passes it on, for public bookings only: a private price needs no customer', () => {
          const source = checkout()
          expect(source).toContain("bookingPriceProblem(bookingPriceReport, bookingKey, booking.selectedSession?.booking_type === 'public' && !customer)")
          expect(source).toContain('eventPriceProblem(eventQuoteReport, eventKey, !customer)')
          // W14a: the basket quote asks for a customer the same way.
          expect(source).toContain('? CHOOSE_CUSTOMER_MESSAGE')
          expect(source.match(/isPriceWaiting\(summaryProblem\)/g)).toHaveLength(2)
        })
      })

      describe('a section with an out of date price', () => {
        const stale = (key: string) => [{ section: 'booking', key, priceLoading: true }]

        it('opens when its inputs changed while it was closed', async () => {
          const { sectionsToOpen } = await readiness()
          expect(sectionsToOpen([], stale('customer-b'), { booking: 'customer-a' }).toOpen).toEqual(['booking'])
        })

        it('stays closed once staff collapse it, until its inputs change', async () => {
          const { sectionsToOpen } = await readiness()
          // Open while the quote runs, so these are the inputs it was last open for.
          const open = sectionsToOpen(['booking'], stale('customer-a'), {})
          expect(open.toOpen).toEqual([])
          const collapsed = sectionsToOpen([], stale('customer-a'), open.keysSeenOpen)
          expect(collapsed.toOpen).toEqual([])
          expect(sectionsToOpen([], stale('customer-b'), collapsed.keysSeenOpen).toOpen).toEqual(['booking'])
        })

        it('a second change after that opens it again', async () => {
          const { sectionsToOpen } = await readiness()
          const reopened = sectionsToOpen(['booking'], stale('customer-b'), { booking: 'customer-a' })
          expect(sectionsToOpen([], stale('customer-c'), reopened.keysSeenOpen).toOpen).toEqual(['booking'])
        })

        it('stays closed with a price, a failed price or nothing selected', async () => {
          const { sectionsToOpen } = await readiness()
          expect(sectionsToOpen([], [{ section: 'booking', key: 'customer-b', priceLoading: false }], { booking: 'customer-a' }).toOpen).toEqual([])
          expect(sectionsToOpen([], [{ section: 'booking', key: null, priceLoading: false }], { booking: 'customer-a' }).toOpen).toEqual([])
        })

        it('treats the two sections separately', async () => {
          const { sectionsToOpen } = await readiness()
          const sections = [
            { section: 'booking', key: 'a', priceLoading: false },
            { section: 'event', key: 'b', priceLoading: true },
          ]
          expect(sectionsToOpen(['booking'], sections, { event: 'old' }).toOpen).toEqual(['event'])
        })

        it('the screen checks both sections, on the basket only, and keeps what is open', () => {
          const source = checkout()
          const start = source.indexOf('const { toOpen, keysSeenOpen } = sectionsToOpen(')
          expect(start).toBeGreaterThan(0)
          const effect = source.slice(source.lastIndexOf('useEffect(', start), source.indexOf('\n  }, [', start))
          expect(effect).toContain("if (phase !== 'basket') return")
          expect(effect).toContain("{ section: 'booking', key: bookingKey, priceLoading: isPriceLoading(bookingProblem) }")
          expect(effect).toContain("{ section: 'event', key: eventKey, priceLoading: isPriceLoading(eventProblem) }")
          expect(effect).toContain('setSectionsOverride([...opened, ...toOpen])')
        })
      })

      it('the loading line does not look like an error', () => {
        const summaries = checkout().match(/isPriceWaiting\(summaryProblem\) \? 'text-muted-foreground' : 'text-destructive'/g)
        expect(summaries).toHaveLength(2)
        const step = readFileSync(path.join(appDir, 'frontend/components/checkout/PaymentStep.tsx'), 'utf8')
        expect(step).toContain("isPriceLoading(priceProblem) ? 'text-muted-foreground' : 'text-destructive'")
      })
    })

    describe('credits', () => {
      const MESSAGE = "Couldn't load this customer's credits and member prices. Please try again."

      const LOADING_CREDITS = "Getting this customer's credits and member prices…"

      it('a failure says so', async () => {
        const { creditLoadProblem } = await readiness()
        expect(creditLoadProblem('failed')).toBe(MESSAGE)
      })

      it('still loading blocks the order too, without saying it failed', async () => {
        const { creditLoadProblem } = await readiness()
        expect(creditLoadProblem('loading')).toBe(LOADING_CREDITS)
      })

      it('both loading lines go once they stop being the problem', async () => {
        const { bannerStillApplies } = await readiness()
        expect(bannerStillApplies(LOADING_CREDITS, LOADING_CREDITS)).toBe(true)
        expect(bannerStillApplies(LOADING, LOADING)).toBe(true)
        expect(bannerStillApplies(LOADING_CREDITS, LOADING)).toBe(false)
        expect(bannerStillApplies(LOADING, null)).toBe(false)
      })

      it('a "please try again" line stays through the retry, and goes once nothing is wrong', async () => {
        const { bannerStillApplies } = await readiness()
        expect(bannerStillApplies(MESSAGE, MESSAGE)).toBe(true)
        expect(bannerStillApplies(MESSAGE, LOADING)).toBe(true)
        expect(bannerStillApplies(MESSAGE, null)).toBe(false)
        expect(bannerStillApplies("Couldn't get the postage price. Please try again.", null)).toBe(false)
      })

      it('any other banner is left alone', async () => {
        const { bannerStillApplies } = await readiness()
        expect(bannerStillApplies('Select a customer.', null)).toBe(true)
        expect(bannerStillApplies(null, LOADING)).toBe(true)
      })

      it('the credits line never counts as a price, so it can\'t open a section', async () => {
        const { isPriceLoading } = await readiness()
        expect(isPriceLoading(LOADING_CREDITS)).toBe(false)
      })

      it('New Order clears a loading line once it stops being the problem', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/CheckoutDialog.tsx'), 'utf8')
        expect(source).toContain('bannerStillApplies(current, currentProblem) ? current : null')
      })

      it('Add Guest clears the line when the lookup finishes', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/AddGuestDialog.tsx'), 'utf8')
        expect(source).toContain("if (creditStatus === 'loading') return")
        expect(source).toContain("current === CREDIT_LOADING_MESSAGE || (current === CREDIT_LOAD_MESSAGE && creditStatus === 'ready') ? null : current")
      })

      it('loaded does not', async () => {
        const { creditLoadProblem } = await readiness()
        expect(creditLoadProblem('ready')).toBeNull()
      })

      it('Add Guest checks before its first call, which can add the guest', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/AddGuestDialog.tsx'), 'utf8')
        const start = source.indexOf('async function handleInitialSubmit')
        const check = source.indexOf('creditLoadProblem(creditStatus)', start)
        expect(check).toBeGreaterThan(start)
        expect(check).toBeLessThan(source.indexOf('await addGuest(', start))
      })
    })

    describe('member prices arriving after a line was added', () => {
      it('a line at the system price follows it', async () => {
        const { repriceLine } = await readiness()
        expect(repriceLine({ unitPrice: 10, systemUnitPrice: 10 }, 8)).toEqual({ unitPrice: 8, systemUnitPrice: 8 })
        expect(repriceLine({ unitPrice: 8, systemUnitPrice: 8 }, 10)).toEqual({ unitPrice: 10, systemUnitPrice: 10 })
      })

      it('a price staff changed stays, with its reason', async () => {
        const { repriceLine } = await readiness()
        const line = { unitPrice: 5, systemUnitPrice: 10, priceOverrideReason: 'Damaged' }
        expect(repriceLine(line, 8)).toEqual({ unitPrice: 5, systemUnitPrice: 8, priceOverrideReason: 'Damaged' })
      })

      it('a changed price that now matches needs no reason', async () => {
        const { repriceLine } = await readiness()
        expect(repriceLine({ unitPrice: 8, systemUnitPrice: 10, priceOverrideReason: 'Member' }, 8)).toEqual({ unitPrice: 8, systemUnitPrice: 8 })
      })

      it('an unknown item or an unchanged price leaves the line alone', async () => {
        const { repriceLine } = await readiness()
        const line = { unitPrice: 10, systemUnitPrice: 10 }
        expect(repriceLine(line, null)).toBe(line)
        expect(repriceLine(line, 10)).toBe(line)
      })
    })

    describe('cash recorded above what was confirmed', () => {
      it('gives the difference', async () => {
        const { cashShortfall } = await readiness()
        expect(cashShortfall('cash', 25, 30)).toBe(5)
        expect(cashShortfall('cash', 0.1, 0.3)).toBe(0.2)
      })

      it.each([
        ['the same', 'cash', 30, 30],
        ['less than confirmed', 'cash', 30, 25],
        ['a rounding difference', 'cash', 30, 30.004],
        ['a card payment', 'card', 25, 30],
        ['no method', null, 25, 30],
        ['no recorded amount', 'cash', 25, undefined],
      ])('nothing for %s', async (_label, method, confirmed, recorded) => {
        const { cashShortfall } = await readiness()
        expect(cashShortfall(method, confirmed, recorded)).toBe(0)
      })
    })

    describe('empty session list', () => {
      it('an outage does not read as an empty day', async () => {
        const { sessionListEmptyText } = await readiness()
        expect(sessionListEmptyText(true)).toBe("Couldn't load sessions. Please try again.")
        expect(sessionListEmptyText(false)).toBe('No sessions scheduled for this date.')
      })

      it.each([
        ['New Order', 'frontend/components/checkout/BookingSection.tsx'],
        ['Move', 'frontend/components/MoveBookingDialog.tsx'],
      ])('%s tells the list when the load failed', (_label, file) => {
        const source = readFileSync(path.join(appDir, file), 'utf8')
        expect(source).toContain('setSessionsLoadFailed(true)')
        expect(source).toContain('loadFailed={sessionsLoadFailed}')
        // A guarded date is an empty list, not a failed load.
        expect(source.indexOf('setSessionsLoadFailed(false)')).toBeLessThan(source.indexOf('if (!isValidIsoDate('))
      })
    })
  })

  describe('cash must match what was confirmed', () => {
    const CHANGED = (amount: string) => `The amount due has changed to £${amount}. Check it with the customer and confirm again.`
    const NOTHING_LEFT = "The amount due has changed. There's nothing left to collect in cash. Check it with the customer and confirm again."
    const AMOUNT_CHANGED = 'The amount due has changed. Check it with the customer and confirm again.'
    const staffRow = { id: 'staff-1', email: user.email, role: 'admin', can_issue_refunds: true, can_manage_pricing: false, active: true }
    const screen = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/cashConfirmation'))
    const backend = (name: string) => import(/* @vite-ignore */ path.join(appDir, `backend/paddock/${name}`))
    const isWrite = (sql: string) => /\b(INSERT INTO|UPDATE|DELETE FROM)\b/.test(sql)
    /** The writes that move money or change the booking: a claim's finishing row isn't one. */
    const notAudit = (sql: string) => !/^\s*INSERT INTO audit_log/.test(sql)

    /** A fake database: the first matching pattern answers, and anything else returns no rows. */
    function stubDatabase(answers: Array<[RegExp, (params: unknown[]) => unknown[]]>) {
      const sql: string[] = []
      const query = vi.fn(async (text: string, params: unknown[] = []) => {
        sql.push(text)
        if (/FROM staff/.test(text)) return { data: [staffRow] }
        const answer = answers.find(([pattern]) => pattern.test(text))
        return { data: answer ? answer[1](params) : [] }
      })
      vi.stubGlobal('paddockData', { query })
      return { sql, writes: () => sql.filter(isWrite) }
    }

    describe('the rule', () => {
      it('refuses a higher figure, with the new amount', async () => {
        const { cashDifferenceRefusal } = await load('cashConfirmation')
        expect(cashDifferenceRefusal('cash', 25, 20)).toEqual({ reason: 'cash_amount_changed', message: CHANGED('25.00'), amountToCollect: 25 })
      })

      it('refuses one penny more', async () => {
        const { cashDifferenceRefusal } = await load('cashConfirmation')
        expect(cashDifferenceRefusal('cash', 20.01, 20)?.message).toBe(CHANGED('20.01'))
      })

      it('refuses a lower figure the same way', async () => {
        const { cashDifferenceRefusal } = await load('cashConfirmation')
        expect(cashDifferenceRefusal('cash', 15, 20)).toEqual({ reason: 'cash_amount_changed', message: CHANGED('15.00'), amountToCollect: 15 })
      })

      it('refuses one penny less', async () => {
        const { cashDifferenceRefusal } = await load('cashConfirmation')
        expect(cashDifferenceRefusal('cash', 19.99, 20)?.message).toBe(CHANGED('19.99'))
      })

      it('refuses when nothing is left to collect but cash was confirmed', async () => {
        const { cashDifferenceRefusal } = await load('cashConfirmation')
        expect(cashDifferenceRefusal('cash', 0, 20)).toEqual({ reason: 'cash_amount_changed', message: NOTHING_LEFT, amountToCollect: 0 })
      })

      it('only says nothing is left when the figure really is £0.00', async () => {
        const { cashDifferenceRefusal } = await load('cashConfirmation')
        expect(cashDifferenceRefusal('cash', 0.004, 20)?.message).toBe(NOTHING_LEFT)
        expect(cashDifferenceRefusal('cash', 0.01, 20)?.message).toBe(CHANGED('0.01'))
      })

      it.each([
        ['the same amount', 'cash', 20, 20],
        ['half a penny more', 'cash', 20.005, 20],
        ['half a penny less', 'cash', 19.995, 20],
        // Both come out a hair over half a penny. Refusing them would show staff the figure they
        // had just confirmed, every time they confirmed it.
        ['a tick rounded up', 'cash', 8.995, 9],
        ['a tick rounded down', 'cash', 12.345, 12.34],
        ['adding up noise', 'cash', 0.1 + 0.2, 0.3],
        ['a card', 'card', 25, 20],
        ['the reader', 'reader', 25, 20],
        ['no method', undefined, 25, 20],
      ])('lets through %s', async (_label, method, due, confirmed) => {
        const { cashDifferenceRefusal } = await load('cashConfirmation')
        expect(cashDifferenceRefusal(method, due, confirmed)).toBeNull()
      })

      it.each([
        ['missing', undefined],
        ['null', null],
        ['not a number', Number.NaN],
        ['infinite', Number.POSITIVE_INFINITY],
      ])('a %s figure counts as nothing confirmed', async (_label, confirmed) => {
        const { cashDifferenceRefusal } = await load('cashConfirmation')
        expect(cashDifferenceRefusal('cash', 25, confirmed)?.reason).toBe('cash_amount_changed')
        expect(cashDifferenceRefusal('cash', 0, confirmed)).toBeNull()
      })
    })

    describe('pennies', () => {
      const both = async () => [await load('cashConfirmation'), await screen()]

      it.each([
        ['nothing left', [1, 0.95, 0.05], 0],
        ['nothing left, with noise above nothing', [6.95, 6.85, 0.1], 0],
        ['a real remainder', [10, 3], 7],
        ['one penny', [0.01], 0.01],
        ['more credit than due', [5, 10], 0],
      ])('amountLeftToPay: %s', async (_label, [due, ...parts], left) => {
        for (const side of await both()) expect(side.amountLeftToPay(due, ...parts)).toBe(left)
      })

      it.each([
        ['adding up noise', 6.95 - 2.9 + 2.9, 6.95, false],
        ['the same amount', 6.95, 6.95, false],
        ['one penny more', 6.96, 6.95, true],
        ['one penny less', 6.94, 6.95, false],
      ])('exceedsAmount: %s', async (_label, parts, amount, exceeds) => {
        for (const side of await both()) expect(side.exceedsAmount(parts, amount)).toBe(exceeds)
      })

      it('the gift card and store credit boxes hold pennies', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/checkout/PaymentStep.tsx'), 'utf8')
        expect(source).toContain('giftCardAmount: toPennies(Math.max(0, defaultAmount))')
        expect(source).toContain('? toPennies(Math.max(0, Math.min(parsed, balance, totalDueNow - storeCreditAppliedAmount)))')
        expect(source).toContain('toPennies(Math.max(0, Math.min(parsed, max)))')
        // W14a: Add Guest, Move and Settle keep this sum (legacyPaymentFigures); New Order takes the quote's.
        const helpers = readFileSync(path.join(appDir, 'frontend/utils/basketQuote.ts'), 'utf8')
        expect(helpers).toContain('const remainder = amountLeftToPay(amountDueNow, giftCardApplied, storeCreditApplied)')
      })

      it.each(['AddGuestDialog', 'MoveBookingDialog', 'SettleLapsedPaymentDialog', 'CheckoutDialog'])('%s compares credit to the penny', (name) => {
        const source = readFileSync(path.join(appDir, `frontend/components/${name}.tsx`), 'utf8')
        expect(source).toMatch(/exceedsAmount\(giftCardAmount \+ storeCreditAmount, /)
        expect(source).not.toMatch(/giftCardAmount \+ storeCreditAmount > /)
      })
    })

    describe('New Order', () => {
      // W16: the tests that ran the old createOrder's body (the confirmed cash and credit figures) went with it;
      // the Worker's own tests hold the order to those rules now (amounts.ts, place-order.test.ts).
      describe('a method held after the choices went', () => {
        const choice = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/paymentMethodChoice'))
        const held = (method: string | null, confirmedCashAmount: number | null = null) => ({ method, confirmedCashAmount })

        it('with the method somehow still held, nothing is sent and the order still finishes', async () => {
          const { orderMethodFields, readerReferenceMissing } = await choice()
          expect(orderMethodFields(held('reader'), 0, 0, false)).toEqual({})
          expect(orderMethodFields(held('cash', 5), 0, 0, false)).toEqual({})
          expect(orderMethodFields(held('card'), 0, 0, false)).toEqual({})
          expect(readerReferenceMissing(undefined, undefined)).toBe(false)
        })

        it('the message stays for a reader that was sent and came back with no reference', async () => {
          const { readerReferenceMissing } = await choice()
          expect(readerReferenceMissing('reader', undefined)).toBe(true)
          expect(readerReferenceMissing('reader', { orderId: 'order-1' })).toBe(false)
          expect(readerReferenceMissing('cash', undefined)).toBe(false)
          expect(readerReferenceMissing('card', undefined)).toBe(false)
        })

        it('a membership keeps the reader with nothing else left to pay, and forces the save', async () => {
          const { clearHiddenMethod, orderMethodFields, paymentChoicesShown } = await choice()
          expect(paymentChoicesShown(0, true)).toBe(true)
          expect(clearHiddenMethod(held('reader'), paymentChoicesShown(0, true)).method).toBe('reader')
          expect(orderMethodFields(held('reader'), 0, 30, false)).toEqual({ method: 'reader', readerSaveCard: true })
        })

        it('clearing takes the tick with it, and leaves everything else alone', async () => {
          const { clearHiddenMethod } = await choice()
          const state = { ...held('cash', 20), storeCreditAmount: 20, giftCardAmount: 0 }
          expect(clearHiddenMethod(state, false)).toEqual({ method: null, confirmedCashAmount: null, storeCreditAmount: 20, giftCardAmount: 0 })
          expect(clearHiddenMethod(state, true)).toBe(state)
          const none = held(null)
          expect(clearHiddenMethod(none, false)).toBe(none)
        })

        it('held cash that was never sent can\'t raise the cash warning', async () => {
          const { cashShortfall } = await import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/quoteReadiness'))
          expect(cashShortfall(null, 0, 20)).toBe(0)
          expect(cashShortfall('cash', 15, 20)).toBe(5)
        })

        it('the method going by itself isn\'t staff acting on a refusal, so its banner stays', async () => {
          const { methodOnlyCleared, paymentInputChanged } = await screen()
          const base = { method: 'cash', selectedGiftCard: null, giftCardAmount: 0, storeCreditAmount: 5, confirmedCashAmount: null }
          expect(paymentInputChanged(base, { ...base, method: null })).toBe(false)
          expect(paymentInputChanged({ ...base, method: null }, base)).toBe(true)
          expect(paymentInputChanged(base, { ...base, method: 'card' })).toBe(true)
          expect(paymentInputChanged(base, { ...base, method: null, storeCreditAmount: 6 })).toBe(true)
          expect(methodOnlyCleared('reader', null)).toBe(true)
          expect(methodOnlyCleared(null, 'reader')).toBe(false)
          expect(methodOnlyCleared(null, null)).toBe(false)
        })
      })
    })

    // Brief W20: addBookingGuest is a thin call to the Worker's guests route now. Its rules (the prices, Q25 and Q27,
    // the cash figure, the parts over the price, the claims, one transaction) are the Worker's and tested there
    // (server/rules/bookings/add-guest.test.ts); here, the wrapper: what it sends, and the old answer shapes it gives.
    describe('Add Guest (W20: a thin call to the Worker)', () => {
      const BOOKING = '11111111-1111-4111-8111-111111111111'
      const refused = (code: string, details: Record<string, unknown>) => ({
        data: { ok: false, error: { code, message: String(details['message']), details: { action: 'add_guest', ...details } }, requestId: 'worker-request' },
      })
      const add = async (params: Record<string, unknown>) => {
        const query = vi.fn()
        vi.stubGlobal('paddockData', { query })
        const fn = (await backend('addBookingGuest')).default
        return { result: () => fn({ params: { bookingId: BOOKING, ...params }, user }), query }
      }
      const guest = { guestName: 'Sam', guestsOver18Confirmed: true }
      const impact = { amountDue: 25, guestAmount: 25, addonsAmount: 0, creditAvailable: false }

      it('sends the guest, the add-ons, the payment, the figures on screen and the press key to the guests route, answers its data, and never touches the database', async () => {
        const added = { added: true, limitReached: false, guest: { id: 'g', guest_name: 'Sam', guest_email: null, guest_type: 'additional_guest', unit_price: 25, pay_by: 'paid' }, addonLineIds: [] }
        rawRequest.mockResolvedValue(success(added))
        const addons = [{ addonId: 'a', quantity: 1, redemptionSource: 'paid' as const }]
        const { result, query } = await add({ ...guest, addons, payment: { method: 'cash', confirmedCashAmount: 30 }, figures: { amountDue: 30, toCollect: 30 }, idempotencyKey: 'press-key-0000000001' })
        expect(await result()).toEqual(added)
        expect(rawRequest).toHaveBeenCalledTimes(1)
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({
          path: `/api/v1/staff/bookings/${BOOKING}/guests`,
          method: 'POST',
          body: { ...guest, addons, payment: { method: 'cash', confirmedCashAmount: 30 }, figures: { amountDue: 30, toCollect: 30 } },
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000001' }),
        })
        expect(query).not.toHaveBeenCalled()
      })

      it("the first call: the Worker's figures, as the old answer gave them", async () => {
        rawRequest.mockResolvedValue(success({ added: false, priceImpact: impact }))
        const { result } = await add(guest)
        expect(await result()).toEqual({ added: false, priceImpact: impact })
      })

      it('the guest limit, and the reader: the old shapes', async () => {
        rawRequest.mockResolvedValue(success({ added: false, limitReached: true, guest: null }))
        expect(await (await add(guest)).result()).toEqual({ added: false, limitReached: true, guest: null })
        const pending = { flow: 'add_guest', recordId: BOOKING, pendingId: '22222222-2222-4222-8222-222222222222', paymentIntentId: 'pi_1', clientSecret: 'pi_1_secret', amount: 25 }
        rawRequest.mockResolvedValue(success({ added: true, guest: null, addonLineIds: [], pendingReaderPayment: pending }))
        expect(await (await add({ ...guest, payment: { method: 'reader' } })).result()).toEqual({ added: true, guest: null, addonLineIds: [], pendingReaderPayment: pending })
      })

      it("a refusal over the amount comes back in the old shape, with the Worker's words and the new figures", async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'cash_amount_changed', message: CHANGED('25.00'), priceImpact: impact }))
        const { result } = await add({ ...guest, payment: { method: 'cash', confirmedCashAmount: 20 }, figures: { amountDue: 20, toCollect: 20 } })
        expect(await result()).toEqual({ added: false, reason: 'cash_amount_changed', message: CHANGED('25.00'), priceImpact: impact })
      })

      it('a refusal the old function sent no words for leaves them out (the dialog has the same), as the old answer did', async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'booking_cancelled', message: 'This booking has been cancelled and can no longer take guests.', screenWords: true }))
        expect(await (await add(guest)).result()).toEqual({ added: false, reason: 'booking_cancelled' })
      })

      it('no name and no add-ons is thrown with its words, as the old function threw', async () => {
        rawRequest.mockResolvedValue(refused('VALIDATION', { reason: 'guest_name_required', message: 'Guest name is required', guestIndex: 0 }))
        await expect((await add({})).result()).rejects.toThrow(new Error('Guest name is required'))
      })

      it.each([
        ['PAYMENT_FAILED', 'card_declined', 'Failed to charge saved card: Your card was declined.'],
        ['PAYMENT_NEEDS_AUTHENTICATION', 'card_needs_authentication', 'This card needs the customer to confirm the payment.'],
        ['CONFLICT', 'no_saved_card', 'Customer has no saved payment method on file.'],
      ])("%s (%s) answers the charge's words as the reason, as the old function did", async (code, reason, message) => {
        rawRequest.mockResolvedValue(refused(code, { reason, message }))
        expect(await (await add({ ...guest, payment: { method: 'card' } })).result()).toEqual({ added: false, reason: message })
      })

      it("a held payment (Q35) is answered with the Worker's words: don't take payment again", async () => {
        const words = "The card payment didn't get a clear answer, so it may or may not have been taken. The change is on hold: don't take payment again. Check the Orders page in a few minutes."
        rawRequest.mockResolvedValue(refused('PAYMENT_UNCONFIRMED', { reason: 'payment_unconfirmed', message: words, pendingId: 'p' }))
        expect(await (await add({ ...guest, payment: { method: 'card' } })).result()).toEqual({ added: false, reason: 'payment_unconfirmed', message: words })
      })

      it.each([
        ['no connection', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
        ['an earlier press still running', () => rawRequest.mockResolvedValue(refusal('CONFLICT', 'This request is already being processed'))],
        ['a fault', () => rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
      ])('%s: no_answer, with words to check before pressing again', async (_label, arrange) => {
        arrange()
        const { ADD_GUEST_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect(await (await add({ ...guest, payment: { method: 'card' } })).result()).toEqual({ added: false, reason: 'no_answer', message: ADD_GUEST_NO_ANSWER_MESSAGE })
      })

      it("a changed press sent under a no-answer press's key is refused with words to check the booking first, never sent as new", async () => {
        rawRequest.mockResolvedValue(refusal('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
        const { ADD_GUEST_PRESSED_AFTER_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect(await (await add({ ...guest, payment: { method: 'cash' } })).result()).toEqual({ added: false, reason: 'pressed_after_no_answer', message: ADD_GUEST_PRESSED_AFTER_NO_ANSWER_MESSAGE })
      })

      it("the no-answer words don't take the guest being there as paid", async () => {
        const { ADD_GUEST_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect(ADD_GUEST_NO_ANSWER_MESSAGE).toContain('shows no payment still open')
        expect(ADD_GUEST_NO_ANSWER_MESSAGE).toContain("it won't add or charge twice")
      })

      it('no booking: refused without a call, as before', async () => {
        const fn = (await backend('addBookingGuest')).default
        expect(await fn({ params: { bookingId: '' }, user })).toEqual({ added: false, reason: 'booking_not_found' })
        expect(rawRequest).not.toHaveBeenCalled()
      })

      it("the dialog sends the Worker's figures and keeps its press key after no answer, until it is closed", () => {
        const dialog = readFileSync(path.join(appDir, 'frontend/components/AddGuestDialog.tsx'), 'utf8')
        // W20a (W20 review later 2): for cash, the tick's own figure, as New Order.
        expect(dialog).toContain('figures: { amountDue, toCollect: figureToCollect(amountLeftToPay(amountDue, giftCardAmount, storeCreditAmount), payment) }')
        expect(dialog.match(/if \(result\?\.reason !== 'no_answer' && result\?\.reason !== 'pressed_after_no_answer'\) pressKey\.current = null/g)).toHaveLength(2)
        expect(dialog).toContain('idempotencyKey: pressKey.current')
      })

      it('W20a (W20 review S1): a call that throws keeps the press key too, with the no-answer words and the error', async () => {
        const dialog = readFileSync(path.join(appDir, 'frontend/components/AddGuestDialog.tsx'), 'utf8')
        // The key is only ever cleared after an answer (the two lines above) and on closing the dialog.
        expect(dialog.match(/pressKey\.current = null/g)).toHaveLength(3)
        const reset = dialog.indexOf('function resetAndClose() {')
        expect(dialog.indexOf('pressKey.current = null', reset)).toBe(dialog.indexOf('\n', reset) + '\n    '.length)
        // Both calls' own catch blocks: the first call (it can add straight away) and the payment press.
        for (const start of ['async function handleInitialSubmit', 'async function handleConfirmPayment']) {
          const from = dialog.indexOf(start)
          const next = dialog.indexOf('\n  async function ', from + 1)
          const body = dialog.slice(from, next < 0 ? dialog.indexOf('\n  return (', from) : next)
          const handler = body.slice(body.lastIndexOf('} catch (err) {'), body.lastIndexOf('} finally {'))
          expect(handler).toContain('setErrorMessage(thrownCallMessage(err))')
          expect(handler).not.toContain('pressKey')
          expect(handler).not.toContain('crypto.randomUUID')
        }
        // The words are the wrapper's no-answer words (the frontend can't import them), with the error after them.
        const { ADD_GUEST_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect(dialog).toContain(`const NO_ANSWER_MESSAGE =\n  ${JSON.stringify(ADD_GUEST_NO_ANSWER_MESSAGE)}`)
        expect(dialog).toContain('return err instanceof Error && err.message ? `${NO_ANSWER_MESSAGE} (${err.message})` : NO_ANSWER_MESSAGE')
      })
    })

    // Brief W21: refundBooking's Part refund, Refund the rest and It already arrived, and getBookingRefundFigures, are
    // thin calls to the Worker. Its rules are tested there (server/rules/bookings/refunds.test.ts); here, the wrappers:
    // what they send, and the answers the dialogs read.
    describe('refunds (W21: thin calls to the Worker)', () => {
      const BOOKING = '11111111-1111-4111-8111-111111111111'
      const figures = { status: 'confirmed', customerId: BOOKING, pricePaid: 40, refundOwed: 0, left: 40, cardLeft: 40, parts: { card: 40, giftCard: 0, storeCredit: 0, cash: 0 }, cashLeft: 0, paidLine: 'Left to refund: £40.00 card money.' }
      const refused = (code: string, details: Record<string, unknown>) => ({
        data: { ok: false, error: { code, message: String(details['message']), details: { action: 'refund', ...details } }, requestId: 'worker-request' },
      })
      const refund = async (params: Record<string, unknown>) => {
        const query = vi.fn()
        vi.stubGlobal('paddockData', { query })
        const fn = (await backend('refundBooking')).default
        return { result: () => fn({ params: { bookingId: BOOKING, ...params }, user }), query }
      }

      it.each([
        ['Part refund', { refundMethod: 'card', amount: 15, reason: 'Goodwill' }, 'refunds', { amount: 15, refundMethod: 'card', reason: 'Goodwill' }],
        ['Part refund in cash (Q26)', { refundMethod: 'cash', amount: 15, reason: 'Handed back' }, 'refunds', { amount: 15, refundMethod: 'cash', reason: 'Handed back' }],
        ['Refund the rest', { refundMethod: 'credit', amount: 20, refundOwed: true }, 'refunds/owed', { amount: 20, refundMethod: 'credit' }],
        ['It already arrived', { refundMethod: 'credit', amount: 20, owedArrived: true, reason: 'Seen' }, 'refunds/owed-arrived', { amount: 20, reason: 'Seen' }],
      ])('%s: sends the amount and the press key to its route, answers its data, never touches the database', async (_label, params, suffix, body) => {
        rawRequest.mockResolvedValue(success({ cardRefundedAmount: 15, storeCreditRefundedAmount: 0, pricePaid: 25 }))
        const { result, query } = await refund({ ...params, idempotencyKey: 'press-key-0000000001' })
        expect(await result()).toEqual({ cardRefundedAmount: 15, storeCreditRefundedAmount: 0, pricePaid: 25 })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({
          path: `/api/v1/staff/bookings/${BOOKING}/${suffix}`,
          method: 'POST',
          body,
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000001' }),
        })
        expect(query).not.toHaveBeenCalled()
      })

      it('the cash, the store credit balance and a warning come back as the dialog reads them', async () => {
        rawRequest.mockResolvedValue(success({ cardRefundedAmount: 20, storeCreditRefundedAmount: 30, cashRefundedAmount: 0, storeCreditBalance: 30, pricePaid: 10, warning: 'w' }))
        expect(await (await refund({ refundMethod: 'card', amount: 50, reason: 'x' })).result()).toEqual({ cardRefundedAmount: 20, storeCreditRefundedAmount: 30, cashRefundedAmount: 0, storeCreditBalance: 30, pricePaid: 10, warning: 'w' })
      })

      it('an amount that no longer fits: `refused` with the Worker\'s words and the new figures (the old shape)', async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'more_than_left', message: 'Only £40.00 is left on this booking. Check the amount and confirm again.', figures }))
        expect(await (await refund({ refundMethod: 'credit', amount: 50, reason: 'x' })).result()).toEqual({ refused: { message: 'Only £40.00 is left on this booking. Check the amount and confirm again.', figures } })
      })

      it('any other refusal: `failed` with its words (the old function threw them), so the dialog can tell it from no answer', async () => {
        rawRequest.mockResolvedValue(refused('PAYMENT_FAILED', { reason: 'refund_failed', message: 'The card refund failed, so nothing was refunded: Failed to refund payment: Your card was declined.' }))
        expect(await (await refund({ refundMethod: 'card', amount: 10, reason: 'x' })).result()).toEqual({
          failed: { reason: 'refund_failed', message: 'The card refund failed, so nothing was refunded: Failed to refund payment: Your card was declined.' },
        })
        rawRequest.mockResolvedValue(refusal('FORBIDDEN', 'Needs Issue refunds permission — this action moves money back to the customer.'))
        expect(await (await refund({ refundMethod: 'card', amount: 10, reason: 'x' })).result()).toEqual({
          failed: { reason: 'forbidden', message: 'Needs Issue refunds permission — this action moves money back to the customer.' },
        })
      })

      it('a refund held for reconcile (Q35): `unsure` with the Worker\'s words, which end the dialog', async () => {
        const words = "The refund didn't get a clear answer, so it may or may not have gone. Don't refund it again. Check the Orders page in a few minutes."
        rawRequest.mockResolvedValue(success({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, held: { claimId: 'c', reason: 'refund_unconfirmed', message: words } }))
        expect(await (await refund({ refundMethod: 'card', amount: 10, reason: 'x' })).result()).toEqual({ unsure: { message: words } })
      })

      it.each([
        ['no connection', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
        ['an earlier press still running', () => rawRequest.mockResolvedValue(refusal('CONFLICT', 'This request is already being processed'))],
        ['a fault', () => rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
      ])('%s: `noAnswer`, so the dialog keeps its key and the next press gets the first one\'s answer', async (_label, arrange) => {
        arrange()
        const { REFUND_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect(await (await refund({ refundMethod: 'card', amount: 10, reason: 'x' })).result()).toEqual({ noAnswer: { message: REFUND_NO_ANSWER_MESSAGE } })
      })

      it("a changed press under a no-answer press's key: `pressedAfterNoAnswer`, never sent as new", async () => {
        rawRequest.mockResolvedValue(refusal('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
        const { REFUND_PRESSED_AFTER_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect(await (await refund({ refundMethod: 'card', amount: 10, reason: 'x' })).result()).toEqual({ pressedAfterNoAnswer: { message: REFUND_PRESSED_AFTER_NO_ANSWER_MESSAGE } })
      })

      it("Cancel & Refund (no amount) still runs the old body (W23): it never calls the Worker's refund routes", async () => {
        const query = vi.fn().mockResolvedValue({ data: [] })
        vi.stubGlobal('paddockData', { query })
        const fn = (await backend('refundBooking')).default
        await fn({ params: { bookingId: BOOKING, refundMethod: 'card' }, user }).catch(() => undefined)
        expect(rawRequest.mock.calls.map((call) => (call[0] as { path: string }).path).filter((p) => p.includes('/refunds'))).toEqual([])
        expect(query).toHaveBeenCalled()
      })

      it('getBookingRefundFigures: a read of the figures route (with its time limit), and the old words for a missing booking', async () => {
        const fn = (await backend('getBookingRefundFigures')).default
        rawRequest.mockResolvedValue(success(figures))
        expect(await fn({ params: { bookingId: BOOKING }, user })).toEqual(figures)
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/${BOOKING}/refund-figures`, method: 'GET' })
        rawRequest.mockResolvedValue(refusal('NOT_FOUND', 'Booking not found.'))
        await expect(fn({ params: { bookingId: BOOKING }, user })).rejects.toThrow(new Error('Booking not found.'))
      })

      it('the two dialogs: a press key kept after no answer or a throw (W20a\'s rule), the Worker\'s figures, Q26\'s cash and Q37\'s line', () => {
        const part = readFileSync(path.join(appDir, 'frontend/components/PartRefundDialog.tsx'), 'utf8')
        const rest = readFileSync(path.join(appDir, 'frontend/components/RefundTheRestDialog.tsx'), 'utf8')
        for (const source of [part, rest]) {
          expect(source).toContain('pressKey.current ??= crypto.randomUUID()')
          expect(source).toContain('idempotencyKey: pressKey.current')
          // The key is cleared only after the no-answer answers have returned (it is kept for them).
          expect(source).toMatch(/if \(response\?\.noAnswer \|\| response\?\.pressedAfterNoAnswer\) \{[^}]*return( true)?\s*\}\s*pressKey\.current = null/)
          expect(source.match(/pressKey\.current = null/g)).toHaveLength(2)
          expect(source).toContain('thrownCallMessage(err)')
        }
        expect(part).toContain("figures.paidLine")
        expect(part).toContain('value="cash"')
        expect(part).toContain('cashLeft > 0')
        expect(part).toMatch(/method === 'card' && next\.parts\.card > 0/)
        expect(rest).toContain('next.cardLeft > 0')
      })
    })

    describe('Move', () => {
      const move = async (payment: Record<string, unknown> | undefined, tierPrice = '65.00') => {
        const session = { id: 'session-2', start_time: '2026-12-01T10:00:00', end_time: '2026-12-01T11:00:00', capacity: 8, total_booked: 0, status: 'open', service_type_id: 'type-1', band_id: 'band-2', booking_type: 'private', started: false }
        const database = stubDatabase([
          [/FROM bookings b\s+LEFT JOIN sessions/, () => [{
            id: 'booking-1',
            customer_id: 'customer-1',
            session_id: 'session-1',
            party_size: 2,
            status: 'confirmed',
            price_paid: '40.00',
            part_refunded_amount: '0.00',
            refund_owed_amount: '0.00',
            redemption_source: 'paid',
            redeemed_membership_id: null,
            redeemed_session_pass_id: null,
            start_time: '2026-11-30T10:00:00',
            end_time: '2026-11-30T11:00:00',
            band_id: 'band-1',
            credit_period_id: null,
            booking_type: 'private',
          }]],
          [/FROM sessions s\s+JOIN service_types/, () => [session]],
          [/FROM service_type_price_tiers/, () => [{ price: tierPrice }]],
        ])
        const fn = (await backend('moveBooking')).default
        const result = await fn({ params: { bookingId: 'booking-1', newSessionId: 'session-2', confirmed: true, ...(payment ? { payment } : {}) }, user })
        return { result, ...database }
      }

      it('refuses a figure below its own, with the new figures, and writes nothing', async () => {
        const { result, writes } = await move({ method: 'cash', confirmedCashAmount: 20 })
        expect(result).toMatchObject({ moved: false, reason: 'cash_amount_changed', message: CHANGED('25.00'), priceImpact: { amountDue: 25 } })
        expect(writes()).toEqual([])
      })

      it('compares the cash left after store credit', async () => {
        const { result, writes } = await move({ method: 'cash', confirmedCashAmount: 10, storeCredit: { amount: 5 } })
        expect(result.message).toBe(CHANGED('20.00'))
        expect(writes()).toEqual([])
      })

      it('refuses a figure above its own, with the new figures, and writes nothing', async () => {
        const { result, writes } = await move({ method: 'cash', confirmedCashAmount: 30 })
        expect(result).toMatchObject({ moved: false, reason: 'cash_amount_changed', message: CHANGED('25.00'), priceImpact: { amountDue: 25 } })
        expect(writes()).toEqual([])
      })

      it('refuses confirmed cash when the difference has dropped to nothing', async () => {
        const { result, writes } = await move({ method: 'cash', confirmedCashAmount: 25 }, '40.00')
        expect(result).toMatchObject({ moved: false, reason: 'cash_amount_changed', message: NOTHING_LEFT, priceImpact: { amountDue: 0 } })
        expect(writes()).toEqual([])
      })

      it('refuses confirmed cash when the difference has turned into a refund', async () => {
        const { result, writes } = await move({ method: 'cash', confirmedCashAmount: 25 }, '30.00')
        expect(result).toMatchObject({ moved: false, reason: 'cash_amount_changed', message: NOTHING_LEFT, priceImpact: { amountDue: -10, refundDue: true } })
        expect(writes()).toEqual([])
      })

      it('gives the new figures when the difference fell below the store credit', async () => {
        const { result, writes } = await move({ method: 'cash', confirmedCashAmount: 5, storeCredit: { amount: 20 } }, '55.00')
        expect(result).toMatchObject({ reason: 'cash_amount_changed', message: NOTHING_LEFT, priceImpact: { amountDue: 15 } })
        expect(writes()).toEqual([])
      })

      it('gets past the check with the confirmed figure', async () => {
        const { result } = await move({ method: 'cash', confirmedCashAmount: 25 })
        expect(result.reason).not.toBe('cash_amount_changed')
      })

      it('with nothing on screen to pay, gives the new figures so the choices appear', async () => {
        const { result, writes } = await move(undefined)
        expect(result).toMatchObject({ moved: false, reason: 'payment_method_required', priceImpact: { amountDue: 25, customerId: 'customer-1' } })
        expect(writes()).toEqual([])
      })

      it('with nothing left for the reader, says the amount changed and gets the figures', async () => {
        const { result, writes } = await move({ method: 'reader', storeCredit: { amount: 25 } })
        expect(result).toMatchObject({ moved: false, reason: 'payment_method_required', message: AMOUNT_CHANGED, priceImpact: { amountDue: 25 } })
        expect(writes()).toEqual([])
      })

      it('never starts a reader payment when the difference has gone to nothing', async () => {
        const { result, writes } = await move({ method: 'reader' }, '40.00')
        expect(result).toMatchObject({ moved: false, reason: 'payment_method_required', message: AMOUNT_CHANGED, priceImpact: { amountDue: 0 } })
        expect(writes()).toEqual([])
      })

      it('the reader refused on a refund keeps its words and gets the figures', async () => {
        const { result, writes } = await move({ method: 'reader' }, '30.00')
        expect(result.message).toContain('a card reader cannot refund')
        expect(result).toMatchObject({ moved: false, reason: 'payment_method_required', priceImpact: { amountDue: -10, refundDue: true } })
        expect(writes()).toEqual([])
      })

      it.each([
        ['a gift card above the difference', { giftCard: { giftCardId: 'gift-1', amount: 30 } }, 'gift_card_amount_exceeds_total'],
        ['store credit above the difference', { storeCredit: { amount: 30 } }, 'store_credit_amount_exceeds_total'],
        ['the two together above the difference', { storeCredit: { amount: 15 }, giftCard: { giftCardId: 'gift-1', amount: 15 } }, 'store_credit_amount_exceeds_total'],
      ])('%s gets the figures, and writes nothing', async (_label, payment, reason) => {
        const { result, writes } = await move(payment)
        expect(result).toMatchObject({ moved: false, reason, priceImpact: { amountDue: 25 } })
        expect(writes()).toEqual([])
      })

      it('a difference that turned into a refund gets the figures, so the refund choices appear', async () => {
        const { result, writes } = await move({ method: 'card' }, '30.00')
        expect(result).toMatchObject({ moved: false, reason: 'refund_method_required', priceImpact: { amountDue: -10, refundDue: true } })
        expect(writes()).toEqual([])
      })

      it.each([[0.05, 24.95], [2.9, 22.1]])('accepts credit that exactly covers £25: %s and %s', async (storeCredit, gift) => {
        const { result } = await move({ storeCredit: { amount: storeCredit }, giftCard: { giftCardId: 'gift-1', amount: gift } })
        expect(['payment_method_required', 'gift_card_amount_exceeds_total', 'store_credit_amount_exceeds_total']).not.toContain(result.reason)
      })
    })

    // Brief W19: settleLapsedBooking is a thin call to the Worker's settle route now. Its rules (the cash figure, the
    // parts over the price, the gift card and store credit claims, one transaction) are the Worker's and tested there
    // (server/rules/bookings/settle.test.ts); here, the wrapper: what it sends, and the old answer shapes it gives back.
    describe('Settle lapsed payment (W19: a thin call to the Worker)', () => {
      const BOOKING = '11111111-1111-4111-8111-111111111111'
      const refused = (code: string, details: Record<string, unknown>) => ({
        data: { ok: false, error: { code, message: String(details['message']), details: { action: 'settle', ...details } }, requestId: 'worker-request' },
      })
      const settle = async (params: Record<string, unknown>) => {
        const query = vi.fn()
        vi.stubGlobal('paddockData', { query })
        const fn = (await backend('settleLapsedBooking')).default
        return { result: () => fn({ params: { bookingId: BOOKING, ...params }, user }), query }
      }

      it('sends the payment, the figures on screen and the press key to the settle route, answers its data, and never touches the database', async () => {
        const settled = { settled: true, booking: { id: BOOKING, status: 'confirmed', redemption_source: 'paid', price_paid: '30.00', payment_due_by: null }, amountCharged: 30 }
        rawRequest.mockResolvedValue(success(settled))
        const { result, query } = await settle({ payment: { method: 'cash', confirmedCashAmount: 30 }, figures: { amountDue: 30, toCollect: 30 }, idempotencyKey: 'press-key-0000000001' })
        expect(await result()).toEqual(settled)
        expect(rawRequest).toHaveBeenCalledTimes(1)
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({
          path: `/api/v1/staff/bookings/${BOOKING}/settle`,
          method: 'POST',
          body: { payment: { method: 'cash', confirmedCashAmount: 30 }, figures: { amountDue: 30, toCollect: 30 } },
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000001' }),
        })
        expect(query).not.toHaveBeenCalled()
      })

      it('the reader: the payment the screen collects, as the old answer named it', async () => {
        const pending = { flow: 'settle', recordId: BOOKING, pendingId: '22222222-2222-4222-8222-222222222222', paymentIntentId: 'pi_1', clientSecret: 'pi_1_secret', amount: 15 }
        rawRequest.mockResolvedValue(success({ settled: false, pendingReaderPayment: pending }))
        const { result } = await settle({ payment: { method: 'reader' }, figures: { amountDue: 15, toCollect: 15 } })
        expect(await result()).toEqual({ settled: false, pendingReaderPayment: pending })
      })

      it("a refusal over the amount comes back in the old shape, with the Worker's words and the new figure", async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'cash_amount_changed', message: CHANGED('30.00'), amountDue: 30 }))
        const { result } = await settle({ payment: { method: 'cash', confirmedCashAmount: 20 }, figures: { amountDue: 30, toCollect: 20 } })
        expect(await result()).toEqual({ settled: false, reason: 'cash_amount_changed', message: CHANGED('30.00'), amountDue: 30 })
      })

      it('any other refusal: the reason and the words, no figure', async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'gift_card_insufficient_or_invalid', message: 'That gift card has expired.' }))
        const { result } = await settle({ payment: { giftCard: { giftCardId: 'g', amount: 30 } } })
        expect(await result()).toEqual({ settled: false, reason: 'gift_card_insufficient_or_invalid', message: 'That gift card has expired.' })
      })

      it.each([
        ['PAYMENT_FAILED', 'card_declined', 'Failed to charge saved card: Your card was declined.'],
        ['PAYMENT_NEEDS_AUTHENTICATION', 'card_needs_authentication', 'This card needs the customer to confirm the payment.'],
        ['CONFLICT', 'no_saved_card', 'Customer has no saved payment method on file.'],
      ])('%s (%s) is thrown with its words, as the old function threw the charge\'s error', async (code, reason, message) => {
        rawRequest.mockResolvedValue(refused(code, { reason, message }))
        const { result } = await settle({ payment: { method: 'card' }, figures: { amountDue: 30, toCollect: 30 } })
        await expect(result()).rejects.toThrow(new Error(message))
      })

      it("a held payment (Q35) is answered with the Worker's words: don't take payment again", async () => {
        const words = "The card payment didn't get a clear answer, so it may or may not have been taken. The change is on hold: don't take payment again. Check the Orders page in a few minutes."
        rawRequest.mockResolvedValue(refused('PAYMENT_UNCONFIRMED', { reason: 'payment_unconfirmed', message: words, pendingId: 'p' }))
        const { result } = await settle({ payment: { method: 'card' }, figures: { amountDue: 30, toCollect: 30 } })
        expect(await result()).toEqual({ settled: false, reason: 'payment_unconfirmed', message: words })
      })

      it.each([
        ['no connection', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
        ['an earlier press still running', () => rawRequest.mockResolvedValue(refusal('CONFLICT', 'This request is already being processed'))],
        ['a fault', () => rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
      ])('%s: no_answer, with words to check before pressing again', async (_label, arrange) => {
        arrange()
        const { SETTLE_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        const { result } = await settle({ payment: { method: 'card' }, figures: { amountDue: 30, toCollect: 30 } })
        expect(await result()).toEqual({ settled: false, reason: 'no_answer', message: SETTLE_NO_ANSWER_MESSAGE })
      })

      // W19a (W19 review S1): a card or reader Settle confirms the booking before the money moves, so "confirmed" is
      // paid only when no payment is still open on it. The words, as the review gave them.
      it("the no-answer words don't take confirmed alone as paid", async () => {
        const { SETTLE_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect(SETTLE_NO_ANSWER_MESSAGE).toBe(
          "Take Payment didn't get an answer, so the payment may or may not have gone through. Don't take payment again yet: reload the booking. If it's confirmed and shows no payment still open, it's paid. If it shows a payment still open, it's being checked: don't take payment, and use Resolve now on the Orders page after 15 minutes. If it's still awaiting payment, press Take Payment again (it won't charge twice)."
        )
        expect(SETTLE_NO_ANSWER_MESSAGE).not.toContain("If it's confirmed, it's paid")
      })

      it('no booking: refused without a call, as before', async () => {
        const fn = (await backend('settleLapsedBooking')).default
        expect(await fn({ params: { bookingId: '' }, user })).toEqual({ settled: false, reason: 'booking_not_found' })
        expect(rawRequest).not.toHaveBeenCalled()
      })

      it.each([
        ['finaliseReaderPayment', 'finalise', { finalised: true, pendingId: 'p' }],
        ['cancelReaderPayment', 'cancel', { cancelled: true, pendingId: 'p' }],
      ])("%s sends a flow the Worker started to the Worker's flow route, and says so plainly when it gets no answer", async (name, step, answer) => {
        const PENDING = '22222222-2222-4222-8222-222222222222'
        const query = vi.fn(async (sql: string) => ({ data: /FROM pending_reader_payments p/.test(sql) ? [{ worker: true }] : [] }))
        vi.stubGlobal('paddockData', { query })
        const fn = (await backend(name)).default
        rawRequest.mockResolvedValue(success(answer))
        expect(await fn({ params: { pendingId: PENDING }, user })).toEqual(answer)
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/reader-flows/${PENDING}/${step}`, method: 'POST' })
        // Only the flow's own row was read: the old body (staff lookup, Stripe through the legacy routes) never ran.
        expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([expect.stringContaining("p.snapshot->>'method' IN ('reader', 'card')")])
        rawRequest.mockRejectedValue(new Error('socket hang up'))
        const { FLOW_STEP_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect(await fn({ params: { pendingId: PENDING }, user })).toMatchObject({ pendingId: PENDING, reason: 'no_answer', message: FLOW_STEP_NO_ANSWER_MESSAGE })
      })

      it('the screen has words for every old reason, and shows the Worker\'s words first', () => {
        const SPENT = 'That gift card no longer has enough balance remaining.'
        const dialog = readFileSync(path.join(appDir, 'frontend/components/SettleLapsedPaymentDialog.tsx'), 'utf8')
        expect(dialog).toContain("store_credit_insufficient_or_invalid: 'The customer no longer has enough store credit remaining. Nothing was taken.'")
        expect(dialog).toContain("store_credit_failed: 'Applying the store credit failed — nothing was taken.'")
        expect(dialog).toContain(`gift_card_insufficient_or_invalid: '${SPENT} Nothing was taken.'`)
        expect(dialog).toContain('setErrorMessage(result.message ?? FAILURE_MESSAGES[result.reason as SettleLapsedBookingFailureReason])')
        // Brief W19: the dialog sends the figures on screen and keeps its press key after no answer. W20a: for cash, the
        // tick's own figure, as New Order.
        expect(dialog).toContain('figures: { amountDue, toCollect: figureToCollect(remainder, payment) }')
        expect(dialog).toContain("if (result?.reason !== 'no_answer') pressKey.current = null")
      })
    })

    describe('Remove Guest', () => {
      const remove = async (params: Record<string, unknown>, seat: { unit_price: string | null; pay_by: string } = { unit_price: '25.00', pay_by: 'paid' }) => {
        const database = stubDatabase([
          [/FROM booking_guests g/, () => [{
            id: 'guest-1',
            booking_id: 'booking-1',
            guest_type: 'additional',
            guest_name: 'Sam',
            ...seat,
            bk_id: 'booking-1',
            customer_id: 'customer-1',
            party_size: 2,
            price_paid: '50.00',
            status: 'confirmed',
            session_id: 'session-1',
            booking_type: 'public',
          }]],
        ])
        const fn = (await backend('removeBookingGuest')).default
        const result = await fn({ params: { guestId: 'guest-1', ...params }, user })
        return { result, ...database }
      }
      const quote = (refundAmount: number, refundable = true) => ({ bookingId: 'booking-1', bookingType: 'public', refundAmount, refundable, partySize: 2 })

      it('a confirmed refund that differs gets the new figure, and writes nothing', async () => {
        const { result, writes } = await remove({ confirmedRefundAmount: 20, refundMethod: 'credit' })
        expect(result).toEqual({ removed: false, blocked: false, guestId: 'guest-1', reason: 'refund_amount_mismatch', message: AMOUNT_CHANGED, quote: quote(25) })
        expect(writes()).toEqual([])
      })

      it('no refund method gets the figure, and writes nothing', async () => {
        const { result, writes } = await remove({ confirmedRefundAmount: 25 })
        expect(result).toEqual({ removed: false, blocked: false, guestId: 'guest-1', reason: 'refund_method_required', quote: quote(25) })
        expect(writes()).toEqual([])
      })

      it('a seat that stopped being refundable is refused, not removed with no refund', async () => {
        const { result, writes } = await remove({ confirmedRefundAmount: 25, refundMethod: 'credit' }, { unit_price: '25.00', pay_by: 'membership_credit' })
        expect(result).toMatchObject({ removed: false, reason: 'refund_amount_mismatch', quote: quote(0, false) })
        expect(writes()).toEqual([])
      })

      describe('what staff are told when it fails', () => {
        const DIDNT_GO_THROUGH = "The refund didn't go through, so the guest hasn't been removed. Please try again."
        const NOTHING_REFUNDED = "The guest couldn't be removed and nothing was refunded. Please try again."
        const WENT_THROUGH = "The refund went through, but the guest couldn't be removed. Check the booking before trying again."
        const PART_WENT_THROUGH = "Part of the refund went through, but the guest couldn't be removed. Check the booking before trying again."
        const CARD_REFUND_FAILED = 'The card refund failed, so nothing was refunded: card_declined'
        const CREDIT_FAILED = 'Adding the store credit failed, so nothing was refunded.'

        /** A seat of £25 on one order. `cardPortion` is what that order's card took (0: no card
         *  money to return). `credit` answers each store credit movement in turn. */
        const run = async (options: {
          params?: Record<string, unknown>
          seat?: { unit_price: string | null; pay_by: string }
          cardPortion?: number
          cardRefund?: { error: string } | { success: true }
          credit?: boolean[]
          deleted?: boolean | Error
          status?: string
        }) => {
          const credit = [...(options.credit ?? [])]
          const database = stubDatabase([
            [/FROM booking_guests g/, () => [{
              id: 'guest-1',
              booking_id: 'booking-1',
              claim_id: 'claim-1',
              guest_type: 'additional',
              guest_name: 'Sam',
              ...(options.seat ?? { unit_price: '25.00', pay_by: 'paid' }),
              bk_id: 'booking-1',
              customer_id: 'customer-1',
              party_size: 2,
              price_paid: '50.00',
              status: options.status ?? 'confirmed',
              session_id: 'session-1',
              booking_type: 'public',
            }]],
            [/WHERE oli\.booking_id = \$1 AND oli\.item_type = 'booking'/, () => [{ id: 'line-1', order_id: 'order-1', net_remaining: '25.00' }]],
            [/FROM orders o WHERE o\.id/, () => [{
              customer_id: 'customer-1',
              stripe_payment_intent_id: (options.cardPortion ?? 0) > 0 ? 'pi_1' : null,
              payment_method: 'card',
              order_total: String(options.cardPortion ?? 0),
              order_discount_amount: '0',
              gift_card_used: '0',
              store_credit_used: '0',
              membership_net: '0',
              already_card_refunded: '0',
            }]],
            [/store_credit_apply/, () => [{ result: credit.shift() === false ? { ok: false } : { ok: true, balance: 25 } }]],
            [/WITH del AS/, () => {
              if (options.deleted instanceof Error) throw options.deleted
              return [{ deleted: options.deleted ?? true }]
            }],
          ])
          const rawRefund = vi.fn(async () => ({ data: options.cardRefund ?? { success: true } }))
          vi.stubGlobal('paddockBackendApi2', { rawRequest: rawRefund })
          const fn = (await backend('removeBookingGuest')).default
          const result = await fn({
            params: { guestId: 'guest-1', confirmedRefundAmount: 25, refundMethod: 'card', ...options.params },
            user,
          })
          return { result, rawRefund, ...database }
        }
        const credit = { refundMethod: 'credit' }
        const cardWentBack = (amount: string) =>
          `£${amount} had already gone back to the card; it was taken off the guest's seat, so retrying refunds only the rest.`

        it('a cancelled booking is refused with its reason at both steps, and nothing moves', async () => {
          for (const params of [{ confirmedRefundAmount: undefined }, {}]) {
            const { result, writes, rawRefund } = await run({ params, status: 'cancelled', cardPortion: 25 })
            expect(result).toEqual({ removed: false, blocked: false, guestId: 'guest-1', reason: 'booking_cancelled' })
            expect(writes()).toEqual([])
            expect(rawRefund).not.toHaveBeenCalled()
          }
        })

        it('a card refund that fails: nothing moved and the guest stays', async () => {
          const { result, writes } = await run({ cardPortion: 25, cardRefund: { error: 'card_declined' } })
          expect(result).toEqual({
            removed: false,
            blocked: false,
            guestId: 'guest-1',
            reason: `refund_failed: ${CARD_REFUND_FAILED}`,
            message: `${DIDNT_GO_THROUGH} (${CARD_REFUND_FAILED})`,
          })
          expect(writes().filter(notAudit)).toEqual([expect.stringContaining('WITH seat AS'), expect.stringContaining('WITH seat AS (UPDATE booking_guests')])
        })

        it('store credit that fails: nothing moved and the guest stays', async () => {
          const { result, sql, writes } = await run({ params: credit, credit: [false] })
          expect(result.message).toBe(`${DIDNT_GO_THROUGH} (${CREDIT_FAILED})`)
          expect(writes().filter(notAudit).filter((text) => !/store_credit_apply/.test(text))).toEqual([expect.stringContaining('WITH seat AS'), expect.stringContaining('WITH seat AS (UPDATE booking_guests')])
          expect(sql.some((text) => /WITH del AS/.test(text))).toBe(false)
        })

        it('no refund was due: says nothing was refunded, not that a refund went through', async () => {
          const { result, rawRefund } = await run({
            params: { confirmedRefundAmount: 0, refundMethod: undefined },
            seat: { unit_price: null, pay_by: 'membership_credit' },
            deleted: new Error('deadlock detected'),
          })
          expect(result).toEqual({
            removed: false,
            blocked: false,
            guestId: 'guest-1',
            reason: 'guest_remove_failed: deadlock detected',
            message: `${NOTHING_REFUNDED} (deadlock detected)`,
          })
          expect(rawRefund).not.toHaveBeenCalled()
        })

        it('store credit taken back: nothing is refunded in the end', async () => {
          const { result } = await run({ params: credit, deleted: new Error('deadlock detected') })
          expect(result.message).toBe(`${NOTHING_REFUNDED} The £25.00 store credit was taken back. (deadlock detected)`)
          expect(result.quote).toBeUndefined()
        })

        it('store credit that could not be taken back: the refund stands', async () => {
          const { result } = await run({ params: credit, credit: [true, false], deleted: new Error('deadlock detected') })
          expect(result.message).toBe(`${WENT_THROUGH} Taking back the £25.00 store credit failed — remove it by hand. (deadlock detected)`)
          expect(result.quote).toBeUndefined()
        })

        it('all of it back on the card: the refund stands, and the screen moves to the £0.00 left', async () => {
          const { result } = await run({ cardPortion: 25, deleted: new Error('deadlock detected') })
          expect(result.reason).toBe('guest_remove_failed: deadlock detected')
          expect(result.message).toBe(`${WENT_THROUGH} ${cardWentBack('25.00')} (deadlock detected)`)
          expect(result.quote).toEqual(quote(0))
          expect(result.removed).toBe(false)
        })

        it('part on the card and the store credit taken back: only that part stands', async () => {
          const { result } = await run({ cardPortion: 15, deleted: new Error('deadlock detected') })
          expect(result.message).toBe(
            `${PART_WENT_THROUGH} The £10.00 store credit was taken back. ${cardWentBack('15.00')} (deadlock detected)`
          )
          expect(result.quote).toEqual(quote(10))
        })

        it('the figure left on the seat is in whole pennies', async () => {
          const { result } = await run({
            params: { confirmedRefundAmount: 25.3 },
            seat: { unit_price: '25.30', pay_by: 'paid' },
            cardPortion: 15.1,
            deleted: new Error('deadlock detected'),
          })
          expect(result.quote).toEqual(quote(10.2))
        })

        it('part on the card and the store credit not taken back: all of it stands', async () => {
          const { result } = await run({ cardPortion: 15, credit: [true, false], deleted: new Error('deadlock detected') })
          expect(result.message).toContain(WENT_THROUGH)
          expect(result.quote).toEqual(quote(10))
        })

        it('keeps what the refund itself warned about', async () => {
          const { result } = await run({ cardPortion: 15, credit: [false], deleted: new Error('deadlock detected') })
          expect(result.message).toBe(
            `${PART_WENT_THROUGH} The other £10.00 wasn't added to store credit, so it's still to refund. ${cardWentBack('15.00')} (deadlock detected)`
          )
        })

        it('a guest already gone: no seat to lower, so no promise about retrying', async () => {
          const { result } = await run({ cardPortion: 25, deleted: false })
          expect(result.message).toBe(
            `${WENT_THROUGH} £25.00 had already gone back to the card; it was taken off the booking's price paid. (the guest was already removed)`
          )
          expect(result.quote).toBeUndefined()
        })

        it('the detail is always last, in brackets', async () => {
          const { result } = await run({ params: credit, deleted: new Error('deadlock detected') })
          expect(result.message.endsWith('(deadlock detected)')).toBe(true)
          expect(result.warning).toBeUndefined()
        })

        it('a guest that has gone says so', async () => {
          stubDatabase([])
          const fn = (await backend('removeBookingGuest')).default
          const result = await fn({ params: { guestId: 'guest-1' }, user })
          expect(result).toEqual({ removed: false, blocked: false, guestId: 'guest-1', reason: 'guest_not_found' })
        })
      })
    })

    describe('refund safety', () => {
      const FAR_OFF = '2099-01-01T10:00:00Z'
      const BROKEN = new Error('connection lost')
      type Answer = [RegExp, (params: unknown[]) => unknown[]]

      /** Two orders paid for the booking, newest first. `portions` is what each order's card took,
       *  or an Error for a read that fails. `credit` answers each store credit movement in turn
       *  (an Error throws, and so does looking for it afterwards, so nobody can say whether it
       *  landed: W05j's read-back is tested in the replay tests) and `refunds` each card refund. */
      const setUp = (options: {
        portions?: Record<string, number | Error>
        credit?: Array<boolean | Error>
        refunds?: Array<{ error: string } | { success: true }>
        linesFail?: boolean
        thirdOrder?: boolean
        answers?: Answer[]
      } = {}) => {
        const credit = [...(options.credit ?? [])]
        let creditThrew = false
        const refunds = [...(options.refunds ?? [])]
        const portions = options.portions ?? { 'order-new': 15, 'order-old': 25 }
        const database = stubDatabase([
          ...(options.answers ?? []),
          [/WHERE oli\.booking_id = \$1 AND oli\.item_type = 'booking'/, () => {
            if (options.linesFail) throw BROKEN
            return [
              { id: 'line-new', order_id: 'order-new', net_remaining: '15.00' },
              { id: 'line-old', order_id: 'order-old', net_remaining: '25.00' },
              ...(options.thirdOrder ? [{ id: 'line-oldest', order_id: 'order-oldest', net_remaining: '25.00' }] : []),
            ]
          }],
          [/FROM orders o WHERE o\.id/, (params) => {
            const portion = portions[String(params[0])] ?? 0
            if (portion instanceof Error) throw portion
            return [{
              customer_id: 'customer-1',
              stripe_payment_intent_id: portion > 0 ? `pi_${String(params[0])}` : null,
              payment_method: 'card',
              order_total: String(portion),
              order_discount_amount: '0',
              gift_card_used: '0',
              store_credit_used: '0',
              membership_net: '0',
              already_card_refunded: '0',
            }]
          }],
          [/store_credit_apply/, () => {
            const next = credit.shift()
            creditThrew = next instanceof Error
            if (next instanceof Error) throw next
            return [{ result: next === false ? { ok: false } : { ok: true, balance: 40 } }]
          }],
          [/FOR SHARE/, () => {
            if (creditThrew) throw BROKEN
            return []
          }],
        ])
        const rawRefund = vi.fn(async () => ({ data: refunds.shift() ?? { success: true } }))
        vi.stubGlobal('paddockBackendApi2', { rawRequest: rawRefund })
        return { rawRefund, ...database }
      }
      const giveBack = async (amount = 25, method: 'card' | 'credit' = 'card') => {
        const { giveBookingMoneyBack } = await load('bookingRefund')
        return giveBookingMoneyBack({ bookingId: 'booking-1', customerId: 'customer-1', amount, method, staffId: 'staff-1', note: 'Refund', recordCardOnLines: true, pricePaidBefore: 50 })
      }
      const refundedTo = (rawRefund: ReturnType<typeof vi.fn>) =>
        rawRefund.mock.calls.map(([call]) => {
          const body = { ...(call as { body: Record<string, unknown> }).body }
          delete body['idempotencyKey']
          return body
        })

      describe('giveBookingMoneyBack', () => {
        it('nothing moved: a failed lookup of the payments is reported, not thrown', async () => {
          const { rawRefund, writes } = setUp({ linesFail: true })
          expect(await giveBack()).toEqual({ ok: false, message: "Looking up the booking's payments failed, so nothing was refunded: connection lost" })
          expect(rawRefund).not.toHaveBeenCalled()
          expect(writes()).toEqual([])
        })

        it('nothing moved: reading the first order failing is reported, not thrown', async () => {
          const { rawRefund, sql } = setUp({ portions: { 'order-new': BROKEN } })
          expect(await giveBack()).toEqual({ ok: false, message: 'Checking the card payment failed, so nothing was refunded: connection lost' })
          expect(rawRefund).not.toHaveBeenCalled()
          expect(sql.some((text) => /store_credit_apply/.test(text))).toBe(false)
        })

        it('nothing moved: an order with no card before the failure still counts as nothing', async () => {
          const { rawRefund } = setUp({ portions: { 'order-new': 0, 'order-old': BROKEN } })
          expect(await giveBack()).toMatchObject({ ok: false })
          expect(rawRefund).not.toHaveBeenCalled()
        })

        it('store credit throwing can\'t say whether it landed: unsure, with its detail', async () => {
          setUp({ credit: [BROKEN] })
          expect(await giveBack(25, 'credit')).toEqual({ ok: false, unsure: true, message: 'Adding the store credit gave no clear answer: connection lost; checking whether it landed failed too: connection lost' })
        })

        it('store credit refused is still a clear no', async () => {
          setUp({ credit: [false] })
          expect(await giveBack(25, 'credit')).toEqual({ ok: false, message: 'Adding the store credit failed, so nothing was refunded.' })
        })

        it('reading the next order failing after a card refund: the rest goes to store credit, and the card money stands', async () => {
          const { rawRefund, sql } = setUp({ portions: { 'order-new': 15, 'order-old': BROKEN } })
          const given = await giveBack()
          expect(given).toMatchObject({
            ok: true,
            result: {
              cardRefunded: 15,
              storeCreditRefunded: 10,
              cardByLine: [{ lineId: 'line-new', orderId: 'order-new', amount: 15 }],
              warning: 'Checking the next card payment failed (connection lost), so the rest went to store credit.',
            },
          })
          expect(given.result.shortfall).toBeUndefined()
          expect(refundedTo(rawRefund)).toEqual([{ paymentIntentId: 'pi_order-new', amount: 15 }])
          expect(sql.filter((text) => /UPDATE order_line_items SET card_refunded_amount/.test(text))).toHaveLength(1)
        })

        it('stops at the failure: no card refund is tried on an older order after it', async () => {
          const { rawRefund } = setUp({ portions: { 'order-new': 15, 'order-old': BROKEN, 'order-oldest': 25 }, thirdOrder: true })
          expect(await giveBack()).toMatchObject({ ok: true, result: { cardRefunded: 15, storeCreditRefunded: 10 } })
          expect(rawRefund).toHaveBeenCalledTimes(1)
        })

        it('that and store credit refused: no false claim about store credit, and the shortfall is named', async () => {
          setUp({ portions: { 'order-new': 15, 'order-old': BROKEN }, credit: [false] })
          const { result } = await giveBack()
          expect(result.warning).toBe(
            'Checking the next card payment failed (connection lost). £15.00 went back to the card, but adding the £10.00 remainder to store credit failed — add it by hand.'
          )
          expect(result).toMatchObject({ cardRefunded: 15, storeCreditRefunded: 0, shortfall: 10 })
          expect(result.warningWithoutShortfall).toBe('Checking the next card payment failed (connection lost).')
        })

        it('a further card refund failing keeps its words', async () => {
          setUp({ refunds: [{ success: true }, { error: 'card_declined' }] })
          const { result } = await giveBack()
          expect(result.warning).toBe('A further card refund of £10.00 failed (card_declined), so the rest went to store credit.')
        })

        it('a further card refund failing and store credit refused: no false claim either', async () => {
          setUp({ refunds: [{ success: true }, { error: 'card_declined' }], credit: [false] })
          const { result } = await giveBack()
          expect(result.warning).toBe(
            'A further card refund of £10.00 failed (card_declined). £15.00 went back to the card, but adding the £10.00 remainder to store credit failed — add it by hand.'
          )
        })

        it('store credit throwing after a card refund: the card money stands, and staff check the balance first', async () => {
          const { sql } = setUp({ portions: { 'order-new': 15 }, credit: [BROKEN] })
          const given = await giveBack()
          expect(given).toMatchObject({ ok: true, result: { cardRefunded: 15, storeCreditRefunded: 0, shortfall: 10 } })
          expect(given.result.warning).toBe(
            "£15.00 went back to the card, but adding the £10.00 remainder to store credit failed (connection lost; checking whether it landed failed too: connection lost) — check their balance, then add it by hand if it isn't there."
          )
          expect(given.result.warningWithoutShortfall).toBeUndefined()
          expect(sql.filter((text) => /UPDATE order_line_items SET card_refunded_amount/.test(text))).toHaveLength(1)
        })

        it('every read and write failing after the first card refund still returns what went back', async () => {
          const { rawRefund } = setUp({
            portions: { 'order-new': 15, 'order-old': BROKEN },
            credit: [BROKEN],
            answers: [[/UPDATE order_line_items SET card_refunded_amount/, () => { throw BROKEN }], [/orders SET payment_status|COUNT\(\*\)/, () => { throw BROKEN }]],
          })
          const given = await giveBack()
          expect(given).toMatchObject({ ok: true, result: { cardRefunded: 15, shortfall: 10 } })
          expect(given.result.warning).toContain('recording it on its order failed — check before refunding this booking again')
          expect(rawRefund).toHaveBeenCalledTimes(1)
        })
      })

      describe('Remove Guest', () => {
        const guestRow = {
          id: 'guest-1', claim_id: 'claim-1', booking_id: 'booking-1', guest_type: 'additional', guest_name: 'Sam', unit_price: '25.00', pay_by: 'paid',
          bk_id: 'booking-1', customer_id: 'customer-1', party_size: 2, price_paid: '50.00', status: 'confirmed', session_id: 'session-1', booking_type: 'public',
        }
        const removal = async (options: Parameters<typeof setUp>[0] & { deleted?: boolean | Error; putBackFails?: boolean; refundMethod?: string }) => {
          const stubs = setUp({
            ...options,
            answers: [
              [/FROM booking_guests g/, () => [guestRow]],
              [/WITH del AS/, () => {
                if (options.deleted instanceof Error) throw options.deleted
                return [{ deleted: options.deleted ?? true }]
              }],
              [/WITH seat AS \(UPDATE booking_guests/, () => {
                if (options.putBackFails) throw BROKEN
                return []
              }],
            ],
          })
          const fn = (await backend('removeBookingGuest')).default
          const result = await fn({ params: { guestId: 'guest-1', confirmedRefundAmount: 25, refundMethod: options.refundMethod ?? 'card' }, user })
          return { result, ...stubs }
        }
        const STILL_TO_REFUND = "The other £10.00 wasn't added to store credit, so it's still to refund."
        const CARD_OFF_SEAT = "£15.00 had already gone back to the card; it was taken off the guest's seat, so retrying refunds only the rest."

        it('a database error before any money moved: the guest stays and it is worded, not thrown', async () => {
          const { result, rawRefund, writes } = await removal({ portions: { 'order-new': BROKEN } })
          expect(result).toEqual({
            removed: false,
            blocked: false,
            guestId: 'guest-1',
            reason: 'refund_failed: Checking the card payment failed, so nothing was refunded: connection lost',
            message: "The refund didn't go through, so the guest hasn't been removed. Please try again. (Checking the card payment failed, so nothing was refunded: connection lost)",
          })
          expect(rawRefund).not.toHaveBeenCalled()
          expect(writes().filter(notAudit)).toEqual([expect.stringContaining('WITH seat AS'), expect.stringContaining('WITH seat AS (UPDATE booking_guests')])
        })

        it('store credit throwing after the card refund: the guest is still removed, and the rest stays on the booking to refund again', async () => {
          const { result, sql, rawRefund } = await removal({ portions: { 'order-new': 15 }, credit: [BROKEN] })
          expect(result).toMatchObject({ removed: true, refundedAmount: 15, cardRefundedAmount: 15, storeCreditRefundedAmount: 0 })
          expect(result.warning).toContain('is still on the booking')
          expect(result.warning).not.toContain('by hand')
          expect(sql.some((text) => /WITH del AS/.test(text))).toBe(true)
          expect(rawRefund).toHaveBeenCalledTimes(1)
        })

        it('the next order failing after the card refund: the same, with the rest on store credit', async () => {
          const { result } = await removal({ portions: { 'order-new': 15, 'order-old': BROKEN } })
          expect(result).toMatchObject({
            removed: true,
            refundedAmount: 25,
            cardRefundedAmount: 15,
            storeCreditRefundedAmount: 10,
            storeCreditBalance: 40,
            warning: 'Checking the next card payment failed (connection lost), so the rest went to store credit.',
          })
        })

        it('a removal tells the screen how the refund split', async () => {
          const { result } = await removal({ portions: { 'order-new': 15 } })
          expect(result).toEqual({
            removed: true,
            blocked: false,
            guestId: 'guest-1',
            refundedAmount: 25,
            cardRefundedAmount: 15,
            storeCreditRefundedAmount: 10,
            storeCreditBalance: 40,
          })
        })

        it('store credit short and the guest stuck: says it is still to refund, never to add it by hand as well', async () => {
          const { result } = await removal({ portions: { 'order-new': 15 }, credit: [false], deleted: new Error('deadlock detected') })
          expect(result.message).toBe(
            `Part of the refund went through, but the guest couldn't be removed. Check the booking before trying again. ${STILL_TO_REFUND} ${CARD_OFF_SEAT} (deadlock detected)`
          )
          expect(result.message).not.toContain('by hand')
          expect(result.quote.refundAmount).toBe(10)
          expect(result.retryLocked).toBeUndefined()
        })

        it('keeps the refund\'s other warnings when the shortfall line is dropped', async () => {
          const { result } = await removal({ portions: { 'order-new': 15, 'order-old': BROKEN }, credit: [false], deleted: new Error('deadlock detected') })
          expect(result.message).toContain(`Checking the next card payment failed (connection lost). ${STILL_TO_REFUND}`)
        })

        describe('the lock', () => {
          it('store credit that could not be taken back locks Remove', async () => {
            const { result } = await removal({ refundMethod: 'credit', credit: [true, false], deleted: new Error('deadlock detected') })
            expect(result.retryLocked).toBe(true)
          })

          it('store credit that threw on the way back locks Remove', async () => {
            const { result } = await removal({ refundMethod: 'credit', credit: [true, BROKEN], deleted: new Error('deadlock detected') })
            expect(result.retryLocked).toBe(true)
          })

          it('a seat that could not be put back locks Remove', async () => {
            const { result } = await removal({ portions: { 'order-new': 15 }, deleted: new Error('deadlock detected'), putBackFails: true })
            expect(result.retryLocked).toBe(true)
            expect(result.message).toContain("Putting the £10.00 back on the booking failed, so its price paid is that much too low")
          })

          it('store credit not taken back locks Remove even with the card part off the seat', async () => {
            const { result } = await removal({ portions: { 'order-new': 15 }, credit: [true, false], deleted: new Error('deadlock detected') })
            expect(result.retryLocked).toBe(true)
            expect(result.quote.refundAmount).toBe(10)
          })

          it('a failure where a retry is safe does not lock', async () => {
            for (const options of [
              { refundMethod: 'credit', deleted: new Error('deadlock detected') },
              { portions: { 'order-new': 25 }, deleted: new Error('deadlock detected') },
              { portions: { 'order-new': 15 }, deleted: new Error('deadlock detected') },
            ]) {
              const { result } = await removal(options)
              expect(result.removed).toBe(false)
              expect(result.retryLocked).toBeUndefined()
            }
          })

          it('a guest already gone does not lock: a retry only finds them gone', async () => {
            for (const options of [
              { refundMethod: 'credit', credit: [true, false], deleted: false },
              { portions: { 'order-new': 15 }, deleted: false, putBackFails: true },
            ]) {
              const { result } = await removal(options)
              expect(result.retryLocked).toBeUndefined()
            }
          })

          it('a refund that moved nothing does not lock', async () => {
            const { result } = await removal({ refunds: [{ error: 'card_declined' }] })
            expect(result.retryLocked).toBeUndefined()
          })
        })
      })

      describe('Cancel & Refund', () => {
        const cancel = async (options: Parameters<typeof setUp>[0] & { statementFails?: boolean }) => {
          const stubs = setUp({
            ...options,
            answers: [
              [/FROM bookings b JOIN sessions s/, () => [{ customer_id: 'customer-1', status: 'confirmed', price_paid: '25.00', party_size: 1, session_id: 'session-1', start_time: FAR_OFF, booking_type: 'public' }]],
              [/UPDATE bookings b\s+SET status = 'cancelled'/, () => [{ id: 'booking-1' }]],
              [/WITH p AS/, () => {
                if (options.statementFails) throw new Error('deadlock detected')
                return [{ id: 'booking-1' }]
              }],
            ],
          })
          const fn = (await backend('refundBooking')).default
          const run = fn({ params: { bookingId: 'booking-1', refundMethod: 'card' }, user })
          return { run, ...stubs }
        }

        it('store credit throwing after the card refund: not cancelled, the card money recorded and the rest owed', async () => {
          const { run, sql } = await cancel({ portions: { 'order-new': 15 }, credit: [BROKEN] })
          const result = await run
          expect(result.unsure.message).toContain('£15.00 went back to the card, and the other £10.00 is still on the booking.')
          expect(sql.some((text) => /WITH p AS/.test(text))).toBe(false)
          expect(sql.some((text) => /refund_owed_amount = price_paid/.test(text))).toBe(true)
          expect(sql.some((text) => /UPDATE order_line_items SET card_refunded_amount/.test(text))).toBe(true)
        })

        it('store credit refused after the card refund: cancelled, and staff add it by hand, as nothing can have landed', async () => {
          const { run, sql } = await cancel({ portions: { 'order-new': 15 }, credit: [false] })
          const result = await run
          expect(result).toMatchObject({ cardRefundedAmount: 15, storeCreditRefundedAmount: 0 })
          expect(result.warning).toContain('add it by hand')
          expect(sql.some((text) => /WITH p AS/.test(text))).toBe(true)
        })

        it('the next order failing after a card refund: cancelled, with the rest on store credit', async () => {
          const { run } = await cancel({ portions: { 'order-new': 15, 'order-old': BROKEN } })
          expect(await run).toMatchObject({ cardRefundedAmount: 15, storeCreditRefundedAmount: 10 })
        })

        it('a database error before any money moved says nothing was refunded, and cancels nothing', async () => {
          const { run, sql } = await cancel({ linesFail: true })
          await expect(run).rejects.toThrow("Looking up the booking's payments failed, so nothing was refunded: connection lost")
          expect(sql.some((text) => /WITH p AS/.test(text))).toBe(false)
          expect(sql.some((text) => /SET status = \$1, cancelled_at = NULL/.test(text))).toBe(true)
        })

        it('a failed cancel after a shortfall says a retry refunds the rest, never to add it by hand', async () => {
          const { run } = await cancel({ portions: { 'order-new': 15 }, credit: [false], statementFails: true })
          const error = await run.catch((err: Error) => err)
          expect((error as Error).message).toContain("£15.00 had already gone back to the card; it is recorded on the order and taken off the booking's price paid, so retrying refunds only the rest.")
          expect((error as Error).message).not.toContain('by hand')
        })
      })

      // Brief W21: refundBooking's amount paths are thin calls to the Worker now (the old body's claim, put-back and
      // warning tests went with it); the wrapper's tests are in 'refunds (W21: thin calls to the Worker)', and the rules'
      // in server/rules/bookings/refunds.test.ts. Cancel & Refund's old body is still tested below.

      describe('Move', () => {
        const session = { id: 'session-2', start_time: '2099-12-01T10:00:00', end_time: '2099-12-01T11:00:00', capacity: 8, total_booked: 0, status: 'open', service_type_id: 'type-1', band_id: 'band-2', booking_type: 'private', started: false }
        const moved = async (options: Parameters<typeof setUp>[0]) => {
          const stubs = setUp({
            ...options,
            answers: [
              [/FROM bookings b\s+LEFT JOIN sessions/, () => [{
                id: 'booking-1', customer_id: 'customer-1', session_id: 'session-1', party_size: 2, status: 'confirmed', price_paid: '50.00',
                part_refunded_amount: '0.00', refund_owed_amount: '0.00', redemption_source: 'paid', redeemed_membership_id: null, redeemed_session_pass_id: null,
                start_time: '2099-11-30T10:00:00', end_time: '2099-11-30T11:00:00', band_id: 'band-1', credit_period_id: null, booking_type: 'private',
              }]],
              [/FROM sessions s\s+JOIN service_types/, () => [session]],
              [/FROM service_type_price_tiers/, () => [{ price: '25.00' }]],
              [/UPDATE sessions[\s\S]*RETURNING/, () => [{ id: 'session-2' }]],
              [/WITH bk AS/, () => [{ id: 'booking-1', pending_id: null }]],
            ],
          })
          const fn = (await backend('moveBooking')).default
          const result = await fn({ params: { bookingId: 'booking-1', newSessionId: 'session-2', confirmed: true, refundMethod: 'card' }, user })
          return { result, ...stubs }
        }
        const undone = (sql: string[]) => sql.filter((text) => /SET session_id/.test(text)).length

        it('store credit throwing after the card refund: the move stands, and is not undone with the money gone', async () => {
          const { result, sql, rawRefund } = await moved({ portions: { 'order-new': 15 }, credit: [BROKEN] })
          // The £10 store credit couldn't give stays on price_paid, to refund again.
          expect(result).toMatchObject({ moved: true, booking: { id: 'booking-1', price_paid: 35 } })
          expect(result.warning).toContain('is still on the booking')
          expect(result.warning).not.toContain('by hand')
          expect(rawRefund).toHaveBeenCalledTimes(1)
          expect(undone(sql)).toBe(1)
        })

        it('the next order failing after a card refund: the move stands, with the rest on store credit', async () => {
          const { result, sql } = await moved({ portions: { 'order-new': 15, 'order-old': BROKEN } })
          expect(result).toMatchObject({ moved: true, warning: 'Checking the next card payment failed (connection lost), so the rest went to store credit.' })
          expect(undone(sql)).toBe(1)
        })

        it('a database error before any money moved: the move stands and the refund is reported as failed', async () => {
          const { result, rawRefund } = await moved({ linesFail: true })
          expect(result).toMatchObject({ moved: true, reason: "refund_failed: Looking up the booking's payments failed, so nothing was refunded: connection lost" })
          expect(rawRefund).not.toHaveBeenCalled()
        })
      })

      describe('the same gap elsewhere', () => {
        describe('refundOrder', () => {
          const refund = async (options: { credit: Array<boolean | Error>; portion: number }) => {
            const stubs = setUp({
              portions: { 'order-1': options.portion },
              credit: options.credit,
              answers: [
                [/SELECT id, customer_id, stripe_payment_intent_id, order_total FROM orders/, () => [{ id: 'order-1', customer_id: 'customer-1', stripe_payment_intent_id: 'pi_order-1', order_total: '25.00' }]],
                [/SELECT \* FROM order_line_items/, () => [{ id: 'line-1', item_type: 'product', line_total: '25.00', discount_amount: '0', quantity: 1, refunded_at: null, product_variant_id: 'variant-1', gift_card_id: null }]],
              ],
            })
            const fn = (await backend('refundOrder')).default
            const result = await fn({ params: { orderId: 'order-1', lineItemIds: ['line-1'], refundMethod: 'card', restock: { 'line-1': false } }, user })
            return { result, ...stubs }
          }

          // W05j: store credit nobody can say landed is counted as given, so the line is stamped and
          // can't be refunded again, and staff are told to check the balance.
          it('store credit throwing after the card refund: counted as given, the line stamped, and staff told to check', async () => {
            const { result, sql, rawRefund } = await refund({ portion: 15, credit: [BROKEN] })
            expect(result).toMatchObject({ success: true, cardRefundedAmount: 15, storeCreditRefundedAmount: 10 })
            expect(result.warning).toContain('Adding the £10.00 store credit gave no clear answer')
            expect(sql.filter((text) => /SET refunded_at = now\(\), refund_method = \$1, restocked = \$2/.test(text))).toHaveLength(1)
            expect(rawRefund).toHaveBeenCalledTimes(1)
          })

          it('store credit throwing with no card money: counted as given too, never "no refund was processed"', async () => {
            const { result } = await refund({ portion: 0, credit: [BROKEN] })
            expect(result).toMatchObject({ success: true, storeCreditRefundedAmount: 25, warning: expect.stringContaining('gave no clear answer') })
          })
        })

        describe('event places', () => {
          const cancelPlaces = async (options: { credit: Array<boolean | Error>; portion: number }) => {
            const stubs = setUp({
              portions: { 'order-1': options.portion },
              credit: options.credit,
              answers: [
                [/event_cancellation_quote/, () => [{
                  quote: { ok: true, event_id: 'event-1', customer_id: 'customer-1', attendee_ids: ['place-1'], places: 1, whole_booking: true, value: 25, before_cutoff: true },
                  status: 'confirmed',
                  places: 1,
                }]],
                [/FROM event_attendees ea\s+WHERE ea\.id = ANY/, () => [{ id: 'place-1', unit_price: '25.00' }]],
                [/oli\.event_booking_id = \$1 AND oli\.item_type = 'event'/, () => [{ id: 'line-1', order_id: 'order-1', unallocated_card: '0' }]],
              ],
            })
            const { cancelEventBookingPlaces } = await load('eventCancellation')
            const result = await cancelEventBookingPlaces({ eventBookingId: 'event-booking-1', refund: 'card', reason: null, staffId: 'staff-1' })
            return { result, ...stubs }
          }

          // W05j: store credit nobody can say landed is counted as given, so the places are cancelled
          // and can't be refunded again, and staff are told to check the balance.
          it('store credit throwing after the card refund: the places are cancelled with it counted as given', async () => {
            const { result, sql } = await cancelPlaces({ portion: 15, credit: [BROKEN] })
            expect(result).toMatchObject({ ok: true, cardRefundedAmount: 15, storeCreditRefundedAmount: 10, refundedAmount: 25 })
            expect(result.warning).toContain('Adding the £10.00 store credit gave no clear answer')
            expect(sql.some((text) => /WITH p AS/.test(text))).toBe(true)
          })

          it('store credit throwing with no card money: cancelled with it counted as given, never "nothing was cancelled"', async () => {
            const { result, sql } = await cancelPlaces({ portion: 0, credit: [BROKEN] })
            expect(result).toMatchObject({ ok: true, storeCreditRefundedAmount: 25, warning: expect.stringContaining('gave no clear answer') })
            expect(sql.some((text) => /WITH p AS/.test(text))).toBe(true)
          })
        })

        describe('booking add-ons', () => {
          const addonLine = (id: string, order: string | null, extra: Record<string, unknown> = {}) => ({
            id, addon_name: id, quantity: 1, price_at_purchase: '10.00', redemption_source: 'paid', redeemed_membership_id: null, order_id: order, ...extra,
          })
          const cancelAddons = async (options: {
            lines: unknown[]
            portions?: Record<string, number | Error>
            credit?: Array<boolean | Error>
            unclaimFails?: boolean
            creditReturnFails?: boolean
          }) => {
            const stubs = setUp({
              ...(options.portions ? { portions: options.portions } : {}),
              ...(options.credit ? { credit: options.credit } : {}),
              answers: [
                [/FROM bookings b JOIN sessions s/, () => [{ customer_id: 'customer-1', start_time: FAR_OFF }]],
                [/UPDATE addon_order_lines aol\s+SET removed_at/, () => options.lines],
                [/UPDATE addon_order_lines SET removed_at = NULL/, () => {
                  if (options.unclaimFails) throw BROKEN
                  return []
                }],
                [/UPDATE customer_memberships/, () => {
                  if (options.creditReturnFails) throw BROKEN
                  return [{ id: 'membership-1' }]
                }],
              ],
            })
            const { cancelBookingAddonLines } = await load('bookingAddonCancellation')
            const lineIds = (options.lines as Array<{ id: string }>).map((line) => line.id)
            const result = await cancelBookingAddonLines({ bookingId: 'booking-1', lineIds, refund: 'card', returnCredits: true, includePaidLines: true, staffId: 'staff-1' })
            return { result, ...stubs }
          }
          const recorded = (sql: string[]) => sql.some((text) => /SET refunded_amount = s\.refunded/.test(text))

          it('store credit throwing after the card refund: the card money is recorded on the add-on, and the rest owed', async () => {
            const { result, sql } = await cancelAddons({ lines: [addonLine('sauna-towel', 'order-1')], portions: { 'order-1': 6 }, credit: [BROKEN] })
            expect(result).toMatchObject({ cardRefundedAmount: 6, storeCreditRefundedAmount: 0, cancelledLineIds: ['sauna-towel'] })
            expect(result.warning).toContain('£4.00 for sauna-towel: This may have gone through.')
            expect(recorded(sql)).toBe(true)
            expect(sql.some((text) => /refund_owed_amount = refund_owed_amount \+/.test(text))).toBe(true)
          })

          it('store credit refused after the card refund: the card money is recorded, and staff add the rest by hand', async () => {
            const { result, sql } = await cancelAddons({ lines: [addonLine('sauna-towel', 'order-1')], portions: { 'order-1': 6 }, credit: [false] })
            expect(result.warning).toBe('£6.00 went back to the card, but adding the £4.00 remainder to store credit failed — add it manually.')
            expect(recorded(sql)).toBe(true)
          })

          it('store credit throwing with no card money: the claim stands, as it may have landed', async () => {
            const { result, sql } = await cancelAddons({ lines: [addonLine('sauna-towel', 'order-1')], portions: { 'order-1': 0 }, credit: [BROKEN] })
            expect(result.cancelledLineIds).toEqual(['sauna-towel'])
            expect(result.warning).toContain('£10.00 for sauna-towel: This may have gone through.')
            expect(sql.some((text) => /UPDATE addon_order_lines SET removed_at = NULL/.test(text))).toBe(false)
          })

          it('store credit refused with no card money: the add-on goes back on the booking', async () => {
            const { result, sql } = await cancelAddons({ lines: [addonLine('sauna-towel', 'order-1')], portions: { 'order-1': 0 }, credit: [false] })
            expect(result.cancelledLineIds).toEqual([])
            expect(result.warning).toContain('it was left on the booking')
            expect(sql.some((text) => /UPDATE addon_order_lines SET removed_at = NULL/.test(text))).toBe(true)
          })

          it('the next order failing after one was refunded: the first is still recorded, the second goes back on the booking', async () => {
            const { result, sql, rawRefund } = await cancelAddons({
              lines: [addonLine('first', 'order-1'), addonLine('second', 'order-2')],
              portions: { 'order-1': 10, 'order-2': BROKEN },
            })
            expect(result).toMatchObject({ cardRefundedAmount: 10, cancelledLineIds: ['first'] })
            expect(result.warning).toBe('Checking the card payment for second failed (connection lost), so it was left on the booking — refund it manually.')
            expect(recorded(sql)).toBe(true)
            expect(rawRefund).toHaveBeenCalledTimes(1)
          })

          it('putting an add-on back failing as well does not lose the first order\'s refund', async () => {
            const { result, sql } = await cancelAddons({
              lines: [addonLine('first', 'order-1'), addonLine('second', 'order-2')],
              portions: { 'order-1': 10, 'order-2': BROKEN },
              unclaimFails: true,
            })
            expect(result.cardRefundedAmount).toBe(10)
            expect(result.warning).toContain('Putting an add-on back on the booking failed, so it may show as removed — check it: connection lost')
            expect(recorded(sql)).toBe(true)
          })

          it('returning a membership credit failing does not lose a paid line\'s refund', async () => {
            const { result, sql } = await cancelAddons({
              lines: [addonLine('paid', 'order-1'), addonLine('credit', null, { redemption_source: 'membership_credit', redeemed_membership_id: 'membership-1' })],
              portions: { 'order-1': 10 },
              creditReturnFails: true,
            })
            expect(result).toMatchObject({ cardRefundedAmount: 10, creditsReturned: 0, cancelledLineIds: ['paid', 'credit'] })
            expect(result.warning).toBe('Returning the add-on credit for credit failed and needs a manual check: connection lost')
            expect(recorded(sql)).toBe(true)
          })
        })
      })

      describe('refundOrder run twice', () => {
        type Line = { id: string; item_type: string; line_total: string; discount_amount: string; card_refunded_amount: string; refunded_at: string | null; refund_method?: string; quantity: number; product_variant_id: string; gift_card_id: null }
        const product = (id: string, total: number, card = 0): Line => ({
          id, item_type: 'product', line_total: total.toFixed(2), discount_amount: '0', card_refunded_amount: card.toFixed(2), refunded_at: null, quantity: 1, product_variant_id: 'variant-1', gift_card_id: null,
        })

        /** An order with lines that remember what happened to them. `cardTook` is what its card
         *  took. `markFails` throws on the line's normal final write, `stampFails` on the stamp
         *  that records it instead. */
        const world = (options: { lines: Line[]; cardTook: number; credit?: Array<boolean | Error>; refunds?: Array<{ error: string } | { success: true }>; markFails?: boolean; stampFails?: boolean; answers?: Answer[] }) => {
          const lines = options.lines
          const credited: number[] = []
          const credit = [...(options.credit ?? [])]
          const line = (id: unknown) => lines.find((l) => l.id === id)!
          const addCard = (id: unknown, amount: unknown) => {
            line(id).card_refunded_amount = (Number.parseFloat(line(id).card_refunded_amount) + Number(amount)).toFixed(2)
          }
          let marksLeft = options.markFails ? 1 : 0
          const stubs = setUp({
            ...(options.refunds ? { refunds: options.refunds } : {}),
            answers: [
              ...(options.answers ?? []),
              [/SELECT id, customer_id, stripe_payment_intent_id, order_total FROM orders/, () => [{ id: 'order-1', customer_id: 'customer-1', stripe_payment_intent_id: 'pi_order-1', order_total: '40.00' }]],
              [/SELECT \* FROM order_line_items/, (params) => lines.filter((l) => (params[0] as string[]).includes(l.id)).map((l) => ({ ...l }))],
              [/FROM orders o WHERE o\.id/, () => [{
                customer_id: 'customer-1', stripe_payment_intent_id: 'pi_order-1', payment_method: 'card', order_total: String(options.cardTook), order_discount_amount: '0',
                gift_card_used: '0', store_credit_used: '0', membership_net: '0',
                already_card_refunded: String(lines.reduce((sum, l) => sum + Number.parseFloat(l.card_refunded_amount), 0)),
              }]],
              [/UPDATE order_line_items SET card_refunded_amount = card_refunded_amount \+ \$1 WHERE id = \$2/, (params) => {
                addCard(params[1], params[0])
                return []
              }],
              [/SET refunded_at = now\(\), refund_method = \$1, restocked = \$2/, (params) => {
                if (marksLeft-- > 0) throw BROKEN
                line(params[3]).refunded_at = 'now'
                line(params[3]).refund_method = String(params[0])
                addCard(params[3], params[2])
                return []
              }],
              [/SET refunded_at = now\(\), refund_method = \$1, card_refunded_amount/, (params) => {
                if (options.stampFails) throw BROKEN
                line(params[2]).refunded_at = 'now'
                line(params[2]).refund_method = String(params[0])
                addCard(params[2], params[1])
                return []
              }],
              [/store_credit_apply/, (params) => {
                const next = credit.shift()
                if (next instanceof Error) throw next
                if (next === false) return [{ result: { ok: false } }]
                credited.push(Number(params[1]))
                return [{ result: { ok: true, balance: 40 } }]
              }],
            ],
          })
          const refund = async (ids: string[], method: 'card' | 'credit' = 'card') => {
            const fn = (await backend('refundOrder')).default
            return fn({ params: { orderId: 'order-1', lineItemIds: ids, refundMethod: method, restock: Object.fromEntries(ids.map((id) => [id, false])) }, user })
          }
          return { refund, credited, line, ...stubs }
        }
        const backToCustomer = (rawRefund: ReturnType<typeof vi.fn>, credited: number[]) =>
          refundedTo(rawRefund).reduce((sum: number, body) => sum + (body as { amount: number }).amount, 0) + credited.reduce((sum, n) => sum + n, 0)

        it('the review\'s sequence: £20 card then failed store credit, then a retry: £30 back on a £30 line, not £50', async () => {
          const { refund, credited, line, rawRefund } = world({ lines: [product('line-1', 30)], cardTook: 20, credit: [BROKEN] })
          const first = await refund(['line-1'])
          expect(first).toMatchObject({ success: true, cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
          expect(line('line-1')).toMatchObject({ card_refunded_amount: '20.00', refunded_at: null })

          const retry = await refund(['line-1'])
          expect(retry).toMatchObject({ success: true, refundedAmount: 10, storeCreditRefundedAmount: 10 })
          expect(retry.cardRefundedAmount).toBeUndefined()
          expect(rawRefund).toHaveBeenCalledTimes(1)
          expect(credited).toEqual([10])
          expect(backToCustomer(rawRefund, credited)).toBe(30)
          expect(line('line-1')).toMatchObject({ card_refunded_amount: '20.00', refunded_at: 'now', refund_method: 'card' })
        })

        it('the same when the first store credit was refused, and the retry goes to store credit', async () => {
          const { refund, credited, rawRefund } = world({ lines: [product('line-1', 30)], cardTook: 20, credit: [false] })
          await refund(['line-1'])
          expect(await refund(['line-1'], 'credit')).toMatchObject({ success: true, refundedAmount: 10 })
          expect(backToCustomer(rawRefund, credited)).toBe(30)
        })

        it('a third press is refused', async () => {
          const { refund, credited, rawRefund } = world({ lines: [product('line-1', 30)], cardTook: 20, credit: [BROKEN] })
          await refund(['line-1'])
          await refund(['line-1'])
          expect(await refund(['line-1'])).toMatchObject({ success: false, reason: 'already_refunded' })
          expect(backToCustomer(rawRefund, credited)).toBe(30)
        })

        it('a line with all its money back on the card pays nothing on a retry, and is finished', async () => {
          const { refund, credited, line, rawRefund } = world({ lines: [product('line-1', 30, 30)], cardTook: 30 })
          expect(await refund(['line-1'])).toMatchObject({ success: true, refundedAmount: 0 })
          expect(rawRefund).not.toHaveBeenCalled()
          expect(credited).toEqual([])
          expect(line('line-1').refunded_at).toBe('now')
        })

        it('a promo comes off as well as what the line has had back', async () => {
          const { refund, credited } = world({ lines: [{ ...product('line-1', 30, 10), discount_amount: '5.00' }], cardTook: 10 })
          expect(await refund(['line-1'])).toMatchObject({ refundedAmount: 15, storeCreditRefundedAmount: 15 })
          expect(credited).toEqual([15])
        })

        it('card money is spread over what each line can still take, on the failure path and on success', async () => {
          for (const credit of [[BROKEN], []]) {
            const { refund, line } = world({ lines: [product('line-a', 30, 20), product('line-b', 10)], cardTook: 35, credit })
            await refund(['line-a', 'line-b'])
            expect(line('line-a').card_refunded_amount).toBe('30.00')
            expect(line('line-b').card_refunded_amount).toBe('5.00')
          }
        })

        it('the line that had nothing back still refunds in full', async () => {
          const { refund, rawRefund, credited } = world({ lines: [product('line-1', 30)], cardTook: 30 })
          expect(await refund(['line-1'])).toMatchObject({ refundedAmount: 30, cardRefundedAmount: 30 })
          expect(backToCustomer(rawRefund, credited)).toBe(30)
        })

        describe('a database error after the money has gone', () => {
          it('card only: recorded, so a retry refunds nothing', async () => {
            const { refund, line, rawRefund, credited } = world({ lines: [product('line-1', 30)], cardTook: 30, markFails: true })
            const first = await refund(['line-1'])
            expect(first).toMatchObject({ success: true, cardRefundedAmount: 30 })
            expect(first.warning).toBe(
              "The refund/credit succeeded, but recording it locally failed partway through and needs a manual check: connection lost The money is recorded on the order lines, so they can't be refunded twice. Check any restock, gift card, session pass or membership on them by hand."
            )
            expect(line('line-1')).toMatchObject({ card_refunded_amount: '30.00', refunded_at: 'now', refund_method: 'card' })
            expect(await refund(['line-1'])).toMatchObject({ success: false, reason: 'already_refunded' })
            expect(backToCustomer(rawRefund, credited)).toBe(30)
          })

          it('card and store credit: a retry can\'t pay the store credit part twice either', async () => {
            const { refund, rawRefund, credited } = world({ lines: [product('line-1', 30)], cardTook: 20, markFails: true })
            await refund(['line-1'])
            expect(await refund(['line-1'])).toMatchObject({ success: false, reason: 'already_refunded' })
            expect(credited).toEqual([10])
            expect(backToCustomer(rawRefund, credited)).toBe(30)
          })

          it('only the lines left unfinished are recorded, so none takes its card money twice', async () => {
            const { line } = world({
              lines: [product('line-a', 10), product('line-b', 20)],
              cardTook: 30,
              answers: [[/UPDATE product_variants|INSERT INTO stock_adjustments/, () => { throw BROKEN }]],
            })
            const fn = (await backend('refundOrder')).default
            const result = await fn({ params: { orderId: 'order-1', lineItemIds: ['line-a', 'line-b'], refundMethod: 'card', restock: { 'line-a': false, 'line-b': true } }, user })
            expect(result.success).toBe(true)
            expect(line('line-a').card_refunded_amount).toBe('10.00')
            expect(line('line-b').card_refunded_amount).toBe('20.00')
          })

          it('only the order status failing: every line is finished, so nothing more is said about them', async () => {
            const { refund, sql } = world({
              lines: [product('line-1', 30)],
              cardTook: 30,
              answers: [[/FROM order_line_items oli\s+LEFT JOIN bookings b/, () => { throw BROKEN }]],
            })
            expect((await refund(['line-1'])).warning).toBe(
              'The refund/credit succeeded, but recording it locally failed partway through and needs a manual check: connection lost'
            )
            expect(sql.some((text) => /SET refunded_at = now\(\), refund_method = \$1, card_refunded_amount/.test(text))).toBe(false)
          })

          it('recording failing as well: staff are told to check Stripe first', async () => {
            const { refund } = world({ lines: [product('line-1', 30)], cardTook: 30, markFails: true, stampFails: true })
            expect((await refund(['line-1'])).warning).toContain(
              'Recording it on the order lines also failed, so check in Stripe before refunding this order again: connection lost'
            )
          })

          it('with no money gone, it still undoes itself and records nothing', async () => {
            const { refund, line, credited, sql } = world({ lines: [product('line-1', 30)], cardTook: 0, markFails: true })
            expect(await refund(['line-1'], 'credit')).toMatchObject({ success: false, reason: 'unexpected_error' })
            expect(line('line-1').refunded_at).toBeNull()
            expect(credited).toEqual([30, -30])
            expect(sql.some((text) => /SET refunded_at = now\(\), refund_method = \$1, card_refunded_amount/.test(text))).toBe(false)
          })
        })

        it('a subscription that won\'t cancel after the card refund: recorded too, so a retry can\'t refund it again', async () => {
          const membership: Line = { ...product('line-1', 30), item_type: 'membership' }
          const { refund, line, rawRefund, credited } = world({
            lines: [membership],
            cardTook: 30,
            refunds: [{ success: true }, { error: 'stripe down' }],
            answers: [[/FROM customer_memberships WHERE order_line_item_id/, () => [{ id: 'membership-1', stripe_subscription_id: 'sub_1', cancel_effective_date: null }]]],
          })
          const first = await refund(['line-1'])
          expect(first).toMatchObject({ success: true, cardRefundedAmount: 30 })
          expect(first.warning).toContain('failed and needs a manual check: stripe down')
          expect(first.warning).toContain("so they can't be refunded twice")
          expect(line('line-1')).toMatchObject({ card_refunded_amount: '30.00', refunded_at: 'now' })
          expect(await refund(['line-1'])).toMatchObject({ success: false, reason: 'already_refunded' })
          expect(refundedTo(rawRefund).filter((body) => 'amount' in (body as object))).toHaveLength(1)
          expect(credited).toEqual([])
        })
      })

      describe('Cancel & Refund after the money has gone', () => {
        const READ_FAILED = 'The booking was cancelled and refunded, but reading its orders failed, so their payment status needs a manual check: connection lost'
        const cancel = async (addonLineIds?: string[]) => {
          const stubs = setUp({
            portions: { 'order-new': 15, 'order-old': 25 },
            answers: [
              [/FROM bookings b JOIN sessions s/, () => [{ customer_id: 'customer-1', status: 'confirmed', price_paid: '25.00', party_size: 1, session_id: 'session-1', start_time: FAR_OFF, booking_type: 'public' }]],
              [/UPDATE bookings b\s+SET status = 'cancelled'/, () => [{ id: 'booking-1' }]],
              [/WITH p AS/, () => [{ id: 'booking-1' }]],
              [/SELECT DISTINCT order_id FROM order_line_items/, () => { throw BROKEN }],
              [/UPDATE addon_order_lines aol\s+SET removed_at/, () => [{ id: 'addon-1', addon_name: 'Towel', quantity: 1, price_at_purchase: '10.00', redemption_source: 'paid', redeemed_membership_id: null, order_id: 'order-new' }]],
            ],
          })
          const fn = (await backend('refundBooking')).default
          const result = await fn({ params: { bookingId: 'booking-1', refundMethod: 'card', ...(addonLineIds ? { addonLineIds } : {}) }, user })
          return { result, ...stubs }
        }

        it('the read failing is a warning with what went back, not an error', async () => {
          const { result, rawRefund } = await cancel()
          expect(result).toEqual({ cardRefundedAmount: 25, storeCreditRefundedAmount: 0, warning: READ_FAILED })
          expect(rawRefund).toHaveBeenCalledTimes(2)
        })

        it('the ticked add-ons still go, and are refunded', async () => {
          const { result, sql } = await cancel(['addon-1'])
          expect(result.warning).toContain(READ_FAILED)
          expect(result.addons).toMatchObject({ cancelledLineIds: ['addon-1'] })
          expect(sql.some((text) => /UPDATE addon_order_lines aol\s+SET removed_at/.test(text))).toBe(true)
        })

        it('the orders it does know of still get their status worked out', async () => {
          const { sql } = await cancel()
          expect(sql.filter((text) => /FROM order_line_items oli\s+LEFT JOIN bookings b/.test(text)).length).toBeGreaterThan(0)
        })
      })
    })

    describe('the screens', () => {
      it('the tick keeps the figure its words show', async () => {
        const { cashTickFigure } = await screen()
        expect(cashTickFigure(20)).toBe(20)
        expect(cashTickFigure(0.1 + 0.2)).toBe(0.3)
        expect(cashTickFigure(19.999)).toBe(20)
      })

      it('sends the figure only for confirmed cash', async () => {
        const { confirmedCashFields } = await screen()
        expect(confirmedCashFields({ method: 'cash', confirmedCashAmount: 20 })).toEqual({ confirmedCashAmount: 20 })
        expect(confirmedCashFields({ method: 'cash', confirmedCashAmount: null })).toEqual({})
        expect(confirmedCashFields({ method: 'card', confirmedCashAmount: 20 })).toEqual({})
      })

      const refused = { quotedTotal: 20, serverTotal: 25, paymentParts: 5, message: 'changed' }

      it('a refused total stands in until the screen\'s own total moves', async () => {
        const { amountDueAfterRefusal } = await screen()
        expect(amountDueAfterRefusal(20, refused)).toBe(25)
        expect(amountDueAfterRefusal(30, refused)).toBe(30)
        expect(amountDueAfterRefusal(20, null)).toBe(20)
      })

      it('the message stays until staff confirm again or its figure stops being right', async () => {
        const { amountRefusalNotice } = await screen()
        expect(amountRefusalNotice(refused, 20, 5, false)).toBe('changed')
        expect(amountRefusalNotice(refused, 20, 5, true)).toBeNull()
        expect(amountRefusalNotice(refused, 20, 6, false)).toBeNull()
        expect(amountRefusalNotice(refused, 30, 5, false)).toBeNull()
        expect(amountRefusalNotice(null, 20, 5, false)).toBeNull()
      })

      it('a refusal with its words in the banner has no notice, but still moves the total', async () => {
        const { amountDueAfterRefusal, amountRefusalNotice } = await screen()
        const noWords = { ...refused, message: null }
        expect(amountRefusalNotice(noWords, 20, 5, false)).toBeNull()
        expect(amountDueAfterRefusal(20, noWords)).toBe(25)
      })

      it.each([
        ['New Order', 'frontend/components/CheckoutDialog.tsx'],
        ['Add Guest', 'frontend/components/AddGuestDialog.tsx'],
        ['Move', 'frontend/components/MoveBookingDialog.tsx'],
        ['Settle', 'frontend/components/SettleLapsedPaymentDialog.tsx'],
      ])('%s sends the figure, and clears the tick on a refusal', (_label, file) => {
        const source = readFileSync(path.join(appDir, file), 'utf8')
        expect(source).toMatch(/(confirmedCashFields|orderMethodFields)\(payment/)
        const refusal = ['result?.reason && result.priceImpact', 'result?.reason && result.amountDue !== undefined', "response?.reason === 'cash_amount_changed'"]
          .map((marker) => source.indexOf(marker))
          .find((index) => index >= 0) ?? -1
        expect(refusal).toBeGreaterThan(0)
        expect(source.slice(refusal, refusal + 500)).toContain('confirmedCashAmount: null')
      })

      it('the tick records what it shows', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/checkout/PaymentStep.tsx'), 'utf8')
        expect(source).toContain('e.target.checked ? cashTickFigure(remainder) : null')
        expect(source).toContain('I confirm {formatCurrency(remainder.toFixed(2))} in cash was received.')
      })

      it('W14a: New Order works from the basket quote everywhere (W03-plan 2.8), and asks again after a refusal', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/CheckoutDialog.tsx'), 'utf8')
        expect(source).toContain('const amountDue = quote?.totals.amountDue ?? 0')
        expect(source).toContain('quote={lastQuote}')
        expect(source).not.toContain('quotedAmountDue')
      })

      it('New Order moves to the total on every refusal over the amount', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/CheckoutDialog.tsx'), 'utf8')
        const start = source.indexOf('response?.reason && response.amountDueTotal !== undefined')
        expect(start).toBeGreaterThan(0)
        const branch = source.slice(start, start + 700)
        expect(branch).toContain('setBasketQuoteRetry((n) => n + 1)')
        expect(branch).toContain('[FAILURE_MESSAGES[response.reason], response.message].filter(Boolean).join')
      })

      it('Add Guest moves to the figures on every refusal over the amount', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/AddGuestDialog.tsx'), 'utf8')
        const start = source.indexOf('if (result?.reason && result.priceImpact) {')
        expect(start).toBeGreaterThan(0)
        const branch = source.slice(start, source.indexOf('return', start))
        expect(branch).toContain('setAmountDue(result.priceImpact.amountDue)')
        expect(branch).toContain('setAmountParts({ guest: result.priceImpact.guestAmount, addons: result.priceImpact.addonsAmount })')
        expect(branch).toContain('confirmedCashAmount: null')
        expect(branch).toContain('setErrorMessage(refusalText(result))')
      })

      it('Move moves to the figures on every refusal over the amount, and fetches the customer the payment step needs', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/MoveBookingDialog.tsx'), 'utf8')
        const start = source.indexOf('if (result?.reason && result.priceImpact) {')
        expect(start).toBeGreaterThan(0)
        const branch = source.slice(start, source.indexOf('return', start))
        expect(branch).toContain('setPriceImpact(result.priceImpact)')
        expect(branch).toContain('confirmedCashAmount: null')
        expect(branch).toContain('setErrorMessage(result.message ?? FAILURE_MESSAGES[result.reason as MoveBookingFailureReason] ?? result.reason)')
        expect(branch).toContain('if (result.priceImpact.amountDue > 0.001 && !customer) await loadPayingCustomer(result.priceImpact.customerId)')
      })

      it('Move shows the server\'s own words on any other refusal', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/MoveBookingDialog.tsx'), 'utf8')
        expect(source).toContain('} else if (result?.reason) {\n        setErrorMessage(result.message ?? FAILURE_MESSAGES')
      })

      it('Move clears the tick on Back, because the next session\'s amount can differ', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/MoveBookingDialog.tsx'), 'utf8')
        const start = source.indexOf("setStep('pick')\n                    setPriceImpact(null)")
        expect(start).toBeGreaterThan(0)
        expect(source.slice(start, source.indexOf('}}', start))).toContain('confirmedCashAmount: null')
      })

      it.each(['AddGuestDialog', 'MoveBookingDialog'])('%s only sends a method with something left to pay', (name) => {
        const source = readFileSync(path.join(appDir, `frontend/components/${name}.tsx`), 'utf8')
        expect(source).toMatch(/amountLeftToPay\([^)]*\) > 0 && payment\.method\n\s+\? \{ method: payment\.method \}/)
      })

      it.each(['AddGuestDialog', 'MoveBookingDialog', 'SettleLapsedPaymentDialog'])('%s clears its banner once the payment changes', (name) => {
        const source = readFileSync(path.join(appDir, `frontend/components/${name}.tsx`), 'utf8')
        // W19: Settle's also starts a new press key then (a block, not one line).
        expect(source).toMatch(/if \(paymentInputChanged\(payment, next\)\) (\{\s*)?setErrorMessage\(null\)/)
      })

      it("W20a (W20 review later 2): the figure to collect is the cash tick's own for cash, as New Order sends it", async () => {
        const { figureToCollect } = await screen()
        // Cash with the tick: the tick's figure, even where it differs from what the screen worked out (the Worker then
        // checks what staff confirmed, and refuses it with the new figure).
        expect(figureToCollect(15, { method: 'cash', confirmedCashAmount: 15 })).toBe(15)
        expect(figureToCollect(15, { method: 'cash', confirmedCashAmount: 12.5 })).toBe(12.5)
        // No tick, or any other method: what is left after the gift card and store credit.
        expect(figureToCollect(15, { method: 'cash', confirmedCashAmount: null })).toBe(15)
        expect(figureToCollect(15, { method: 'card', confirmedCashAmount: 12.5 })).toBe(15)
        expect(figureToCollect(15, { method: 'reader', confirmedCashAmount: null })).toBe(15)
        expect(figureToCollect(0, { method: null, confirmedCashAmount: null })).toBe(0)
        // New Order's own rule, for comparison (basketQuote.ts): cash sends the tick.
        const basket = readFileSync(path.join(appDir, 'frontend/utils/basketQuote.ts'), 'utf8')
        expect(basket).toContain("const toCollect = method === 'cash' ? (confirmedCashAmount ?? 0)")
      })

      it.each([
        ['AddGuestDialog', 'figureToCollect(amountLeftToPay(amountDue, giftCardAmount, storeCreditAmount), payment)'],
        ['SettleLapsedPaymentDialog', 'figureToCollect(remainder, payment)'],
      ])("W20a: %s sends the cash tick's figure as toCollect", (name, call) => {
        const source = readFileSync(path.join(appDir, `frontend/components/${name}.tsx`), 'utf8')
        expect(source).toContain(`toCollect: ${call}`)
        expect(source.match(/toCollect:/g)).toHaveLength(1)
      })

      it('a change to any payment input counts, and nothing else does', async () => {
        const { paymentInputChanged } = await screen()
        const base = { method: 'cash', selectedGiftCard: null, giftCardAmount: 0, storeCreditAmount: 5, confirmedCashAmount: null }
        expect(paymentInputChanged(base, { ...base })).toBe(false)
        for (const change of [{ method: 'card' }, { selectedGiftCard: {} }, { giftCardAmount: 1 }, { storeCreditAmount: 4 }, { confirmedCashAmount: 5 }]) {
          expect(paymentInputChanged(base, { ...base, ...change })).toBe(true)
        }
      })

      it('Add Guest and Settle show the server\'s own words', () => {
        const addGuest = readFileSync(path.join(appDir, 'frontend/components/AddGuestDialog.tsx'), 'utf8')
        expect(addGuest).toContain('return result?.message ?? (result?.reason ? messages[result.reason] ?? result.reason')
        expect(addGuest).not.toContain("setErrorMessage(result?.reason ? REASON_MESSAGES")
        const settle = readFileSync(path.join(appDir, 'frontend/components/SettleLapsedPaymentDialog.tsx'), 'utf8')
        expect(settle).toContain('result?.message ??\n            (result?.reason')
      })

      it('Remove Guest moves to the new figure and shows words, not a code', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(source).toContain('if (result?.quote) setQuote(result.quote)')
        expect(source).toContain("setErrorMessage(refusalText(result, 'Failed to remove guest.'))")
        expect(source).not.toContain("setErrorMessage(result?.reason ??")
      })

      it('Remove Guest has words for a cancelled booking and a guest that has gone', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(source).toContain("booking_cancelled: 'This booking has been cancelled, so guests can no longer be removed.'")
        expect(source).toContain("guest_not_found: 'This guest has already been removed.'")
      })

      it('Remove Guest no longer has a branch for a removal whose refund failed, which can\'t happen', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(source).not.toContain('Guest removed, but the refund failed')
      })

      it('Remove Guest locks on the server\'s flag, and only closing clears it', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(source).toContain("const RETRY_LOCKED_MESSAGE = 'Check the booking first. Close this and reopen it to try again.'")
        expect(source).toContain('if (result?.retryLocked) setRetryLocked(true)')
        expect(source).toContain('disabled={submitting || retryLocked ||')
        expect(source).toContain('if (!quote || retryLocked) return')
        expect(source).toContain('{retryLocked ? <div className="mt-1 font-medium">{RETRY_LOCKED_MESSAGE}</div> : null}')
        expect(source.match(/setRetryLocked\(false\)/g)).toHaveLength(1)
        expect(source).toMatch(/function resetAndClose\(\) \{[\s\S]*?setRetryLocked\(false\)[\s\S]*?\n  \}/)
      })

      it('Remove Guest has no way back to a fresh quote while locked', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(source).toMatch(/\{retryLocked \? \(\s+<Button variant="outline" onClick=\{resetAndClose\}/)
      })

      it('Remove Guest keeps its success panel up: the row only goes on close', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        const confirm = source.slice(source.indexOf('async function handleConfirm'), source.indexOf('return (\n    <>'))
        expect(confirm).toContain('removedOnClose.current = true')
        expect(confirm).not.toContain('onRemoved(guestId)')
        expect(source).toMatch(/if \(removedOnClose\.current\) \{\s+removedOnClose\.current = false\s+onRemoved\(guestId\)/)
      })

      it('Remove Guest words a split refund like Cancel Event Places, from what actually went back', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(source).toContain('`${total} refunded (${formatCurrency(card.toFixed(2))} card, ${formatCurrency(credit.toFixed(2))} store credit).`')
        expect(source).toContain('credit > 0 ? `${total} refunded to store credit.` : `${total} refunded.`')
        expect(source).toContain('result.cardRefundedAmount ?? 0')
        expect(source).toContain('result.storeCreditRefundedAmount ?? 0')
        expect(source).toContain('{success.warning ? <div className="mt-1 text-warning">{success.warning}</div> : null}')
      })

      it('Remove Guest says nothing is left on a paid seat, and keeps the old reason for an unpaid one', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(source).toMatch(/\{quote\.refundable\s+\? 'Nothing left to refund on this seat\.'\s+: 'Nothing to refund — this seat was not paid with money \(legacy booking or credit-covered\)\.'\}/)
      })

      it('Remove Guest reloads the booking when it closes after a refusal, and the parent does', () => {
        const dialog = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(dialog.match(/reloadOnClose\.current = true/g)).toHaveLength(3)
        expect(dialog).toContain('if (reloadOnClose.current) {')
        expect(dialog).toContain('onBookingStale()')
        const parent = readFileSync(path.join(appDir, 'frontend/components/BookingDetailContent.tsx'), 'utf8')
        expect(parent).toContain('onBookingStale={handleGuestRemovalRefused}')
        expect(parent).toMatch(/function handleGuestRemovalRefused\(\) \{\s+trigger\(\{ bookingId \}, \{ skipCache: true \}\)/)
      })

      it('add-ons-only mode has its own words for how to pay, from the screen and from the server', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/AddGuestDialog.tsx'), 'utf8')
        expect(source).toContain("const ADDONS_PAYMENT_MESSAGE = 'Select how to pay for the add-ons.'")
        expect(source).toContain('payment_method_required: ADDONS_PAYMENT_MESSAGE')
        expect(source).toContain("if (!payment.method) return addonsOnly ? ADDONS_PAYMENT_MESSAGE : 'Select how to pay the difference.'")
        expect(source).toContain('const messages = addonsOnly ? ADDONS_REASON_MESSAGES : REASON_MESSAGES')
        // Guest mode keeps its words.
        expect(source).toContain("payment_method_required: 'Select how to pay the seat price.'")
      })

      it('add-ons-only mode never talks about a guest', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/AddGuestDialog.tsx'), 'utf8')
        expect(source).toContain("booking_cancelled: 'This booking has been cancelled and can no longer take add-ons.'")
        expect(source).toContain("const failedMessage = addonsOnly ? 'Failed to add the add-ons.' : 'Failed to add guest.'")
        expect(source).toContain("const adding = addonsOnly ? 'these add-ons' : 'this guest'")
        expect(source).toContain("title: addonsOnly ? 'Add-ons not added' : 'Guest not added'")
        expect(source).not.toContain("'Failed to add guest.')\n")
        expect(source).not.toContain('do not retry adding this guest')
        // W20: the reader's words when its payment couldn't be started are the Worker's now, for a guest or add-ons alone.
        const worker = readFileSync(path.join(process.cwd(), 'server/rules/bookings/failure-messages.ts'), 'utf8')
        expect(worker).toContain("(addingGuest ? 'guest was' : 'add-ons were')")
      })

      describe('the customer behind the payment step', () => {
        const readiness = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/quoteReadiness'))

        it('a customer means ready; no customer or no answer is a failure, not still loading', async () => {
          const { customerLoadOutcome } = await readiness()
          expect(customerLoadOutcome([{ id: 'customer-1' }])).toEqual({ customer: { id: 'customer-1' }, status: 'ready' })
          expect(customerLoadOutcome([])).toEqual({ customer: null, status: 'failed' })
          expect(customerLoadOutcome(null)).toEqual({ customer: null, status: 'failed' })
          expect(customerLoadOutcome(undefined)).toEqual({ customer: null, status: 'failed' })
        })

        it('has the agreed words and a Try again button', async () => {
          const { CUSTOMER_LOAD_MESSAGE } = await readiness()
          expect(CUSTOMER_LOAD_MESSAGE).toBe("Couldn't load this customer's payment details. Please try again.")
          const source = readFileSync(path.join(appDir, 'frontend/components/checkout/PaymentCustomerLoad.tsx'), 'utf8')
          expect(source).toContain("if (status !== 'failed') {")
          expect(source).toContain('{CUSTOMER_LOAD_MESSAGE}')
          expect(source).toMatch(/onClick=\{onRetry\}>\s+Try again/)
        })

        it('a load that fails or arrives late is handled', () => {
          const source = readFileSync(path.join(appDir, 'frontend/hooks/usePaymentCustomer.ts'), 'utf8')
          // The second argument to then: without it a failed load would hang on the loading line.
          expect(source).toMatch(/\.result\.then\(\s+\(rows: CustomerRow\[\]\) => \{[\s\S]+\},\s+\(\) => \{[\s\S]+setStatus\('failed'\)/)
          expect(source.match(/if \(requestRef\.current !== requestId\) return/g)).toHaveLength(2)
          expect(source).toMatch(/function clear\(\) \{\s+requestRef\.current \+= 1/)
        })

        it.each([
          ['AddGuestDialog', 'onRetry={() => void loadCustomer(customerId)}', 'disabled={submitting || !customer}'],
          ['SettleLapsedPaymentDialog', 'onRetry={() => void loadCustomer(customerId)}', 'disabled={submitting || amountDue === null || !customer}'],
          ['MoveBookingDialog', 'onRetry={() => void loadPayingCustomer(priceImpact.customerId)}', '|| ((priceImpact?.amountDue ?? 0) > 0.001 && !customer)}'],
        ])('%s offers Try again, clears on close, and Confirm waits for the customer', (name, retry, gate) => {
          const source = readFileSync(path.join(appDir, `frontend/components/${name}.tsx`), 'utf8')
          expect(source).toContain('<PaymentCustomerLoad status={customerStatus}')
          expect(source).toContain(retry)
          expect(source).toContain(gate)
          expect(source).toContain('clearCustomer()')
          expect(source).not.toContain('Loading customer payment details')
          expect(source).not.toContain('useGetCustomers')
        })
      })

      it('Settle asks the parent to reload the booking on the refusal, and the parent does', () => {
        const dialog = readFileSync(path.join(appDir, 'frontend/components/SettleLapsedPaymentDialog.tsx'), 'utf8')
        const start = dialog.indexOf('if (result?.reason && result.amountDue !== undefined) {')
        expect(start).toBeGreaterThan(0)
        const branch = dialog.slice(start, dialog.indexOf('return', start))
        expect(branch).toContain('setServerAmountDue(result.amountDue)')
        expect(branch).toContain('confirmedCashAmount: null')
        expect(branch).toContain('onAmountChanged()')
        const parent = readFileSync(path.join(appDir, 'frontend/components/BookingDetailContent.tsx'), 'utf8')
        expect(parent).toContain('onAmountChanged={() => trigger({ bookingId }, { skipCache: true })}')
        // Reloading must not take the dialog away: only a first load shows the skeleton.
        expect(parent).toContain('if (loading && !detail) return <Skeleton')
      })

      describe('what a move leaves staff to do', () => {
        const notices = async (result: Record<string, unknown>) => (await import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/paymentMethodChoice'))).moveNotices(result)
        const dialog = () => readFileSync(path.join(appDir, 'frontend/components/MoveBookingDialog.tsx'), 'utf8')

        it('a failed refund and a warning both stay, in the words accepted before', async () => {
          expect(await notices({ moved: true, reason: 'refund_failed: The card refund failed, so nothing was refunded: declined', warning: 'Check the pass.' })).toEqual([
            'Booking moved, but the refund failed: The card refund failed, so nothing was refunded: declined',
            'Check the pass.',
          ])
        })

        it('a clean move leaves nothing', async () => {
          expect(await notices({ moved: true })).toEqual([])
        })

        it('every way a move finishes goes the same way, and none is only a toast', () => {
          const source = dialog()
          expect(source).not.toContain('toast.warning')
          expect(source.match(/finishMove\(/g)).toHaveLength(5)
          expect(source.match(/finishMove\(moveNotices\(result\)\)/g)).toHaveLength(2)
          expect(source.match(/toast\.success\('Booking moved'\)/g)).toHaveLength(1)
        })

        it('held open, the parent hears on close, and there is no way to move it again', () => {
          const source = dialog()
          const finish = source.slice(source.indexOf('function finishMove'), source.indexOf('/** PaymentStep needs the customer'))
          expect(finish).toMatch(/if \(lines\.length > 0\) \{\s+movedOnClose\.current = true\s+setNotices\(lines\)\s+return\s+\}/)
          expect(source).toMatch(/function resetAndClose\(\) \{\s+if \(movedOnClose\.current\) \{\s+movedOnClose\.current = false\s+onMoved\(\)/)
          expect(source).toMatch(/\{notices \? \(\s+<Button onClick=\{resetAndClose\}>Done<\/Button>/)
          expect(source.match(/onMoved\(\)/g)).toHaveLength(2)
        })
      })

      describe('warnings that used to go with a toast', () => {
        const read = (name: string) => readFileSync(path.join(appDir, `frontend/components/${name}.tsx`), 'utf8')

        it.each(['RemoveBookingAddonDialog', 'CancelEventPlacesDialog', 'CancelCreditBookingDialog', 'CancelPaymentNeededDialog'])('%s has no warning in a toast', (name) => {
          expect(read(name)).not.toContain('toast.warning')
        })

        it('Remove Add-on stays open on a warning, and the row goes on close', () => {
          const source = read('RemoveBookingAddonDialog')
          const confirm = source.slice(source.indexOf('async function handleConfirm'), source.indexOf('return (\n    <>'))
          expect(confirm).toMatch(/if \(result\.warning\) \{\s+removedOnClose\.current = true\s+setDone\(\{ summary: result\.summary, notes: result\.notes, warning: result\.warning \}\)\s+return\s+\}/)
          expect(source).toMatch(/function close\(\) \{[\s\S]*?if \(removedOnClose\.current\) \{\s+removedOnClose\.current = false\s+onRemoved\(\)/)
          expect(source).toContain('<div className="mt-1 text-warning">{done.warning}</div>')
          expect(source).toMatch(/\{done \? \(\s+<Button onClick=\{close\}>Done<\/Button>/)
          expect(source).toContain('next ? setOpen(true) : close()')
        })

        it('Cancel Event Places keeps refusals and thrown errors in the dialog', () => {
          const source = read('CancelEventPlacesDialog')
          expect(source).not.toContain('toast.error')
          expect(source).toContain("setErrorMessage([result.message, result.warning].filter(Boolean).join(' '))")
          expect(source).toContain("setErrorMessage(err instanceof Error ? err.message : 'Failed to cancel')")
          expect(source).toContain('<div>{errorMessage}</div>')
        })

        it('Cancel Event Places stays open on a warning, and the page hears on close', () => {
          const source = read('CancelEventPlacesDialog')
          expect(source).toMatch(/if \(result\.warning\) \{\s+cancelledOnClose\.current = \(\) => onCancelled\(result\.booking, result\.eventPlacesBooked\)\s+setDone\(\{ summary, warning: result\.warning \}\)\s+return\s+\}/)
          expect(source).toMatch(/function close\(\) \{[\s\S]*?cancelledOnClose\.current\?\.\(\)/)
          expect(source).toContain('<div className="mt-1 text-warning">{done.warning}</div>')
          expect(source).toMatch(/\{done \? \(\s+<Button onClick=\{close\}>Done<\/Button>/)
        })

        it('Cancel & Return Credit shows the warning, and only reloads on close when there is one', () => {
          const source = read('CancelCreditBookingDialog')
          expect(source).toContain('{result.warning ? <div className="mt-1 text-warning">{result.warning}</div> : null}')
          expect(source).toMatch(/if \(response\.warning\) cancelledOnClose\.current = true\s+else onCancelled\(bookingId\)/)
          expect(source).toMatch(/function resetAndClose\(\) \{\s+if \(cancelledOnClose\.current\) \{\s+cancelledOnClose\.current = false\s+onCancelled\(bookingId\)/)
        })

        it('Cancel Booking stays open on a warning, and only reloads on close', () => {
          const source = read('CancelPaymentNeededDialog')
          expect(source).toMatch(/if \(response\.warning\) \{\s+setDone\(\{ summary, notes: response\.addons\?\.notes \?\? \[\], warning: response\.warning \}\)\s+return\s+\}/)
          expect(source).toMatch(/function resetAndClose\(\) \{[\s\S]*?if \(done\) onCancelled\(bookingId\)/)
          expect(source).toContain('<div className="mt-1 text-warning">{done.warning}</div>')
        })
      })

      it('Remove Guest locks and reloads when the call itself fails, because the refund may have gone', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        const confirm = source.slice(source.indexOf('async function handleConfirm'), source.indexOf('return (\n    <>'))
        const failed = confirm.slice(confirm.indexOf('} catch (err) {'))
        expect(failed).toContain('reloadOnClose.current = true')
        expect(failed).toContain('setRetryLocked(true)')
        // Fetching the quote moves no money, so it stays retryable.
        const quote = source.slice(source.indexOf('async function handleQuote'), source.indexOf('async function handleConfirm'))
        expect(quote).not.toContain('setRetryLocked(true)')
      })

      it('New Order goes by what it sent and what came back, and never by the method held on screen', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/CheckoutDialog.tsx'), 'utf8')
        const after = source.slice(source.indexOf('if (response?.success) {'), source.indexOf('async function handleCancelReaderWait'))
        expect(after).not.toContain("payment.method === 'reader'")
        expect(after).not.toMatch(/\bpayment\.method\b/)
        expect(after).toContain('if (readerReferenceMissing(paymentInput.method, response.pendingReaderPayment)) {')
        expect(after).toContain('const pending = response.pendingReaderPayment\n      if (pending) {')
        // W14a: the result line names the method that was sent (paymentSummaryLine), never the one held on screen.
        expect(source).toContain('const methodSent = paymentInput.method ?? null')
        expect(source).toContain('...orderMethodFields(payment, totals.toCollect.cash, membershipAmount, readerSaveCard),')
      })

      it('New Order keeps a refusal\'s banner when the method goes by itself', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/CheckoutDialog.tsx'), 'utf8')
        expect(source).toContain('const clearedByItself = methodOnlyCleared(methodSeen.current, payment.method)')
        expect(source).toContain("if (phase !== 'payment' || clearedByItself) return")
      })

      it('the payment step clears the held method, after the tick, and shows the choices by the same rule', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/checkout/PaymentStep.tsx'), 'utf8')
        expect(source).toContain('const cleared = clearHiddenMethod(state, choicesShown)')
        expect(source).toContain('if (cleared !== state) onChange(cleared)')
        expect(source).toContain('}, [choicesShown, state.method])')
        expect(source).toContain('{choicesShown ? (')
        expect(source.indexOf('clearHiddenMethod(state')).toBeGreaterThan(source.indexOf('if (state.confirmedCashAmount !== null) onChange'))
      })

      it('W14a: the result line says what was taken, from the answer (W03-plan 2.8: the screen stops cashShortfall)', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/CheckoutDialog.tsx'), 'utf8')
        expect(source).not.toContain('cashShortfall(')
        expect(source).toContain('collected: result.cardAmount ?? 0,')
      })
    })
  })

  describe('Redemption Source "Gift Card" is gone', () => {
    // W16: the refusal itself is the Worker's now (place-order.test.ts, "the gift card source is refused").
    it.each([
      ['backend/paddock/createOrder.ts'],
      ['frontend/components/CheckoutDialog.tsx'],
      ['frontend/components/BookingDetailContent.tsx'],
      ['frontend/components/BlockSessionDialog.tsx'],
      ['frontend/components/BlockDayDialog.tsx'],
    ])('%s has no special case for it', (file) => {
      const source = readFileSync(path.join(appDir, file), 'utf8')
      expect(source).not.toMatch(/[rR]edemption_?[sS]ource\s*[!=]==\s*'gift_card'/)
      expect(source).not.toMatch(/pay_by === 'gift_card'/)
    })

    it('neither list on the booking screen offers it', () => {
      const source = readFileSync(path.join(appDir, 'frontend/components/checkout/BookingSection.tsx'), 'utf8')
      expect(source).not.toContain("value: 'gift_card'")
    })
  })

  describe('changing the customer in New Order', () => {
    const change = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/customerChange'))

    it('clears the money that belonged to the old customer', async () => {
      const { paymentForNewCustomer } = await change()
      const payment = { selectedGiftCard: { id: 'card-1' }, giftCardAmount: 10, storeCreditAmount: 5, method: 'cash', confirmedCashAmount: 20 }
      expect(paymentForNewCustomer(payment)).toEqual({ selectedGiftCard: null, giftCardAmount: 0, storeCreditAmount: 0, method: 'cash', confirmedCashAmount: null })
    })

    it('clears their membership and session pass', async () => {
      const { bookingForNewCustomer } = await change()
      const booking = { membershipId: 'm1', sessionPassId: 'p1', cancelExhaustedMembershipId: 'm0', redemptionSource: 'membership_credit', addons: [] }
      expect(bookingForNewCustomer(booking)).toEqual({ membershipId: null, sessionPassId: null, cancelExhaustedMembershipId: null, redemptionSource: 'membership_credit', addons: [] })
    })

    it('an add-on on their credit becomes paid, at the price on the line', async () => {
      const { bookingForNewCustomer } = await change()
      const line = { addonId: 'a1', quantity: 1, unitPrice: 7, redemptionSource: 'membership_credit', membershipId: 'm1', systemUnitPrice: 9, priceOverrideReason: 'Staff' }
      const { addons } = bookingForNewCustomer({ addons: [line] })
      expect(addons).toEqual([{ addonId: 'a1', quantity: 1, unitPrice: 7, redemptionSource: 'paid', systemUnitPrice: 9, priceOverrideReason: 'Staff' }])
    })

    it('leaves paid lines and typed prices alone', async () => {
      const { bookingForNewCustomer } = await change()
      const line = { addonId: 'a1', quantity: 2, unitPrice: 3.5, redemptionSource: 'paid', priceOverrideReason: 'Staff' }
      expect(bookingForNewCustomer({ addons: [line] }).addons[0]).toBe(line)
    })

    it('the picker goes through them, and only for a different customer', () => {
      const source = readFileSync(path.join(appDir, 'frontend/components/CheckoutDialog.tsx'), 'utf8')
      expect(source).toContain('onSelect={handleCustomerSelected}')
      const start = source.indexOf('function handleCustomerSelected')
      const body = source.slice(start, source.indexOf('\n  }\n', start))
      expect(body).toContain('if (next?.id !== customer?.id)')
      expect(body).toContain('setPayment(paymentForNewCustomer)')
      expect(body).toContain('setBooking(bookingForNewCustomer)')
      expect(body).toContain('setDeliveryAddress(emptyDeliveryAddress())')
      expect(body).toContain('addressPrefilledForRef.current = null')
      expect(body).toContain('setReaderSaveCard(false)')
      // Saving a card on the reader updates the same customer, and must keep the payment.
      expect(source).toContain('onCustomerUpdated={(updated) => setCustomer(updated)}')
    })
  })

})
