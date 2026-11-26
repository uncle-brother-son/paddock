import { describe, expect, it } from 'vitest'

import type { ShopEventState } from '@/contracts/shop'
import answers from '@/lib/sanity/sample-answers.json'
import type { EventCard as SanityEventCard } from '@/lib/sanity/schemas'
import type { ShopEvent } from '@/lib/shop/read'

import { eventAvailabilityAddress, eventAvailabilityFrom } from './availability'
import { EVENTS_LIST_ID, eventCard, eventLive, eventPrice, eventsListAddress, OTHER_EVENTS_LENGTH, otherEvents, upcomingCards } from './event'
import { CARD_MEMBERS_ONLY, cardSpaces, EVENT_CANCELLED, spacesLine } from './format'

// Brief W75: what an Event page and an EventCard write. Every date is UK time whatever the server's own zone, and
// every price is one W75a's read gave.

const onSale = (over: Partial<ShopEvent> = {}): ShopEvent => ({
  sanityId: 'event-1',
  startsAt: '2026-10-27T16:00:00+00:00',
  endsAt: null,
  spacesLeft: 6,
  access: 'public',
  publicReleaseAt: null,
  state: 'open',
  price: '25.00',
  memberPrice: '20.00',
  ...over,
})

// W78a (WQ69): when an event is, on its page and on its card, is written by the site's one formatter (lib/dates.ts:
// "16:00 - Tuesday 27 October"), and tested there: UK time, both clock changes, and that both of these use it.

describe('the spaces left', () => {
  it('under the button: "6 spaces left", "1 space left"', () => {
    expect([spacesLine(6), spacesLine(1), spacesLine(12)]).toEqual(['6 spaces left', '1 space left', '12 spaces left'])
  })

  it('on a card, in its capitals; a sold-out event says "Sold out" in their place', () => {
    expect([cardSpaces(6), cardSpaces(1), cardSpaces(0)]).toEqual(['6 Spaces Left', '1 Space Left', 'Sold out'])
  })

  it("a cancelled event's own line", () => {
    expect(EVENT_CANCELLED).toBe('This event has been cancelled')
  })
})

describe("an event's price line (WQ58, WQ59)", () => {
  it('open: the public price, and "Member from" the lowest member level', () => {
    expect(eventPrice({ state: 'open', price: '25.00', memberPrice: '20.00' })).toEqual({ now: '£25', member: '£20', memberOnly: false })
    expect(eventPrice({ state: 'open', price: '25.50', memberPrice: '0.00' })).toEqual({ now: '£25.50', member: '£0', memberOnly: false })
  })

  it('"Member from" is said only when a member pays less than everyone else', () => {
    expect(eventPrice({ state: 'open', price: '25.00', memberPrice: '25.00' }).member).toBeNull()
    expect(eventPrice({ state: 'open', price: '25.00', memberPrice: '30.00' }).member).toBeNull()
    // Compared as money, not as words: "100.00" is more than "25.00".
    expect(eventPrice({ state: 'open', price: '100.00', memberPrice: '25.00' }).member).toBe('£25')
    expect(eventPrice({ state: 'open', price: '25.00', memberPrice: null }).member).toBeNull()
  })

  it('sold out, started and cancelled keep the public line', () => {
    for (const state of ['sold_out', 'started', 'cancelled'] as const) expect(eventPrice({ state, price: '25.00', memberPrice: '20.00' })).toEqual({ now: '£25', member: '£20', memberOnly: false })
  })

  it('members only: the member price with "Member Only", in every state it can be in', () => {
    for (const state of ['members_only', 'sold_out', 'started', 'cancelled'] as const) expect(eventPrice({ state, price: null, memberPrice: '20.00' })).toEqual({ now: '£20', member: null, memberOnly: true })
  })

  it('members first, before it opens to everyone: as a members-only one, its public price not shown yet', () => {
    expect(eventPrice({ state: 'not_released_yet', price: '25.00', memberPrice: '20.00' })).toEqual({ now: '£20', member: null, memberOnly: true })
  })

  it('what changes while the page is open is the state, the spaces and the price line', () => {
    expect(eventLive({ state: 'open', spacesLeft: 3, price: '25.00', memberPrice: '20.00' })).toEqual({ state: 'open', spacesLeft: 3, price: { now: '£25', member: '£20', memberOnly: false } })
  })
})

describe('the cards of a list', () => {
  const content = answers.eventCards as SanityEventCard[]
  const second: SanityEventCard = { id: 'event-2', name: 'Aufguss', slug: 'aufguss-3-nov', gallery: [] }

  it("a card: Sanity's name, picture and address, the Worker's date and spaces", () => {
    const card = eventCard(content[0]!, onSale({ spacesLeft: 1 }))
    expect([card.id, card.href, card.name, card.when, card.startsAt, card.spaces]).toEqual(['event-1', '/events/solstice-2026', 'Solstice', '16:00 - Tuesday 27 October', '2026-10-27T16:00:00+00:00', '1 Space Left'])
    expect(card.picture?.alt).toBe('A hoodie')
    expect(eventCard(second, onSale()).picture).toBeNull()
  })

  // W78b (WQ77): the card has a price, and a members only version. Both are the Event page's own price line.
  it('a card has the public price alone: the card is drawn with no "Member from"', () => {
    const card = eventCard(second, onSale())
    expect([card.price, card.membersOnly]).toEqual(['£25', false])
    expect([eventCard(second, onSale({ price: '40.50' })).price, eventCard(second, onSale({ state: 'sold_out', spacesLeft: 0 })).membersOnly]).toEqual(['£40.50', false])
  })

  it('the members only card: a members-only event, and a members-first one before it opens to everyone, with the member price', () => {
    const membersOnly = eventCard(second, onSale({ access: 'members_only', state: 'members_only', price: null }))
    const notReleased = eventCard(second, onSale({ access: 'members_first', state: 'not_released_yet', publicReleaseAt: '2026-10-20T09:00:00+01:00' }))
    expect([membersOnly.price, membersOnly.membersOnly]).toEqual(['£20', true])
    expect([notReleased.price, notReleased.membersOnly]).toEqual(['£20', true])
    // Sold out, a members-only event has no public price still, and keeps the members only card.
    expect(eventCard(second, onSale({ access: 'members_only', state: 'sold_out', spacesLeft: 0, price: null })).membersOnly).toBe(true)
    // A members-first event once it has opened to everyone is any other event.
    const released = eventCard(second, onSale({ access: 'members_first', state: 'open', publicReleaseAt: '2026-10-20T09:00:00+01:00' }))
    expect([released.price, released.membersOnly]).toEqual(['£25', false])
    // A card is told by the same rule as the Event page's price line, whatever the state.
    const states: ShopEventState[] = ['open', 'sold_out', 'not_released_yet', 'members_only', 'started', 'cancelled']
    for (const state of states) {
      const line = eventPrice({ state, price: '25.00', memberPrice: '20.00' })
      const card = eventCard(second, onSale({ state }))
      expect([card.price, card.membersOnly]).toEqual([line.now, line.memberOnly])
    }
    expect(CARD_MEMBERS_ONLY).toBe('Members Only')
  })

  it("the list is the Worker's, in its order (soonest first); an event Sanity does not publish is left out", () => {
    const upcoming = [onSale({ sanityId: 'event-2', startsAt: '2026-11-03T16:00:00+00:00' }), onSale({ sanityId: 'not-in-sanity' }), onSale({ sanityId: 'event-1', startsAt: '2026-12-21T19:30:00+00:00', spacesLeft: 0, state: 'sold_out' })]
    const cards = upcomingCards({ content: [...content, second], upcoming })
    expect(cards.map((card) => [card.id, card.spaces])).toEqual([
      ['event-2', '6 Spaces Left'],
      ['event-1', 'Sold out'],
    ])
    // An event Sanity publishes that the Worker does not list (off sale, started, cancelled) has no card.
    expect(upcomingCards({ content: [...content, second], upcoming: [] })).toEqual([])
  })

  it('Other events: the next upcoming ones, never the page\'s own, up to three', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const cards = ids.map((id) => eventCard({ ...second, id }, onSale()))
    expect(OTHER_EVENTS_LENGTH).toBe(3)
    expect(otherEvents(cards, 'b').map((card) => card.id)).toEqual(['a', 'c', 'd'])
    expect(otherEvents(cards, 'not-listed').map((card) => card.id)).toEqual(['a', 'b', 'c'])
    expect(otherEvents(cards.slice(0, 1), 'a')).toEqual([])
  })

  it('"All Events" goes to the events list on the page that holds it, by that page\'s own slug', () => {
    expect(EVENTS_LIST_ID).toBe('events')
    expect(eventsListAddress({ slug: 'exclusive-hire', isHome: false })).toBe('/exclusive-hire#events')
    expect(eventsListAddress({ slug: 'home', isHome: true })).toBe('/#events')
  })
})

describe("the event's route, asked again after load", () => {
  const data = { event: 'event-1', spacesLeft: 2, state: 'open', publicReleaseAt: null, price: '25.00', memberPrice: '20.00' }

  it('asks the public route for the event by its id', () => {
    expect(eventAvailabilityAddress('event-1')).toBe('/api/v1/shop/event-availability?event=event-1')
    expect(eventAvailabilityAddress('a b&c')).toBe('/api/v1/shop/event-availability?event=a%20b%26c')
  })

  it("takes the route's answer for this event", () => {
    expect(eventAvailabilityFrom({ ok: true, data, requestId: 'r' }, 'event-1')).toEqual(data)
    const states: ShopEventState[] = ['open', 'sold_out', 'not_released_yet', 'members_only', 'started', 'cancelled']
    for (const state of states) expect(eventAvailabilityFrom({ ok: true, data: { ...data, state } }, 'event-1')?.state).toBe(state)
    expect(eventAvailabilityFrom({ ok: true, data: { ...data, price: null, publicReleaseAt: '2026-10-20T09:00:00+01:00' } }, 'event-1')).toMatchObject({ price: null })
  })

  it('anything else is nothing, and the page keeps what it was sent with', () => {
    const refused = { ok: false, error: { code: 'NOT_FOUND', message: "This event isn't on sale." } }
    const wrong = [null, 'no', refused, { ok: true }, { ok: true, data: { ...data, event: 'event-2' } }, { ok: true, data: { ...data, spacesLeft: -1 } }, { ok: true, data: { ...data, spacesLeft: 1.5 } }]
    const shapes = [{ ok: true, data: { ...data, spacesLeft: '2' } }, { ok: true, data: { ...data, state: 'paused' } }, { ok: true, data: { ...data, price: 25 } }, { ok: true, data: { ...data, memberPrice: undefined } }]
    for (const answer of [...wrong, ...shapes]) expect(eventAvailabilityFrom(answer, 'event-1'), JSON.stringify(answer)).toBeNull()
  })
})
