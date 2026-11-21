// New in W30 (E-plan 4.4, 4.6, 4.7; Wayne's Q39, Q42, Q43): event places on the Worker, on step D's refund pipeline.
// Replaces the staff app's cancelEventPlaces and getEventCancellationQuote (shared/eventCancellation.ts,
// shared/eventCancellationQuote.ts): one place, several places or a whole event booking cancelled, with the money back
// to the card, to store credit, in cash (Q42) or not at all.
//
// R1 is one transaction with no Stripe call: the booking's order locked, then its customer, the event and the event
// booking (LOCK_ORDER), every old check in the old order with the old words, the reason rule (Q43: an event with no
// cut-off uses its start), the refund staff confirmed (Q18, bug E9: half a penny; without it nothing is cancelled), the
// plan (the card capped at the order's card money left, or Q42's cash capped at the cash paid; the rest to store
// credit), then the places cancelled and stamped with what they were worth, the booking's places lowered (cancelled at
// none), the event's places released, and the claim (`event_booking.refund_claimed`), written only when money goes
// back. With no card part R1 also gives the store credit (or records the cash) and finishes the claim: one
// transaction, nothing held. The amount stays the database function's (event_cancellation_quote): the chosen places'
// share of the event line after its promo, the last places taking exactly what is left.
//
// With a card part (bug E13: nothing is sent before the cancel and its claim are saved), R1 commits, then the press
// sends it once, keyed `<claimId>:refund:<orderId>` with `metadata.claim_id`, then R2 (one transaction): the places'
// refunded and card amounts, the card money on the event line, the store credit for the rest, the order's status, the
// claim finished.
// - Refused (nothing went): marked on the claim, then R1 undone in one transaction (the places booked again), with the
//   old words. Never store credit instead (Wayne, 14 Nov). If the released places have been sold since, or the undo
//   fails, the cancel stands and the card money is owed on the booking's order with Stripe's reason (Q39).
// - No clear answer: the claim is held and the places stay cancelled. No press ever sends it again: reconcile lists
//   the refunds on the payment, matches `metadata.claim_id`, and runs R2 (found) or leaves the money owed on the order
//   (not found). While a claim holds the order, every other cancel on the booking is refused (`refund_open`).
//
// Check-in (W52: on the Worker, server/rules/events/attendance.ts) holds the event's row FOR SHARE before its own
// statement, so it and R1, which holds the same row FOR NO KEY UPDATE, take turns: a check-in pressed while a cancel
// is in progress waits and is decided on what the cancel committed, and a cancel that starts during a check-in waits
// and reads the place as checked in. R1's own guard (each chosen place still not cancelled and not checked in, in the
// same statement that stamps it) stays as the second line.
//
// W31: `wholeEvent` (the booking is cancelled because its event was; the event's own cancel is cancel-event.ts) is
// honoured only when the event is cancelled in the database, read under the event's lock in R1: every place the
// booking has left, no cut-off rule, Card or Store credit only (Q42: a cash booking goes to store credit there). On a
// live event it is refused, so a screen can't use it to skip the cut-off. And (W30 review L1) the undo never puts
// places back, or the booking back to confirmed, on an event cancelled since R1: the cancel stands and the card money
// is owed on the order, as when the places have been resold. (A cancel made on an event that was already cancelled,
// the whole-event run's own press, is still put back after a refusal: the booking is then still to cancel, and Retry
// presses it again.)
//
// W33 (E-plan 4.11; Wayne's Q44, 15 Nov): the same R1 on the customer channel, for the website's cancel (the words and
// the answer's shape are server/rules/customer/cancels.ts). The signed-in customer cancels their own booking's places
// (some or all), always to store credit (card, cash and gift card money alike), so there is no card part, no Stripe
// client is made, and the claim is finished in R1's transaction. Refused: someone else's booking (as not found), after
// the cut-off (Q43; staff need a reason there, a customer can't give one), and on a cancelled event (the club's
// whole-event cancel gives that money back; W31 "For the Worker step" 2). No reason, no Issue refunds, never
// `wholeEvent`. The rows are the customer's (`actor_type` customer; `cancelled_by` and the store credit row's staff
// are null) and the cancel's record and its own row carry `channel: 'customer'`.
//
// What the old code needed and this doesn't (E-plan, "six things" item 4): the settle-on-the-next-press machinery
// (shared/heldCardRefund), refusal counts in the key (cardRefundAttempts), finding a store credit movement by its
// note (storeCreditRefund), the `card_refund_recorded` / `card_refund_unallocated` rows and every take-back.
import 'server-only'
import type { ApiErrorCode, CancelEventPlacesInput, CancelEventPlacesOutput, EventAttendeeBooking, EventCancelQuoteOutput } from '@/contracts'
import { audit, type AuditEntry } from '@/server/audit'
import { isDeadlock, type Db, type Queryable, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import type { StripeClient } from '@/server/stripe/client'
import { stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import { inC1 } from '@/server/rules/bookings/money-in'
import { loadOrderCardPortion, recordOrderPaymentStatus } from '@/server/rules/bookings/money-left'
import { raiseMoneyOwed } from '@/server/rules/orders/money-owed'
import { orderCashLeft } from '@/server/rules/orders/refund-lines'
import {
  markStepEClaimRefused,
  openClaimHolding,
  readEventBookingClaim,
  refundOpenRefusal,
  stepEClaimFinished,
  writeEventBookingClaim,
  type EventBookingClaim,
  type EventPlacesCancelled,
  type StepEClaimMethod,
  type StepEPlan,
} from '@/server/rules/refunds/claims'
import { CUSTOMER_CANCEL_WORDS } from '@/server/rules/customer/cancel-words'
import { lockForRefund } from '@/server/rules/refunds/locks'
import { claimRowsActor, EVENT_BOOKING_CLAIMS, heldAnswer, sendCardPart, staffIdOf, type CardPart, type ClaimActor } from '@/server/rules/refunds/pipeline'
import { claimWatchEntries, refundSeen, refundsForRow, type RefundSeen } from '@/server/rules/refunds/refund-watch'
import { loadEventAttendeeBooking } from './attendee-list'
import {
  EVENT_CANCEL_NEW_WORDS as NEW_WORDS,
  EVENT_CANCEL_WORDS as WORDS,
  EVENT_NAME_FALLBACK,
  EVENT_QUOTE_REFUSALS,
  EVENT_STORE_CREDIT_AFTER_CASH_NOTE,
  EVENT_WHOLE_CANCEL_NEW_WORDS as WHOLE_NEW_WORDS,
  EVENT_WHOLE_CANCEL_WORDS as WHOLE_WORDS,
  eventStoreCreditNote,
} from './failure-messages'

/** The action's own audit row (same transaction as what it records, E-plan 4.10): written once the cancel stands. */
export const EVENT_PLACES_CANCELLED = 'event_booking.cancel_places'

export interface EventCancelOptions {
  /** A staff member, or (W33) the customer cancelling their own places online. */
  actor: ClaimActor
  requestId: string
  /** The request's start: the press's Stripe call ends by a deadline from it. */
  startedAt?: number
  now?: () => number
  /** The Stripe client, made before R1 for a card refund, so a missing key fails with nothing written. */
  stripe?: () => StripeClient
  /** W35a (F5): the staff member's Issue refunds switch, for No refund on an event the club has cancelled. */
  canIssueRefunds: boolean
}

/** Who finishes a claim: the press, reconcile, or a person closing it by hand (as an order claim's). */
export interface EventFinishedBy {
  actor: { type: 'staff' | 'system' | 'customer'; id: string | null }
  requestId: string
  how: 'press' | 'reconcile' | 'close' | 'undo_blocked' | 'undo_failed'
  why?: string
}

/** What a claim ended with. `owed`: card money that never went, left on the booking's order as still to refund (Q39). */
export interface EventClaimOutcome {
  /** The card part, when it went. */
  went: CardPart[]
  /** W32: its refund as Stripe answered or lists it: kept on the finished row, and watched while it hasn't succeeded. */
  refunds?: RefundSeen[]
  owed: number
  /** Stripe's reason when it refused the card part, kept on the finished row. */
  refused?: string
}

/** What R2 did, for the action's own answer. */
export interface EventClaimFinished {
  places: number
  cardRefunded: number
  storeCreditRefunded: number
  cashRefunded: number
  storeCreditBalance?: number
  /** What is still to refund on the booking's order after this. */
  refundOwed: number
}

type RefundChoice = StepEClaimMethod | 'none'

const round2 = (n: number): number => Math.round(n * 100) / 100
const amountOf = (value: string | null | undefined): number => Number.parseFloat(value ?? '0')
const sum = (amounts: readonly number[]): number => round2(amounts.reduce((total, n) => total + n, 0))
/** Half a penny either way passes (Q18), rounded first: taking pounds from pounds leaves noise. */
const overHalfPenny = (amount: number, limit: number): boolean => Math.round((amount - limit) * 1e6) / 1e6 > 0.005
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// --- Refusals

type Action = 'cancel_places' | 'quote' | 'cancel_event' | 'overview'

/**
 * A refusal before anything moved: the old function's reason and its words, in `details`, so the staff app's thin
 * wrappers put the old result shape back (`ok: false, reason, message`). With the quote as it now stands when the
 * refund staff confirmed no longer fits (Q18).
 */
export function eventCancelRefusal(code: ApiErrorCode, reason: string, message: string, action: Action = 'cancel_places', extras: { quote?: EventCancelQuoteOutput; field?: string; logDetail?: string } = {}): ApiError {
  return new ApiError(code, message, {
    ...(extras.field ? { field: extras.field } : {}),
    ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
    details: { reason, message, action, ...(extras.quote ? { quote: extras.quote } : {}) },
  })
}

const notSaved = (logDetail: string): ApiError => eventCancelRefusal('INTERNAL', 'cancel_not_saved', NEW_WORDS.notSaved, 'cancel_places', { logDetail })

// --- The quote (every amount comes from the database function)

interface Quote {
  eventId: string
  customerId: string
  attendeeIds: string[]
  places: number
  wholeBooking: boolean
  value: number
  refundCutoffAt: string | null
  /** Q43 applied: with no cut-off set, before the event's start. */
  beforeCutoff: boolean
  eventStarted: boolean
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
}

/** event_cancellation_quote with the booking's status beside it (`$1` the booking, `$2` the places or NULL for all left). */
const QUOTE_SQL = `
SELECT public.event_cancellation_quote($1::uuid, $2::uuid[]) AS quote, eb.status
FROM (SELECT 1) AS one
LEFT JOIN event_bookings eb ON eb.id = $1::uuid`

/**
 * The database's quote, read and explained as the old quoteEventCancellation: a booking whose reader payment is still
 * open is told apart from a cancelled one, and each refusal keeps its old reason and words.
 *
 * Wayne's Q43 (14 Nov; bug E8): with no cut-off set, the cut-off is the event's start: before it, refund freely; after
 * it, a reason is needed. The database function used to answer `before_cutoff: false` for an event with no cut-off,
 * and W30 corrected that here. W33: migration 024 makes the function itself answer by Q43 (a null start counting as
 * before), so `before_cutoff` is read as it is, and everything that reads the function gets the same answer. The
 * migration must be applied before this code is live (its header says why).
 */
async function quotePlaces(db: Queryable, eventBookingId: string, attendeeIds: readonly string[] | undefined, action: Action): Promise<Quote> {
  const chosen = attendeeIds && attendeeIds.length > 0 ? [...attendeeIds] : null
  // A place id that isn't an id can't be on the booking.
  if (chosen && !chosen.every((id) => UUID.test(id))) {
    const refusal = EVENT_QUOTE_REFUSALS['attendee_not_found']
    throw eventCancelRefusal('NOT_FOUND', refusal?.reason ?? 'attendee_not_found', refusal?.message ?? '', action)
  }
  const row = (await db.query<{ quote: unknown; status: string | null }>(QUOTE_SQL, [eventBookingId, chosen]))[0]
  if (row?.status === 'pending') throw eventCancelRefusal('CONFLICT', 'booking_pending', WORDS.bookingPending, action)
  const parsed = parseJson(row?.quote)
  if (!parsed || parsed['ok'] !== true) {
    const refusal = EVENT_QUOTE_REFUSALS[String(parsed?.['reason'] ?? 'booking_not_found')] ?? EVENT_QUOTE_REFUSALS['booking_not_found']
    const reason = refusal?.reason ?? 'booking_not_found'
    throw eventCancelRefusal(reason === 'booking_not_found' || reason === 'attendee_not_found' ? 'NOT_FOUND' : 'CONFLICT', reason, refusal?.message ?? '', action)
  }
  const cutoff = typeof parsed['refund_cutoff_at'] === 'string' ? parsed['refund_cutoff_at'] : null
  const started = parsed['event_started'] === true
  return {
    eventId: String(parsed['event_id']),
    customerId: String(parsed['customer_id']),
    attendeeIds: Array.isArray(parsed['attendee_ids']) ? (parsed['attendee_ids'] as unknown[]).map(String) : [],
    places: Number(parsed['places'] ?? 0),
    wholeBooking: parsed['whole_booking'] === true,
    value: round2(Number(parsed['value'] ?? 0)),
    refundCutoffAt: cutoff,
    beforeCutoff: parsed['before_cutoff'] === true,
    eventStarted: started,
  }
}

/** The booking's event, and the order line (and order) that paid for it: none can be sold without one, but a row can be gone. */
interface BookingIds {
  eventId: string
  /** Whose booking it is (W33: a customer cancels only their own). */
  customerId: string
  lineId: string | null
  orderId: string | null
}

const BOOKING_IDS_SQL = `
SELECT eb.event_id, eb.customer_id, line.id AS line_id, line.order_id
FROM event_bookings eb
LEFT JOIN LATERAL (
  SELECT oli.id, oli.order_id FROM order_line_items oli
  WHERE oli.event_booking_id = eb.id AND oli.item_type = 'event'
  ORDER BY oli.created_at, oli.id LIMIT 1
) line ON true
WHERE eb.id = $1::uuid`

async function bookingIds(db: Queryable, eventBookingId: string): Promise<BookingIds | null> {
  const row = (await db.query<{ event_id: string; customer_id: string; line_id: string | null; order_id: string | null }>(BOOKING_IDS_SQL, [eventBookingId]))[0]
  return row ? { eventId: row.event_id, customerId: row.customer_id, lineId: row.line_id, orderId: row.order_id } : null
}

/** Where a refund of `value` would go, for the dialog: the card part and the rest of a Card refund, the cash Q42 allows, and any money owed. */
async function destinations(db: Queryable, ids: BookingIds | null, value: number): Promise<Pick<EventCancelQuoteOutput, 'cardAmount' | 'storeCreditAmount' | 'cashAmount' | 'refundOwed'>> {
  let cardAmount = 0
  let cashAmount = 0
  let refundOwed = 0
  if (ids?.orderId) {
    if (value > 0) {
      const portion = await loadOrderCardPortion(db, ids.orderId)
      if (portion?.paymentIntentId) cardAmount = round2(Math.min(value, portion.cardPortionRemaining))
      cashAmount = round2(Math.min(value, await orderCashLeft(db, ids.orderId)))
    }
    refundOwed = round2(amountOf((await db.query<{ owed: string }>('SELECT refund_owed_amount::text AS owed FROM orders WHERE id = $1::uuid', [ids.orderId]))[0]?.owed))
  }
  return { cardAmount, storeCreditAmount: round2(value - cardAmount), cashAmount, refundOwed }
}

const quoteOutput = (quote: Quote, where: Awaited<ReturnType<typeof destinations>>): EventCancelQuoteOutput => ({
  places: quote.places,
  wholeBooking: quote.wholeBooking,
  value: quote.value,
  refundCutoffAt: quote.refundCutoffAt,
  beforeCutoff: quote.beforeCutoff,
  eventStarted: quote.eventStarted,
  ...where,
})

/**
 * POST /event-bookings/:id/cancel/quote (getEventCancellationQuote): what the Cancel place / Cancel booking dialog
 * shows and sends back (Q18): what the places are worth now, the cut-off (Q43), where a Card refund would go, the cash
 * that can be handed back (Q42) and any money owed on the booking's order (Q39). Refused, with the cancel's own words,
 * while a refund on the booking's order is still being checked: the cancel would be refused too.
 */
export async function quoteEventPlacesCancel(db: Queryable, eventBookingId: string, attendeeIds: readonly string[] | undefined): Promise<EventCancelQuoteOutput> {
  const ids = await bookingIds(db, eventBookingId)
  if (ids?.orderId) {
    const holding = await openClaimHolding(db, ids.orderId)
    if (holding) throw refundOpenRefusal('event_booking', holding.on)
  }
  const quote = await quotePlaces(db, eventBookingId, attendeeIds, 'quote')
  return quoteOutput(quote, await destinations(db, ids, quote.value))
}

// --- W33: the customer channel's own checks

/** Someone else's booking is refused exactly as one that doesn't exist, so the answer never says it does. */
const notTheCustomers = (action: Action): ApiError => eventCancelRefusal('NOT_FOUND', 'booking_not_found', CUSTOMER_CANCEL_WORDS.eventBookingNotFound, action)

/**
 * W33 (Q44; W31 "For the Worker step" 2): what the customer channel refuses once the places are quoted: a cancel on a
 * cancelled event, and one after the cut-off (Q43, from quotePlaces: an event with no cut-off uses its start).
 */
function customerCannotCancelPlaces(quote: Quote, eventCancelled: boolean, action: Action): ApiError | null {
  if (eventCancelled) return eventCancelRefusal('CONFLICT', 'event_cancelled', CUSTOMER_CANCEL_WORDS.eventCancelled, action)
  if (!quote.beforeCutoff) return eventCancelRefusal('CONFLICT', 'after_cutoff', CUSTOMER_CANCEL_WORDS.afterCutoff, action)
  return null
}

// --- R1

/**
 * Splits `total` across places in proportion to their unit prices, the remainder on the last, so the parts always add
 * up to the total exactly (equal shares when every price is 0). Ported exactly from shared/eventCancellation.ts.
 */
export function splitByUnitPrice(total: number, unitPrices: readonly number[]): number[] {
  const n = unitPrices.length
  if (n === 0) return []
  const units = unitPrices.reduce((a, b) => a + b, 0)
  const parts: number[] = []
  let given = 0
  for (let i = 0; i < n - 1; i += 1) {
    const part = units > 0 ? round2((total * (unitPrices[i] ?? 0)) / units) : round2(total / n)
    parts.push(part)
    given = round2(given + part)
  }
  parts.push(round2(total - given))
  return parts
}

/** `done`: R1 finished the cancel itself (no card part). `card`: its claim, whose card part the press now sends. */
type Started = { kind: 'done'; output: CancelEventPlacesOutput } | { kind: 'card'; claim: EventBookingClaim }

/** With no order line there is no order to lock first: the event, then the event booking (LOCK_ORDER's order for the two). */
async function lockWithoutOrder(tx: Tx, ids: BookingIds, eventBookingId: string): Promise<void> {
  await tx.query('SELECT id FROM events WHERE id = $1::uuid FOR NO KEY UPDATE', [ids.eventId])
  await tx.query('SELECT id FROM event_bookings WHERE id = $1::uuid FOR NO KEY UPDATE', [eventBookingId])
}

/**
 * The booking's event line stamped refunded, as the old statement stamped it: once the booking is fully cancelled and
 * a refund was made on any of its places (now or for earlier ones). Its method is `card` whenever card money went
 * back on it (or a card refund of its places is still owed), `cash` when cash was handed back and no card, else
 * `credit`. A line already stamped keeps its date.
 */
async function stampEventLine(tx: Tx, eventBookingId: string): Promise<void> {
  await tx.query(
    `UPDATE order_line_items oli
     SET refunded_at = COALESCE(oli.refunded_at, now()),
         refund_method = CASE
           WHEN oli.card_refunded_amount > 0 OR EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_booking_id = oli.event_booking_id AND ea.cancelled_at IS NOT NULL AND ea.refund_method = 'card') THEN 'card'
           WHEN EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_booking_id = oli.event_booking_id AND ea.cancelled_at IS NOT NULL AND ea.refund_method = 'cash') THEN 'cash'
           ELSE 'credit' END
     FROM event_bookings eb
     WHERE oli.event_booking_id = $1::uuid AND oli.item_type = 'event' AND eb.id = oli.event_booking_id AND eb.status = 'cancelled'
       AND EXISTS (SELECT 1 FROM event_attendees ea
                   WHERE ea.event_booking_id = oli.event_booking_id AND ea.cancelled_at IS NOT NULL AND ea.refund_method IN ('card', 'credit', 'cash'))`,
    [eventBookingId]
  )
}

/** The answer's last two fields: the booking as the attendee list shows it now, and the event's places booked. */
async function listState(db: Queryable, eventBookingId: string, eventId: string): Promise<{ booking: EventAttendeeBooking | null; eventPlacesBooked?: number }> {
  const booking = await loadEventAttendeeBooking(db, eventBookingId)
  const booked = (await db.query<{ places_booked: number }>('SELECT places_booked FROM events WHERE id = $1::uuid', [eventId]))[0]?.places_booked
  return { booking, ...(booked !== undefined && booked !== null ? { eventPlacesBooked: Number(booked) } : {}) }
}

async function cancelR1(tx: Tx, eventBookingId: string, input: CancelEventPlacesInput, refund: RefundChoice, options: EventCancelOptions, livemode: boolean | null, unlocked: BookingIds | null): Promise<Started> {
  // The locks, from the ids read with no lock; then everything is read again under them (E-plan 4.2).
  if (unlocked?.orderId) await lockForRefund(tx, { orderId: unlocked.orderId, eventId: unlocked.eventId, eventBookingId })
  else if (unlocked) await lockWithoutOrder(tx, unlocked, eventBookingId)
  const ids = await bookingIds(tx, eventBookingId)
  // W33: the customer channel cancels the customer's own booking only; anyone else's is refused as one that isn't there.
  const online = options.actor.type === 'customer'
  if (online && ids?.customerId !== options.actor.id) throw notTheCustomers('cancel_places')
  // The line can't move to another order; a line that appeared or went between the two reads is tried again by the press.
  if ((ids?.orderId ?? null) !== (unlocked?.orderId ?? null)) throw eventCancelRefusal('CONFLICT', 'changed_by_someone_else', WORDS.changedBySomeoneElse)

  // A refund still being checked on the booking's order holds every cancel on the booking, refund or not: its undo
  // puts its places back, and its money isn't settled yet.
  if (ids?.orderId) {
    const holding = await openClaimHolding(tx, ids.orderId)
    if (holding) throw refundOpenRefusal('event_booking', holding.on)
  }

  // The old function's checks, in its order. A whole-event cancel is always every place the booking has left.
  const whole = input.wholeEvent === true
  const quote = await quotePlaces(tx, eventBookingId, whole ? undefined : input.attendeeIds, 'cancel_places')
  let reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null
  // W31: whether the event is cancelled already. Its row is locked above, and the event's own cancel takes the same
  // lock, so this read can't be overtaken. Kept on the claim: the undo needs to know if the event was cancelled since.
  const event = (await tx.query<{ cancelled: boolean; cancel_reason: string | null }>('SELECT cancelled_at IS NOT NULL AS cancelled, cancel_reason FROM events WHERE id = $1::uuid', [quote.eventId]))[0]
  const eventCancelled = event?.cancelled === true
  if (whole) {
    // Honoured only when the event is cancelled in the database. With no reason sent, the event's own is recorded.
    if (!eventCancelled) throw eventCancelRefusal('CONFLICT', 'event_not_cancelled', WHOLE_NEW_WORDS.eventNotCancelled)
    reason ??= event?.cancel_reason ?? null
  }
  // W35a (W35 audit F5, Wayne 15 Nov): on an event the club has cancelled, No refund needs Issue refunds too. The
  // place would be stamped with its value and the whole-event run would pass it by, so the customer would get nothing
  // for an event the club called off. On a live event No refund stays open to every active staff member. Read under
  // the event's lock, which the event's own cancel takes. The route's own permission answer (FORBIDDEN, no reason of
  // its own). W52: in words of its own, which say why a No refund needs the permission here.
  if (!online && eventCancelled && refund === 'none' && !options.canIssueRefunds) throw new ApiError('FORBIDDEN', WHOLE_NEW_WORDS.noRefundNeedsIssueRefunds)
  // No cut-off rule for a whole event: nobody chose to cancel late.
  const afterCutoff = !whole && !quote.beforeCutoff
  // W33 (Q44): online, not on a cancelled event and only before the cut-off (staff can refund later, with a reason).
  if (online) {
    const cannot = customerCannotCancelPlaces(quote, eventCancelled, 'cancel_places')
    if (cannot) throw cannot
  }
  if (refund !== 'none' && afterCutoff && !reason) throw eventCancelRefusal('VALIDATION', 'reason_required_after_cutoff', WORDS.reasonRequiredAfterCutoff, 'cancel_places', { field: 'reason' })
  const value = refund === 'none' ? 0 : quote.value
  if (value > 0 && (!ids?.lineId || !ids.orderId)) throw eventCancelRefusal('NOT_FOUND', 'order_not_found', WORDS.orderLineNotFound)

  // The refund staff confirmed (Q18; bug E9: the dialog showed one figure and another went). £0 for No refund.
  const asItStands = async (): Promise<EventCancelQuoteOutput> => quoteOutput(quote, await destinations(tx, ids, quote.value))
  const confirmed = input.confirmed?.refund
  if (typeof confirmed !== 'number' || !Number.isFinite(confirmed)) {
    throw eventCancelRefusal('VALIDATION', 'amount_not_confirmed', NEW_WORDS.amountNotConfirmed, 'cancel_places', { field: 'confirmed', quote: await asItStands() })
  }
  if (overHalfPenny(confirmed, value) || overHalfPenny(value, confirmed)) {
    throw eventCancelRefusal('CONFLICT', 'figures_changed', NEW_WORDS.figuresChanged, 'cancel_places', { quote: await asItStands() })
  }

  // Where it goes: the card capped at the order's card money left, or Q42's cash capped at the cash paid on the order;
  // the rest to store credit. No card payment on the order: it all goes to store credit, as before.
  let cardAmount = 0
  let cash = 0
  let paymentIntentId: string | null = null
  if (value > 0 && ids?.orderId) {
    if (refund === 'card') {
      const portion = await loadOrderCardPortion(tx, ids.orderId)
      if (!portion) throw eventCancelRefusal('NOT_FOUND', 'order_not_found', WORDS.orderNotFound)
      paymentIntentId = portion.paymentIntentId
      if (paymentIntentId) cardAmount = round2(Math.min(value, portion.cardPortionRemaining))
    }
    if (refund === 'cash') {
      const cashLeft = await orderCashLeft(tx, ids.orderId)
      if (!(cashLeft > 0)) throw eventCancelRefusal('CONFLICT', 'no_cash_left', NEW_WORDS.noCashLeft, 'cancel_places', { quote: await asItStands() })
      cash = round2(Math.min(value, cashLeft))
    }
  }
  const storeCredit = round2(value - cardAmount - cash)

  // The places, in the old order (oldest first), with what each was worth.
  const places = await tx.query<{ id: string; unit_price: string }>('SELECT ea.id, ea.unit_price::text AS unit_price FROM event_attendees ea WHERE ea.id = ANY($1::uuid[]) ORDER BY ea.created_at, ea.id', [quote.attendeeIds])
  const unitPrices = places.map((place) => amountOf(place.unit_price))
  const values = splitByUnitPrice(quote.value, unitPrices)
  // The place's stamp: `card` when a card part is planned, `cash` when cash is handed back, `credit` for store credit
  // alone, `none` when nothing goes back (No refund, or places worth £0).
  const placeMethod: RefundChoice = value <= 0 ? 'none' : cardAmount > 0 ? 'card' : cash > 0 ? 'cash' : 'credit'
  const refundAfterCutoff = refund !== 'none' && afterCutoff

  // The places stamped. Each must still be there to cancel, as the old statement required: not cancelled and not
  // checked in. Since W52 a check-in holds the event's row FOR SHARE (events/attendance.ts) and this cancel holds it
  // FOR NO KEY UPDATE, so neither can land during the other; this guard is the second line (the header, above).
  const stamped = await tx.query(
    `UPDATE event_attendees ea
     SET cancelled_at = now(), cancelled_by = $1::uuid, cancel_reason = $2::text, cancelled_value = s.val,
         refunded_amount = 0, card_refunded_amount = 0, refund_method = $3::text, refund_after_cutoff = $4::boolean
     FROM unnest($5::uuid[], $6::numeric[]) AS s(id, val)
     WHERE ea.id = s.id AND ea.event_booking_id = $7::uuid AND ea.cancelled_at IS NULL AND ea.checked_in_at IS NULL
     RETURNING ea.id`,
    // cancelled_by points at staff: null when the customer cancelled online (W33).
    [staffIdOf(options.actor), reason, placeMethod, refundAfterCutoff, places.map((place) => place.id), values, eventBookingId]
  )
  if (stamped.length !== places.length || places.length !== quote.places) throw eventCancelRefusal('CONFLICT', 'changed_by_someone_else', WORDS.changedBySomeoneElse)

  // The booking's places lowered, and the booking cancelled when none are left.
  const booking = (
    await tx.query<{ status: string }>(
      `UPDATE event_bookings eb
       SET places = eb.places - $1::int,
           status = CASE WHEN eb.places - $1::int <= 0 THEN 'cancelled' ELSE eb.status END,
           cancelled_at = CASE WHEN eb.places - $1::int <= 0 THEN now() ELSE eb.cancelled_at END,
           cancelled_by = CASE WHEN eb.places - $1::int <= 0 THEN $2::uuid ELSE eb.cancelled_by END,
           cancel_reason = CASE WHEN eb.places - $1::int <= 0 THEN $3::text ELSE eb.cancel_reason END,
           updated_at = now()
       WHERE eb.id = $4::uuid AND eb.status = 'confirmed' AND eb.places >= $1::int
       RETURNING eb.status`,
      [places.length, staffIdOf(options.actor), reason, eventBookingId]
    )
  )[0]
  if (!booking) throw eventCancelRefusal('CONFLICT', 'changed_by_someone_else', WORDS.changedBySomeoneElse)
  await tx.query('SELECT public.release_event_places($1::uuid, $2::int)', [quote.eventId, places.length])

  const cancelled: EventPlacesCancelled = {
    eventId: quote.eventId,
    lineId: ids?.lineId ?? '',
    places: places.map((place, index) => ({ id: place.id, value: values[index] ?? 0, unitPrice: unitPrices[index] ?? 0 })),
    bookingCancelled: booking.status === 'cancelled',
    afterCutoff: refundAfterCutoff,
    ...(whole ? { wholeEvent: true } : {}),
    ...(eventCancelled ? { eventCancelled: true } : {}),
    ...(online ? { channel: 'customer' as const } : {}),
  }

  // Nothing goes back: the cancel is whole here, with its own row. No claim (E-plan 4.4: only when money goes back).
  if (!(value > 0) || !ids?.orderId || !ids.lineId) {
    await stampEventLine(tx, eventBookingId)
    await audit.recordAll(tx, [cancelRow(eventBookingId, { actorType: options.actor.type, actorId: options.actor.id }, options.requestId, { refund, reason, cancelled, amount: 0, cardRefunded: 0, storeCreditRefunded: 0, cashRefunded: 0, owed: 0 })])
    return { kind: 'done', output: { places: places.length, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, ...(await listState(tx, eventBookingId, quote.eventId)) } }
  }

  const parts: CardPart[] = cardAmount > 0 && paymentIntentId ? [{ orderId: ids.orderId, paymentIntentId, amount: cardAmount, lines: [{ lineId: ids.lineId, amount: cardAmount }] }] : []
  const plan: StepEPlan = { card: parts, storeCredit: storeCredit > 0.005 ? storeCredit : 0, cash, ownOrderId: ids.orderId }
  // W33: nothing online ever goes back to a card or is handed over in cash. Thrown inside R1, so nothing is kept.
  if (online && (parts.length > 0 || cash > 0)) throw new Error('A customer cancel planned a card or cash refund.')
  const claim = await writeEventBookingClaim(
    tx,
    eventBookingId,
    {
      kind: 'cancel_places',
      orderId: ids.orderId,
      amount: value,
      method: refund as StepEClaimMethod,
      reason,
      worker: true,
      plan,
      livemode: parts.length > 0 ? livemode : null,
      ...(cash > 0 ? { handedOverBy: options.actor.id } : {}),
      cancel: cancelled,
      ...(online ? { channel: 'customer' as const } : {}),
    },
    options
  )
  if (parts.length > 0) return { kind: 'card', claim }
  const finished = await finishEventClaimInTransaction(tx, claim, { went: [], owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!finished) throw new Error(`Event refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output: { ...cancelOutput(finished), ...(await listState(tx, eventBookingId, quote.eventId)) } }
}

/** The cancel's own row: what was cancelled, the refund asked for, and where the money went. */
function cancelRow(
  eventBookingId: string,
  /** The staff member who pressed, or (W33) the customer who cancelled online. */
  by: { actorType: 'staff' | 'customer'; actorId: string | null },
  requestId: string,
  details: { refund: RefundChoice; reason: string | null; cancelled: EventPlacesCancelled; amount: number; cardRefunded: number; storeCreditRefunded: number; cashRefunded: number; owed: number; handedOverBy?: string | null }
): AuditEntry {
  const { cancelled } = details
  return {
    ...by,
    action: EVENT_PLACES_CANCELLED,
    entityType: 'event_booking',
    entityId: eventBookingId,
    requestId,
    details: {
      attendeeIds: cancelled.places.map((place) => place.id),
      places: cancelled.places.length,
      value: sum(cancelled.places.map((place) => place.value)),
      bookingCancelled: cancelled.bookingCancelled,
      refund: details.refund,
      reason: details.reason,
      afterCutoff: cancelled.afterCutoff,
      ...(cancelled.wholeEvent ? { wholeEvent: true } : {}),
      ...(cancelled.channel === 'customer' ? { channel: 'customer' } : {}),
      amount: details.amount,
      cardRefunded: details.cardRefunded,
      storeCreditRefunded: details.storeCreditRefunded,
      owed: details.owed,
      ...(details.cashRefunded > 0 ? { cashRefunded: details.cashRefunded, handedOverBy: details.handedOverBy ?? null } : {}),
    },
  }
}

/** cancelEventPlaces's answer, in the old function's fields, from what R2 did (the list's state is added by the caller). */
function cancelOutput(finished: EventClaimFinished): Omit<CancelEventPlacesOutput, 'booking'> {
  return {
    places: finished.places,
    refundedAmount: round2(finished.cardRefunded + finished.storeCreditRefunded + finished.cashRefunded),
    cardRefundedAmount: finished.cardRefunded,
    storeCreditRefundedAmount: finished.storeCreditRefunded,
    ...(finished.cashRefunded > 0 ? { cashRefundedAmount: finished.cashRefunded } : {}),
    ...(finished.storeCreditBalance !== undefined ? { storeCreditBalance: finished.storeCreditBalance } : {}),
    ...(finished.refundOwed > 0 ? { refundOwed: finished.refundOwed } : {}),
  }
}

// --- R2: what went is recorded on the places and the line, the store credit given, what never went owed, the claim finished

function cancelOf(claim: EventBookingClaim): EventPlacesCancelled {
  const cancelled = claim.details.cancel
  if (!cancelled || cancelled.places.length === 0 || !cancelled.lineId) throw new Error(`Event refund claim ${claim.id} doesn't say which places it cancelled.`)
  return cancelled
}

/**
 * R2, inside a transaction the caller opened: the booking's order locked (then its customer, the event and the event
 * booking), then, unless the claim is finished already (null): what was given back written on the claim's places
 * (shared out by unit price, the remainder on the last, as before); the card part that went added to the event line;
 * the plan's store credit given as one store credit refund linked to the order; card money that never went, or that
 * Stripe refused, left on the order as owed (Q39: never as store credit instead); the event line stamped once the
 * booking is fully cancelled; the order's status worked out again; the cancel's own row and the claim's finished row.
 * Throws on any failure, so the caller's transaction keeps nothing.
 */
export async function finishEventClaimInTransaction(tx: Tx, claim: EventBookingClaim, outcome: EventClaimOutcome, by: EventFinishedBy): Promise<EventClaimFinished | null> {
  const cancelled = cancelOf(claim)
  const locks = await lockForRefund(tx, { orderId: claim.orderId, eventId: cancelled.eventId, eventBookingId: claim.eventBookingId })
  if (!locks) throw new Error(`The order of event refund claim ${claim.id} no longer exists.`)
  if (await stepEClaimFinished(tx, claim)) return null
  const { details } = claim
  const { plan } = details

  const cardRefunded = sum(outcome.went.map((part) => part.amount))
  const owed = round2(outcome.owed)
  const storeCredit = round2(plan.storeCredit)
  const cash = round2(plan.cash)
  const given = round2(cardRefunded + storeCredit + cash)

  // What each place got back, and how much of it on the card.
  const unitPrices = cancelled.places.map((place) => place.unitPrice)
  const refundedParts = splitByUnitPrice(given, unitPrices)
  const cardParts = splitByUnitPrice(cardRefunded, unitPrices)
  await tx.query(
    `UPDATE event_attendees ea
     SET refunded_amount = s.refunded, card_refunded_amount = s.card
     FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS s(id, refunded, card)
     WHERE ea.id = s.id AND ea.event_booking_id = $4::uuid`,
    [cancelled.places.map((place) => place.id), refundedParts, cardParts, claim.eventBookingId]
  )
  for (const part of outcome.went) {
    for (const line of part.lines) {
      await tx.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1::numeric WHERE id = $2::uuid', [line.amount, line.lineId])
    }
  }

  let balance: number | undefined
  if (storeCredit > 0) {
    const event = (await tx.query<{ name: string | null }>('SELECT name FROM events WHERE id = $1::uuid', [cancelled.eventId]))[0]
    const eventName = event?.name ?? EVENT_NAME_FALLBACK
    // "The rest went back to the card" is said only when it did (a card part left owed hasn't gone back).
    const note = `${cash > 0 ? EVENT_STORE_CREDIT_AFTER_CASH_NOTE(eventName) : eventStoreCreditNote(eventName, cardRefunded)} [ref ${crypto.randomUUID()}]`
    const applied = (
      await tx.query<{ result: { ok?: boolean; reason?: string; balance?: number | string } | null }>(
        'SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, $4::uuid, NULL::uuid, $5::uuid, $6::text, NULL::uuid) AS result',
        [locks.customerId, storeCredit, 'refund', claim.orderId, claim.staffId, note]
      )
    )[0]?.result
    if (applied?.ok !== true) throw new Error(`The store credit refund was refused: ${applied?.reason ?? 'no answer'}.`)
    balance = applied.balance !== undefined && applied.balance !== null ? Number(applied.balance) : undefined
  }
  const owedNow = owed > 0 ? await raiseMoneyOwed(tx, claim.orderId, owed) : round2(amountOf((await tx.query<{ owed: string }>('SELECT refund_owed_amount::text AS owed FROM orders WHERE id = $1::uuid', [claim.orderId]))[0]?.owed))
  await stampEventLine(tx, claim.eventBookingId)
  await recordOrderPaymentStatus(tx, claim.orderId)

  const finishedBy = by.how === 'press' ? {} : { by: { how: by.how, type: by.actor.type, id: by.actor.id, ...(by.why ? { why: by.why } : {}) } }
  await audit.recordAll(tx, [
    cancelRow(claim.eventBookingId, claimRowsActor(claim), by.requestId, {
      refund: details.method,
      reason: details.reason,
      cancelled,
      amount: details.amount,
      cardRefunded,
      storeCreditRefunded: storeCredit,
      cashRefunded: cash,
      owed,
      handedOverBy: details.handedOverBy ?? null,
    }),
    {
      ...claimRowsActor(claim),
      action: EVENT_BOOKING_CLAIMS.finished,
      entityType: 'event_booking',
      entityId: claim.eventBookingId,
      requestId: by.requestId,
      details: {
        claimId: claim.id,
        outcome: owed > 0 ? 'owed' : 'given',
        cardRefunded,
        storeCreditRefunded: storeCredit,
        owed,
        ...(cash > 0 ? { cash } : {}),
        ...(outcome.refused !== undefined ? { refused: outcome.refused } : {}),
        ...refundsForRow(outcome.went, outcome.refunds),
        ...finishedBy,
      },
    },
    // W32: a refund that hadn't succeeded yet is watched from the same transaction that records it as gone.
    ...claimWatchEntries({ id: claim.id, on: 'event_booking', subjectId: claim.eventBookingId, livemode: details.livemode }, outcome.went, outcome.refunds, { actor: by.actor, requestId: by.requestId }),
  ])
  return {
    places: cancelled.places.length,
    cardRefunded,
    storeCreditRefunded: storeCredit,
    cashRefunded: cash,
    ...(balance !== undefined ? { storeCreditBalance: balance } : {}),
    refundOwed: owedNow,
  }
}

/** R2 in a transaction of its own, run once more after a deadlock (it is safe twice: the finished row is checked). */
export async function finishEventClaim(db: Db, claim: EventBookingClaim, outcome: EventClaimOutcome, by: EventFinishedBy): Promise<EventClaimFinished | null> {
  try {
    return await db.transaction((tx) => finishEventClaimInTransaction(tx, claim, outcome, by))
  } catch (err) {
    if (!isDeadlock(err)) throw err
    return db.transaction((tx) => finishEventClaimInTransaction(tx, claim, outcome, by))
  }
}

// --- The undo (the card part was refused, so nothing went)

/**
 * The undo can't put the places back: the places R1 released have been booked by someone else since, so the event has
 * no room for them; or (W31, W30 review L1) the whole event has been cancelled since R1, and a booking must never go
 * back to confirmed on a cancelled event. Thrown inside the undo's transaction, so nothing of the undo is kept: the
 * cancel stands, and the press finishes the claim there and then with the card money owed on the order (E-plan 4.4).
 */
export class EventPlacesPutBackBlocked extends Error {
  /** `booked`: the event has no room for them any more. `event_cancelled` (W31): the event was cancelled after R1. */
  readonly why: 'booked' | 'event_cancelled'
  constructor(why: 'booked' | 'event_cancelled', what: string) {
    super(`The undo can't put the places back: ${what}.`)
    this.name = 'EventPlacesPutBackBlocked'
    this.why = why
  }
}

/**
 * R1 undone in one transaction: the event's places taken again (only while it has room for them), the booking's
 * places raised and the booking confirmed again, each place as it was before the cancel. False when the claim was
 * finished already. The event line was never stamped by R1 (R2 stamps it), so there is nothing to unstamp.
 */
async function undoEventClaimOnce(db: Db, claim: EventBookingClaim, by: EventFinishedBy): Promise<boolean> {
  return db.transaction(async (tx) => {
    const cancelled = cancelOf(claim)
    const locks = await lockForRefund(tx, { orderId: claim.orderId, eventId: cancelled.eventId, eventBookingId: claim.eventBookingId })
    if (!locks) throw new Error(`The order of event refund claim ${claim.id} no longer exists.`)
    if (await stepEClaimFinished(tx, claim)) return false
    const n = cancelled.places.length
    // W31 (W30 review L1): the event's row is locked above, as the event's own cancel locks it, so this is current.
    // Places are never put back on an event cancelled since R1: the whole-event run passed this booking by while its
    // claim was open, and afterwards it would sit confirmed on a cancelled event. A cancel made when the event was
    // already cancelled (the whole-event run's own press, `eventCancelled` on the claim) is put back as before: the
    // booking is then one still to cancel, which the overview lists and Retry presses again.
    const event = (await tx.query<{ cancelled: boolean }>('SELECT cancelled_at IS NOT NULL AS cancelled FROM events WHERE id = $1::uuid', [cancelled.eventId]))[0]
    if (event?.cancelled === true && cancelled.eventCancelled !== true) throw new EventPlacesPutBackBlocked('event_cancelled', `event ${cancelled.eventId} has been cancelled since`)
    // An undo is not a sale: it needs room, not an event that is on sale (claim_event_places also asks for that).
    const retaken = await tx.query(
      'UPDATE events SET places_booked = places_booked + $1::int, updated_at = now() WHERE id = $2::uuid AND (capacity IS NULL OR places_booked + $1::int <= capacity) RETURNING id',
      [n, cancelled.eventId]
    )
    if (retaken.length !== 1) throw new EventPlacesPutBackBlocked('booked', `the ${n} released on event ${cancelled.eventId} have been booked since`)
    const restored = await tx.query(
      `UPDATE event_attendees
       SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, cancelled_value = 0, refunded_amount = 0, card_refunded_amount = 0,
           refund_method = NULL, refund_after_cutoff = false
       WHERE id = ANY($1::uuid[]) AND event_booking_id = $2::uuid AND cancelled_at IS NOT NULL
       RETURNING id`,
      [cancelled.places.map((place) => place.id), claim.eventBookingId]
    )
    if (restored.length !== n) throw new Error(`The places of event refund claim ${claim.id} are no longer as its cancel left them.`)
    const booking = await tx.query(
      `UPDATE event_bookings
       SET places = places + $1::int, status = 'confirmed', cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL, updated_at = now()
       WHERE id = $2::uuid RETURNING id`,
      [n, claim.eventBookingId]
    )
    if (booking.length !== 1) throw new Error(`The event booking of refund claim ${claim.id} no longer exists.`)
    await audit.recordAll(tx, [
      {
        actorType: 'staff',
        actorId: claim.staffId,
        action: EVENT_BOOKING_CLAIMS.finished,
        entityType: 'event_booking',
        entityId: claim.eventBookingId,
        requestId: by.requestId,
        details: { claimId: claim.id, outcome: 'put_back', cardRefunded: 0, storeCreditRefunded: 0, owed: 0 },
      },
    ])
    return true
  })
}

/** The undo, run once more after a deadlock, as R2 is: nothing of the ended try is kept and nothing outside the database is called. */
async function undoEventClaim(db: Db, claim: EventBookingClaim, by: EventFinishedBy): Promise<boolean> {
  try {
    return await undoEventClaimOnce(db, claim, by)
  } catch (err) {
    if (!isDeadlock(err)) throw err
    return undoEventClaimOnce(db, claim, by)
  }
}

// --- The press: the card part once, then R2

type Held = { claimId: string; reason: string; message: string }
/** What the press ended with: R2's result (with words when the refusal couldn't be put back), or a claim held for reconcile. */
type Pressed = { finished: EventClaimFinished; held?: Held } | { finished: null; held: Held; cardGone: number }

/**
 * The card part was refused and the undo didn't put the places back (they have been sold, or it failed), so the cancel
 * stands. The claim is finished now with no card money gone and the card money owed on the order, Stripe's reason
 * kept: a person uses Refund the rest. R2 gives the plan's store credit all the same, and the words name it (W30a). If the finish fails too, the claim stays open with the refusal's mark, and reconcile
 * finishes it the same way. Null when the claim was finished already (the undo's COMMIT went through and only its
 * answer was lost).
 */
async function finishRefusedNotPutBack(db: Db, claim: EventBookingClaim, options: EventCancelOptions, detail: string, blocked: EventPlacesPutBackBlocked['why'] | null): Promise<{ finished: EventClaimFinished | null; held: Held } | null> {
  const owed = sum(claim.details.plan.card.map((part) => part.amount))
  const reason = 'refund_refused_not_put_back'
  // Why the places stay cancelled: resold, the event cancelled since (W31), or the undo failed for another reason.
  const words = blocked === 'event_cancelled' ? NEW_WORDS.putBackEventCancelled : blocked === 'booked' ? NEW_WORDS.putBackBlocked : NEW_WORDS.putBackFailed
  const notRecorded = blocked === 'event_cancelled' ? NEW_WORDS.putBackEventCancelledNotRecorded : blocked === 'booked' ? NEW_WORDS.putBackBlockedNotRecorded : NEW_WORDS.putBackFailedNotRecorded
  try {
    const finished = await finishEventClaim(db, claim, { went: [], owed, refused: detail }, { actor: options.actor, requestId: options.requestId, how: blocked ? 'undo_blocked' : 'undo_failed', why: detail })
    if (!finished) return null
    return { finished, held: { claimId: claim.id, reason, message: words(detail, owed, finished.storeCreditRefunded) } }
  } catch {
    return { finished: null, held: { claimId: claim.id, reason, message: notRecorded(detail) } }
  }
}

/**
 * After R1 has committed a claim with its card part: the part once, then R2. A refusal is marked on the claim first
 * (`event_booking.refund_refused`), then R1 is undone and the refusal thrown with the old words; an undo that doesn't
 * put the places back ends as money owed. No clear answer holds the claim for reconcile, as does R2 failing after the
 * money went (what went is never sent again: reconcile records it).
 */
async function sendAndFinish(db: Db, stripe: StripeClient, claim: EventBookingClaim, options: EventCancelOptions, timing: StripeTiming): Promise<Pressed> {
  const by: EventFinishedBy = { actor: options.actor, requestId: options.requestId, how: 'press' }
  const part = claim.details.plan.card[0]
  if (!part) throw new Error(`Event refund claim ${claim.id} has no card part to send.`)
  const held = (reason: string, message: string, cardGone = 0): Pressed => ({ finished: null, held: heldAnswer(claim.id, reason, message, cardGone).held, cardGone })
  const answer = await sendCardPart(stripe, claim.id, part, timing)
  if (answer.outcome === 'unclear') return held('refund_unconfirmed', NEW_WORDS.unconfirmed)
  if (answer.outcome !== 'went') {
    // Stripe's refusal is on the claim before the undo is tried, so reconcile never reads it as "not found".
    if (answer.outcome === 'refused') await markStepEClaimRefused(db, claim, answer.detail, options.requestId)
    const detail = answer.outcome === 'not_sent' ? NEW_WORDS.notSentDetail : answer.detail
    try {
      await undoEventClaim(db, claim, by)
    } catch (err) {
      const ended = await finishRefusedNotPutBack(db, claim, options, detail, err instanceof EventPlacesPutBackBlocked ? err.why : null)
      if (ended?.finished) return { finished: ended.finished, held: ended.held }
      if (ended) return { finished: null, held: ended.held, cardGone: 0 }
    }
    // The old function's words for Stripe's refusal; plain words for a refund the press had no time left to send.
    throw eventCancelRefusal('PAYMENT_FAILED', 'refund_failed', answer.outcome === 'not_sent' ? NEW_WORDS.notSentInTime : WORDS.cardRefundFailed(detail || undefined))
  }
  try {
    const finished = await finishEventClaim(db, claim, { went: [part], refunds: [refundSeen(part, answer.refund)], owed: 0 }, by)
    // Finished by someone else (a close): what went is theirs to report.
    return finished ? { finished } : held('refund_finished_elsewhere', NEW_WORDS.goneNotRecorded(part.amount), part.amount)
  } catch {
    return held('refund_not_recorded', NEW_WORDS.goneNotRecorded(part.amount), part.amount)
  }
}

/**
 * POST /event-bookings/:id/cancel (cancelEventPlaces): one place, several places or the whole booking cancelled, with
 * the refund to the card (capped at the order's card money left, the rest to store credit), to store credit, in cash
 * (Q42: up to the cash paid on the order, the rest to store credit) or with no refund. A refusal before anything
 * changed is an ApiError with the old reason and words; a held claim answers as data, with the places cancelled.
 * The route checks Issue refunds for any money back, and the switch; R1 checks it for No refund on a cancelled event (W35a). W31: with `wholeEvent` it is cancelEvent's
 * per-booking half (the whole booking, no cut-off rule, Card or Store credit), once the event itself is cancelled.
 */
export async function cancelEventPlaces(db: Db, eventBookingId: string, input: CancelEventPlacesInput, options: EventCancelOptions): Promise<CancelEventPlacesOutput> {
  // The old function's param checks, before anything is read.
  if (!eventBookingId) throw eventCancelRefusal('VALIDATION', 'invalid_params', WORDS.chooseBooking)
  if (input.attendeeIds !== undefined && (!Array.isArray(input.attendeeIds) || input.attendeeIds.length === 0)) throw eventCancelRefusal('VALIDATION', 'invalid_params', WORDS.choosePlace)
  const refund = input.refund
  // W31 (Q42): a whole event goes back to the card or to store credit only, in the old cancelEvent's words.
  if (input.wholeEvent === true && refund !== 'card' && refund !== 'credit') throw eventCancelRefusal('VALIDATION', 'invalid_params', WHOLE_WORDS.chooseRefund, 'cancel_places', { field: 'refund' })
  if (refund !== 'card' && refund !== 'credit' && refund !== 'cash' && refund !== 'none') throw eventCancelRefusal('VALIDATION', 'invalid_params', WORDS.chooseRefund, 'cancel_places', { field: 'refund' })

  // A card refund needs Stripe: the client is made before R1, so a missing key fails with nothing written.
  const stripe = refund === 'card' && options.stripe ? options.stripe() : null
  const timing = stripeTiming(options.startedAt ?? Date.now(), options.now ?? Date.now)
  const unlocked = await bookingIds(db, eventBookingId)
  // A COMMIT with no answer (INTERNAL) may have saved a claim whose card part was never sent: reconcile finds it,
  // finds nothing in Stripe, and the money ends as owed on the booking's order (Refund the rest).
  const started = await inC1(db, (tx) => cancelR1(tx, eventBookingId, input, refund, options, stripe?.keyLivemode ?? null, unlocked), notSaved)
  if (started.kind === 'done') return started.output
  if (!stripe) throw new Error('A card refund was planned with no Stripe client.')
  const { claim } = started
  const pressed = await sendAndFinish(db, stripe, claim, options, timing)
  const state = await listState(db, eventBookingId, cancelOf(claim).eventId).catch(() => ({ booking: null }))
  if (pressed.finished) return { ...cancelOutput(pressed.finished), ...state, ...(pressed.held ? { held: pressed.held } : {}) }
  return { places: cancelOf(claim).places.length, refundedAmount: pressed.cardGone, cardRefundedAmount: pressed.cardGone, storeCreditRefundedAmount: 0, ...state, held: pressed.held }
}

// --- W33: the customer's own cancel online (Q44)

/** What the customer's cancel of these places would give: all of it to store credit. */
export interface CustomerEventCancelQuote {
  places: number
  wholeBooking: boolean
  value: number
  refundCutoffAt: string | null
}

/**
 * W33: the quote for the customer's own cancel (some places, or all with none named). Reads only, in R1's order:
 * someone else's booking is not found; then a refund still being checked on its order, the database's own refusals
 * (a payment still open, a booking or place already cancelled, a place checked in), a cancelled event, the cut-off.
 * Each is thrown with the staff reason; cancels.ts gives it the customer's words.
 */
export async function quoteEventPlacesCancelForCustomer(db: Queryable, eventBookingId: string, attendeeIds: readonly string[] | undefined, customerId: string): Promise<CustomerEventCancelQuote> {
  const ids = await bookingIds(db, eventBookingId)
  if (!ids || ids.customerId !== customerId) throw notTheCustomers('quote')
  if (ids.orderId) {
    const holding = await openClaimHolding(db, ids.orderId)
    if (holding) throw refundOpenRefusal('event_booking', holding.on)
  }
  const quote = await quotePlaces(db, eventBookingId, attendeeIds, 'quote')
  const event = (await db.query<{ cancelled: boolean }>('SELECT cancelled_at IS NOT NULL AS cancelled FROM events WHERE id = $1::uuid', [quote.eventId]))[0]
  const cannot = customerCannotCancelPlaces(quote, event?.cancelled === true, 'quote')
  if (cannot) throw cannot
  return { places: quote.places, wholeBooking: quote.wholeBooking, value: quote.value, refundCutoffAt: quote.refundCutoffAt }
}

/**
 * W33 (Q44): the customer cancels places on their own event booking online (all of them with none named), with the
 * store credit they confirmed (Q18: required). One transaction (R1, which finishes its own claim): the refund is
 * always store credit, so there is no card part, no Stripe client is made and nothing can be held.
 */
export async function cancelEventPlacesForCustomer(
  db: Db,
  eventBookingId: string,
  input: { attendeeIds?: string[] | undefined; confirmed: { refund: number } },
  customer: { id: string },
  requestId: string
): Promise<CancelEventPlacesOutput> {
  if (input.attendeeIds !== undefined && input.attendeeIds.length === 0) throw eventCancelRefusal('VALIDATION', 'invalid_params', WORDS.choosePlace)
  const unlocked = await bookingIds(db, eventBookingId)
  if (!unlocked || unlocked.customerId !== customer.id) throw notTheCustomers('cancel_places')
  const options: EventCancelOptions = { actor: { type: 'customer', id: customer.id }, requestId, canIssueRefunds: true }
  const press: CancelEventPlacesInput = { ...(input.attendeeIds ? { attendeeIds: input.attendeeIds } : {}), refund: 'credit', confirmed: input.confirmed }
  const started = await inC1(db, (tx) => cancelR1(tx, eventBookingId, press, 'credit', options, null, unlocked), notSaved)
  if (started.kind !== 'done') throw new Error('A customer cancel was not finished in its own transaction.')
  return started.output
}

// --- For reconcile and the close by hand

export { readEventBookingClaim }
