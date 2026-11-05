import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db, SqlParam } from '@/server/db'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { stepBRoutes } from '@/server/rules/testing/routes'

// Old logic against new logic: the staff app's nine functions, with shadowCompare on, against the
// real Worker routes, on one database. The old side runs the old SQL; the new side goes through
// callWorker into the route. Any difference reaches /parity and fails the test.
//
// This proves the two sets of code agree. It does NOT compare the two database drivers: paddockData
// is stubbed with the Worker's own db here, so both sides see the same column types. That
// comparison is in driver-parity.test.ts. Skipped when the staff app's checkout isn't beside this repo.

const KEY = 'test-staff-api-key'
const appDir = process.env.RETOOL_APP_DIR ?? path.resolve(__dirname, '../../../../paddock-retool-app')
const functions = path.join(appDir, 'backend/paddock')

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const load = async (name: string) =>
  (await import(/* @vite-ignore */ path.join(functions, name))).default as (req: unknown) => Promise<unknown>

const user = { email: 'jo@example.com' }

describe.skipIf(!existsSync(functions))('old and new logic through shadowCompare, on one driver', () => {
  let t: TestDatabase
  const parity: Array<{ action: string; diff: unknown }> = []
  let tamper: ((data: unknown) => unknown) | null = null
  let customer: string, member: string, herd: string, session: string, peakSession: string, noBand: string, corePlan: string, sauna: string, plunge: string

  beforeAll(async () => {
    process.env.STAFF_API_KEY = KEY
    t = await startTestDatabase()
    holder.db = t.db
    const { db } = t
    await insert(db, 'staff', { first_name: 'A', last_name: 'B', email: user.email, role: 'staff', can_issue_refunds: false, can_manage_pricing: true, active: true })

    vi.stubGlobal('paddockData', {
      query: async (sql: string, params: readonly SqlParam[] = []) => ({ data: await db.query(sql, params) }),
    })
    vi.stubGlobal('paddockWorkerV1', {
      async rawRequest(options: { path: string; method: string; headers: Record<string, string>; queryParams?: Record<string, string>; body?: unknown }) {
        if (options.path === '/api/v1/staff/parity') {
          const entry = options.body as { action: string; diff: unknown }
          parity.push({ action: entry.action, diff: entry.diff })
          return { data: { ok: true, data: { recorded: true }, requestId: 'r' } }
        }
        const route = stepBRoutes[options.path]
        if (!route) throw new Error(`No route ${options.path}`)
        const url = new URL(`https://worker.test${options.path}`)
        for (const [k, v] of Object.entries(options.queryParams ?? {})) url.searchParams.set(k, v)
        const response = await route.handler(
          new Request(url, {
            method: options.method,
            headers: { ...options.headers, authorization: `Bearer ${KEY}` },
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          })
        )
        const body = (await response.json()) as { ok: boolean; data?: unknown }
        if (tamper && body.ok) body.data = tamper(body.data)
        return { data: body }
      },
    })

    const core = await fixtures.band(db, { name: 'Core', price: '20.00' })
    const peak = await fixtures.band(db, { name: 'Peak', price: '25.50' })
    await insert(db, 'membership_band_terms', { membership_level: 'core', band_id: core, credit_eligible: true, discount_percent: '100' })
    await insert(db, 'membership_band_terms', { membership_level: 'core', band_id: peak, credit_eligible: false, discount_percent: '15' })
    await insert(db, 'band_rules', { band_id: core, day_of_week: 1, from_time: '09:00', to_time: '12:00' })
    sauna = await fixtures.serviceType(db, { name: 'Sauna' })
    plunge = await fixtures.serviceType(db, { name: 'Plunge' })
    session = await fixtures.session(db, { service_type_id: sauna, band_id: core })
    peakSession = await fixtures.session(db, { service_type_id: sauna, band_id: peak, start_time: '2030-06-15 18:00:00+00', end_time: '2030-06-15 19:00:00+00' })
    noBand = await fixtures.session(db, { service_type_id: sauna, start_time: '2030-06-15 20:00:00+00', end_time: '2030-06-15 21:00:00+00' })
    corePlan = await fixtures.plan(db, { name: 'Core plan' })
    customer = await fixtures.customer(db)
    member = await fixtures.customer(db)
    herd = await fixtures.customer(db)
    const membership = await fixtures.membership(db, { customer_id: member, plan_id: corePlan, next_renewal_date: '2099-01-01', addon_credits_remaining: 2 })
    await fixtures.membership(db, { customer_id: herd, plan_id: corePlan, is_herd: true, next_renewal_date: '2099-01-01', addon_credits_remaining: 2 })
    await insert(db, 'membership_credit_periods', { membership_id: membership, period_start: '2020-01-01', period_end: '2099-01-01', credits_allocated: 4, is_unlimited: false })
    const passType = await fixtures.passType(db, { name: 'Core pass', level: 'core' })
    await fixtures.pass(db, { customer_id: member, pass_type_id: passType })
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await t.stop()
  })

  beforeEach(() => {
    parity.length = 0
    tamper = null
  })

  async function same(name: string, params?: unknown) {
    const fn = await load(name)
    const result = await fn({ params, user })
    expect(parity, `${name} ${JSON.stringify(params)}`).toEqual([])
    return result
  }

  it('quoteBookingSeats', async () => {
    await same('quoteBookingSeats', { sessionId: session, customerId: customer, partySize: 1 })
    await same('quoteBookingSeats', { sessionId: session, customerId: member, partySize: 6 })
    await same('quoteBookingSeats', { sessionId: peakSession, customerId: member, partySize: 2 })
    await same('quoteBookingSeats', { sessionId: peakSession, customerId: customer, partySize: 2, newMembershipPlanId: corePlan })
    await same('quoteBookingSeats', { sessionId: noBand, customerId: customer, partySize: 1 })
    await same('quoteBookingSeats', { sessionId: session, customerId: customer, partySize: 0 })
  })

  it('quoteEvent', async () => {
    const open = await fixtures.event(t.db)
    const membersOnly = await fixtures.event(t.db, { access: 'members_only' })
    const membersFirst = await fixtures.event(t.db, {
      access: 'members_first',
      public_release_at: '2099-09-05 18:00:00+00',
      starts_at: '2099-10-15 18:00:00+00',
      ends_at: '2099-10-15 20:00:00+00',
      refund_cutoff_at: '2099-10-14 18:00:00+00',
    })
    const full = await fixtures.event(t.db, { capacity: 2, places_booked: 2 })
    for (const eventId of [open, membersOnly, membersFirst, full, '00000000-0000-4000-8000-000000000009']) {
      for (const customerId of [customer, member, herd]) {
        await same('quoteEvent', { eventId, customerId, places: 2, accountHolderAttending: true })
        await same('quoteEvent', { eventId, customerId, places: 0, accountHolderAttending: false })
        await same('quoteEvent', { eventId, customerId, places: 1, accountHolderAttending: true, newMembershipFrequency: 'monthly' })
      }
    }
  })

  it('validatePromoCode', async () => {
    const lines = [
      { key: 'seat:0', itemType: 'booking', amount: 20, isMemberPriced: true },
      { key: 'seat:1', itemType: 'booking', amount: 20, isMemberPriced: false },
      { key: 'addon:0', itemType: 'addon', amount: 9.99, isMemberPriced: false },
    ]
    const codes = [
      await fixtures.promo(t.db, { code: 'PCT-10', discount_type: 'percentage', discount_value: '10' }),
      await fixtures.promo(t.db, { code: 'FIX-7', discount_type: 'fixed', discount_value: '7', applies_on_member_prices: true }),
      await fixtures.promo(t.db, { code: 'OLD-1', expires_on: '2020-01-01' }),
      await fixtures.promo(t.db, { code: 'MIN-1', min_spend: '1000' }),
      await fixtures.promo(t.db, { code: 'OFF-1', active: false }),
    ]
    expect(codes).toHaveLength(5)
    for (const code of ['PCT-10', 'fix-7', 'OLD-1', 'MIN-1', 'OFF-1', 'NOPE']) {
      await same('validatePromoCode', { code, customerId: customer, lines })
    }
    await same('validatePromoCode', { code: 'PCT-10', customerId: customer, lines: [] })
  })

  it('getCustomerCreditOptions', async () => {
    await same('getCustomerCreditOptions', { customerId: customer })
    await same('getCustomerCreditOptions', { customerId: member })
    await same('getCustomerCreditOptions', { customerId: member, sessionId: session })
    await same('getCustomerCreditOptions', { customerId: member, sessionId: peakSession })
    await same('getCustomerCreditOptions', { customerId: herd })
  })

  it('getCustomerCreditOptions: unlimited, and memberships and passes that tie', async () => {
    const period = { period_start: '2020-01-01', period_end: '2099-01-01', credits_allocated: 2, is_unlimited: false }
    const unlimited = await fixtures.customer(t.db)
    const unlimitedId = await fixtures.membership(t.db, { customer_id: unlimited, plan_id: corePlan })
    await insert(t.db, 'membership_credit_periods', { ...period, membership_id: unlimitedId, credits_allocated: 0, is_unlimited: true })

    const tied = await fixtures.customer(t.db)
    for (const id of ['ffffffff-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001']) {
      await fixtures.membership(t.db, { id, customer_id: tied, plan_id: corePlan })
      await insert(t.db, 'membership_credit_periods', { ...period, membership_id: id })
    }
    const passType = await fixtures.passType(t.db, { level: 'all_access' })
    for (const id of ['ffffffff-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002']) {
      await fixtures.pass(t.db, { id, customer_id: tied, pass_type_id: passType })
    }

    await same('getCustomerCreditOptions', { customerId: unlimited })
    await same('getCustomerCreditOptions', { customerId: tied })
    const options = (await same('getCustomerCreditOptions', { customerId: tied, sessionId: session })) as { membershipsWithSessionCredit: Array<{ id: string }> }
    expect(options.membershipsWithSessionCredit[0]?.id).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('getAvailableSessions', async () => {
    const booked = await fixtures.session(t.db, { service_type_id: plunge, start_time: '2030-06-16 10:00:00+00', end_time: '2030-06-16 11:00:00+00' })
    await fixtures.session(t.db, { service_type_id: sauna, start_time: '2030-06-16 10:00:00+00', end_time: '2030-06-16 11:00:00+00' })
    await fixtures.booking(t.db, { session_id: booked, customer_id: herd })
    await fixtures.session(t.db, { service_type_id: sauna, start_time: '2020-06-16 10:00:00+00', end_time: '2020-06-16 11:00:00+00', status: 'blocked', blocked_reason: 'Closed' })

    await same('getAvailableSessions', { date: '2030-06-15' })
    await same('getAvailableSessions', { date: '2030-06-15', serviceTypeId: sauna })
    await same('getAvailableSessions', { date: '2030-06-16' })
    await same('getAvailableSessions', { date: '2020-06-16' })
    await same('getAvailableSessions', { date: '2031-01-01' })
  })

  it('getAvailableSessions: sessions at the same time', async () => {
    const twin = await fixtures.serviceType(t.db, { name: 'Sauna' })
    await fixtures.session(t.db, { service_type_id: sauna, start_time: '2030-06-17 10:00:00+00', end_time: '2030-06-17 11:00:00+00' })
    await fixtures.session(t.db, { service_type_id: twin, start_time: '2030-06-17 10:00:00+00', end_time: '2030-06-17 11:00:00+00' })
    await fixtures.session(t.db, { service_type_id: plunge, start_time: '2030-06-17 10:00:00+00', end_time: '2030-06-17 11:00:00+00' })

    expect(await same('getAvailableSessions', { date: '2030-06-17' })).toHaveLength(3)
  })

  it('checkCustomerDayConflict', async () => {
    const day = await fixtures.session(t.db, { service_type_id: sauna, start_time: '2030-09-04 10:00:00+00', end_time: '2030-09-04 11:00:00+00' })
    const later = await fixtures.session(t.db, { service_type_id: sauna, start_time: '2030-09-04 15:00:00+00', end_time: '2030-09-04 16:00:00+00' })
    await fixtures.booking(t.db, { session_id: day, customer_id: customer })

    expect(await same('checkCustomerDayConflict', { customerId: customer, sessionId: later })).toEqual({ conflict: true, date: '04 Sept 2030' })
    await same('checkCustomerDayConflict', { customerId: member, sessionId: later })
  })

  it('checkSessionTimeConflict', async () => {
    const other = await fixtures.session(t.db, { service_type_id: plunge, start_time: '2030-07-01 10:00:00+00', end_time: '2030-07-01 11:00:00+00' })
    await fixtures.booking(t.db, { session_id: other, customer_id: customer })
    const params = { sessionId: session, serviceTypeId: sauna }

    expect(await same('checkSessionTimeConflict', { ...params, startTime: '2030-07-01T10:30:00.000Z', endTime: '2030-07-01T11:30:00.000Z' })).toMatchObject({ conflict: true })
    await same('checkSessionTimeConflict', { ...params, startTime: '2030-07-01T12:00:00.000Z', endTime: '2030-07-01T13:00:00.000Z' })
  })

  it('checkSessionTimeConflict: several conflicts at the same time', async () => {
    const third = await fixtures.serviceType(t.db, { name: 'Third' })
    for (const type of [plunge, third]) {
      const clash = await fixtures.session(t.db, { service_type_id: type, start_time: '2030-07-02 10:00:00+00', end_time: '2030-07-02 11:00:00+00' })
      await fixtures.booking(t.db, { session_id: clash, customer_id: await fixtures.customer(t.db) })
    }

    await same('checkSessionTimeConflict', { sessionId: session, serviceTypeId: sauna, startTime: '2030-07-02T10:00:00.000Z', endTime: '2030-07-02T11:00:00.000Z' })
  })

  it('getPricingConfig', async () => {
    expect(await same('getPricingConfig')).toMatchObject({ canManagePricing: true })
  })

  it('getPostageSettings: a failure on both sides with the same text is not a mismatch', async () => {
    const fn = await load('getPostageSettings')

    await expect(fn({ user })).rejects.toThrow('Postage settings have not been configured yet.')
    expect(parity).toEqual([])

    await t.db.query('INSERT INTO postage_settings (standard_price, express_price, free_shipping_threshold) VALUES ($1, $2, $3)', ['4.95', '9.95', '75.00'])
    await same('getPostageSettings')
  })

  it('a real difference does reach parity, and the screen still gets the old answer', async () => {
    tamper = (data) => ({ ...(data as object), paidTotal: 999 })
    const fn = await load('quoteBookingSeats')

    const result = (await fn({ params: { sessionId: session, customerId: customer, partySize: 1 }, user })) as { paidTotal: number }

    expect(result.paidTotal).toBe(20)
    expect(parity).toEqual([{ action: 'quoteBookingSeats', diff: [{ path: 'paidTotal', oldValue: 20, newValue: 999 }] }])
  })
})
