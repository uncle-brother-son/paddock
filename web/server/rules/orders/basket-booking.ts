// Ported from backend/paddock/createBooking.ts and the booking parts of createOrder.ts (reads only;
// the writes move in W06).
import 'server-only'
import type { BasketBooking, BasketProblem, BasketSeat, PromoEligibleLine } from '@/contracts'
import { GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE, MAX_GUESTS_PER_PRIVATE_BOOKING, MAX_GUESTS_PER_PUBLIC_BOOKING, validateGuests } from './guest-validation'
import type { BasketFacts, BasketSeatFacts } from './load-basket'

export const GIFT_CARD_SOURCE_REMOVED_MESSAGE = 'Gift Card is no longer a booking option. Choose Paid and apply the gift card at payment.'

type PayBy = BasketSeat['payBy']

export interface PricedBooking {
  seats: BasketSeat[]
  /** Sum of the seats paid with money: credit-covered seats are left out. */
  price: number
  recordedSource: PayBy
  /** What a promo can discount: the paid seats in order, keyed `seat:<seat number>`, or a private booking's one `booking` line. */
  promoLines: PromoEligibleLine[]
}

const money = (value: string): number => Number.parseFloat(value)

/** How seat 1 is covered. Guests always pay the full band price. */
function seat1Cover(source: string, seat1: BasketSeatFacts | undefined): PayBy {
  if (source === 'session_pass_credit' || source === 'buy_new_session_pass') return 'session_pass_credit'
  if (source === 'membership_credit' || source === 'buy_new_membership') return seat1?.credit_eligible ? 'membership_credit' : 'paid'
  return 'paid'
}

/**
 * Seat 1 as it will be once the new membership exists: createBooking quotes after writing it, so
 * quote_booking gives the new plan's terms, which plan_seat_terms gives before it exists.
 */
function quotedSeats(booking: BasketBooking, facts: BasketFacts): BasketSeatFacts[] {
  const seats = facts.session?.seats ?? []
  const planSeat = facts.session?.plan_seat
  const [seat1, ...guests] = seats
  if (booking.redemptionSource !== 'buy_new_membership' || !seat1 || !planSeat) return seats
  return [{ ...seat1, ...planSeat }, ...guests]
}

/**
 * The promo's lines. Normal flow: one per money-paid seat, where a seat below the band's list price
 * is a member-discounted account-holder seat. Buy-new flow (W03 Q6: the server's rule is kept): the
 * paid seats priced up front, with a paid seat 1 always counted as member-priced. A private booking
 * has no seat prices: see privatePromoLine.
 */
function promoLines(seats: BasketSeat[], buysNew: boolean, bandListPrice: string | null): PromoEligibleLine[] {
  const lines: PromoEligibleLine[] = []
  for (const seat of seats) {
    const amount = seat.unitPrice
    if (seat.payBy !== 'paid' || amount === null || !(amount > 0.005)) continue
    const memberPriced = buysNew
      ? seat.seatNo === 1
      : seat.kind === 'account_holder' && bandListPrice !== null && amount < money(bandListPrice) - 0.005
    lines.push({ key: `seat:${seat.seatNo}`, itemType: 'booking', amount, isMemberPriced: memberPriced })
  }
  return lines
}

/** W03-decisions Q24: one line for the whole private price, which is never a member price. */
function privatePromoLine(price: number): PromoEligibleLine[] {
  return price > 0.005 ? [{ key: 'booking', itemType: 'booking', amount: price, isMemberPriced: false }] : []
}

export function priceBooking(booking: BasketBooking, facts: BasketFacts): PricedBooking {
  const session = facts.session
  const source = booking.redemptionSource
  const buysNew = source === 'buy_new_membership' || source === 'buy_new_session_pass'

  if (session?.booking_type === 'private') {
    const tierPrice = session.private_tier?.price
    const price = tierPrice ? money(tierPrice) : 0
    const seats = booking.guests.map((_, i): BasketSeat => ({
      seatNo: i + 1,
      kind: i === 0 ? 'account_holder' : 'guest',
      payBy: 'paid',
      listPrice: null,
      unitPrice: null,
      discountPercent: 0,
      creditEligible: false,
      discount: 0,
    }))
    return { seats, price, recordedSource: 'paid', promoLines: privatePromoLine(price) }
  }

  const quoted = quotedSeats(booking, facts)
  const cover = seat1Cover(source, quoted[0])
  const seats = quoted.map((seat): BasketSeat => ({
    seatNo: seat.seat_no,
    kind: seat.seat_kind,
    payBy: seat.seat_no === 1 ? cover : 'paid',
    listPrice: money(seat.list_price),
    unitPrice: money(seat.unit_price),
    discountPercent: money(seat.discount_percent),
    creditEligible: seat.credit_eligible,
    discount: 0,
  }))
  const price = seats.reduce((sum, seat) => (seat.payBy === 'paid' ? sum + (seat.unitPrice ?? 0) : sum), 0)
  return { seats, price, recordedSource: cover, promoLines: promoLines(seats, buysNew, session?.band_list_price ?? null) }
}

function refusal(reason: string, extra: Pick<BasketProblem, 'message' | 'guestIndex'> = {}): BasketProblem {
  return { stage: 'booking', reason, bookingFailureReason: reason, ...extra }
}

/** What createBooking would refuse with, in its order. Null when the booking can go ahead. */
export function bookingProblem(booking: BasketBooking, facts: BasketFacts): BasketProblem | null {
  const session = facts.session
  if (!session) return refusal('session_not_found')
  if (session.status !== 'open') return refusal('session_blocked')
  if (session.started) return refusal('session_already_started')

  const isPublic = session.booking_type === 'public'
  const maxGuests = isPublic ? MAX_GUESTS_PER_PUBLIC_BOOKING : MAX_GUESTS_PER_PRIVATE_BOOKING
  const guests = validateGuests(booking.guests, maxGuests, booking.guestsOver18Confirmed === true, facts.today)
  if (guests) {
    return refusal(guests.reason, {
      ...(guests.reason === 'guests_over_18_not_confirmed' ? { message: GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE } : {}),
      ...(guests.guestIndex !== undefined ? { guestIndex: guests.guestIndex } : {}),
    })
  }

  const source = booking.redemptionSource
  if (!['paid', 'membership_credit', 'session_pass_credit', 'buy_new_membership', 'buy_new_session_pass'].includes(source)) {
    return refusal('invalid_redemption_source')
  }

  if (source === 'membership_credit') {
    if (!booking.membershipId) return refusal('membership_id_required')
    const membership = facts.membership_credit
    if (!membership) return refusal('membership_not_found')
    if (!(membership.is_unlimited || (membership.credits_remaining ?? 0) > 0)) return refusal('insufficient_membership_credit')
  }
  if (source === 'session_pass_credit') {
    if (!booking.sessionPassId) return refusal('session_pass_id_required')
    const pass = facts.pass_credit
    if (!pass) return refusal('session_pass_not_found')
    if (pass.sessions_remaining < 1 || pass.expiry_date < facts.today) return refusal('insufficient_session_pass_credit')
  }

  if (session.time_conflict) return refusal('time_conflict')

  if (isPublic) {
    if (!session.seats) return refusal('band_unpriced')
  } else {
    if (!session.private_tier) return refusal('private_price_not_set')
    if (session.private_tier.price === null) return refusal('price_pending')
  }

  if (session.duplicate_day) return refusal('duplicate_day_booking')

  // A private session is exclusive: the first booking claims all of it.
  const hasRoom = isPublic ? session.capacity - session.total_booked >= booking.guests.length : session.total_booked === 0
  if (!hasRoom) return refusal('insufficient_capacity')

  // Checked when the credit is claimed, so last. A new pass was checked against the session already.
  if (source === 'session_pass_credit' && facts.pass_credit && !facts.pass_credit.covers_session) {
    return refusal('session_pass_not_valid_for_band', {
      message: session.band_id
        ? "This is a Core pass, which can't be used for Peak sessions. Choose another way to pay."
        : "This session has no time band set, so a pass can't be used. Set the session's band or choose another way to pay.",
    })
  }
  return null
}
