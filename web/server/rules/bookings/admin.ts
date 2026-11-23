// W50 (G-plan 1.10, 1.12, 4.1, 4.3, 4.8; bugs GB14 and GB17; Wayne's Q49; W48 review L2 and L5): the Bookings page,
// the booking detail and Overview's booking cards on the Worker. Ported from the staff app's getBookings.ts,
// getBookingById.ts, getBookingDetail.ts (with shared/bookingPaymentOpenWords.ts and shared/readerPaymentOpen.ts),
// getAddonPrepChecklistForRange.ts, getWaiverGapsForRange.ts, getPaymentAttentionItems.ts, setBookingCheckedIn.ts,
// setGuestWaiverStatus.ts and setAddonLinePrepared.ts (as they were at W48), with their words
// (./admin-failure-messages.ts). W53: getPaymentAttentionItems' read (listPaymentAttention) moved to
// server/rules/orders/admin.ts, unchanged, where G-plan 4.1 places it; it still reads a booking by BOOKING_ROW_SQL.
//
// The six reads
//  - GB14: an active staff member, through the admin read helper (the old reads checked nobody). Named columns: every
//    column the old `b.*` gave is named here, so nothing a screen reads is gone and a new column is a decision.
//  - Each read takes the channel (G-plan 4.8). On the customer channel every statement is limited to the signed-in
//    customer's own bookings (`ownOnly`); no customer route exists yet (lead call L13). The detail's guests and add-on
//    lines are read for a LIST of bookings, so the website's account pages can later say "1 of 2 signed", list the
//    add-ons and word what was paid (each guest's `unit_price` and `pay_by`) for a page of bookings in two statements.
//  - A range picks its days by the session's London day, read from the stored digits whatever the connection's time
//    zone (time/london-day-sql.ts; W48 review L5). "Today" is the screen's (London's), sent as the range.
//
// The three flags (G-plan 4.2, level C): one guarded statement and an audit row in one transaction, under the call's
// own key. GB17: the old functions checked nothing about the booking, and nothing said who.
//  - A cancelled booking: every change refused, on and off (the lead's call, 20 Nov).
//  - A booking at Payment needed: Check In refused in Wayne's words (Q49). Undoing a check-in, waivers and prepared
//    are allowed: prep and paperwork before payment is fine (the lead's call).
//  - An add-on already removed from its booking can't be marked prepared (or not prepared).
//  - The check-in time is the database's own clock, as every other Worker write's, never the staff app's.
//  - A repeat press keeps the flag and who set it: a second Check In keeps the first time, a waiver already signed
//    keeps how and when it was signed, an add-on already prepared keeps who prepared it and when. (It still moves
//    the booking's updated_at on Check In and writes another audit row: W50 review "Claims" 1.)
//  - W48 review L2: a guest's waiver and an add-on line are guarded by their BOOKING's status, which is another
//    table's row. So each holds the booking FOR SHARE first (LOCK_ORDER's 'booking', and nothing before it): a cancel
//    in progress is waited for and the press is then decided on the committed status. The check-in's guard is on the
//    row it updates, which Postgres re-checks after a wait by itself.
//  - W54a's stale-page rule doesn't apply: a flag writes only what was pressed (one switch), never a row as a page read it.
//
// W50a (W50's review; Wayne, 20 Nov):
//  - Q49's words name the button: "This booking needs payment first. Use Take Payment."
//  - Review L2: Check In is refused while a payment is still being taken on the booking (an open card-reader or
//    saved-card flow, or an order still being paid: the test the detail's `readerPaymentOpenMessage` makes), reason
//    `payment_open`. An open payment is another table's row, so Check In now holds its booking first as well, with
//    the lock its own UPDATE takes: a flow that is opening (it locks the booking, then writes its record) is waited
//    for, and the press is decided on what it committed. Undo, waivers and prepared are unchanged.
//  - Review L6: on the customer channel the waiver's hold names the customer, so a booking that isn't theirs is
//    never locked; and each flag says which channels it accepts (only a waiver accepts a customer).
import 'server-only'
import type {
  AddonPreparedRouteOutput,
  AdminAction,
  AdminGetAddonPrepChecklistForRangeOutput,
  AdminGetBookingByIdOutput,
  AdminGetBookingDetailOutput,
  AdminGetBookingsOutput,
  AdminGetWaiverGapsForRangeOutput,
  BookingCheckInRouteOutput,
  BookingDayRangeRouteInput,
  BookingListRouteInput,
  GuestWaiverRouteOutput,
} from '@/contracts'
import type { Db, Queryable, SqlParam, Tx } from '@/server/db'
import type { ApiError } from '@/server/http/errors'
import { flagWrite } from '@/server/rules/admin/flag'
import { isUuid } from '@/server/rules/admin/locks'
import { adminRead, namedRead } from '@/server/rules/admin/read'
import { adminRefusal, type AdminActor } from '@/server/rules/admin/refusal'
import { LONDON_WALL_CLOCK_NOW_SQL, onOrAfterLondonDaySql, onOrBeforeLondonDaySql, withinLondonDaysSql } from '@/server/rules/time/london-day-sql'
import { DEFAULT_WAIVER_VERSION, isWaiverMethodFor } from '@/server/rules/waivers/methods'
import { BOOKING_ADMIN_NEW_WORDS, BOOKING_ADMIN_WORDS } from './admin-failure-messages'
import { BOOKING_FLOWS_SQL, ORDER_BEING_PAID_SQL } from './load-booking'

// ---------------------------------------------------------------------------------------------------------------------
// Who is reading, and the channel

/**
 * Who a booking read is for (G-plan 4.8). `staff`: the signed-in staff member, as the route's own staff check read
 * them. `customer`: the website's signed-in customer, who is only ever shown their own bookings.
 */
export type BookingReader = { channel: 'staff'; actor: AdminActor } | { channel: 'customer'; customerId: string }

/** A statement's parameters, numbered as they are added. */
class Params {
  readonly values: SqlParam[] = []
  add(value: SqlParam): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

/**
 * The customer channel's limit: only the signed-in customer's own bookings (`b` is the booking). Nothing on the staff
 * channel. Every booking read's statement carries it, so no read can show a customer someone else's booking.
 */
const ownOnly = (reader: BookingReader, params: Params): string => (reader.channel === 'customer' ? ` AND b.customer_id = ${params.add(reader.customerId)}::uuid` : '')

interface BookingRead {
  name: string
  sql: string
  params: readonly SqlParam[]
  times?: readonly string[]
}

/** One read on its channel: the staff permission first for staff; the customer's is the `ownOnly` limit in the statement. */
function channelRead<Row extends Record<string, unknown>>(db: Queryable, reader: BookingReader, read: BookingRead): Promise<Row[]> {
  return reader.channel === 'staff' ? adminRead<Row>(db, { ...read, needs: 'staff' }, { actor: reader.actor }) : namedRead<Row>(db, read)
}

// ---------------------------------------------------------------------------------------------------------------------
// The booking list, one booking

/**
 * A booking as the lists show it: every column of the booking by name (the old reads took `b.*`), its session's
 * times and service type, its customer, and how its OWN order was paid: the earliest booking line whose order
 * recorded a payment method, else the earliest. A later guest's or add-on's order never decides it. Exported (W53)
 * for Overview's payments needing attention, which answers whole booking rows (server/rules/orders/admin.ts).
 */
export const BOOKING_ROW_SQL = `
SELECT b.id, b.session_id, b.customer_id, b.party_size, b.status, b.price_paid::text AS price_paid, b.stripe_payment_id,
       b.redemption_source, b.created_at, b.cancelled_at, b.checked_in_at, b.updated_at, b.redeemed_membership_id,
       b.redeemed_session_pass_id, b.band_id, b.credit_period_id, b.payment_due_by, b.cancel_reason, b.special_requests,
       b.guests_over_18_confirmed_at, b.part_refunded_amount::text AS part_refunded_amount,
       b.refund_owed_amount::text AS refund_owed_amount,
       s.start_time, s.end_time, s.service_type_id, st.name AS service_type_name, st.booking_type,
       c.first_name AS customer_first_name, c.last_name AS customer_last_name, c.email AS customer_email,
       ord.payment_method
  FROM bookings b
  JOIN sessions s ON s.id = b.session_id
  JOIN service_types st ON st.id = s.service_type_id
  JOIN customers c ON c.id = b.customer_id
  LEFT JOIN LATERAL (
    SELECT o.payment_method
      FROM order_line_items oli
      JOIN orders o ON o.id = oli.order_id
     WHERE oli.booking_id = b.id
     ORDER BY (o.payment_method IS NULL), oli.created_at ASC, oli.id ASC
     LIMIT 1
  ) ord ON true`
export const BOOKING_ROW_TIMES = ['created_at', 'cancelled_at', 'checked_in_at', 'updated_at', 'payment_due_by', 'guests_over_18_confirmed_at', 'start_time', 'end_time'] as const

type BookingRow = AdminGetBookingsOutput[number]

/**
 * getBookings (`GET bookings`): the bookings whose session is on a London day from `startDate` to `endDate` (each
 * optional, both included), with the status asked for, newest session first. With nothing asked for, every booking,
 * as before.
 */
export function listBookings(db: Queryable, input: BookingListRouteInput, reader: BookingReader): Promise<AdminGetBookingsOutput> {
  const params = new Params()
  const where: string[] = []
  if (input.startDate) where.push(onOrAfterLondonDaySql('s.start_time', params.add(input.startDate)))
  if (input.endDate) where.push(onOrBeforeLondonDaySql('s.start_time', params.add(input.endDate)))
  if (input.status) where.push(`b.status = ${params.add(input.status)}`)
  const sql = `${BOOKING_ROW_SQL}
 WHERE true${where.map((condition) => ` AND ${condition}`).join('')}${ownOnly(reader, params)}
 ORDER BY s.start_time DESC, b.created_at, b.id`
  return channelRead<BookingRow>(db, reader, { name: 'bookings.list', sql, params: params.values, times: BOOKING_ROW_TIMES })
}

/** getBookingById (`GET bookings/:bookingId`): one booking's row, read fresh; null when there is none (or, on the customer channel, when it isn't theirs). */
export async function getBookingRow(db: Queryable, bookingId: string, reader: BookingReader): Promise<AdminGetBookingByIdOutput> {
  // An id that isn't one names no booking: the same answer, without asking the database to cast it.
  const params = new Params()
  const sql = `${BOOKING_ROW_SQL}
 WHERE b.id = ${params.add(isUuid(bookingId) ? bookingId : null)}::uuid${ownOnly(reader, params)}
 LIMIT 1`
  const rows = await channelRead<BookingRow>(db, reader, { name: 'bookings.one', sql, params: params.values, times: BOOKING_ROW_TIMES })
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------------------------------------------------
// The booking detail

type GuestRow = AdminGetBookingDetailOutput['guests'][number]
type AddonLineRow = AdminGetBookingDetailOutput['addonLines'][number]

/** A guest's row, every column by name. A date of birth and a price as the database's text. */
const GUEST_COLUMNS_SQL = `bg.id, bg.booking_id, bg.guest_type, bg.guest_name, bg.guest_email, bg.waiver_accepted, bg.waiver_version,
       bg.waiver_accepted_at, bg.waiver_method, bg.reminder_sent_at, bg.created_at, bg.date_of_birth::text AS date_of_birth,
       bg.unit_price::text AS unit_price, bg.pay_by`
const GUEST_TIMES = ['waiver_accepted_at', 'reminder_sent_at', 'created_at'] as const

/**
 * The guests of the bookings named, seat 1 first within each (created_at, then id). For a list of bookings, so a page
 * of them can be summed up in one statement ("1 of 2 signed"; each seat's price and how it is covered).
 */
export function guestsOfBookings(db: Queryable, bookingIds: readonly string[], reader: BookingReader): Promise<GuestRow[]> {
  const params = new Params()
  const sql = `
SELECT ${GUEST_COLUMNS_SQL}
  FROM booking_guests bg
  JOIN bookings b ON b.id = bg.booking_id
 WHERE bg.booking_id = ANY(${params.add(bookingIds.filter(isUuid))}::uuid[])${ownOnly(reader, params)}
 ORDER BY bg.created_at, bg.id`
  return channelRead<GuestRow>(db, reader, { name: 'bookings.guests', sql, params: params.values, times: GUEST_TIMES })
}

/**
 * The add-on lines of the bookings named, removed ones included (kept for history), oldest first, each with its
 * add-on's name, who removed it and whether the order that paid for IT took a card payment (so a refund can go back
 * to the card).
 */
export function addonLinesOfBookings(db: Queryable, bookingIds: readonly string[], reader: BookingReader): Promise<AddonLineRow[]> {
  const params = new Params()
  const sql = `
SELECT aol.id, aol.booking_id, aol.addon_id, a.name AS addon_name, aol.quantity, aol.price_at_purchase::text AS price_at_purchase,
       aol.sku_at_purchase, aol.redemption_source, aol.prepared, aol.prepared_at, aol.prepared_by, aol.created_at,
       aol.redeemed_membership_id, aol.removed_at,
       NULLIF(trim(concat_ws(' ', remover.first_name, remover.last_name)), '') AS removed_by_name,
       aol.refunded_amount::text AS refunded_amount, aol.card_refunded_amount::text AS card_refunded_amount, aol.refund_method,
       COALESCE(o.stripe_payment_intent_id IS NOT NULL, false) AS order_has_card
  FROM addon_order_lines aol
  JOIN bookings b ON b.id = aol.booking_id
  LEFT JOIN orders o ON o.id = aol.order_id
  JOIN addons a ON a.id = aol.addon_id
  LEFT JOIN staff remover ON remover.id = aol.removed_by
 WHERE aol.booking_id = ANY(${params.add(bookingIds.filter(isUuid))}::uuid[])${ownOnly(reader, params)}
 ORDER BY aol.created_at, aol.id`
  return channelRead<AddonLineRow>(db, reader, { name: 'bookings.addon_lines', sql, params: params.values, times: ['prepared_at', 'created_at', 'removed_at'] })
}

/** The flows that hold the booking `b` while a payment is taken on it. */
const OPEN_FLOW_OF_BOOKING_SQL = `p.record_id = b.id AND p.flow IN ${BOOKING_FLOWS_SQL} AND p.status = 'pending'`

/**
 * For a booking aliased `b`: whether a payment is still being taken on it, by card reader or saved card: an open flow
 * of the booking, or an order still being paid for it (load-booking.ts's `paymentOpen`, as one condition). The
 * detail's open-payment words and Check In's guard (W50a) both ask exactly this.
 */
const PAYMENT_OPEN_ON_BOOKING_SQL = `(EXISTS (SELECT 1 FROM pending_reader_payments p WHERE ${OPEN_FLOW_OF_BOOKING_SQL}) OR ${ORDER_BEING_PAID_SQL})`

/**
 * What staff are told while a payment is still being taken on the booking, or null when none is: the card words when
 * every open flow on it is one the Worker started on a saved card (method `card` with its request id, as
 * load-booking.ts reads a flow), the reader words otherwise, including an order still being paid with no flow open.
 */
export const paymentOpenWords = (open: boolean, cardOnly: boolean): string | null =>
  !open ? null : cardOnly ? BOOKING_ADMIN_WORDS.bookingPaymentOpenWords.cardPaymentOnBookingStillBeing : BOOKING_ADMIN_WORDS.readerPaymentOpen.cardReaderPaymentStillOpenOn

/**
 * getBookingDetail (`GET bookings/:bookingId/detail`): the booking's guests, its add-on lines, its special requests,
 * the money still to give back, and the open-payment words. A booking that isn't there (or isn't the customer's)
 * answers the same empty detail the old function did.
 */
export async function getBookingDetail(db: Queryable, bookingId: string, reader: BookingReader): Promise<AdminGetBookingDetailOutput> {
  const ids = [bookingId]
  const guests = await guestsOfBookings(db, ids, reader)
  const addonLines = await addonLinesOfBookings(db, ids, reader)
  const params = new Params()
  const [row] = await channelRead<{ special_requests: string | null; refund_owed_amount: string; payment_open: boolean; card_only: boolean }>(db, reader, {
    name: 'bookings.detail',
    sql: `
SELECT b.special_requests, b.refund_owed_amount::text AS refund_owed_amount,
       ${PAYMENT_OPEN_ON_BOOKING_SQL} AS payment_open,
       COALESCE((
         SELECT bool_and(p.snapshot->>'method' = 'card' AND (p.snapshot->>'request_id') IS NOT NULL)
           FROM pending_reader_payments p
          WHERE ${OPEN_FLOW_OF_BOOKING_SQL}
       ), false) AS card_only
  FROM bookings b
 WHERE b.id = ${params.add(isUuid(bookingId) ? bookingId : null)}::uuid${ownOnly(reader, params)}`,
    params: params.values,
  })
  return {
    guests,
    addonLines,
    specialRequests: row?.special_requests ?? null,
    refundOwedAmount: row?.refund_owed_amount ?? '0',
    readerPaymentOpenMessage: row ? paymentOpenWords(row.payment_open === true, row.card_only === true) : null,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The prep list and the waiver gaps

/**
 * getAddonPrepChecklistForRange (`GET bookings/addon-prep`): every add-on still on a booking that isn't cancelled,
 * for sessions on a London day from `startDate` to `endDate` (both included), in session order.
 */
export function listAddonPrep(db: Queryable, input: BookingDayRangeRouteInput, reader: BookingReader): Promise<AdminGetAddonPrepChecklistForRangeOutput> {
  const params = new Params()
  const sql = `
SELECT aol.id, aol.booking_id, aol.addon_id, a.name AS addon_name, aol.quantity, aol.prepared, aol.prepared_at, aol.prepared_by,
       s.id AS session_id, s.start_time, s.end_time, st.name AS service_type_name,
       c.first_name AS customer_first_name, c.last_name AS customer_last_name, b.status AS booking_status, b.special_requests
  FROM addon_order_lines aol
  JOIN addons a ON a.id = aol.addon_id
  JOIN bookings b ON b.id = aol.booking_id
  JOIN sessions s ON s.id = b.session_id
  JOIN service_types st ON st.id = s.service_type_id
  JOIN customers c ON c.id = b.customer_id
 WHERE ${withinLondonDaysSql('s.start_time', params.add(input.startDate), params.add(input.endDate))}
   AND b.status != 'cancelled'
   AND aol.removed_at IS NULL${ownOnly(reader, params)}
 ORDER BY s.start_time, a.name, aol.created_at, aol.id`
  return channelRead<AdminGetAddonPrepChecklistForRangeOutput[number]>(db, reader, { name: 'bookings.addon_prep', sql, params: params.values, times: ['prepared_at', 'start_time', 'end_time'] })
}

/**
 * getWaiverGapsForRange (`GET bookings/waiver-gaps`): every guest on a booking that isn't cancelled who hasn't a
 * signed waiver, for sessions on a London day from `startDate` to `endDate` (both included), in session order.
 */
export function listWaiverGaps(db: Queryable, input: BookingDayRangeRouteInput, reader: BookingReader): Promise<AdminGetWaiverGapsForRangeOutput> {
  const params = new Params()
  const sql = `
SELECT bg.id, bg.booking_id, bg.guest_name, bg.guest_type, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
       s.start_time, st.name AS service_type_name
  FROM booking_guests bg
  JOIN bookings b ON b.id = bg.booking_id
  JOIN sessions s ON s.id = b.session_id
  JOIN service_types st ON st.id = s.service_type_id
  JOIN customers c ON c.id = b.customer_id
 WHERE ${withinLondonDaysSql('s.start_time', params.add(input.startDate), params.add(input.endDate))}
   AND b.status != 'cancelled'
   AND bg.waiver_accepted IS NOT TRUE${ownOnly(reader, params)}
 ORDER BY s.start_time, bg.created_at, bg.id`
  return channelRead<AdminGetWaiverGapsForRangeOutput[number]>(db, reader, { name: 'bookings.waiver_gaps', sql, params: params.values, times: ['start_time'] })
}

// ---------------------------------------------------------------------------------------------------------------------
// The three flags

/** A press by a staff member: who, the request, and the call's own key (the route's Idempotency-Key). */
export interface StaffFlagPress {
  actor: AdminActor
  requestId: string
  pressKey: string | null
}

/**
 * Who records a waiver (brief item 7). A staff member, on the one route there is; or the website's signed-in
 * customer, for a guest on one of their own bookings (the rule only: no customer route yet, lead call L13).
 */
export type WaiverPress = { requestId: string; pressKey: string | null } & ({ channel: 'staff'; actor: AdminActor } | { channel: 'customer'; customerId: string })

const WORDS = BOOKING_ADMIN_NEW_WORDS
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value))
const changedMeanwhile = (action: AdminAction): ApiError => adminRefusal('CONFLICT', action, 'booking_changed', WORDS.bookingChanged)

/**
 * W50a (W50 review L2): Check In's guard reads the booking's open payments, which are other tables' rows, so the
 * booking is held first, in a statement of its own, with the lock the check-in's UPDATE takes anyway (FOR NO KEY
 * UPDATE; FOR SHARE would let two presses each hold it and then wait for the other's). A flow that is opening holds
 * the same lock until its record is committed (C1: lockForBooking, then writeFlowRecord), so the press waits for it
 * and its own statement, which starts after the wait, sees the record. Exported for the race test's control
 * (admin-postgres.test.ts), which runs CHECK_IN_SQL without it.
 */
export const HOLD_BOOKING_FOR_CHECK_IN_SQL = 'SELECT b.id FROM bookings b WHERE b.id = $1::uuid FOR NO KEY UPDATE OF b'

/** Checked in: a booking already checked in keeps its first time. Exported for the race test's control. */
export const CHECK_IN_SQL = `
UPDATE bookings b
   SET checked_in_at = COALESCE(b.checked_in_at, now()), updated_at = now()
 WHERE b.id = $1::uuid AND b.status <> 'cancelled' AND b.status <> 'payment_needed'
   AND NOT ${PAYMENT_OPEN_ON_BOOKING_SQL}
RETURNING b.id, b.checked_in_at`
/** Why Check In's guard refused: the booking's status, and whether a payment is open on it, as the guard asked. */
const CHECK_IN_REFUSAL_SQL = `SELECT b.status, ${PAYMENT_OPEN_ON_BOOKING_SQL} AS payment_open FROM bookings b WHERE b.id = $1::uuid`
const UNDO_CHECK_IN_SQL = `
UPDATE bookings
   SET checked_in_at = NULL, updated_at = now()
 WHERE id = $1::uuid AND status <> 'cancelled'
RETURNING id, checked_in_at`

/**
 * setBookingCheckedIn (`POST bookings/:bookingId/check-in`), on and undo. Any active staff member. One guarded
 * statement: a cancelled booking is refused either way; a booking at Payment needed can't be checked in (Q49: "This
 * booking needs payment first. Use Take Payment."), and neither can one with a payment still being taken on it
 * (W50a: "A payment on this booking is still going through. Check in once it has completed."), though a check-in
 * made before can still be undone in both cases. The time is the database's clock, and a booking already checked in
 * keeps its first time. The audit row (`booking.checked_in` or `booking.check_in_undone`) says who.
 */
export async function setBookingCheckedIn(db: Db, bookingId: string, checkedIn: boolean, press: StaffFlagPress): Promise<BookingCheckInRouteOutput> {
  const action: AdminAction = checkedIn ? 'booking.checked_in' : 'booking.check_in_undone'
  const notFound = () => adminRefusal('NOT_FOUND', action, 'booking_not_found', WORDS.bookingNotFound)
  if (!isUuid(bookingId)) throw notFound()
  const row = await flagWrite<{ id: string; checked_in_at: unknown }>(
    db,
    {
      action,
      needs: 'staff',
      channels: ['staff'],
      entity: { type: 'booking', id: bookingId },
      ...(checkedIn ? { holdFirst: { sql: HOLD_BOOKING_FOR_CHECK_IN_SQL, params: [bookingId] } } : {}),
      statement: { sql: checkedIn ? CHECK_IN_SQL : UNDO_CHECK_IN_SQL, params: [bookingId] },
      async refusal(tx) {
        // Undo reads what it always read. Check In also reads whether a payment is open, as its guard did.
        const [booking] = checkedIn
          ? await tx.query<{ status: string; payment_open: boolean }>(CHECK_IN_REFUSAL_SQL, [bookingId])
          : await tx.query<{ status: string; payment_open?: boolean }>('SELECT status FROM bookings WHERE id = $1::uuid', [bookingId])
        if (!booking) return notFound()
        if (booking.status === 'cancelled') return adminRefusal('CONFLICT', action, 'booking_cancelled', WORDS.cancelledCheckIn)
        // An open payment first: on a Payment needed booking it is Settle's own, and "Use Take Payment" would be wrong then.
        if (checkedIn && booking.payment_open === true) return adminRefusal('CONFLICT', action, 'payment_open', WORDS.paymentOpenCheckIn)
        if (checkedIn && booking.status === 'payment_needed') return adminRefusal('CONFLICT', action, 'payment_needed', WORDS.paymentNeededCheckIn)
        return changedMeanwhile(action)
      },
      recorded: (updated) => ({ checked_in_at: iso(updated.checked_in_at) }),
    },
    press
  )
  return { id: row.id, checked_in_at: iso(row.checked_in_at) }
}

/**
 * W48 review L2: the booking a guest or an add-on line belongs to, held FOR SHARE before the flag's own statement,
 * so the status the guard reads is a committed one and can't change until the flag commits. FOR SHARE is enough: it
 * waits for (and is waited for by) the lock every cancel, move, settle and refund takes on the booking, while two
 * flags on one booking don't wait for each other. The booking is the first lock the press takes, and its only one
 * besides the row it updates, so it can't be waiting for a booking while holding a row a booking change wants.
 */
const HOLD_BOOKING_OF_GUEST_SQL = 'SELECT b.id FROM bookings b WHERE b.id = (SELECT bg.booking_id FROM booking_guests bg WHERE bg.id = $1::uuid) FOR SHARE OF b'
const HOLD_BOOKING_OF_ADDON_LINE_SQL = 'SELECT b.id FROM bookings b WHERE b.id = (SELECT aol.booking_id FROM addon_order_lines aol WHERE aol.id = $1::uuid) FOR SHARE OF b'
/**
 * W50a (W50 review L6a): the customer channel's hold. The same statement, limited to the signed-in customer's own
 * bookings (`$2`), so a customer pressing on someone else's guest locks nothing: the guard then refuses, and they
 * are told only that the guest isn't on one of their bookings.
 */
const HOLD_OWN_BOOKING_OF_GUEST_SQL =
  'SELECT b.id FROM bookings b WHERE b.id = (SELECT bg.booking_id FROM booking_guests bg WHERE bg.id = $1::uuid) AND b.customer_id = $2::uuid FOR SHARE OF b'

/**
 * What the customer channel adds to a waiver's guard (brief item 7; backend log 18): the guest is on one of the
 * signed-in customer's own bookings, and the session hasn't passed (its end, on London's wall clock). Staff can
 * still record a waiver after the session. `$4` is the customer.
 */
const CUSTOMER_WAIVER_GUARD_SQL = `
   AND b.customer_id = $4::uuid
   AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = b.session_id AND s.end_time > ${LONDON_WALL_CLOCK_NOW_SQL})`

/**
 * Signed: a waiver already signed keeps how and when it was signed. `$2` the method, `$3` the version. Exported for
 * the race test's control (admin-postgres.test.ts), which runs it without the booking held first.
 */
export const signWaiverSql = (customer: boolean): string => `
UPDATE booking_guests bg
   SET waiver_accepted = true,
       waiver_accepted_at = CASE WHEN bg.waiver_accepted IS TRUE THEN bg.waiver_accepted_at ELSE now() END,
       waiver_method = CASE WHEN bg.waiver_accepted IS TRUE THEN bg.waiver_method ELSE $2::text END,
       waiver_version = CASE WHEN bg.waiver_accepted IS TRUE THEN bg.waiver_version ELSE $3::text END
  FROM bookings b
 WHERE bg.id = $1::uuid AND b.id = bg.booking_id AND b.status <> 'cancelled'${customer ? CUSTOMER_WAIVER_GUARD_SQL : ''}
RETURNING ${GUEST_COLUMNS_SQL}`
const REVOKE_WAIVER_SQL = `
UPDATE booking_guests bg
   SET waiver_accepted = false, waiver_accepted_at = NULL, waiver_method = NULL, waiver_version = NULL
  FROM bookings b
 WHERE bg.id = $1::uuid AND b.id = bg.booking_id AND b.status <> 'cancelled'
RETURNING ${GUEST_COLUMNS_SQL}`

/**
 * setGuestWaiverStatus (`POST bookings/guests/:guestId/waiver`), sign and revoke.
 *  - The method must be one the channel may record (waivers/methods.ts): staff `in_person` or `email_link`, refused
 *    in the old words; the customer channel `email_link` only (and never a revoke).
 *  - The booking is held FOR SHARE first (W48 review L2), then one guarded statement: a cancelled booking's waivers
 *    can't be changed, either way. On the customer channel the guest must be on one of the customer's own bookings
 *    and the session mustn't have passed.
 *  - The audit row (`booking.guest_waiver_set`) says who, and keeps the waiver as set: never a name, an email or a
 *    date of birth.
 */
export async function setGuestWaiver(db: Db, guestId: string, input: { accepted: boolean; waiverMethod?: unknown; waiverVersion?: unknown }, press: WaiverPress): Promise<GuestWaiverRouteOutput> {
  const action: AdminAction = 'booking.guest_waiver_set'
  const customer = press.channel === 'customer'
  if (customer && !input.accepted) throw adminRefusal('FORBIDDEN', action, 'customer_cannot_revoke', WORDS.customerCannotRevoke)
  if (input.accepted && !isWaiverMethodFor(press.channel, input.waiverMethod)) {
    throw customer
      ? adminRefusal('VALIDATION', action, 'waiver_method_not_allowed', WORDS.customerWaiverMethod, { field: 'waiverMethod' })
      : adminRefusal('VALIDATION', action, 'invalid_waiver_method', BOOKING_ADMIN_WORDS.setGuestWaiverStatus.waivermethodMustEmailLinkOrIn, { field: 'waiverMethod' })
  }
  const notFound = () => adminRefusal('NOT_FOUND', action, 'guest_not_found', WORDS.guestNotFound)
  if (!isUuid(guestId)) throw notFound()
  const version = (typeof input.waiverVersion === 'string' ? input.waiverVersion.trim() : '') || DEFAULT_WAIVER_VERSION
  const statement = !input.accepted
    ? { sql: REVOKE_WAIVER_SQL, params: [guestId] }
    : { sql: signWaiverSql(customer), params: customer ? [guestId, input.waiverMethod as string, version, press.customerId] : [guestId, input.waiverMethod as string, version] }

  const row = await flagWrite<Record<string, unknown>>(
    db,
    {
      action,
      needs: 'staff',
      // The one flag the website's customer may set (brief W50 item 7); every other accepts staff only.
      channels: ['staff', 'customer'],
      entity: { type: 'booking_guest', id: guestId },
      holdFirst: customer ? { sql: HOLD_OWN_BOOKING_OF_GUEST_SQL, params: [guestId, press.customerId] } : { sql: HOLD_BOOKING_OF_GUEST_SQL, params: [guestId] },
      statement,
      refusal: (tx) => waiverRefusal(tx, guestId, press, action, notFound),
      recorded: (updated) => ({ booking_id: updated['booking_id'], waiver_accepted: updated['waiver_accepted'], waiver_method: updated['waiver_method'], waiver_version: updated['waiver_version'], waiver_accepted_at: iso(updated['waiver_accepted_at']) }),
      details: { accepted: input.accepted, ...(customer ? { channel: 'customer' } : {}) },
    },
    { actor: customer ? { type: 'customer', id: press.customerId } : press.actor, requestId: press.requestId, pressKey: press.pressKey }
  )
  return { ...row, waiver_accepted_at: iso(row['waiver_accepted_at']), reminder_sent_at: iso(row['reminder_sent_at']), created_at: iso(row['created_at']) } as GuestWaiverRouteOutput
}

/** A guest's booking as a waiver's refusal reads it: its status, whose it is, and whether its session has passed (its end, on London's wall clock). */
const WAIVER_REFUSAL_SQL = `
SELECT b.status, b.customer_id, (s.end_time <= ${LONDON_WALL_CLOCK_NOW_SQL}) AS passed
  FROM booking_guests bg
  JOIN bookings b ON b.id = bg.booking_id
  JOIN sessions s ON s.id = b.session_id
 WHERE bg.id = $1::uuid`

/** Why a waiver's guard refused, read in the press's own transaction (the booking is held, so its status is the one the guard read). */
async function waiverRefusal(tx: Tx, guestId: string, press: WaiverPress, action: AdminAction, notFound: () => ApiError): Promise<ApiError> {
  const [guest] = await tx.query<{ status: string; customer_id: string; passed: boolean }>(WAIVER_REFUSAL_SQL, [guestId])
  if (!guest) return notFound()
  // Theirs first: a customer is told nothing about a booking that isn't their own.
  if (press.channel === 'customer' && guest.customer_id !== press.customerId) return adminRefusal('FORBIDDEN', action, 'not_their_booking', WORDS.customerNotTheirBooking)
  if (guest.status === 'cancelled') return adminRefusal('CONFLICT', action, 'booking_cancelled', WORDS.cancelledWaiver)
  if (press.channel === 'customer' && guest.passed === true) return adminRefusal('CONFLICT', action, 'session_passed', WORDS.customerSessionPassed)
  return changedMeanwhile(action)
}

/** An add-on line's row, every column by name (the old function answered `RETURNING *`). Money as the database's text. */
const ADDON_LINE_COLUMNS_SQL = `aol.id, aol.booking_id, aol.addon_id, aol.quantity, aol.price_at_purchase::text AS price_at_purchase, aol.sku_at_purchase,
       aol.redemption_source, aol.stripe_price_id, aol.created_at, aol.prepared, aol.prepared_at, aol.prepared_by, aol.redeemed_membership_id,
       aol.order_id, aol.removed_at, aol.removed_by, aol.refunded_amount::text AS refunded_amount,
       aol.card_refunded_amount::text AS card_refunded_amount, aol.refund_method`

/**
 * Prepared: a line already prepared keeps who prepared it and when. `$2` is the staff member. Exported for the race
 * test's control (admin-postgres.test.ts), which runs it without the booking held first.
 */
export const PREPARE_ADDON_LINE_SQL = `
UPDATE addon_order_lines aol
   SET prepared = true,
       prepared_at = CASE WHEN aol.prepared THEN aol.prepared_at ELSE now() END,
       prepared_by = CASE WHEN aol.prepared THEN aol.prepared_by ELSE $2::uuid END
  FROM bookings b
 WHERE aol.id = $1::uuid AND b.id = aol.booking_id AND b.status <> 'cancelled' AND aol.removed_at IS NULL
RETURNING ${ADDON_LINE_COLUMNS_SQL}`
const UNPREPARE_ADDON_LINE_SQL = `
UPDATE addon_order_lines aol
   SET prepared = false, prepared_at = NULL, prepared_by = NULL
  FROM bookings b
 WHERE aol.id = $1::uuid AND b.id = aol.booking_id AND b.status <> 'cancelled' AND aol.removed_at IS NULL
RETURNING ${ADDON_LINE_COLUMNS_SQL}`

/**
 * setAddonLinePrepared (`POST bookings/addon-lines/:lineId/prepared`), on and off. Any active staff member. The
 * booking is held FOR SHARE first (W48 review L2), then one guarded statement: a cancelled booking's add-ons can't be
 * changed, and neither can a line already removed from its booking (GB17). Prepared records the staff member and the
 * time; the audit row (`booking.addon_prepared_set`) says who pressed either way.
 */
export async function setAddonLinePrepared(db: Db, lineId: string, prepared: boolean, press: StaffFlagPress): Promise<AddonPreparedRouteOutput> {
  const action: AdminAction = 'booking.addon_prepared_set'
  const notFound = () => adminRefusal('NOT_FOUND', action, 'addon_line_not_found', WORDS.addonLineNotFound)
  if (!isUuid(lineId)) throw notFound()
  const row = await flagWrite<Record<string, unknown>>(
    db,
    {
      action,
      needs: 'staff',
      channels: ['staff'],
      entity: { type: 'addon_order_line', id: lineId },
      holdFirst: { sql: HOLD_BOOKING_OF_ADDON_LINE_SQL, params: [lineId] },
      statement: prepared ? { sql: PREPARE_ADDON_LINE_SQL, params: [lineId, press.actor.id] } : { sql: UNPREPARE_ADDON_LINE_SQL, params: [lineId] },
      async refusal(tx) {
        const [line] = await tx.query<{ status: string; removed: boolean }>(
          'SELECT b.status, (aol.removed_at IS NOT NULL) AS removed FROM addon_order_lines aol JOIN bookings b ON b.id = aol.booking_id WHERE aol.id = $1::uuid',
          [lineId]
        )
        if (!line) return notFound()
        if (line.status === 'cancelled') return adminRefusal('CONFLICT', action, 'booking_cancelled', WORDS.cancelledPrepared)
        if (line.removed === true) return adminRefusal('CONFLICT', action, 'addon_removed', WORDS.removedAddonPrepared)
        return changedMeanwhile(action)
      },
      recorded: (updated) => ({ booking_id: updated['booking_id'], prepared: updated['prepared'], prepared_by: updated['prepared_by'], prepared_at: iso(updated['prepared_at']) }),
      details: { prepared },
    },
    press
  )
  return { ...row, created_at: iso(row['created_at']), prepared_at: iso(row['prepared_at']), removed_at: iso(row['removed_at']) } as AddonPreparedRouteOutput
}
