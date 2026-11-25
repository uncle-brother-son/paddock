import { connection } from 'next/server'
import { cache } from 'react'

import type { Found } from '@/lib/pages/read'
import { readSanity } from '@/lib/sanity/read'
import { movedAddress } from '@/lib/sanity/redirects'
import type { Event, EventsSettings } from '@/lib/sanity/schemas'
import { readShopEventKept, readShopEventsKept } from '@/lib/shop/read'

import { eventsListAddress, eventView, otherEvents, upcomingCards, type EventCardView, type EventView } from './event'

// W75: what an event at /events/[slug] and the events list (the Upcoming Events module) are made of. Names, words and
// pictures are Sanity's; dates, spaces, states and prices are the Worker's (lib/shop/read.ts, at most a minute old).
// Each is read once for a request, though a route asks twice: for its title and for the page itself.

/** Events settings (the terms summary every event shows), or null when it isn't published. */
export const readEventsSettings = cache(async (): Promise<EventsSettings | null> => {
  await connection()
  return readSanity('eventsSettings')
})

/**
 * Every upcoming event as its card, soonest first (WQ60): the Worker's list (on sale, not cancelled, not started;
 * sold-out ones stay), each one that is also published in Sanity. A read that fails throws: never an empty list.
 */
export const readUpcomingEventCards = cache(async (): Promise<EventCardView[]> => {
  await connection()
  const [content, upcoming] = await Promise.all([readSanity('eventCards'), readShopEventsKept()])
  return upcomingCards({ content, upcoming })
})

/** Where "All Events" goes (WQ60): the events list on the page that holds the module, or null while no page does. */
export const readEventsListAddress = cache(async (): Promise<string | null> => {
  await connection()
  const page = await readSanity('eventsListPage')
  return page ? eventsListAddress(page) : null
})

export type EventPage = {
  /** Sanity's event: its address, and its SEO section. */
  event: Event
  view: EventView
  /** The Other events row; empty hides it. */
  others: EventCardView[]
  /** "All Events"; null hides the link. */
  listAddress: string | null
}

/**
 * The event at /events/[slug]: the page, the address it moved to (an old slug, answered with a permanent redirect:
 * W72a), or nothing (a 404). It shows when it is published in Sanity and in the Worker's read by its id: on sale, a
 * started one and a cancelled one included (WQ59: booking is closed, the page stays). Off sale, or never on, is nothing.
 */
export const findEventPage = cache(async (slug: string): Promise<Found<EventPage>> => {
  await connection()
  const event = await readSanity('event', slug)
  if (!event) {
    const movedTo = await movedAddress('event', slug)
    return movedTo ? { page: null, movedTo } : { page: null, movedTo: null }
  }
  const [onSale, settings, cards, listAddress] = await Promise.all([readShopEventKept(event.id), readEventsSettings(), readUpcomingEventCards(), readEventsListAddress()])
  if (!onSale) return { page: null, movedTo: null }
  return { page: { event, view: eventView({ event, onSale, settings }), others: otherEvents(cards, event.id), listAddress }, movedTo: null }
})
