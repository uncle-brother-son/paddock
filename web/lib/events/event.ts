import type { ShopEventAvailabilityRouteOutput, ShopEventState } from '@/contracts/shop'
import type { Event, EventCard as SanityEventCard, EventsSettings, RichText } from '@/lib/sanity/schemas'
import { cardPictures, type CardPicture } from '@/lib/shop/cards'
import { inPence, pounds } from '@/lib/shop/money'
import { galleryItems, type GalleryItem } from '@/lib/shop/product'
import type { ShopEvent } from '@/lib/shop/read'

import { whenLine } from '@/lib/dates'

import { cardSpaces } from './format'

// W75: what an Event page and an EventCard show (Figma 1684:41950, 1684:42018, 329:7588), made from Sanity's event
// (name, words, pictures) and the Worker's (W75a: date, spaces, state, prices). Nothing here reads either, and every
// price is one W75a's read gave: this only writes them as the designs do.

/** The id of the events list's section (WQ60): what "All Events" scrolls to, as `/exclusive-hire#events`. */
export const EVENTS_LIST_ID = 'events'

/**
 * An event's price line as Figma's CTA draws it (Type=event).
 * - `memberOnly` false: the public price, and "(Member from £X)" when the lowest member level pays less (WQ58).
 * - `memberOnly` true ("member only signed out", 1709:48988): the member price and "Member Only".
 */
export type EventPrice = { now: string | null; member: string | null; memberOnly: boolean }

type Priced = Pick<ShopEventAvailabilityRouteOutput, 'state' | 'price' | 'memberPrice'>

/**
 * The price line for a visitor who isn't signed in. A members-only event has no public price; a members-first one
 * has, but until it opens to everyone only a member can book it, so it shows as a members-only one (WQ59). W75a gives
 * a member price whether or not it is the lower: "Member from" is said only when it is (comparing two of the Worker's
 * figures, never working one out).
 */
export function eventPrice({ state, price, memberPrice }: Priced): EventPrice {
  if (price === null || state === 'members_only' || state === 'not_released_yet') {
    return { now: memberPrice === null ? null : pounds(memberPrice), member: null, memberOnly: true }
  }
  const lower = memberPrice !== null && inPence(memberPrice) < inPence(price)
  return { now: pounds(price), member: lower ? pounds(memberPrice) : null, memberOnly: false }
}

/** What of an event changes while its page is open: asked again from the route once the page has loaded. */
export type EventLive = { state: ShopEventState; spacesLeft: number; price: EventPrice }

export const eventLive = (event: Priced & { spacesLeft: number }): EventLive => ({ state: event.state, spacesLeft: event.spacesLeft, price: eventPrice(event) })

export type EventView = {
  /** The Sanity document's id: what the availability route and the bag are told. */
  id: string
  name: string
  gallery: GalleryItem[]
  /** "16:00 - Tuesday 27 October", UK time (WQ69). */
  when: string
  /** The moment it starts, for the page's <time>. */
  startsAt: string
  live: EventLive
  description: RichText
  /** Events settings' terms summary, the same on every event (WQ17). */
  terms: RichText
  /** The event's own extra waiver, when it has one: shown after the summary (WQ17). */
  extraWaiver: string | null
}

type EventContent = { event: Event; onSale: ShopEvent; settings: EventsSettings | null }

export function eventView({ event, onSale, settings }: EventContent): EventView {
  return {
    id: event.id,
    name: event.name,
    gallery: galleryItems(event.gallery),
    when: whenLine(onSale.startsAt),
    startsAt: onSale.startsAt,
    live: eventLive(onSale),
    description: event.description,
    terms: settings?.termsSummary ?? [],
    extraWaiver: event.extraWaiver?.trim() || null,
  }
}

/** An EventCard (Figma 329:7588): its picture, "16:00 - Tuesday 27 October" (WQ69), "6 Spaces Left" and its name; one link to the event. */
export type EventCardView = {
  id: string
  href: string
  name: string
  /** The gallery's first picture (a video's poster stands for it), or none yet. */
  picture: CardPicture | null
  when: string
  startsAt: string
  /** "6 Spaces Left", "1 Space Left", or "Sold out". */
  spaces: string
}

/** A card is a third of a desktop window (8 of the grid's 24 columns) and the whole of a phone's. */
export const EVENT_CARD_SIZES = '(min-width: 768px) 33vw, 100vw'

export function eventCard(content: SanityEventCard, event: Pick<ShopEvent, 'startsAt' | 'spacesLeft'>): EventCardView {
  return {
    id: content.id,
    href: `/events/${content.slug}`,
    name: content.name,
    picture: cardPictures(content.gallery).picture,
    when: whenLine(event.startsAt),
    startsAt: event.startsAt,
    spaces: cardSpaces(event.spacesLeft),
  }
}

/**
 * The events a list shows (WQ17, WQ60): every upcoming event the Worker lists (on sale, not cancelled, not started;
 * sold-out and members-only ones stay), in its order, soonest first, that is also published in Sanity with an address.
 */
export function upcomingCards({ content, upcoming }: { content: SanityEventCard[]; upcoming: ShopEvent[] }): EventCardView[] {
  const published = new Map(content.map((one) => [one.id, one]))
  return upcoming.flatMap((event) => {
    const one = published.get(event.sanityId)
    return one ? [eventCard(one, event)] : []
  })
}

/** Cards in the Other events row, as drawn (Figma "UpSellRow", Type=events, 1402:50607). */
export const OTHER_EVENTS_LENGTH = 3

/** Other events (WQ17): the next upcoming events, soonest first, never this one, up to the row's length. */
export const otherEvents = (cards: EventCardView[], id: string, length: number = OTHER_EVENTS_LENGTH): EventCardView[] => cards.filter((card) => card.id !== id).slice(0, length)

/** Where "All Events" goes: the events list on the page that holds it (WQ60), the address made from Sanity's own slug. */
export const eventsListAddress = (page: { slug: string; isHome: boolean }): string => `${page.isHome ? '/' : `/${page.slug}`}#${EVENTS_LIST_ID}`
