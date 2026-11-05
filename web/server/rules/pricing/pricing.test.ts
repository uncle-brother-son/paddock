import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '@/server/http/errors'
import { fixtures, HIGH_ID, insert, LOW_ID, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { getPostageSettings } from './postage-settings'
import { getPricingConfig } from './pricing-config'
import { quoteBookingSeats } from './quote-booking-seats'

let t: TestDatabase
let core: string, peak: string
let session: string, peakSession: string, noBandSession: string, privateSession: string
let visitor: string, coreMember: string, corePlan: string, allAccessPlan: string, unknownPlanLevel: string

beforeAll(async () => {
  t = await startTestDatabase()
  const { db } = t
  core = await fixtures.band(db, { name: 'Core', price: '20.00' })
  peak = await fixtures.band(db, { name: 'Peak', price: '25.50' })
  const type = await fixtures.serviceType(db)
  session = await fixtures.session(db, { service_type_id: type, band_id: core })
  peakSession = await fixtures.session(db, { service_type_id: type, band_id: peak, start_time: '2030-06-16 10:00:00+00', end_time: '2030-06-16 11:00:00+00' })
  noBandSession = await fixtures.session(db, { service_type_id: type, start_time: '2030-06-17 10:00:00+00', end_time: '2030-06-17 11:00:00+00' })
  privateSession = await fixtures.session(db, { service_type_id: type, band_id: core, type: 'private', start_time: '2030-06-18 10:00:00+00', end_time: '2030-06-18 11:00:00+00' })

  await insert(db, 'membership_band_terms', { membership_level: 'core', band_id: core, credit_eligible: true, discount_percent: '100' })
  await insert(db, 'membership_band_terms', { membership_level: 'core', band_id: peak, credit_eligible: false, discount_percent: '15.00' })
  await insert(db, 'membership_band_terms', { membership_level: 'all_access', band_id: peak, credit_eligible: true, discount_percent: '100' })

  corePlan = await fixtures.plan(db, { level: 'core' })
  allAccessPlan = await fixtures.plan(db, { level: 'all_access' })
  unknownPlanLevel = await fixtures.plan(db, { level: null })
  visitor = await fixtures.customer(db)
  coreMember = await fixtures.customer(db)
  await fixtures.membership(db, { customer_id: coreMember, plan_id: corePlan })
})

afterAll(() => t.stop())

describe('quoteBookingSeats', () => {
  it('prices a non-member at the band price, with strings for money', async () => {
    const quote = await quoteBookingSeats(t.db, { sessionId: session, customerId: visitor, partySize: 1 })

    expect(quote.unpriced).toBe(false)
    expect(quote.seats).toEqual([
      {
        seat_no: 1,
        seat_kind: 'account_holder',
        band_id: core,
        list_price: '20.00',
        unit_price: '20.00',
        credit_eligible: false,
        membership_level: null,
        discount_percent: '0',
      },
    ])
    expect(quote.band).toMatchObject({ band_id: core, band_name: 'Core', band_price: '20.00', band_overridden: false })
    expect(quote.paidTotal).toBe(20)
  })

  it('gives a member their terms on seat 1 only', async () => {
    const quote = await quoteBookingSeats(t.db, { sessionId: session, customerId: coreMember, partySize: 3 })

    expect(quote.seats.map((s) => [s.seat_kind, s.unit_price, s.credit_eligible, s.membership_level])).toEqual([
      ['account_holder', '0.00', true, 'core'],
      ['guest', '20.00', false, null],
      ['guest', '20.00', false, null],
    ])
    expect(quote.paidTotal).toBe(40)
  })

  it('a Core member on Peak pays the discounted price, with no credit', async () => {
    const quote = await quoteBookingSeats(t.db, { sessionId: peakSession, customerId: coreMember, partySize: 1 })

    expect(quote.seats[0]).toMatchObject({ list_price: '25.50', unit_price: '21.68', credit_eligible: false, discount_percent: '15.00' })
  })

  it('sums party sizes 1 and 6 as a plain float sum', async () => {
    const one = await quoteBookingSeats(t.db, { sessionId: peakSession, customerId: visitor, partySize: 1 })
    const six = await quoteBookingSeats(t.db, { sessionId: peakSession, customerId: visitor, partySize: 6 })

    expect(one.seats).toHaveLength(1)
    expect(six.seats).toHaveLength(6)
    expect(six.paidTotal).toBe([1, 2, 3, 4, 5, 6].reduce((sum) => sum + Number.parseFloat('25.50'), 0))
  })

  it('paidTotal is the plain float sum, not rounded to pence', async () => {
    const cheap = await fixtures.band(t.db, { code: 'cheap', name: 'Cheap', price: '0.10' })
    const type = await fixtures.serviceType(t.db)
    const cheapSession = await fixtures.session(t.db, { service_type_id: type, band_id: cheap })

    const quote = await quoteBookingSeats(t.db, { sessionId: cheapSession, customerId: visitor, partySize: 3 })

    expect(quote.paidTotal).toBe(0.30000000000000004)
  })

  it('a new membership plan replaces seat 1 only (plan_seat_terms)', async () => {
    const quote = await quoteBookingSeats(t.db, { sessionId: peakSession, customerId: visitor, partySize: 2, newMembershipPlanId: allAccessPlan })

    expect(quote.seats[0]).toMatchObject({ seat_kind: 'account_holder', credit_eligible: true, unit_price: '0.00', discount_percent: '100.00', list_price: '25.50', membership_level: null })
    expect(quote.seats[1]).toMatchObject({ unit_price: '25.50' })
  })

  it('a new plan with no terms for the band pays list price', async () => {
    const quote = await quoteBookingSeats(t.db, { sessionId: peakSession, customerId: visitor, partySize: 1, newMembershipPlanId: unknownPlanLevel })

    expect(quote.seats[0]).toMatchObject({ credit_eligible: false, discount_percent: '0', unit_price: '25.50' })
  })

  it('a session with no band is unpriced, with its message', async () => {
    const quote = await quoteBookingSeats(t.db, { sessionId: noBandSession, customerId: visitor, partySize: 1 })

    expect(quote).toEqual({
      seats: [],
      band: { band_id: null, band_code: null, band_name: null, band_price: null, band_overridden: false },
      paidTotal: 0,
      unpriced: true,
      error: 'No band is assigned to this session.',
    })
  })

  it('a session that does not exist is the same, with a null band', async () => {
    const quote = await quoteBookingSeats(t.db, { sessionId: '00000000-0000-4000-8000-000000000009', customerId: visitor, partySize: 1 })

    expect(quote).toEqual({ seats: [], band: null, paidTotal: 0, unpriced: true, error: 'No band is assigned to this session.' })
  })

  it("passes on quote_booking's own refusals as unpriced", async () => {
    const none = await quoteBookingSeats(t.db, { sessionId: session, customerId: visitor, partySize: 0 })
    expect(none).toMatchObject({ seats: [], paidTotal: 0, unpriced: true, error: 'Party size must be at least 1' })

    const privateQuote = await quoteBookingSeats(t.db, { sessionId: privateSession, customerId: visitor, partySize: 1 })
    expect(privateQuote.error).toBe(`Session ${privateSession} is not a public session with a band`)
  })
})

describe('getPricingConfig', () => {
  it('returns the page data in the same order, with the flag it was given', async () => {
    await insert(t.db, 'band_rules', { band_id: core, day_of_week: 2, from_time: '09:00', to_time: '12:00' })
    await insert(t.db, 'band_rules', { band_id: peak, day_of_week: 1, from_time: '17:00:00', to_time: '20:00:00' })

    const allowed = await getPricingConfig(t.db, true)
    const denied = await getPricingConfig(t.db, false)

    expect(allowed.canManagePricing).toBe(true)
    expect(denied.canManagePricing).toBe(false)
    expect(allowed.bandRules.map((r) => [r.day_of_week, r.from_time, r.to_time])).toEqual([
      [1, '17:00:00', '20:00:00'],
      [2, '09:00:00', '12:00:00'],
    ])
    expect(allowed.bands[0]).toMatchObject({ price: expect.any(String), sort_order: expect.any(Number), active: true })
    expect(allowed.membershipTerms[0]?.discount_percent).toEqual(expect.any(String))
    expect(allowed.membershipLevels).toEqual(['all_access', 'core'])
  })
})

describe('getPricingConfig order', () => {
  it('bands go by sort_order, then id', async () => {
    const tiedHigh = await fixtures.band(t.db, { id: HIGH_ID, code: 'tied_high', sort_order: 9 })
    const tiedLow = await fixtures.band(t.db, { id: LOW_ID, code: 'tied_low', sort_order: 9 })
    const first = await fixtures.band(t.db, { code: 'sorted_first', sort_order: 5 })

    const ids = (await getPricingConfig(t.db, true)).bands.map((b) => b.id).filter((id) => [tiedHigh, tiedLow, first].includes(id))

    expect(ids).toEqual([first, LOW_ID, HIGH_ID])
  })

  it('band rules go by day, then start time, then id', async () => {
    await insert(t.db, 'band_rules', { id: HIGH_ID, band_id: core, day_of_week: 5, from_time: '09:00', to_time: '12:00' })
    await insert(t.db, 'band_rules', { id: LOW_ID, band_id: peak, day_of_week: 5, from_time: '09:00', to_time: '11:00' })

    const ids = (await getPricingConfig(t.db, true)).bandRules.filter((r) => r.day_of_week === 5).map((r) => r.id)

    expect(ids).toEqual([LOW_ID, HIGH_ID])
  })

  it('membership terms go by level, then band', async () => {
    const terms = (await getPricingConfig(t.db, true)).membershipTerms.map((m) => `${m.membership_level} ${m.band_id}`)

    expect(terms.length).toBeGreaterThan(2)
    expect(terms).toEqual([...terms].sort())
  })
})

describe('getPostageSettings', () => {
  it('fails as INTERNAL with the old text when there is no row', async () => {
    const err = await getPostageSettings(t.db).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({
      code: 'INTERNAL',
      message: 'Postage settings have not been configured yet. Run the postage_settings migration (CREATE TABLE + seed row) to set them up.',
    })
  })

  it('parses the row into numbers', async () => {
    await t.db.query('INSERT INTO postage_settings (standard_price, express_price, free_shipping_threshold) VALUES ($1, $2, $3)', ['4.95', '9.95', '75.00'])

    expect(await getPostageSettings(t.db)).toEqual({ standardPrice: 4.95, expressPrice: 9.95, freeShippingThreshold: 75 })
  })

  it('fails as INTERNAL with the old text when the table is missing', async () => {
    await t.pg.exec('RESET ROLE; ALTER TABLE postage_settings RENAME TO postage_settings_hidden; SET ROLE paddock_worker;')
    try {
      await expect(getPostageSettings(t.db)).rejects.toMatchObject({
        code: 'INTERNAL',
        message: 'The postage_settings table does not exist yet. Run the postage migration (CREATE TABLE postage_settings + seed row) to set it up.',
      })
    } finally {
      await t.pg.exec('RESET ROLE; ALTER TABLE postage_settings_hidden RENAME TO postage_settings; SET ROLE paddock_worker;')
    }
  })
})
