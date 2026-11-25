import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as availabilityRoute } from '@/app/api/v1/shop/event-availability/route'
import { shopEventAvailabilityRouteOutputSchema, type EventBlockReason, type ShopEventAvailabilityRouteOutput } from '@/contracts'
import type { Db } from '@/server/db'
import { EVENT_BLOCK_MESSAGES } from '@/server/rules/events/event-blocks'
import { quoteEvent } from '@/server/rules/events/quote-event'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { listShopEvents, readShopEvent, readShopEvents, shopEvent, shopEventPrices, shopEventState, type ShopEvent } from './events'
import { SHOP_WORDS } from './failure-messages'

// Brief W75a: the website's event reads and their public route, on the live schema.
vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown, closed: 0 }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {
    holder.closed += 1
  },
}))

let database: TestDatabase
let db: Db

beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())
beforeEach(async () => {
  await database.pg.exec('RESET ROLE; TRUNCATE events CASCADE; SET ROLE paddock_worker;')
  holder.closed = 0
})

/** An event on sale in 2099, £40 / £30 / £20, 10 places, unless `row` says otherwise. Answers its database id. */
const event = (sanityId: string | null, row: Record<string, unknown> = {}): Promise<string> => fixtures.event(db, { sanity_event_id: sanityId, ...row })

const MEMBERS_FIRST = { access: 'members_first', public_release_at: '2099-05-01 09:00:00+00' }
const RELEASED = { access: 'members_first', public_release_at: '2020-05-01 09:00:00+00' }
const STARTED = { starts_at: '2020-06-15 18:00:00+00', ends_at: '2020-06-15 20:00:00+00', refund_cutoff_at: '2020-06-14 18:00:00+00' }
/** As the event's cancel leaves one (events/cancel-event.ts). */
const CANCELLED = { active: false, cancelled_at: '2026-11-01 10:00:00+00', cancel_reason: 'Henry is ill' }

async function one(sanityId: string): Promise<ShopEvent> {
  const found = await shopEvent(db, sanityId)
  expect(found, sanityId).not.toBeNull()
  return found as ShopEvent
}
const listed = async (): Promise<string[]> => (await listShopEvents(db)).map(({ sanityId }) => sanityId)

const ask = async (query: string) => {
  const response = await availabilityRoute(new Request(`https://worker.test/api/v1/shop/event-availability${query}`))
  const body = (await response.json()) as { ok: boolean; data?: ShopEventAvailabilityRouteOutput; error?: { code: string; message: string; field?: string } }
  return { status: response.status, cacheControl: response.headers.get('Cache-Control'), body }
}

/** Every field name anywhere in an answer. */
const fieldsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(fieldsOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, inner]) => [name, ...fieldsOf(inner)]) : []
const FORBIDDEN_FIELD = /attend|book|guest|customer|stripe|capacity|waiver|reason|cancelled/i

describe("an event's state, for a visitor who isn't signed in", () => {
  it('open, with everything the site is told and nothing else', async () => {
    await event('aufguss', { capacity: 10, places_booked: 3 })
    expect(await one('aufguss')).toEqual({
      sanityId: 'aufguss',
      startsAt: '2099-06-15T18:00:00+01:00',
      endsAt: '2099-06-15T20:00:00+01:00',
      spacesLeft: 7,
      access: 'public',
      publicReleaseAt: null,
      state: 'open',
      price: '40.00',
      memberPrice: '20.00',
    })
    expect(await listShopEvents(db)).toEqual([await one('aufguss')])
  })

  it('one space left is still open; full is sold out, and stays in the list', async () => {
    await event('last', { capacity: 4, places_booked: 3 })
    await event('full', { capacity: 4, places_booked: 4 })
    expect(await one('last')).toMatchObject({ state: 'open', spacesLeft: 1 })
    expect(await one('full')).toMatchObject({ state: 'sold_out', spacesLeft: 0, price: '40.00', memberPrice: '20.00' })
    expect((await listed()).sort()).toEqual(['full', 'last'])
  })

  it('members first: not released yet, with the release time; open once released', async () => {
    await event('before', MEMBERS_FIRST)
    await event('after', RELEASED)
    expect(await one('before')).toMatchObject({ state: 'not_released_yet', access: 'members_first', publicReleaseAt: '2099-05-01T09:00:00+01:00', price: '40.00', memberPrice: '20.00' })
    expect(await one('after')).toMatchObject({ state: 'open', access: 'members_first', publicReleaseAt: '2020-05-01T09:00:00+01:00' })
    expect((await listed()).sort()).toEqual(['after', 'before'])
  })

  it('a release time left on an event that is not members first is not given', async () => {
    await event('public', { public_release_at: '2099-05-01 09:00:00+00' })
    expect(await one('public')).toMatchObject({ state: 'open', publicReleaseAt: null })
  })

  it('members only: in the list, with no public price', async () => {
    await event('members', { access: 'members_only' })
    expect(await one('members')).toMatchObject({ state: 'members_only', access: 'members_only', price: null, memberPrice: '20.00' })
    expect(await listed()).toEqual(['members'])
  })

  it('full comes before the two members\' states: nobody can book it', async () => {
    await event('members', { access: 'members_only', capacity: 2, places_booked: 2 })
    await event('before', { ...MEMBERS_FIRST, capacity: 2, places_booked: 2 })
    expect(await one('members')).toMatchObject({ state: 'sold_out', access: 'members_only', price: null })
    expect(await one('before')).toMatchObject({ state: 'sold_out', access: 'members_first', publicReleaseAt: '2099-05-01T09:00:00+01:00' })
  })

  it('started and cancelled are read by id for their own page, full or not, and never listed (WQ59)', async () => {
    await event('started', STARTED)
    await event('started-full', { ...STARTED, capacity: 2, places_booked: 2 })
    await event('cancelled', CANCELLED)
    await event('cancelled-past', { ...STARTED, ...CANCELLED })
    await event('cancelled-members', { ...CANCELLED, access: 'members_only', capacity: 2, places_booked: 2 })
    for (const id of ['started', 'started-full']) expect((await one(id)).state, id).toBe('started')
    for (const id of ['cancelled', 'cancelled-past', 'cancelled-members']) expect((await one(id)).state, id).toBe('cancelled')
    expect(await listed()).toEqual([])
  })

  it('starts exactly when the database says it has: by the London clock, the minute it begins', async () => {
    const startIn = (sanityId: string, minutes: number) =>
      db.query(
        `UPDATE events SET starts_at = ((now() AT TIME ZONE 'Europe/London') + make_interval(mins => $2::int)) AT TIME ZONE 'UTC', ends_at = NULL,
           refund_cutoff_at = ((now() AT TIME ZONE 'Europe/London') - interval '1 day') AT TIME ZONE 'UTC'
         WHERE sanity_event_id = $1`,
        [sanityId, minutes]
      )
    await event('now')
    await event('soon')
    await startIn('now', 0)
    await startIn('soon', 1)
    expect([(await one('now')).state, (await one('soon')).state]).toEqual(['started', 'open'])
    expect((await one('now')).endsAt).toBeNull()
    expect(await listed()).toEqual(['soon'])
  })

  it('off sale, with no Sanity document, or cancelled before it was ever complete enough to sell: not read at all', async () => {
    await event('off', { active: false })
    await event(null)
    await event('no-price', { ...CANCELLED, price_public: null })
    await event('no-date', { ...CANCELLED, starts_at: null, ends_at: null, refund_cutoff_at: null })
    await event('no-places', { ...CANCELLED, capacity: null })
    await event('no-release', { ...CANCELLED, access: 'members_first' })
    for (const id of ['off', 'no-price', 'no-date', 'no-places', 'no-release', 'unknown']) expect(await shopEvent(db, id), id).toBeNull()
    expect(await listed()).toEqual([])
  })

  it("every reason the block rule has, with a place and without one: the rule's own list, so a new reason fails here", () => {
    const states = Object.fromEntries(
      [...(Object.keys(EVENT_BLOCK_MESSAGES) as EventBlockReason[]), null].map((reason) => [String(reason), [shopEventState(reason, 1), shopEventState(reason, 0)]])
    )
    expect(states).toEqual({
      event_not_found: [null, null],
      event_not_on_sale: [null, null],
      event_cancelled: ['cancelled', 'cancelled'],
      event_started: ['started', 'started'],
      event_members_only: ['members_only', 'sold_out'],
      event_not_released_yet: ['not_released_yet', 'sold_out'],
      null: ['open', 'sold_out'],
    })
  })
})

describe('spaces left', () => {
  it('never below 0, whatever the row says', async () => {
    // The table refuses more places than its capacity; the read doesn't lean on that.
    await database.pg.exec('RESET ROLE; ALTER TABLE events DROP CONSTRAINT events_places_within_capacity; SET ROLE paddock_worker;')
    await event('over', { capacity: 4, places_booked: 6 })
    expect(await one('over')).toMatchObject({ spacesLeft: 0, state: 'sold_out' })
    expect((await ask('?event=over')).body.data).toMatchObject({ spacesLeft: 0, state: 'sold_out' })
    await database.pg.exec('RESET ROLE; TRUNCATE events CASCADE; ALTER TABLE events ADD CONSTRAINT events_places_within_capacity CHECK ((capacity IS NULL) OR (places_booked <= capacity)); SET ROLE paddock_worker;')
  })
})

describe("times: the moment, with the UK's own offset", () => {
  it.each([
    ['2027-01-02 16:00:00+00', '2027-01-02T16:00:00+00:00', '2027-01-02T16:00:00.000Z'],
    ['2027-07-02 16:00:00+00', '2027-07-02T16:00:00+01:00', '2027-07-02T15:00:00.000Z'],
    ['2027-03-28 00:30:00+00', '2027-03-28T00:30:00+00:00', '2027-03-28T00:30:00.000Z'],
    ['2027-03-28 02:30:00+00', '2027-03-28T02:30:00+01:00', '2027-03-28T01:30:00.000Z'],
  ])('%s as kept is %s, and reads the same digits in UK time', async (kept, answered, instant) => {
    await event('e', { starts_at: kept, ends_at: null, refund_cutoff_at: '2026-12-01 00:00:00+00' })
    const { startsAt } = await one('e')
    expect([startsAt, new Date(startsAt).toISOString()]).toEqual([answered, instant])
    const shown = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' }).format(new Date(startsAt))
    expect(shown).toBe(kept.slice(0, 16))
  })
})

describe("prices for display, all from quote_event's rule", () => {
  it.each([
    ['Herd the lower', { price_pre_herd: '30.00', price_herd: '20.00' }, '20.00'],
    ['Pre-Herd the lower', { price_pre_herd: '15.00', price_herd: '20.00' }, '15.00'],
    ['as money, not as text', { price_pre_herd: '9.50', price_herd: '10.00' }, '9.50'],
    ['free to a member', { price_pre_herd: '10.00', price_herd: '0.00' }, '0.00'],
  ])('the member price is the lowest member level set: %s', async (_label, row, memberPrice) => {
    await event('e', { price_public: '40.00', ...row })
    expect(await one('e')).toMatchObject({ price: '40.00', memberPrice })
  })

  it('one level set is that one; none set is no member price; members only has no public price', () => {
    expect(shopEventPrices('public', { public: '40.00', preHerd: '30.00', herd: null })).toEqual({ price: '40.00', memberPrice: '30.00' })
    expect(shopEventPrices('public', { public: '40.00', preHerd: null, herd: '20.00' })).toEqual({ price: '40.00', memberPrice: '20.00' })
    expect(shopEventPrices('members_first', { public: '40.00', preHerd: null, herd: null })).toEqual({ price: '40.00', memberPrice: null })
    expect(shopEventPrices('members_only', { public: '40.00', preHerd: '30.00', herd: '20.00' })).toEqual({ price: null, memberPrice: '20.00' })
  })

  it('they are what the order\'s own quote charges a visitor, a Pre-Herd member and a Herd member', async () => {
    const id = await event('e', { price_public: '25.00', price_pre_herd: '20.00', price_herd: '15.00' })
    const plan = await fixtures.plan(db)
    const charged: string[] = []
    for (const herd of [null, false, true]) {
      const customer = await fixtures.customer(db)
      if (herd !== null) await fixtures.membership(db, { customer_id: customer, plan_id: plan, is_herd: herd })
      const quote = await quoteEvent(db, { eventId: id, customerId: customer, places: 1, accountHolderAttending: true })
      charged.push(quote.places[0]?.unit_price ?? '')
    }
    expect(charged).toEqual(['25.00', '20.00', '15.00'])
    expect(await one('e')).toMatchObject({ price: charged[0], memberPrice: charged[2] })
  })

  it('a price changed in quote_event itself is the price shown: the columns are not read for it', async () => {
    await event('e')
    const [was] = await db.query<{ source: string }>("SELECT pg_get_functiondef('public.quote_event'::regproc) AS source")
    await database.pg.exec(`RESET ROLE; ${(was?.source ?? '').replace('ELSE e.price_public', 'ELSE e.price_public + 1').replace('THEN e.price_herd', 'THEN e.price_herd + 2')}; SET ROLE paddock_worker;`)
    expect(await one('e')).toMatchObject({ price: '41.00', memberPrice: '22.00' })
    await database.pg.exec(`RESET ROLE; ${was?.source ?? ''}; SET ROLE paddock_worker;`)
    expect(await one('e')).toMatchObject({ price: '40.00', memberPrice: '20.00' })
  })
})

describe('lists (WQ60)', () => {
  it('upcoming only, soonest first, then by name', async () => {
    const at = (day: string) => ({ starts_at: `2099-${day} 18:00:00+00`, ends_at: null, refund_cutoff_at: '2099-01-01 00:00:00+00' })
    await event('third', { ...at('06-20'), name: 'C' })
    await event('second-b', { ...at('06-10'), name: 'B' })
    await event('second-a', { ...at('06-10'), name: 'A', capacity: 1, places_booked: 1 })
    await event('first', { ...at('03-01'), name: 'Z', access: 'members_only' })
    await event('started', STARTED)
    await event('cancelled', { ...CANCELLED, ...at('02-01') })
    await event('off', { active: false, ...at('02-01') })
    expect(await listed()).toEqual(['first', 'second-a', 'second-b', 'third'])
  })

  it('none is an empty list', async () => {
    expect(await listShopEvents(db)).toEqual([])
  })
})

describe('GET /api/v1/shop/event-availability', () => {
  it('answers the spaces, the state and the prices now, with no sign-in, never cached', async () => {
    const id = await event('e0bd43f4-1f25-461a-93aa-3c6559e55835', { capacity: 10, places_booked: 0, price_public: '25.00', price_pre_herd: '20.00', price_herd: '15.00' })
    await event('other')
    const query = '?event=e0bd43f4-1f25-461a-93aa-3c6559e55835'
    const { status, cacheControl, body } = await ask(query)
    expect([status, cacheControl]).toEqual([200, 'no-store'])
    expect(body.data).toEqual({ event: 'e0bd43f4-1f25-461a-93aa-3c6559e55835', spacesLeft: 10, state: 'open', publicReleaseAt: null, price: '25.00', memberPrice: '15.00' })
    await db.query('UPDATE events SET places_booked = 10 WHERE id = $1::uuid', [id])
    expect((await ask(query)).body.data).toMatchObject({ spacesLeft: 0, state: 'sold_out' })
  })

  it('the release time goes with "not released yet" alone', async () => {
    await event('before', MEMBERS_FIRST)
    await event('after', RELEASED)
    await event('full', { ...MEMBERS_FIRST, capacity: 1, places_booked: 1 })
    const answers = []
    for (const id of ['before', 'after', 'full']) answers.push((await ask(`?event=${id}`)).body.data)
    expect(answers.map((data) => [data?.state, data?.publicReleaseAt])).toEqual([['not_released_yet', '2099-05-01T09:00:00+01:00'], ['open', null], ['sold_out', null]])
  })

  it('a started event and a cancelled one still answer; a members-only one gives no public price', async () => {
    await event('started', STARTED)
    await event('cancelled', CANCELLED)
    await event('members', { access: 'members_only' })
    const answers = []
    for (const id of ['started', 'cancelled', 'members']) answers.push((await ask(`?event=${id}`)).body.data)
    expect(answers.map((data) => [data?.state, data?.price])).toEqual([['started', '40.00'], ['cancelled', '40.00'], ['members_only', null]])
  })

  it('holds no attendee, booking or Stripe detail, and neither do the reads', async () => {
    const id = await event('e', { name: 'SECRET-NAME', capacity: 8731, places_booked: 2 })
    const customer = await fixtures.customer(db, { email: 'secret@example.test', stripe_customer_id: 'cus_secret' })
    const booking = await insert(db, 'event_bookings', { event_id: id, customer_id: customer, places: 2, price_paid: '61.23', status: 'confirmed' })
    await insert(db, 'event_attendees', { event_booking_id: booking, attendee_type: 'guest', name: 'SECRET-GUEST', email: 'guest@example.test', price_level: 'public', unit_price: '40.00' })
    await event('cancelled', { ...CANCELLED, cancel_reason: 'SECRET-REASON' })
    const answers = [(await ask('?event=e')).body, (await ask('?event=cancelled')).body, await readShopEvents(), await readShopEvent('e'), await readShopEvent('cancelled')]
    for (const answer of answers) {
      expect(fieldsOf(answer).filter((name) => FORBIDDEN_FIELD.test(name))).toEqual([])
      expect(JSON.stringify(answer)).not.toMatch(/SECRET|secret|8731|61\.23|example\.test|"(cus|pi|prod|price)_/)
      expect(JSON.stringify(answer)).not.toContain(id)
      expect(JSON.stringify(answer)).not.toContain(booking)
    }
    expect(Object.keys((await ask('?event=e')).body.data ?? {}).sort()).toEqual(['event', 'memberPrice', 'price', 'publicReleaseAt', 'spacesLeft', 'state'])
    // The check sees one, and the route's contract refuses one.
    const bad = ['attendees', 'booking_id', 'places_booked', 'customerEmail', 'stripe_price_id', 'capacity', 'cancel_reason']
    expect(fieldsOf(Object.fromEntries(bad.map((name) => [name, 1]))).filter((name) => FORBIDDEN_FIELD.test(name))).toEqual(bad)
    const answer = { event: 'e', spacesLeft: 1, state: 'open', publicReleaseAt: null, price: '40.00', memberPrice: null }
    expect(shopEventAvailabilityRouteOutputSchema.safeParse(answer).success).toBe(true)
    for (const name of bad) expect(shopEventAvailabilityRouteOutputSchema.safeParse({ ...answer, [name]: 1 }).success, name).toBe(false)
    expect(shopEventAvailabilityRouteOutputSchema.safeParse({ ...answer, spacesLeft: -1 }).success).toBe(false)
  })

  it.each([
    ['none', ''],
    ['an empty one', '?event='],
    ['a space', '?event=e%201'],
    ['SQL', "?event=e'%3B--"],
    ['a path', '?event=..%2Fstaff'],
    ['one starting with a dot', '?event=.e'],
    ['one too long', `?event=${'a'.repeat(129)}`],
    ['two', '?event=e-1&event=e-2'],
  ])('refuses an event that is not a well-formed id (%s): 400, and nothing is read', async (_label, query) => {
    const spy = vi.spyOn(db, 'query')
    const { status, cacheControl, body } = await ask(query)
    expect([status, cacheControl, body.ok, body.error?.code, body.error?.field]).toEqual([400, 'no-store', false, 'VALIDATION', 'event'])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('an unknown event and one that was never on sale are refused the same way: 404', async () => {
    await event('off', { active: false })
    await event('never', { ...CANCELLED, price_herd: null })
    for (const id of ['unknown', 'off', 'never']) {
      const { status, cacheControl, body } = await ask(`?event=${id}`)
      expect([status, cacheControl, body.error?.code, body.error?.message]).toEqual([404, 'no-store', 'NOT_FOUND', SHOP_WORDS.eventNotOnSale])
    }
  })

  it("the database's own id is not an address", async () => {
    const id = await event('e')
    expect((await ask(`?event=${id}`)).status).toBe(404)
  })
})

describe('readShopEvents and readShopEvent, for a page to call', () => {
  it('each on a connection of its own, closed, a failed read included', async () => {
    await event('e')
    await event('cancelled', CANCELLED)
    expect((await readShopEvents()).map(({ sanityId }) => sanityId)).toEqual(['e'])
    expect(holder.closed).toBe(1)
    expect([(await readShopEvent('cancelled'))?.state, await readShopEvent('unknown')]).toEqual(['cancelled', null])
    expect(holder.closed).toBe(3)
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('down'))
    await expect(readShopEvents()).rejects.toThrow('down')
    expect(holder.closed).toBe(4)
    spy.mockRestore()
  })
})
