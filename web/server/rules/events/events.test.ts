import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtures, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { eventBlockMessage } from './event-blocks'
import { quoteEvent } from './quote-event'

let t: TestDatabase
let visitor: string, preHerd: string, herd: string

beforeAll(async () => {
  t = await startTestDatabase()
  const { db } = t
  const plan = await fixtures.plan(db)
  visitor = await fixtures.customer(db)
  preHerd = await fixtures.customer(db)
  herd = await fixtures.customer(db)
  await fixtures.membership(db, { customer_id: preHerd, plan_id: plan })
  await fixtures.membership(db, { customer_id: herd, plan_id: plan, is_herd: true })
})

afterAll(() => t.stop())

const quote = (eventId: string, customerId: string, extra: Partial<Parameters<typeof quoteEvent>[1]> = {}) =>
  quoteEvent(t.db, { eventId, customerId, places: 2, accountHolderAttending: true, ...extra })

describe('quoteEvent', () => {
  it('quotes an open event: the holder at their level, guests at the public price', async () => {
    const event = await fixtures.event(t.db)

    expect(await quote(event, herd)).toEqual({
      blockReason: null,
      blockMessage: null,
      places: [
        { place_no: 1, attendee_type: 'account_holder', price_level: 'herd', unit_price: '20.00' },
        { place_no: 2, attendee_type: 'guest', price_level: 'public', unit_price: '40.00' },
      ],
      total: 60,
      placesLeft: 10,
    })
  })

  it('a holder not attending pays no member price', async () => {
    const event = await fixtures.event(t.db)
    const result = await quote(event, herd, { accountHolderAttending: false })

    expect(result.places.map((p) => [p.attendee_type, p.price_level, p.unit_price])).toEqual([
      ['guest', 'public', '40.00'],
      ['guest', 'public', '40.00'],
    ])
  })

  it('rounds the total to pennies', async () => {
    const event = await fixtures.event(t.db, { price_public: '0.10', price_pre_herd: '0.10', price_herd: '0.10' })

    expect((await quote(event, visitor, { places: 3 })).total).toBe(0.3)
  })

  it('refuses a non-member on a members-only event', async () => {
    const event = await fixtures.event(t.db, { access: 'members_only' })

    expect(await quote(event, visitor)).toEqual({
      blockReason: 'event_members_only',
      blockMessage: 'This event is for members only — the customer needs an active membership.',
      places: [],
      total: 0,
      placesLeft: 10,
    })
    expect((await quote(event, preHerd)).blockReason).toBeNull()
  })

  it('members-first before release: refuses the public with the time spelled out, lets members in', async () => {
    const event = await fixtures.event(t.db, {
      access: 'members_first',
      public_release_at: '2099-09-05 18:00:00+00',
      starts_at: '2099-10-15 18:00:00+00',
      ends_at: '2099-10-15 20:00:00+00',
      refund_cutoff_at: '2099-10-14 18:00:00+00',
    })

    expect(await quote(event, visitor)).toMatchObject({
      blockReason: 'event_not_released_yet',
      blockMessage: 'Members can book now; public booking opens Sat 5 Sept, 6:00 pm.',
      places: [],
    })
    expect((await quote(event, preHerd)).blockReason).toBeNull()
  })

  it('members-first after release is open to everyone', async () => {
    const event = await fixtures.event(t.db, { access: 'members_first', public_release_at: '2020-01-01 09:00:00+00' })

    expect((await quote(event, visitor)).blockReason).toBeNull()
  })

  it('a new monthly membership counts as Pre-Herd, a new yearly as Herd', async () => {
    const event = await fixtures.event(t.db, { access: 'members_only' })

    const monthly = await quote(event, visitor, { places: 1, newMembershipFrequency: 'monthly' })
    expect(monthly).toMatchObject({ blockReason: null, total: 30 })
    expect(monthly.places[0]?.price_level).toBe('pre_herd')

    const yearly = await quote(event, visitor, { places: 1, newMembershipFrequency: 'yearly' })
    expect(yearly.places[0]?.price_level).toBe('herd')
  })

  it('sold out still quotes: the block rule does not look at places, and placesLeft says 0', async () => {
    const event = await fixtures.event(t.db, { capacity: 3, places_booked: 3 })

    expect(await quote(event, visitor, { places: 1 })).toMatchObject({ blockReason: null, placesLeft: 0, total: 40 })
  })

  it('places 0 or a non-integer gives no quote but keeps placesLeft', async () => {
    const event = await fixtures.event(t.db)
    const empty = { blockReason: null, blockMessage: null, places: [], total: 0, placesLeft: 10 }

    expect(await quote(event, visitor, { places: 0 })).toEqual(empty)
    expect(await quote(event, visitor, { places: 1.5 })).toEqual(empty)
  })

  it('reports the other block reasons', async () => {
    const cancelled = await fixtures.event(t.db, { active: false, cancelled_at: '2026-01-01 00:00:00+00' })
    expect(await quote(cancelled, visitor)).toMatchObject({ blockReason: 'event_cancelled', blockMessage: 'That event has been cancelled.' })

    const offSale = await fixtures.event(t.db, { active: false })
    expect(await quote(offSale, visitor)).toMatchObject({ blockReason: 'event_not_on_sale', blockMessage: 'That event is not on sale.' })

    const started = await fixtures.event(t.db, {
      starts_at: '2020-06-15 18:00:00+00',
      ends_at: '2020-06-15 20:00:00+00',
      refund_cutoff_at: '2020-06-14 18:00:00+00',
    })
    expect(await quote(started, visitor)).toMatchObject({ blockReason: 'event_started', blockMessage: 'That event has already started.' })
  })

  it('an unknown event has a null placesLeft', async () => {
    expect(await quote('00000000-0000-4000-8000-000000000009', visitor)).toEqual({
      blockReason: 'event_not_found',
      blockMessage: 'That event no longer exists.',
      places: [],
      total: 0,
      placesLeft: null,
    })
  })
})

describe('eventBlockMessage', () => {
  it('spells out the release time exactly as the staff app does, reading the digits as they are', () => {
    expect(eventBlockMessage('event_not_released_yet', '2026-11-04T09:05:00.000Z')).toBe('Members can book now; public booking opens Wed 4 Nov, 9:05 am.')
    expect(eventBlockMessage('event_not_released_yet', '2026-06-01T12:00:00.000Z')).toBe('Members can book now; public booking opens Mon 1 Jun, 12:00 pm.')
  })

  it('falls back to the plain message with no release time', () => {
    expect(eventBlockMessage('event_not_released_yet', null)).toBe("Members can book now; public booking hasn't opened yet for this event.")
  })
})
