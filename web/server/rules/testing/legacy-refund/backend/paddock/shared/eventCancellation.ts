/**
 * Cancels event places (one, several, or a whole booking) with an optional refund. Shared by
 * cancelEventPlaces (staff on the attendee list) and cancelEvent (the whole event). Writes, so no
 * read-only getter may import it (CLAUDE.md).
 *
 * Every amount comes from event_cancellation_quote (the selected places' share of the event line
 * after its promo, less what earlier cancelled places took; the last places take exactly what is
 * left). Money moves first, then ONE guarded statement records everything, as the app's refund
 * flows do:
 *  1. Card part: back through the order's PaymentIntent, capped at the order's card portion still
 *     refundable (shared/orderCardPortion). Store credit part: the rest, via applyStoreCredit
 *     (never expires, never a gift card). 'credit' sends it all to store credit; 'none' moves
 *     nothing.
 *  2. One statement stamps the places, takes them off the booking (cancelling it when none are
 *     left), releases them on the event and adds the card amount to the event order line (stamping
 *     the line refunded once the booking is fully cancelled with money given back). The booking's
 *     place count is the guard: a concurrent cancel changes it, and a concurrent check-in leaves a
 *     place unstamped, and either makes the statement fail as a whole (nothing recorded).
 *  3. The order's payment_status is recomputed (shared/orderPaymentStatus).
 *
 * A card refund with no clear answer stops the press with nothing cancelled, and is held
 * (shared/heldCardRefund): the next press on this booking sends it again with the same key first,
 * whatever it is asked to do, so it can't be paid twice. Its key names the order line, the card the
 * order has had back, the places and the amount, and the refusals so far, so another cancel of other
 * places, or of the same places once one is recorded, is a new refund. Store credit that can't be
 * told to have landed (shared/storeCreditRefund) is counted as given, and staff are told to check.
 *
 * Two presses on the same places build the same key, so Stripe makes one refund and hands it to both.
 * The statement writes its key (`event_booking.card_refund_recorded`), and a press whose statement
 * then fails looks for it before recording its card money on the line: there, it was the other
 * press's refund, so nothing is recorded twice. A failing press that records the money writes
 * `event_booking.card_refund_unallocated` with the key, so an overlapping statement after it doesn't
 * add the same money to the line again.
 */
import { refundPaymentIntent } from './refundPaymentIntent'
import { giveStoreCredit, storeCreditLanded, storeCreditMoved } from './storeCreditRefund'
import { idsFingerprint, noteRefusedCardRefundOn, pence, refusedCardRefundsOn } from './cardRefundAttempts'
import { heldRefundMessage, holdCardRefund, settleHeldCardRefunds } from './heldCardRefund'
import { loadOrderCardPortion } from './orderCardPortion'
import { recomputeOrderPaymentStatus } from './orderPaymentStatus'
import { loadEventAttendeeBookings, type EventAttendeeBooking } from './eventAttendeeList'
import { quoteEventCancellation, round2, type CancelPlacesFailureReason } from './eventCancellationQuote'

export type { CancelPlacesFailureReason } from './eventCancellationQuote'

export type EventRefundChoice = 'card' | 'credit' | 'none'

export type CancelPlacesResult =
  | {
      ok: true
      places: number
      /** Card + store credit given back. */
      refundedAmount: number
      cardRefundedAmount: number
      storeCreditRefundedAmount: number
      /** The customer's store credit balance after the refund (store credit part only). */
      storeCreditBalance?: number
      /** The booking as the attendee list shows it now (null when it couldn't be re-read). */
      booking: EventAttendeeBooking | null
      /** The event's places booked after the cancel, for the attendee list header. */
      eventPlacesBooked?: number
      /** Money moved but something after it needs a manual check. */
      warning?: string
    }
  | { ok: false; reason: CancelPlacesFailureReason; message: string; warning?: string }

export interface CancelPlacesInput {
  eventBookingId: string
  /** Omit for every remaining place in the booking. */
  attendeeIds?: string[]
  refund: EventRefundChoice
  reason: string | null
  staffId: string | null
  /** Who is acting: an earlier refund with no clear answer is looked for on Stripe through the Worker. */
  user: User
  /** Cancelling the whole event: refunds in full whatever the cut-off (no reason check). */
  wholeEvent?: boolean
}

/** Splits `total` across places in proportion to their unit prices, the remainder on the last, so
 *  the parts always add up to the total exactly (equal shares when every price is 0). */
function splitByUnitPrice(total: number, unitPrices: number[]): number[] {
  const n = unitPrices.length
  if (n === 0) return []
  const sum = unitPrices.reduce((a, b) => a + b, 0)
  const parts: number[] = []
  let given = 0
  for (let i = 0; i < n - 1; i++) {
    const part = sum > 0 ? round2((total * unitPrices[i]!) / sum) : round2(total / n)
    parts.push(part)
    given = round2(given + part)
  }
  parts.push(round2(total - given))
  return parts
}

export async function cancelEventBookingPlaces(input: CancelPlacesInput): Promise<CancelPlacesResult> {
  const { eventBookingId, refund, staffId, user, wholeEvent } = input
  const reason = input.reason?.trim() ? input.reason.trim() : null
  if (refund !== 'card' && refund !== 'credit' && refund !== 'none') {
    return { ok: false, reason: 'invalid_params', message: 'Choose Card, Store credit or No refund.' }
  }

  // An earlier press's card refund with no clear answer is settled first, before anything is read.
  const earlier = await settleHeldCardRefunds('event_booking', eventBookingId, staffId, user)
  if (!earlier.settled) return { ok: false, reason: 'refund_unsure', message: earlier.message }

  // --- Quote (every amount comes from the database function) -----------------------------------
  const quoted = await quoteEventCancellation(eventBookingId, wholeEvent ? undefined : input.attendeeIds)
  if (!quoted.ok) return quoted
  const quote = quoted.quote
  const afterCutoff = !quote.before_cutoff
  if (refund !== 'none' && afterCutoff && !wholeEvent && !reason) {
    return { ok: false, reason: 'reason_required_after_cutoff', message: 'A reason is needed to refund after the refund cut-off.' }
  }

  const [placesLookup, lineLookup, eventLookup] = await Promise.all([
    paddockData.query<{ id: string; unit_price: string }>(
      `SELECT ea.id, ea.unit_price FROM event_attendees ea
       WHERE ea.id = ANY($1::uuid[]) ORDER BY ea.created_at, ea.id`,
      [quote.attendee_ids]
    ),
    // unallocated_card: card money already refunded on the event line but not yet assigned to a
    // cancelled place — left by an earlier attempt whose recording failed (see the failure path
    // below). It counts as already given back, so a retry never refunds it again.
    paddockData.query<{ id: string; order_id: string; unallocated_card: string }>(
      `SELECT oli.id, oli.order_id,
              GREATEST(oli.card_refunded_amount - COALESCE((SELECT sum(ea.card_refunded_amount) FROM event_attendees ea
                                                            WHERE ea.event_booking_id = oli.event_booking_id), 0), 0) AS unallocated_card
       FROM order_line_items oli WHERE oli.event_booking_id = $1 AND oli.item_type = 'event' LIMIT 1`,
      [eventBookingId]
    ),
    paddockData.query<{ name: string }>('SELECT name FROM events WHERE id = $1', [quote.event_id]),
  ])
  const places = placesLookup.data
  // Read with the quote, so the guard below fails if anything was cancelled since the amounts
  // were worked out.
  const placesBefore = quote.booking_places
  const line = lineLookup.data[0] ?? null
  const eventName = eventLookup.data[0]?.name ?? 'the event'
  // Card money an earlier failed attempt already gave back for these places (whatever is chosen
  // now, it has gone back, so the places record it).
  const alreadyCard = line ? round2(Math.min(Number.parseFloat(line.unallocated_card), quote.value)) : 0
  // What still has to be refunded now.
  const value = refund === 'none' ? 0 : round2(Math.max(0, quote.value - alreadyCard))
  if (value > 0 && !line) {
    return { ok: false, reason: 'order_not_found', message: "This booking's order line couldn't be found, so nothing can be refunded." }
  }

  // --- Money first --------------------------------------------------------------------------------
  // cardAmount: the NEW card refund made by this call, and refundKey its Stripe key.
  let cardAmount = 0
  let refundKey: string | null = null
  if (refund === 'card' && value > 0 && line) {
    const portion = await loadOrderCardPortion(line.order_id)
    if (!portion) return { ok: false, reason: 'order_not_found', message: "This booking's order couldn't be found." }
    // No PaymentIntent (cash, gift card or store credit only): it all goes to store credit.
    if (portion.paymentIntentId) cardAmount = round2(Math.min(value, portion.cardPortionRemaining))
    if (cardAmount > 0) {
      let refused: number
      try {
        refused = await refusedCardRefundsOn('event_booking', eventBookingId)
      } catch (err) {
        return { ok: false, reason: 'refund_failed', message: `Checking the card payment failed, so nothing was cancelled: ${err instanceof Error ? err.message : String(err)}` }
      }
      const key = `event-refund:${line.id}:${pence(portion.alreadyCardRefunded)}:${places.length}:${idsFingerprint(places.map((p) => p.id))}:${pence(cardAmount)}:${refused}`
      refundKey = key
      const refunded = await refundPaymentIntent(portion.paymentIntentId!, cardAmount, key)
      if (!refunded.ok && refunded.unsure) {
        const held = await holdCardRefund({
          on: 'event_booking',
          entityId: eventBookingId,
          staffId,
          paymentIntentId: portion.paymentIntentId!,
          amount: cardAmount,
          key,
          lines: [{ lineId: line.id, amount: cardAmount }],
        })
        return {
          ok: false,
          reason: 'refund_unsure',
          message: heldRefundMessage(cardAmount),
          ...(held
            ? {}
            : { warning: 'Keeping it for the next press failed too, so press again only with Card on the same places: that gets the first refund back.' }),
        }
      }
      if (!refunded.ok) {
        await noteRefusedCardRefundOn({ entityType: 'event_booking', entityId: eventBookingId, staffId, amount: cardAmount, message: refunded.message })
        return { ok: false, reason: 'refund_failed', message: `The card refund failed, so nothing was cancelled: ${refunded.message ?? 'unknown error'}` }
      }
    }
  }
  let creditAmount = refund === 'none' ? 0 : round2(value - cardAmount)
  let storeCreditBalance: number | undefined
  let warning: string | undefined
  // The store credit's note, when nobody can say whether it landed. It is counted as given.
  let creditUnsureNote: string | null = null
  if (creditAmount > 0) {
    const given = await giveStoreCredit({
      customerId: quote.customer_id,
      amount: creditAmount,
      reason: 'refund',
      orderId: line?.order_id ?? null,
      staffId,
      note:
        cardAmount > 0
          ? `Event refund: ${eventName} (the rest went back to the card).`
          : `Event refund: ${eventName}.`,
    })
    if (given.outcome === 'refused') {
      if (cardAmount <= 0) {
        return { ok: false, reason: 'store_credit_failed', message: 'Adding the store credit failed, so nothing was cancelled.' }
      }
      // The card part has gone back already: record the cancellation with what was refunded.
      warning = `£${cardAmount.toFixed(2)} went back to the card, but adding the £${creditAmount.toFixed(2)} remainder to store credit failed and needs a manual check.`
      creditAmount = 0
    } else if (given.outcome === 'unsure') {
      // Counted as given, so the places are cancelled and can't be refunded again.
      creditUnsureNote = given.note
      warning = `Adding the £${creditAmount.toFixed(2)} store credit gave no clear answer (${given.message}), so it is counted as given. Check their balance, and add it with Adjust store credit if it isn't there.`
    } else {
      storeCreditBalance = given.balance
    }
  }
  // Card on these places = the earlier attempt's card money plus this call's.
  const cardOnPlaces = round2(alreadyCard + cardAmount)
  const refundedTotal = round2(cardOnPlaces + creditAmount)
  const moneyMoved = round2(cardAmount + creditAmount) > 0

  // --- One guarded statement records everything -----------------------------------------------
  const unitPrices = places.map((p) => Number.parseFloat(p.unit_price))
  const values = splitByUnitPrice(quote.value, unitPrices)
  const refundedParts = splitByUnitPrice(refundedTotal, unitPrices)
  const cardParts = splitByUnitPrice(cardOnPlaces, unitPrices)
  const placeRefundMethod: EventRefundChoice = refundedTotal <= 0 ? 'none' : cardOnPlaces > 0 ? 'card' : 'credit'
  // The order line's refund_method (card / credit only) once the booking is fully cancelled with
  // money given back on it.
  try {
    await paddockData.query(
      `WITH p AS (
         SELECT $1::uuid AS booking_id, $2::int AS n, $3::int AS places_before, $4::uuid AS staff_id,
                $5::text AS reason, $6::text AS refund_method, $7::boolean AS after_cutoff,
                $8::numeric AS card_total, $9::uuid[] AS ids, $10::numeric[] AS vals,
                $11::numeric[] AS refunded, $12::numeric[] AS cards, $13::text AS refund_key
       ),
       -- This press's card refund may be one Stripe replayed to a press that overlapped it. That
       -- press, failing, has recorded the money on the line already when this row is there.
       already AS (
         SELECT 1 FROM audit_log a, p
         WHERE a.action = 'event_booking.card_refund_unallocated' AND a.entity_type = 'event_booking'
           AND a.entity_id = p.booking_id::text AND a.details->>'key' = p.refund_key
       ),
       bk AS (
         UPDATE event_bookings eb
         SET places = eb.places - p.n,
             status = CASE WHEN eb.places - p.n <= 0 THEN 'cancelled' ELSE eb.status END,
             cancelled_at = CASE WHEN eb.places - p.n <= 0 THEN now() ELSE eb.cancelled_at END,
             cancelled_by = CASE WHEN eb.places - p.n <= 0 THEN p.staff_id ELSE eb.cancelled_by END,
             cancel_reason = CASE WHEN eb.places - p.n <= 0 THEN p.reason ELSE eb.cancel_reason END,
             updated_at = now()
         FROM p
         WHERE eb.id = p.booking_id AND eb.status = 'confirmed' AND eb.places = p.places_before
         RETURNING eb.id, eb.event_id, eb.status
       ),
       att AS (
         UPDATE event_attendees ea
         SET cancelled_at = now(), cancelled_by = p.staff_id, cancel_reason = p.reason,
             cancelled_value = s.val, refunded_amount = s.refunded, card_refunded_amount = s.card,
             refund_method = p.refund_method, refund_after_cutoff = p.after_cutoff
         FROM p, unnest(p.ids, p.vals, p.refunded, p.cards) AS s(id, val, refunded, card)
         WHERE ea.id = s.id AND ea.event_booking_id = p.booking_id
           AND ea.cancelled_at IS NULL AND ea.checked_in_at IS NULL
           AND EXISTS (SELECT 1 FROM bk)
         RETURNING ea.id
       ),
       rel AS (
         SELECT public.release_event_places(bk.event_id, p.n) FROM bk, p
       ),
       -- The line is stamped refunded once the booking is fully cancelled and any money went back
       -- on it (now or for earlier places); its refund_method is 'card' whenever any card money
       -- went back on it, otherwise 'credit'.
       line AS (
         UPDATE order_line_items oli
         SET card_refunded_amount = oli.card_refunded_amount + CASE WHEN EXISTS (SELECT 1 FROM already) THEN 0 ELSE p.card_total END,
             refunded_at = CASE
               WHEN bk.status = 'cancelled' AND (p.refund_method <> 'none' OR EXISTS (
                      SELECT 1 FROM event_attendees ea WHERE ea.event_booking_id = bk.id AND ea.refunded_amount > 0))
                 THEN COALESCE(oli.refunded_at, now())
               ELSE oli.refunded_at END,
             refund_method = CASE
               WHEN bk.status = 'cancelled' AND (p.refund_method <> 'none' OR EXISTS (
                      SELECT 1 FROM event_attendees ea WHERE ea.event_booking_id = bk.id AND ea.refunded_amount > 0))
                 THEN CASE WHEN oli.card_refunded_amount + p.card_total > 0 THEN 'card' ELSE 'credit' END
               ELSE oli.refund_method END
         FROM bk, p
         WHERE oli.event_booking_id = bk.id AND oli.item_type = 'event'
         RETURNING oli.id
       ),
       -- The card refund's key, so a press that overlapped this one and lost can tell that Stripe
       -- replayed this refund to it, and records nothing.
       recorded AS (
         INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
         SELECT 'staff', p.staff_id::text, 'event_booking.card_refund_recorded', 'event_booking', bk.id::text,
                jsonb_build_object('key', p.refund_key, 'amount', p.card_total)
         FROM bk, p WHERE p.refund_key IS NOT NULL
         RETURNING id
       )
       -- rel is read unconditionally so the places are always released with the rest. All or
       -- nothing: unless the booking and every chosen place were updated, the text cast fails
       -- the whole statement so nothing is recorded.
       SELECT (SELECT count(*) FROM rel) AS released,
              (SELECT count(*) FROM line) AS lines,
              CAST(CASE
                WHEN (SELECT count(*) FROM bk) = 1 AND (SELECT count(*) FROM att) = (SELECT n FROM p) THEN '1'
                ELSE 'event_cancel_conflict'
              END AS int) AS ok`,
      [
        eventBookingId,
        places.length,
        placesBefore,
        staffId,
        reason,
        placeRefundMethod,
        refund !== 'none' && afterCutoff && !wholeEvent,
        cardAmount,
        places.map((p) => p.id),
        values,
        refundedParts,
        cardParts,
        refundKey,
      ]
    )
  } catch (err) {
    // Nothing was recorded. Never leave money given back with nothing to show for it: take the
    // store credit back, and record a new card refund on the event line (its own statement) so
    // the card portion counts it and a retry uses it up instead of refunding it again (see
    // unallocated_card above). Reported as a failure, so cancelEvent lists the booking as failed
    // and a Retry is safe.
    const message = err instanceof Error ? err.message : String(err)
    const notes: string[] = []
    // Store credit that may not have landed is only taken back once it can be seen to have.
    const creditLanded =
      creditAmount > 0 && creditUnsureNote
        ? await storeCreditLanded(quote.customer_id, creditUnsureNote).then(
            (landed) => (landed ? 'yes' : 'no'),
            () => 'unknown' as const
          )
        : 'yes'
    if (creditAmount > 0 && creditLanded === 'unknown') {
      notes.push(
        `The £${creditAmount.toFixed(2)} store credit gave no clear answer and still can't be checked: look at their balance and take it off with Adjust store credit if it's there, before trying again.`
      )
    } else if (creditAmount > 0 && creditLanded === 'yes') {
      // Found by its note if its answer is lost, so staff are never told to remove it twice.
      const reversed = await storeCreditMoved({
        customerId: quote.customer_id,
        amount: -creditAmount,
        reason: 'refund',
        orderId: line?.order_id ?? null,
        staffId,
        note: 'Automatic reversal: the event cancellation could not be recorded.',
      })
      notes.push(
        reversed
          ? `The £${creditAmount.toFixed(2)} store credit was taken back.`
          : `Taking back the £${creditAmount.toFixed(2)} store credit failed — check their balance, and remove it by hand only if it's still there.`
      )
    }
    // Stripe answers a repeated key with the first refund, so a press that overlapped another on the
    // same places may have been handed that press's refund. That press recorded it with its key, so
    // the money isn't recorded again here. Waiting on the booking's row first lets a statement still
    // being written finish, so its key is seen.
    let refundedByAnotherPress = false
    if (cardAmount > 0 && line) {
      try {
        await paddockData.query('SELECT id FROM event_bookings WHERE id = $1 FOR SHARE', [eventBookingId])
        const recorded = await paddockData.query<{ seen: boolean }>(
          `WITH seen AS (
             SELECT 1 FROM audit_log
             WHERE entity_type = 'event_booking' AND entity_id = $1
               AND action IN ('event_booking.card_refund_recorded', 'event_booking.card_refund_unallocated')
               AND details->>'key' = $2
           ),
           line AS (
             UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $3
             WHERE id = $4 AND NOT EXISTS (SELECT 1 FROM seen)
             RETURNING id
           ),
           kept AS (
             INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
             SELECT 'staff', $5, 'event_booking.card_refund_unallocated', 'event_booking', $6, $7::jsonb FROM line
             RETURNING id
           )
           SELECT EXISTS (SELECT 1 FROM seen) AS seen`,
          [eventBookingId, refundKey, cardAmount, line.id, staffId, eventBookingId, JSON.stringify({ key: refundKey, amount: cardAmount })]
        )
        refundedByAnotherPress = recorded.data[0]?.seen === true
        if (!refundedByAnotherPress) {
          notes.push(
            `£${cardAmount.toFixed(2)} had already gone back to the card; it is recorded on the order, so retrying won't refund it again.`
          )
        }
      } catch {
        notes.push(`£${cardAmount.toFixed(2)} had already gone back to the card and recording it failed — check in Stripe before retrying.`)
      }
    }
    const conflict = message.includes('event_cancel_conflict')
    return {
      ok: false,
      reason: conflict ? 'changed_by_someone_else' : 'unexpected_error',
      message: refundedByAnotherPress
        ? `Someone else cancelled these places at the same moment, with the same card refund of £${cardAmount.toFixed(2)}: it went back to the card once, on their cancellation. Reload to see it.`
        : conflict
          ? 'Someone else changed this booking at the same moment (a place was cancelled or checked in). Nothing was cancelled; reload and try again.'
          : `Recording the cancellation failed, so nothing was cancelled: ${message}`,
      ...(notes.length > 0 ? { warning: notes.join(' ') } : {}),
    }
  }

  // --- After: order status, fresh booking state ------------------------------------------------
  if (line && moneyMoved) {
    try {
      await recomputeOrderPaymentStatus(line.order_id)
    } catch (err) {
      const note = `Updating the order's payment status failed and needs a manual check: ${err instanceof Error ? err.message : String(err)}`
      warning = warning ? `${warning} ${note}` : note
    }
  }
  let booking: EventAttendeeBooking | null = null
  let eventPlacesBooked: number | undefined
  try {
    const [bookings, eventRow] = await Promise.all([
      loadEventAttendeeBookings({ eventBookingId }),
      paddockData.query<{ places_booked: number }>('SELECT places_booked FROM events WHERE id = $1', [quote.event_id]),
    ])
    booking = bookings[0] ?? null
    eventPlacesBooked = eventRow.data[0]?.places_booked
  } catch {
    booking = null
  }
  return {
    ok: true,
    places: places.length,
    refundedAmount: refundedTotal,
    cardRefundedAmount: cardAmount,
    storeCreditRefundedAmount: creditAmount,
    ...(storeCreditBalance !== undefined ? { storeCreditBalance } : {}),
    booking,
    ...(eventPlacesBooked !== undefined ? { eventPlacesBooked } : {}),
    ...(warning ? { warning } : {}),
  }
}
