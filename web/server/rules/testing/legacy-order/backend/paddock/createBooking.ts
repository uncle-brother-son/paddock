import {
  findUsableMembershipCreditPeriod,
  reserveSessionPassCredit,
  releaseSessionPassCredit,
} from '@retool-app/backend/paddock/shared/creditRedemption'
import {
  validateGuests,
  GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE,
  MAX_GUESTS_PER_PUBLIC_BOOKING,
  MAX_GUESTS_PER_PRIVATE_BOOKING,
  type GuestInput,
  type GuestValidationReason,
} from '@retool-app/backend/paddock/shared/guestValidation'
import { claimSessionCapacity, releaseSessionCapacity } from '@retool-app/backend/paddock/shared/sessionCapacity'
import { quoteSeats, findDuplicateDayBooking, type BandSeatQuote } from '@retool-app/backend/paddock/shared/bandPricing'
import { londonToday } from '@retool-app/backend/paddock/shared/londonTime'
import { resolveStaffId } from '@retool-app/backend/paddock/shared/resolveStaffId'

export type RedemptionSource = 'paid' | 'membership_credit' | 'session_pass_credit'

const VALID_REDEMPTION_SOURCES: RedemptionSource[] = [
  'paid',
  'membership_credit',
  'session_pass_credit',
]

export const GIFT_CARD_SOURCE_REMOVED_MESSAGE =
  'Gift Card is no longer a booking option. Choose Paid and apply the gift card at payment.'

/** 'gift_card' charged nothing and needed no gift card. A gift card now pays for a booking the
 *  normal way, as a payment part, so this old value is refused with its own explanation. */
export function isRemovedRedemptionSource(source: string | null | undefined): boolean {
  return source === 'gift_card'
}

export interface CreateBookingParams {
  sessionId: string
  customerId: string
  /**
   * One row per attendee (1-6 for a public session, 1-10 for a private one) — this is now the
   * sole source of the booking's headcount (party_size is derived as guests.length), replacing a
   * manually-typed party size. Quote seat N is written against guests[N-1]: seat 1 (the account
   * holder, priced with the membership terms quote_booking applies) is recorded as the
   * 'account_holder' guest row, every other seat as an additional guest.
   */
  guests: GuestInput[]
  redemptionSource: RedemptionSource
  /** Required when redemptionSource is 'membership_credit' — the specific membership to draw a session credit from. */
  membershipId?: string
  /** Required when redemptionSource is 'session_pass_credit' — the specific pass to draw a session from. */
  sessionPassId?: string
  /** Optional free-text special requests for the booking (the account holder) — e.g. dietary or
   *  accessibility needs. Trimmed; stored as NULL when empty. Max 500 characters (enforced by
   *  truncation here and by the checkout UI's counter). */
  specialRequests?: string
  /** "Everyone else in this booking is 18 or over" — required true whenever guests has more than
   *  the account holder (row 1). Guests give no date of birth. */
  guestsOver18Confirmed?: boolean
}

export type CreateBookingFailureReason =
  | 'session_not_found'
  | 'session_blocked'
  | 'session_already_started'
  | 'time_conflict'
  | 'duplicate_day_booking'
  | 'insufficient_capacity'
  | 'price_pending'
  | 'private_price_not_set'
  | 'band_unpriced'
  | 'invalid_redemption_source'
  | 'gift_card_source_removed'
  | 'membership_id_required'
  | 'session_pass_id_required'
  | 'membership_not_found'
  | 'session_pass_not_found'
  | 'insufficient_membership_credit'
  | 'insufficient_session_pass_credit'
  /** The pass is usable but its level doesn't cover this session (a Core pass on a Peak session). */
  | 'session_pass_not_valid_for_band'
  | 'private_booking_requires_real_payment'
  | GuestValidationReason

export interface CreateBookingResult {
  created: boolean
  reason?: CreateBookingFailureReason
  /** Staff-facing text for reasons that carry one (currently session_pass_not_valid_for_band). */
  message?: string
  guestIndex?: number
  booking?: Record<string, unknown>
  /** How seat 1 (the account holder) ended up covered — callers tracking credit usage need this,
   *  since a quote-marked credit seat can fall back to paid at claim time without failing the
   *  booking. When seat 1 is covered by a membership credit, the booking row also carries the
   *  credit_period_id of the period it drew from. */
  seat1PayBy?: 'paid' | 'membership_credit' | 'session_pass_credit'
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
  /** True when the session has already started (or is in the past) — start_time is stored as
   *  London wall-clock labelled UTC, so it's compared like for like against London wall-clock
   *  now, never against raw now(). */
  started: boolean
}

interface PriceTier {
  price: string | null
}

/**
 * How each seat of a public booking is covered:
 *  - Every guest seat is always paid with money at the full band price (quote_booking's guest
 *    unit_price) — guests are never covered by a credit.
 *  - Seat 1 (the account holder) is covered by a membership credit only when its quote row has
 *    credit_eligible = true AND the selected membership has credit available in its CURRENT
 *    credit period (membership_current_credits: unlimited, or credits_remaining > 0). Otherwise
 *    it is paid at its (discounted) unit_price. Session-pass credits still cover seat 1 only,
 *    exactly as before.
 */
function seatUsesCredit(quote: BandSeatQuote, redemptionSource: RedemptionSource): 'membership_credit' | 'session_pass_credit' | null {
  if (quote.seat_kind !== 'account_holder') return null
  if (redemptionSource === 'membership_credit') return quote.credit_eligible ? 'membership_credit' : null
  if (redemptionSource === 'session_pass_credit') return 'session_pass_credit'
  return null
}

/** The work itself, for functions that have already refused an inactive account at their start,
 *  so nothing new can fail in the middle of their payment flow. */
export async function createBookingUnguarded(
  req: { params: CreateBookingParams; user: User }
): Promise<CreateBookingResult> {
  const { sessionId, customerId, guests, redemptionSource, membershipId, sessionPassId } = req.params

  if (isRemovedRedemptionSource(redemptionSource)) {
    return { created: false, reason: 'gift_card_source_removed', message: GIFT_CARD_SOURCE_REMOVED_MESSAGE }
  }

  // Resolved before guest validation so the correct attendee cap (6 for public, 10 for private)
  // can be applied — the cap is a real business rule tied to the session's booking_type, not a
  // flat number every booking shares.
  const sessionLookup = await paddockData.query<SessionInfo>(
    `SELECT s.id, s.start_time, s.end_time, s.capacity, s.total_booked, s.status, s.service_type_id, s.band_id, st.booking_type,
            (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS started
     FROM sessions s
     JOIN service_types st ON st.id = s.service_type_id
     WHERE s.id = $1`,
    [sessionId]
  )
  const session = sessionLookup.data[0]
  if (!session) {
    return { created: false, reason: 'session_not_found' }
  }
  if (session.status !== 'open') {
    return { created: false, reason: 'session_blocked' }
  }
  if (session.started) {
    return { created: false, reason: 'session_already_started' }
  }

  const maxGuestsForBooking =
    session.booking_type === 'public' ? MAX_GUESTS_PER_PUBLIC_BOOKING : MAX_GUESTS_PER_PRIVATE_BOOKING
  const guestValidation = validateGuests(guests ?? [], maxGuestsForBooking, req.params.guestsOver18Confirmed === true)
  if (!guestValidation.valid) {
    return {
      created: false,
      reason: guestValidation.reason ?? 'no_guests',
      ...(guestValidation.reason === 'guests_over_18_not_confirmed' ? { message: GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE } : {}),
      ...(guestValidation.guestIndex !== undefined ? { guestIndex: guestValidation.guestIndex } : {}),
    }
  }
  const partySize = guests.length
  // Recorded on the booking when the 18+ tick was given (any attendee besides the account
  // holder) — a constant SQL expression, so the inserts' placeholder numbering is untouched.
  const guestsOver18ConfirmedSql = partySize > 1 ? 'now()' : 'NULL'

  if (!VALID_REDEMPTION_SOURCES.includes(redemptionSource)) {
    return { created: false, reason: 'invalid_redemption_source' }
  }

  // Private bookings are always paid with real money — card, cash, or gift card — never a
  // credit redemption of any kind, and never stacking multiple credits together. Membership and
  // session-pass credits (existing or newly purchased) can only ever be redeemed against public
  // bookings. Enforced here server-side since this is a real policy rule, not just a UI nicety.
  if (session.booking_type === 'private' && (redemptionSource === 'membership_credit' || redemptionSource === 'session_pass_credit')) {
    return { created: false, reason: 'private_booking_requires_real_payment' }
  }

  // All four remaining reads are independent of one another (each depends only on values already
  // known), so they run in ONE parallel stage — cutting the booking's latency by ~3 round trips.
  // Their RESULTS are still evaluated below in the original order (credit validation → conflict →
  // price → duplicate-day), so failure precedence and every reason code are unchanged. These are
  // all plain reads; nothing is reserved or claimed here.
  const membershipValidation =
    redemptionSource === 'membership_credit' && membershipId
      ? paddockData.query<{ id: string; period_id: string | null; is_unlimited: boolean; credits_remaining: number | null }>(
          `SELECT cm.id, mcc.period_id, mcc.is_unlimited, mcc.credits_remaining
           FROM customer_memberships cm
           LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
           WHERE cm.id = $1 AND cm.customer_id = $2 AND cm.subscription_status = $3
             AND (cm.cancel_effective_date IS NULL OR cm.cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)`,
          [membershipId, customerId, 'active']
        )
      : null
  const passValidation =
    redemptionSource === 'session_pass_credit' && sessionPassId
      ? paddockData.query<{ id: string; sessions_remaining: number; expiry_date: string }>(
          'SELECT id, sessions_remaining, expiry_date FROM customer_session_passes WHERE id = $1 AND customer_id = $2',
          [sessionPassId, customerId]
        )
      : null
  let quoteError: unknown = null
  const [conflictCheck, quoteOrTier, duplicateCheck] = await Promise.all([
    // Cross-service-type conflict pre-check. Sessions are generated independently per service
    // type (each has its own duration, so its own time grid), but the venue itself is one shared,
    // exclusive resource: a private booking must block every other service type's session at an
    // overlapping time, and a public booking must block private sessions at an overlapping time
    // (other public bookings on the SAME session are fine — that's normal capacity-sharing). This
    // pre-check gives a fast, clean rejection in the common case, but it is NOT what actually
    // guarantees correctness — it's a plain SELECT before the write, so two concurrent requests
    // for different overlapping sessions can both pass it before either has committed. The real
    // guarantee is the `bookings_no_cross_session_overlap` exclusion constraint on the bookings
    // table, which Postgres enforces atomically at insert time regardless of request timing —
    // this check is just an optimization to avoid claiming capacity and attempting an insert we
    // already know will fail.
    paddockData.query<{ id: string }>(
      `SELECT s2.id
       FROM sessions s2
       JOIN bookings b2 ON b2.session_id = s2.id AND b2.status IN ('confirmed', 'pending', 'payment_needed')
       WHERE s2.service_type_id != $1
         AND s2.start_time < $2
         AND s2.end_time > $3
       LIMIT 1`,
      [session.service_type_id, session.end_time, session.start_time]
    ),
    session.booking_type === 'public'
      ? quoteSeats(sessionId, customerId, partySize).catch((err) => {
          quoteError = err
          return []
        })
      : paddockData.query<PriceTier>(
          `SELECT price, (price IS NOT NULL) AS priced FROM service_type_price_tiers
           WHERE service_type_id = $1 AND band_id = $2 AND min_people <= $3 AND max_people >= $4
           LIMIT 1`,
          [session.service_type_id, session.band_id, partySize, partySize]
        ),
    findDuplicateDayBooking(customerId, session.start_time),
  ])

  // Evaluate the parallel reads' results in the original order.

  // Validate (but do not yet reserve) the specific credit source up front, before we claim
  // session capacity — reservation happens later, right before the INSERT, so a failure between
  // here and there doesn't leave a claimed credit with no booking to show for it.
  if (redemptionSource === 'membership_credit') {
    if (!membershipId) return { created: false, reason: 'membership_id_required' }
    const membership = (await membershipValidation)?.data[0]
    if (!membership) return { created: false, reason: 'membership_not_found' }
    // Usable means: the membership's CURRENT credit period exists and is unlimited or still has
    // unspent credit (usage is counted from non-cancelled bookings in that period — never the
    // legacy counter).
    if (!(membership.is_unlimited || (membership.credits_remaining ?? 0) > 0)) {
      return { created: false, reason: 'insufficient_membership_credit' }
    }
  }
  if (redemptionSource === 'session_pass_credit') {
    if (!sessionPassId) return { created: false, reason: 'session_pass_id_required' }
    const pass = (await passValidation)?.data[0]
    if (!pass) return { created: false, reason: 'session_pass_not_found' }
    // Valid through its expiry date (London).
    if (pass.sessions_remaining < 1 || pass.expiry_date.slice(0, 10) < londonToday()) {
      return { created: false, reason: 'insufficient_session_pass_credit' }
    }
  }

  if (conflictCheck.data.length > 0) {
    return { created: false, reason: 'time_conflict' }
  }

  // Resolve the price per seat from the already-fetched quote/tier (see the parallel stage above).
  // Public pricing is band-based: every seat is priced by quote_booking (the band itself comes
  // from the session's band_id, assigned by the sessions_assign_band trigger — never computed
  // here). Private pricing is unchanged: whichever headcount tier matches the party size.
  let seatQuotes: BandSeatQuote[] | null = null
  let priceToRecord: number | null = null
  let seat1PayBy: 'paid' | 'membership_credit' | 'session_pass_credit' = 'paid'
  // What is actually recorded on the booking row: when a membership-credit request ends up with
  // seat 1 paid (quote not credit-eligible, or the guarded INSERT found no credit left), the
  // booking must be stored as 'paid' with no redeemed membership — otherwise cancel/refund
  // flows would treat money-paid seats as credit-covered.
  let bookingRedemptionSource: RedemptionSource = redemptionSource
  const redeemedMembershipId: string | null = redemptionSource === 'membership_credit' ? membershipId ?? null : null
  if (session.booking_type === 'public') {
    if (quoteError !== null) {
      return { created: false, reason: 'band_unpriced' }
    }
    seatQuotes = quoteOrTier as BandSeatQuote[]
    // Seat 1 uses a membership credit only when the quote marks it credit-eligible AND the
    // selected membership still has credit in its current period (claimed atomically by the
    // guarded booking INSERT below). Otherwise — including when staff chose 'paid', or a session
    // pass isn't in play — it is paid at its unit_price.
    const seat1 = seatQuotes[0]!
    seat1PayBy = seatUsesCredit(seat1, redemptionSource) ?? 'paid'
    if (seat1PayBy === 'session_pass_credit' && !sessionPassId) {
      return { created: false, reason: 'session_pass_id_required' }
    }
    if (redemptionSource === 'membership_credit' && seat1PayBy !== 'membership_credit') {
      // The quote says seat 1 is not credit-eligible (e.g. a Core member in a Peak session), so
      // nothing credit-based is left in this booking: record it as a plain paid booking rather
      // than carrying a membership_credit source with no credit behind it.
      bookingRedemptionSource = 'paid'
    }
    // price_paid is the sum of seats actually paid with money — credit-covered seats are excluded.
    priceToRecord = seatQuotes.reduce(
      (sum, seat) => (seat.seat_no === 1 && seat1PayBy !== 'paid' ? sum : sum + Number.parseFloat(seat.unit_price)),
      0
    )
  } else {
    const tierRows = (quoteOrTier as { data: Array<PriceTier & { priced: boolean }> }).data
    const tier = tierRows[0]
    if (!tier) {
      // No tier row covers this group size and the session's band — staff must add one in the
      // catalog (a row that exists but has no price yet falls through to 'price_pending' below).
      return { created: false, reason: 'private_price_not_set' }
    }
    priceToRecord = tier.price === null ? null : Number.parseFloat(tier.price)
  }

  if (priceToRecord === null) {
    return { created: false, reason: 'price_pending' }
  }

  // Optional special requests: trimmed, NULL when empty. Belongs to the booking (the account
  // holder), never to individual guests.
  const specialRequests = typeof req.params.specialRequests === 'string' && req.params.specialRequests.trim() !== ''
    ? req.params.specialRequests.trim().slice(0, 500)
    : null

  // One active booking (pending / confirmed / payment_needed) per customer per London calendar
  // day — pre-checked here so the UI can show a plain message before taking payment; the
  // bookings_one_per_customer_day trigger remains the atomic backstop.
  if (duplicateCheck) {
    return { created: false, reason: 'duplicate_day_booking' }
  }

  // Atomically claim capacity: for a public session this re-checks and reserves per-attendee
  // capacity in one statement; for a private session it claims the ENTIRE capacity in one shot
  // (see shared/sessionCapacity.ts), so concurrent booking attempts can't both succeed and
  // overbook — or, for private, both land on the same session at all.
  const capacityClaimed = await claimSessionCapacity(sessionId, partySize, session.booking_type)

  if (!capacityClaimed) {
    return { created: false, reason: 'insufficient_capacity' }
  }

  // The session-pass credit is still reserved before the INSERT (pass counter). Membership
  // session credits are NOT reserved here — they are claimed atomically by the guarded booking
  // INSERT below, which re-checks the period's availability and records credit_period_id in the
  // same statement, so two simultaneous bookings can never overspend the same period.
  // The claim re-checks pass_covers_session (pass level vs the session's band) atomically.
  let reservedSessionPassCredit = false
  const sessionBookingType = session.booking_type
  if (seat1PayBy === 'session_pass_credit' && sessionPassId) {
    const passClaim = await reserveSessionPassCredit(sessionPassId, sessionId)
    reservedSessionPassCredit = passClaim.reserved
    if (!reservedSessionPassCredit) {
      await releaseSessionCapacity(sessionId, partySize, sessionBookingType)
      if (passClaim.reason === 'not_valid_for_band') {
        // pass_covers_session is also false for a public session with no band — say so plainly
        // rather than blaming the pass level.
        return {
          created: false,
          reason: 'session_pass_not_valid_for_band',
          message: session.band_id
            ? "This is a Core pass, which can't be used for Peak sessions. Choose another way to pay."
            : "This session has no time band set, so a pass can't be used. Set the session's band or choose another way to pay.",
        }
      }
      return { created: false, reason: 'insufficient_session_pass_credit' }
    }
  }

  async function releaseEverythingClaimed() {
    await releaseSessionCapacity(sessionId, partySize, sessionBookingType)
    if (reservedSessionPassCredit && sessionPassId) await releaseSessionPassCredit(sessionPassId)
  }

  try {
    // Seat-1 membership credit: claimed by the INSERT itself. The WHERE clause re-checks, inside
    // the same statement that writes the booking, that the period is still usable (membership
    // active, not cancelled) and has spare credit — unlimited periods always qualify, limited
    // ones only while non-cancelled bookings using the period number fewer than its allocation.
    // FOR UPDATE OF p serializes two simultaneous claims on the same period; the loser re-checks
    // against the winner's committed booking and inserts zero rows. Zero rows inserted means the
    // credit is gone: the seat becomes paid and price_paid is recomputed, mirroring the old
    // failed-reservation fallback.
    let createdBookingId: string | null = null
    const creditSeatAttempted = seat1PayBy === 'membership_credit' && membershipId !== undefined
    if (creditSeatAttempted) {
      const usable = await findUsableMembershipCreditPeriod(membershipId!)
      if (usable) {
        const guarded = await paddockData.query<{ id: string }>(
          `INSERT INTO bookings
             (session_id, customer_id, party_size, status, price_paid, redemption_source, start_time, end_time,
              redeemed_membership_id, redeemed_session_pass_id, band_id, credit_period_id, special_requests,
              guests_over_18_confirmed_at)
           SELECT $1, $2, $3, 'confirmed', $4, $5, $6, $7, $8, $9, $10, p.id, $11, ${guestsOver18ConfirmedSql}
           FROM membership_credit_periods p
           JOIN customer_memberships cm ON cm.id = p.membership_id
           WHERE p.id = $12
             AND cm.subscription_status = 'active'
             AND (cm.cancel_effective_date IS NULL OR cm.cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
             AND (p.is_unlimited OR (SELECT count(*) FROM bookings b
                   WHERE b.credit_period_id = p.id
                     AND b.redemption_source = 'membership_credit'
                     AND b.status <> 'cancelled') < p.credits_allocated)
           FOR UPDATE OF p
           RETURNING id`,
          [
            sessionId,
            customerId,
            partySize,
            priceToRecord,
            redemptionSource,
            session.start_time,
            session.end_time,
            membershipId,
            null,
            seatQuotes ? seatQuotes[0]!.band_id : session.band_id,
            specialRequests,
            usable.periodId,
          ]
        )
        if (guarded.data.length > 0) {
          createdBookingId = guarded.data[0]!.id
        }
      }
      if (createdBookingId === null) {
        // Credit vanished between validation and now — the seat falls back to being paid, which
        // changes price_paid, so recompute it from the quote rather than releasing capacity.
        seat1PayBy = 'paid'
        bookingRedemptionSource = 'paid'
        priceToRecord = seatQuotes!.reduce((sum, seat) => sum + Number.parseFloat(seat.unit_price), 0)
      }
    }
    if (createdBookingId === null) {
      const bookingResult = await paddockData.query<{ id: string }>(
        `INSERT INTO bookings
           (session_id, customer_id, party_size, status, price_paid, redemption_source, start_time, end_time,
            redeemed_membership_id, redeemed_session_pass_id, band_id, special_requests, guests_over_18_confirmed_at)
         VALUES ($1, $2, $3, 'confirmed', $4, $5, $6, $7, $8, $9, $10, $11, ${guestsOver18ConfirmedSql})
         RETURNING id`,
        [
          sessionId,
          customerId,
          partySize,
          priceToRecord,
          bookingRedemptionSource,
          session.start_time,
          session.end_time,
          bookingRedemptionSource === 'membership_credit' ? redeemedMembershipId : null,
          redemptionSource === 'session_pass_credit' ? sessionPassId : null,
          seatQuotes ? seatQuotes[0]!.band_id : session.band_id,
          specialRequests,
        ]
      )
      createdBookingId = bookingResult.data[0]!.id
    }
    const createdBooking = { id: createdBookingId! }

    // Every attendee is recorded as a named guest, one row per quote seat: seat 1 (the account
    // holder, priced with the membership terms) is tagged 'account_holder'; every other seat is
    // an 'additional_guest'. Each row records its own unit_price (what that seat actually pays —
    // the member discount for seat 1, the full band price for guests) and pay_by. Only the account
    // holder's row carries a date of birth (checked 18+ above); guests are covered by the 18+ tick.
    let alreadyReleased = false
    try {
      for (let i = 0; i < guests.length; i++) {
        const guest = guests[i]!
        const quote = seatQuotes ? seatQuotes[i] : undefined
        await paddockData.query(
          `INSERT INTO booking_guests (booking_id, guest_type, guest_name, guest_email, date_of_birth, waiver_accepted, unit_price, pay_by)
           VALUES ($1, $2, $3, $4, $5, false, $6, $7)`,
          [
            createdBooking.id,
            i === 0 ? 'account_holder' : 'additional_guest',
            guest.name.trim(),
            guest.email?.trim() || null,
            i === 0 ? guest.dateOfBirth ?? null : null,
            quote ? quote.unit_price : null,
            i === 0 ? seat1PayBy : 'paid',
          ]
        )
      }
    } catch (guestErr) {
      // Guest rows failed partway through — treat this the same as an INSERT failure below:
      // delete whatever guest rows did get created, then fall through to the same booking-level
      // rollback (release capacity/credit, delete the booking). `alreadyReleased` prevents the
      // outer catch from releasing capacity/credit a second time for this same failure.
      await paddockData.query(`DELETE FROM booking_guests WHERE booking_id = $1`, [createdBooking.id])
      await paddockData.query(`DELETE FROM bookings WHERE id = $1`, [createdBooking.id])
      await releaseEverythingClaimed()
      alreadyReleased = true
      throw Object.assign(guestErr instanceof Error ? guestErr : new Error(String(guestErr)), { alreadyReleased })
    }

    return {
      created: true,
      booking: { id: createdBooking.id, price_paid: priceToRecord, session_id: sessionId },
      seat1PayBy,
    }
  } catch (err) {
    // Insert failed — release everything we claimed above so state stays in sync, unless the
    // guest-insert failure path above already did so (flagged via `alreadyReleased` to avoid
    // double-releasing capacity/credit back).
    const alreadyReleased = err instanceof Error && (err as Error & { alreadyReleased?: boolean }).alreadyReleased === true
    if (!alreadyReleased) {
      await releaseEverythingClaimed()
    }
    const message = err instanceof Error ? err.message : String(err)
    // A concurrent request for a different, overlapping session can race past the pre-check above
    // and reach this INSERT before the other commits. The `bookings_no_cross_session_overlap`
    // exclusion constraint is what actually catches that case — translate its violation into the
    // same structured failure reason the pre-check uses, instead of surfacing a raw DB error.
    if (message.includes('bookings_no_cross_session_overlap')) {
      return { created: false, reason: 'time_conflict' }
    }
    // The duplicate-booking-day trigger can also catch a race that slipped past the pre-check.
    if (message.includes('This customer already has a booking on')) {
      return { created: false, reason: 'duplicate_day_booking' }
    }
    throw err
  }
}

export default async function createBooking(req: { params: CreateBookingParams; user: User }): Promise<CreateBookingResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  return createBookingUnguarded(req)
}
