import { claimSessionCapacity, releaseSessionCapacity } from './shared/sessionCapacity'
import { quoteSeats, type BandSeatQuote } from './shared/bandPricing'
import {
  CARD_CHARGE_IN_PROGRESS_MESSAGE,
  CHARGE_FINISHED_AUDIT,
  CHARGE_KEY_STILL_STANDS,
  cardChargeUnsure,
  cardChargeWinner,
  chargeBookingCard,
  chargeFinishedDetails,
  earlierCardCharge,
  markCardChargePartsReturned,
  retireCardCharge,
} from './shared/bookingCardCharge'
import { storeCreditMoved } from './shared/storeCreditRefund'
import { createTerminalPaymentIntentUnguarded as createTerminalPaymentIntent } from './createTerminalPaymentIntent'
import { type PendingReaderSnapshot } from './shared/pendingReaderFlows'
import { type RefundMethod } from './refundBooking'
import { REFUND_UNSURE_MESSAGE, giveBookingMoneyBack, reverseSavedCardCharge, shortfallStaysOnBookingWarnings } from './shared/bookingRefund'
import { CLAIM_AUDIT, finishRefundClaim, putBackAsOwed, refundClaimDetails } from './shared/bookingMoneyClaim'
import { PRESS_FINISHED_AUDIT, detailId, findPressFinished, newPressId } from './shared/pressFinished'
import { applyStoreCredit } from './shared/storeCredit'
import { releaseSessionPassCredit } from './shared/creditRedemption'
import { resolveStaffId } from './shared/resolveStaffId'
import { getStaffAccessRow } from './shared/staffAccess'
import { AMOUNT_CHANGED_MESSAGE, amountLeftToPay, cashDifferenceRefusal, exceedsAmount } from './shared/cashConfirmation'
import { NO_READER_PAYMENT_OPEN, READER_PAYMENT_OPEN_MESSAGE, anyReaderPaymentOpenOnBooking } from './shared/readerPaymentOpen'

/** Saving the move gave no answer, and looking for its finished row failed too. */
const MOVE_SAVE_UNCLEAR_MESSAGE =
  "Saving the move gave no answer, and checking whether it was saved failed too, so nothing was put back. Reload the booking: if it is on the new session, the move is done. If not, check both sessions' places, and give back by hand any gift card, store credit or cash taken for it."

export interface MoveBookingPaymentInput {
  giftCard?: { giftCardId: string; amount: number }
  /** Store credit drawn from the customer's own store_credit_balance — a separate payment part
   *  from the gift card, applied (claimed, negative) before any card money. */
  storeCredit?: { amount: number }
  method?: 'card' | 'reader' | 'cash'
  /** Cash only: the figure on the tick staff confirmed. Refused if the amount works out different
   *  (shared/cashConfirmation). */
  confirmedCashAmount?: number
}

export interface MoveBookingParams {
  bookingId: string
  newSessionId: string
  /**
   * Step 2 only — the staff-confirmed decision from a previous call's `priceImpact`. The first
   * call quotes what the move would cost/refund and changes nothing; the second call must pass
   * `confirmed: true` (plus a payment input when money is due, or a refund method when money is
   * coming back) before anything is written.
   */
  confirmed?: boolean
  /** Required when the confirmed move leaves an amount DUE (paid seats cost more in the new band). */
  payment?: MoveBookingPaymentInput
  /** Required when the confirmed move leaves an amount REFUNDABLE (paid seats cost less). */
  refundMethod?: RefundMethod
}

export interface MoveSeatDelta {
  /** 1-based seat number; seat 1 is the account holder. */
  seatNo: number
  seatKind: 'account_holder' | 'guest'
  /** How the seat is covered after the move. */
  payBy: 'paid' | 'membership_credit' | 'session_pass_credit'
  oldUnitPrice: number | null
  newUnitPrice: number
  /** new minus old, for paid seats — the per-seat amount that moves. 0 for credit seats. */
  delta: number
  /** True when a credit previously covering this seat had to be released: a membership credit
   *  whose level isn't credit-eligible in the new band, or a session pass whose level doesn't
   *  cover the new session (a Core pass moving into Peak). The seat is then paid in full. */
  creditReleased: boolean
}

export interface MoveBookingPriceImpact {
  /** Positive means staff must collect this, negative means this much is refunded, never more than
   *  what is left on the booking. Public: the sum of per-seat deltas for paid seats, a dearer one
   *  stopping at the new paid seats less price_paid (without refund_owed_amount) and
   *  part_refunded_amount. Private: the new tier price less those two. 0 means nothing moves (credit
   *  seat unchanged, or legacy booking kept at its recorded price). */
  amountDue: number
  /** True when amountDue < 0 — staff must confirm the refund. */
  refundDue: boolean
  seatDeltas: MoveSeatDelta[]
  /** True when the booking predates per-seat pricing (no unit_price recorded) — the move keeps
   *  the price it was charged and reprices nothing. */
  legacyPricing: boolean
  /** The booking's customer — lets UI callers that only hold a booking summary still resolve
   *  payment details for the difference. */
  customerId: string
}

export type MoveBookingFailureReason =
  | 'booking_not_found'
  | 'booking_not_movable'
  | 'reader_payment_open'
  /** The booking's money changed after it was read, so nothing was moved and any payment taken
   *  was reversed. */
  | 'booking_changed'
  | 'same_session'
  | 'session_not_found'
  | 'session_blocked'
  | 'session_already_started'
  | 'time_conflict'
  | 'insufficient_capacity'
  | 'band_unpriced'
  | 'private_price_not_set'
  | 'payment_method_required'
  /** The cash due differs from what staff confirmed — nothing was moved; `priceImpact` has the new figures. */
  | 'cash_amount_changed'
  | 'gift_card_amount_exceeds_total'
  | 'store_credit_amount_exceeds_total'
  | 'store_credit_insufficient_or_invalid'
  | 'refund_method_required'
  | 'gift_card_insufficient_or_invalid'
  /** The confirmed move refunds money (paid seats got cheaper) but the caller lacks
   *  can_issue_refunds — nothing was moved and no money changed hands. */
  | 'no_refund_permission'
  | 'promo_discounted_booking'
  /** The new session is a different booking type (public vs private) from the booking's current
   *  session — moves only go public → public or private → private; staff cancel and rebook. */
  | 'booking_type_mismatch'
  /** Payment taken before any write; the saved-card charge was declined or failed. Nothing was
   *  written and every earlier payment part (store credit, gift card) was reversed. */
  | 'card_charge_failed'
  /** Another press on this booking is taking the same payment: nothing was taken. */
  | 'card_charge_in_progress'
  /** The booking was already moved with this payment (by another press, or this one with its
   *  answer lost): nothing was refunded, and `message` says so. */
  | 'already_moved'
  /** The move write failed after money was taken; capacity and the booking were restored but an
   *  automatic money reversal itself failed — staff must check store credit / gift card / card
   *  refund manually. */
  | 'move_failed_refund_failed'
  /** The move write failed after money was taken; capacity, the booking and every payment part
   *  taken were all reversed successfully. */
  | 'move_failed'
  /** The move failed after it started writing (or, on the reader path, the card reader payment
   *  could not be set up) and putting the booking / both sessions' capacity back failed — staff
   *  must check the booking and both sessions by hand. */
  | 'move_failed_restore_failed'

export interface MoveBookingResult {
  moved: boolean
  reason?: MoveBookingFailureReason
  message?: string
  booking?: Record<string, unknown>
  /** Present, with `moved: true`, when method is 'reader' (new flow): the move writes are done
   *  and PENDING the reader charge — the frontend collects on the reader then calls
   *  finaliseReaderPayment({ pendingId }); a reader failure calls cancelReaderPayment, which
   *  undoes the move (the booking goes back to its old session). */
  pendingReaderPayment?: {
    flow: 'move'
    recordId: string
    pendingId: string
    paymentIntentId: string
    clientSecret: string
    amount: number
  }
  /** Present, with `moved: false`, on the quoting step — staff confirm this before the move (and
   *  any charge/refund) actually happens. Also present with every refusal over the amount, so the
   *  screen moves to the new figures. */
  priceImpact?: MoveBookingPriceImpact
  /** Set when the move succeeded but a bookkeeping step (recording the card-refunded amount)
   *  failed and needs a manual check. */
  warning?: string
}

interface BookingInfo {
  id: string
  customer_id: string
  session_id: string
  party_size: number
  status: string
  price_paid: string | null
  part_refunded_amount: string
  refund_owed_amount: string
  /** As text: part of the card charge's key, so it must come back exactly as it went in. */
  updated_at: string
  redemption_source: string
  redeemed_membership_id: string | null
  redeemed_session_pass_id: string | null
  start_time: string
  end_time: string
  band_id: string | null
  credit_period_id: string | null
  /** Booking type of the booking's CURRENT session's service type (null if that session can't be
   *  found — the move is then refused as a type mismatch). */
  booking_type: 'public' | 'private' | null
}

interface GuestSeatRow {
  id: string
  guest_type: string
  unit_price: string | null
  pay_by: string | null
}

interface SessionInfo {
  id: string
  start_time: string
  end_time: string
  capacity: number
  total_booked: number
  status: string
  service_type_id: string
  booking_type: 'public' | 'private'
  band_id: string | null
  /** True when the target session has already started (or is in the past) — start_time is stored
   *  as London wall-clock labelled UTC, so it's compared like for like against London wall-clock
   *  now, never against raw now(). */
  started: boolean
}

// Reassigns an existing booking to a different session, enforcing the exact same rules
// createBooking.ts enforces for a brand-new booking: the new session must be open, must have
// capacity for this party size, and must not overlap another service type's confirmed/pending/
// payment_needed booking (the shared-venue exclusivity rule). See createBooking.ts for the full
// rationale on why the pre-checks below are fast-path optimizations only, while the
// `bookings_no_cross_session_overlap` exclusion constraint on `bookings` is what actually
// guarantees correctness under concurrent requests.
//
// For PUBLIC bookings the move is also a repricing event: the party is re-quoted at the new
// session's band (quote_booking), and only the per-seat DIFFERENCE is settled — paid seats are
// charged or refunded (staff confirm the amount first, two-step), a credit-covered seat keeps its
// credit while the new band stays credit-eligible for the member's level, and otherwise the seat
// is paid at its new unit_price and the credit is released by clearing the booking's
// credit_period_id (usage is counted from non-cancelled bookings per period, so clearing the link
// is the release — no counter is involved). Bookings recorded before
// per-seat pricing keep the price they were charged (no repricing). PRIVATE bookings are repriced
// at the new session's band tier price for the party size. A move never changes booking type
// (public → public, private → private only).
//
// A part refund stays with the customer on a move (Q28), so it is neither asked for again nor put
// back on price_paid. A seat's unit_price still holds any part refund, so the public seat
// differences already compare the new price with price_paid + part_refunded_amount, except after a
// capped cheaper move, which lowers the seats by more than it gave back, so a dearer move stops at
// that sum; private bookings have no seat prices and compare those figures directly. Money owed
// after a failed refund sits inside price_paid but is still the customer's, so it pays for nothing
// here and a move never gives it: staff give it with Refund the rest. Either way price_paid moves by
// exactly what the move settles, and a refund never exceeds what is left, so total money back can't
// pass what was paid.
export default async function moveBooking(
  req: { params: MoveBookingParams; user: User }
): Promise<MoveBookingResult> {
  const { bookingId, newSessionId, confirmed, payment, refundMethod } = req.params

  // First, so an inactive account is refused before anything happens, and so nothing below has to
  // look this up between taking money and reversing it.
  const actingStaffId = await resolveStaffId(req.user.email)

  // The three lookups below are independent of each other (each depends only on the incoming
  // ids), so they run in parallel to cut the move's latency. The booking's own validity checks
  // still gate everything that follows.
  const [bookingLookup, sessionLookup, seatRows] = await Promise.all([
    paddockData.query<BookingInfo>(
      `SELECT b.id, b.customer_id, b.session_id, b.party_size, b.status, b.price_paid, b.part_refunded_amount, b.refund_owed_amount, b.redemption_source,
              b.updated_at::text AS updated_at, b.redeemed_membership_id, b.redeemed_session_pass_id, b.start_time, b.end_time, b.band_id,
              b.credit_period_id, st.booking_type
       FROM bookings b
       LEFT JOIN sessions s ON s.id = b.session_id
       LEFT JOIN service_types st ON st.id = s.service_type_id
       WHERE b.id = $1`,
      [bookingId]
    ),
    paddockData.query<SessionInfo>(
      `SELECT s.id, s.start_time, s.end_time, s.capacity, s.total_booked, s.status, s.service_type_id, s.band_id, st.booking_type,
              (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS started
       FROM sessions s
       JOIN service_types st ON st.id = s.service_type_id
       WHERE s.id = $1`,
      [newSessionId]
    ),
    paddockData.query<GuestSeatRow>(
      `SELECT id, guest_type, unit_price, pay_by FROM booking_guests WHERE booking_id = $1 ORDER BY created_at, id`,
      [bookingId]
    ),
  ])
  const booking = bookingLookup.data[0]
  if (!booking) {
    return { moved: false, reason: 'booking_not_found' }
  }
  if (booking.status !== 'confirmed' && booking.status !== 'pending' && booking.status !== 'payment_needed') {
    return { moved: false, reason: 'booking_not_movable' }
  }
  if (booking.session_id === newSessionId) {
    return { moved: false, reason: 'same_session' }
  }

  // A promo-discounted booking can never be moved: the move reprices seats from the new band's
  // quote, which could raise the recorded price paid above what the customer actually paid with
  // the code. Cancel & Refund still works for these bookings.
  const promoOrder = await paddockData.query<{ id: string }>(
    `SELECT o.id
     FROM order_line_items oli
     JOIN orders o ON o.id = oli.order_id
     WHERE oli.booking_id = $1 AND o.promo_code IS NOT NULL
     LIMIT 1`,
    [bookingId]
  )
  if (promoOrder.data[0]) {
    return {
      moved: false,
      reason: 'promo_discounted_booking',
      message: 'This booking was paid with a promo code. Cancel it and make a new booking instead.',
    }
  }

  const newSession = sessionLookup.data[0]
  if (!newSession) {
    return { moved: false, reason: 'session_not_found' }
  }
  // Moves never change booking type (decision 27 Oct): checked before any quote, capacity or
  // money step, so the reader-pending path is covered too.
  if (newSession.booking_type !== booking.booking_type) {
    return {
      moved: false,
      reason: 'booking_type_mismatch',
      message:
        'A public booking can only move to a public session, and a private booking to a private session. To change type, cancel and rebook.',
    }
  }
  if (newSession.status !== 'open') {
    return { moved: false, reason: 'session_blocked' }
  }
  if (newSession.started) {
    return { moved: false, reason: 'session_already_started' }
  }

  // Cross-service-type exclusivity pre-check, excluding this booking's own row — it still sits
  // on the OLD session at this point in the function, and would otherwise falsely conflict with
  // itself whenever the old and new sessions are different service types at overlapping times.
  // It and the new session's seat quote are independent reads — run them in parallel.
  const seats = seatRows.data
  const partySize = seats.length > 0 ? seats.length : booking.party_size
  let quoteError: unknown = null
  const [conflictCheck, quoteAttempt] = await Promise.all([
    paddockData.query<{ id: string }>(
      `SELECT s2.id
       FROM sessions s2
       JOIN bookings b2 ON b2.session_id = s2.id AND b2.status IN ('pending', 'confirmed', 'payment_needed') AND b2.id != $1
       WHERE s2.service_type_id != $2
         AND s2.start_time < $3
         AND s2.end_time > $4
       LIMIT 1`,
      [bookingId, newSession.service_type_id, newSession.end_time, newSession.start_time]
    ),
    newSession.booking_type === 'public'
      ? quoteSeats(newSessionId, booking.customer_id, partySize).catch((err) => {
          quoteError = err
          return null
        })
      : Promise.resolve(null),
  ])
  if (quoteError !== null) {
    return { moved: false, reason: 'band_unpriced' }
  }
  if (conflictCheck.data.length > 0) {
    return { moved: false, reason: 'time_conflict' }
  }

  // --- Reprice at the new session's band ---
  // PUBLIC: the party is re-quoted seat by seat (quote_booking) and the per-seat difference is
  // settled. PRIVATE: the party is priced by the headcount tier AT THE NEW SESSION'S BAND — the
  // whole-booking difference (new tier price − money paid toward it − part refunds) is settled the same way
  // (private guests carry no per-seat prices).
  let priceImpact: MoveBookingPriceImpact | null = null
  let newQuotes: BandSeatQuote[] | null = null
  const oldPricePaid = Number.parseFloat(booking.price_paid ?? '0')
  /** What was paid toward the booking: price_paid without the money owed. */
  const paidToward = Math.round((oldPricePaid - Number.parseFloat(booking.refund_owed_amount)) * 100) / 100
  /** A refund can't give back more than is left on the booking. 0 less, so £0 left is never -0. */
  const settled = (difference: number) => Math.max(Math.round(difference * 100) / 100, 0 - paidToward)
  /** False when the booking's session pass doesn't cover the new session (public only). */
  let passCoversNewSession = true
  if (newSession.booking_type === 'public') {
    const legacyPricing = seats.some((s) => s.unit_price === null)
    // The quote was already fetched in parallel with the conflict pre-check above.
    newQuotes = quoteAttempt
    if (!newQuotes) {
      // The parallel quote fetch failed (its catch nulls the result and sets quoteError — but
      // guard anyway so a null can never be indexed below).
      return { moved: false, reason: 'band_unpriced' }
    }
    // A session-pass seat keeps its credit only if the booking's pass covers the NEW session
    // (pass_covers_session: a Core pass never covers Peak).
    if (booking.redeemed_session_pass_id && seats.some((s) => s.pay_by === 'session_pass_credit')) {
      const coverage = await paddockData.query<{ covers: boolean }>(
        'SELECT pass_covers_session(pass_type_id, $1) AS covers FROM customer_session_passes WHERE id = $2',
        [newSessionId, booking.redeemed_session_pass_id]
      )
      passCoversNewSession = coverage.data[0]?.covers === true
    }
    const seatDeltas: MoveSeatDelta[] = []
    let rawAmountDue = 0
    for (let i = 0; i < partySize; i++) {
      const oldSeat = seats[i]
      const newQuote = newQuotes[i]
      if (!oldSeat || !newQuote) break
      let payBy: MoveSeatDelta['payBy'] =
        oldSeat.pay_by === 'membership_credit' || oldSeat.pay_by === 'session_pass_credit'
          ? (oldSeat.pay_by as MoveSeatDelta['payBy'])
          : 'paid'
      let creditReleased = false
      if (payBy === 'membership_credit' && !newQuote.credit_eligible) {
        // e.g. a Core member moving into Peak — the seat is paid at its new unit_price and the
        // credit is released (the booking's credit_period_id is cleared below, once the move is
        // confirmed). If the credit's period has already ended by then it is simply gone — no
        // rollover.
        payBy = 'paid'
        creditReleased = true
      }
      if (payBy === 'session_pass_credit' && !passCoversNewSession) {
        // e.g. a Core pass moving into Peak — same as the membership case: the seat is paid at its
        // new unit_price and the pass session is returned once the move is written.
        payBy = 'paid'
        creditReleased = true
      }
      const oldUnitPrice = oldSeat.unit_price === null ? null : Number.parseFloat(oldSeat.unit_price)
      // A released credit seat was never paid with money (its stored unit_price is only the quote),
      // so it is charged its full new unit_price; a seat already paid settles only the difference.
      const delta =
        payBy !== 'paid' || oldUnitPrice === null
          ? 0
          : creditReleased
            ? Number.parseFloat(newQuote.unit_price)
            : Number.parseFloat(newQuote.unit_price) - oldUnitPrice
      if (payBy === 'paid') rawAmountDue += delta
      seatDeltas.push({
        seatNo: newQuote.seat_no,
        seatKind: newQuote.seat_kind,
        payBy,
        oldUnitPrice,
        newUnitPrice: Number.parseFloat(newQuote.unit_price),
        delta,
        creditReleased,
      })
    }
    // Q28: what is due is never more than the new seats less what was paid toward them and the part
    // refunds. A capped cheaper move lowered the seats by more than the money it gave back, so the
    // seat differences alone would charge the customer for what they had already been given.
    if (rawAmountDue > 0) {
      const newPaidSeats = seatDeltas.reduce((sum, seat) => (seat.payBy === 'paid' ? sum + seat.newUnitPrice : sum), 0)
      const q28 = newPaidSeats - paidToward - Number.parseFloat(booking.part_refunded_amount)
      rawAmountDue = Math.max(Math.min(rawAmountDue, q28), 0)
    }
    const amountDue = legacyPricing ? 0 : settled(rawAmountDue)
    priceImpact = {
      amountDue,
      refundDue: amountDue < -0.001,
      seatDeltas,
      legacyPricing,
      customerId: booking.customer_id,
    }
  } else if (newSession.booking_type === 'private') {
    // Private bookings are whole-booking priced: the new session's band tier at this party size
    // is the new price, and only the difference against what was paid plus the part refunds is settled
    // (same two-step quote/confirm flow as public). Private guests carry no per-seat prices, so no
    // seat deltas.
    const tier = await paddockData.query<{ price: string | null }>(
      `SELECT t.price FROM service_type_price_tiers t
       WHERE t.service_type_id = $1 AND t.band_id = $2
         AND t.min_people <= $3 AND t.max_people >= $4
       LIMIT 1`,
      [newSession.service_type_id, newSession.band_id, partySize, partySize]
    )
    const tierPrice = tier.data[0]?.price === null || tier.data[0]?.price === undefined
      ? null
      : Number.parseFloat(tier.data[0]!.price)
    if (tierPrice === null) {
      return {
        moved: false,
        reason: 'private_price_not_set',
        message: 'No private price is set for this group size and band — add one under Catalog → Session Types first.',
      }
    }
    const amountDue = settled(tierPrice - paidToward - Number.parseFloat(booking.part_refunded_amount))
    priceImpact = {
      amountDue,
      refundDue: amountDue < -0.001,
      seatDeltas: [],
      legacyPricing: false,
      customerId: booking.customer_id,
    }
  }

  // --- Step 1: quote ---
  if (!confirmed) {
    return priceImpact ? { moved: false, priceImpact } : { moved: false }
  }

  // --- Step 2: confirmed — validate the money movement before writing anything ---
  if (await anyReaderPaymentOpenOnBooking(bookingId)) {
    return { moved: false, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
  }
  // Cash comes first, whatever the difference has become: it is worked out again on this call, and
  // can have gone up, come down, or turned into nothing owed or a refund. Nothing has been taken
  // or written yet, so there is nothing to put back.
  const cashToCollect = amountLeftToPay(priceImpact?.amountDue ?? 0, payment?.giftCard?.amount ?? 0, payment?.storeCredit?.amount ?? 0)
  const cashRefusal = cashDifferenceRefusal(payment?.method, cashToCollect, payment?.confirmedCashAmount)
  if (cashRefusal) {
    return { moved: false, reason: cashRefusal.reason, message: cashRefusal.message, ...(priceImpact ? { priceImpact } : {}) }
  }
  let chargeAmount = 0
  let refundAmount = 0
  if (priceImpact && priceImpact.amountDue > 0.001) {
    chargeAmount = priceImpact.amountDue
    const giftCardAmount = payment?.giftCard?.amount ?? 0
    const storeCreditAmount = payment?.storeCredit?.amount ?? 0
    if (exceedsAmount(giftCardAmount, chargeAmount)) {
      return { moved: false, reason: 'gift_card_amount_exceeds_total', priceImpact }
    }
    if (exceedsAmount(giftCardAmount + storeCreditAmount, chargeAmount)) {
      return { moved: false, reason: 'store_credit_amount_exceeds_total', priceImpact }
    }
    const expectedRemainder = amountLeftToPay(chargeAmount, giftCardAmount, storeCreditAmount)
    if (expectedRemainder > 0 && !payment?.method) {
      // The screen thought nothing was owed, so it offered no way to pay: the figures bring them up.
      return { moved: false, reason: 'payment_method_required', priceImpact }
    }
    // New reader flow: no pre-charged PaymentIntent — the move writes happen first (pending) and
    // the PaymentIntent is created with metadata afterwards; the frontend collects then calls
    // finaliseReaderPayment. There must be something for the reader to charge. The screen only
    // sends the reader with something left to pay, so here the amount has changed.
    if (payment?.method === 'reader' && expectedRemainder <= 0.005) {
      return { moved: false, reason: 'payment_method_required', message: AMOUNT_CHANGED_MESSAGE, priceImpact }
    }
  }
  if (priceImpact && priceImpact.amountDue < -0.001) {
    refundAmount = -priceImpact.amountDue
    // A move that refunds money cannot use the card reader — there is nothing to charge.
    if (payment?.method === 'reader') {
      return {
        moved: false,
        reason: 'payment_method_required',
        message: 'This move refunds the price difference — a card reader cannot refund. Choose a refund method instead.',
        priceImpact,
      }
    }
    if (!refundMethod) {
      return { moved: false, reason: 'refund_method_required', priceImpact }
    }
    // A move that refunds the difference is a refund action like any other — the caller must
    // hold can_issue_refunds. Checked before any money moves or anything is written.
    const refundPermission = await getStaffAccessRow(req.user.email)
    if (!refundPermission?.can_issue_refunds) {
      return { moved: false, reason: 'no_refund_permission' }
    }
  }
  // The difference has gone to nothing: the reader path below would start a £0 payment.
  if (payment?.method === 'reader' && chargeAmount === 0 && refundAmount === 0) {
    return { moved: false, reason: 'payment_method_required', message: AMOUNT_CHANGED_MESSAGE, ...(priceImpact ? { priceImpact } : {}) }
  }

  // --- Take the money BEFORE anything is written ---
  // Payment is settled first so a payment failure leaves the booking exactly as it was — on the
  // old session, with the old capacity untouched. Store credit is claimed first (negative
  // 'redemption' movement), then the gift card is debited, then the saved card is charged. If
  // any step fails, reverseTakenPayment below puts back the parts already taken and a failure
  // reason is returned. Reader charges were already taken by the Terminal before this call, and
  // cash needs no server-side action — staff confirmed receipt in the UI.
  let storeCreditClaimedAmount = 0
  let giftCardClaimedAmount = 0
  let cardChargedAmount = 0
  /** The saved-card charge's PaymentIntent — a reversal refunds exactly this. */
  let cardChargedPaymentIntentId: string | null = null
  const readerPending = payment?.method === 'reader'

  // Best-effort reversal of every payment part taken so far: store credit via a positive
  // 'redemption_reversal' movement, the gift card balance restored, the card charge refunded via
  // a refund of that exact PaymentIntent (reverseSavedCardCharge). Returns a short description of anything that could NOT
  // be reversed automatically — null when everything was put back. Safe to call more than once:
  // only the first call reverses anything.
  /** The charge's subject and whether it resumed a dead press, for its finished row. */
  let cardChargeFinished: { subject: Parameters<typeof chargeFinishedDetails>[0]; resumed: boolean } | null = null
  /** Whose parts this press holds (its own started row, or the dead press's it resumed), and its own. */
  let partsFrom: string | null = null
  let ownStartedId: string | null = null
  /** Set once the key is retired: a finished row for this payment, if any (another press, or this
   *  one's statement whose answer was lost, moved the booking with it). */
  let chargeOutcome: { retired: boolean; failed: boolean; winner: { partsFrom: string | null; by: string | null } | null } | null = null
  const retireAndFindWinner = async () => {
    if (chargeOutcome) return chargeOutcome
    try {
      await retireCardCharge(bookingId)
    } catch {
      chargeOutcome = { retired: false, failed: false, winner: null }
      return chargeOutcome
    }
    try {
      chargeOutcome = { retired: true, failed: false, winner: cardChargedPaymentIntentId ? await cardChargeWinner(bookingId, cardChargedPaymentIntentId) : null }
    } catch {
      chargeOutcome = { retired: true, failed: true, winner: null }
    }
    return chargeOutcome
  }
  /** A function, so TypeScript reads the variable as it is when called, not as it was declared. */
  const winnerFound = () => chargeOutcome?.winner ?? null
  const MOVED_WITH_THIS_PAYMENT =
    'This booking was already moved with the same payment (by a press at the same moment, or this one with its answer lost), so it was only taken once. Reload the booking.'

  let paymentReversed = false
  const reverseTakenPayment = async (): Promise<string | null> => {
    if (paymentReversed) return null
    paymentReversed = true
    // A refunded PaymentIntent still replays as paid, so its key must be finished with before it is
    // refunded. If it can't be, everything stays taken, and pressing again finishes the move. With the
    // key retired, a finished row for the payment means it is the booking's: never refunded, and the
    // parts go back only if the press that finished didn't count them as its own.
    let movedWithThisPayment = false
    if (cardChargedAmount > 0) {
      const outcome = await retireAndFindWinner()
      if (!outcome.retired) return 'the card, store credit and gift card are all still taken: wait a minute, then press again, which finishes it without charging twice'
      if (outcome.failed) {
        return `checking whether another press moved it with payment ${cardChargedPaymentIntentId ?? ''} failed, so nothing was refunded or put back: check the booking and that payment before doing anything else`
      }
      movedWithThisPayment = outcome.winner !== null
      if (outcome.winner && outcome.winner.partsFrom === partsFrom) return null
    }
    let notReversed: string | null = null
    if (storeCreditClaimedAmount > 0) {
      const back = await storeCreditMoved({
        customerId: booking.customer_id,
        amount: storeCreditClaimedAmount,
        reason: 'redemption_reversal',
        bookingId,
        staffId: actingStaffId,
        note: 'Automatic reversal — the booking move failed after the store credit was redeemed.',
      })
      if (!back) notReversed = 'store credit reversal failed'
    }
    if (giftCardClaimedAmount > 0 && payment?.giftCard) {
      try {
        // The claim only ever marks the card redeemed_at when it drives the balance to exactly
        // zero (the claim requires remaining_balance >= the amount, so the balance can only sit
        // at zero because of this move's own claim) — restoring the balance past zero therefore
        // un-marks it, while a card already redeemed at a positive balance keeps its mark.
        await paddockData.query(
          `UPDATE gift_cards
           SET remaining_balance = remaining_balance + $1,
               redeemed_at = CASE WHEN remaining_balance <= 0 THEN NULL ELSE redeemed_at END,
               updated_at = now()
           WHERE id = $2`,
          [giftCardClaimedAmount, payment.giftCard.giftCardId]
        )
      } catch {
        notReversed = notReversed ? `${notReversed}; gift card restore failed` : 'gift card restore failed'
      }
    }
    if (cardChargedAmount > 0 && !movedWithThisPayment) {
      // Refund exactly the charge THIS call just took (its own PaymentIntent and amount); no
      // permission check — returning money the caller's own action just took must not depend on
      // can_issue_refunds.
      const reversed = cardChargedPaymentIntentId
        ? await reverseSavedCardCharge(cardChargedPaymentIntentId, cardChargedAmount).catch(() => ({ ok: false }))
        : { ok: false }
      if (!reversed.ok) notReversed = notReversed ? `${notReversed}; card refund failed` : 'card refund failed'
    }
    return notReversed
  }

  if (chargeAmount > 0 && payment) {
    const giftCardAmount = payment.giftCard?.amount ?? 0
    const storeCreditAmount = payment.storeCredit?.amount ?? 0
    const remainder = amountLeftToPay(chargeAmount, giftCardAmount, storeCreditAmount)
    const cardCharge = { flow: 'move' as const, bookingId, customerId: booking.customer_id, bookingUpdatedAt: booking.updated_at, amount: remainder }
    // Another press may be taking this same payment now: wait for it. Or one died after its charge,
    // having taken these parts too, and nothing gave them back.
    const earlier = remainder > 0 && payment.method === 'card' ? await earlierCardCharge(cardCharge) : ({ state: 'none' } as const)
    if (earlier.state === 'in_progress') {
      return { moved: false, reason: 'card_charge_in_progress', message: CARD_CHARGE_IN_PROGRESS_MESSAGE }
    }
    const resuming = earlier.state === 'resume'
    if (earlier.state === 'resume') {
      partsFrom = earlier.startedId
      storeCreditClaimedAmount = storeCreditAmount
      giftCardClaimedAmount = giftCardAmount
    }
    cardChargeFinished = { subject: cardCharge, resumed: resuming }
    try {
      if (storeCreditAmount > 0 && !resuming) {
        const applied = await applyStoreCredit({
          customerId: booking.customer_id,
          amount: -storeCreditAmount,
          reason: 'redemption',
          bookingId,
          staffId: actingStaffId,
          note: 'Store credit redeemed towards a booking move price difference.',
        })
        if (!applied.ok) {
          throw new Error('store_credit_insufficient_or_invalid')
        }
        storeCreditClaimedAmount = storeCreditAmount
      }
      if (giftCardAmount > 0 && payment.giftCard && !resuming) {
        const claim = await paddockData.query<{ id: string; remaining_balance: string }>(
          `UPDATE gift_cards SET remaining_balance = remaining_balance - $1, updated_at = now()
           WHERE id = $2 AND remaining_balance >= $3 AND voided IS NOT TRUE AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
           RETURNING id, remaining_balance`,
          [giftCardAmount, payment.giftCard.giftCardId, giftCardAmount]
        )
        if (claim.data.length === 0) {
          throw new Error('gift_card_insufficient_or_invalid')
        }
        giftCardClaimedAmount = giftCardAmount
        if (Number.parseFloat(claim.data[0]!.remaining_balance) <= 0) {
          await paddockData.query(`UPDATE gift_cards SET redeemed_at = now() WHERE id = $1 AND redeemed_at IS NULL`, [
            payment.giftCard.giftCardId,
          ])
        }
      }
      if (remainder > 0 && payment.method === 'card') {
        const charged = await chargeBookingCard({
          ...cardCharge,
          staffId: actingStaffId,
          description: `Booking moved to a differently priced session (${bookingId})`,
          lineItems: [{ itemType: 'booking', quantity: 1, unitPrice: remainder, bookingId }],
        })
        cardChargedAmount = remainder
        cardChargedPaymentIntentId = charged.paymentIntentId
        ownStartedId = charged.startedId
        partsFrom ??= charged.startedId
      } else if (remainder > 0 && payment.method === 'reader') {
        // New reader flow: nothing to collect here — the PaymentIntent is created after the move
        // writes below, and the frontend collects on the reader then finalises.
      }
      // 'cash' needs no server-side action — staff confirmed receipt in the UI.
    } catch (err) {
      // Nothing has been written yet — put back whatever was taken and return with the booking
      // exactly as it was, on the old session, with the old capacity untouched.
      const notReversed = await reverseTakenPayment()
      const message = err instanceof Error ? err.message : String(err)
      if (
        message === 'store_credit_insufficient_or_invalid' ||
        message === 'gift_card_insufficient_or_invalid'
      ) {
        return { moved: false, reason: message as MoveBookingFailureReason }
      }
      // No clear answer: the charge may land later. The parts are back, so the next press must take
      // them again rather than count them.
      const unsure = cardChargeUnsure(err)
      if (unsure) {
        const marked = notReversed === null && (await markCardChargePartsReturned(bookingId, [unsure.startedId, ...(partsFrom ? [partsFrom] : [])], actingStaffId))
        return {
          moved: false,
          reason: 'card_charge_failed',
          message: marked ? unsure.message : `${unsure.message} Putting the store credit or gift card back didn't fully work: check their balance and the gift card by hand.`,
        }
      }
      return { moved: false, reason: 'card_charge_failed' }
    }
  }

  // --- Move the booking: capacity first, then the rows ---
  let oldCapacityReleased = false
  let newCapacityClaimed = false

  // Reader path undo when the move can't go ahead: release the new session's capacity and reverse
  // the money parts. The booking is written by one statement, so it is either untouched or moved.
  // The old seat was never released on this path (nothing to re-claim) and the pass session is only
  // released at finalise (nothing to take back).
  const undoReaderMove = async (): Promise<{ restoreProblems: string[]; notReversed: string | null }> => {
    const restoreProblems: string[] = []
    if (newCapacityClaimed) {
      try {
        await releaseSessionCapacity(newSessionId, partySize, newSession.booking_type)
        newCapacityClaimed = false
      } catch (releaseErr) {
        restoreProblems.push(
          `release the new session capacity: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`
        )
      }
    }
    const notReversed = await reverseTakenPayment()
    return { restoreProblems, notReversed }
  }
  const readerMoveFailure = (
    undo: { restoreProblems: string[]; notReversed: string | null },
    whenClean: MoveBookingResult
  ): MoveBookingResult => {
    if (undo.restoreProblems.length > 0) {
      return {
        moved: false,
        reason: 'move_failed_restore_failed',
        message:
          'The card reader payment could not be set up and the move could not be fully undone — check this ' +
          "booking's new session by hand before doing anything else" +
          (undo.notReversed ? `; also check the customer's money: ${undo.notReversed}` : '') +
          `. Failed steps: ${undo.restoreProblems.join('; ')}`,
      }
    }
    if (undo.notReversed) return { moved: false, reason: 'move_failed_refund_failed' }
    return whenClean
  }

  // Non-reader undo when the move fails after capacity changed: re-claim the old seat it released,
  // release the new seat it claimed, then reverse the money taken. The booking is written by one
  // statement, so it needs nothing putting back.
  const undoMove = async (): Promise<{ restoreProblems: string[]; notReversed: string | null }> => {
    const restoreProblems: string[] = []
    if (oldCapacityReleased) {
      try {
        if (await claimSessionCapacity(booking.session_id, partySize)) {
          oldCapacityReleased = false
        } else {
          restoreProblems.push('re-claim the old session capacity: the old session is now full')
        }
      } catch (claimErr) {
        restoreProblems.push(
          `re-claim the old session capacity: ${claimErr instanceof Error ? claimErr.message : String(claimErr)}`
        )
      }
    }
    if (newCapacityClaimed) {
      try {
        await releaseSessionCapacity(newSessionId, partySize, newSession.booking_type)
        newCapacityClaimed = false
      } catch (releaseErr) {
        restoreProblems.push(
          `release the new session capacity: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`
        )
      }
    }
    const notReversed = chargeAmount > 0 ? await reverseTakenPayment() : null
    return { restoreProblems, notReversed }
  }
  const moveRestoreFailure = (undo: { restoreProblems: string[]; notReversed: string | null }): MoveBookingResult => ({
    moved: false,
    reason: 'move_failed_restore_failed',
    message:
      'The move failed and could not be fully undone — check this booking and both sessions (old and new) ' +
      'by hand: which session the booking is on, and that each session counts it correctly' +
      (undo.notReversed ? `; also check the customer's money: ${undo.notReversed}` : '') +
      `. Failed steps: ${undo.restoreProblems.join('; ')}`,
  })

  try {
    // Release the capacity this booking held on the old session first... (bookingType left
    // unresolved so releaseSessionCapacity looks it up itself — the old session may be a
    // different service type/booking_type than the new one).
    // Reader-pending mode: the OLD seat stays held until finalise (Wayne's rule — the old seat
    // must not be released while the reader wait is open); it is released by
    // finaliseMovePending, and undoMovePending never touches it, so no re-claim race exists.
    if (!readerPending) {
      await releaseSessionCapacity(booking.session_id, partySize)
      oldCapacityReleased = true
    }

    // ...then atomically claim capacity on the new session (mirrors createBooking.ts's rule: a
    // private session claims its entire capacity in one shot, a public session claims
    // per-attendee).
    const capacityClaimed = await claimSessionCapacity(newSessionId, partySize, newSession.booking_type)
    if (!capacityClaimed) {
      // Couldn't claim the new session — put the old session's capacity back the way it was and
      // reverse the money taken above; the booking stays on the old session exactly as it was.
      // Reader path: the old seat was never released, so only the money is reversed.
      if (oldCapacityReleased) {
        const undo = await undoMove()
        if (undo.restoreProblems.length > 0) return moveRestoreFailure(undo)
        if (undo.notReversed) return { moved: false, reason: 'move_failed_refund_failed' }
        if (winnerFound()) return { moved: false, reason: 'already_moved', message: MOVED_WITH_THIS_PAYMENT }
        return { moved: false, reason: 'insufficient_capacity' }
      }
      const notReversed = await reverseTakenPayment()
      if (notReversed) {
        return { moved: false, reason: 'move_failed_refund_failed' }
      }
      if (winnerFound()) return { moved: false, reason: 'already_moved', message: MOVED_WITH_THIS_PAYMENT }
      return { moved: false, reason: 'insufficient_capacity' }
    }
    newCapacityClaimed = true
    // price_paid moves by exactly what this move settles, so a part refund stays off it (Q28).
    // Legacy bookings keep the price they were charged.
    const newPricePaid =
      priceImpact && !priceImpact.legacyPricing ? Math.round((oldPricePaid + priceImpact.amountDue) * 100) / 100 : null

    const seatChanges: Array<{ id: string; unitPrice: string | number; payBy: string | null }> = []
    if (priceImpact && !priceImpact.legacyPricing && newQuotes) {
      for (let i = 0; i < seats.length; i++) {
        const seat = seats[i]
        const delta = priceImpact.seatDeltas[i]
        const quote = newQuotes[i]
        if (!seat || !delta || !quote) continue
        seatChanges.push({ id: seat.id, unitPrice: quote.unit_price, payBy: delta.payBy })
      }
    }
    // Credit settlement: any seat whose membership credit was released (new band not
    // credit-eligible for the member's level) is released by clearing the booking's
    // credit_period_id in the same UPDATE — the credit then counts as unused again for its
    // period automatically. When the credit STAYS, the booking keeps its original
    // credit_period_id even if the new session sits in a later period. A released session-pass
    // credit clears redeemed_session_pass_id in the same UPDATE; the pass counter itself is given
    // back after the write (or at finalise on the reader path — see below).
    const creditReleasedOnMove = Boolean(
      priceImpact &&
        !priceImpact.legacyPricing &&
        priceImpact.seatDeltas.some((s) => s.creditReleased)
    )
    const sessionPassToRelease = creditReleasedOnMove && !passCoversNewSession ? booking.redeemed_session_pass_id : null

    // The reader path's pending row: undoMovePending puts the booking back from this.
    const moveSnapshot: PendingReaderSnapshot = {
      customer_id: booking.customer_id,
      description: `Booking moved to a differently priced session (${bookingId})`,
      booking_id: bookingId,
      old_session_id: booking.session_id,
      old_start_time: booking.start_time,
      old_end_time: booking.end_time,
      old_price_paid: booking.price_paid,
      price_paid_change: newPricePaid === null ? 0 : Math.round((newPricePaid - oldPricePaid) * 100) / 100,
      old_band_id: booking.band_id,
      old_credit_period_id: booking.credit_period_id,
      old_redemption_source: booking.redemption_source,
      old_redeemed_membership_id: booking.redeemed_membership_id,
      old_redeemed_session_pass_id: booking.redeemed_session_pass_id,
      // Deferred like the old seat: the pass session is only returned when the reader payment
      // is finalised, so an undo never has to re-claim it from the pass.
      ...(sessionPassToRelease ? { release_session_pass_on_finalise: true } : {}),
      seats: seats.map((s) => ({ id: s.id, unit_price: s.unit_price ?? '', pay_by: s.pay_by })),
      new_session_id: newSessionId,
      new_session_booking_type: newSession.booking_type,
      party_size: partySize,
      ...(storeCreditClaimedAmount > 0 ? { store_credit_amount: storeCreditClaimedAmount } : {}),
      ...(giftCardClaimedAmount > 0 && payment?.giftCard
        ? { gift_card: { gift_card_id: payment.giftCard.giftCardId, amount: giftCardClaimedAmount } }
        : {}),
    }

    // New reader flow: create the PaymentIntent (metadata flow/record_id) first, as nothing is
    // charged until the frontend collects on the reader. The pending row then goes in with the move
    // itself, so price_paid never holds this money without the row that stops it being refunded.
    const readerRemainder = chargeAmount - (payment?.giftCard?.amount ?? 0) - (payment?.storeCredit?.amount ?? 0)
    let intent: { paymentIntentId: string; clientSecret: string } | null = null
    if (readerPending) {
      try {
        intent = await createTerminalPaymentIntent({
          params: {
            customerId: booking.customer_id,
            amount: readerRemainder,
            saveCard: false,
            metadata: { flow: 'move', record_id: bookingId },
            description: moveSnapshot.description,
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return readerMoveFailure(await undoReaderMove(), {
          moved: false,
          reason: 'move_failed',
          message: `Creating the card reader payment failed — the move was undone and nothing was charged (${message}).`,
        })
      }
    }

    // ONE guarded statement: the booking, each seat's new price/coverage and the pending row, so
    // none of them can happen alone. It is also the claim on a refund's money: price_paid must be
    // what this move was worked out from, the booking still live, and nothing open on the reader. A
    // part refund on its way has already lowered price_paid, so a move that read it counts it, and
    // one that read it before is stopped here rather than writing the old figure back.
    // With no card charge, this press marks its own write (shared/pressFinished), so an answer lost
    // after the statement wrote is never undone. A card charge has its finished row for that.
    const pressId = cardChargedAmount > 0 ? null : newPressId()
    let updateResult: { data: Array<{ id: string; pending_id: string | null; claim_id: string | null }> }
    try {
      updateResult = await paddockData.query<{ id: string; pending_id: string | null; claim_id: string | null }>(
        `WITH bk AS (
           UPDATE bookings b
           SET session_id = $1, start_time = $2, end_time = $3,
               price_paid = COALESCE($4, b.price_paid),
               band_id = $5,
               credit_period_id = CASE WHEN $6::boolean THEN NULL ELSE b.credit_period_id END,
               redemption_source = CASE WHEN $7::boolean THEN 'paid' ELSE b.redemption_source END,
               redeemed_membership_id = CASE WHEN $8::boolean THEN NULL ELSE b.redeemed_membership_id END,
               redeemed_session_pass_id = CASE WHEN $9::boolean THEN NULL ELSE b.redeemed_session_pass_id END,
               updated_at = now()
           WHERE b.id = $10 AND b.status <> 'cancelled' AND b.price_paid = $11::numeric AND b.party_size = $12::int
             AND b.session_id = $13
             AND ${CHARGE_KEY_STILL_STANDS('b', '$14')}
             AND ${NO_READER_PAYMENT_OPEN}
           RETURNING b.id
         ),
         seats AS (
           UPDATE booking_guests g SET unit_price = x.unit_price, pay_by = x.pay_by
           FROM bk, unnest($15::uuid[], $16::numeric[], $17::text[]) AS x(id, unit_price, pay_by)
           WHERE g.id = x.id
           RETURNING g.id
         ),
         pending AS (
           INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status)
           SELECT 'move', bk.id, $18::text, $19::numeric, $20::jsonb, 'pending' FROM bk WHERE $21::boolean
           RETURNING id
         ),
         ${CLAIM_AUDIT('$22', '$23', '$24::boolean')},
         ${CHARGE_FINISHED_AUDIT('$25', '$26', '$27::boolean')},
         -- The gift card part goes in the card's redemption history with the move, as Add Guest's does:
         -- this booking, no order (a move has none of its own). On the reader it is written at finalise
         -- (finaliseMovePending), so an undo has no row to remove.
         gcr AS (
           INSERT INTO gift_card_redemptions (gift_card_id, order_id, booking_id, amount_used, redeemed_at)
           SELECT $28::uuid, NULL, bk.id, $29::numeric, now() FROM bk WHERE $30::boolean
           RETURNING id
         ),
         ${PRESS_FINISHED_AUDIT('$31', `jsonb_build_object('press', $32::text, 'claim', (SELECT id FROM claim), 'pending', (SELECT id FROM pending))`, '$33::boolean')}
         SELECT bk.id, (SELECT id FROM pending) AS pending_id, (SELECT id FROM claim) AS claim_id FROM bk`,
        [
          newSessionId,
          newSession.start_time,
          newSession.end_time,
          newPricePaid,
          // Private (and legacy-priced public) moves have no seat quotes: the booking still takes
          // the new session's band, same as createBooking.
          newQuotes ? newQuotes[0]!.band_id : newSession.band_id,
          creditReleasedOnMove,
          creditReleasedOnMove,
          creditReleasedOnMove,
          creditReleasedOnMove,
          bookingId,
          oldPricePaid,
          booking.party_size,
          booking.session_id,
          cardChargedAmount > 0 ? booking.updated_at : null,
          seatChanges.map((s) => s.id),
          seatChanges.map((s) => s.unitPrice),
          seatChanges.map((s) => s.payBy),
          intent?.paymentIntentId ?? null,
          readerRemainder,
          JSON.stringify(moveSnapshot),
          intent !== null,
          actingStaffId,
          refundClaimDetails('move', { amount: refundAmount, seenPricePaid: oldPricePaid, ...(refundMethod ? { method: refundMethod } : {}) }),
          refundAmount > 0,
          actingStaffId,
          cardChargeFinished && cardChargedAmount > 0 && partsFrom && ownStartedId
            ? chargeFinishedDetails(cardChargeFinished.subject, {
                paymentIntentId: cardChargedPaymentIntentId,
                partsFrom,
                by: ownStartedId,
                resumed: cardChargeFinished.resumed,
              })
            : '{}',
          cardChargedAmount > 0,
          payment?.giftCard?.giftCardId ?? null,
          giftCardClaimedAmount,
          giftCardClaimedAmount > 0 && !readerPending,
          actingStaffId,
          pressId,
          pressId !== null,
        ]
      )
    } catch (err) {
      // The statement may have written and lost its answer: then its row is there, and the move goes
      // on as if the answer had come back (the pass, the reader payment and any refund still follow).
      // Not there: nothing was written, and the catch below undoes it.
      if (!pressId) throw err
      let landed: Record<string, unknown> | null
      try {
        landed = await findPressFinished(bookingId, pressId)
      } catch {
        return { moved: false, reason: 'move_failed_restore_failed', message: MOVE_SAVE_UNCLEAR_MESSAGE }
      }
      if (!landed) throw err
      updateResult = { data: [{ id: bookingId, pending_id: detailId(landed, 'pending'), claim_id: detailId(landed, 'claim') }] }
    }
    const written = updateResult.data[0]
    if (!written) {
      // Nothing was written. Whatever the reader's PaymentIntent was for, nobody can collect it.
      const undo = readerPending ? await undoReaderMove() : await undoMove()
      if (undo.restoreProblems.length > 0) return moveRestoreFailure(undo)
      if (undo.notReversed) return { moved: false, reason: 'move_failed_refund_failed' }
      if (winnerFound()) return { moved: false, reason: 'already_moved', message: MOVED_WITH_THIS_PAYMENT }
      if (await anyReaderPaymentOpenOnBooking(bookingId)) {
        return { moved: false, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
      }
      return {
        moved: false,
        reason: 'booking_changed',
        message: 'The booking changed while it was being moved, so it was not moved and any payment was put back. Check it and try again.',
      }
    }

    if (intent) {
      return {
        moved: true,
        booking: { id: written.id, price_paid: newPricePaid },
        pendingReaderPayment: {
          flow: 'move',
          recordId: bookingId,
          pendingId: written.pending_id!,
          paymentIntentId: intent.paymentIntentId,
          clientSecret: intent.clientSecret,
          amount: readerRemainder,
        },
      }
    }

    // The move is written: return the released session to the pass (only while it is unexpired —
    // see releaseSessionPassCredit). A failure here must not undo the move or the money already
    // taken; it surfaces as a warning for a manual check.
    let passReleaseWarning: string | undefined
    if (sessionPassToRelease) {
      try {
        await releaseSessionPassCredit(sessionPassToRelease)
      } catch (err) {
        passReleaseWarning =
          `The booking moved, but returning the session to the customer's pass failed and needs a ` +
          `manual check: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // Refund the difference when paid seats got cheaper. Failures here do NOT undo the move —
    // the error is surfaced so staff can retry the refund.
    if (refundAmount > 0 && refundMethod) {
      // Permission was already checked above (no_refund_permission) before any money moved. The
      // difference goes back in Retool (shared/bookingRefund): card against the booking's orders
      // newest first, each capped at its card portion, recorded on its booking line; the rest to
      // store credit. The move is already written, so a refund that fails doesn't undo it: the
      // money goes back on price_paid below, owed, for staff to give with Refund the rest.
      const given = await giveBookingMoneyBack({
        bookingId,
        customerId: booking.customer_id,
        amount: refundAmount,
        method: refundMethod,
        staffId: actingStaffId,
        user: req.user,
        note: 'Refund of the price difference after a booking move',
        recordCardOnLines: true,
        pricePaidBefore: oldPricePaid,
      })
      // The move wrote price_paid as if all of it went back. What didn't stays on the booking as
      // money owed, so price_paid falls only by what was given back.
      const notGiven = given.ok ? (given.result.shortfall ?? 0) : refundAmount
      const stillOnBooking = (): string => {
        if (!given.ok && given.unsure) return `The £${notGiven.toFixed(2)} is still on the booking. ${REFUND_UNSURE_MESSAGE}`
        return refundMethod === 'card'
          ? `The card refund of £${notGiven.toFixed(2)} failed, so it is still on the booking: use Refund the rest.`
          : `The £${notGiven.toFixed(2)} is still on the booking: check their store credit balance, then use Refund the rest if it isn't there.`
      }
      const warnings = [
        ...(given.ok ? shortfallStaysOnBookingWarnings(given.result) : [stillOnBooking()]),
        ...(passReleaseWarning ? [passReleaseWarning] : []),
      ]
      let pricePaidNow = newPricePaid
      if (notGiven > 0) {
        try {
          await putBackAsOwed(bookingId, notGiven)
          pricePaidNow = Math.round(((newPricePaid ?? 0) + notGiven) * 100) / 100
        } catch (err) {
          warnings.push(
            `Putting the £${notGiven.toFixed(2)} back on the booking's price paid failed — check the booking before refunding it: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      if (written.claim_id) {
        await finishRefundClaim({
          claimId: written.claim_id,
          bookingId,
          staffId: actingStaffId,
          outcome: notGiven > 0 ? 'owed' : 'given',
          cardRefunded: given.ok ? given.result.cardRefunded : 0,
          storeCreditRefunded: given.ok ? given.result.storeCreditRefunded : 0,
          owed: notGiven,
        })
      }
      if (!given.ok) {
        return {
          moved: true,
          booking: { id: written.id, price_paid: pricePaidNow },
          reason: `refund_failed: ${given.message}` as MoveBookingFailureReason,
          warning: warnings.join(' '),
        }
      }
      if (warnings.length > 0) {
        return {
          moved: true,
          booking: { id: written.id, price_paid: pricePaidNow },
          warning: warnings.join(' '),
        }
      }
    }

    return {
      moved: true,
      booking: { id: written.id, price_paid: newPricePaid },
      ...(passReleaseWarning ? { warning: passReleaseWarning } : {}),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The statement may have written and lost its answer: then this press's own finished row is
    // there, the booking has moved with its charge and its capacity, and nothing must be undone.
    if (cardChargedAmount > 0 && ownStartedId) {
      const outcome = await retireAndFindWinner()
      if (outcome.winner && outcome.winner.by === ownStartedId) {
        return { moved: false, reason: 'already_moved', message: MOVED_WITH_THIS_PAYMENT }
      }
    }
    // Reader path, after the new capacity was claimed: the statement failed, so nothing was written.
    if (readerPending && newCapacityClaimed) {
      return readerMoveFailure(
        await undoReaderMove(),
        message.includes('bookings_no_cross_session_overlap')
          ? { moved: false, reason: 'time_conflict' }
          : { moved: false, reason: 'move_failed' }
      )
    }
    // The move failed (most likely the exclusion constraint catching a conflict that raced past
    // the pre-check above) — re-claim the old seat, release the new one and, when money was already
    // taken, reverse every payment part (store credit, gift card, card charge).
    const undo = await undoMove()
    if (undo.restoreProblems.length > 0) return moveRestoreFailure(undo)
    if (undo.notReversed) {
      return { moved: false, reason: 'move_failed_refund_failed' }
    }
    if (winnerFound()) return { moved: false, reason: 'already_moved', message: MOVED_WITH_THIS_PAYMENT }
    if (message.includes('bookings_no_cross_session_overlap')) {
      return { moved: false, reason: 'time_conflict' }
    }
    if (chargeAmount > 0) {
      return { moved: false, reason: 'move_failed' }
    }
    throw err
  }
}
