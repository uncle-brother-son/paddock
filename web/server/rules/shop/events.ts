// Brief W75a (Wayne's WQ17, WQ59, WQ60; WQ58): what the website reads about events. Reads only. An event's name, words
// and pictures are Sanity's: each row is joined to its document by its Sanity id, so a row with none is left out.
//
// Nothing is decided here. Whether a visitor can book is event_booking_block_reason's answer and every price is
// quote_event's, the two functions New Order and checkout use, asked as somebody with no account. Every row is built
// field by field: never an attendee, a booking, the capacity or a Stripe id.
import 'server-only'
import type { EventBlockReason, ShopEventAvailabilityRouteOutput, ShopEventState } from '@/contracts'
import type { Queryable } from '@/server/db'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { ApiError } from '@/server/http/errors'
import { namedRead } from '@/server/rules/admin/read'
import { lowest } from './display-prices'
import { SHOP_WORDS } from './failure-messages'

export type ShopEventAccess = 'public' | 'members_first' | 'members_only'

export interface ShopEvent {
  sanityId: string
  /** The moment it starts: ISO with the UK's own offset ("2027-07-02T18:00:00+01:00"), so format it in Europe/London. */
  startsAt: string
  /** Null when no end is set. */
  endsAt: string | null
  /** Never below 0. Given in every state. */
  spacesLeft: number
  access: ShopEventAccess
  /** When a members-first event opens to everyone, as `startsAt` is written; null for any other. */
  publicReleaseAt: string | null
  /** For a visitor who isn't signed in. */
  state: ShopEventState
  /** What a visitor pays for a place; null for a members-only event. */
  price: string | null
  /** "Member from": the lowest member level's price (WQ58). */
  memberPrice: string | null
}

interface EventRow extends Record<string, unknown> {
  sanity_event_id: string
  starts_at: string
  ends_at: string | null
  places_left: number
  access: ShopEventAccess
  public_release_at: string | null
  reason: EventBlockReason | null
  price_public: string
  price_pre_herd: string
  price_herd: string
}

/** Event times are kept as London wall-clock digits labelled UTC. This is the real moment, as ISO with London's offset then. */
export const londonIso = (column: string): string => {
  const wall = `(${column} AT TIME ZONE 'UTC')`
  return `to_char(${wall}, 'YYYY-MM-DD"T"HH24:MI:SS') || '+' || to_char(${wall} - ((${wall} AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC'), 'HH24:MI')`
}

/**
 * One place's price, from quote_event: for nobody with an account, and for a holder with a new membership, which is
 * how that function is asked for a level (monthly is Pre-Herd, yearly is Herd). It raises on an event without all
 * three prices, and the reads below leave such an event out.
 */
const quoted = (attending: boolean, frequency: 'monthly' | 'yearly' | null): string =>
  `(SELECT q.unit_price::text FROM quote_event(e.id, NULL::uuid, 1, ${attending ? 'true' : 'false'}, ${frequency === null ? 'NULL::text' : `'${frequency}'`}) q)`

/**
 * An event on sale, or a cancelled one (cancelling takes it off sale). Only a complete event can go on sale
 * (events_on_sale_complete), so one cancelled before it was complete was never on sale and has no page.
 */
const READABLE = `e.sanity_event_id IS NOT NULL AND (e.active OR e.cancelled_at IS NOT NULL)
    AND e.starts_at IS NOT NULL AND e.capacity IS NOT NULL
    AND e.price_public IS NOT NULL AND e.price_pre_herd IS NOT NULL AND e.price_herd IS NOT NULL
    AND (e.access <> 'members_first' OR e.public_release_at IS NOT NULL)`

const EVENTS_SQL = `SELECT e.sanity_event_id, ${londonIso('e.starts_at')} AS starts_at, ${londonIso('e.ends_at')} AS ends_at,
    GREATEST(e.capacity - e.places_booked, 0) AS places_left, e.access, ${londonIso('e.public_release_at')} AS public_release_at, why.reason,
    ${quoted(false, null)} AS price_public, ${quoted(true, 'monthly')} AS price_pre_herd, ${quoted(true, 'yearly')} AS price_herd
  FROM events e CROSS JOIN LATERAL (SELECT event_booking_block_reason(e.id, NULL::uuid, NULL::text) AS reason) why
  WHERE ${READABLE}`

/** On sale, not cancelled and not started, soonest first (WQ60). */
const UPCOMING_SQL = `${EVENTS_SQL} AND e.active AND why.reason IS DISTINCT FROM 'event_started'
  ORDER BY e.starts_at, e.name, e.id`

const ONE_SQL = `${EVENTS_SQL} AND e.sanity_event_id = $1`

/**
 * The state from the rule's own reason and the places left. Full comes after cancelled and started and before the two
 * members' reasons: a full event can't be booked by anybody, so it doesn't ask a visitor to sign in. Null: the visitor
 * isn't shown it.
 */
export function shopEventState(reason: EventBlockReason | null, spacesLeft: number): ShopEventState | null {
  switch (reason) {
    case 'event_not_found':
    case 'event_not_on_sale':
      return null
    case 'event_cancelled':
      return 'cancelled'
    case 'event_started':
      return 'started'
    case 'event_members_only':
      return spacesLeft > 0 ? 'members_only' : 'sold_out'
    case 'event_not_released_yet':
      return spacesLeft > 0 ? 'not_released_yet' : 'sold_out'
    case null:
      return spacesLeft > 0 ? 'open' : 'sold_out'
  }
}

/** The prices shown: no public price on a members-only event, and the lowest member level set. */
export function shopEventPrices(access: ShopEventAccess, levels: { public: string | null; preHerd: string | null; herd: string | null }): Pick<ShopEvent, 'price' | 'memberPrice'> {
  return { price: access === 'members_only' ? null : levels.public, memberPrice: lowest([levels.preHerd, levels.herd]) }
}

function eventsOf(rows: readonly EventRow[]): ShopEvent[] {
  return rows.flatMap((row) => {
    const state = shopEventState(row.reason, row.places_left)
    if (state === null) return []
    return [
      {
        sanityId: row.sanity_event_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        spacesLeft: row.places_left,
        access: row.access,
        publicReleaseAt: row.access === 'members_first' ? row.public_release_at : null,
        state,
        ...shopEventPrices(row.access, { public: row.price_public, preHerd: row.price_pre_herd, herd: row.price_herd }),
      },
    ]
  })
}

/** The events a list shows: on sale, not cancelled and not started, soonest first. Sold-out and members-only ones stay (WQ17). */
export async function listShopEvents(db: Queryable): Promise<ShopEvent[]> {
  return eventsOf(await namedRead<EventRow>(db, { name: 'shop.events', sql: UPCOMING_SQL }))
}

/** One event by its Sanity id, a started or cancelled one included (WQ59). Null when it is unknown or not on sale. */
export async function shopEvent(db: Queryable, sanityEventId: string): Promise<ShopEvent | null> {
  return eventsOf(await namedRead<EventRow>(db, { name: 'shop.event', sql: ONE_SQL, params: [sanityEventId] }))[0] ?? null
}

/** One event's spaces, state and prices now (`GET /api/v1/shop/event-availability`). Unknown and not on sale are refused in the same words. */
export async function shopEventAvailability(db: Queryable, sanityEventId: string): Promise<ShopEventAvailabilityRouteOutput> {
  const event = await shopEvent(db, sanityEventId)
  if (!event) throw new ApiError('NOT_FOUND', SHOP_WORDS.eventNotOnSale, { field: 'event' })
  return {
    event: event.sanityId,
    spacesLeft: event.spacesLeft,
    state: event.state,
    publicReleaseAt: event.state === 'not_released_yet' ? event.publicReleaseAt : null,
    price: event.price,
    memberPrice: event.memberPrice,
  }
}

/** A read on a connection of its own, closed whatever happens. */
async function onItsOwn<T>(read: (db: Queryable) => Promise<T>): Promise<T> {
  const db = openRequestDb()
  try {
    return await read(db)
  } finally {
    await closeRequestDb(db)
  }
}

/** The events a list shows, on a connection of its own, for a page to call (no HTTP). */
export const readShopEvents = (): Promise<ShopEvent[]> => onItsOwn(listShopEvents)

/** One event for its own page, on a connection of its own (no HTTP). Null: no page. */
export const readShopEvent = (sanityEventId: string): Promise<ShopEvent | null> => onItsOwn((db) => shopEvent(db, sanityEventId))
