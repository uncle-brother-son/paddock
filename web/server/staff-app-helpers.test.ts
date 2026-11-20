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
        // W44: requireCanIssueRefunds left the staff app (no caller: the Worker checks Issue refunds).
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
    // W50: setAddonLinePrepared, setBookingCheckedIn and setGuestWaiverStatus left this list. They are thin calls to
    // the Worker now, which refuses an inactive account before anything happens: held in "W50: the booking and
    // Overview functions are thin calls to the Worker" below, with the same words.
    const guarded = [
      'addServiceTypeScheduleSlot',
      'createOneOffSession',
      'deleteServiceTypeScheduleSlot',
      'generateUpcomingSessions',
      'setEventAttendeeCheckIn',
      'setEventAttendeeWaiver',
      'setEventAttendeesCheckIn',
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

    // Brief W39: createCustomer is a thin call to the Worker now (it was one of W01c's guarded functions), whose
    // defineRoute refuses an inactive account before anything is read (the route's own tests, customers/customers.test.ts).
    // The refusal comes back as data with the same words. Never the database or the legacy routes themselves.
    it('createCustomer asks only the Worker, which refuses an inactive account', async () => {
      const query = stubStaffTable([row(false)])
      const legacy = vi.fn()
      vi.stubGlobal('paddockBackendApi2', { rawRequest: legacy })
      rawRequest.mockResolvedValue(refusal('FORBIDDEN', INACTIVE))
      const { default: fn } = await import(/* @vite-ignore */ path.join(appDir, 'backend/paddock/createCustomer'))

      expect(await fn({ params: { firstName: 'Dee', lastName: 'Dale', email: 'dee@example.com', dateOfBirth: '1992-02-29' }, user })).toEqual({ created: false, reason: 'permission_denied', message: INACTIVE })

      expect(rawRequest).toHaveBeenCalledTimes(1)
      expect(legacy).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
    })

    // Brief W38: picked up and shipped are thin calls to the Worker now (they were two of W01c's guarded functions),
    // whose defineRoute refuses an inactive account, setting or clearing (the routes' own tests, gift-cards/admin.test.ts).
    // The refusal comes back as data with the same words. Never the database or the legacy routes themselves.
    it.each([
      ['setGiftCardPickedUp', { pickedUp: true }],
      ['setGiftCardPickedUp', { pickedUp: false }],
      ['setGiftCardShipped', { shipped: true }],
      ['setGiftCardShipped', { shipped: false }],
    ] as const)('%s %o asks only the Worker, which refuses an inactive account', async (name, flag) => {
      const query = stubStaffTable([row(false)])
      const legacy = vi.fn()
      vi.stubGlobal('paddockBackendApi2', { rawRequest: legacy })
      rawRequest.mockResolvedValue(refusal('FORBIDDEN', INACTIVE))
      const { default: fn } = await import(/* @vite-ignore */ path.join(appDir, `backend/paddock/${name}`))

      expect(await fn({ params: { giftCardId: '11111111-1111-4111-8111-111111111111', ...flag }, user })).toEqual({ updated: false, reason: 'permission_denied', message: INACTIVE })

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

    // W25: chargeSavedCard and createTerminalPaymentIntent, and their unguarded versions, went with the old flow code:
    // every charge and reader intent is the Worker's (server/rules/testing/removed-booking-code.test.ts).

    it('uses the same wording as the Worker', async () => {
      const { INACTIVE_STAFF_MESSAGE } = await load('staffAccess')
      const db = { query: async () => [row(false)] } as unknown as Queryable
      const headers = new Headers({ authorization: 'Bearer key', 'x-staff-email': 'jo@example.com' })

      await expect(authenticateStaff(headers, db, 'key')).rejects.toThrow(INACTIVE_STAFF_MESSAGE)
    })
  })

  // W49 + W54 (brief item 12; W48 "Noticed" 3). The four tests that stood here ("at least one active admin") ran the
  // old setStaffPermission and setStaffRole against a stubbed database. Both are thin calls now, so:
  //  - "refuses when the guarded update changed nothing and the staff member exists" and "answers null, as before,
  //    for a staff member who does not exist" are MOVED here as what the thin functions make of the Worker's two
  //    refusals (the old words thrown; null);
  //  - "counts and locks inside the one statement that makes the change" and "adding an admin or switching someone on
  //    needs no guard" are DROPPED: they read the old SQL. The rule is the Worker's, held by
  //    server/rules/staff/admin.test.ts ("the last active admin keeps the role", "the last active admin stays active",
  //    "switching on … needs no guard", "every staff change holds the staff guard before it reads") and, as races on
  //    real Postgres, by server/rules/staff/admin-postgres.test.ts.
  describe('W49 + W54: the staff, pricing and promo code functions are thin calls to the Worker', () => {
    const INACTIVE = 'This staff account is inactive. Ask an admin to reactivate it.'
    const LAST_ADMIN = 'There must always be at least one active admin. Make someone else an active admin first.'
    const NO_ANSWER = "That didn't get an answer, so it may or may not have been saved. The screen has been reloaded: check it, and press again if it hasn't changed."
    const STAFF_ID = '11111111-1111-4111-8111-111111111111'
    const fn = async (name: string) => (await import(/* @vite-ignore */ path.join(appDir, `backend/paddock/${name}`))).default as (req: { params: Record<string, unknown>; user: typeof user }) => Promise<unknown>
    /** A refusal as the Worker's admin rules answer it: the reason and the words in `details`. */
    const refused = (code: string, reason: string, message: string) => ({ data: { ok: false, error: { code, message, details: { reason, message, action: 'x' } }, requestId: 'worker-request' } })
    const promo = { code: 'ALLTEN', discountType: 'percentage', discountValue: 10, appliesTo: ['booking'], appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null }
    const sent = () => rawRequest.mock.calls[0]?.[0] as { path: string; method: string; body?: unknown; headers: Record<string, string> }

    /** Each function with params a screen sends, and the route it must call. */
    const thin: Array<[string, Record<string, unknown>, string, string]> = [
      ['getCurrentStaff', {}, 'GET', '/api/v1/staff/staff/me'],
      ['getStaff', {}, 'GET', '/api/v1/staff/staff'],
      ['createStaff', { firstName: 'Nia', lastName: 'New', email: 'nia@example.com', role: 'staff' }, 'POST', '/api/v1/staff/staff'],
      ['setStaffRole', { staffId: STAFF_ID, role: 'manager' }, 'POST', `/api/v1/staff/staff/${STAFF_ID}/role`],
      ['setStaffPermission', { staffId: STAFF_ID, field: 'active', value: false }, 'POST', `/api/v1/staff/staff/${STAFF_ID}/permissions`],
      ['setStaffCanManagePricing', { staffId: STAFF_ID, canManagePricing: false }, 'POST', `/api/v1/staff/staff/${STAFF_ID}/permissions`],
      ['setBandPrice', { bandId: STAFF_ID, price: 22 }, 'POST', `/api/v1/staff/pricing/bands/${STAFF_ID}/price`],
      ['setBandRules', { dayOfWeek: 6, rules: [{ bandId: STAFF_ID, fromTime: '00:00', toTime: '24:00' }] }, 'POST', '/api/v1/staff/pricing/band-rules/6'],
      ['setMembershipBandTerm', { membershipLevel: 'core', bandId: STAFF_ID, creditEligible: false, discountPercent: 20 }, 'POST', '/api/v1/staff/pricing/member-band-terms'],
      ['setPostageSettings', { standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60 }, 'POST', '/api/v1/staff/postage/settings'],
      ['getPromoCodes', {}, 'GET', '/api/v1/staff/promo-codes'],
      ['getPromoCodeRedemptions', { promoCodeId: STAFF_ID }, 'GET', `/api/v1/staff/promo-codes/${STAFF_ID}/redemptions`],
      ['createPromoCode', promo, 'POST', '/api/v1/staff/promo-codes'],
      ['updatePromoCode', { ...promo, id: STAFF_ID, active: true }, 'POST', `/api/v1/staff/promo-codes/${STAFF_ID}`],
    ]

    it.each(thin)('%s asks only the Worker, on its own route, and an inactive account is refused in the same words as before', async (name, params, method, route) => {
      const query = vi.fn()
      const legacy = vi.fn()
      vi.stubGlobal('paddockData', { query })
      vi.stubGlobal('paddockBackendApi2', { rawRequest: legacy })
      rawRequest.mockResolvedValue(refusal('FORBIDDEN', INACTIVE))
      const call = (await fn(name))({ params, user })

      // The two that add something answer a refusal as data (their dialogs keep a press key); every other one throws
      // the words alone, as the old functions did: no code and no request id after them.
      if (name === 'createStaff' || name === 'createPromoCode') expect(await call).toEqual({ created: false, reason: 'permission_denied', message: INACTIVE })
      else await expect(call).rejects.toThrow(new Error(INACTIVE))

      expect(rawRequest).toHaveBeenCalledTimes(1)
      expect(sent()).toMatchObject({ method, path: route, headers: { 'X-Staff-Email': user.email } })
      // A write goes under a press key (the screen's, or one made for the call); a read has none.
      expect(typeof sent().headers['Idempotency-Key']).toBe(method === 'POST' ? 'string' : 'undefined')
      expect(legacy).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
    })

    it("a press's key is the screen's own when it sends one, and is never part of what is sent as the change", async () => {
      rawRequest.mockResolvedValue(success({ id: STAFF_ID, role: 'manager' }))
      await (await fn('setStaffRole'))({ params: { staffId: STAFF_ID, role: 'manager', idempotencyKey: 'key-from-the-screen-1234' }, user })
      expect(sent().headers['Idempotency-Key']).toBe('key-from-the-screen-1234')
      expect(sent().body).toEqual({ role: 'manager' })

      rawRequest.mockClear()
      rawRequest.mockResolvedValue(success({ id: 'p1' }))
      await (await fn('createPromoCode'))({ params: { ...promo, idempotencyKey: 'key-from-the-dialog-12345' }, user })
      expect(sent().headers['Idempotency-Key']).toBe('key-from-the-dialog-12345')
      expect(sent().body).toEqual(promo)
    })

    // Moved from "at least one active admin": the old guarded update that changed nothing for a staff member who exists.
    it('setStaffRole and setStaffPermission throw the last-active-admin refusal in the old words, exactly', async () => {
      rawRequest.mockResolvedValue(refused('CONFLICT', 'last_active_admin', LAST_ADMIN))
      await expect((await fn('setStaffPermission'))({ params: { staffId: STAFF_ID, field: 'active', value: false }, user })).rejects.toThrow(new Error(LAST_ADMIN))
      await expect((await fn('setStaffRole'))({ params: { staffId: STAFF_ID, role: 'staff' }, user })).rejects.toThrow(new Error(LAST_ADMIN))
    })

    // Moved from "at least one active admin".
    it('setStaffRole and setStaffPermission answer null, as before, for a staff member who does not exist; setStaffCanManagePricing throws, as before', async () => {
      rawRequest.mockResolvedValue(refused('NOT_FOUND', 'staff_not_found', 'Staff member not found.'))
      expect(await (await fn('setStaffPermission'))({ params: { staffId: STAFF_ID, field: 'active', value: false }, user })).toBeNull()
      expect(await (await fn('setStaffRole'))({ params: { staffId: STAFF_ID, role: 'staff' }, user })).toBeNull()
      await expect((await fn('setStaffCanManagePricing'))({ params: { staffId: STAFF_ID, canManagePricing: true }, user })).rejects.toThrow(new Error('Staff member not found.'))
    })

    it('the three switches share one route: setStaffPermission sends its own two and refuses any other itself, in the old words; setStaffCanManagePricing sends the third', async () => {
      await expect((await fn('setStaffPermission'))({ params: { staffId: STAFF_ID, field: 'can_manage_pricing', value: true }, user })).rejects.toThrow(new Error('Invalid field: can_manage_pricing'))
      expect(rawRequest).not.toHaveBeenCalled()

      rawRequest.mockResolvedValue(success({ id: STAFF_ID, can_issue_refunds: true }))
      expect(await (await fn('setStaffPermission'))({ params: { staffId: STAFF_ID, field: 'can_issue_refunds', value: true }, user })).toEqual({ id: STAFF_ID, can_issue_refunds: true })
      expect(sent().body).toEqual({ field: 'can_issue_refunds', value: true })

      rawRequest.mockClear()
      rawRequest.mockResolvedValue(success({ id: STAFF_ID, can_manage_pricing: false }))
      expect(await (await fn('setStaffCanManagePricing'))({ params: { staffId: STAFF_ID, canManagePricing: false }, user })).toEqual({ id: STAFF_ID, can_manage_pricing: false })
      expect(sent().body).toEqual({ field: 'can_manage_pricing', value: false })
    })

    it('a refusal the old function answered as data still is: a promo code not there or locked, a band not there (now with words)', async () => {
      const update = await fn('updatePromoCode')
      rawRequest.mockResolvedValue(refused('NOT_FOUND', 'not_found', 'That promo code no longer exists.'))
      expect(await update({ params: { ...promo, id: STAFF_ID, active: true }, user })).toEqual({ updated: false, reason: 'not_found', message: 'That promo code no longer exists.' })
      rawRequest.mockResolvedValue(refused('CONFLICT', 'code_locked', 'Locked.'))
      expect(await update({ params: { ...promo, id: STAFF_ID, active: true }, user })).toEqual({ updated: false, reason: 'code_locked', message: 'Locked.' })
      // Any other refusal is thrown in its words, as before.
      rawRequest.mockResolvedValue(refused('CONFLICT', 'duplicate_code', 'A promo code "FIVER" already exists (codes are unique, case-insensitive).'))
      await expect(update({ params: { ...promo, id: STAFF_ID, active: true }, user })).rejects.toThrow(new Error('A promo code "FIVER" already exists (codes are unique, case-insensitive).'))

      rawRequest.mockResolvedValue(refused('NOT_FOUND', 'band_not_found', 'That band no longer exists. Reload the page and try again.'))
      expect(await (await fn('setBandPrice'))({ params: { bandId: STAFF_ID, price: 22 }, user })).toEqual({ updated: false, reason: 'band_not_found', message: 'That band no longer exists. Reload the page and try again.' })
      rawRequest.mockResolvedValue(success({ updated: true, band: { id: STAFF_ID, code: 'core', name: 'Core', price: '22.00' } }))
      expect(await (await fn('setBandPrice'))({ params: { bandId: STAFF_ID, price: 22 }, user })).toEqual({ updated: true, band: { id: STAFF_ID, code: 'core', name: 'Core', price: '22.00' } })
    })

    it('no answer: a setting says the change may or may not have been saved; a create says so as data, so its dialog keeps its key; a read keeps the "didn\'t answer" error', async () => {
      rawRequest.mockRejectedValue(new Error('socket hang up'))
      for (const [name, params] of [['setStaffRole', { staffId: STAFF_ID, role: 'manager' }], ['setBandRules', { dayOfWeek: 6, rules: [] }], ['setPostageSettings', {}], ['updatePromoCode', { ...promo, id: STAFF_ID, active: true }]] as const) {
        await expect((await fn(name))({ params, user }), name).rejects.toThrow(new Error(NO_ANSWER))
      }
      // The Worker's own fault (a 500) and a press still running under the same key (409 with no reason) are no answer too.
      rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))
      await expect((await fn('setBandPrice'))({ params: { bandId: STAFF_ID, price: 22 }, user })).rejects.toThrow(new Error(NO_ANSWER))
      rawRequest.mockResolvedValue(refusal('CONFLICT', 'A request with this key is still in progress.'))
      expect(await (await fn('createStaff'))({ params: { firstName: 'Nia', lastName: 'New', email: 'nia@example.com', role: 'staff' }, user })).toMatchObject({ created: false, reason: 'no_answer', noAnswer: true, message: expect.stringContaining("didn't get an answer") })
      expect(await (await fn('createPromoCode'))({ params: promo, user })).toMatchObject({ created: false, reason: 'no_answer', noAnswer: true, message: expect.stringContaining('Press Create promo code again here') })
      // A changed press under the key of one that got no answer.
      rawRequest.mockResolvedValue(refusal('IDEMPOTENCY_MISMATCH', 'This key was used for a different request.'))
      expect(await (await fn('createStaff'))({ params: { firstName: 'Nia', lastName: 'Other', email: 'nia@example.com', role: 'staff' }, user })).toMatchObject({ created: false, reason: 'pressed_after_no_answer', noAnswer: true })

      rawRequest.mockRejectedValue(new Error('socket hang up'))
      await expect((await fn('getStaff'))({ params: {}, user })).rejects.toThrow(/Could not reach the Worker: socket hang up \(WORKER_UNREACHABLE, request /)
    })

    it('the old result shapes come back unchanged from a success', async () => {
      const row = { id: STAFF_ID, email: 'jo@example.com', role: 'admin', can_issue_refunds: true, can_manage_pricing: true, active: false }
      rawRequest.mockResolvedValue(success(row))
      expect(await (await fn('getCurrentStaff'))({ params: {}, user })).toEqual(row)
      rawRequest.mockResolvedValue(success(null))
      expect(await (await fn('getCurrentStaff'))({ params: {}, user })).toBeNull()
      // W54a: with the row's new stamp beside the old shape, for the screen's next save.
      rawRequest.mockResolvedValue(success({ saved: true, rebandedSessions: 3, rules: [], stamp: 'day-2' }))
      expect(await (await fn('setBandRules'))({ params: { dayOfWeek: 6, rules: [] }, user })).toStrictEqual({ saved: true, rebandedSessions: 3, rules: [], stamp: 'day-2' })
      rawRequest.mockResolvedValue(success({ updated: true, promo: { id: STAFF_ID, code: 'ALLTEN' }, stamp: 'code-2' }))
      expect(await (await fn('updatePromoCode'))({ params: { ...promo, id: STAFF_ID, active: true }, user })).toStrictEqual({ updated: true, promo: { id: STAFF_ID, code: 'ALLTEN' }, stamp: 'code-2' })
      const term = { id: 't1', membership_level: 'core', band_id: STAFF_ID, credit_eligible: false, discount_percent: '20.00' }
      rawRequest.mockResolvedValue(success({ saved: true, term, stamp: 'term-2' }))
      expect(await (await fn('setMembershipBandTerm'))({ params: { membershipLevel: 'core', bandId: STAFF_ID, creditEligible: false, discountPercent: 20 }, user })).toStrictEqual({ saved: true, term, stamp: 'term-2' })
      rawRequest.mockResolvedValue(success({ standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60, stamp: 'postage-2' }))
      expect(await (await fn('setPostageSettings'))({ params: { standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60 }, user })).toStrictEqual({ standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60, stamp: 'postage-2' })
    })

    // W54a (W49 + W54 review S1; the lead's call: one step G rule): an edit that writes a whole row carries the stamp
    // the screen loaded, and the Worker refuses it when the row has changed since.
    describe('W54a: an edit made from a page loaded before someone else\'s change', () => {
      const CHANGED_SINCE = 'This was changed by someone else since the page loaded. The page has been reloaded: check it and save again.'
      const stamped: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
        ['updatePromoCode', { ...promo, id: STAFF_ID, active: false, stamp: 'code-1' }, { ...promo, active: false, stamp: 'code-1' }],
        ['setBandRules', { dayOfWeek: 6, rules: [{ bandId: STAFF_ID, fromTime: '00:00', toTime: '24:00' }], stamp: 'day-1' }, { rules: [{ bandId: STAFF_ID, fromTime: '00:00', toTime: '24:00' }], stamp: 'day-1' }],
        ['setMembershipBandTerm', { membershipLevel: 'core', bandId: STAFF_ID, creditEligible: false, discountPercent: 20, stamp: 'term-1' }, { membershipLevel: 'core', bandId: STAFF_ID, creditEligible: false, discountPercent: 20, stamp: 'term-1' }],
        ['setPostageSettings', { standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60, stamp: 'postage-1' }, { standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60, stamp: 'postage-1' }],
      ]

      it.each(stamped)('%s sends the stamp its screen loaded, as part of the change', async (name, params, body) => {
        rawRequest.mockResolvedValue(success({ updated: true, promo: {}, saved: true, rebandedSessions: 0, standardPrice: 0, expressPrice: 0, freeShippingThreshold: 0, stamp: 'next' }))
        await (await fn(name))({ params, user })
        expect(sent().body).toEqual(body)
        // The stamp is part of what the key covers: the same press again sends the same stamp.
        expect(JSON.parse(JSON.stringify(sent().body))).toHaveProperty('stamp')
      })

      it('a band price sends none: the press writes only the price typed', async () => {
        rawRequest.mockResolvedValue(success({ updated: true, band: { id: STAFF_ID, code: 'core', name: 'Core', price: '22.00' } }))
        await (await fn('setBandPrice'))({ params: { bandId: STAFF_ID, price: 22 }, user })
        expect(sent().body).toEqual({ price: 22 })
      })

      it('the refusal: a promo code edit answers it as data, so the page and the dialog can tell it apart and read the list again; the three Pricing saves throw the words, and the page reloads', async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', 'changed_since', CHANGED_SINCE))
        expect(await (await fn('updatePromoCode'))({ params: stamped[0]?.[1] as Record<string, unknown>, user })).toEqual({ updated: false, reason: 'changed_since', message: CHANGED_SINCE })
        for (const [name, params] of stamped.slice(1)) await expect((await fn(name))({ params, user }), name).rejects.toThrow(new Error(CHANGED_SINCE))
      })

      it("the words are the Worker's own, and each screen sends the stamp it loaded", async () => {
        const { CHANGED_SINCE_WORDS } = await import('@/server/rules/admin/stamp')
        expect(CHANGED_SINCE_WORDS).toBe(CHANGED_SINCE)
        const source = (file: string) => readFileSync(path.join(appDir, 'frontend', file), 'utf8')
        const promoPage = source('pages/PromoCodesPage.tsx')
        const promoDialog = source('components/PromoCodeDialog.tsx')
        const pricingPage = source('pages/PricingAdminPage.tsx')
        // The list's switch and the edit dialog: the stamp of the row as the list loaded it.
        expect(promoPage).toContain('stamp: row.stamp,')
        expect(promoDialog).toContain('stamp: existing!.stamp }')
        // A refused switch reads the list again; a refused dialog save closes, and the list is read again.
        const branch = (text: string, opens: string) => text.slice(text.indexOf(opens)).split('} else')[0] ?? ''
        expect(promoPage).toContain('if (!result?.updated) {')
        expect(branch(promoPage, 'if (!result?.updated) {')).toContain('trigger({}, { skipCache: true })')
        expect(promoDialog).toContain("} else if (result?.reason === 'changed_since') {")
        const refusedSave = branch(promoDialog, "if (result?.reason === 'changed_since') {")
        expect(refusedSave).toContain('onSaved()')
        expect(refusedSave).toContain('onOpenChange(false)')
        // The day's windows, a member term and postage: each its own stamp from the load.
        expect(pricingPage).toContain('const dayStamp = config?.bandRulesStamps?.[day]')
        expect(pricingPage).toContain('stamp: dayStamp,')
        expect(pricingPage).toContain('onSave(term.membership_level, term.band_id, creditEligible, Number(discount), term.stamp)')
        expect(pricingPage).toContain('setTerm({ membershipLevel: level, bandId, creditEligible, discountPercent, stamp }')
        expect(pricingPage).toContain('{ stamp: shownStamp.current }')
        // What is on screen follows a reload that finds the row changed: the day's rows, a term's row, the three boxes.
        expect(pricingPage).toContain('}, [day, dayStamp])')
        expect(pricingPage).toContain('key={`${term.id}:${term.stamp}`}')
        expect(pricingPage).toContain('if (data && data.stamp !== shownStamp.current) show(data)')
      })
    })
  })

  // Brief W50 (item 8; lead calls L4 and L11): the six booking and Overview reads and the three flags are thin calls
  // to the Worker, one function for each old one, with the old bodies gone. What each makes of the Worker's answers
  // is held here; the rules themselves in server/rules/bookings/admin.test.ts and its races.
  describe('W50: the booking and Overview functions are thin calls to the Worker', () => {
    const INACTIVE = 'This staff account is inactive. Ask an admin to reactivate it.'
    const NO_ANSWER = "That didn't get an answer, so it may or may not have been saved. The screen has been reloaded: check it, and press again if it hasn't changed."
    // W50a item 1: Wayne's words now name the button on the booking window.
    const Q49 = 'This booking needs payment first. Use Take Payment.'
    // W50a item 3: Check In while a payment is still being taken on the booking.
    const PAYMENT_OPEN = 'A payment on this booking is still going through. Check in once it has completed.'
    const ID = '22222222-2222-4222-8222-222222222222'
    const fn = async (name: string) => (await import(/* @vite-ignore */ path.join(appDir, `backend/paddock/${name}`))).default as (req: { params: Record<string, unknown>; user: typeof user }) => Promise<unknown>
    const refused = (code: string, reason: string, message: string) => ({ data: { ok: false, error: { code, message, details: { reason, message, action: 'x' } }, requestId: 'worker-request' } })
    const sent = () => rawRequest.mock.calls[0]?.[0] as { path: string; method: string; body?: unknown; queryParams?: Record<string, string>; headers: Record<string, string> }

    /** Each function with params a screen sends, the route it must call, and what it sends there. */
    const thin: Array<[string, Record<string, unknown>, string, string, { queryParams?: Record<string, string>; body?: unknown }]> = [
      ['getBookings', { startDate: '2026-11-20', endDate: '2026-11-26', status: 'cancelled' }, 'GET', '/api/v1/staff/bookings', { queryParams: { startDate: '2026-11-20', endDate: '2026-11-26', status: 'cancelled' } }],
      ['getBookingById', { bookingId: ID }, 'GET', `/api/v1/staff/bookings/${ID}`, {}],
      ['getBookingDetail', { bookingId: ID }, 'GET', `/api/v1/staff/bookings/${ID}/detail`, {}],
      ['getAddonPrepChecklistForRange', { startDate: '2026-11-20', endDate: '2026-11-20' }, 'GET', '/api/v1/staff/bookings/addon-prep', { queryParams: { startDate: '2026-11-20', endDate: '2026-11-20' } }],
      ['getWaiverGapsForRange', { startDate: '2026-11-20', endDate: '2026-11-20' }, 'GET', '/api/v1/staff/bookings/waiver-gaps', { queryParams: { startDate: '2026-11-20', endDate: '2026-11-20' } }],
      ['getPaymentAttentionItems', {}, 'GET', '/api/v1/staff/overview/payment-attention', {}],
      ['setBookingCheckedIn', { bookingId: ID, checkedIn: true }, 'POST', `/api/v1/staff/bookings/${ID}/check-in`, { body: { checkedIn: true } }],
      ['setGuestWaiverStatus', { guestId: ID, accepted: true, waiverMethod: 'in_person', waiverVersion: 'v1' }, 'POST', `/api/v1/staff/bookings/guests/${ID}/waiver`, { body: { accepted: true, waiverMethod: 'in_person', waiverVersion: 'v1' } }],
      ['setAddonLinePrepared', { lineId: ID, prepared: true }, 'POST', `/api/v1/staff/bookings/addon-lines/${ID}/prepared`, { body: { prepared: true } }],
    ]

    it.each(thin)('%s asks only the Worker, on its own route, and an inactive account is refused in the same words as before', async (name, params, method, route, sends) => {
      const query = vi.fn()
      const legacy = vi.fn()
      vi.stubGlobal('paddockData', { query })
      vi.stubGlobal('paddockBackendApi2', { rawRequest: legacy })
      rawRequest.mockResolvedValue(refusal('FORBIDDEN', INACTIVE))

      // Thrown as the words alone, as the old functions threw them: no code and no request id after them.
      await expect((await fn(name))({ params, user })).rejects.toThrow(new Error(INACTIVE))

      expect(rawRequest).toHaveBeenCalledTimes(1)
      expect(sent()).toMatchObject({ method, path: route, headers: { 'X-Staff-Email': user.email } })
      if (sends.queryParams) expect(sent().queryParams).toEqual(sends.queryParams)
      if (sends.body) expect(sent().body).toEqual(sends.body)
      // A flag goes under a key made for the call; a read has none.
      expect(typeof sent().headers['Idempotency-Key']).toBe(method === 'POST' ? 'string' : 'undefined')
      // The database and the legacy resource are never touched: the exact-case email comparison is gone with them.
      expect(legacy).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
    })

    it('none of the nine reads the database, the legacy resource or the old staff lookups any more', () => {
      for (const [name] of thin) {
        const source = readFileSync(path.join(appDir, `backend/paddock/${name}.ts`), 'utf8')
        expect(source, name).not.toMatch(/paddockData|paddockBackendApi2|resolveStaffId|requireStaffId/)
        expect(source, name).not.toMatch(/from '\.\/shared\/(staffAccess|readerPaymentOpen|bookingPaymentOpenWords)'/)
        expect(source, name).toMatch(/from '\.\/shared\/adminWorker'/)
      }
    })

    it('a sign-in with capitals is sent as it is: the Worker finds the staff row in lower case (the old functions compared exactly)', async () => {
      rawRequest.mockResolvedValue(success([]))
      await (await fn('getBookings'))({ params: {}, user: { email: 'Jo@Example.COM' } })
      expect(sent().headers['X-Staff-Email']).toBe('Jo@Example.COM')
      // No filter asked for: none sent (every booking, as before).
      expect(sent().queryParams).toEqual({})
    })

    it('the old result shapes come back unchanged from a success', async () => {
      const row = { id: ID, status: 'confirmed', price_paid: '20.00' }
      rawRequest.mockResolvedValue(success([row]))
      expect(await (await fn('getBookings'))({ params: { status: 'confirmed' }, user })).toEqual([row])
      rawRequest.mockResolvedValue(success(row))
      expect(await (await fn('getBookingById'))({ params: { bookingId: ID }, user })).toEqual(row)
      rawRequest.mockResolvedValue(success(null))
      expect(await (await fn('getBookingById'))({ params: { bookingId: ID }, user })).toBeNull()
      const detail = { guests: [], addonLines: [], specialRequests: null, refundOwedAmount: '0', readerPaymentOpenMessage: null }
      rawRequest.mockResolvedValue(success(detail))
      expect(await (await fn('getBookingDetail'))({ params: { bookingId: ID }, user })).toEqual(detail)
      rawRequest.mockResolvedValue(success({ bookings: [row], memberships: [] }))
      expect(await (await fn('getPaymentAttentionItems'))({ params: {}, user })).toEqual({ bookings: [row], memberships: [] })
      rawRequest.mockResolvedValue(success({ id: ID, checked_in_at: '2026-11-20T10:00:00.000Z' }))
      expect(await (await fn('setBookingCheckedIn'))({ params: { bookingId: ID, checkedIn: true }, user })).toEqual({ id: ID, checked_in_at: '2026-11-20T10:00:00.000Z' })
    })

    it('getBookingById with no id answers null without asking, as before', async () => {
      expect(await (await fn('getBookingById'))({ params: { bookingId: '' }, user })).toBeNull()
      expect(rawRequest).not.toHaveBeenCalled()
    })

    it('a flag pressed on a row that is not there answers null, as the old functions did; each only for its own reason', async () => {
      rawRequest.mockResolvedValue(refused('NOT_FOUND', 'booking_not_found', 'That booking no longer exists. Reload the page and try again.'))
      expect(await (await fn('setBookingCheckedIn'))({ params: { bookingId: ID, checkedIn: true }, user })).toBeNull()
      await expect((await fn('setGuestWaiverStatus'))({ params: { guestId: ID, accepted: false }, user })).rejects.toThrow(new Error('That booking no longer exists. Reload the page and try again.'))
      rawRequest.mockResolvedValue(refused('NOT_FOUND', 'guest_not_found', 'That guest is no longer on the booking. Reload the page and try again.'))
      expect(await (await fn('setGuestWaiverStatus'))({ params: { guestId: ID, accepted: false }, user })).toBeNull()
      rawRequest.mockResolvedValue(refused('NOT_FOUND', 'addon_line_not_found', 'That add-on is no longer on the booking. Reload the page and try again.'))
      expect(await (await fn('setAddonLinePrepared'))({ params: { lineId: ID, prepared: false }, user })).toBeNull()
    })

    it("a refusal is thrown in the Worker's words, exactly: Q49's, a cancelled booking's, a removed add-on's, the old waiver-method words", async () => {
      rawRequest.mockResolvedValue(refused('CONFLICT', 'payment_needed', Q49))
      await expect((await fn('setBookingCheckedIn'))({ params: { bookingId: ID, checkedIn: true }, user })).rejects.toThrow(new Error(Q49))
      // W50a item 3: a payment still going through, in the Worker's words.
      rawRequest.mockResolvedValue(refused('CONFLICT', 'payment_open', PAYMENT_OPEN))
      await expect((await fn('setBookingCheckedIn'))({ params: { bookingId: ID, checkedIn: true }, user })).rejects.toThrow(new Error(PAYMENT_OPEN))
      const cancelled ="This booking is cancelled, so its guests' waivers can no longer be changed."
      rawRequest.mockResolvedValue(refused('CONFLICT', 'booking_cancelled', cancelled))
      await expect((await fn('setGuestWaiverStatus'))({ params: { guestId: ID, accepted: true, waiverMethod: 'in_person' }, user })).rejects.toThrow(new Error(cancelled))
      const removed = "This add-on has been removed from the booking, so it can't be marked prepared or not prepared."
      rawRequest.mockResolvedValue(refused('CONFLICT', 'addon_removed', removed))
      await expect((await fn('setAddonLinePrepared'))({ params: { lineId: ID, prepared: true }, user })).rejects.toThrow(new Error(removed))
      const method = 'waiverMethod must be "email_link" or "in_person" when accepting a waiver'
      rawRequest.mockResolvedValue(refused('VALIDATION', 'invalid_waiver_method', method))
      await expect((await fn('setGuestWaiverStatus'))({ params: { guestId: ID, accepted: true }, user })).rejects.toThrow(new Error(method))
      // Accepting with no method sends none: the Worker says the old words.
      expect((rawRequest.mock.calls.at(-1)?.[0] as { body: unknown }).body).toEqual({ accepted: true })
    })

    it("a press's key is the screen's own when it sends one, and is never part of what is sent as the change", async () => {
      rawRequest.mockResolvedValue(success({ id: ID, checked_in_at: null }))
      await (await fn('setBookingCheckedIn'))({ params: { bookingId: ID, checkedIn: false, idempotencyKey: 'key-from-the-screen-1234' }, user })
      expect(sent().headers['Idempotency-Key']).toBe('key-from-the-screen-1234')
      expect(sent().body).toEqual({ checkedIn: false })
    })

    it('no answer: a flag says the change may or may not have been saved; a read keeps the "didn\'t answer" error', async () => {
      rawRequest.mockRejectedValue(new Error('socket hang up'))
      for (const [name, params] of [['setBookingCheckedIn', { bookingId: ID, checkedIn: true }], ['setGuestWaiverStatus', { guestId: ID, accepted: false }], ['setAddonLinePrepared', { lineId: ID, prepared: true }]] as const) {
        await expect((await fn(name))({ params, user }), name).rejects.toThrow(new Error(NO_ANSWER))
      }
      rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))
      await expect((await fn('setAddonLinePrepared'))({ params: { lineId: ID, prepared: true }, user })).rejects.toThrow(new Error(NO_ANSWER))
      rawRequest.mockRejectedValue(new Error('socket hang up'))
      await expect((await fn('getBookingDetail'))({ params: { bookingId: ID }, user })).rejects.toThrow(/Could not reach the Worker: socket hang up \(WORKER_UNREACHABLE, request /)
    })

    // The screens' own code, read from the staff app's checkout (it has no test runner of its own).
    describe('the screens', () => {
      const component = (name: string) => readFileSync(path.join(appDir, 'frontend/components', name), 'utf8')
      const page = (name: string) => readFileSync(path.join(appDir, 'frontend/pages', name), 'utf8')

      it("item 9: a cancelled booking shows no Check In, Mark Signed, Revoke, remove guest or prepared button, in the one booking window every screen opens", () => {
        const dialog = component('BookingDetailDialog.tsx')
        // The window is the same one for the Bookings page, BookingByIdDialog (Booking History, Money still to refund) and Overview.
        for (const opener of [page('BookingsPage.tsx'), component('BookingByIdDialog.tsx'), page('OverviewPage.tsx')]) expect(opener).toContain('<BookingDetailDialog')
        // Checked in already: the time. Cancelled: words, no button. Otherwise the button.
        expect(dialog).toMatch(/\{booking\.checked_in_at \? \([^]*?\) : booking\.status === 'cancelled' \? \([^]*?Not checked in<\/div>\s*\) : \([^]*?'Check In'\}/)
        expect(dialog.split("'Check In'")).toHaveLength(2)

        const detail = component('BookingDetailContent.tsx')
        expect(detail).toContain("const isCancelled = booking.status === 'cancelled'")
        // The guest's actions cell is empty on a cancelled booking: Revoke, Mark Signed and remove guest are all inside it.
        const actions = detail.slice(detail.indexOf('<TableCell className="px-2 py-2 align-top text-right">'), detail.indexOf('</TableBody>'))
        expect(actions).toMatch(/^<TableCell className="px-2 py-2 align-top text-right">\s*\{isCancelled \? null : \(/)
        for (const control of ['handleRevokeWaiver(g.id)', '<AcceptWaiverDialog', '<RemoveGuestDialog']) {
          expect(detail.split(control), control).toHaveLength(2)
          expect(actions, control).toContain(control)
        }
        // The prepared button: the badge alone on a cancelled booking, nothing to press.
        expect(detail).toMatch(/\{isCancelled \? \(\s*\/\/[^\n]*\n\s*line\.prepared \? <Badge variant="success">Prepared<\/Badge> : null\s*\) : line\.prepared \? \(/)
        expect(detail.split('handleTogglePrepared(line.id,')).toHaveLength(3)
      })

      it("item 9 (Q49) and W50a items 1 and 3: Check In stays on a booking that needs payment or has a payment still going through, and the press shows the Worker's words; every check-in handler shows the words it is given", () => {
        const dialog = component('BookingDetailDialog.tsx')
        // W50a item 1: Q49's words name the Take Payment button themselves, so the line that said so under Check In is
        // gone (the toast and the line would say the same thing twice).
        expect(dialog).not.toContain('Needs payment first')
        expect(dialog).not.toContain('use Take Payment below')
        // "Take Payment" is the Settle dialog's own button on the same window.
        expect(component('SettleLapsedPaymentDialog.tsx')).toContain('Take Payment')
        // W50a item 3: the button is drawn for every booking that isn't checked in or cancelled, and is only ever
        // greyed while a press is being saved: nothing about the status or an open payment hides or disables it, so
        // the press reaches the Worker and its words ("needs payment first", "still going through") are shown.
        expect(dialog).toMatch(/Not checked in<\/div>\s*\) : \(\s*(\/\/[^\n]*\n\s*)+<Button variant="outline" size="sm" disabled=\{checkingIn\} onClick=\{\(\) => void handleCheckIn\(booking\.id, true\)\}>\s*\{checkingIn \? 'Saving…' : 'Check In'\}\s*<\/Button>\s*\)\}/)
        expect(dialog).not.toMatch(/readerPaymentOpenMessage|paymentOpen/)
        const handlers: Array<[string, string]> = [['BookingsPage.tsx', page('BookingsPage.tsx')], ['OverviewPage.tsx', page('OverviewPage.tsx')], ['BookingByIdDialog.tsx', component('BookingByIdDialog.tsx')], ['MoneyOwedSection.tsx', component('MoneyOwedSection.tsx')]]
        for (const [name, source] of handlers) {
          expect(source, name).toContain("toast.error(err instanceof Error && err.message ? err.message : checkedIn ? 'Failed to check in booking' : 'Failed to undo the check-in')")
          expect(source, name).not.toContain("toast.error('Failed to check in booking')")
        }
        // The Bookings page no longer shows its own clock's time as the check-in time: it waits for the Worker's.
        const bookings = page('BookingsPage.tsx')
        expect(bookings).not.toContain('const now = new Date().toISOString()')
        expect(bookings).toContain('if (row) setRows((prev) => prev.map((b) => (b.id === bookingId ? { ...b, checked_in_at: row.checked_in_at } : b)))')
        // A waiver and the prepared tick show the Worker's words too, and read their list again.
        expect(component('AcceptWaiverDialog.tsx')).toContain("toast.error(err instanceof Error && err.message ? err.message : 'Failed to update waiver status')")
        expect(component('AcceptWaiverDialog.tsx')).toContain('onRefused?.()')
        for (const [name, source] of [['BookingsPage.tsx', bookings], ['OverviewPage.tsx', page('OverviewPage.tsx')], ['BookingDetailContent.tsx', component('BookingDetailContent.tsx')]] as const) {
          expect(source, name).toContain("toast.error(err instanceof Error && err.message ? err.message : 'Failed to update prepared status')")
        }
        expect(component('BookingDetailContent.tsx')).toContain("toast.error(err instanceof Error && err.message ? err.message : 'Failed to revoke waiver')")
      })

      // Brief W50a item 2 (W50 review L5; Wayne, 20 Nov).
      it('W50a item 2: a small Undo beside the check-in time, hidden on a cancelled booking; it calls the same route with checkedIn false, shows the Worker\'s words on a refusal and reads the booking again', async () => {
        const dialog = component('BookingDetailDialog.tsx')
        // Beside the time, in the checked-in branch; nothing on a cancelled booking; "Saving…" while it is sent.
        expect(dialog).toMatch(
          /\{booking\.checked_in_at \? \(\s*<div className="flex items-center gap-2">[^]*?\{formatDateTime\(booking\.checked_in_at\)\}\s*<\/div>\s*\{booking\.status === 'cancelled' \? null : \(\s*(\/\/[^\n]*\n\s*)+<Button variant="ghost" size="sm" className="[^"]*" disabled=\{checkingIn\} onClick=\{\(\) => void handleCheckIn\(booking\.id, false\)\}>\s*\{checkingIn \? 'Saving…' : 'Undo'\}\s*<\/Button>\s*\)\}\s*<\/div>\s*\) : booking\.status === 'cancelled' \? \(/
        )
        expect(dialog.split("'Undo'")).toHaveLength(2)
        expect(dialog.split('handleCheckIn(booking.id, false)')).toHaveLength(2)
        expect(dialog.split('handleCheckIn(booking.id, true)')).toHaveLength(2)
        // The window hands the press to the page behind it, saying which way.
        expect(dialog).toContain('onCheckIn: (bookingId: string, checkedIn: boolean) => void | Promise<void>')
        expect(dialog).toContain('await onCheckIn(bookingId, checkedIn)')

        // Each of the four pages behind the window sends what it is given (never a fixed `true` any more), shows the
        // Worker's words when refused, and reads the booking again whether it was saved or refused.
        const handlers: Array<[string, string, RegExp]> = [
          ['BookingsPage.tsx', page('BookingsPage.tsx'), /setCheckedIn\(\{ bookingId, checkedIn \}, \{ skipCache: true \}\)[^]*?refetchAfterMutation\(\)\s*\} catch \(err\) \{\s*toast\.error\([^\n]*\)\s*runCalendarQuery\(granularity, referenceDate\)\s*\}/],
          ['OverviewPage.tsx', page('OverviewPage.tsx'), /setCheckedIn\(\s*\{ bookingId, checkedIn \},\s*\{ skipCache: true \}\s*\)[^]*?\} catch \(err\) \{\s*(\/\/[^\n]*\n\s*)*toast\.error\([^\n]*\)\s*\}\s*refreshDetailAndLists\(\)/],
          ['BookingByIdDialog.tsx', component('BookingByIdDialog.tsx'), /setCheckedIn\(\{ bookingId: id, checkedIn \}, \{ skipCache: true \}\)\s*\} catch \(err\) \{\s*(\/\/[^\n]*\n\s*)*toast\.error\([^\n]*\)\s*\}\s*refresh\(\)/],
          ['MoneyOwedSection.tsx', component('MoneyOwedSection.tsx'), /setCheckedIn\(\{ bookingId: id, checkedIn \}, \{ skipCache: true \}\)\s*\} catch \(err\) \{\s*(\/\/[^\n]*\n\s*)*toast\.error\([^\n]*\)\s*\}\s*changed\(\)/],
        ]
        for (const [name, source, sendsAndReadsAgain] of handlers) {
          const handler = source.slice(source.indexOf('async function handleCheckIn('))
          expect(handler, name).toMatch(/^async function handleCheckIn\((bookingId|id): string, checkedIn: boolean\) \{/)
          expect(handler, name).toMatch(sendsAndReadsAgain)
          expect(source, name).not.toContain('checkedIn: true')
          expect(source, name).toContain('onCheckIn={handleCheckIn}')
        }
        // The pages that show the time from the answer take it away when the answer has none.
        expect(page('BookingsPage.tsx')).toContain('checked_in_at: row.checked_in_at } : b)))')
        expect(page('OverviewPage.tsx')).toContain('setSelectedBooking((prev) => (prev && prev.id === bookingId ? { ...prev, checked_in_at: row.checked_in_at } : prev))')

        // The function behind the button: the existing route, `checkedIn: false`, the Worker's answer back, and a
        // refusal (a booking cancelled since the page loaded) thrown in the Worker's own words.
        rawRequest.mockResolvedValue(success({ id: ID, checked_in_at: null }))
        expect(await (await fn('setBookingCheckedIn'))({ params: { bookingId: ID, checkedIn: false }, user })).toEqual({ id: ID, checked_in_at: null })
        expect(sent()).toMatchObject({ method: 'POST', path: `/api/v1/staff/bookings/${ID}/check-in`, body: { checkedIn: false } })
        const cancelled = "This booking is cancelled, so it can't be checked in and its check-in can't be undone."
        rawRequest.mockResolvedValue(refused('CONFLICT', 'booking_cancelled', cancelled))
        await expect((await fn('setBookingCheckedIn'))({ params: { bookingId: ID, checkedIn: false }, user })).rejects.toThrow(new Error(cancelled))
      })

      it('item 11: the add-ons picker never treats a failed read as "no add-ons": an error line with Try again, not loaded, and the three cancel dialogs show no Cancel button', () => {
        const picker = component('CancelAddonsPicker.tsx')
        expect(picker).toContain('const readFailed = Boolean(error) && !loading && detail === null')
        expect(picker).toContain('loaded: detail !== null,')
        expect(picker).toContain('failed: readFailed,')
        expect(picker).not.toContain('loaded: detail !== null || Boolean(error)')
        expect(picker).toMatch(/if \(readFailed\) \{\s*return \([^]*?\{ADDONS_READ_FAILED_MESSAGE\}[^]*?onClick=\{\(\) => trigger\(\{ bookingId \}, \{ skipCache: true \}\)\}[^]*?Try again/)
        expect(picker).toContain("couldn't be read, so it can't be cancelled from here yet")
        expect(picker).toContain('loaded: false, failed: false }')
        // The quote is asked for only once the add-ons have loaded, so a failed read asks for none and nothing can be confirmed.
        expect(component('useCancelCreditPress.ts')).toContain('if (!active || !addons.loaded) return')
        expect(component('CancelAndRefundDialog.tsx')).toContain('if (!open || !addons.loaded || result || unsure) return')
        // …and the button itself is not drawn.
        expect(component('CancelAndRefundDialog.tsx')).toMatch(/\) : addons\.failed \? null : \(\s*\/\/[^\n]*\n\s*<Button variant="destructive" onClick=\{handleSubmit\} disabled=\{!canConfirm\}>/)
        expect(component('CancelCreditBookingDialog.tsx')).toMatch(/\) : press\.addons\.failed \? null : \(\s*\/\/[^\n]*\n\s*<Button variant="destructive" onClick=\{\(\) => void handleConfirm\(\)\} disabled=\{!press\.canConfirm\}>/)
        expect(component('CancelPaymentNeededDialog.tsx')).toMatch(/\{press\.addons\.failed \? null : \(\s*<Button variant="destructive" onClick=\{\(\) => void handleConfirm\(\)\} disabled=\{!press\.canConfirm\}>/)
      })

      it('item 10: under the Cancelled filter every cancelled booking in range is on a card, under a "Cancelled" heading, and a card with only cancelled bookings never looks booked', async () => {
        const { buildDaySlotCards, buildCardsByDate, summarizeDayCards } = await import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/dayViewSlots.ts'))
        const session = (id: string, bookingType: string, start: string, end: string, more: Record<string, unknown> = {}) => ({ id, booking_type: bookingType, status: 'open', total_booked: 0, start_time: `2026-11-20T${start}:00`, end_time: `2026-11-20T${end}:00`, ...more })
        const booking = (id: string, sessionId: string, status: string) => ({ id, session_id: sessionId, status, start_time: '2026-11-20T10:00:00' })
        type Card = { session: { id: string }; bookings: Array<{ id: string }>; cancelledBookings: Array<{ id: string }>; visualState: string; occupied: boolean; cancelledListed: boolean }
        const shape = (cards: Card[]) => cards.map((card) => [card.session.id, card.visualState, card.bookings.map((b) => b.id), card.cancelledBookings.map((b) => b.id)])

        const sessions = [
          session('pub', 'public', '10:00', '11:00'),
          session('blocked', 'public', '12:00', '13:00', { status: 'blocked' }),
          session('busy', 'public', '14:00', '15:00', { total_booked: 2 }),
          session('priv', 'private', '10:00', '12:00'),
          session('priv-empty', 'private', '16:00', '18:00'),
        ]
        const cancelled = [booking('b1', 'pub', 'cancelled'), booking('b2', 'priv', 'cancelled'), booking('b3', 'blocked', 'cancelled'), booking('b4', 'busy', 'cancelled')]

        // Any other filter: cancelled bookings are on no card, as before.
        expect(shape(buildDaySlotCards(sessions, cancelled, false))).toEqual([['pub', 'empty', [], []], ['blocked', 'blocked', [], []], ['busy', 'empty', [], []]])

        // The Cancelled filter, default (public) view. Every cancelled booking is listed:
        const listed: Card[] = buildDaySlotCards(sessions, cancelled, false, true)
        expect(shape(listed)).toEqual([
          // an open session's: the card is "open" (its true places), never "booked";
          ['pub', 'empty', [], ['b1']],
          // a private session's, without the Private toggle, after the public card at the same time;
          ['priv', 'empty', [], ['b2']],
          // a blocked session's (W26a review R1): still "Blocked";
          ['blocked', 'blocked', [], ['b3']],
          // and one on a session that still has live bookings (not loaded under this filter).
          ['busy', 'empty', [], ['b4']],
        ])
        expect(listed.every((card) => card.cancelledListed)).toBe(true)
        // A private session with no cancelled booking gets no card in the public view; it claims no public slot either.
        expect(listed.some((card) => card.session.id === 'priv-empty')).toBe(false)
        // Only a session with places still booked is "occupied" (Block slot and Edit start time stay off it).
        expect(listed.map((card) => [card.session.id, card.occupied])).toEqual([['pub', false], ['priv', false], ['blocked', false], ['busy', true]])
        // With the Private toggle: the private sessions, the cancelled booking under its heading.
        expect(shape(buildDaySlotCards(sessions, cancelled, true, true))).toEqual([['priv', 'empty', [], ['b2']], ['priv-empty', 'empty', [], []]])

        // A live booking is never in the cancelled list, and still makes its card booked and occupied.
        const live: Card[] = buildDaySlotCards(sessions, [booking('b5', 'pub', 'confirmed'), booking('b1', 'pub', 'cancelled')], false)
        expect(shape(live)[0]).toEqual(['pub', 'public_booked', ['b5'], []])
        expect(live[0]?.occupied).toBe(true)
        // An active private booking still claims the public slot it spans.
        expect(shape(buildDaySlotCards(sessions, [booking('b6', 'priv', 'confirmed')], false, true)).map((card) => card[0])).toEqual(['blocked', 'busy'])

        // The Month view's number for the day is its cancelled bookings; nothing reads as booked.
        const day = buildCardsByDate(sessions, cancelled, false, true).get('2026-11-20') ?? []
        expect(summarizeDayCards(day)).toMatchObject({ totalBookings: 4, publicBookedCount: 0, privateBookedCount: 0, blockedCount: 1 })
        expect(summarizeDayCards(buildCardsByDate(sessions, cancelled).get('2026-11-20') ?? [])).toMatchObject({ totalBookings: 0 })

        // The session window: the cancelled bookings under a "Cancelled" heading whatever the card's state, each row opening its booking.
        const window = component('SessionDetailDialog.tsx')
        expect(window).toMatch(/\{cancelledBookings\.length > 0 \? \(\s*<div>\s*<div className="[^"]*">Cancelled<\/div>[^]*?\{cancelledBookings\.map\(\(b\) => \([^]*?onClick=\{\(\) => onSelectBooking\(b\)\}[^]*?<BookingStatusBadge status=\{b\.status\} \/>/)
        // The live list is still drawn only for a booked card, and no longer carries a cancelled row.
        expect(window).toContain("{visualState === 'public_booked' || visualState === 'private_booked' ? (")
        expect(window).not.toContain("b.status === 'cancelled' ? (")
        // Block slot and Edit start time follow `occupied`, not the rows that happen to be loaded.
        expect(window).toContain('{!occupied ? (')
        expect(window).not.toContain('bookings.length === 0 ? (')
        // The card itself says "Cancelled: n bookings" beside the session's own state.
        expect(component('SessionSummaryCard.tsx')).toMatch(/\{cancelledBookings\.length > 0 \? \([^]*?Cancelled: \{cancelledBookings\.length\} booking/)
        // Overview's "booked slots" still count live bookings only.
        expect(page('OverviewPage.tsx')).toContain('buildDaySlotCards(sessions, bookings, false)')
      })
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
    const screen = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/cashConfirmation'))
    const backend = (name: string) => import(/* @vite-ignore */ path.join(appDir, `backend/paddock/${name}`))

    // Brief W24a: the rule's own tests (cashDifferenceRefusal in backend/paddock/shared/cashConfirmation.ts) went with
    // that file. The rule is the Worker's now (server/rules/orders/amounts.ts), tested through the actions that use it
    // (place-order.test.ts, settle.test.ts, add-guest.test.ts, move.test.ts).

    describe('pennies', () => {
      // Brief W24a: the staff app's backend copy of these two sums is deleted; the screen's copy stays.

      it.each([
        ['nothing left', [1, 0.95, 0.05], 0],
        ['nothing left, with noise above nothing', [6.95, 6.85, 0.1], 0],
        ['a real remainder', [10, 3], 7],
        ['one penny', [0.01], 0.01],
        ['more credit than due', [5, 10], 0],
      ])('amountLeftToPay: %s', async (_label, [due, ...parts], left) => {
        expect((await screen()).amountLeftToPay(due, ...parts)).toBe(left)
      })

      it.each([
        ['adding up noise', 6.95 - 2.9 + 2.9, 6.95, false],
        ['the same amount', 6.95, 6.95, false],
        ['one penny more', 6.96, 6.95, true],
        ['one penny less', 6.94, 6.95, false],
      ])('exceedsAmount: %s', async (_label, parts, amount, exceeds) => {
        expect((await screen()).exceedsAmount(parts, amount)).toBe(exceeds)
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
    describe('order refunds (W28: thin calls to the Worker)', () => {
      const ORDER = '22222222-2222-4222-8222-222222222222'
      const LINE = '33333333-3333-4333-8333-333333333333'
      const figures = {
        orderId: ORDER,
        paymentStatus: 'paid',
        lines: [{ lineItemId: LINE, itemType: 'product', lineTotal: 15, discount: 1.5, cardRefunded: 0, refundable: 13.5, refunded: false, blocked: null }],
        cardLeft: 13.5,
        cashLeft: 0,
        refundOwed: 0,
        blocked: null,
      }
      const refused = (code: string, details: Record<string, unknown>) => ({
        data: { ok: false, error: { code, message: String(details['message']), details: { action: 'refund', ...details } }, requestId: 'worker-request' },
      })
      const refund = async (params: Record<string, unknown> = {}) => {
        const query = vi.fn()
        const legacy = vi.fn()
        vi.stubGlobal('paddockData', { query })
        vi.stubGlobal('paddockBackendApi2', { rawRequest: legacy })
        const fn = (await backend('refundOrder')).default
        const result = await fn({ params: { orderId: ORDER, lineItemIds: [LINE], refundMethod: 'card', restock: { [LINE]: true }, confirmed: { amount: 13.5 }, idempotencyKey: 'press-key-0000000001', ...params }, user })
        // Never the database, never a legacy route: the Worker holds every rule.
        expect(query).not.toHaveBeenCalled()
        expect(legacy).not.toHaveBeenCalled()
        return result
      }

      it('refundOrder: sends the lines, the method, the restock choices, the confirmed amount and the press key to the route, and answers in the old shape', async () => {
        rawRequest.mockResolvedValue(success({ refundedAmount: 13.5, refundMethod: 'card', cardRefundedAmount: 10, storeCreditRefundedAmount: 3.5, storeCreditBalance: 33.5, orderPaymentStatus: 'partially_refunded' }))
        expect(await refund()).toEqual({ success: true, refundedAmount: 13.5, refundMethod: 'card', cardRefundedAmount: 10, storeCreditRefundedAmount: 3.5, storeCreditBalance: 33.5, orderPaymentStatus: 'partially_refunded' })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({
          path: `/api/v1/staff/orders/${ORDER}/refunds`,
          method: 'POST',
          body: { lineItemIds: [LINE], refundMethod: 'card', restock: { [LINE]: true }, confirmed: { amount: 13.5 } },
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000001', 'X-Staff-Email': user.email }),
        })
      })

      it('cash (Q42) and money left owed (Q39) come back as the dialog reads them, with a warning', async () => {
        rawRequest.mockResolvedValue(success({ refundedAmount: 24, refundMethod: 'cash', cashRefundedAmount: 14, storeCreditRefundedAmount: 10, storeCreditBalance: 40, orderPaymentStatus: 'refunded', warning: 'w' }))
        expect(await refund({ refundMethod: 'cash' })).toEqual({ success: true, refundedAmount: 24, refundMethod: 'cash', cashRefundedAmount: 14, storeCreditRefundedAmount: 10, storeCreditBalance: 40, orderPaymentStatus: 'refunded', warning: 'w' })
      })

      it("W29: a membership's refund comes back with the bookings it flagged (Q41) and, when the cancel is left, the Worker's warning (E10); a refused card refund that stands keeps both sets of words", async () => {
        const left = "The refund is done, but the membership's subscription (sub_1) couldn't be confirmed cancelled in Stripe yet, so it could still take its next payment. The automatic check tries again every 5 minutes, and it shows on the Orders page until it is cancelled. Don't refund it again."
        rawRequest.mockResolvedValue(success({ refundedAmount: 40, refundMethod: 'card', cardRefundedAmount: 40, orderPaymentStatus: 'refunded', bookingsFlagged: 2, warning: left, subscriptionCancelLeft: ['sub_1'] }))
        expect(await refund({ confirmed: { amount: 40 } })).toEqual({ success: true, refundedAmount: 40, refundMethod: 'card', cardRefundedAmount: 40, orderPaymentStatus: 'refunded', bookingsFlagged: 2, warning: left })
        // No bookings flagged: the field isn't sent.
        rawRequest.mockResolvedValue(success({ refundedAmount: 40, refundMethod: 'credit', storeCreditRefundedAmount: 40, storeCreditBalance: 70, orderPaymentStatus: 'refunded' }))
        expect(await refund({ refundMethod: 'credit', confirmed: { amount: 40 } })).toEqual({ success: true, refundedAmount: 40, refundMethod: 'credit', storeCreditRefundedAmount: 40, storeCreditBalance: 70, orderPaymentStatus: 'refunded' })
        // The card refund refused and not put back (money owed), and the cancel left as well: both, the refusal's first.
        rawRequest.mockResolvedValue(success({ refundedAmount: 40, refundMethod: 'card', refundOwed: 40, held: { claimId: 'c', reason: 'refund_refused_not_put_back', message: 'Refused words.' }, warning: left, subscriptionCancelLeft: ['sub_1'] }))
        // W47 (the W35 audit's F4), a named difference: the wrapper also says this press's own card refund was refused
        // (`cardRefundRefused`), which is what the dialog's heading now reads.
        expect(await refund({ confirmed: { amount: 40 } })).toEqual({ success: true, refundedAmount: 40, refundMethod: 'card', refundOwed: 40, cardRefundRefused: true, warning: `Refused words. ${left}` })
        // Q40's two refusals come back as any other, with the Worker's words.
        const { MEMBERSHIP_REFUND_WORDS } = await import('@/server/rules/refunds/failure-messages')
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'membership_refund_alone', message: MEMBERSHIP_REFUND_WORDS.refundAlone }))
        expect(await refund()).toEqual({ success: false, reason: 'membership_refund_alone', message: MEMBERSHIP_REFUND_WORDS.refundAlone })
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'membership_payment_not_recorded', message: MEMBERSHIP_REFUND_WORDS.paymentNotRecorded }))
        expect(await refund()).toEqual({ success: false, reason: 'membership_payment_not_recorded', message: MEMBERSHIP_REFUND_WORDS.paymentNotRecorded })
      })

      it("W29, the dialog: a membership line says how much of it was used before the press (Q41, the Worker's words), and one paid by its own card payment goes back to that payment on its own (Q40)", async () => {
        const dialog = readFileSync(path.join(appDir, 'frontend/components/RefundOrderDialog.tsx'), 'utf8')
        const { MEMBERSHIP_REFUND_WORDS, membershipUsedWords } = await import('@/server/rules/refunds/failure-messages')
        // Q41: the dialog's copy of the words is the Worker's, held to it by running both on the same counts.
        const copy = /function membershipUsedWords\(creditSessionsTaken: number, futureCreditBookings: number\): string \| null \{\n([\s\S]*?)\n\}\n/.exec(dialog)?.[1]
        expect(copy).toBeDefined()
        // The same statements, with the types taken off, as plain JavaScript.
        const run = new Function('creditSessionsTaken', 'futureCreditBookings', String(copy).replace('const parts: string[] = []', 'const parts = []')) as (taken: number, future: number) => string | null
        for (const [taken, future] of [[0, 0], [1, 0], [0, 1], [1, 1], [4, 2], [2, 5]] as const) expect(run(taken, future)).toBe(membershipUsedWords(taken, future))
        expect(membershipUsedWords(4, 2)).toBe('4 credit sessions already taken; 2 future credit bookings will need payment.')
        expect(membershipUsedWords(0, 0)).toBeNull()
        // Shown under the line, from the Worker's two counts, before the press.
        expect(dialog).toContain('{membershipUsedWords(line.membership.creditSessionsTaken, line.membership.futureCreditBookings)}')
        // Q40: the card money for the chosen lines: the membership's own payment when it is chosen alone; nothing to a card when it is chosen with other lines.
        expect(dialog).toContain("const own = chosen.find((line) => line.ownCardLeft !== undefined)")
        expect(dialog).toContain('if (!own) return { left: figures.cardLeft, mixed: false }')
        expect(dialog).toContain('return chosen.length === 1 ? { left: own.ownCardLeft ?? 0, mixed: false } : { left: 0, mixed: true }')
        expect(dialog).toContain("const cardPart = figures && refundMethod === 'card' ? round2(Math.min(total, card.left)) : 0")
        expect(dialog).toContain('<RadioGroupItem value="card" id="refund-card" disabled={card.left <= 0} />')
        // The default method never lands on a card that can't take it.
        expect(dialog).toContain("const cardLeft = cardFor(next, new Set(lineItems.map((l) => l.id))).left")
        expect(dialog).toContain("setRefundMethod(method === 'card' && cardLeft > 0 ? 'card' : method === 'cash' && next.cashLeft > 0 ? 'cash' : 'credit')")
        expect(dialog).toContain(`const MEMBERSHIP_REFUND_ALONE =\n  ${JSON.stringify(MEMBERSHIP_REFUND_WORDS.refundAlone).replace(/^"|"$/g, "'")}`)
        expect(dialog).toContain('{card.mixed ? <div className="text-xs text-muted-foreground">{MEMBERSHIP_REFUND_ALONE}</div> : null}')
        // After the press: how many bookings now need payment.
        expect(dialog).toContain("{successResult.bookingsFlagged} future credit {successResult.bookingsFlagged === 1 ? 'booking now needs' : 'bookings now need'} payment.")
        expect(dialog).toContain('bookingsFlagged: result.bookingsFlagged,')
      })

      it('a refusal: `success: false` with the old reason and words; `order_not_found` with no words, as the old function', async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'already_refunded', message: `Already refunded: ${LINE}` }))
        expect(await refund()).toEqual({ success: false, reason: 'already_refunded', message: `Already refunded: ${LINE}` })
        rawRequest.mockResolvedValue(refused('NOT_FOUND', { reason: 'order_not_found', message: 'Refund failed (order_not_found).' }))
        expect(await refund()).toEqual({ success: false, reason: 'order_not_found' })
      })

      it('figures that no longer fit (Q18): the refusal carries the Worker\'s new figures for the dialog to show', async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'figures_changed', message: 'The figures on this order have just changed. Check them and confirm again.', figures }))
        expect(await refund({ confirmed: { amount: 15 } })).toEqual({ success: false, reason: 'figures_changed', message: 'The figures on this order have just changed. Check them and confirm again.', figures })
      })

      it('review L2: REFUND_PATH_OFF (order refunds switched off on the Worker) is `refund_path_off` with the switched-off words, not a generic failure', async () => {
        const words = 'This is switched off in the booking system. Tell a manager.'
        rawRequest.mockResolvedValue({ data: { ok: false, error: { code: 'REFUND_PATH_OFF', message: words, details: { reason: 'refund_path_off', message: words, kinds: ['order_refunds'] } }, requestId: 'worker-request' } })
        expect(await refund()).toEqual({ success: false, reason: 'refund_path_off', message: words })
        // Even if the details were lost on the way, the code alone maps to the same answer.
        rawRequest.mockResolvedValue(refusal('REFUND_PATH_OFF', words))
        expect(await refund()).toEqual({ success: false, reason: 'refund_path_off', message: words })
      })

      it.each([
        ['no Issue refunds', 'FORBIDDEN', 'Needs Issue refunds permission — this action moves money back to the customer.'],
        ['no staff record', 'UNAUTHORISED', "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."],
      ])('%s: the old `permission_denied`, with the Worker\'s words', async (_label, code, words) => {
        rawRequest.mockResolvedValue(refusal(code, words))
        expect(await refund()).toEqual({ success: false, reason: 'permission_denied', message: words })
      })

      it('a refund held for reconcile: the old `refund_unsure`, with the Worker\'s words and `held`, which end the dialog', async () => {
        const words = "The refund didn't get a clear answer, so it may or may not have gone. Don't refund it again. Check the Orders page in a few minutes."
        rawRequest.mockResolvedValue(success({ refundedAmount: 0, refundMethod: 'card', held: { claimId: 'c', reason: 'refund_unconfirmed', message: words } }))
        expect(await refund()).toEqual({ success: false, reason: 'refund_unsure', message: words, held: true })
      })

      it('a refused card refund that could not be undone: the refund stands, so a success with the money owed and the Worker\'s words as the warning', async () => {
        const words = "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card…"
        rawRequest.mockResolvedValue(success({ refundedAmount: 24, refundMethod: 'card', orderPaymentStatus: 'refunded', refundOwed: 24, held: { claimId: 'c', reason: 'refund_refused_not_put_back', message: words } }))
        // W47 (F4), a named difference: `cardRefundRefused`, from the Worker's `held`.
        expect(await refund()).toEqual({ success: true, refundedAmount: 24, refundMethod: 'card', orderPaymentStatus: 'refunded', refundOwed: 24, cardRefundRefused: true, warning: words })
      })

      it.each([
        ['no connection', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
        ['an earlier press still running', () => rawRequest.mockResolvedValue(refusal('CONFLICT', 'This request is already being processed'))],
        ['a fault', () => rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
      ])('E11, %s: `no_answer` with `noAnswer`, so the dialog keeps its key and the next press gets the first one\'s answer', async (_label, arrange) => {
        arrange()
        const { ORDER_REFUND_NO_ANSWER_MESSAGE } = await load('orderRefundWorker')
        expect(await refund()).toEqual({ success: false, reason: 'no_answer', message: ORDER_REFUND_NO_ANSWER_MESSAGE, noAnswer: true })
      })

      it("a changed press under a no-answer press's key: refused as `pressed_after_no_answer`, never sent as new", async () => {
        rawRequest.mockResolvedValue(refusal('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
        const { ORDER_REFUND_PRESSED_AFTER_NO_ANSWER_MESSAGE } = await load('orderRefundWorker')
        expect(await refund()).toEqual({ success: false, reason: 'pressed_after_no_answer', message: ORDER_REFUND_PRESSED_AFTER_NO_ANSWER_MESSAGE, noAnswer: true })
      })

      it('getOrderRefundFigures: a read of the figures route, and plain words for a missing order', async () => {
        const fn = (await backend('getOrderRefundFigures')).default
        rawRequest.mockResolvedValue(success(figures))
        expect(await fn({ params: { orderId: ORDER }, user })).toEqual(figures)
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/orders/${ORDER}/refund-figures`, method: 'GET' })
        rawRequest.mockResolvedValue(refusal('NOT_FOUND', 'Refund failed (order_not_found).'))
        await expect(fn({ params: { orderId: ORDER }, user })).rejects.toThrow(new Error('Order not found.'))
      })

      it('the Refund Line Items dialog: the Worker\'s figures sent back as confirmed (E1, Q18), a press key kept after no answer, closing blocked mid-call, the order read again on close (E11), cash only when offered (Q42)', () => {
        const dialog = readFileSync(path.join(appDir, 'frontend/components/RefundOrderDialog.tsx'), 'utf8')
        // E1: the total is the Worker's (each line's `refundable`), never the lines' bare totals.
        expect(dialog).toContain('useGetOrderRefundFigures')
        expect(dialog).toContain('chosen.reduce((sum, line) => sum + line.refundable, 0)')
        expect(dialog).not.toContain('Number.parseFloat(l.line_total)')
        expect(dialog).toContain('confirmed: { amount: total }')
        // E11: one key per press, kept after no answer or a throw until the dialog closes.
        expect(dialog).toContain('pressKey.current ??= crypto.randomUUID()')
        expect(dialog).toContain('idempotencyKey: pressKey.current')
        expect(dialog).toMatch(/if \(result\.noAnswer\) \{[\s\S]*?reloadOnClose\.current = true\s+return\s+\}\s+\/\/ Any answer: the next press is a new one\.\s+pressKey\.current = null/)
        expect(dialog).toMatch(/\} catch \(err\) \{[\s\S]*?reloadOnClose\.current = true\s+\} finally/)
        // Closing is blocked while a press runs, and a press that may have gone through reads the order again on close.
        expect(dialog).toContain('if (submitting || inFlight.current) return')
        expect(dialog).toMatch(/if \(reloadOnClose\.current\) \{\s+reloadOnClose\.current = false\s+onRefunded\(\)/)
        // A held refund ends the dialog: no Confirm button to press again.
        expect(dialog).toContain('{successResult || heldMessage ? (')
        // Q42: cash is offered only while cash paid on the order is left; the split is shown before the press.
        expect(dialog).toContain('{figures.cashLeft > 0 ? (')
        expect(dialog).toContain('to the card${creditPart > 0 ? `, ${money(creditPart)} to store credit` : \'\'}.')
        expect(dialog).toContain('The cash is recorded as handed over by you.')
        // The old dialog's own words stay (the Worker's word list is held to them).
        for (const words of ['Choose whether to restock every product line item selected.', 'No response from the refund endpoint.', "`Refund failed (${result.reason ?? 'unknown reason'}).`", 'Failed to refund order.']) expect(dialog).toContain(words)
      })

      it('review S2 (W28a): a refund whose card part was refused and not put back opens in the warning style with its own first line, never "Refund processed successfully."; the owed bar\'s heading fits Refund the rest', () => {
        const dialog = readFileSync(path.join(appDir, 'frontend/components/RefundOrderDialog.tsx'), 'utf8')
        const bar = readFileSync(path.join(appDir, 'frontend/components/OrderOwedBar.tsx'), 'utf8')
        // The case: this press's own card refund refused and not put back. W47 (the W35 audit's F4), a named
        // difference: read from the wrapper's `cardRefundRefused` (the Worker's `held`). It was "a warning and money
        // still to refund on the order", which is also true of a refund that went through with a warning on an order
        // that already had money owed from an earlier one.
        expect(dialog).toContain('const cardNotGone = successResult?.cardRefundRefused === true')
        expect(dialog).toContain('...(result.cardRefundRefused ? { cardRefundRefused: true } : {}),')
        expect(dialog).not.toContain('(successResult.refundOwed ?? 0) > 0')
        // Its first line replaces the success line, in the warning style with the warning icon.
        expect(dialog).toContain('{cardNotGone ? <div className="font-medium">The lines are refunded, but the card refund didn\'t go through.</div> : <div>Refund processed successfully.</div>}')
        expect(dialog).toContain("${cardNotGone ? 'border-warning/30 bg-warning/10' : 'border-success/30 bg-success/10'}")
        expect(dialog).toContain('{cardNotGone ? <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-success" />}')
        // The success line is nowhere else on the screen (the other mention is the comment above `cardNotGone`).
        expect(dialog.match(/<div>Refund processed successfully\.<\/div>/g)).toHaveLength(1)
        // The toast doesn't call it processed either.
        // W47 (F4), named differences: both from the press's own answer.
        expect(dialog).toContain('if (result.cardRefundRefused) toast.warning("The card refund didn\'t go through — see details")')
        expect(bar).toContain('if (response?.cardRefundRefused) toast.warning("The card refund didn\'t go through — see details")')
        expect(bar).toContain('...(response?.cardRefundRefused ? { cardRefused: true } : {}),')
        // The owed bar: Refund the rest's refused card refund says what happened; the Worker's words say what to do.
        expect(bar).not.toContain('This needs a manual check')
        // W47 (F4), a named difference: `result.cardRefused`, not what is owed on the order afterwards.
        expect(bar).toContain('<div className="font-medium">{result.cardRefused ? "The card refund didn\'t go through" : \'Refunded, with a warning\'}</div>')
        expect(bar).not.toContain('result.owedAfter > 0 ? "The card refund')
      })

      it('the Orders page: the owed bar with Refund the rest and It already arrived (Issue refunds), and no refund ticks on an order that isn\'t paid (E2)', () => {
        const page = readFileSync(path.join(appDir, 'frontend/pages/OrdersPage.tsx'), 'utf8')
        const bar = readFileSync(path.join(appDir, 'frontend/components/OrderOwedBar.tsx'), 'utf8')
        const table = readFileSync(path.join(appDir, 'frontend/components/OrderLineItemsTable.tsx'), 'utf8')
        expect(page).toContain("const refundOwed = Number.parseFloat(order.refund_owed_amount ?? '0') || 0")
        // W47, a named difference: after a press on the bar the "Money still to refund" section is read again too
        // (`owedMayHaveChanged`); it was the orders' own list alone.
        expect(page).toContain('{refundOwed > 0 ? <OrderOwedBar orderId={order.id} owed={refundOwed} onChanged={owedMayHaveChanged} /> : null}')
        expect(page).toContain('const owedMayHaveChanged = () => {\n    setOwedToken((token) => token + 1)\n    runQuery(view, { skipCache: true })\n  }')
        expect(page).toContain('still to refund')
        // Both buttons need Issue refunds (the Worker checks it again).
        expect(bar.match(/disabled=\{!canIssueRefunds\}/g)).toHaveLength(2)
        expect(bar).toContain('It already arrived')
        expect(bar).toContain('Refund the rest')
        // Refund the rest sends exactly what is owed; It already arrived any amount up to it, with a reason.
        expect(bar).toContain('refundOrderOwed({ orderId, amount: figures.refundOwed, refundMethod, idempotencyKey: pressKey.current }')
        // W47 item 8 (Wayne, 19 Nov), a named difference: It already arrived also sends where staff saw the money.
        expect(bar).toContain('refundOrderOwed({ orderId, amount, arrived: true, reason: reason.trim(), arrivedOn, idempotencyKey: pressKey.current }')
        expect(bar).toContain('arrived > 0 && arrived <= owed + 0.005')
        expect(bar).toContain('pressKey.current ??= crypto.randomUUID()')
        // Closing is blocked mid-call.
        expect(bar).toContain('onOpenChange={(next) => (submitting ? undefined : next ? setOpen(true) : resetAndClose())}')
        // E2: lines can be ticked only on a paid or part refunded order.
        expect(table).toContain("const orderRefundable = paymentStatus === 'paid' || paymentStatus === 'partially_refunded'")
        expect(table).toContain("return orderRefundable && line.item_type !== 'booking' && line.item_type !== 'event' && !line.refunded_at")
      })

      it("the booking's It already arrived takes a part amount too (the W26 audit's row 31)", () => {
        const rest = readFileSync(path.join(appDir, 'frontend/components/RefundTheRestDialog.tsx'), 'utf8')
        expect(rest).toContain('amount: Math.round(arrived * 100) / 100, owedArrived: true')
        expect(rest).toContain('arrived > 0 && arrived <= owed + 0.005')
        expect(rest).toContain('id="refund-rest-arrived-amount"')
        // Refund the rest still sends exactly what is owed.
        expect(rest).toContain('{ bookingId, refundMethod, amount: figures.refundOwed, refundOwed: true, idempotencyKey: pressKey.current }')
      })

      describe('refundOrderOwed: Refund the rest and It already arrived on an order (Q39)', () => {
        const owed = async (params: Record<string, unknown>) => {
          const query = vi.fn()
          vi.stubGlobal('paddockData', { query })
          const fn = (await backend('refundOrderOwed')).default
          const result = await fn({ params: { orderId: ORDER, idempotencyKey: 'press-key-0000000002', ...params }, user })
          expect(query).not.toHaveBeenCalled()
          return result
        }

        it.each([
          ['Refund the rest', { amount: 24, refundMethod: 'card' }, 'refunds/owed', { amount: 24, refundMethod: 'card' }],
          ['It already arrived (part of what is owed)', { amount: 10, arrived: true, reason: 'Seen in Stripe' }, 'refunds/owed-arrived', { amount: 10, reason: 'Seen in Stripe' }],
        ])('%s: sends the amount and the press key to its route and answers its data', async (_label, params, suffix, body) => {
          rawRequest.mockResolvedValue(success({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 14 }))
          expect(await owed(params)).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 14 })
          expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/orders/${ORDER}/${suffix}`, method: 'POST', body, headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000002' }) })
        })

        it('an amount that is no longer what is owed: `refused` with the new figures; any other refusal: `failed`; the switch: `refund_path_off`', async () => {
          rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'owed_changed', message: 'The amount owed has changed to £14.00. Check it and confirm again.', figures }))
          expect(await owed({ amount: 24, refundMethod: 'credit' })).toEqual({ refused: { message: 'The amount owed has changed to £14.00. Check it and confirm again.', figures } })
          rawRequest.mockResolvedValue(refused('PAYMENT_FAILED', { reason: 'refund_failed', message: 'The card refund failed, so nothing was refunded: Failed to refund payment: Your card was declined.' }))
          expect(await owed({ amount: 24, refundMethod: 'card' })).toEqual({ failed: { reason: 'refund_failed', message: 'The card refund failed, so nothing was refunded: Failed to refund payment: Your card was declined.' } })
          rawRequest.mockResolvedValue(refusal('REFUND_PATH_OFF', 'This is switched off in the booking system. Tell a manager.'))
          expect(await owed({ amount: 24, refundMethod: 'card' })).toEqual({ failed: { reason: 'refund_path_off', message: 'This is switched off in the booking system. Tell a manager.' } })
        })

        it('held: `unsure`; no answer: `noAnswer` (the key kept); a changed press under that key: `pressedAfterNoAnswer`', async () => {
          rawRequest.mockResolvedValue(success({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 0, held: { claimId: 'c', reason: 'refund_unconfirmed', message: 'held words' } }))
          expect(await owed({ amount: 24, refundMethod: 'card' })).toEqual({ unsure: { message: 'held words' } })
          const { ORDER_REFUND_NO_ANSWER_MESSAGE, ORDER_REFUND_PRESSED_AFTER_NO_ANSWER_MESSAGE } = await load('orderRefundWorker')
          rawRequest.mockRejectedValue(new Error('socket hang up'))
          expect(await owed({ amount: 24, refundMethod: 'card' })).toEqual({ noAnswer: { message: ORDER_REFUND_NO_ANSWER_MESSAGE } })
          rawRequest.mockReset()
          rawRequest.mockResolvedValue(refusal('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
          expect(await owed({ amount: 24, refundMethod: 'credit' })).toEqual({ pressedAfterNoAnswer: { message: ORDER_REFUND_PRESSED_AFTER_NO_ANSWER_MESSAGE } })
        })
      })
    })

    // Brief W30: cancelEventPlaces and getEventCancellationQuote are thin calls to the Worker. Its rules are tested
    // there (server/rules/events/cancel-places.test.ts); here, the wrappers and the screens: what they send, and the
    // answers the dialog and the attendee list read.
    describe('event places (W30: thin calls to the Worker)', () => {
      const BOOKING = '44444444-4444-4444-8444-444444444444'
      const PLACE = '55555555-5555-4555-8555-555555555555'
      const quote = { places: 1, wholeBooking: false, value: 40, refundCutoffAt: '2026-11-30T19:00:00+00:00', beforeCutoff: true, eventStarted: false, cardAmount: 40, storeCreditAmount: 0, cashAmount: 0, refundOwed: 0 }
      const booking = { id: BOOKING, status: 'confirmed', places: 1, order_id: '22222222-2222-4222-8222-222222222222', refund_owed_amount: '0.00', attendees: [] }
      const refused = (code: string, details: Record<string, unknown>) => ({
        data: { ok: false, error: { code, message: String(details['message']), details: { action: 'cancel_places', ...details } }, requestId: 'worker-request' },
      })
      const cancel = async (params: Record<string, unknown> = {}) => {
        const query = vi.fn()
        const legacy = vi.fn()
        vi.stubGlobal('paddockData', { query })
        vi.stubGlobal('paddockBackendApi2', { rawRequest: legacy })
        const fn = (await backend('cancelEventPlaces')).default
        const result = await fn({ params: { eventBookingId: BOOKING, attendeeIds: [PLACE], refund: 'card', confirmed: { refund: 40 }, idempotencyKey: 'press-key-0000000001', ...params }, user })
        // Never the database, never a legacy route: the Worker holds every rule.
        expect(query).not.toHaveBeenCalled()
        expect(legacy).not.toHaveBeenCalled()
        return result
      }

      it('cancelEventPlaces: sends the places, the refund choice, the reason, the confirmed refund and the press key to the route, and answers in the old shape', async () => {
        rawRequest.mockResolvedValue(success({ places: 1, refundedAmount: 40, cardRefundedAmount: 40, storeCreditRefundedAmount: 0, booking, eventPlacesBooked: 1 }))
        expect(await cancel({ reason: 'Train strike' })).toEqual({ ok: true, places: 1, refundedAmount: 40, cardRefundedAmount: 40, storeCreditRefundedAmount: 0, booking, eventPlacesBooked: 1 })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({
          path: `/api/v1/staff/event-bookings/${BOOKING}/cancel`,
          method: 'POST',
          body: { attendeeIds: [PLACE], refund: 'card', reason: 'Train strike', confirmed: { refund: 40 } },
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000001', 'X-Staff-Email': user.email }),
        })
        // The whole booking: no places are sent, and no reason goes as null.
        rawRequest.mockClear()
        rawRequest.mockResolvedValue(success({ places: 2, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, booking: null }))
        expect(await cancel({ attendeeIds: undefined, refund: 'none', confirmed: { refund: 0 } })).toEqual({ ok: true, places: 2, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, booking: null })
        expect((rawRequest.mock.calls[0]?.[0] as { body: unknown }).body).toEqual({ refund: 'none', reason: null, confirmed: { refund: 0 } })
      })

      it('cash (Q42), the store credit balance and a warning come back as the dialog reads them', async () => {
        rawRequest.mockResolvedValue(success({ places: 2, refundedAmount: 80, cardRefundedAmount: 0, storeCreditRefundedAmount: 40, cashRefundedAmount: 40, storeCreditBalance: 70, booking, eventPlacesBooked: 0, warning: 'w' }))
        expect(await cancel({ refund: 'cash', confirmed: { refund: 80 } })).toEqual({ ok: true, places: 2, refundedAmount: 80, cardRefundedAmount: 0, storeCreditRefundedAmount: 40, cashRefundedAmount: 40, storeCreditBalance: 70, booking, eventPlacesBooked: 0, warning: 'w' })
      })

      it('no booking chosen: the old words, and the Worker is never called (the route is the booking\'s)', async () => {
        expect(await cancel({ eventBookingId: '' })).toEqual({ ok: false, reason: 'invalid_params', message: 'Choose a booking.' })
        expect(rawRequest).not.toHaveBeenCalled()
      })

      it('a refusal: `ok: false` with the old reason and words', async () => {
        const { EVENT_CANCEL_WORDS, EVENT_QUOTE_REFUSALS } = await import('@/server/rules/events/failure-messages')
        rawRequest.mockResolvedValue(refused('VALIDATION', { reason: 'reason_required_after_cutoff', message: EVENT_CANCEL_WORDS.reasonRequiredAfterCutoff }))
        expect(await cancel()).toEqual({ ok: false, reason: 'reason_required_after_cutoff', message: EVENT_CANCEL_WORDS.reasonRequiredAfterCutoff })
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'attendee_checked_in', message: EVENT_QUOTE_REFUSALS['attendee_checked_in']?.message }))
        expect(await cancel()).toEqual({ ok: false, reason: 'attendee_checked_in', message: 'A place you chose is checked in. Undo check-in first.' })
        rawRequest.mockResolvedValue(refused('PAYMENT_FAILED', { reason: 'refund_failed', message: EVENT_CANCEL_WORDS.cardRefundFailed('Failed to refund payment: Your card was declined.') }))
        expect(await cancel()).toEqual({ ok: false, reason: 'refund_failed', message: 'The card refund failed, so nothing was cancelled: Failed to refund payment: Your card was declined.' })
      })

      it('a refund that no longer fits what staff confirmed (Q18, bug E9): the refusal carries the Worker\'s quote as it now stands, for the dialog to show', async () => {
        const { EVENT_CANCEL_NEW_WORDS } = await import('@/server/rules/events/failure-messages')
        const now = { ...quote, places: 2, wholeBooking: true, value: 76.66, cardAmount: 76.66 }
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'figures_changed', message: EVENT_CANCEL_NEW_WORDS.figuresChanged, quote: now }))
        expect(await cancel({ attendeeIds: undefined, confirmed: { refund: 115 } })).toEqual({ ok: false, reason: 'figures_changed', message: 'The figures on this event booking have just changed. Check them and confirm again.', quote: now })
      })

      it('REFUND_PATH_OFF (event cancels with money back switched off on the Worker) is `refund_path_off` with the switched-off words, not a generic failure', async () => {
        const words = 'This is switched off in the booking system. Tell a manager.'
        rawRequest.mockResolvedValue({ data: { ok: false, error: { code: 'REFUND_PATH_OFF', message: words, details: { reason: 'refund_path_off', message: words, kinds: ['event_cancels'] } }, requestId: 'worker-request' } })
        expect(await cancel()).toEqual({ ok: false, reason: 'refund_path_off', message: words })
        // Even if the details were lost on the way, the code alone maps to the same answer.
        rawRequest.mockResolvedValue(refusal('REFUND_PATH_OFF', words))
        expect(await cancel()).toEqual({ ok: false, reason: 'refund_path_off', message: words })
      })

      it.each([
        ['no Issue refunds', 'FORBIDDEN', 'Needs Issue refunds permission — this action moves money back to the customer.'],
        ['no staff record (bug E12)', 'UNAUTHORISED', "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."],
        ['an inactive account', 'FORBIDDEN', 'This staff account is inactive. Ask an admin to reactivate it.'],
      ])('%s: `permission_denied` as data, with the Worker\'s words (the old function threw them)', async (_label, code, words) => {
        rawRequest.mockResolvedValue(refusal(code, words))
        expect(await cancel()).toEqual({ ok: false, reason: 'permission_denied', message: words })
      })

      it('a refund held for reconcile: the places are cancelled, so `ok: true` with the booking, the Worker\'s words as the warning and `held`', async () => {
        const { EVENT_CANCEL_NEW_WORDS } = await import('@/server/rules/events/failure-messages')
        rawRequest.mockResolvedValue(success({ places: 1, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, booking, eventPlacesBooked: 1, held: { claimId: 'c', reason: 'refund_unconfirmed', message: EVENT_CANCEL_NEW_WORDS.unconfirmed } }))
        expect(await cancel()).toEqual({ ok: true, places: 1, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, booking, eventPlacesBooked: 1, warning: EVENT_CANCEL_NEW_WORDS.unconfirmed, held: true })
      })

      it('a refused card refund whose places could not be put back: the cancel stands, with the money owed and the Worker\'s words as the warning (not `held`: nothing is still being checked)', async () => {
        const { EVENT_CANCEL_NEW_WORDS } = await import('@/server/rules/events/failure-messages')
        const words = EVENT_CANCEL_NEW_WORDS.putBackBlocked('Failed to refund payment: Your card was declined.', 40)
        rawRequest.mockResolvedValue(success({ places: 1, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, booking, eventPlacesBooked: 1, refundOwed: 40, held: { claimId: 'c', reason: 'refund_refused_not_put_back', message: words } }))
        expect(await cancel()).toEqual({ ok: true, places: 1, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, booking, eventPlacesBooked: 1, refundOwed: 40, warning: words })
        expect(words).toContain('£40.00 shows on this booking as still to refund. Use Refund the rest to give it another way.')
      })

      it.each([
        ['no connection', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
        ['an earlier press still running', () => rawRequest.mockResolvedValue(refusal('CONFLICT', 'This request is already being processed'))],
        ['a fault', () => rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
      ])('%s: `no_answer` with `noAnswer`, so the dialog keeps its key and the next press gets the first one\'s answer', async (_label, arrange) => {
        arrange()
        const { EVENT_CANCEL_NO_ANSWER_MESSAGE } = await load('eventCancelWorker')
        expect(await cancel()).toEqual({ ok: false, reason: 'no_answer', message: EVENT_CANCEL_NO_ANSWER_MESSAGE, noAnswer: true })
      })

      it("a changed press under a no-answer press's key: refused as `pressed_after_no_answer`, never sent as new", async () => {
        rawRequest.mockResolvedValue(refusal('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
        const { EVENT_CANCEL_PRESSED_AFTER_NO_ANSWER_MESSAGE } = await load('eventCancelWorker')
        expect(await cancel()).toEqual({ ok: false, reason: 'pressed_after_no_answer', message: EVENT_CANCEL_PRESSED_AFTER_NO_ANSWER_MESSAGE, noAnswer: true })
      })

      it('getEventCancellationQuote: a read of the quote route with the cash and the money owed; a refusal as `ok: false` with the old words; anything else is thrown', async () => {
        const fn = (await backend('getEventCancellationQuote')).default
        rawRequest.mockResolvedValue(success({ ...quote, cashAmount: 40, refundOwed: 15 }))
        expect(await fn({ params: { eventBookingId: BOOKING, attendeeIds: [PLACE] }, user })).toEqual({ ok: true, ...quote, cashAmount: 40, refundOwed: 15 })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/event-bookings/${BOOKING}/cancel/quote`, method: 'POST', body: { attendeeIds: [PLACE] } })
        // A read: it has a time limit and no press key.
        expect((rawRequest.mock.calls[0]?.[0] as { headers: Record<string, string> }).headers['Idempotency-Key']).toBeUndefined()
        rawRequest.mockResolvedValue(refused('CONFLICT', { action: 'quote', reason: 'booking_pending', message: 'A card reader payment is still in progress for this booking. Finish or cancel it first.' }))
        expect(await fn({ params: { eventBookingId: BOOKING }, user })).toEqual({ ok: false, reason: 'booking_pending', message: 'A card reader payment is still in progress for this booking. Finish or cancel it first.' })
        const { EVENT_BOOKING_REFUND_OPEN_MESSAGE } = await import('@/server/rules/refunds/failure-messages')
        rawRequest.mockResolvedValue(refused('CONFLICT', { action: 'refund', reason: 'refund_open', message: EVENT_BOOKING_REFUND_OPEN_MESSAGE }))
        expect(await fn({ params: { eventBookingId: BOOKING }, user })).toEqual({ ok: false, reason: 'refund_open', message: EVENT_BOOKING_REFUND_OPEN_MESSAGE })
        rawRequest.mockResolvedValue(refusal('FORBIDDEN', 'This staff account is inactive. Ask an admin to reactivate it.'))
        await expect(fn({ params: { eventBookingId: BOOKING }, user })).rejects.toThrow('This staff account is inactive.')
      })

      it('neither wrapper touches the database or a legacy route, and neither imports the old cancellation code', () => {
        for (const name of ['cancelEventPlaces', 'getEventCancellationQuote', 'shared/eventCancelWorker']) {
          const source = readFileSync(path.join(appDir, `backend/paddock/${name}.ts`), 'utf8')
          expect(source, name).not.toContain('paddockData')
          expect(source, name).not.toContain('paddockBackendApi2')
          expect(source, name).not.toMatch(/from '\.\/(shared\/)?eventCancellation(Quote)?'/)
          expect(source, name).not.toMatch(/from '\.\/(shared\/)?(heldCardRefund|cardRefundAttempts|storeCreditRefund|refundPaymentIntent|stripeRefundLookup|orderCardPortion|orderPaymentStatus)'/)
        }
      })

      describe('the Cancel place / Cancel booking dialog', () => {
        const dialog = () => readFileSync(path.join(appDir, 'frontend/components/CancelEventPlacesDialog.tsx'), 'utf8')

        it('Q18: the refund shown is the Worker\'s quote (£0 for No refund) and is sent back with the press', () => {
          const source = dialog()
          expect(source).toContain('const refundShown = ok && refunding ? ok.value : 0')
          expect(source).toContain('confirmed: { refund: refundShown },')
          // The figures changed under the dialog: it moves to the Worker's new quote and reads the list again on close.
          expect(source).toMatch(/if \(result\.quote\) \{[\s\S]*?showQuote\(\{ ok: true, \.\.\.result\.quote \}, refund\)\s+reloadOnClose\(\)\s+\}/)
        })

        it('W30a (review L7): the cash choice says how much can go back in cash for these places, not "paid in cash on this order"', () => {
          const source = dialog()
          expect(source).toContain('{`Cash, handed over now (up to ${formatCurrency(ok.cashAmount ?? 0)} in cash)`}')
          expect(source).not.toContain('paid in cash on this order')
        })

        it('the press key: one per press, kept after a press that got no answer or threw, and dropped on any answer and when the dialog closes', () => {
          const source = dialog()
          const confirm = source.slice(source.indexOf('async function handleConfirm'), source.indexOf('return (\n    <>'))
          expect(confirm).toContain('pressKey.current ??= crypto.randomUUID()')
          expect(confirm).toContain('idempotencyKey: pressKey.current,')
          // No answer: the key stays (nothing sets it to null before the return).
          const noAnswer = confirm.slice(confirm.indexOf('if (!result.ok && result.noAnswer) {'), confirm.indexOf('// Any answer: the next press is a new one.'))
          expect(noAnswer).not.toContain('pressKey.current = null')
          expect(noAnswer).toContain('reloadOnClose()')
          expect(confirm).toMatch(/\/\/ Any answer: the next press is a new one\.\s+pressKey\.current = null/)
          // The call threw: no answer either.
          const thrown = confirm.slice(confirm.indexOf('} catch (err) {'))
          expect(thrown).toContain('setErrorMessage(thrownCallMessage(err))')
          expect(thrown).toContain('reloadOnClose()')
          expect(thrown).not.toContain('pressKey.current = null')
          // Closing ends the press.
          expect(source).toMatch(/function close\(\) \{[\s\S]*?pressKey\.current = null/)
        })

        it('closing is blocked while a press runs, and a second press can\'t start a second call', () => {
          const source = dialog()
          expect(source).toMatch(/function close\(\) \{\s+\/\/[^\n]*\n\s+if \(saving \|\| inFlight\.current\) return/)
          expect(source).toMatch(/async function handleConfirm\(\) \{\s+if \(inFlight\.current \|\| !ok\) return\s+inFlight\.current = true/)
          expect(source).toMatch(/\} finally \{\s+inFlight\.current = false\s+setSaving\(false\)/)
          expect(source).toContain('onOpenChange={(next) => (saving ? undefined : next ? setOpen(true) : close())}')
          expect(source).toContain('<Button variant="outline" onClick={close} disabled={saving}>')
        })

        it('the attendee list is read again on close after a press that got no answer, threw, or found the figures changed', () => {
          const source = dialog()
          expect(source).toContain('cancelledOnClose.current ??= () => onCancelled(null)')
          expect(source).toMatch(/function close\(\) \{[\s\S]*?cancelledOnClose\.current\?\.\(\)\s+cancelledOnClose\.current = null/)
          // The page reloads the whole list when it is told of a change with no booking to patch in.
          const page = readFileSync(path.join(appDir, 'frontend/pages/EventAttendeesPage.tsx'), 'utf8')
          expect(page).toMatch(/function replaceBooking\(updated: EventAttendeeBooking \| null, eventPlacesBooked\?: number\) \{[\s\S]*?if \(inFlight\.current === 0\) reload\(\)/)
        })

        it('cash (Q42) is offered only when cash paid on the order is left to hand back, needs Issue refunds, and says who hands it over; Q43\'s words for an event with no cut-off', () => {
          const source = dialog()
          expect(source).toContain('const cashAmount = ok ? round2(Math.min(ok.value, ok.cashAmount ?? 0)) : 0')
          expect(source).toMatch(/\{cashAmount > 0 \? \(\s+<div className="flex items-center gap-2">\s+<RadioGroupItem value="cash" id="cancel-refund-cash" disabled=\{!canIssueRefunds\} \/>/)
          expect(source).toContain("The cash is recorded as handed over by you.")
          expect(source).toContain("setRefund(choice === 'cash' && cashLeft <= 0 ? 'credit' : choice)")
          expect(source).toContain("setRefund(v === 'card' || v === 'credit' || v === 'cash' ? v : 'none')")
          expect(source).toContain("No refund cut-off set, so the event's start is the cut-off")
          // Card and store credit still need Issue refunds on the screen, and No refund is open to all.
          expect(source).toContain('<RadioGroupItem value={choice} id={`cancel-refund-${choice}`} disabled={!canIssueRefunds} />')
          expect(source).toContain('<RadioGroupItem value="none" id="cancel-refund-none" />')
        })

        it("the dialog's no-answer words are the wrapper's", async () => {
          const { EVENT_CANCEL_NO_ANSWER_MESSAGE } = await load('eventCancelWorker')
          expect(dialog()).toContain(`const NO_ANSWER_MESSAGE =\n  ${JSON.stringify(EVENT_CANCEL_NO_ANSWER_MESSAGE)}`)
        })
      })

      describe('money owed on the attendee list (Q39)', () => {
        const page = () => readFileSync(path.join(appDir, 'frontend/pages/EventAttendeesPage.tsx'), 'utf8')

        it("the staff app's loader reads the order that paid for each booking and the money still to refund on it, as the Worker's loader does", async () => {
          const loader = readFileSync(path.join(appDir, 'backend/paddock/shared/eventAttendeeList.ts'), 'utf8')
          const worker = readFileSync(path.join(appDir, '..', 'paddock/web/server/rules/events/attendee-list.ts'), 'utf8')
          const read = /paid\.order_id, COALESCE\(paid\.refund_owed_amount, 0\)::numeric\(10,2\)::text AS refund_owed_amount/
          const from = /LEFT JOIN LATERAL \(\s+SELECT o\.id AS order_id, o\.refund_owed_amount\s+FROM order_line_items oli JOIN orders o ON o\.id = oli\.order_id\s+WHERE oli\.event_booking_id = eb\.id AND oli\.item_type = 'event'\s+ORDER BY oli\.created_at, oli\.id LIMIT 1\s+\) paid ON true/
          for (const source of [loader, worker]) {
            expect(source).toMatch(read)
            expect(source).toMatch(from)
          }
          // Still read-only (getEventAttendees imports it).
          expect(loader).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
        })

        it('a booking with money owed shows the order\'s owed bar (Refund the rest, It already arrived), and the list is read again when it changes', () => {
          const source = page()
          expect(source).toContain("const refundOwed = Number.parseFloat(b.refund_owed_amount ?? '0') || 0")
          expect(source).toMatch(/\{refundOwed > 0 && b\.order_id \? \(\s+<div className="px-4 py-3 border-b border-border">\s+<OrderOwedBar orderId=\{b\.order_id\} owed=\{refundOwed\} onChanged=\{onOwedChanged\} where="on this booking's order" \/>/)
          expect(source).toContain('onOwedChanged={reload}')
          // The bar is W28's own: its buttons need Issue refunds, checked again by the Worker.
          const bar = readFileSync(path.join(appDir, 'frontend/components/OrderOwedBar.tsx'), 'utf8')
          expect(bar).toContain("where = 'on this order'")
          expect(bar).toContain('<div className="font-medium">{money(owedOnRow)} still to refund {where}</div>')
          expect(bar).toContain('disabled={!canIssueRefunds}')
        })

        it('a cancelled place says cash when cash was handed back, and how much of its refund did not go with the cancel', () => {
          const source = page()
          expect(source).toContain("a.refund_method === 'cash'")
          expect(source).toContain('`${formatCurrency(refunded)} refunded in cash`')
          expect(source).toContain("const refundAsked = a.refund_method === 'card' || a.refund_method === 'credit' || a.refund_method === 'cash'")
          expect(source).toContain('const short = refundAsked ? Math.round((Number.parseFloat(a.cancelled_value) - refunded) * 100) / 100 : 0')
        })
      })
    })

    describe('the whole event (W31: thin calls to the Worker, one press per booking)', () => {
      const EVENT = '66666666-6666-4666-8666-666666666666'
      const BOOKING = '44444444-4444-4444-8444-444444444444'
      const overview = {
        eventName: 'Full Moon Sauna',
        ended: false,
        cancelledAt: '2026-11-10T09:00:00.000Z',
        cancelReason: 'Storm',
        pendingCustomers: [],
        bookings: [
          { eventBookingId: BOOKING, customerName: 'Sam Test', places: 2, value: 80, problem: null },
          { eventBookingId: '77777777-7777-4777-8777-777777777777', customerName: 'Mo Member', places: 1, value: 20, problem: null, refundOwed: 5 },
        ],
        totalPlaces: 3,
        totalValue: 100,
      }
      const refused = (code: string, details: Record<string, unknown>) => ({
        data: { ok: false, error: { code, message: String(details['message']), details: { action: 'cancel_event', ...details } }, requestId: 'worker-request' },
      })
      const run = async (name: 'cancelEvent' | 'getEventCancellationOverview', params: Record<string, unknown>) => {
        const query = vi.fn()
        const legacy = vi.fn()
        vi.stubGlobal('paddockData', { query })
        vi.stubGlobal('paddockBackendApi2', { rawRequest: legacy })
        const fn = (await backend(name)).default
        const result = await fn({ params, user })
        // Never the database, never a legacy route: the Worker holds every rule.
        expect(query).not.toHaveBeenCalled()
        expect(legacy).not.toHaveBeenCalled()
        return result
      }
      const cancel = (params: Record<string, unknown> = {}) => run('cancelEvent', { eventId: EVENT, refund: 'card', reason: 'Storm', ...params })

      it('cancelEvent: sends the choice and the reason to the event\'s route, with no key (running it again is safe) and no time limit, and answers the bookings still to cancel', async () => {
        rawRequest.mockResolvedValue(success(overview))
        expect(await cancel()).toEqual({ ok: true, overview })
        expect(rawRequest).toHaveBeenCalledTimes(1)
        const sent = rawRequest.mock.calls[0]?.[0] as { path: string; method: string; body: unknown; headers: Record<string, string> }
        expect(sent).toMatchObject({ path: `/api/v1/staff/events/${EVENT}/cancel`, method: 'POST', body: { refund: 'card', reason: 'Storm' } })
        expect(sent.headers['X-Staff-Email']).toBe(user.email)
        expect('Idempotency-Key' in sent.headers).toBe(false)
        // No money moves in this call: the body names no booking, no amount and no confirmed figure.
        expect(Object.keys(sent.body as object).sort()).toEqual(['reason', 'refund'])
      })

      it('no event chosen: the old words, and the Worker is never called (the route is the event\'s)', async () => {
        expect(await cancel({ eventId: '' })).toEqual({ ok: false, reason: 'invalid_params', message: 'Choose an event.' })
        expect(rawRequest).not.toHaveBeenCalled()
      })

      it('a refusal: `ok: false` with the old reason and words', async () => {
        const { EVENT_WHOLE_CANCEL_WORDS } = await import('@/server/rules/events/failure-messages')
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'event_ended', message: EVENT_WHOLE_CANCEL_WORDS.eventEnded }))
        expect(await cancel()).toEqual({ ok: false, reason: 'event_ended', message: "This event has already ended, so it can't be cancelled." })
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'bookings_pending', message: EVENT_WHOLE_CANCEL_WORDS.bookingsPending(['Sam Test']) }))
        expect(await cancel()).toEqual({ ok: false, reason: 'bookings_pending', message: 'A card reader payment is still in progress for Sam Test. Finish or cancel it first.' })
        rawRequest.mockResolvedValue(refused('VALIDATION', { reason: 'invalid_params', message: EVENT_WHOLE_CANCEL_WORDS.chooseRefund }))
        expect(await cancel({ refund: 'cash' })).toEqual({ ok: false, reason: 'invalid_params', message: 'Choose Card or Store credit.' })
        rawRequest.mockResolvedValue(refused('NOT_FOUND', { reason: 'event_not_found', message: EVENT_WHOLE_CANCEL_WORDS.eventNotFound }))
        expect(await cancel()).toEqual({ ok: false, reason: 'event_not_found', message: 'This event no longer exists.' })
        // Rolled back in the database: a definite "not cancelled", not "no answer".
        const { EVENT_WHOLE_CANCEL_NEW_WORDS } = await import('@/server/rules/events/failure-messages')
        rawRequest.mockResolvedValue(refused('INTERNAL', { reason: 'cancel_not_saved', message: EVENT_WHOLE_CANCEL_NEW_WORDS.notSaved }))
        expect(await cancel()).toEqual({ ok: false, reason: 'cancel_not_saved', message: EVENT_WHOLE_CANCEL_NEW_WORDS.notSaved })
      })

      it('no Issue refunds, and event cancels switched off: as data, with the Worker\'s words (the old function threw the first)', async () => {
        rawRequest.mockResolvedValue(refusal('FORBIDDEN', 'Needs Issue refunds permission — this action moves money back to the customer.'))
        expect(await cancel()).toEqual({ ok: false, reason: 'permission_denied', message: 'Needs Issue refunds permission — this action moves money back to the customer.' })
        const words = 'This is switched off in the booking system. Tell a manager.'
        rawRequest.mockResolvedValue(refusal('REFUND_PATH_OFF', words))
        expect(await cancel()).toEqual({ ok: false, reason: 'refund_path_off', message: words })
      })

      it.each([
        ['no connection', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
        ['a fault', () => rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
      ])('%s: `noAnswer`, with words that say pressing again is safe and no booking was refunded', async (_label, arrange) => {
        arrange()
        const { EVENT_WHOLE_CANCEL_NO_ANSWER_MESSAGE } = await load('eventCancelWorker')
        expect(await cancel()).toEqual({ ok: false, reason: 'no_answer', message: EVENT_WHOLE_CANCEL_NO_ANSWER_MESSAGE, noAnswer: true })
        expect(EVENT_WHOLE_CANCEL_NO_ANSWER_MESSAGE).toContain('No booking has been refunded by this press.')
      })

      it('getEventCancellationOverview: a read of the overview route (with its time limit); null for an event that is gone, as before; any other failure is thrown', async () => {
        rawRequest.mockResolvedValue(success(overview))
        expect(await run('getEventCancellationOverview', { eventId: EVENT })).toEqual(overview)
        const sent = rawRequest.mock.calls[0]?.[0] as { path: string; method: string; body?: unknown }
        expect(sent).toMatchObject({ path: `/api/v1/staff/events/${EVENT}/cancel/overview`, method: 'GET' })
        expect(sent.body).toBeUndefined()
        rawRequest.mockResolvedValue(refused('NOT_FOUND', { reason: 'event_not_found', message: 'This event no longer exists.', action: 'overview' }))
        expect(await run('getEventCancellationOverview', { eventId: EVENT })).toBeNull()
        rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong.'))
        await expect(run('getEventCancellationOverview', { eventId: EVENT })).rejects.toThrow('Something went wrong.')
        const wrapper = readFileSync(path.join(appDir, 'backend/paddock/getEventCancellationOverview.ts'), 'utf8')
        expect(wrapper).toContain('timeoutMs: READ_TIMEOUT_MS')
      })

      it('cancelEventPlaces passes `wholeEvent` on, only when it is true', async () => {
        rawRequest.mockResolvedValue(success({ places: 2, refundedAmount: 80, cardRefundedAmount: 80, storeCreditRefundedAmount: 0, booking: null }))
        const fn = (await backend('cancelEventPlaces')).default
        await fn({ params: { eventBookingId: BOOKING, refund: 'card', reason: 'Storm', wholeEvent: true, confirmed: { refund: 80 }, idempotencyKey: 'press-key-0000000002' }, user })
        expect((rawRequest.mock.calls[0]?.[0] as { body: unknown }).body).toEqual({ refund: 'card', reason: 'Storm', wholeEvent: true, confirmed: { refund: 80 } })
        rawRequest.mockClear()
        await fn({ params: { eventBookingId: BOOKING, refund: 'card', wholeEvent: false, confirmed: { refund: 80 }, idempotencyKey: 'press-key-0000000003' }, user })
        expect('wholeEvent' in ((rawRequest.mock.calls[0]?.[0] as { body: object }).body)).toBe(false)
      })

      it('the two wrappers import none of the old modules, and neither touches the database or a legacy route', () => {
        for (const name of ['cancelEvent', 'getEventCancellationOverview']) {
          const source = readFileSync(path.join(appDir, `backend/paddock/${name}.ts`), 'utf8')
          expect(source, name).toContain('callWorker')
          expect(source, name).not.toMatch(/paddockData|paddockBackendApi2/)
          expect(source, name).not.toMatch(/from '\.\/shared\/(eventCancellation|eventCancellationQuote|heldCardRefund|cardRefundAttempts|storeCreditRefund|refundPaymentIntent|stripeRefundLookup|orderCardPortion|orderPaymentStatus|staffAccess|resolveStaffId)'/)
        }
        // The shared helper the wrappers use holds no write: a read-only getter imports it.
        expect(readFileSync(path.join(appDir, 'backend/paddock/shared/eventCancelWorker.ts'), 'utf8')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/)
      })

      describe('the Cancel event dialog', () => {
        const dialog = () => readFileSync(path.join(appDir, 'frontend/components/CancelEventDialog.tsx'), 'utf8')

        it('cancels the event first, then presses each booking in turn with `wholeEvent`, the overview\'s figure as the confirmed refund (Q18) and its own key (bugs E6, E7)', () => {
          const source = dialog()
          expect(source).toContain('cancelled = await cancelEvent({ eventId, refund, reason: reason.trim() }, { skipCache: true })')
          expect(source).toContain('{ eventBookingId, refund: press.refund, reason: press.reason, wholeEvent: true, confirmed: { refund: press.confirmed }, idempotencyKey: press.key }')
          // One new key for each booking, and the figure is the overview's own for that booking.
          expect(source).toContain('waiting.set(b.eventBookingId, { key: crypto.randomUUID(), refund, reason: reason.trim(), confirmed: b.value, customerName: b.customerName, places: b.places })')
          // The bookings come from the event cancel's own answer, not from what the dialog loaded earlier.
          expect(source).toContain('for (const b of cancelled.overview.bookings) {')
          // One at a time: each press is awaited inside the loop, and the list is shown as it grows.
          expect(source).toMatch(/for \(const \[eventBookingId, press\] of waiting\) \{\s+rows\.set\(eventBookingId, await cancelBooking\(eventBookingId, press\)\)\s+done \+= 1\s+setProgress\(\{ done, total \}\)\s+setResults\(\[\.\.\.rows\.values\(\)\]\)\s+\}/)
          // The event's own call must come before any booking is pressed.
          expect(source.indexOf('await cancelEvent(')).toBeLessThan(source.indexOf('await cancelBooking('))
          // Nothing is pressed when the event's cancel was refused or got no answer.
          expect(source).toMatch(/if \(!cancelled\.ok\) \{\s+setErrorMessage\(cancelled\.message\)\s+return\s+\}/)
        })

        it('only Card or Store credit is offered (Q42: never cash for a whole event)', () => {
          const source = dialog()
          expect(source).toContain("useState<'card' | 'credit'>('card')")
          expect(source).toContain("onValueChange={(v) => setRefund(v === 'credit' ? 'credit' : 'card')}")
          expect(source).not.toMatch(/value="cash"|'cash'/)
        })

        it("a booking's press that got no answer keeps its key and what was sent, and Retry presses it again exactly so, first, even when it is no longer listed; any answer drops the key", () => {
          const source = dialog()
          expect(source).toContain('heldPresses.current.set(eventBookingId, press)')
          expect(source).toContain('if (!result) return noAnswer(BOOKING_NO_ANSWER_MESSAGE)')
          expect(source).toContain('if (!result.ok && result.noAnswer) return noAnswer(BOOKING_NO_ANSWER_MESSAGE)')
          // The row's words are this list's own, and the replay's model of the dialog uses the same sentence.
          const model = readFileSync(path.join(appDir, '..', 'paddock/web/server/rules/testing/replay/whole-event-side.ts'), 'utf8')
          const words = /const BOOKING_NO_ANSWER_MESSAGE =\n  ("[^\n]+")/.exec(source)?.[1]
          expect(words).toBe(JSON.stringify("No answer came back, so this booking may or may not have been cancelled and refunded. Don't refund it by hand: press Retry (it won't cancel or refund twice)."))
          expect(model).toContain(`export const BOOKING_NO_ANSWER_MESSAGE =\n  ${String(words)}`)
          expect(source).toMatch(/\} catch \(err\) \{\s+\/\/ The call threw: no answer \(W20a's rule\)\.\s+return noAnswer\(/)
          expect(source).toContain('heldPresses.current.delete(eventBookingId)')
          expect(source).toMatch(/for \(const \[id, held\] of heldPresses\.current\) waiting\.set\(id, held\)\s+for \(const b of cancelled\.overview\.bookings\) \{\s+if \(waiting\.has\(b\.eventBookingId\)\) continue/)
          // The keys last until the dialog closes or is opened for another event.
          expect(source.match(/heldPresses\.current = new Map\(\)/g)).toHaveLength(2)
        })

        it('closing is blocked while a run is going, a second press never starts a second run, and the events list is read again', () => {
          const source = dialog()
          expect(source).toContain('if (saving || inFlight.current) return\n    heldPresses.current = new Map()\n    onClose()')
          expect(source).toContain('<Dialog open={open} onOpenChange={(next) => (saving || next ? undefined : close())}>')
          expect(source).toContain('<Button variant="outline" onClick={close} disabled={saving}>')
          expect(source).toContain('if (inFlight.current) return\n    inFlight.current = true')
          expect(source.match(/onChanged\(\)/g)?.length).toBeGreaterThanOrEqual(2)
        })

        it('a refusal or no answer on the event itself stays in the dialog (no toast), and Retry is offered for what is left, as before', () => {
          const source = dialog()
          expect(source).not.toContain('toast.error')
          expect(source).toContain("{saving ? 'Cancelling…' : results || alreadyCancelled ? 'Retry' : 'Cancel event and refund'}")
          expect(source).toContain("r.noAnswer\n                            ? 'no answer'\n                            : 'not cancelled'")
          expect(source).toContain('still to refund on its order')
        })

        it("the dialog's no-answer words for the event are the wrapper's", async () => {
          const { EVENT_WHOLE_CANCEL_NO_ANSWER_MESSAGE } = await load('eventCancelWorker')
          expect(dialog()).toContain(`const EVENT_NO_ANSWER_MESSAGE =\n  ${JSON.stringify(EVENT_WHOLE_CANCEL_NO_ANSWER_MESSAGE)}`)
        })
      })

      it("W31 (W30a \"Noticed\" 2): the order refund dialog's cash label says how much can go back in cash, not what was paid", () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RefundOrderDialog.tsx'), 'utf8')
        expect(source).toContain('{`Cash, handed over now (up to ${money(figures.cashLeft)} in cash)`}')
        expect(source).not.toContain('paid in cash on this order')
      })
    })

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

    describe('Cancel & Refund and Cancel & return credit (W23: thin calls to the Worker)', () => {
      const BOOKING = '11111111-1111-4111-8111-111111111111'
      const LINE = '33333333-3333-4333-8333-333333333333'
      const quote = {
        bookingId: BOOKING,
        status: 'confirmed',
        refund: 40,
        owed: 0,
        addonsRefund: 5,
        addonLineIds: [LINE],
        parts: { card: 45, storeCredit: 0 },
        cardRefundAvailable: true,
        insideTwentyFourHours: false,
        paidLine: 'Left to refund: £40.00 card money.',
        blocked: null,
      }
      const refused = (code: string, details: Record<string, unknown>) => ({
        data: { ok: false, error: { code, message: String(details['message']), details: { ...details } }, requestId: 'worker-request' },
      })
      const run = async (name: 'refundBooking' | 'cancelCreditBooking', params: Record<string, unknown>) => {
        const query = vi.fn()
        vi.stubGlobal('paddockData', { query })
        const fn = (await backend(name)).default
        return { result: await fn({ params: { bookingId: BOOKING, ...params }, user }), query }
      }
      const addons = { cancelledLineIds: [LINE], refundedAmount: 5, cardRefundedAmount: 5, storeCreditRefundedAmount: 0, creditsReturned: 0, notes: [], summary: '1 add-on cancelled: £5.00 to the card' }

      it('Cancel & Refund: no `confirmed` asks for the quote (a read, its ticks, no key); with it, the cancel with the figures and the press key; never the database', async () => {
        rawRequest.mockResolvedValue(success(quote))
        const quoting = await run('refundBooking', { refundMethod: 'card', addonLineIds: [LINE] })
        expect(quoting.result).toEqual({ quote })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/${BOOKING}/cancel-and-refund/quote`, method: 'POST', body: { addonLineIds: [LINE] } })
        expect((rawRequest.mock.calls[0]?.[0] as { headers?: Record<string, string> }).headers?.['Idempotency-Key']).toBeUndefined()
        rawRequest.mockResolvedValue(success({ cancelled: true, cardRefundedAmount: 40, storeCreditRefundedAmount: 0, addons }))
        const pressed = await run('refundBooking', { refundMethod: 'card', addonLineIds: [LINE], confirmed: { refund: 40, addonsRefund: 5 }, idempotencyKey: 'press-key-0000000023' })
        expect(pressed.result).toEqual({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, addons })
        expect(rawRequest.mock.calls[1]?.[0]).toMatchObject({
          path: `/api/v1/staff/bookings/${BOOKING}/cancel-and-refund`,
          method: 'POST',
          body: { refundMethod: 'card', addonLineIds: [LINE], confirmed: { refund: 40, addonsRefund: 5 } },
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000023' }),
        })
        expect(quoting.query).not.toHaveBeenCalled()
        expect(pressed.query).not.toHaveBeenCalled()
      })

      it('Cancel & Refund: changed figures as `quoteChanged` with the new quote; any other refusal as `failed`; a hold as `unsure`', async () => {
        const words = 'The figures on this booking have just changed. Check them and confirm again.'
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'refund_changed', message: words, action: 'cancel_and_refund', cancelQuote: quote }))
        expect((await run('refundBooking', { refundMethod: 'card', confirmed: { refund: 30, addonsRefund: 0 } })).result).toEqual({ quoteChanged: { message: words, quote } })
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'within_24_hours', message: 'Not eligible for refund or credit — within 24 hours of session start.', action: 'cancel_and_refund' }))
        expect((await run('refundBooking', { refundMethod: 'card', confirmed: { refund: 40, addonsRefund: 0 } })).result).toEqual({
          failed: { reason: 'within_24_hours', message: 'Not eligible for refund or credit — within 24 hours of session start.' },
        })
        const held = "The refund didn't get a clear answer, so it may or may not have gone. Don't refund it again. Check the Orders page in a few minutes."
        rawRequest.mockResolvedValue(success({ cancelled: true, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, held: { claimId: 'c', reason: 'refund_unconfirmed', message: held } }))
        expect((await run('refundBooking', { refundMethod: 'card', confirmed: { refund: 40, addonsRefund: 0 } })).result).toEqual({ unsure: { message: held } })
      })

      it.each([
        ['no connection', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
        ['an earlier press still running', () => rawRequest.mockResolvedValue(refusal('CONFLICT', 'This request is already being processed'))],
        ['a fault', () => rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
      ])('%s: Cancel & Refund `noAnswer` and Cancel & return credit `no_answer`, with the cancel words (the dialogs keep their key)', async (_label, arrange) => {
        const { CANCEL_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        arrange()
        expect((await run('refundBooking', { refundMethod: 'card', confirmed: { refund: 40, addonsRefund: 0 } })).result).toEqual({ noAnswer: { message: CANCEL_NO_ANSWER_MESSAGE } })
        arrange()
        expect((await run('cancelCreditBooking', { confirmed: { addonsRefund: 0 } })).result).toEqual({ cancelled: false, reason: 'no_answer', message: CANCEL_NO_ANSWER_MESSAGE })
      })

      it('a changed press under a no-answer key: `pressedAfterNoAnswer` / `pressed_after_no_answer` (locked), never sent as new', async () => {
        const { CANCEL_PRESSED_AFTER_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        rawRequest.mockResolvedValue(refusal('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
        expect((await run('refundBooking', { refundMethod: 'card', confirmed: { refund: 40, addonsRefund: 0 } })).result).toEqual({ pressedAfterNoAnswer: { message: CANCEL_PRESSED_AFTER_NO_ANSWER_MESSAGE } })
        expect((await run('cancelCreditBooking', { confirmed: { addonsRefund: 0 } })).result).toEqual({
          cancelled: false,
          reason: 'pressed_after_no_answer',
          message: CANCEL_PRESSED_AFTER_NO_ANSWER_MESSAGE,
          retryLocked: true,
        })
      })

      it('Cancel & return credit: the quote first; then the cancel with the paid add-ons\' figure, the method and the key; the old answer shape; refusals as data with the words (and the new quote)', async () => {
        rawRequest.mockResolvedValue(success({ ...quote, refund: 0 }))
        expect((await run('cancelCreditBooking', { addonLineIds: [LINE] })).result).toEqual({ cancelled: false, quote: { ...quote, refund: 0 } })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/${BOOKING}/cancel-credit/quote`, body: { addonLineIds: [LINE] } })
        rawRequest.mockResolvedValue(success({ cancelled: true, creditUsableAgain: true, booking: { id: BOOKING, status: 'cancelled' }, addons }))
        const pressed = await run('cancelCreditBooking', { addonLineIds: [LINE], addonRefund: 'card', confirmed: { addonsRefund: 5 }, idempotencyKey: 'press-key-0000000024' })
        expect(pressed.result).toEqual({ cancelled: true, creditUsableAgain: true, booking: { id: BOOKING, status: 'cancelled' }, addons })
        expect(rawRequest.mock.calls[1]?.[0]).toMatchObject({
          path: `/api/v1/staff/bookings/${BOOKING}/cancel-credit`,
          body: { addonRefund: 'card', confirmed: { addonsRefund: 5 }, addonLineIds: [LINE] },
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000024' }),
        })
        expect(pressed.query).not.toHaveBeenCalled()
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'paid_guests_present', message: 'Remove paid guests first, then cancel.', action: 'cancel_credit' }))
        expect((await run('cancelCreditBooking', { confirmed: { addonsRefund: 0 } })).result).toEqual({ cancelled: false, reason: 'paid_guests_present', message: 'Remove paid guests first, then cancel.' })
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'refund_changed', message: 'The figures on this booking have just changed. Check them and confirm again.', action: 'cancel_credit', cancelQuote: quote }))
        expect((await run('cancelCreditBooking', { confirmed: { addonsRefund: 0 } })).result).toMatchObject({ cancelled: false, reason: 'refund_changed', quote })
        // A held add-on refund: cancelled, with its words as the warning.
        rawRequest.mockResolvedValue(success({ cancelled: true, creditUsableAgain: false, booking: { id: BOOKING, status: 'cancelled' }, held: { claimId: 'c', reason: 'refund_unconfirmed', message: 'held words' } }))
        expect((await run('cancelCreditBooking', { confirmed: { addonsRefund: 5 } })).result).toMatchObject({ cancelled: true, warning: 'held words' })
      })

      it('the three dialogs: the quote first, its figures sent back as confirmed, the press key kept after no answer or a throw (W20a), closing blocked mid-call (W02 finding 13), the card from cardRefundAvailable (Q37)', () => {
        const read = (file: string) => readFileSync(path.join(appDir, 'frontend/components', file), 'utf8')
        const cancel = read('CancelAndRefundDialog.tsx')
        const press = read('useCancelCreditPress.ts')
        for (const source of [cancel, press]) {
          expect(source).toContain('const idempotencyKey = pressKey.current ?? crypto.randomUUID()')
          expect(source).toContain('pressKey.current = idempotencyKey')
          // Kept after no answer and after a changed press; cleared after any other answer, and on close.
          expect(source).toMatch(/\/\/ Any other answer: the next press is a new one\.\s+pressKey\.current = null/)
          expect(source).toContain("W20a's rule: a throw is no answer, so the key is kept for the next press.")
          // The key is cleared in two places only (after an answer, and on close): never in the catch.
          expect(source.match(/pressKey\.current = null/g)).toHaveLength(2)
          const thrown = source.slice(source.indexOf('} catch (err) {', source.indexOf('const idempotencyKey = pressKey.current')))
          expect(thrown.slice(0, thrown.indexOf('} finally {'))).not.toContain('pressKey.current = null')
          expect(source).toContain('quoteFor === ticksKey(addons.lineIds)')
          expect(source).toContain('!quote.blocked')
        }
        expect(cancel).toContain('confirmed: { refund: quote.refund, addonsRefund: quote.addonsRefund }')
        expect(cancel).toContain('onOpenChange={(next) => (submitting ? undefined')
        expect(cancel).toContain('disabled={!quote?.cardRefundAvailable}')
        expect(cancel).not.toContain('payment_method')
        // W25: with the paid guests' money (`refund`) when the club's cancel gives it back.
        expect(press).toContain('confirmed: { addonsRefund: addons.paidTicked ? quote.addonsRefund : 0, ...(quote.refund > 0 ? { refund: quote.refund } : {}) }')
        expect(press).toContain('...(addons.paidTicked || quote.refund > 0 ? { addonRefund } : {})')
        for (const dialog of ['CancelCreditBookingDialog.tsx', 'CancelPaymentNeededDialog.tsx']) {
          const source = read(dialog)
          expect(source).toContain('useCancelCreditPress(bookingId')
          expect(source).toContain('onOpenChange={(next) => (press.submitting ? undefined')
          expect(source).toContain('press.quote?.blocked')
        }
      })

      it('N5: a pass booking with paid guests shows Cancel & return credit (the Worker\'s words say to remove the paid guests first); the Block dialogs open the same Cancel & Refund dialog', () => {
        const detail = readFileSync(path.join(appDir, 'frontend/components/BookingDetailContent.tsx'), 'utf8')
        expect(detail).toMatch(/Number\.parseFloat\(booking\.price_paid\) === 0 \|\|\s+booking\.redemption_source === 'session_pass_credit' \|\|/)
        expect(detail).not.toContain('Paid in cash — no card payment on file')
        for (const block of ['BlockSessionDialog.tsx', 'BlockDayDialog.tsx']) {
          expect(readFileSync(path.join(appDir, 'frontend/components', block), 'utf8')).toContain('<CancelAndRefundDialog')
        }
      })

      it('W23a: the club\'s cancel (`clubCancelled`) goes to the quote and the press of both wrappers; without it nothing extra is sent', async () => {
        rawRequest.mockResolvedValue(success(quote))
        await run('refundBooking', { refundMethod: 'card', clubCancelled: true })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/${BOOKING}/cancel-and-refund/quote`, body: { clubCancelled: true } })
        rawRequest.mockResolvedValue(success({ cancelled: true, cardRefundedAmount: 40, storeCreditRefundedAmount: 0 }))
        await run('refundBooking', { refundMethod: 'card', confirmed: { refund: 40, addonsRefund: 0 }, clubCancelled: true })
        expect(rawRequest.mock.calls[1]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/${BOOKING}/cancel-and-refund`, body: { refundMethod: 'card', confirmed: { refund: 40, addonsRefund: 0 }, clubCancelled: true } })
        rawRequest.mockResolvedValue(success({ ...quote, refund: 0 }))
        await run('cancelCreditBooking', { clubCancelled: true })
        expect(rawRequest.mock.calls[2]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/${BOOKING}/cancel-credit/quote`, body: { clubCancelled: true } })
        rawRequest.mockResolvedValue(success({ cancelled: true, creditUsableAgain: true, booking: { id: BOOKING, status: 'cancelled' } }))
        await run('cancelCreditBooking', { confirmed: { addonsRefund: 0 }, clubCancelled: true })
        expect(rawRequest.mock.calls[3]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/${BOOKING}/cancel-credit`, body: { confirmed: { addonsRefund: 0 }, clubCancelled: true } })
        // From the booking page: no flag at all.
        rawRequest.mockResolvedValue(success(quote))
        await run('refundBooking', { refundMethod: 'card' })
        await run('cancelCreditBooking', {})
        for (const call of rawRequest.mock.calls.slice(4)) expect((call[0] as { body?: Record<string, unknown> }).body).not.toHaveProperty('clubCancelled')
      })

      it('W23a (W23 review S2): the three cancel dialogs reload the booking on close after no answer or a throw; a held or warning Cancel & Refund tells its parent on close, not straight away', () => {
        const read = (file: string) => readFileSync(path.join(appDir, 'frontend/components', file), 'utf8')
        const cancel = read('CancelAndRefundDialog.tsx')
        const press = read('useCancelCreditPress.ts')
        for (const source of [cancel, press]) {
          // Set in the no-answer branch, the pressed-after-no-answer branch and the catch.
          expect(source.match(/reloadOnClose\.current = true/g)).toHaveLength(3)
          const thrown = source.slice(source.indexOf('} catch (err) {', source.indexOf('const idempotencyKey = pressKey.current')))
          expect(thrown.slice(0, thrown.indexOf('} finally {'))).toContain('reloadOnClose.current = true')
        }
        expect(cancel).toMatch(/if \(reloadOnClose\.current\) \{\s+reloadOnClose\.current = false\s+onStale\?\.\(booking\.id\)/)
        expect(cancel).toMatch(/toast\.warning\('This refund needs checking'\)\s+refundedOnClose\.current = true\s+return/)
        expect(cancel).toMatch(/toast\.warning\('Refund processed with a warning — see details'\)\s+refundedOnClose\.current = true\s+return/)
        expect(cancel).toMatch(/if \(refundedOnClose\.current\) \{\s+refundedOnClose\.current = false\s+onRefunded\(booking\.id\)/)
        // onRefunded twice only: on close (held or warning), and straight after a clear answer.
        expect(cancel.match(/onRefunded\(booking\.id\)/g)).toHaveLength(2)
        expect(press).toMatch(/const stale = reloadOnClose\.current\s+reloadOnClose\.current = false/)
        for (const dialog of ['CancelCreditBookingDialog.tsx', 'CancelPaymentNeededDialog.tsx']) expect(read(dialog)).toContain('if (press.reset()) onStale?.(bookingId)')
        const detail = readFileSync(path.join(appDir, 'frontend/components/BookingDetailContent.tsx'), 'utf8')
        // W24: and the Move dialog's. W26a (audit S4): and Take Payment, Refund the rest, Part refund and both Add Guest buttons.
        expect(detail.match(/onStale=\{reloadAfterNoAnswer\}/g)).toHaveLength(9)
        expect(detail).toMatch(/function reloadAfterNoAnswer\(\) \{\s+trigger\(\{ bookingId \}, \{ skipCache: true \}\)/)
      })

      it("W23a (Wayne, 13 Nov): Block Session and Block Day cancel as the club and offer Cancel & return credit for credit bookings; the booking page never sends the flag", () => {
        const read = (file: string) => readFileSync(path.join(appDir, 'frontend/components', file), 'utf8')
        for (const block of ['BlockSessionDialog.tsx', 'BlockDayDialog.tsx']) {
          const source = read(block)
          expect(source.match(/^\s+clubCancelled$/gm)).toHaveLength(2)
          expect(source).toContain("const CREDIT_SOURCES: ReadonlySet<string> = new Set(['membership_credit', 'session_pass_credit'])")
          expect(source).toMatch(/\{CREDIT_SOURCES\.has\(b\.redemption_source\) \? \(\s+<CancelCreditBookingDialog/)
        }
        expect(read('BookingDetailContent.tsx')).not.toContain('clubCancelled')
        expect(read('CancelAndRefundDialog.tsx')).toContain('const club = clubCancelled ? { clubCancelled: true } : {}')
        expect(read('CancelAndRefundDialog.tsx').match(/\.\.\.club\b/g)).toHaveLength(2)
        expect(read('useCancelCreditPress.ts').match(/\.\.\.club\b/g)).toHaveLength(2)
        expect(read('CancelCreditBookingDialog.tsx')).toContain('useCancelCreditPress(bookingId, open && !result, clubCancelled)')
      })
    })

    describe('Move (W24: a thin call to the Worker)', () => {
      const BOOKING = '11111111-1111-4111-8111-111111111111'
      const SESSION = '22222222-2222-4222-8222-222222222222'
      const priceImpact = { amountDue: -11, refundDue: true, seatDeltas: [], legacyPricing: false, customerId: '44444444-4444-4444-8444-444444444444' }
      const quote = { priceImpact, blocked: null, cardRefundAvailable: true, refundParts: { card: 11, storeCredit: 0 } }
      const refused = (code: string, details: Record<string, unknown>) => ({
        data: { ok: false, error: { code, message: String(details['message']), details: { ...details } }, requestId: 'worker-request' },
      })
      const run = async (params: Record<string, unknown>) => {
        const query = vi.fn()
        vi.stubGlobal('paddockData', { query })
        const fn = (await backend('moveBooking')).default
        return { result: await fn({ params: { bookingId: BOOKING, newSessionId: SESSION, ...params }, user }), query }
      }

      it('no `confirmed` asks for the quote (a read, no key) and answers the old shape; with it, the move with the figures and the press key; never the database', async () => {
        rawRequest.mockResolvedValue(success(quote))
        const quoting = await run({})
        expect(quoting.result).toEqual({ moved: false, priceImpact, cardRefundAvailable: true, refundParts: { card: 11, storeCredit: 0 } })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/${BOOKING}/move/quote`, method: 'POST', body: { newSessionId: SESSION } })
        expect((rawRequest.mock.calls[0]?.[0] as { headers?: Record<string, string> }).headers?.['Idempotency-Key']).toBeUndefined()
        // A dearer or same-price quote: the old answer exactly (no card choice), and `blocked` only when something blocks.
        rawRequest.mockResolvedValue(success({ ...quote, priceImpact: { ...priceImpact, amountDue: 11, refundDue: false }, refundParts: null, blocked: { reason: 'refund_open', message: 'held' } }))
        expect((await run({})).result).toEqual({ moved: false, priceImpact: { ...priceImpact, amountDue: 11, refundDue: false }, blocked: { reason: 'refund_open', message: 'held' } })
        rawRequest.mockResolvedValue(success({ moved: true, booking: { id: BOOKING, price_paid: 29 } }))
        const pressed = await run({ confirmed: true, refundMethod: 'card', figures: { amountDue: -11, toCollect: 0 }, idempotencyKey: 'press-key-0000000025' })
        expect(pressed.result).toEqual({ moved: true, booking: { id: BOOKING, price_paid: 29 } })
        expect(rawRequest.mock.calls[2]?.[0]).toMatchObject({
          path: `/api/v1/staff/bookings/${BOOKING}/move`,
          method: 'POST',
          body: { newSessionId: SESSION, confirmed: true, figures: { amountDue: -11, toCollect: 0 }, refundMethod: 'card' },
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000025' }),
        })
        expect(quoting.query).not.toHaveBeenCalled()
        expect(pressed.query).not.toHaveBeenCalled()
      })

      it('the reader: moved, pending the tap; a held refund: moved, with its words as the warning', async () => {
        const pending = { flow: 'move', recordId: BOOKING, pendingId: 'p', paymentIntentId: 'pi', clientSecret: 'pi_secret', amount: 11 }
        rawRequest.mockResolvedValue(success({ moved: true, booking: { id: BOOKING, price_paid: 51 }, pendingReaderPayment: pending }))
        expect((await run({ confirmed: true, payment: { method: 'reader' }, figures: { amountDue: 11, toCollect: 11 } })).result).toEqual({ moved: true, booking: { id: BOOKING, price_paid: 51 }, pendingReaderPayment: pending })
        rawRequest.mockResolvedValue(success({ moved: true, booking: { id: BOOKING, price_paid: 29 }, held: { claimId: 'c', reason: 'refund_unconfirmed', message: 'held words' } }))
        expect((await run({ confirmed: true, refundMethod: 'card', figures: { amountDue: -11 } })).result).toEqual({ moved: true, booking: { id: BOOKING, price_paid: 29 }, warning: 'held words' })
      })

      it('refusals as data, in the old shape: the reason, the words (left out when only the dialog had some), the new figures', async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'amount_changed', message: 'The amount due has changed to £5.50. Check it with the customer and confirm again.', action: 'move', priceImpact: { ...priceImpact, amountDue: 5.5, refundDue: false } }))
        expect((await run({ confirmed: true, payment: { method: 'card' }, figures: { amountDue: 11, toCollect: 11 } })).result).toEqual({
          moved: false,
          reason: 'amount_changed',
          message: 'The amount due has changed to £5.50. Check it with the customer and confirm again.',
          priceImpact: { ...priceImpact, amountDue: 5.5, refundDue: false },
        })
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'same_session', message: 'Pick a different session than the one this booking is already on.', action: 'move', screenWords: true }))
        expect((await run({})).result).toEqual({ moved: false, reason: 'same_session' })
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'duplicate_day_booking', message: 'This customer already has a booking on that day. Only one booking per customer per day is allowed.', action: 'move' }))
        expect((await run({})).result).toEqual({ moved: false, reason: 'duplicate_day_booking', message: 'This customer already has a booking on that day. Only one booking per customer per day is allowed.' })
      })

      it.each([
        ['no connection', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
        ['an earlier press still running', () => rawRequest.mockResolvedValue(refusal('CONFLICT', 'This request is already being processed'))],
        ['a fault', () => rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
      ])('%s on the press: `no_answer`, with the move words (the dialog keeps its key)', async (_label, arrange) => {
        const { MOVE_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        arrange()
        expect((await run({ confirmed: true, figures: { amountDue: 0 } })).result).toEqual({ moved: false, reason: 'no_answer', message: MOVE_NO_ANSWER_MESSAGE })
      })

      it('a changed press under a no-answer key: `pressed_after_no_answer`, locked, never sent as new', async () => {
        const { MOVE_PRESSED_AFTER_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        rawRequest.mockResolvedValue(refusal('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
        expect((await run({ confirmed: true, figures: { amountDue: 0 } })).result).toEqual({ moved: false, reason: 'pressed_after_no_answer', message: MOVE_PRESSED_AFTER_NO_ANSWER_MESSAGE, retryLocked: true })
      })

      it('the dialog: the Worker\'s quote and its figures sent back (Q18), the card from cardRefundAvailable (Q37), the press key kept after no answer or a throw (W20a), closing blocked mid-call, the booking reloaded on close after either (W23a S2), `blocked` holding Confirm', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/MoveBookingDialog.tsx'), 'utf8')
        expect(source).toContain('figures: {\n            amountDue: priceImpact.amountDue,')
        expect(source).toContain('toCollect: dearer ? figureToCollect(amountLeftToPay(priceImpact.amountDue, giftCardAmount, storeCreditAmount), payment) : 0,')
        expect(source).toContain('pressKey.current ??= crypto.randomUUID()')
        expect(source).toContain('idempotencyKey: pressKey.current,')
        // Kept after no answer (and a changed press after it), cleared after any other answer and on close: never in the catch.
        expect(source.match(/pressKey\.current = null/g)).toHaveLength(2)
        const press = source.slice(source.indexOf('async function handleConfirm'))
        const caught = press.indexOf('} catch (err) {')
        const thrown = press.slice(caught, press.indexOf('} finally {', caught))
        expect(thrown).not.toContain('pressKey.current = null')
        expect(thrown).toContain('reloadOnClose.current = true')
        expect(source.match(/reloadOnClose\.current = true/g)).toHaveLength(2)
        expect(source).toMatch(/if \(reloadOnClose\.current\) \{\s+reloadOnClose\.current = false\s+onStale\?\.\(bookingId\)/)
        expect(source).toContain('onOpenChange={(next) => (readerWaiting || submitting ? undefined')
        expect(source).toContain('const card = result.cardRefundAvailable === true')
        expect(source).toContain('disabled={!cardRefundAvailable}')
        expect(source).toContain('disabled={submitting || retryLocked || Boolean(blocked) ||')
        expect(source).not.toContain('cardRefundAvailable = true')
        // W25 (W24 review L6): the Block dialogs pass onStale to Move: after a Move with no answer the booking is read
        // again (a read, never the block itself) and its row goes or is brought up to date.
        for (const block of ['BlockSessionDialog.tsx', 'BlockDayDialog.tsx']) {
          const blockSource = readFileSync(path.join(appDir, 'frontend/components', block), 'utf8')
          const dialog = blockSource.slice(blockSource.indexOf('<MoveBookingDialog'), blockSource.indexOf('/>', blockSource.indexOf('<MoveBookingDialog')))
          expect(dialog).toContain('onStale={(id) => void handleBookingStale(id)}')
          expect(dialog).not.toContain('cardRefundAvailable')
          expect(blockSource).toContain('const fresh = await loadBooking({ bookingId }, { skipCache: true })')
          expect(blockSource).toContain('useGetBookingById')
        }
        // W25 item 6 (W23 review later 1): the owed bar shows on a cancelled booking too, with Refund the rest held to
        // store credit there.
        const detailSource = readFileSync(path.join(appDir, 'frontend/components/BookingDetailContent.tsx'), 'utf8')
        expect(detailSource).toContain('{refundOwed > 0 ? (')
        expect(detailSource).not.toContain("refundOwed > 0 && booking.status !== 'cancelled'")
        expect(detailSource).toContain("storeCreditOnly={booking.status === 'cancelled'}")
        const restSource = readFileSync(path.join(appDir, 'frontend/components/RefundTheRestDialog.tsx'), 'utf8')
        expect(restSource).toContain("setRefundMethod(!storeCreditOnly && method === 'card' && next.cardLeft > 0 ? 'card' : 'credit')")
        expect(restSource).toContain('const cardTakes = figures && !storeCreditOnly ? Math.min(figures.cardLeft, owed) : 0')
        // W25 (W24 review L7): a re-quote that fails after an "amount changed" refusal clears the old card choice.
        expect(source).toContain("setCardRefundAvailable(false)\n            setRefundParts(null)\n            setRefundMethod('credit')")
      })
    })

    describe('Remove Guest and Remove add-on (W22: thin calls to the Worker)', () => {
      const GUEST = '22222222-2222-4222-8222-222222222222'
      const LINE = '33333333-3333-4333-8333-333333333333'
      const BOOKING = '11111111-1111-4111-8111-111111111111'
      const quote = { bookingId: BOOKING, bookingType: 'public', refundAmount: 20, refundable: true, partySize: 3 }
      const addonQuote = { lineId: LINE, bookingId: BOOKING, paid: true, amount: 5, insideTwentyFourHours: false, refund: 5 }
      const refused = (code: string, details: Record<string, unknown>) => ({
        data: { ok: false, error: { code, message: String(details['message']), details: { ...details } }, requestId: 'worker-request' },
      })
      const run = async (name: 'removeBookingGuest' | 'removeBookingAddon', params: Record<string, unknown>) => {
        const query = vi.fn()
        vi.stubGlobal('paddockData', { query })
        const fn = (await backend(name)).default
        return { result: await fn({ params, user }), query }
      }

      it('Remove Guest: the first call asks for the quote (a read, no key); the second removes with the amount and the press key; never the database', async () => {
        rawRequest.mockResolvedValue(success({ removed: false, blocked: false, guestId: GUEST, quote }))
        const first = await run('removeBookingGuest', { guestId: GUEST })
        expect(first.result).toEqual({ removed: false, blocked: false, guestId: GUEST, quote })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/guests/${GUEST}/remove/quote`, method: 'POST', body: {} })
        expect((rawRequest.mock.calls[0]?.[0] as { headers?: Record<string, string> }).headers?.['Idempotency-Key']).toBeUndefined()
        rawRequest.mockResolvedValue(success({ removed: true, blocked: false, guestId: GUEST, refundedAmount: 20, cardRefundedAmount: 20, storeCreditRefundedAmount: 0 }))
        const second = await run('removeBookingGuest', { guestId: GUEST, confirmedRefundAmount: 20, refundMethod: 'card', idempotencyKey: 'press-key-0000000001' })
        expect(second.result).toEqual({ removed: true, blocked: false, guestId: GUEST, refundedAmount: 20, cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
        expect(rawRequest.mock.calls[1]?.[0]).toMatchObject({
          path: `/api/v1/staff/bookings/guests/${GUEST}/remove`,
          method: 'POST',
          body: { confirmedRefundAmount: 20, refundMethod: 'card' },
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000001' }),
        })
        expect(first.query).not.toHaveBeenCalled()
        expect(second.query).not.toHaveBeenCalled()
      })

      it('Remove Guest: a refusal in the old shape (the words left out when the old function had none; the new quote; the permission flag)', async () => {
        rawRequest.mockResolvedValue(refused('CONFLICT', { reason: 'refund_amount_mismatch', message: 'The amount due has changed. Check it with the customer and confirm again.', action: 'remove_guest', quote }))
        expect((await run('removeBookingGuest', { guestId: GUEST, confirmedRefundAmount: 25, refundMethod: 'card' })).result).toEqual({
          removed: false,
          blocked: false,
          guestId: GUEST,
          reason: 'refund_amount_mismatch',
          message: 'The amount due has changed. Check it with the customer and confirm again.',
          quote,
        })
        rawRequest.mockResolvedValue(refused('FORBIDDEN', { reason: 'no_refund_permission', message: 'x', action: 'remove_guest', screenWords: true, blockedByRefundPermission: true }))
        expect((await run('removeBookingGuest', { guestId: GUEST, confirmedRefundAmount: 20, refundMethod: 'card' })).result).toEqual({
          removed: false,
          blocked: false,
          guestId: GUEST,
          reason: 'no_refund_permission',
          blockedByRefundPermission: true,
        })
        rawRequest.mockResolvedValue(refused('NOT_FOUND', { reason: 'guest_not_found', message: 'This guest has already been removed.', action: 'remove_guest', screenWords: true }))
        expect((await run('removeBookingGuest', { guestId: GUEST })).result).toEqual({ removed: false, blocked: false, guestId: GUEST, reason: 'guest_not_found' })
      })

      it("Remove Guest: a refund held for the automatic check (Q35): removed, with the Worker's words as the warning", async () => {
        const words = "The refund didn't get a clear answer, so it may or may not have gone. Don't refund it again. Check the Orders page in a few minutes."
        rawRequest.mockResolvedValue(success({ removed: true, blocked: false, guestId: GUEST, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, held: { claimId: 'c', reason: 'refund_unconfirmed', message: words } }))
        expect((await run('removeBookingGuest', { guestId: GUEST, confirmedRefundAmount: 20, refundMethod: 'card' })).result).toMatchObject({ removed: true, warning: words })
      })

      it.each([
        ['no connection', () => rawRequest.mockRejectedValue(new Error('socket hang up'))],
        ['an earlier press still running', () => rawRequest.mockResolvedValue(refusal('CONFLICT', 'This request is already being processed'))],
        ['a fault', () => rawRequest.mockResolvedValue(refusal('INTERNAL', 'Something went wrong and the action may not have finished. Check before trying again.'))],
      ])('%s: `no_answer` on either removal, so the dialog keeps its key', async (_label, arrange) => {
        arrange()
        const { REMOVE_GUEST_NO_ANSWER_MESSAGE, REMOVE_ADDON_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect((await run('removeBookingGuest', { guestId: GUEST, confirmedRefundAmount: 20, refundMethod: 'card' })).result).toEqual({
          removed: false,
          blocked: false,
          guestId: GUEST,
          reason: 'no_answer',
          message: REMOVE_GUEST_NO_ANSWER_MESSAGE,
        })
        expect((await run('removeBookingAddon', { addonLineId: LINE, refund: 'card', confirmedRefund: 5 })).result).toEqual({ removed: false, reason: 'no_answer', message: REMOVE_ADDON_NO_ANSWER_MESSAGE })
      })

      it('a changed press under a no-answer key: `pressed_after_no_answer` (Remove Guest locks), never sent as new', async () => {
        rawRequest.mockResolvedValue(refusal('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request.'))
        const { REMOVE_GUEST_PRESSED_AFTER_NO_ANSWER_MESSAGE, REMOVE_ADDON_PRESSED_AFTER_NO_ANSWER_MESSAGE } = await load('bookingWorker')
        expect((await run('removeBookingGuest', { guestId: GUEST, confirmedRefundAmount: 20, refundMethod: 'credit' })).result).toMatchObject({
          reason: 'pressed_after_no_answer',
          message: REMOVE_GUEST_PRESSED_AFTER_NO_ANSWER_MESSAGE,
          retryLocked: true,
        })
        expect((await run('removeBookingAddon', { addonLineId: LINE, refund: 'credit', confirmedRefund: 5 })).result).toEqual({
          removed: false,
          reason: 'pressed_after_no_answer',
          message: REMOVE_ADDON_PRESSED_AFTER_NO_ANSWER_MESSAGE,
        })
      })

      it('Remove add-on: the quote first (a read), then the removal with the confirmed refund and the key; a refusal with the new quote', async () => {
        rawRequest.mockResolvedValue(success(addonQuote))
        expect((await run('removeBookingAddon', { addonLineId: LINE, refund: 'card' })).result).toEqual({ removed: false, quote: addonQuote })
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/bookings/addon-lines/${LINE}/remove/quote`, method: 'POST' })
        const removed = { removed: true, summary: '1 add-on cancelled: £5.00 to the card', cancelledLineIds: [LINE], refundedAmount: 5, cardRefundedAmount: 5, storeCreditRefundedAmount: 0, creditsReturned: 0, notes: [] }
        rawRequest.mockResolvedValue(success(removed))
        const { result, query } = await run('removeBookingAddon', { addonLineId: LINE, refund: 'card', confirmedRefund: 5, idempotencyKey: 'press-key-0000000002' })
        expect(result).toEqual(removed)
        expect(rawRequest.mock.calls[1]?.[0]).toMatchObject({
          path: `/api/v1/staff/bookings/addon-lines/${LINE}/remove`,
          body: { refund: 'card', confirmed: { refund: 5 } },
          headers: expect.objectContaining({ 'Idempotency-Key': 'press-key-0000000002' }),
        })
        expect(query).not.toHaveBeenCalled()
        rawRequest.mockResolvedValue(
          refused('CONFLICT', { reason: 'refund_changed', message: 'The figures on this booking have just changed. Check them and confirm again.', action: 'remove_addon', addonQuote: { ...addonQuote, insideTwentyFourHours: true, refund: 0 } })
        )
        expect((await run('removeBookingAddon', { addonLineId: LINE, refund: 'card', confirmedRefund: 5 })).result).toEqual({
          removed: false,
          reason: 'refund_changed',
          message: 'The figures on this booking have just changed. Check them and confirm again.',
          quote: { ...addonQuote, insideTwentyFourHours: true, refund: 0 },
        })
      })

      it("the dialogs: Remove Guest blocks closing mid-call (W02 finding 13); both keep their press key after no answer or a throw (W20a's rule); Remove add-on sends the quote's figure", () => {
        const guest = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        const addon = readFileSync(path.join(appDir, 'frontend/components/RemoveBookingAddonDialog.tsx'), 'utf8')
        expect(guest).toContain('onOpenChange={(next) => (submitting ? undefined : next ? setOpen(true) : resetAndClose())}')
        expect(addon).toContain('onOpenChange={(next) => (saving ? undefined : next ? setOpen(true) : close())}')
        for (const source of [guest, addon]) {
          expect(source).toContain('pressKey.current ??= crypto.randomUUID()')
          expect(source).toContain('idempotencyKey: pressKey.current')
          // The key is cleared only after the no-answer answers have returned (it is kept for them), and on close.
          expect(source).toMatch(/=== 'no_answer' \|\| result(\?)?\.reason === 'pressed_after_no_answer'\)\) ?\{[\s\S]*?return\s*\}\s*pressKey\.current = null|=== 'no_answer' \|\| result(\?)?\.reason === 'pressed_after_no_answer'\) \{[\s\S]*?return\s*\}\s*pressKey\.current = null/)
          expect(source.match(/pressKey\.current = null/g)).toHaveLength(2)
          // A throw keeps the key, with the no-answer words.
          expect(source).toContain('setErrorMessage(thrownCallMessage(err))')
        }
        // The old dialog locked Remove after a throw; with the key kept, pressing again is the same press.
        expect(guest.slice(guest.indexOf('async function handleConfirm'))).not.toMatch(/catch \(err\) \{[^}]*setRetryLocked\(true\)/)
        expect(addon).toContain('confirmedRefund: refundShown')
        expect(addon).toContain("const refundShown = quote && quote.paid && refund !== 'none' ? quote.refund : 0")
      })

      it("W22a item 1 (Wayne's decision): inside 24 hours Remove Guest shows the 24-hour words and sends the Worker's £0", () => {
        const guest = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(guest).toContain(
          "'Inside 24 hours of the session, so nothing is refunded for this guest. Use Part refund if you want to give something back.'"
        )
        expect(guest).toMatch(/\{quote\.refundable && quote\.insideTwentyFourHours\s+\? INSIDE_24_HOURS_MESSAGE/)
        // The figure sent is the quote's (the Worker's £0 inside 24 hours), with no method when it is £0.
        expect(guest).toContain('confirmedRefundAmount: quote.refundAmount,')
        expect(guest).toContain('...(quote.refundAmount > 0 ? { refundMethod } : {}),')
      })

      it('W22a S1 (Q37): Remove Guest offers the card whenever the booking\'s figures show card money left, not from its payment_method', () => {
        const guest = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        expect(guest).toContain('const figures = await loadFigures({ bookingId: next.bookingId }, { skipCache: true })')
        expect(guest).toContain('const cardLeft = figures.parts.card')
        expect(guest).toContain('const cardRefundAvailable = card !== null && card.cardLeft > 0')
        expect(guest).toContain("setRefundMethod(cardLeft > 0 ? 'card' : 'credit')")
        // Figures that can't be loaded offer store credit only; Remove waits for the figures when money goes back.
        expect(guest).toContain("setCard({ cardLeft: 0, paidLine: null, failed: true })")
        expect(guest).toContain('(quote.refundAmount > 0 && (!canIssueRefunds || card === null))')
        expect(guest).not.toContain('cardRefundAvailable?: boolean')
        expect(guest).not.toMatch(/payment_method ===|hasCardPayment/)
        const parent = readFileSync(path.join(appDir, 'frontend/components/BookingDetailContent.tsx'), 'utf8')
        const removeGuest = parent.slice(parent.indexOf('<RemoveGuestDialog'), parent.indexOf('/>', parent.indexOf('<RemoveGuestDialog')))
        expect(removeGuest).not.toContain('cardRefundAvailable')
      })

      it('W22a S2: Remove add-on reloads the booking on close after no answer or a throw, as Remove Guest does', () => {
        const addon = readFileSync(path.join(appDir, 'frontend/components/RemoveBookingAddonDialog.tsx'), 'utf8')
        const confirm = addon.slice(addon.indexOf('async function handleConfirm'), addon.indexOf('return (\n    <>'))
        expect(confirm).toMatch(/=== 'pressed_after_no_answer'\)\) \{\s+\/\/[^\n]*\n\s+removedOnClose\.current = true/)
        expect(confirm).toMatch(/catch \(err\) \{\s+\/\/[^\n]*\n\s+removedOnClose\.current = true\s+setErrorMessage\(thrownCallMessage\(err\)\)/)
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
      ])("%s sends every flow to the Worker's flow route (W25: no old body, no read of its own), and says so plainly when it gets no answer", async (name, step, answer) => {
        const PENDING = '22222222-2222-4222-8222-222222222222'
        const query = vi.fn(async () => ({ data: [] }))
        vi.stubGlobal('paddockData', { query })
        const fn = (await backend(name)).default
        rawRequest.mockResolvedValue(success(answer))
        expect(await fn({ params: { pendingId: PENDING }, user })).toEqual(answer)
        expect(rawRequest.mock.calls[0]?.[0]).toMatchObject({ path: `/api/v1/staff/reader-flows/${PENDING}/${step}`, method: 'POST' })
        // W25: nothing is read here any more (the old body, with its staff lookup and legacy routes, is gone).
        expect(query).not.toHaveBeenCalled()
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

    // 'refund safety' (W05j, W05k) is gone. Its tests left as each action went to the Worker: refundBooking (W21),
    // Cancel & Refund (W23), giveBookingMoneyBack (W24a), refundOrder (W28). Brief W34 took the last two, which loaded
    // the staff app's shared/eventCancellation (deleted at W34; W31 review L2): store credit that gave no clear answer
    // on an event place cancel. The Worker's rule is tested in server/rules/events/, and the frozen copy of the old
    // code is replayed by server/rules/testing/replay/event-places-replay.test.ts (legacy-refund/).

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
        // W24: the Worker's words first (refusalText), then the dialog's for the reason.
        expect(branch).toContain('setErrorMessage(refusalText(result))')
        expect(branch).toContain('if (result.priceImpact.amountDue > 0.001 && !customer) await loadPayingCustomer(result.priceImpact.customerId)')
      })

      it('Move shows the server\'s own words on any other refusal', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/MoveBookingDialog.tsx'), 'utf8')
        // W24: refusalText puts the Worker's words first, then the dialog's for the reason.
        expect(source).toContain('} else {\n        setErrorMessage(refusalText(result))')
        expect(source).toContain("return result?.message ?? (result?.reason ? FAILURE_MESSAGES[result.reason] ?? result.reason : 'Failed to move booking.')")
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
        // W22a: through showQuote, which loads the booking's figures again for the new figure.
        expect(source).toContain('if (result?.quote) await showQuote(result.quote)')
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
        expect(source).toMatch(/: quote\.refundable\s+\? 'Nothing left to refund on this seat\.'\s+: 'Nothing to refund — this seat was not paid with money \(legacy booking or credit-covered\)\.'\}/)
      })

      it('Remove Guest reloads the booking when it closes after a refusal, and the parent does', () => {
        const dialog = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        // W22: and after no answer (the key kept), as after a refusal or a throw.
        expect(dialog.match(/reloadOnClose\.current = true/g)).toHaveLength(4)
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
          // W24: the quote (a read on the Worker) never moves, so only the press finishes with its answer's notices.
          expect(source.match(/finishMove\(/g)).toHaveLength(4)
          expect(source.match(/finishMove\(moveNotices\(result\)\)/g)).toHaveLength(1)
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
          // W30: a call that throws got no answer, so the dialog says so and keeps its press key (W20a's rule).
          expect(source).toContain('setErrorMessage(thrownCallMessage(err))')
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

      it('Remove Guest reloads when the call itself fails, because the refund may have gone; W22: it keeps the press key rather than locking (pressing again is the same press)', () => {
        const source = readFileSync(path.join(appDir, 'frontend/components/RemoveGuestDialog.tsx'), 'utf8')
        const confirm = source.slice(source.indexOf('async function handleConfirm'), source.indexOf('return (\n    <>'))
        const failed = confirm.slice(confirm.indexOf('} catch (err) {'))
        expect(failed).toContain('reloadOnClose.current = true')
        expect(failed).not.toContain('setRetryLocked(true)')
        expect(failed).not.toContain('pressKey.current = null')
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

  describe('W26a: the step D audit fixes on the screens', () => {
    const component = (file: string) => readFileSync(path.join(appDir, 'frontend/components', file), 'utf8')
    const page = (file: string) => readFileSync(path.join(appDir, 'frontend/pages', file), 'utf8')
    /** The dialog's use in a parent: from its opening tag to the tag's end. */
    const uses = (source: string, tag: string) => source.split(`<${tag}`).slice(1).map((rest) => rest.slice(0, rest.indexOf('/>')))
    const CLOSE = /if \(reloadOnClose\.current\) \{\s+reloadOnClose\.current = false\s+onStale\?\.\(bookingId\)\s+\}/
    /** Each press's `catch (err)` body (to its `finally`): a press is where the key is made. */
    const thrown = (source: string) =>
      source
        .split('pressKey.current ??= crypto.randomUUID()')
        .slice(1)
        .map((rest) => {
          const at = rest.indexOf('} catch (err) {')
          return rest.slice(at, rest.indexOf('} finally {', at))
        })

    describe('S4: the four dialogs reload the booking on close after no answer, a changed press after no answer, or a throw', () => {
      it('Part refund', () => {
        const source = component('PartRefundDialog.tsx')
        // One branch covers no answer and a changed press after it; the other is the catch.
        expect(source.match(/reloadOnClose\.current = true/g)).toHaveLength(2)
        expect(source).toMatch(/if \(response\?\.noAnswer \|\| response\?\.pressedAfterNoAnswer\) \{\s+setErrorMessage\([^\n]+\)\s+reloadOnClose\.current = true\s+return/)
        expect(thrown(source)).toHaveLength(1)
        for (const body of thrown(source)) expect(body).toContain('reloadOnClose.current = true')
        expect(source).toMatch(CLOSE)
        const close = source.slice(source.indexOf('function resetAndClose()'), source.indexOf('const amountValue'))
        expect(close).toMatch(CLOSE)
        // The key is still kept after no answer or a throw (W20a), and closing is blocked mid-call.
        expect(thrown(source)[0]).not.toContain('pressKey.current = null')
        expect(source).toContain('onOpenChange={(next) => (submitting ? undefined : next ? setOpen(true) : resetAndClose())}')
      })

      it('Refund the rest and It already arrived', () => {
        const source = component('RefundTheRestDialog.tsx')
        // The shared no-answer branch (both presses go through it), and each press's catch.
        expect(source.match(/reloadOnClose\.current = true/g)).toHaveLength(3)
        const early = source.slice(source.indexOf('function stoppedEarly'), source.indexOf('async function handleArrived'))
        expect(early).toMatch(/if \(response\?\.noAnswer \|\| response\?\.pressedAfterNoAnswer\) \{\s+setErrorMessage\([^\n]+\)\s+reloadOnClose\.current = true\s+return true/)
        expect(thrown(source)).toHaveLength(2)
        for (const body of thrown(source)) {
          expect(body).toContain('reloadOnClose.current = true')
          expect(body).not.toContain('pressKey.current = null')
        }
        for (const press of ['async function handleArrived', 'async function handleSubmit']) {
          expect(source.slice(source.indexOf(press)).slice(0, 1200)).toContain('if (stoppedEarly(response)) return')
        }
        const close = source.slice(source.indexOf('function resetAndClose()'), source.indexOf('function stoppedEarly'))
        expect(close).toMatch(CLOSE)
      })

      it('Add Guest (and add-ons)', () => {
        const source = component('AddGuestDialog.tsx')
        // Both presses (the first call and Confirm): the no-answer branch and the catch of each.
        expect(source.match(/reloadOnClose\.current = true/g)).toHaveLength(4)
        expect(
          source.match(/if \(result\?\.reason !== 'no_answer' && result\?\.reason !== 'pressed_after_no_answer'\) pressKey\.current = null\s+else reloadOnClose\.current = true/g)
        ).toHaveLength(2)
        expect(thrown(source)).toHaveLength(2)
        for (const body of thrown(source)) {
          expect(body).toContain('reloadOnClose.current = true')
          expect(body).not.toContain('pressKey.current = null')
        }
        const close = source.slice(source.indexOf('function resetAndClose()'), source.indexOf('function handleContinueToPayment'))
        expect(close).toMatch(CLOSE)
      })

      it('Take Payment', () => {
        const source = component('SettleLapsedPaymentDialog.tsx')
        expect(source.match(/reloadOnClose\.current = true/g)).toHaveLength(2)
        expect(source).toMatch(/if \(result\?\.reason !== 'no_answer'\) pressKey\.current = null\s+else reloadOnClose\.current = true/)
        expect(thrown(source)).toHaveLength(1)
        for (const body of thrown(source)) expect(body).toContain('reloadOnClose.current = true')
        const close = source.slice(source.indexOf('function resetAndClose()'), source.indexOf('async function handleCancelReaderWait'))
        expect(close).toMatch(CLOSE)
      })

      it('every parent passes the reload: the booking detail for all four, the Block dialogs for Part refund', () => {
        const detail = component('BookingDetailContent.tsx')
        expect(detail).toMatch(/function reloadAfterNoAnswer\(\) \{\s+trigger\(\{ bookingId \}, \{ skipCache: true \}\)\s+onBookingsChanged\?\.\(\)/)
        for (const [tag, count] of [['PartRefundDialog', 1], ['RefundTheRestDialog', 1], ['AddGuestDialog', 2], ['SettleLapsedPaymentDialog', 1]] as const) {
          const found = uses(detail, tag)
          expect(found, tag).toHaveLength(count)
          for (const use of found) expect(use, tag).toContain('onStale={reloadAfterNoAnswer}')
        }
        for (const block of ['BlockSessionDialog.tsx', 'BlockDayDialog.tsx']) {
          const found = uses(component(block), 'PartRefundDialog')
          expect(found).toHaveLength(1)
          expect(found[0]).toContain('onStale={(id) => void handleBookingStale(id)}')
        }
      })
    })

    describe('S1: a cancelled booking can be opened again', () => {
      it("a customer's Booking History row opens the booking window by id, as the Overview does", () => {
        const customers = page('CustomersPage.tsx')
        const history = customers.slice(customers.indexOf('detail.bookingHistory.map((b) => ('))
        // Every row, whatever its status (no condition on it), opens its booking.
        expect(history.slice(0, history.indexOf('</TableRow>'))).toMatch(/<TableRow key=\{b\.id\} className="cursor-pointer hover:bg-accent\/50" onClick=\{\(\) => setOpenBookingId\(b\.id\)\}>/)
        expect(customers).toMatch(/<BookingByIdDialog\s+bookingId=\{openBookingId\}\s+onClose=\{\(\) => setOpenBookingId\(null\)\}\s+onChanged=\{\(\) => trigger\(\{ customerId \}, \{ skipCache: true \}\)\}/)
        const dialog = component('BookingByIdDialog.tsx')
        // The row is read fresh by id (never filtered by status), and again after any action inside the window.
        expect(dialog).toContain('loadBookingById({ bookingId }, { skipCache: true })')
        expect(dialog).toContain('}, [bookingId, refreshToken])')
        expect(dialog).toMatch(/<BookingDetailDialog\s+booking=\{booking\}\s+open=\{bookingId !== null\}/)
        expect(dialog).not.toMatch(/status\s*[!=]==/)
        // The window shows the owed bar on a cancelled booking, with Refund the rest to store credit only (W25).
        const detail = component('BookingDetailContent.tsx')
        const bar = detail.slice(detail.indexOf('{refundOwed > 0 ? ('), detail.indexOf('{isRefundEligible || isMovable || isCreditBooking ? ('))
        expect(bar).toContain('still to refund')
        expect(bar).toContain("storeCreditOnly={booking.status === 'cancelled'}")
        expect(bar).not.toContain("status !== 'cancelled'")
      })

      it('the calendar lists cancelled bookings on the session cards only when the status filter is Cancelled', async () => {
        const { buildDaySlotCards, buildCardsByDate } = await import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/dayViewSlots.ts'))
        const session = (id: string, bookingType: string, start: string, end: string) => ({ id, booking_type: bookingType, status: 'open', start_time: `2026-11-20T${start}:00`, end_time: `2026-11-20T${end}:00` })
        const booking = (id: string, sessionId: string, status: string) => ({ id, session_id: sessionId, status, start_time: '2026-11-20T10:00:00' })
        const sessions = [session('pub', 'public', '10:00', '11:00'), session('priv', 'private', '10:00', '12:00')]
        const cancelledOnly = [booking('b1', 'pub', 'cancelled'), booking('b2', 'priv', 'cancelled')]
        // As before: cancelled bookings are never on a card.
        expect(buildDaySlotCards(sessions, cancelledOnly, false).map((card: { bookings: unknown[]; cancelledBookings: unknown[]; visualState: string }) => [card.bookings.length, card.cancelledBookings.length, card.visualState])).toEqual([[0, 0, 'empty']])
        // With the Cancelled filter: listed, so one can be opened; a cancelled private booking doesn't hide the public slot.
        // W50 item 10 (W26a review R1, L5) changed how: the cancelled bookings are in `cancelledBookings`, apart from the
        // live ones, so the card keeps the session's own state ('empty', not 'public_booked'), and the private
        // session's cancelled booking has a card in the public view too. Held in full in "W50: … item 10" above.
        const listed = buildDaySlotCards(sessions, cancelledOnly, false, true)
        expect(listed.map((card: { session: { id: string }; cancelledBookings: Array<{ id: string }>; visualState: string }) => [card.session.id, card.cancelledBookings.map((b) => b.id), card.visualState])).toEqual([['pub', ['b1'], 'empty'], ['priv', ['b2'], 'empty']])
        expect(buildDaySlotCards(sessions, cancelledOnly, true, true)[0]).toMatchObject({ session: { id: 'priv' }, bookings: [], cancelledBookings: [{ id: 'b2' }], visualState: 'empty' })
        // An active private booking still claims the public slot it spans, listed or not.
        expect(buildDaySlotCards(sessions, [booking('b3', 'priv', 'confirmed')], false, true)).toEqual([])
        expect(buildCardsByDate(sessions, cancelledOnly, false, true).get('2026-11-20')?.[0]?.cancelledBookings).toHaveLength(1)
        expect(buildCardsByDate(sessions, cancelledOnly).get('2026-11-20')?.[0]?.cancelledBookings).toHaveLength(0)

        const bookings = page('BookingsPage.tsx')
        // From the filter the rows were loaded with (Apply Filters), not the select's value.
        expect(bookings).toContain("const listCancelled = rowsStatus === 'cancelled'")
        expect(bookings).toMatch(/const status = statusFilter\s+trigger\(\{/)
        expect(bookings).toMatch(/setRows\(result \?\? \[\]\)\s+setRowsStatus\(status\)/)
        for (const view of ['BookingSessionAgendaView', 'BookingWeekView', 'BookingMonthView']) {
          const found = uses(bookings, view)
          expect(found, view).toHaveLength(1)
          expect(found[0], view).toContain('listCancelled={listCancelled}')
        }
        expect(component('BookingSessionAgendaView.tsx')).toContain('buildDaySlotCards(sessions, bookings, showPrivateSessions, listCancelled)')
        expect(component('BookingWeekView.tsx')).toContain('buildCardsByDate(sessions, bookings, showPrivateSessions, listCancelled)')
        expect(component('BookingMonthView.tsx')).toContain('buildCardsByDate(sessions, bookings, false, listCancelled)')
        // The card's row opens the booking and says it is cancelled (W50: in the window's own "Cancelled" list).
        const card = component('SessionDetailDialog.tsx')
        expect(card).toContain('onClick={() => onSelectBooking(b)}')
        expect(card).toMatch(/\{cancelledBookings\.map\(\(b\) => \([^]*?<BookingStatusBadge status=\{b\.status\} \/>/)
      })
    })

    it("S5 (Q37): the booking detail shows the Worker's exact payment line, read again with the booking, and keeps the general words until it has it", () => {
      const detail = component('BookingDetailContent.tsx')
      expect(detail).toContain('const { trigger: loadFigures } = useGetBookingRefundFigures()')
      expect(detail).toContain("const showsPaidWords = booking.redemption_source === 'paid' && booking.status !== 'cancelled'")
      // W47 item 9, named differences: the same read is made for a cancelled booking too (for why it lapsed), so the
      // payment line is set only for the booking it is shown on, and the effect follows both conditions.
      expect(detail).toContain('setPaidWords(showsPaidWords && figures && figures.left > 0 && figures.paidWords ? figures.paidWords : null)')
      expect(detail).toContain('}, [data, bookingId, showsPaidWords, mayHaveLapsed])')
      expect(detail).toMatch(/\{paidWords\s+\? `\$\{paidWords\} Card money goes back to the card, the rest to store credit\.`\s+: 'Paid — eligible for refund: card money goes back to the card, the rest to store credit\.'\}/)
      const types = readFileSync(path.join(appDir, 'frontend/types/paddock.ts'), 'utf8')
      expect(types).toContain('paidWords?: string')
      const contracts = readFileSync(path.join(shared, 'workerContracts.ts'), 'utf8')
      // W46: for a lapsed booking the route's answer also carries `lapse` (why it lapsed), after the words.
      expect(contracts).toMatch(/export type BookingRefundFiguresRouteOutput = \{[^\n]*paidLine: string; paidWords: string; lapse\?: \{[^\n]*words: string; \} \| undefined; \}/)
    })
  })


  // Brief W47: the screens' own code, read from the staff app's checkout (it has no test runner of its own). The
  // words and sums they show are tested as functions in server/staff-app-orders-page.test.ts.
  describe('W47: the Orders page, Overview, the owed bar and the booking detail', () => {
    const component = (name: string) => readFileSync(path.join(appDir, 'frontend/components', name), 'utf8')
    const page = (name: string) => readFileSync(path.join(appDir, 'frontend/pages', name), 'utf8')

    it('item 2: Resolve now is on the Orders page with nothing listed; the banner itself is only drawn when it has something to show', () => {
      const banner = component('StuckPaymentsBanner.tsx')
      // The old line returned nothing at all, button included.
      expect(banner).not.toContain('if (count === 0 && !reconcileSaid && !data?.workerProblem) return null')
      // With nothing to show: a quiet line and the button, which runs the same press.
      expect(banner).toMatch(/if \(!stuckAnythingToShow\(data\) && !data\?\.workerProblem\) \{\s+return \(\s+<div className="flex items-center justify-between gap-3 flex-wrap mb-4 text-sm text-muted-foreground">\s+<span>\{reconcileSaid \?\? NOTHING_STUCK_LINE\}<\/span>\s+<Button size="sm" variant="outline" onClick=\{resolveNow\} disabled=\{running\}>/)
      expect(banner.match(/onClick=\{resolveNow\}/g)).toHaveLength(2)
      // After every run that answered the page reads its lists again (a run can leave money owed).
      expect(banner).toContain('if (answer?.ok) onSwept()')
    })

    it("item 3: the banner's first line counts by kind, and Stripe's notices have a line of their own in the Worker's words", () => {
      const banner = component('StuckPaymentsBanner.tsx')
      expect(banner).toContain('{data?.workerProblem && listed === 0 ? STUCK_LIST_NOT_READ_LINE : stuckHeadline(data)}')
      expect(banner).not.toContain('card payment{count === 1')
      expect(banner).toMatch(/\{data\?\.webhook \? \(\s+<div className="flex items-start gap-2 rounded border border-destructive\/40 bg-destructive\/10 p-2 text-destructive">\s+<AlertTriangle className="w-4 h-4 shrink-0 mt-0\.5" \/>\s+<span>\{data\.webhook\.words\}<\/span>/)
    })

    it('item 4: a watched payment is a line of its own, with its close only when the Worker offers one', () => {
      const banner = component('StuckPaymentsBanner.tsx')
      expect(banner).toContain('{data?.watchedPayments?.map((item) => (')
      expect(banner).toContain('{watchedPaymentLabel(item)} · since {formatDateTime(item.since)}')
      expect(banner).toContain('{closeButton(item.close, watchedPaymentLabel(item), item.words)}')
      expect(banner).toContain('const listed = counts.payments + counts.memberships + counts.watching')
      expect(banner).toContain('{listed > 0 ? (')
    })

    it('item 1: the Orders page has the "Money still to refund" section, read again after anything that may change what is owed; Overview counts it', () => {
      const orders = page('OrdersPage.tsx')
      expect(orders).toContain('<MoneyOwedSection onChanged={() => runQuery(view, { skipCache: true })} reloadToken={owedToken} />')
      expect(orders).toContain('<StuckPaymentsBanner onSwept={owedMayHaveChanged} />')
      expect(orders).toContain('onLinesChanged={owedMayHaveChanged}')
      const section = component('MoneyOwedSection.tsx')
      expect(section).toContain('const { data: loaded, loading, trigger: loadList } = useGetMoneyOwed()')
      expect(section).toContain('<h2 className="font-semibold text-foreground">Money still to refund</h2>')
      // Every line of the Worker's list, once, keyed by what it is on.
      expect(section).toContain('{data?.owed.map((item) => (')
      expect(section).toContain('<li key={`${item.on}-${item.orderId ?? item.bookingId}`}')
      expect(section).toContain('{item.customerName} · {formatCurrency(item.amount.toFixed(2))} · {owedForWords(item)}')
      expect(section).toContain('<div className="text-muted-foreground">{item.where}</div>')
      // Refund the rest runs from the list: an order's line has the order's own bar; a booking's opens the booking.
      expect(section).toMatch(/\{item\.on === 'order' && item\.orderId \? \(\s+<OrderOwedBar\s+orderId=\{item\.orderId\}\s+owed=\{item\.amount\}\s+onChanged=\{changed\}/)
      expect(section).toContain("{item.on === 'booking' && item.bookingId ? (")
      expect(section).toContain('onClick={() => setBookingId(item.bookingId)}')
      // The money kept on lapsed bookings, with the Worker's note (which names Adjust store credit).
      expect(section).toContain('<div className="text-muted-foreground">{data?.keptNote}</div>')
      expect(section).toContain('{item.customerName} · {formatCurrency(item.kept.toFixed(2))} kept')
      const overview = page('OverviewPage.tsx')
      expect(overview).toContain('const { data: moneyOwedData, loading: moneyOwedLoading, trigger: loadMoneyOwed } = useGetMoneyOwed()')
      expect(overview).toContain('value={moneyOwedCount(moneyOwedData as MoneyOwedResult | undefined)}')
      expect(overview).toContain('label={moneyOwedTileLabel(moneyOwedCount(moneyOwedData as MoneyOwedResult | undefined))}')
      expect(overview).toContain('    loadMoneyOwed({}, { skipCache: true })')
    })

    it("item 6 (the W35 audit's F3): the owed bar's split comes from the payment the Worker names, not from the order's own card money", () => {
      const bar = component('OrderOwedBar.tsx')
      expect(bar).toContain('const split = figures ? owedCardSplit(figures) : null')
      expect(bar).toContain('const cardTakes = split?.card ?? 0')
      expect(bar).toContain("const whichCard = split?.payment === 'membership' ? \" (the membership's own card payment)\" : ''")
      expect(bar).toContain("setRefundMethod(method === 'card' && owedCardSplit(next).cardLeft > 0 ? 'card' :")
      expect(bar).not.toContain('Math.min(figures.cardLeft, owed)')
      expect(bar).not.toContain("method === 'card' && next.cardLeft > 0")
    })

    it('item 8 (Wayne, 19 Nov): both It already arrived windows ask where the money arrived, send it, and keep the button off until staff have said', () => {
      const choice = component('ArrivedOnChoice.tsx')
      expect(choice).toContain('<RadioGroup value={value ?? \'\'} onValueChange={(next) => onChange(next as ArrivedOn)}>')
      expect(choice).toContain('<RadioGroupItem value="card"')
      expect(choice).toContain('<RadioGroupItem value="other"')
      const bar = component('OrderOwedBar.tsx')
      expect(bar).toContain('const [arrivedOn, setArrivedOn] = useState<ArrivedOn | null>(null)')
      expect(bar).toContain('<ArrivedOnChoice value={arrivedOn} onChange={setArrivedOn} idPrefix="order-owed" />')
      expect(bar).toContain('if (inFlight.current || !figures || !arrivedValid || !reasonValid || !arrivedOn) return')
      expect(bar).toContain("disabled={submitting || owed <= 0 || !arrivedValid || !reasonValid || !arrivedOn || figures?.blocked?.reason === 'refund_open'}>")
      const booking = component('RefundTheRestDialog.tsx')
      expect(booking).toContain('const [arrivedOn, setArrivedOn] = useState<ArrivedOn | null>(null)')
      expect(booking).toContain('<ArrivedOnChoice value={arrivedOn} onChange={setArrivedOn} idPrefix="refund-rest" />')
      expect(booking).toContain('if (inFlight.current || !figures || !arrivedValid || !arrivedOn) return')
      expect(booking).toContain("{ bookingId, refundMethod: 'credit', amount: Math.round(arrived * 100) / 100, owedArrived: true, reason: reason.trim(), arrivedOn, idempotencyKey: pressKey.current },")
      expect(booking).toContain('disabled={submitting || owed <= 0 || !reasonValid || !arrivedValid || !arrivedOn}>')
      // Closing either window forgets the choice.
      expect(bar.match(/setArrivedOn\(null\)/g)).toHaveLength(1)
      expect(booking.match(/setArrivedOn\(null\)/g)).toHaveLength(1)
    })

    it("item 9: the booking detail shows why a booking lapsed, in the Worker's words, from the figures read it already makes", () => {
      const detail = component('BookingDetailContent.tsx')
      expect(detail).toContain("const mayHaveLapsed = booking.status === 'cancelled'")
      expect(detail).toContain('if (!data || (!showsPaidWords && !mayHaveLapsed)) {')
      expect(detail).toContain('setLapseWords(mayHaveLapsed && figures?.lapse?.words ? figures.lapse.words : null)')
      expect(detail).toMatch(/\{lapseWords \? \(\s+<div className="flex items-start gap-2 rounded-md border border-border bg-muted\/30 px-3 py-2 text-sm">\s+<AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0 mt-0\.5" \/>\s+<span>\{lapseWords\}<\/span>/)
      // No new read: the one hook the detail already had.
      expect(detail.match(/useGetBookingRefundFigures\(\)/g)).toHaveLength(1)
      const types = readFileSync(path.join(appDir, 'frontend/types/paddock.ts'), 'utf8')
      expect(types).toContain('lapse?: { at: string; givenBack: number; kept: number; owed: number; words: string }')
    })

    it('the wrappers pass where the money arrived to the Worker, and send nothing when the screen sends none', async () => {
      const rawRequest = vi.fn().mockResolvedValue({ data: { ok: true, data: { cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 0, pricePaid: 20 }, requestId: 'r' } })
      vi.stubGlobal('paddockWorkerV1', { rawRequest })
      try {
        const user = { email: 'jo@example.com' }
        const owed = (await import(/* @vite-ignore */ path.join(appDir, 'backend/paddock/refundOrderOwed'))).default as (req: { params: object; user: object }) => Promise<unknown>
        const booking = (await import(/* @vite-ignore */ path.join(appDir, 'backend/paddock/refundBooking'))).default as (req: { params: object; user: object }) => Promise<unknown>
        const bodies = () => rawRequest.mock.calls.map((call) => [(call[0] as { path: string }).path.split('/').slice(-2).join('/'), (call[0] as { body: unknown }).body])
        await owed({ params: { orderId: 'o1', amount: 10, arrived: true, reason: 'Seen in Stripe', arrivedOn: 'card' }, user })
        await owed({ params: { orderId: 'o1', amount: 10, arrived: true, reason: 'On their balance', arrivedOn: 'other' }, user })
        await owed({ params: { orderId: 'o1', amount: 10, arrived: true, reason: 'An older screen' }, user })
        await booking({ params: { bookingId: 'b1', refundMethod: 'credit', amount: 20, owedArrived: true, reason: 'Seen in Stripe', arrivedOn: 'card' }, user })
        await booking({ params: { bookingId: 'b1', refundMethod: 'credit', amount: 20, owedArrived: true, reason: 'An older screen' }, user })
        expect(bodies()).toEqual([
          ['refunds/owed-arrived', { amount: 10, reason: 'Seen in Stripe', arrivedOn: 'card' }],
          ['refunds/owed-arrived', { amount: 10, reason: 'On their balance', arrivedOn: 'other' }],
          ['refunds/owed-arrived', { amount: 10, reason: 'An older screen' }],
          ['refunds/owed-arrived', { amount: 20, reason: 'Seen in Stripe', arrivedOn: 'card' }],
          ['refunds/owed-arrived', { amount: 20, reason: 'An older screen' }],
        ])
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it("W47a (W47 review L2): when It already arrived \"on the card\" could record less than arrived, the Worker's note reaches both windows through the wrappers and is shown under the result", async () => {
      const note = 'Only £3.00 could be recorded against the card payment (it had £3.00 left); the other £22.00 is recorded as reached another way. Check you chose the right place.'
      const rawRequest = vi.fn().mockResolvedValue({
        data: { ok: true, data: { cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 0, pricePaid: 20, arrivedOnCard: { recorded: 3, other: 22 }, warning: note }, requestId: 'r' },
      })
      vi.stubGlobal('paddockWorkerV1', { rawRequest })
      try {
        const user = { email: 'jo@example.com' }
        const owed = (await import(/* @vite-ignore */ path.join(appDir, 'backend/paddock/refundOrderOwed'))).default as (req: { params: object; user: object }) => Promise<unknown>
        const booking = (await import(/* @vite-ignore */ path.join(appDir, 'backend/paddock/refundBooking'))).default as (req: { params: object; user: object }) => Promise<unknown>
        expect(await owed({ params: { orderId: 'o1', amount: 25, arrived: true, reason: 'Seen in Stripe', arrivedOn: 'card' }, user })).toMatchObject({ refundOwed: 0, warning: note })
        expect(await booking({ params: { bookingId: 'b1', refundMethod: 'credit', amount: 25, owedArrived: true, reason: 'Seen in Stripe', arrivedOn: 'card' }, user })).toMatchObject({ warning: note })
      } finally {
        vi.unstubAllGlobals()
      }
      const bar = component('OrderOwedBar.tsx')
      const dialog = component('RefundTheRestDialog.tsx')
      // Each window keeps the note with its result...
      expect(bar).toContain("setResult({ card: 0, storeCredit: 0, cash: 0, owedAfter: response?.refundOwed ?? 0, arrived: amount, ...(response?.warning ? { warning: response.warning } : {}) })")
      expect(dialog).toContain("setResult({ cardRefunded: 0, storeCreditRefunded: 0, arrived: true, ...(response?.warning ? { warning: response.warning } : {}) })")
      // ...and shows it straight under "No money moved", in the It already arrived view.
      for (const source of [bar, dialog]) {
        expect(source).toMatch(
          /No money moved\.[\s\S]{0,260}\{result\.warning \? \(\s+<div className="flex items-start gap-2 rounded-md border border-warning\/30 bg-warning\/10 p-3 text-sm">\s+<AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0\.5" \/>\s+<div>\{result\.warning\}<\/div>/
        )
      }
    })
  })
})
