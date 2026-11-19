// New in W47 (G-plan 4.7; the W26a review's R2, Q39, the W35 audit's F1 and row 5, W43 "Noticed" 5, the W45 audit's
// row 54): the "Money still to refund" list. Money owed is card refund money that never reached the customer (Stripe
// refused the refund, never got it, or failed it later). It lives in `orders.refund_owed_amount` and
// `bookings.refund_owed_amount`, and until W47 it was shown only on the order or the booking itself, which the default
// screens don't list (a refunded order, a cancelled or lapsed booking, a cancelled event booking). This read lists
// every one, so staff no longer need to know where to look and the lead's live counts stop being needed.
//
// - An order and a booking each appear once. An event booking has no money owed of its own: its money is its order's
//   (E-plan 4.4), so it is shown beside that order, never as a line of its own.
// - "How long it has been owed" is read from the records that raise it (a claim finished with money owed, a refund
//   that failed later): the first one since money was last taken off (Refund the rest, It already arrived), or, when
//   none is later than that (part of it was taken off and the rest stayed), the newest one before. Null when no
//   record says: nothing the Worker writes leaves money owed without one.
// - Below it, for information, the money a lapse kept (Q48: inside 24 hours of the session, or after it started),
//   from each `booking.lapsed` row. None of that is owed; the words name Adjust store credit as the goodwill route.
//
// A read: nothing is written. Any active staff member (the route), as the stuck list.
import 'server-only'
import type { LapsedKeptItem, MoneyOwedEventBooking, MoneyOwedItem, MoneyOwedOutput } from '@/contracts'
import type { Queryable, SqlParam } from '@/server/db'
import { BOOKING_LAPSED } from '@/server/rules/bookings/cancel'
import { lapseFacts, type LapsedDetails } from '@/server/rules/bookings/lapse-facts'
import { MONEY_OWED_WORDS } from './failure-messages'

/** How far back the money kept on lapsed bookings is listed: it is for information, and nothing is done with it. */
export const LAPSED_KEPT_DAYS = 90

const round2 = (n: number): number => Math.round(n * 100) / 100
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ''))
const name = (row: { first_name: string; last_name: string }): string => `${row.first_name} ${row.last_name}`.trim()

/** Every order with money owed. */
const ORDERS_OWED_SQL = `
SELECT o.id, o.customer_id, o.refund_owed_amount::text AS owed, c.first_name, c.last_name
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.refund_owed_amount > 0
ORDER BY o.created_at, o.id`

/** The event bookings the order (`$1`) paid for: each has an event line on it. */
const ORDER_EVENT_BOOKINGS_SQL = `
SELECT DISTINCT eb.id, eb.event_id, e.name, e.starts_at, eb.status
FROM order_line_items oli
JOIN event_bookings eb ON eb.id = oli.event_booking_id
JOIN events e ON e.id = eb.event_id
WHERE oli.order_id = $1::uuid AND oli.item_type = 'event'
ORDER BY e.starts_at, eb.id`

/**
 * Every booking with money owed, whatever its status, and whether it lapsed (a `booking.lapsed` row, or the reason
 * the database's old sweep wrote).
 */
const BOOKINGS_OWED_SQL = `
SELECT b.id, b.customer_id, b.status, b.start_time, b.refund_owed_amount::text AS owed, c.first_name, c.last_name,
       (b.cancel_reason = 'membership_lapsed'
        OR EXISTS (SELECT 1 FROM audit_log l WHERE l.action = '${BOOKING_LAPSED}' AND l.entity_type = 'booking' AND l.entity_id = b.id::text)) AS lapsed
FROM bookings b
JOIN customers c ON c.id = b.customer_id
WHERE b.refund_owed_amount > 0
ORDER BY b.start_time, b.id`

/**
 * When the money on a subject became owed. `raised`: the records that raise it; `lowered`: the newest record that
 * took money off it. The first raise after that, else the newest raise.
 */
const since = (raised: string, lowered: string): string => `
WITH raised AS (${raised}),
lowered AS (${lowered})
SELECT COALESCE(
  (SELECT min(r.at) FROM raised r WHERE r.at > COALESCE((SELECT l.at FROM lowered l), '-infinity'::timestamptz)),
  (SELECT max(r.at) FROM raised r)
) AS since`

/** A booking (`$1`, as text): a claim finished with money owed (the press, reconcile, a close by hand), or a refund that failed later. */
const BOOKING_OWED_SINCE_SQL = since(
  `SELECT a.at FROM audit_log a
   WHERE a.entity_type = 'booking' AND a.entity_id = $1::text
     AND a.action IN ('booking.refund_finished', 'booking.refund_failed_later')
     AND COALESCE((a.details->>'owed')::numeric, 0) > 0`,
  `SELECT max(a.at) AS at FROM audit_log a
   WHERE a.entity_type = 'booking' AND a.entity_id = $1::text
     AND (a.action = 'booking.refund_owed_arrived' OR (a.action = 'booking.refund_claimed' AND a.details->>'kind' = 'refund_owed'))`
)

/**
 * An order (`$1`, as text; `$2` its event bookings, as text): the same for its own claims and for the claims of the
 * event bookings it paid for, whose money owed is the order's.
 */
const ORDER_OWED_SINCE_SQL = since(
  `SELECT a.at FROM audit_log a
   WHERE ((a.entity_type = 'order' AND a.entity_id = $1::text AND a.action IN ('order.refund_finished', 'order.refund_failed_later'))
       OR (a.entity_type = 'event_booking' AND a.entity_id = ANY($2::text[]) AND a.action IN ('event_booking.refund_finished', 'event_booking.refund_failed_later')))
     AND COALESCE((a.details->>'owed')::numeric, 0) > 0`,
  `SELECT max(a.at) AS at FROM audit_log a
   WHERE a.entity_type = 'order' AND a.entity_id = $1::text
     AND (a.action = 'order.owed_arrived' OR (a.action = 'order.refund_claimed' AND a.details->>'kind' = 'refund_owed'))`
)

/**
 * The bookings a lapse cancelled in the last `$1` days with nothing given back, each with its newest
 * `booking.lapsed` row. Read from the bookings (few are cancelled in any 90 days), then their rows by the index.
 */
const LAPSED_KEPT_SQL = `
SELECT b.id AS booking_id, b.customer_id, b.start_time, c.first_name, c.last_name, l.at, l.details
FROM bookings b
JOIN customers c ON c.id = b.customer_id
JOIN LATERAL (
  SELECT a.at, a.details FROM audit_log a
  WHERE a.action = '${BOOKING_LAPSED}' AND a.entity_type = 'booking' AND a.entity_id = b.id::text
  ORDER BY a.at DESC
  LIMIT 1
) l ON true
WHERE b.status = 'cancelled' AND b.cancelled_at > now() - make_interval(days => $1::int)
  AND l.details->>'back' = 'false'
ORDER BY l.at DESC, b.id`

interface Owed {
  item: MoneyOwedItem
  /** For the order of the list: the one owed longest first; one with no date first of all (nothing says how long). */
  at: number
}

const daysBetween = (from: string, now: number): number => Math.max(0, Math.floor((now - new Date(from).getTime()) / 86_400_000))

/** GET /api/v1/staff/money-owed. */
export async function moneyOwedList(db: Queryable, { now = Date.now }: { now?: () => number } = {}): Promise<MoneyOwedOutput> {
  const at = now()
  const owed: Owed[] = []
  const sinceOf = async (sql: string, params: readonly SqlParam[]): Promise<string | null> => {
    const row = (await db.query<{ since: unknown }>(sql, params))[0]
    return row?.since ? iso(row.since) : null
  }
  const timing = (owedSince: string | null): Pick<MoneyOwedItem, 'owedSince' | 'daysOwed'> => ({ owedSince, daysOwed: owedSince ? daysBetween(owedSince, at) : null })

  for (const row of await db.query<{ id: string; customer_id: string; owed: string; first_name: string; last_name: string }>(ORDERS_OWED_SQL)) {
    const eventBookings = (await db.query<{ id: string; event_id: string; name: string; starts_at: unknown; status: string }>(ORDER_EVENT_BOOKINGS_SQL, [row.id])).map(
      (found): MoneyOwedEventBooking => ({ eventBookingId: found.id, eventId: found.event_id, eventName: found.name, startsAt: iso(found.starts_at), status: found.status })
    )
    const owedSince = await sinceOf(ORDER_OWED_SINCE_SQL, [row.id, eventBookings.map((one) => one.eventBookingId)])
    owed.push({
      at: owedSince ? new Date(owedSince).getTime() : 0,
      item: {
        on: 'order',
        orderId: row.id,
        bookingId: null,
        customerId: row.customer_id,
        customerName: name(row),
        amount: round2(Number.parseFloat(row.owed)),
        ...timing(owedSince),
        ...(eventBookings.length > 0 ? { eventBookings } : {}),
        where: eventBookings.length > 0 ? MONEY_OWED_WORDS.orderWithEvent : MONEY_OWED_WORDS.order,
      },
    })
  }

  for (const row of await db.query<{ id: string; customer_id: string; status: string; start_time: unknown; owed: string; first_name: string; last_name: string; lapsed: boolean | null }>(BOOKINGS_OWED_SQL)) {
    const owedSince = await sinceOf(BOOKING_OWED_SINCE_SQL, [row.id])
    const lapsed = row.lapsed === true && row.status === 'cancelled'
    owed.push({
      at: owedSince ? new Date(owedSince).getTime() : 0,
      item: {
        on: 'booking',
        orderId: null,
        bookingId: row.id,
        customerId: row.customer_id,
        customerName: name(row),
        amount: round2(Number.parseFloat(row.owed)),
        ...timing(owedSince),
        bookingStatus: row.status,
        lapsed,
        ...(row.start_time ? { sessionStart: iso(row.start_time) } : {}),
        where: lapsed ? MONEY_OWED_WORDS.lapsedBooking : row.status === 'cancelled' ? MONEY_OWED_WORDS.cancelledBooking : MONEY_OWED_WORDS.booking,
      },
    })
  }

  const lapsedKept: LapsedKeptItem[] = []
  for (const row of await db.query<{ booking_id: string; customer_id: string; start_time: unknown; first_name: string; last_name: string; at: unknown; details: LapsedDetails | null }>(LAPSED_KEPT_SQL, [LAPSED_KEPT_DAYS])) {
    const facts = lapseFacts(iso(row.at), row.details)
    if (!(facts.kept > 0)) continue
    lapsedKept.push({
      bookingId: row.booking_id,
      customerId: row.customer_id,
      customerName: name(row),
      lapsedAt: facts.at,
      sessionStart: iso(row.start_time),
      kept: facts.kept,
      keptBecause: facts.keptBecause,
      words: facts.words,
    })
  }

  // The one owed longest first. The sort is stable, so lines with the same moment keep the order read (orders, then bookings).
  const items = owed.sort((a, b) => a.at - b.at).map((one) => one.item)
  return {
    owed: items,
    total: round2(items.reduce((total, item) => total + item.amount, 0)),
    lapsedKept,
    keptDays: LAPSED_KEPT_DAYS,
    keptNote: MONEY_OWED_WORDS.keptNote,
  }
}
