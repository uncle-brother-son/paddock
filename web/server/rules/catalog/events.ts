// W52 (G-plan 1.5, 4.1, 4.3, 4.6; bugs GB11 and GB14; Wayne's Q51; W54a's stale-page rule): Catalog → Events on the
// Worker. Ported from the staff app's getEvents.ts, setEventActive.ts and setEventDetails.ts (frozen at W48 in
// testing/legacy-admin), with their words (server/rules/events/admin-failure-messages.ts).
//
// The read (GB14): an active staff member, through the admin read helper (the old read checked nobody), with named
// columns. Each event also answers its stamp, which the edit dialog sends back with a save.
//
// The two writes (level B): Manage pricing, in the old words; one transaction under the EVENT's own row lock, the
// lock New Order takes before it claims places (orders/locks.ts), a place cancel takes before it releases them
// (refunds/locks.ts), and the whole-event cancel takes (events/cancel-event.ts). So "places are booked" is read while
// no place can be sold or given back, and an edit and a sale never write the same row at once. Each writes an audit
// row with the event before and after, which the old functions never did.
//
// The table's own constraints stay the rules (end after start, cut-off not after start, release before start,
// capacity not below places booked, an on-sale event stays complete): a violation is answered in the old words,
// never as a database error.
//
// Q51 (Wayne, 20 Nov 2026; bug GB11), decided under that lock:
//  - Once a place is booked, the refund cut-off can move later but not earlier: a customer keeps at least the cut-off
//    they booked under. With no cut-off set the event's start is the cut-off (Q43), so the rule compares what the
//    cut-off IS before and after the edit. An earlier one is refused, with the earliest allowed.
//  - A price change applies to new bookings only, as before: a place keeps the price it was sold at (its own row).
//  - A date change is allowed; the dialog reminds staff to tell the attendees (no email is sent).
//
// W52a (Wayne's Q-a and Q-b, 21 Nov 2026; W52 review S1 and S2):
//  - Q-a: an event with places booked may be brought forward to before its cut-off in force, and then the cut-off
//    follows it: it becomes the new start, never earlier than it. Only in that case: the cut-off box itself still
//    can't be moved earlier, and a later date never pulls the cut-off earlier. Example: places sold under a cut-off of
//    14 June 18:00 on an event on 15 June 18:00; the club brings the event forward to 14 June 09:00; the edit saves
//    and the cut-off is 14 June 09:00. The dialog tells staff to tell the attendees and refund anyone who can't come.
//  - Q-b: a postponement leaves the cut-off where it is (the dialog reminds staff it doesn't move with the date).
//  - S1: the refusal names the earliest cut-off as the dialog's box can hold it, rounded UP to the next whole minute
//    when the cut-off in force has seconds (a hand correction in SQL can leave them; the dialog writes whole
//    minutes). The rule itself still compares the moments as they are: never earlier.
//  - S2: the refusal's words follow what changed: the cut-off box moved earlier, or the event left with no cut-off
//    at all. A date brought forward on its own is no longer refused (Q-a).
//
// W54a's rule on the details edit: it writes the event's date, places, access, prices and cut-off back as the page
// loaded them, so the press carries the stamp of those columns and is refused `changed_since` when one of them has
// changed since. The stamp is of those columns only (admin/stamp.ts, fieldsStampSql): a place sold or cancelled
// meanwhile moves `places_booked` and `updated_at` on the same row and must not refuse the edit. On and off sale
// writes one switch, so it carries no stamp.
import 'server-only'
import type { AdminAction, EventActiveRouteOutput, EventDetailsRouteInput, EventDetailsRouteOutput, EventListRouteOutput } from '@/contracts'
import { postgresRefusal, type Db, type Queryable } from '@/server/db'
import { adminRead } from '@/server/rules/admin/read'
import { adminRefusal, requireAdminPermission, type AdminActor } from '@/server/rules/admin/refusal'
import { fieldsStampSql, NO_ROW_STAMP } from '@/server/rules/admin/stamp'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWriteOptions } from '@/server/rules/admin/write'
import { EVENT_ADMIN_NEW_WORDS, EVENT_ADMIN_WORDS } from '@/server/rules/events/admin-failure-messages'

type EventRow = EventListRouteOutput[number]
type EventAnswerRow = EventDetailsRouteOutput['event']

/** An event's row as the old functions answered it, every column by name; prices as the database's text. */
const eventColumnsSql = (alias: string): string => `${alias}.id, ${alias}.sanity_event_id, ${alias}.name, ${alias}.thumbnail_url, ${alias}.has_extra_waiver, ${alias}.starts_at, ${alias}.ends_at,
       ${alias}.capacity, ${alias}.places_booked, ${alias}.access, ${alias}.public_release_at, ${alias}.price_public::text AS price_public,
       ${alias}.price_pre_herd::text AS price_pre_herd, ${alias}.price_herd::text AS price_herd, ${alias}.refund_cutoff_at, ${alias}.active,
       ${alias}.cancelled_at, ${alias}.cancel_reason, ${alias}.created_at, ${alias}.updated_at`
const EVENT_TIMES = ['starts_at', 'ends_at', 'public_release_at', 'refund_cutoff_at', 'cancelled_at', 'created_at', 'updated_at'] as const

/** The columns the details edit writes, in the order the stamp reads them. Exported for its test. */
export const EVENT_DETAILS_COLUMNS = ['starts_at', 'ends_at', 'capacity', 'access', 'public_release_at', 'price_public', 'price_pre_herd', 'price_herd', 'refund_cutoff_at'] as const
const eventStampSql = (alias: string): string => fieldsStampSql(alias, EVENT_DETAILS_COLUMNS)

// --- The read

/** Upcoming first by start time, events with no date yet last, then by name, as before (and by id, so two alike keep one order). */
const EVENT_LIST_SQL = `
SELECT ${eventColumnsSql('e')}, ${eventStampSql('e')} AS stamp
  FROM events e
 ORDER BY e.starts_at ASC NULLS LAST, e.name, e.id`

/**
 * getEvents (`GET catalog/events`): every event, for Catalog → Events and New Order's event picker, each with its
 * stamp. Any active staff member.
 */
export function listEvents(db: Queryable, actor: AdminActor): Promise<EventListRouteOutput> {
  return adminRead<EventRow>(db, { name: 'events.list', needs: 'staff', sql: EVENT_LIST_SQL, times: EVENT_TIMES }, { actor })
}

// --- What the two writes share

const WORDS = EVENT_ADMIN_WORDS
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value))

/** Whether a failed statement was refused by the events table's constraint `name` (its name, or its name in the message, as the old functions looked for it). */
function refusedByConstraint(err: unknown, name: string): boolean {
  const refused = postgresRefusal(err)
  if (!refused) return false
  return (refused.constraint ?? '').includes(name) || refused.message.includes(name)
}

// --- On and off sale

/**
 * setEventActive (`POST catalog/events/:eventId/active`). Manage pricing. One transaction under the event's lock: the
 * switch, and an `event.active_set` audit row with the switch before and after. The table's `events_on_sale_complete`
 * rule refuses an event that isn't finished (no date, capacity, a price or the cut-off missing, or no release time
 * for Members first) or is cancelled, in the old words. Taking an event off sale always works.
 */
export async function setEventActive(db: Db, eventId: string, active: unknown, options: AdminWriteOptions): Promise<EventActiveRouteOutput> {
  const action: AdminAction = 'event.active_set'
  const gone = () => adminRefusal('NOT_FOUND', action, 'event_not_found', WORDS.setEventActive.thatEventNoLongerExists)
  // As the old function read it: anything but `true` is off sale.
  const onSale = active === true
  type Switch = { id: string; active: boolean }
  try {
    return await adminWrite<Switch, Switch, EventActiveRouteOutput>(
      db,
      {
        action,
        needs: 'manage_pricing',
        entity: { type: 'event', id: eventId },
        locks: [{ table: 'events', ids: [eventId] }],
        // One switch: nothing the page read is written back.
        unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
        async before(tx, held) {
          if (!held.events?.length) throw gone()
          const [row] = await tx.query<Switch>('SELECT id, active FROM events WHERE id = $1::uuid', [eventId])
          if (!row) throw gone()
          return row
        },
        async change(tx) {
          const [row] = await tx.query<Switch>('UPDATE events SET active = $1::boolean, updated_at = now() WHERE id = $2::uuid RETURNING id, active', [onSale, eventId])
          if (!row) throw new Error('The event was held but not updated.')
          return { after: row, answer: { updated: true, event: row } }
        },
      },
      options
    )
  } catch (err) {
    // The transaction has rolled back: the event is as it was.
    if (refusedByConstraint(err, 'events_on_sale_complete')) throw adminRefusal('CONFLICT', action, 'event_incomplete', WORDS.setEventActive.setDateCapacityPricesAndRefund)
    throw err
  }
}

// --- The details edit

const ACCESS_VALUES: readonly string[] = ['public', 'members_only', 'members_first']

/** The fields as the row will hold them, once checked. Times are ISO text (London wall-clock digits labelled UTC, as the screens send them). */
interface EventDetails {
  startsAt: string | null
  endsAt: string | null
  capacity: number | null
  access: string
  publicReleaseAt: string | null
  pricePublic: number | null
  pricePreHerd: number | null
  priceHerd: number | null
  refundCutoffAt: string | null
}

/** A moment the old check accepted (anything JavaScript reads as a date) and the database can hold: its ISO text, or undefined. */
function momentOf(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return undefined
  // A year outside 0001 to 9999 is no date an event can have, and the database would refuse its text.
  const year = at.getUTCFullYear()
  return year >= 1 && year <= 9999 ? at.toISOString() : undefined
}

/** The old field checks, in their order and words (`invalid_params`). Throws the first that fails. */
/** W58b (W52 "For later" 3): what `events.capacity` (integer) and the price columns (numeric(10,2)) can hold. */
const MAX_CAPACITY = 2_147_483_647
const MAX_PRICE = 99_999_999.99

function checkedDetails(action: AdminAction, input: EventDetailsRouteInput): EventDetails {
  const words = WORDS.setEventDetails
  const invalid = (message: string, field: string) => adminRefusal('VALIDATION', action, 'invalid_params', message, { field })
  const { access, capacity } = input
  if (typeof access !== 'string' || !ACCESS_VALUES.includes(access)) throw invalid(words.chooseWhoCanBookPublicMembers, 'access')
  if (capacity !== null && (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1)) throw invalid(words.capacityMustWholeNumberAtLeast, 'capacity')
  // W58b (W52 "For later" 3): past what the columns hold, the table's own error was shown; plain words instead.
  if (capacity !== null && capacity > MAX_CAPACITY) throw invalid(EVENT_ADMIN_NEW_WORDS.capacityTooLarge, 'capacity')
  const prices: Array<[unknown, string]> = [
    [input.pricePublic, 'pricePublic'],
    [input.pricePreHerd, 'pricePreHerd'],
    [input.priceHerd, 'priceHerd'],
  ]
  for (const [price, field] of prices) {
    if (price !== null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0)) throw invalid(words.pricesCantNegative, field)
    if (price !== null && price > MAX_PRICE) throw invalid(EVENT_ADMIN_NEW_WORDS.priceTooLarge, field)
  }
  const moments: Array<[unknown, string]> = [
    [input.startsAt, 'startsAt'],
    [input.endsAt, 'endsAt'],
    [input.publicReleaseAt, 'publicReleaseAt'],
    [input.refundCutoffAt, 'refundCutoffAt'],
  ]
  for (const [moment, field] of moments) {
    if (momentOf(moment) === undefined) throw invalid(words.oneDatesNotValid, field)
  }
  return {
    startsAt: momentOf(input.startsAt) ?? null,
    endsAt: momentOf(input.endsAt) ?? null,
    capacity: capacity as number | null,
    access,
    // Only kept for Members first: cleared for the other two, as before.
    publicReleaseAt: access === 'members_first' ? (momentOf(input.publicReleaseAt) ?? null) : null,
    pricePublic: input.pricePublic as number | null,
    pricePreHerd: input.pricePreHerd as number | null,
    priceHerd: input.priceHerd as number | null,
    refundCutoffAt: momentOf(input.refundCutoffAt) ?? null,
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * An event time as staff read it, "Tue 1 Dec 2026, 6:00 pm": the stored digits as they are (London wall clock
 * labelled UTC), written out by hand so the words are the same wherever the Worker runs.
 */
export function eventTimeWords(at: Date): string {
  const hour = at.getUTCHours()
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${hour12}:${String(at.getUTCMinutes()).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`
}

/** The event as the edit reads it under its lock: the columns it writes, the places booked and whether it is cancelled. */
interface EventBefore {
  starts_at: string | null
  ends_at: string | null
  capacity: number | null
  access: string
  public_release_at: string | null
  price_public: string | null
  price_pre_herd: string | null
  price_herd: string | null
  refund_cutoff_at: string | null
  places_booked: number
  cancelled: boolean
}
type EventAfter = Omit<EventBefore, 'cancelled'>

const EVENT_BEFORE_SQL = `
SELECT e.starts_at, e.ends_at, e.capacity, e.access, e.public_release_at, e.price_public::text AS price_public,
       e.price_pre_herd::text AS price_pre_herd, e.price_herd::text AS price_herd, e.refund_cutoff_at, e.places_booked,
       (e.cancelled_at IS NOT NULL) AS cancelled
  FROM events e
 WHERE e.id = $1::uuid`
const EVENT_STAMP_SQL = `SELECT ${eventStampSql('e')} AS stamp FROM events e WHERE e.id = $1::uuid`

const UPDATE_EVENT_SQL = `
UPDATE events
   SET starts_at = $1::timestamptz, ends_at = $2::timestamptz, capacity = $3::int, access = $4::text, public_release_at = $5::timestamptz,
       price_public = $6::numeric, price_pre_herd = $7::numeric, price_herd = $8::numeric, refund_cutoff_at = $9::timestamptz, updated_at = now()
 WHERE id = $10::uuid AND cancelled_at IS NULL
RETURNING ${eventColumnsSql('events')}, ${eventStampSql('events')} AS stamp`

/** The table's constraints the edit can meet, in the old function's order, each with its old words. */
const constraintWords = (placesBooked: number): ReadonlyArray<readonly [string, string]> => [
  ['events_places_within_capacity', WORDS.setEventDetails.capacityCantLowerThanPlacesAlready(placesBooked)],
  ['events_ends_after_start', WORDS.setEventDetails.endTimeMustAfterStartTime],
  ['events_cutoff_before_start', WORDS.setEventDetails.refundCutOffCantAfterEvent],
  ['events_release_before_start', WORDS.setEventDetails.publicReleaseMustBeforeEventStarts],
  ['events_capacity_check', WORDS.setEventDetails.capacityMustAtLeast1],
  ['events_price_', WORDS.setEventDetails.pricesCantNegative],
  ['events_on_sale_complete', WORDS.setEventDetails.eventOnSaleSoItNeeds],
]

const time = (value: string | null): number | null => (value === null ? null : new Date(value).getTime())

/**
 * Q51: what the refund cut-off IS for a customer: the cut-off, or the event's start when none is set (Q43), as
 * event_cancellation_quote reads it. Null when the event has neither.
 */
export const cutoffInForce = (refundCutoffAt: string | null, startsAt: string | null): number | null => time(refundCutoffAt) ?? time(startsAt)

/**
 * W52a (W52 review S1): a moment as the edit dialog's box can hold it, for the refusal's "earliest it can be" words:
 * rounded UP to the next whole minute when it has seconds, so the time staff are told is one they can type and one
 * the rule accepts. A cut-off of 18:00:30 reads "6:01 pm": 6:00 pm would be 30 seconds earlier and refused again.
 * For the words only; the rule compares the moments as they are.
 */
export const upToTheMinute = (at: number): number => Math.ceil(at / 60_000) * 60_000

/**
 * W52a (Wayne's Q-a, 21 Nov 2026; W52 review S1 and S2): Q51 with places booked, decided under the event's lock.
 * `inForce` is the cut-off customers have now. Answers the cut-off the row is to hold, or the refusal's words.
 *  - The start moves to before the cut-off in force (Q-a): allowed, and the cut-off follows as far as the new start.
 *    A cut-off box left as it was, or set anywhere from the new start on, is written as the new start (the table
 *    allows none after the start); an empty box stays empty, which is the same cut-off (Q43: the start). A box set
 *    earlier than the new start is refused in Q51's words, with the new start as the earliest.
 *  - Otherwise the cut-off in force can't move earlier. A cut-off box set earlier than it: Q51's words, with the
 *    cut-off in force as the earliest. No cut-off and no date left at all: the cleared words.
 */
export function cutoffToKeep(inForce: number, asked: { refundCutoffAt: string | null; startsAt: string | null }): { refundCutoffAt: string | null } | { refused: string } {
  const words = (earliest: number): string => eventTimeWords(new Date(upToTheMinute(earliest)))
  const box = time(asked.refundCutoffAt)
  const newStart = time(asked.startsAt)
  if (newStart !== null && newStart < inForce) {
    if (box !== null && box < newStart) return { refused: EVENT_ADMIN_NEW_WORDS.cutoffEarlier(words(newStart)) }
    return { refundCutoffAt: box === null ? null : asked.startsAt }
  }
  if (box === null && newStart === null) return { refused: EVENT_ADMIN_NEW_WORDS.cutoffCleared(words(inForce)) }
  if (box !== null && box < inForce) return { refused: EVENT_ADMIN_NEW_WORDS.cutoffEarlier(words(inForce)) }
  return { refundCutoffAt: asked.refundCutoffAt }
}

/**
 * setEventDetails (`POST catalog/events/:eventId/details`): the edit dialog's nine fields in one UPDATE. Manage
 * pricing, then the old field checks (`invalid_params`), then ONE transaction under the event's lock, in the old
 * function's order:
 *  1. an event that isn't there is refused (`event_not_found`, the old words);
 *  1a. W54a: an event whose date, places, access, prices or cut-off changed since the page read them is refused
 *      (`changed_since`): the dialog sends all nine as the page loaded them, so a page loaded before someone
 *      corrected a price would put the old price back (£40 corrected to £45, then the capacity edited from the older
 *      page: £40 again, and every later place sold £5 short);
 *  2. a cancelled event can't be edited (`event_cancelled`, the old words);
 *  3. Q51: with a place booked, a cut-off earlier than the one in force is refused (`cutoff_earlier`), with the
 *     earliest allowed. Read under the lock a sale takes, so the first place can't be sold between the check and
 *     the write. W52a (Q-a): unless the event itself is brought forward to before that cut-off, when the cut-off
 *     follows to the new start (cutoffToKeep);
 *  4. the row, with the table's constraints answered in the old words (`constraint`), and an `event.details_set`
 *     audit row with the event before and after and the places booked at the time.
 */
export async function setEventDetails(db: Db, input: EventDetailsRouteInput, options: AdminWriteOptions): Promise<EventDetailsRouteOutput> {
  const action: AdminAction = 'event.details_set'
  // The old order: the permission, then the fields, then the event.
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const fields = checkedDetails(action, input)
  const { eventId } = input
  const words = WORDS.setEventDetails
  const gone = () => adminRefusal('NOT_FOUND', action, 'event_not_found', words.thatEventNoLongerExists)
  const cancelled = () => adminRefusal('CONFLICT', action, 'event_cancelled', words.eventHasBeenCancelledSoIt)
  let placesBooked = 0

  try {
    return await adminWrite<EventBefore, EventAfter, EventDetailsRouteOutput>(
      db,
      {
        action,
        needs: 'manage_pricing',
        entity: { type: 'event', id: eventId },
        locks: [{ table: 'events', ids: [eventId] }],
        unchangedSince: {
          seen: input.stamp,
          now: async (tx) => (await tx.query<{ stamp: string }>(EVENT_STAMP_SQL, [eventId]))[0]?.stamp ?? NO_ROW_STAMP,
        },
        async before(tx, held) {
          if (!held.events?.length) throw gone()
          const [row] = await tx.query<Record<keyof EventBefore, unknown>>(EVENT_BEFORE_SQL, [eventId])
          if (!row) throw gone()
          return {
            starts_at: iso(row.starts_at),
            ends_at: iso(row.ends_at),
            capacity: row.capacity === null ? null : Number(row.capacity),
            access: String(row.access),
            public_release_at: iso(row.public_release_at),
            price_public: row.price_public === null ? null : String(row.price_public),
            price_pre_herd: row.price_pre_herd === null ? null : String(row.price_pre_herd),
            price_herd: row.price_herd === null ? null : String(row.price_herd),
            refund_cutoff_at: iso(row.refund_cutoff_at),
            places_booked: Number(row.places_booked),
            cancelled: row.cancelled === true,
          }
        },
        async change(tx, before) {
          placesBooked = before.places_booked
          if (before.cancelled) throw cancelled()
          // Q51: once a place is booked, the cut-off in force can move later, never earlier; W52a (Q-a): except that
          // it follows an event brought forward to before it, as far as the new start.
          let refundCutoffAt = fields.refundCutoffAt
          // W58b (W52a "Noticed" 1, 2): whether the cut-off followed an event brought forward (Q-a), for the answer.
          let cutoffFollowed = false
          const inForce = cutoffInForce(before.refund_cutoff_at, before.starts_at)
          if (before.places_booked > 0 && inForce !== null) {
            const kept = cutoffToKeep(inForce, fields)
            if ('refused' in kept) throw adminRefusal('CONFLICT', action, 'cutoff_earlier', kept.refused, { field: 'refundCutoffAt' })
            refundCutoffAt = kept.refundCutoffAt
            const newStart = time(fields.startsAt)
            cutoffFollowed = newStart !== null && newStart < inForce
          }
          const [row] = await tx.query<Record<string, unknown>>(UPDATE_EVENT_SQL, [
            fields.startsAt,
            fields.endsAt,
            fields.capacity,
            fields.access,
            fields.publicReleaseAt,
            fields.pricePublic,
            fields.pricePreHerd,
            fields.priceHerd,
            refundCutoffAt,
            eventId,
          ])
          // Under the lock a cancel can't land between the read and the write; kept as the old function had it.
          if (!row) throw cancelled()
          const { stamp, ...event } = row
          const answered = Object.fromEntries(Object.entries(event).map(([name, value]) => [name, (EVENT_TIMES as readonly string[]).includes(name) ? iso(value) : value])) as EventAnswerRow
          const after: EventAfter = {
            starts_at: answered.starts_at,
            ends_at: answered.ends_at,
            capacity: answered.capacity,
            access: answered.access,
            public_release_at: answered.public_release_at,
            price_public: answered.price_public,
            price_pre_herd: answered.price_pre_herd,
            price_herd: answered.price_herd,
            refund_cutoff_at: answered.refund_cutoff_at,
            places_booked: answered.places_booked,
          }
          return { after, answer: { updated: true, event: answered, stamp: String(stamp), ...(cutoffFollowed ? { cutoffFollowed: true as const } : {}) } }
        },
      },
      options
    )
  } catch (err) {
    // The transaction has rolled back. One of the table's own rules: its old words, never the database's.
    const match = constraintWords(placesBooked).find(([constraint]) => refusedByConstraint(err, constraint))
    if (match) throw adminRefusal('CONFLICT', action, 'constraint', match[1])
    throw err
  }
}
