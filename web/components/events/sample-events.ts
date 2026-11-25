import type { ShopEventAvailabilityRouteOutput } from '@/contracts/shop'
import { eventLive, type EventCardView, type EventView } from '@/lib/events/event'
import { whenLine } from '@/lib/dates'
import { cardSpaces } from '@/lib/events/format'
import type { SizedImage } from '@/lib/sanity/image'
import type { RichText } from '@/lib/sanity/schemas'
import type { GalleryItem } from '@/lib/shop/product'

// For the Events stories only: an event and its cards as Figma draws them ("Aufguss Session with Henry", £25, Member
// from £20, 16:00 - Tuesday 27 October, 6 spaces left), with pictures drawn on the spot so a story fetches nothing.
// The site's own come from Sanity and the Worker.

/** A drawn stand-in for an event's photograph, 4 by 5 on Object/Product BG: a sauna stove with its steam. */
const stove = (colour: string, steam = 3): SizedImage => {
  const wisps = Array.from({ length: steam }, (_, index) => `<path d="M${150 + index * 50} 250c-20-30 20-50 0-80s20-50 0-80" fill="none" stroke="#f1eee3" stroke-width="6" stroke-linecap="round"/>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#d6d2c2"/><rect x="120" y="280" width="160" height="140" rx="6" fill="${colour}"/>${wisps}</svg>`
  const src = `data:image/svg+xml,${encodeURIComponent(svg)}`
  return { src, srcSet: `${src} 400w`, width: 400, height: 500 }
}

const MOSS = '#193028'
const MUD = '#6e6258'
const BLACK = '#222222'

/** Figma's event: a Tuesday in October, after the clocks go back (16:00 in London is 16:00 UTC). */
export const SAMPLE_STARTS_AT = '2026-10-27T16:00:00+00:00'

const block = (key: string, text: string, bullet = false): RichText[number] => ({
  _type: 'block',
  _key: key,
  style: 'normal',
  listItem: bullet ? 'bullet' : null,
  level: bullet ? 1 : null,
  children: [{ _type: 'span', _key: `${key}-1`, text, marks: [] }],
  markDefs: [],
})

const SAMPLE_DESCRIPTION: RichText = [
  block('d1', 'An hour of Aufguss with Henry: three rounds of steam and scent, towel work between them, and the plunge after each.'),
  block('d2', 'Bring swimwear and two towels', true),
  block('d3', 'Arrive fifteen minutes before', true),
  block('d4', 'Water and tea are included', true),
]

const SAMPLE_TERMS: RichText = [
  block('t1', 'Places are for those aged 18 and over. Each person attending signs the waiver before the event.'),
  block('t2', 'A place can be cancelled for store credit until the day before the event', true),
  block('t3', 'If we have to cancel, every place is refunded in full', true),
]

const galleryItem = (key: string, colour: string, steam: number, alt: string): GalleryItem => ({ key, picture: { desktop: stove(colour, steam), mobile: stove(colour, steam), alt }, video: null })

/** What the Worker says of the sample event (W75a), for a state: its spaces, and the prices a visitor is shown. */
export const sampleAvailability = (over: Partial<ShopEventAvailabilityRouteOutput> = {}): ShopEventAvailabilityRouteOutput => ({
  event: 'event-aufguss',
  spacesLeft: 6,
  state: 'open',
  publicReleaseAt: null,
  price: '25.00',
  memberPrice: '20.00',
  ...over,
})

/** Figma's Event (1684:41950): Aufguss Session with Henry, £25 (Member from £20), 6 spaces left, two pictures. */
export const SAMPLE_EVENT: EventView = {
  id: 'event-aufguss',
  name: 'Aufguss Session with Henry',
  gallery: [galleryItem('g1', MOSS, 3, 'The sauna stove, with steam rising'), galleryItem('g2', MUD, 2, 'The stove again, from the side')],
  when: whenLine(SAMPLE_STARTS_AT),
  startsAt: SAMPLE_STARTS_AT,
  live: eventLive(sampleAvailability()),
  description: SAMPLE_DESCRIPTION,
  terms: SAMPLE_TERMS,
  extraWaiver: 'Aufguss is hot. Tell the sauna master if you feel unwell, and leave the sauna at once if you need to.\n\nDo not take part if you are pregnant or have a heart condition.',
}

/** The sample event in one of the Worker's states. */
export const sampleEvent = (over: Partial<ShopEventAvailabilityRouteOutput>): EventView => ({ ...SAMPLE_EVENT, live: eventLive(sampleAvailability(over)) })

/** CTA's states (Figma 1684:39401, Type=event), by the Worker's state for a visitor who isn't signed in. */
export const SAMPLE_EVENTS = {
  open: SAMPLE_EVENT,
  oneSpaceLeft: sampleEvent({ spacesLeft: 1 }),
  soldOut: sampleEvent({ state: 'sold_out', spacesLeft: 0 }),
  // A members-only event has no public price.
  membersOnly: sampleEvent({ state: 'members_only', price: null }),
  // Members first, before it opens to everyone: it has a public price, which is not shown yet.
  notReleasedYet: sampleEvent({ state: 'not_released_yet', publicReleaseAt: '2026-10-20T09:00:00+01:00' }),
  started: sampleEvent({ state: 'started' }),
  cancelled: sampleEvent({ state: 'cancelled' }),
}

type CardOptions = { name?: string; startsAt?: string; spacesLeft?: number; colour?: string; steam?: number }

/** A card as Figma's EventCard, its date by the site's one rule (WQ69): "16:00 - Tuesday 27 October", "6 Spaces Left", "Aufguss Session with Henry". */
export function sampleEventCard(id: string, { name = 'Aufguss Session with Henry', startsAt = SAMPLE_STARTS_AT, spacesLeft = 6, colour = MOSS, steam = 3 }: CardOptions = {}): EventCardView {
  return { id, href: `/events/${id}`, name, picture: { ...stove(colour, steam), alt: '' }, when: whenLine(startsAt), startsAt, spaces: cardSpaces(spacesLeft) }
}

export const SAMPLE_EVENT_CARDS = {
  plain: sampleEventCard('aufguss-27-oct'),
  oneSpaceLeft: sampleEventCard('aufguss-3-nov', { startsAt: '2026-11-03T16:00:00+00:00', spacesLeft: 1, colour: MUD }),
  soldOut: sampleEventCard('winter-solstice', { name: 'Winter Solstice Sauna', startsAt: '2026-12-21T19:30:00+00:00', spacesLeft: 0, colour: BLACK, steam: 2 }),
  // In British Summer Time: 18:00 in London is 17:00 UTC.
  summer: sampleEventCard('midsummer-plunge', { name: 'Midsummer Plunge', startsAt: '2027-06-22T18:00:00+01:00', spacesLeft: 12, colour: MUD, steam: 1 }),
  noPicture: { ...sampleEventCard('breathwork', { name: 'Breathwork with Ana', startsAt: '2026-11-14T10:00:00+00:00', spacesLeft: 8 }), picture: null },
}

/** Other events, as drawn: three cards. */
export const SAMPLE_OTHER_EVENTS: EventCardView[] = [SAMPLE_EVENT_CARDS.oneSpaceLeft, SAMPLE_EVENT_CARDS.soldOut, SAMPLE_EVENT_CARDS.summer]

/** An events list of seven, soonest first: three rows on a desktop, the last with one card. */
export const SAMPLE_EVENT_LIST: EventCardView[] = [
  SAMPLE_EVENT_CARDS.plain,
  SAMPLE_EVENT_CARDS.oneSpaceLeft,
  SAMPLE_EVENT_CARDS.noPicture,
  sampleEventCard('aufguss-17-nov', { startsAt: '2026-11-17T16:00:00+00:00', spacesLeft: 4 }),
  SAMPLE_EVENT_CARDS.soldOut,
  sampleEventCard('new-year-plunge', { name: 'New Year Plunge', startsAt: '2027-01-01T11:00:00+00:00', spacesLeft: 20, colour: MUD, steam: 1 }),
  SAMPLE_EVENT_CARDS.summer,
]

/** Where "All Events" goes in the stories: the events list on Exclusive Hire (WQ60). */
export const SAMPLE_LIST_ADDRESS = '/exclusive-hire#events'
