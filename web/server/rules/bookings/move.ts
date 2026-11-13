// New in W24 (D-plan 1.2, 3 N1/N2/N9, 4.2, 4.3, 4.7, 4.11; brief W24): moveBooking on the Worker. A booking moved to
// another session of its own type, repriced as the old function did, and the difference settled.
//
// The price, as the old function worked it out (D-plan 1.2's rules worth keeping exactly): a public booking is quoted
// seat by seat at the new session's band (quote_booking) and only the paid seats' differences move, a dearer move
// stopping at the new paid seats less what was paid toward them and the part refunds (Q28 and the W05 review's
// finding 7 cap); a private booking is priced at the new band's tier less those two; a refund is never more than is
// left; a booking with no seat prices (legacy) keeps its price (N9 left as it is); public to private and promo bookings
// are refused. Wayne's Q34 (N2): a membership credit stays only while the new band is credit-eligible for the level and
// the membership covers the new date (active, not past its last day); a pass seat only while the pass covers the new
// session and hasn't expired on that date. Otherwise the seat is charged its full new price and the credit or pass
// session is released. N1: the one-booking-a-day rule is checked before any money moves, with New Order's words (and
// the trigger's own refusal, should another booking race past the check, gets the same words, never the raw text).
//
// The dialog's first call is the quote (a read). The press sends the figures staff saw (Q18: `figures.amountDue`,
// signed; `toCollect`), and runs one transaction (C1, or R1 for a cheaper move), the booking locked in LOCK_ORDER with
// its customer, both sessions (id order), the session pass and the gift card:
// - same price, or dearer with no card money (cash, gift card, store credit), or cheaper to store credit: the places
//   on both sessions, the seats, the store credit and gift card (dearer), a released credit or pass session, and (a
//   cheaper move) the refund given as store credit, all in that one transaction. As today, no order for cash, gift card
//   or store credit (Wayne's Q36: keep today's way); the gift card's redemption row names the booking.
// - dearer on the card or reader (W19's flow pipeline): C1 claims the new place, holds the old seat, takes the store
//   credit and gift card, moves the booking and writes the flow record last; then the saved card is charged once under
//   `<pendingId>:charge` and W12's C2 finishes the move (the old place and a released pass session given back, the
//   card's order written), or the reader's intent is made under `<pendingId>:reader-intent` for the screen to collect.
//   A definite refusal undoes it in one transaction; no clear answer holds it (Q35) for reconcile.
// - cheaper to the card (W21's refund pipeline): R1 moves the booking and plans the refund (claim kind `move`), then
//   each card part once under `<claimId>:refund:<orderId>`, then R2. The first part refused undoes the move exactly; a
//   later one sends the rest to store credit; no clear answer holds it (the booking stays moved), and reconcile records
//   what went and leaves what never went owed (Refund the rest), never sending it again.
// A payment still being taken on the booking, or a refund still being checked, refuses the press (the quote shows the
// words instead). Issue refunds for a move that gives money back, checked before anything changes.
import 'server-only'
import type { ApiErrorCode, MoveBookingInput, MoveBookingOutput, MovePriceImpact, MoveQuote } from '@/contracts'
import { audit } from '@/server/audit'
import { postgresRefusal, type Db, type Queryable, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import type { StripeClient } from '@/server/stripe/client'
import { stripeTiming } from '@/server/stripe/deadline'
import { amountChangedRefusal, cashDifferenceRefusal, exceedsAmount } from '@/server/rules/orders/amounts'
import { COLLECT_DEADLINE_MS } from '@/server/rules/orders/collect-saved-card'
import { FAILURE_MESSAGES as ORDER_WORDS, NO_SAVED_CARD_MESSAGE } from '@/server/rules/orders/failure-messages'
import { FLOW_INTENT_UNCONFIRMED_MESSAGE, readFlow, undoFlowInTransaction } from '@/server/rules/orders/reader-flow'
import { findDuplicateDayBooking } from '@/server/rules/pricing/band-pricing'
import {
  AMOUNT_CHANGED_MESSAGE,
  amountChangedToMessage,
  MOVE_NOT_SAVED_MESSAGE,
  MOVE_NOT_UNDONE_MESSAGE,
  MOVE_PAYMENT_AND_REFUND_MESSAGE,
  MOVE_PAYMENT_NEEDED_MESSAGE,
  MOVE_WORDS,
  moveReaderNotStartedNotUndoneMessage,
  moveReaderSetupFailedMessage,
  moveRefundFailedMessage,
  REFUND_METHOD_WORDS,
  REFUND_OPEN_MESSAGE,
  REFUND_WORDS,
  staffSees,
} from './failure-messages'
import { createFlowReaderIntent, recordFlowIntent, settleCardFlow, writeFlowRecord, type CardFlowSnapshot, type ReaderFlowSnapshot } from './flow'
import { loadBooking, lockAndLoadBooking, paymentOpen, type LoadedBooking } from './load-booking'
import { claimGiftCard, claimStoreCredit, inC1, partAmount, paymentOpenRefusal } from './money-in'
import {
  BOOKING_MOVED,
  finishClaimInTransaction,
  moveRowDetails,
  planRefund,
  refundClaimOpen,
  sendAndFinish,
  writeClaim,
  type Claim,
  type ClaimDetails,
  type MoveClaim,
  type RefundOptions,
} from './refunds'

export interface MoveOptions extends RefundOptions {
  /** The signed-in staff member's Issue refunds switch: a move that gives money back needs it (as before). */
  canIssueRefunds: boolean
}

type MoveExtras = { priceImpact?: MovePriceImpact; pendingId?: string; field?: string; logDetail?: string }

/**
 * A refusal: the old reason and the words staff see (the old function's, else the Move dialog's for the reason), as
 * details, with the figures when the old function sent them, so the dialog moves to them.
 */
export function moveRefusal(code: ApiErrorCode, reason: string, message: string | undefined, extras: MoveExtras = {}): ApiError {
  const words = staffSees('move', reason, message)
  return new ApiError(code, words, {
    ...(extras.field ? { field: extras.field } : {}),
    ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
    details: {
      reason,
      message: words,
      action: 'move',
      ...(extras.priceImpact ? { priceImpact: extras.priceImpact } : {}),
      ...(extras.pendingId !== undefined ? { pendingId: extras.pendingId } : {}),
      ...(message ? {} : { screenWords: true }),
    },
  })
}

/** The old function's description of the change: the flow's, the card order's and the reader intent's. */
export const moveDescription = (bookingId: string): string => `Booking moved to a differently priced session (${bookingId})`
/** The old function's note on the store credit a dearer move took. */
export const MOVE_STORE_CREDIT_NOTE = 'Store credit redeemed towards a booking move price difference.'

const round2 = (n: number): number => Math.round(n * 100) / 100
const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))
/** Pennies are the smallest amount: anything above a tenth of a penny moves (the old function's 0.001). */
const MOVES = 0.001
/** Half a penny either way (Q18). */
const differs = (a: number, b: number): boolean => Math.round(Math.abs(a - b) * 1e6) / 1e6 > 0.005

/** The session the booking would move to, as the old function read it. */
interface NewSession {
  id: string
  capacity: number
  total_booked: number
  status: string
  service_type_id: string
  /** The service type's: 'public' or 'private'. */
  booking_type: string
  /** The session row's own type (quote_booking reads it). */
  type: string
  band_id: string | null
  /** Started (or in the past), on the London wall clock the times are stored in. */
  started: boolean
  /** The London date it falls on, as the one-booking-a-day rule reads it. */
  day: string
  start_time: string
}

const NEW_SESSION_SQL = `
SELECT s.id, s.capacity, s.total_booked, s.status, s.service_type_id, st.booking_type, s.type, s.band_id,
       (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS started,
       (s.start_time AT TIME ZONE 'UTC')::date::text AS day, s.start_time::text AS start_time
FROM sessions s JOIN service_types st ON st.id = s.service_type_id
WHERE s.id = $1::uuid`

interface SeatQuote {
  seat_no: number
  seat_kind: 'account_holder' | 'guest'
  band_id: string | null
  unit_price: string | null
  credit_eligible: boolean
}

/** What the move costs and changes, worked out from the booking (locked in C1, or as the quote reads it). */
interface Priced {
  booking: LoadedBooking
  newSession: NewSession
  partySize: number
  priceImpact: MovePriceImpact
  /** The booking's new price paid; null for a legacy booking, which keeps its price. */
  newPricePaid: number | null
  /** The band the booking takes: the new seats' band (public), else the session's. */
  newBandId: string | null
  /** Each seat's new price and cover (public, priced seats only). */
  seatChanges: Array<{ id: string; unitPrice: string; payBy: string }>
  /** Any seat's membership or pass credit released: the booking's credit fields are cleared. */
  creditReleased: boolean
  /** The pass a released pass seat gives its session back to (the old function's sessionPassToRelease). */
  passToRelease: string | null
}

const refusalOf = (code: ApiErrorCode, reason: string, message?: string): ApiError => moveRefusal(code, reason, message)

/**
 * The checks and the price, in the old function's order: the booking (found, movable: confirmed or pending, never one
 * awaiting payment (W24a), not the same session, not paid with a promo code), the new session (found, the same type, open, not started), N1 (the one-booking-a-day rule, new
 * here, before anything costs money), the seat quote and the overlap check, then the price. Reads only; every refusal
 * throws. In C1 the booking is already locked.
 */
async function priceTheMove(db: Queryable, booking: LoadedBooking | null, newSessionId: string): Promise<Priced> {
  if (!booking) throw refusalOf('NOT_FOUND', 'booking_not_found')
  // W24a (W24 review S1): a booking awaiting payment is refused. Its lapsed credit doesn't cover the new date (Q34), so
  // Move would charge seat 1 and leave the booking awaiting payment, and Settle would then charge seat 1 again.
  if (booking.status === 'payment_needed') throw refusalOf('CONFLICT', 'booking_not_movable', MOVE_PAYMENT_NEEDED_MESSAGE)
  if (booking.status !== 'confirmed' && booking.status !== 'pending') throw refusalOf('CONFLICT', 'booking_not_movable')
  if (booking.sessionId === newSessionId) throw refusalOf('CONFLICT', 'same_session')
  // A promo-discounted booking can never be moved: repricing from the new band would raise what was paid above what the
  // customer paid with the code.
  const promo = await db.query(
    'SELECT o.id FROM order_line_items oli JOIN orders o ON o.id = oli.order_id WHERE oli.booking_id = $1::uuid AND o.promo_code IS NOT NULL LIMIT 1',
    [booking.id]
  )
  if (promo.length > 0) throw refusalOf('CONFLICT', 'promo_discounted_booking', MOVE_WORDS.promoDiscounted)
  const newSession = (await db.query<NewSession>(NEW_SESSION_SQL, [newSessionId]))[0]
  if (!newSession) throw refusalOf('NOT_FOUND', 'session_not_found')
  if (newSession.booking_type !== booking.session.bookingType) throw refusalOf('CONFLICT', 'booking_type_mismatch', MOVE_WORDS.typeMismatch)
  if (newSession.status !== 'open') throw refusalOf('CONFLICT', 'session_blocked')
  if (newSession.started) throw refusalOf('CONFLICT', 'session_already_started')
  // N1: the old function met the one-booking-a-day trigger only at its write, after taking the money.
  if (await findDuplicateDayBooking(db, booking.customerId, newSession.start_time, booking.id)) {
    throw refusalOf('CONFLICT', 'duplicate_day_booking', ORDER_WORDS['duplicate_day_booking'])
  }

  const seats = booking.seats
  const partySize = seats.length > 0 ? seats.length : booking.partySize
  const isPublic = newSession.booking_type === 'public'
  // quote_booking raises for a session that isn't a public one with a band: inside C1 that would end the transaction,
  // so it is asked only when it can answer (the old function's band_unpriced either way).
  let quotes: SeatQuote[] | null = null
  if (isPublic) {
    if (newSession.type !== 'public' || newSession.band_id === null) throw refusalOf('CONFLICT', 'band_unpriced')
    quotes = await db.query<SeatQuote>('SELECT seat_no, seat_kind, band_id, unit_price::text AS unit_price, credit_eligible FROM quote_booking($1::uuid, $2::uuid, $3::int)', [
      newSessionId,
      booking.customerId,
      partySize,
    ])
    if (quotes.some((quote) => quote.unit_price === null)) throw refusalOf('CONFLICT', 'band_unpriced')
  }
  // The overlap rule's pre-check (another service type's live booking at the same time), this booking left out.
  const conflict = await db.query(
    `SELECT s2.id FROM sessions s2
     JOIN bookings b2 ON b2.session_id = s2.id AND b2.status IN ('pending', 'confirmed', 'payment_needed') AND b2.id <> $1::uuid
     WHERE s2.service_type_id <> $2::uuid
       AND s2.start_time < (SELECT end_time FROM sessions WHERE id = $3::uuid)
       AND s2.end_time > (SELECT start_time FROM sessions WHERE id = $3::uuid)
     LIMIT 1`,
    [booking.id, newSession.service_type_id, newSessionId]
  )
  if (conflict.length > 0) throw refusalOf('CONFLICT', 'time_conflict')

  /** What was paid toward the booking: price_paid without the money owed. */
  const paidToward = round2(booking.pricePaid - booking.refundOwed)
  /** A refund can't give back more than is left on the booking. 0 less, so £0 left is never -0. */
  const settled = (difference: number): number => Math.max(round2(difference), 0 - paidToward)

  if (isPublic && quotes) {
    const legacyPricing = seats.some((seat) => seat.unitPrice === null)
    let passCovers = true
    if (booking.redeemedSessionPassId && seats.some((seat) => seat.payBy === 'session_pass_credit')) {
      // Q34: the pass covers the new session's band and hasn't expired on its date.
      const pass = (
        await db.query<{ covers: boolean }>(
          'SELECT pass_covers_session(pass_type_id, $1::uuid) AND expiry_date >= $2::date AS covers FROM customer_session_passes WHERE id = $3::uuid',
          [newSessionId, newSession.day, booking.redeemedSessionPassId]
        )
      )[0]
      passCovers = pass?.covers === true
    }
    // Q34: the membership that gave the credit covers the new date: active, and not past its last day. A credit seat
    // with no membership named keeps today's rule (the band alone).
    let membershipCovers = true
    if (booking.redeemedMembershipId && seats.some((seat) => seat.payBy === 'membership_credit')) {
      const membership = (
        await db.query<{ covers: boolean }>(
          `SELECT subscription_status = 'active' AND (cancel_effective_date IS NULL OR cancel_effective_date >= $1::date) AS covers
           FROM customer_memberships WHERE id = $2::uuid`,
          [newSession.day, booking.redeemedMembershipId]
        )
      )[0]
      membershipCovers = membership?.covers === true
    }
    const seatDeltas: MovePriceImpact['seatDeltas'] = []
    let rawAmountDue = 0
    for (let i = 0; i < partySize; i += 1) {
      const oldSeat = seats[i]
      const quote = quotes[i]
      if (!oldSeat || !quote) break
      let payBy: 'paid' | 'membership_credit' | 'session_pass_credit' =
        oldSeat.payBy === 'membership_credit' || oldSeat.payBy === 'session_pass_credit' ? oldSeat.payBy : 'paid'
      let creditReleased = false
      if (payBy === 'membership_credit' && (!quote.credit_eligible || !membershipCovers)) {
        payBy = 'paid'
        creditReleased = true
      }
      if (payBy === 'session_pass_credit' && !passCovers) {
        payBy = 'paid'
        creditReleased = true
      }
      const newUnitPrice = Number.parseFloat(quote.unit_price as string)
      const oldUnitPrice = oldSeat.unitPrice
      // A released credit seat was never paid with money (its stored price is only the quote), so it is charged its
      // full new price; a seat already paid settles only the difference.
      const delta = payBy !== 'paid' || oldUnitPrice === null ? 0 : creditReleased ? newUnitPrice : newUnitPrice - oldUnitPrice
      if (payBy === 'paid') rawAmountDue += delta
      seatDeltas.push({ seatNo: quote.seat_no, seatKind: quote.seat_kind, payBy, oldUnitPrice, newUnitPrice, delta, creditReleased })
    }
    // Q28: what is due is never more than the new seats less what was paid toward them and the part refunds.
    if (rawAmountDue > 0) {
      const newPaidSeats = seatDeltas.reduce((total, seat) => (seat.payBy === 'paid' ? total + seat.newUnitPrice : total), 0)
      rawAmountDue = Math.max(Math.min(rawAmountDue, newPaidSeats - paidToward - booking.partRefunded), 0)
    }
    const amountDue = legacyPricing ? 0 : settled(rawAmountDue)
    const priceImpact: MovePriceImpact = { amountDue, refundDue: amountDue < -MOVES, seatDeltas, legacyPricing, customerId: booking.customerId }
    const creditReleased = !legacyPricing && seatDeltas.some((seat) => seat.creditReleased)
    const seatChanges: Priced['seatChanges'] = []
    if (!legacyPricing) {
      for (let i = 0; i < seats.length; i += 1) {
        const seat = seats[i]
        const delta = seatDeltas[i]
        const quote = quotes[i]
        if (!seat || !delta || !quote) continue
        seatChanges.push({ id: seat.id, unitPrice: quote.unit_price as string, payBy: delta.payBy })
      }
    }
    return {
      booking,
      newSession,
      partySize,
      priceImpact,
      newPricePaid: legacyPricing ? null : round2(booking.pricePaid + amountDue),
      newBandId: quotes[0]?.band_id ?? newSession.band_id,
      seatChanges,
      creditReleased,
      passToRelease: creditReleased && !passCovers ? booking.redeemedSessionPassId : null,
    }
  }

  // Private: the new band's tier for the party size, less what was paid toward the booking and the part refunds.
  const tier = (
    await db.query<{ price: string | null }>(
      'SELECT price::text AS price FROM service_type_price_tiers WHERE service_type_id = $1::uuid AND band_id = $2::uuid AND min_people <= $3::int AND max_people >= $3::int LIMIT 1',
      [newSession.service_type_id, newSession.band_id, partySize]
    )
  )[0]
  if (!tier || tier.price === null) throw refusalOf('CONFLICT', 'private_price_not_set', MOVE_WORDS.privatePriceNotSet)
  const amountDue = settled(Number.parseFloat(tier.price) - paidToward - booking.partRefunded)
  return {
    booking,
    newSession,
    partySize,
    priceImpact: { amountDue, refundDue: amountDue < -MOVES, seatDeltas: [], legacyPricing: false, customerId: booking.customerId },
    newPricePaid: round2(booking.pricePaid + amountDue),
    newBandId: newSession.band_id,
    seatChanges: [],
    creditReleased: false,
    passToRelease: null,
  }
}

/** What a press would be refused with now, before any money: a payment still being taken, a refund still being checked. */
async function blockedNow(db: Queryable, booking: LoadedBooking): Promise<ApiError | null> {
  if (paymentOpen(booking)) return paymentOpenRefusal(booking, moveRefusal)
  if (await refundClaimOpen(db, booking.id)) return moveRefusal('CONFLICT', 'refund_open', REFUND_OPEN_MESSAGE)
  return null
}

/**
 * The quote (the dialog's first call): reads only, never refused for a payment still being taken or a refund still
 * being checked (`blocked` says so). For a cheaper move, where the refund can go (Q37): the card(s) that paid, as far
 * as their money is left, the rest to store credit.
 */
export async function quoteMove(db: Queryable, bookingId: string, newSessionId: string): Promise<MoveQuote> {
  const priced = await priceTheMove(db, await loadBooking(db, bookingId), newSessionId)
  const blocked = await blockedNow(db, priced.booking)
  const refund = priced.priceImpact.amountDue < -MOVES ? round2(-priced.priceImpact.amountDue) : 0
  let refundParts: MoveQuote['refundParts'] = null
  if (refund > 0) {
    const plan = await planRefund(db, bookingId, refund, 'card')
    const card = round2(plan.card.reduce((total, part) => total + part.amount, 0))
    refundParts = { card, storeCredit: round2(refund - card) }
  }
  const details = blocked?.details as { reason?: string; message?: string } | undefined
  return {
    priceImpact: priced.priceImpact,
    blocked: blocked ? { reason: details?.reason ?? 'refused', message: details?.message ?? blocked.message } : null,
    cardRefundAvailable: priced.booking.figures.parts.card > 0,
    refundParts,
  }
}

// --- C1 / R1

/** A flow C1 committed: its record, what the card or reader takes, and the booking's new price paid. */
interface FlowStarted {
  pendingId: string
  remainder: number
  pricePaid: number | null
}

type Started =
  | { kind: 'done'; output: MoveBookingOutput }
  | ({ kind: 'card' | 'reader' } & FlowStarted)
  | { kind: 'claim'; claim: Claim; pricePaid: number | null }

/** The new session's places: a private session takes its whole capacity (only when empty), a public one the party. */
async function claimNewPlaces(tx: Tx, newSession: NewSession, partySize: number): Promise<number> {
  const claimed = await tx.query<{ before: number; after: number }>(
    newSession.booking_type === 'private'
      ? `UPDATE sessions s SET total_booked = s.capacity, updated_at = now()
         FROM (SELECT id, total_booked FROM sessions WHERE id = $1::uuid) old
         WHERE s.id = old.id AND s.status = 'open' AND s.total_booked = 0
         RETURNING old.total_booked AS before, s.total_booked AS after`
      : `UPDATE sessions s SET total_booked = s.total_booked + $2::int, updated_at = now()
         FROM (SELECT id, total_booked FROM sessions WHERE id = $1::uuid) old
         WHERE s.id = old.id AND s.status = 'open' AND (s.capacity - s.total_booked) >= $2::int
         RETURNING old.total_booked AS before, s.total_booked AS after`,
    newSession.booking_type === 'private' ? [newSession.id] : [newSession.id, partySize]
  )
  const row = claimed[0]
  if (!row) throw moveRefusal('CONFLICT', 'insufficient_capacity', undefined)
  return Number(row.after) - Number(row.before)
}

/** The old session's places given back, as releaseSessionCapacity did (its own type: a private session back to empty). */
async function releaseOldPlaces(tx: Tx, sessionId: string, partySize: number): Promise<number> {
  const released = await tx.query<{ before: number; after: number }>(
    `UPDATE sessions s
     SET total_booked = CASE WHEN st.booking_type = 'private' THEN 0 ELSE s.total_booked - $2::int END, updated_at = now()
     FROM service_types st, (SELECT id, total_booked FROM sessions WHERE id = $1::uuid) old
     WHERE s.id = old.id AND st.id = s.service_type_id
     RETURNING old.total_booked AS before, s.total_booked AS after`,
    [sessionId, partySize]
  )
  const row = released[0]
  return row ? Number(row.before) - Number(row.after) : 0
}

/** The booking as C1 found it, as the database has it (times as text), for the flow's and the claim's undo. */
interface BookingBefore {
  price_paid: string | null
  start_time: string
  end_time: string
}

interface C1Input {
  bookingId: string
  newSessionId: string
  figures: MoveBookingInput['figures']
  payment: MoveBookingInput['payment']
  refundMethod: string | undefined
}

/**
 * C1 (R1 for a cheaper move), inside its transaction. Every refusal throws, so nothing it did is kept. See the file's
 * header for what each kind of move writes.
 */
async function moveC1(tx: Tx, input: C1Input, options: MoveOptions, keyLivemode: boolean | null): Promise<Started> {
  const { bookingId, newSessionId, payment } = input
  const giftCardId = payment?.giftCard?.giftCardId ?? null
  // The pass a released pass seat would go back to, read before the lock (a booking's pass changes only under it, and
  // a different one is read again below), so it is locked in LOCK_ORDER with the rest.
  const passId = (await tx.query<{ id: string | null }>('SELECT redeemed_session_pass_id AS id FROM bookings WHERE id = $1::uuid', [bookingId]))[0]?.id ?? null
  const loaded = await lockAndLoadBooking(tx, { bookingId, ownSession: true, sessionIds: [newSessionId], sessionPassId: passId, giftCardId })
  const priced = await priceTheMove(tx, loaded?.booking ?? null, newSessionId)
  const { booking, newSession, partySize, priceImpact } = priced
  if (booking.redeemedSessionPassId !== passId) throw new Error(`Booking ${bookingId}'s pass changed while it was being locked.`)
  const amountDue = priceImpact.amountDue
  const withFigures = { priceImpact }

  // The old function's checks before anything moved, in its order, with two new ones first: a payment still being
  // taken (W18a's words) and a refund still being checked (W21's).
  if (paymentOpen(booking)) throw paymentOpenRefusal(booking, moveRefusal)
  if (await refundClaimOpen(tx, bookingId)) throw moveRefusal('CONFLICT', 'refund_open', REFUND_OPEN_MESSAGE)
  const dearer = amountDue > MOVES
  const refund = amountDue < -MOVES ? round2(-amountDue) : 0
  const giftCardAmount = dearer ? partAmount(payment?.giftCard?.amount, 'gift_card_amount_invalid', moveRefusal, withFigures) : 0
  const storeCreditAmount = dearer ? partAmount(payment?.storeCredit?.amount, 'store_credit_amount_invalid', moveRefusal, withFigures) : 0
  const method = payment?.method
  // W25 (W24 review L7): a press is a payment or a refund, never both. The dialog sends a payment method only for a
  // dearer move and a refund method only for a cheaper one; the two together used to be read as a cash-in press.
  if (method && input.refundMethod) {
    throw moveRefusal('VALIDATION', 'payment_and_refund', MOVE_PAYMENT_AND_REFUND_MESSAGE, { ...withFigures, field: 'refundMethod' })
  }
  const remainder = dearer ? Math.max(0, round2(amountDue - giftCardAmount - storeCreditAmount)) : 0
  // Cash first, whatever the difference has become (the old function's order): staff are holding what they confirmed.
  const toCollect = input.figures?.toCollect ?? payment?.confirmedCashAmount
  const cash = cashDifferenceRefusal(method, remainder, toCollect)
  if (cash) throw moveRefusal('CONFLICT', cash.reason, cash.message, withFigures)
  if (dearer) {
    if (exceedsAmount(giftCardAmount, amountDue)) throw moveRefusal('CONFLICT', 'gift_card_amount_exceeds_total', undefined, withFigures)
    if (exceedsAmount(giftCardAmount + storeCreditAmount, amountDue)) throw moveRefusal('CONFLICT', 'store_credit_amount_exceeds_total', undefined, withFigures)
    if (remainder > 0 && !method) throw moveRefusal('CONFLICT', 'payment_method_required', undefined, withFigures)
    // The screen sends the reader only with something left to take, so the amount has changed.
    if (method === 'reader' && remainder <= 0.005) throw moveRefusal('CONFLICT', 'payment_method_required', AMOUNT_CHANGED_MESSAGE, withFigures)
  }
  let refundMethod: 'card' | 'credit' | null = null
  if (refund > 0) {
    if (method === 'reader') throw moveRefusal('CONFLICT', 'payment_method_required', MOVE_WORDS.readerCannotRefund, withFigures)
    if (!input.refundMethod) throw moveRefusal('CONFLICT', 'refund_method_required', undefined, withFigures)
    if (input.refundMethod !== 'card' && input.refundMethod !== 'credit') {
      throw moveRefusal('VALIDATION', 'refund_method_invalid', REFUND_METHOD_WORDS, { ...withFigures, field: 'refundMethod' })
    }
    // A move that refunds the difference is a refund like any other: Issue refunds, before anything changes.
    if (!options.canIssueRefunds) throw moveRefusal('FORBIDDEN', 'no_refund_permission', undefined)
    refundMethod = input.refundMethod
  }
  // The difference has gone to nothing: the reader would start a £0 payment.
  if (method === 'reader' && !dearer && refund === 0) throw moveRefusal('CONFLICT', 'payment_method_required', AMOUNT_CHANGED_MESSAGE, withFigures)
  // The old function took any other method as cash with nothing recorded; New Order's words instead.
  if (remainder > 0 && method !== 'card' && method !== 'reader' && method !== 'cash') {
    throw moveRefusal('VALIDATION', 'invalid_payment_method', ORDER_WORDS['invalid_payment_method'], { ...withFigures, field: 'payment.method' })
  }
  // Q18: the figures staff saw. The card's or reader's remainder first (Q11's words), then the signed amount due (a
  // missing figure counts as £0): money in gets Q11's words, money back the refunds' (D-plan 4.7).
  if (dearer && remainder > 0 && (method === 'card' || method === 'reader')) {
    const changed = amountChangedRefusal(method, { toCollect: input.figures?.toCollect }, { amountDue, toCollect: remainder })
    if (changed) throw moveRefusal('CONFLICT', changed.reason, changed.message, withFigures)
  }
  const sentAmountDue = typeof input.figures?.amountDue === 'number' && Number.isFinite(input.figures.amountDue) ? input.figures.amountDue : 0
  if (differs(sentAmountDue, amountDue)) {
    if (refund > 0) throw moveRefusal('CONFLICT', 'refund_changed', REFUND_WORDS.figuresChanged, withFigures)
    throw moveRefusal('CONFLICT', 'amount_changed', amountChangedToMessage(amountDue), withFigures)
  }

  const cardMoney = remainder > 0 && (method === 'card' || method === 'reader') ? method : null
  let savedCard: { stripe_customer_id: string | null; saved_payment_method_id: string | null } | undefined
  if (cardMoney) {
    savedCard = (
      await tx.query<{ stripe_customer_id: string | null; saved_payment_method_id: string | null }>(
        'SELECT stripe_customer_id, saved_payment_method_id FROM customers WHERE id = $1::uuid',
        [booking.customerId]
      )
    )[0]
    // The legacy charge route's words for a card with nothing saved: nothing is claimed or charged.
    if (cardMoney === 'card' && (!savedCard?.stripe_customer_id || !savedCard.saved_payment_method_id)) {
      throw moveRefusal('CONFLICT', 'no_saved_card', NO_SAVED_CARD_MESSAGE)
    }
  }

  const before = (
    await tx.query<BookingBefore>('SELECT price_paid::text AS price_paid, start_time::text AS start_time, end_time::text AS end_time FROM bookings WHERE id = $1::uuid', [
      bookingId,
    ])
  )[0]
  if (!before) throw new Error(`Booking ${bookingId} is gone under its lock.`)

  // The places: the new session's claimed; the old session's given back now, unless card money is still to come, when
  // the old seat is held until C2 (so an undo never has to take a place back).
  const placesClaimed = await claimNewPlaces(tx, newSession, partySize)
  const placesReleased = cardMoney ? 0 : await releaseOldPlaces(tx, booking.sessionId, partySize)

  // The money parts of a dearer move, in the payment order: store credit, then the gift card.
  if (storeCreditAmount > 0) {
    await claimStoreCredit(tx, { customerId: booking.customerId, amount: storeCreditAmount, bookingId, staffId: options.actor.id, note: MOVE_STORE_CREDIT_NOTE }, moveRefusal, withFigures)
  }
  const stampedRedeemedAt = giftCardAmount > 0 && giftCardId ? await claimGiftCard(tx, giftCardId, giftCardAmount, moveRefusal, withFigures) : false

  // The booking and its seats: the new session, times and band; price_paid moves by exactly what the move settles (a
  // legacy booking keeps it); a released credit clears the booking's credit (its period counts it unused again).
  await tx.query(
    `UPDATE bookings b
     SET session_id = s.id, start_time = s.start_time, end_time = s.end_time,
         price_paid = COALESCE($2::numeric, b.price_paid),
         band_id = $3::uuid,
         credit_period_id = CASE WHEN $4::boolean THEN NULL ELSE b.credit_period_id END,
         redemption_source = CASE WHEN $4::boolean THEN 'paid' ELSE b.redemption_source END,
         redeemed_membership_id = CASE WHEN $4::boolean THEN NULL ELSE b.redeemed_membership_id END,
         redeemed_session_pass_id = CASE WHEN $4::boolean THEN NULL ELSE b.redeemed_session_pass_id END,
         updated_at = now()
     FROM sessions s
     WHERE b.id = $1::uuid AND s.id = $5::uuid`,
    [bookingId, priced.newPricePaid, priced.newBandId, priced.creditReleased, newSessionId]
  )
  if (priced.seatChanges.length > 0) {
    await tx.query(
      `UPDATE booking_guests g SET unit_price = x.unit_price, pay_by = x.pay_by
       FROM unnest($1::uuid[], $2::numeric[], $3::text[]) AS x(id, unit_price, pay_by)
       WHERE g.id = x.id`,
      [priced.seatChanges.map((seat) => seat.id), priced.seatChanges.map((seat) => seat.unitPrice), priced.seatChanges.map((seat) => seat.payBy)]
    )
  }
  // A released pass seat's session goes back to the pass while it is unexpired (releaseSessionPassCredit); with card
  // money still to come, at C2 instead (as the reader always did), so an undo never takes it back.
  let passReturned: string | null = null
  if (priced.passToRelease && !cardMoney) {
    const returned = await tx.query(
      `UPDATE customer_session_passes SET sessions_remaining = sessions_remaining + 1, updated_at = now()
       WHERE id = $1::uuid AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
       RETURNING id`,
      [priced.passToRelease]
    )
    passReturned = returned.length > 0 ? priced.passToRelease : null
  }

  const description = moveDescription(bookingId)
  const pricePaidChange = priced.newPricePaid === null ? 0 : round2(priced.newPricePaid - booking.pricePaid)
  let pendingId: string | null = null
  if (cardMoney) {
    // What the flow's C2 and undo read (W12's finaliseFlowInTransaction / undoFlowInTransaction, 'move'), as the old
    // reader snapshot held it.
    const old = {
      customer_id: booking.customerId,
      description,
      booking_id: bookingId,
      old_session_id: booking.sessionId,
      old_start_time: before.start_time,
      old_end_time: before.end_time,
      old_price_paid: before.price_paid,
      price_paid_change: pricePaidChange,
      old_band_id: booking.bandId,
      old_credit_period_id: booking.creditPeriodId,
      old_redemption_source: booking.redemptionSource ?? 'paid',
      old_redeemed_membership_id: booking.redeemedMembershipId,
      old_redeemed_session_pass_id: booking.redeemedSessionPassId,
      ...(priced.passToRelease ? { release_session_pass_on_finalise: true } : {}),
      seats: booking.seats.map((seat) => ({ id: seat.id, unit_price: seat.unitPrice === null ? '' : seat.unitPrice.toFixed(2), pay_by: seat.payBy })),
      new_session_id: newSessionId,
      new_session_booking_type: (newSession.booking_type === 'private' ? 'private' : 'public') as 'public' | 'private',
      party_size: partySize,
      ...(storeCreditAmount > 0 ? { store_credit_amount: storeCreditAmount } : {}),
      ...(giftCardAmount > 0 && giftCardId ? { gift_card: { gift_card_id: giftCardId, amount: giftCardAmount, stamped_redeemed_at: stampedRedeemedAt } } : {}),
    }
    const marks = { channel: 'staff' as const, request_id: options.requestId, livemode: keyLivemode === true }
    const snapshot: CardFlowSnapshot | ReaderFlowSnapshot =
      cardMoney === 'card'
        ? { ...old, ...marks, method: 'card', stripe_customer_id: savedCard?.stripe_customer_id as string, payment_method_id: savedCard?.saved_payment_method_id as string }
        : { ...old, ...marks, method: 'reader', stripe_customer_id: savedCard?.stripe_customer_id ?? null }
    // The record last, before anything is asked of Stripe (bug 14's rule): its id is every key of the flow.
    pendingId = await writeFlowRecord(tx, { flow: 'move', recordId: bookingId, expectedAmount: remainder, snapshot })
  } else if (giftCardAmount > 0 && giftCardId) {
    // The gift card part in the card's history, as today: this booking, no order (Q36). On a flow, C2 writes it.
    await tx.query(
      'INSERT INTO gift_card_redemptions (gift_card_id, order_id, booking_id, amount_used, redeemed_at) VALUES ($1::uuid, NULL, $2::uuid, $3::numeric, now())',
      [giftCardId, bookingId, giftCardAmount]
    )
  }

  const answer = (pricePaid: number | null): MoveBookingOutput => ({ moved: true, booking: { id: bookingId, price_paid: pricePaid } })
  if (refund > 0 && refundMethod) {
    // A cheaper move: the refund planned (card parts against the booking's orders newest first, the rest to store
    // credit) and claimed, with what R1 changed so the undo after a refused first part puts it all back. Its own row
    // (`booking.move`) is R2's, once the money's fate is known.
    const plan = await planRefund(tx, bookingId, refund, refundMethod)
    const move: MoveClaim = {
      oldSessionId: booking.sessionId,
      newSessionId,
      oldStartTime: before.start_time,
      oldEndTime: before.end_time,
      oldBandId: booking.bandId,
      oldCreditPeriodId: booking.creditPeriodId,
      oldRedemptionSource: booking.redemptionSource,
      oldRedeemedMembershipId: booking.redeemedMembershipId,
      oldRedeemedSessionPassId: booking.redeemedSessionPassId,
      seats: booking.seats.map((seat) => ({ id: seat.id, unitPrice: seat.unitPrice === null ? null : seat.unitPrice.toFixed(2), payBy: seat.payBy })),
      placesClaimed,
      placesReleased,
      passReturned,
      creditReleased: priced.creditReleased,
    }
    const details: ClaimDetails = {
      kind: 'move',
      amount: refund,
      pricePaidBefore: booking.pricePaid,
      method: refundMethod,
      reason: null,
      worker: true,
      plan,
      livemode: plan.card.length > 0 ? keyLivemode : null,
      move,
    }
    const claim = await writeClaim(tx, bookingId, details, options)
    if (plan.card.length > 0) return { kind: 'claim', claim, pricePaid: priced.newPricePaid }
    const output = await finishClaimInTransaction(tx, claim, { went: [], extraToStoreCredit: 0, owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
    if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
    return { kind: 'done', output: { ...answer(output.pricePaid ?? priced.newPricePaid), ...(output.warning ? { warning: output.warning } : {}) } }
  }

  await audit.record(tx, {
    actorType: options.actor.type,
    actorId: options.actor.id,
    action: BOOKING_MOVED,
    entityType: 'booking',
    entityId: bookingId,
    requestId: options.requestId,
    details: moveRowDetails({
      oldSessionId: booking.sessionId,
      newSessionId,
      amountDue,
      storeCredit: storeCreditAmount,
      giftCard: giftCardAmount,
      method: remainder > 0 ? (method ?? null) : null,
      toCollect: remainder,
      refundMethod: null,
      cardRefunded: 0,
      storeCreditRefunded: 0,
      owed: 0,
      pendingId,
      creditReleased: priced.creditReleased,
      passReleased: passReturned ?? (cardMoney ? priced.passToRelease : null),
      legacyPricing: priceImpact.legacyPricing,
    }),
  })
  if (cardMoney && pendingId) return { kind: cardMoney, pendingId, remainder, pricePaid: priced.newPricePaid }
  return { kind: 'done', output: answer(priced.newPricePaid) }
}

/** The trigger's words for a second booking on the day (enforce_one_booking_per_customer_day). */
const DUPLICATE_DAY_TEXT = 'This customer already has a booking on'

/**
 * C1 rolled back: a refusal Postgres raised is answered with Move's own reason and words (N1: the one-booking-a-day
 * trigger, should another booking have raced past the check, never shown raw; the overlap constraint, the old
 * time_conflict); anything else is the plain "not saved" words: nothing was moved, taken or refunded.
 */
function notSaved(logDetail: string, err: unknown): ApiError {
  const refused = postgresRefusal(err)
  if (refused?.constraint === 'bookings_no_cross_session_overlap') return moveRefusal('CONFLICT', 'time_conflict', undefined, { logDetail })
  if (refused?.code === 'P0001' && refused.message.startsWith(DUPLICATE_DAY_TEXT)) {
    return moveRefusal('CONFLICT', 'duplicate_day_booking', ORDER_WORDS['duplicate_day_booking'], { logDetail })
  }
  return moveRefusal('INTERNAL', 'move_not_saved', MOVE_NOT_SAVED_MESSAGE, { logDetail })
}

/** The saved card: charged once, then C2 or the undo; anything unclear held (flow.ts, settleCardFlow). */
async function chargeAndFinish(db: Db, stripe: StripeClient, bookingId: string, started: FlowStarted, options: MoveOptions, startedAt: number): Promise<MoveBookingOutput> {
  const outcome = await settleCardFlow(db, stripe, started.pendingId, {
    actor: options.actor,
    requestId: options.requestId,
    timing: { deadline: startedAt + COLLECT_DEADLINE_MS, now: options.now ?? Date.now },
  })
  if (outcome.outcome === 'finished') return { moved: true, booking: { id: bookingId, price_paid: started.pricePaid } }
  if (outcome.outcome === 'declined') {
    // Nothing was taken, and the move was undone. The old function answered card_charge_failed; the charge's own words now.
    const reason = outcome.needsAuthentication ? 'card_needs_authentication' : 'card_charge_failed'
    const message = outcome.undone ? outcome.message : `${outcome.message} ${MOVE_NOT_UNDONE_MESSAGE}`
    throw moveRefusal(outcome.needsAuthentication ? 'PAYMENT_NEEDS_AUTHENTICATION' : 'PAYMENT_FAILED', reason, message, {
      pendingId: started.pendingId,
      logDetail: `${outcome.stripeCode ?? 'no code'}; undone: ${String(outcome.undone)}`,
    })
  }
  if (outcome.outcome === 'held') throw moveRefusal('PAYMENT_UNCONFIRMED', outcome.reason, outcome.message, { pendingId: started.pendingId, logDetail: outcome.detail })
  throw new Error(`The card flow ${started.pendingId} wasn't open straight after C1 (${outcome.state}).`)
}

/** The reader, pending-first (W12-7): the intent under the record's key, written onto the record; the screen collects. */
async function startOnTheReader(db: Db, stripe: StripeClient, bookingId: string, started: FlowStarted, options: MoveOptions, startedAt: number): Promise<MoveBookingOutput> {
  const timing = stripeTiming(startedAt, options.now ?? Date.now)
  const row = await readFlow(db, started.pendingId)
  if (!row) throw new Error(`The reader flow ${started.pendingId} is gone straight after C1.`)
  const answer = await createFlowReaderIntent(db, stripe, row, timing)
  const held = (detail: string) => moveRefusal('PAYMENT_UNCONFIRMED', 'payment_unconfirmed', FLOW_INTENT_UNCONFIRMED_MESSAGE, { pendingId: started.pendingId, logDetail: detail })

  if (answer.outcome === 'definite') {
    // No intent exists, so nothing can be taken: the flow's undo puts the booking back, in one transaction.
    let undone = false
    try {
      const result = await undoFlowInTransaction(db, started.pendingId, { actor: options.actor, requestId: options.requestId, why: `The card reader payment couldn't be started. ${answer.detail}` })
      undone = result.undone || result.reason !== 'already_finalised'
    } catch {
      undone = false
    }
    const message = undone ? moveReaderSetupFailedMessage(answer.message) : moveReaderNotStartedNotUndoneMessage(answer.message)
    throw moveRefusal('PAYMENT_FAILED', 'move_failed', message, { pendingId: started.pendingId, logDetail: answer.detail })
  }
  if (answer.outcome === 'unknown') throw held(`The reader's intent got no clear answer: ${answer.detail}`)

  const { paymentIntent, stripeCustomerId } = answer
  const clientSecret = paymentIntent.client_secret
  let recorded: boolean
  try {
    recorded = Boolean(clientSecret) && (await recordFlowIntent(db, started.pendingId, paymentIntent, stripeCustomerId))
  } catch (err) {
    throw held(`${paymentIntent.id} could not be written onto the record: ${explain(err)}`)
  }
  if (!recorded || !clientSecret) throw held(`${paymentIntent.id} was not written onto the record (no secret, or the record changed)`)
  return {
    moved: true,
    booking: { id: bookingId, price_paid: started.pricePaid },
    pendingReaderPayment: { flow: 'move', recordId: bookingId, pendingId: started.pendingId, paymentIntentId: paymentIntent.id, clientSecret, amount: started.remainder },
  }
}

/**
 * moveBooking's press. Without `confirmed`, the quote and nothing moved (the old first call). Otherwise C1 (or R1),
 * then the saved card or the reader for card money, or the card refunds for a cheaper move to the card.
 */
export async function moveBooking(db: Db, bookingId: string, input: MoveBookingInput, options: MoveOptions): Promise<MoveBookingOutput> {
  if (input.confirmed !== true) return { moved: false, quote: await quoteMove(db, bookingId, input.newSessionId) }
  const startedAt = options.startedAt ?? (options.now ?? Date.now)()
  const method = input.payment?.method
  // Made before C1, so a payment or a card refund is never left held with no way to reach Stripe.
  const needsStripe = method === 'card' || method === 'reader' || input.refundMethod === 'card'
  const stripe = needsStripe ? options.stripe?.() : undefined
  if (needsStripe && !stripe) throw new Error('A move on the card or reader, or refunding to the card, needs a Stripe client.')
  const c1Input: C1Input = { bookingId, newSessionId: input.newSessionId, figures: input.figures, payment: input.payment, refundMethod: input.refundMethod }
  const started = await inC1(db, (tx) => moveC1(tx, c1Input, options, stripe?.keyLivemode ?? null), notSaved)
  if (started.kind === 'done') return started.output
  if (!stripe) throw new Error('A card or reader move, or a card refund, needs a Stripe client.')
  if (started.kind === 'card') return chargeAndFinish(db, stripe, bookingId, started, options, startedAt)
  if (started.kind === 'reader') return startOnTheReader(db, stripe, bookingId, started, options, startedAt)
  if (started.kind !== 'claim') throw new Error(`A move started as ${started.kind}.`)
  // A cheaper move to the card: each card part once, then R2. The first refused undoes the move exactly.
  const firstRefused = (detail: string): ApiError => moveRefusal('PAYMENT_FAILED', 'refund_failed', moveRefundFailedMessage(detail))
  const output = await sendAndFinish(db, stripe, started.claim, options, stripeTiming(startedAt, options.now ?? Date.now), firstRefused)
  return {
    moved: true,
    booking: { id: bookingId, price_paid: output.pricePaid ?? started.pricePaid },
    ...(output.warning ? { warning: output.warning } : {}),
    ...(output.held ? { held: output.held } : {}),
  }
}
