import { releaseSessionCapacity } from './shared/sessionCapacity'
import { releaseSessionPassCredit } from './shared/creditRedemption'
import { startsWithinRealHours } from './shared/londonTime'
import { resolveStaffId } from './shared/resolveStaffId'
import { requireCanIssueRefunds } from './shared/staffAccess'
import { cancelBookingAddonLines, describeAddonCancellation, type CancelAddonLinesResult } from './shared/bookingAddonCancellation'
import { stampLinesIfSeatMoneyAllBack } from './shared/bookingRefund'
import { NO_READER_PAYMENT_OPEN, READER_PAYMENT_OPEN_MESSAGE, anyReaderPaymentOpenOnBooking } from './shared/readerPaymentOpen'

export interface CancelCreditBookingParams {
  bookingId: string
  /** Optional free-text note — recorded in the result only; the booking keeps its own audit trail. */
  reason?: string
  /** The booking's add-on lines to cancel with it (all ticked by default). Add-on credits come
   *  back to the membership. Ticked PAID add-ons are refunded with `addonRefund` (Issue refunds
   *  only, checked here); without it they're left as they are. */
  addonLineIds?: string[]
  /** How ticked paid add-ons are refunded: card (card first on their own order, the rest to
   *  store credit) or store credit. Needs Issue refunds. */
  addonRefund?: 'card' | 'credit'
}

export interface CancelCreditBookingResult {
  cancelled: boolean
  reason?: string
  message?: string
  /** Set on success — true when the returned credit is usable again (its period still covers
   *  today, or the period is unlimited); false when the credit's period has already ended, so
   *  staff are told the credit is NOT coming back. */
  creditUsableAgain?: boolean
  booking?: { id: string; status: string }
  /** Set when add-on lines were sent: what happened to them. */
  addons?: CancelAddonLinesResult & { summary: string }
  warning?: string
}

/** Wording matches the card refund endpoint's 24-hour rejection message verbatim. */
const WITHIN_24_HOURS_MESSAGE = 'Not eligible for refund or credit — within 24 hours of session start.'

const CREDIT_SOURCES = ['membership_credit', 'session_pass_credit'] as const

/**
 * Cancels a credit-paid booking and returns its credit. Membership session credits need no write
 * beyond the cancellation itself — usage is counted from NON-cancelled bookings carrying
 * credit_period_id, so cancelling frees the credit automatically. Session-pass credits go back
 * onto the pass's counter via the existing releaseSessionPassCredit helper, which itself only
 * releases while the pass is unexpired.
 */
export default async function cancelCreditBooking(
  req: { params: CancelCreditBookingParams; user: User }
): Promise<CancelCreditBookingResult> {
  const { bookingId, reason } = req.params
  // First, so an inactive account is refused before anything is cancelled.
  const actingStaffId = await resolveStaffId(req.user.email)
  const addonRefund = req.params.addonRefund === 'card' || req.params.addonRefund === 'credit' ? req.params.addonRefund : null

  if (!bookingId) {
    return { cancelled: false, reason: 'booking_id_required', message: 'Booking id is required.' }
  }
  // Refunding paid add-ons moves money: Issue refunds only, checked before anything is cancelled.
  if (addonRefund && (req.params.addonLineIds ?? []).length > 0) {
    const paid = await paddockData.query<{ id: string }>(
      `SELECT id FROM addon_order_lines
       WHERE booking_id = $1 AND id = ANY($2::uuid[]) AND removed_at IS NULL
         AND COALESCE(redemption_source, 'paid') <> 'membership_credit'
       LIMIT 1`,
      [bookingId, req.params.addonLineIds]
    )
    if (paid.data.length > 0) await requireCanIssueRefunds(req.user.email)
  }

  const lookup = await paddockData.query<{
    id: string
    status: string
    party_size: number
    price_paid: string
    session_id: string
    booking_type: 'public' | 'private'
    redemption_source: string | null
    redeemed_session_pass_id: string | null
    credit_period_id: string | null
    is_unlimited: boolean | null
    period_end: string | null
    start_time: string
    seat1_pay_by: string | null
    paid_guest_count: number
  }>(
    `SELECT b.id, b.status, b.party_size, b.price_paid, b.session_id, st.booking_type, b.redemption_source,
            b.redeemed_session_pass_id, b.credit_period_id, mcc.is_unlimited, mcc.period_end,
            s.start_time,
            (SELECT bg.pay_by FROM booking_guests bg WHERE bg.booking_id = b.id ORDER BY bg.created_at, bg.id LIMIT 1) AS seat1_pay_by,
            (SELECT count(*)::int FROM booking_guests bg2
             WHERE bg2.booking_id = b.id AND bg2.guest_type = 'additional_guest' AND bg2.unit_price > 0) AS paid_guest_count
     FROM bookings b
     JOIN sessions s ON s.id = b.session_id
     JOIN service_types st ON st.id = s.service_type_id
     LEFT JOIN membership_current_credits mcc ON mcc.period_id = b.credit_period_id
     WHERE b.id = $1`,
    [bookingId]
  )
  const booking = lookup.data[0]
  if (!booking) {
    return { cancelled: false, reason: 'booking_not_found', message: 'Booking not found.' }
  }
  // A payment_needed booking (a former membership-credit booking flagged after the membership's
  // payment failed) is cancellable here too — the membership lapsed, so there is no credit to
  // "return", but the cancellation releases the held capacity exactly the same way and no money
  // was paid, so no refund is involved. Its 24-hour rule does not apply (see below).
  const isPaymentNeeded = booking.status === 'payment_needed'
  if (
    !isPaymentNeeded &&
    (!booking.redemption_source || !(CREDIT_SOURCES as readonly string[]).includes(booking.redemption_source))
  ) {
    return {
      cancelled: false,
      reason: 'not_credit_booking',
      message: 'Only bookings paid with a membership or session-pass credit can be cancelled this way.',
    }
  }
  if (booking.status !== 'confirmed' && booking.status !== 'pending' && !isPaymentNeeded) {
    return {
      cancelled: false,
      reason: 'not_cancellable',
      message: `Only confirmed or pending bookings can be cancelled — this one is ${booking.status}.`,
    }
  }

  // A reader tap on this booking would still go through after the cancel, and charge for add-ons on
  // a booking that has gone.
  if (await anyReaderPaymentOpenOnBooking(bookingId)) {
    return { cancelled: false, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
  }

  // A money payment must be refunded, not silently dropped: seat 1 was paid (e.g. the credit
  // fell back to paid, or the move released it), so this action refuses — Cancel & Refund is the
  // right flow. Only when seat 1 itself is genuinely credit-covered and the paid amount comes
  // solely from additional guest seats does the existing "remove guests first" rule apply.
  if (Number.parseFloat(booking.price_paid) > 0) {
    const seat1CreditCovered =
      booking.credit_period_id !== null ||
      booking.seat1_pay_by === 'membership_credit' ||
      booking.seat1_pay_by === 'session_pass_credit'
    if (seat1CreditCovered && booking.paid_guest_count > 0) {
      return {
        cancelled: false,
        reason: 'paid_guests_present',
        message: 'Remove paid guests first, then cancel.',
      }
    }
    return {
      cancelled: false,
      reason: 'money_paid',
      message: 'This booking includes a money payment - use Cancel & Refund instead.',
    }
  }

  // 24-hour rule — REAL elapsed hours, matching the payments backend (Worker) exactly: the
  // stored London wall-clock digits are converted to a true UTC instant first (see
  // shared/londonTime.ts). The previous naive digit comparison differed by one hour on
  // clock-change weekends (e.g. the 2026-10-25 autumn change), refusing refunds in the 09:00–
  // 08:00 BST/GMT hour that the backend still allowed. Payment_needed bookings skip this rule
  // entirely: their clock is the payment deadline, not the session start, and the scheduled job
  // will cancel them anyway — staff cancelling one early must not be blocked by a rule that no
  // longer applies to it.
  if (!isPaymentNeeded) {
    if (startsWithinRealHours(booking.start_time, 24)) {
      return {
        cancelled: false,
        reason: 'within_24_hours',
        message: WITHIN_24_HOURS_MESSAGE,
      }
    }
  }

  // Guarded like every other claim: this gives no money back, so it may only cancel what it read as
  // £0, with nothing on the reader. Money landing in the gap would be stuck on a cancelled booking.
  const update = await paddockData.query<{ id: string; status: string }>(
    `UPDATE bookings b
     SET status = 'cancelled', cancelled_at = now(), updated_at = now()
     WHERE b.id = $1 AND b.status IN ('confirmed', 'pending', 'payment_needed') AND b.price_paid = $2::numeric
       AND ${NO_READER_PAYMENT_OPEN}
     RETURNING b.id, b.status`,
    [bookingId, Number.parseFloat(booking.price_paid)]
  )
  if (update.data.length === 0) {
    // Something changed since the checks above: they answer with where the booking stands now.
    return cancelCreditBooking(req)
  }

  await releaseSessionCapacity(booking.session_id, booking.party_size, booking.booking_type)

  let creditUsableAgain = false
  if (booking.redemption_source === 'membership_credit') {
    // Nothing to write — usage is counted from non-cancelled bookings, so the credit is already
    // free again. Report whether it is actually usable: only when its period is unlimited or
    // still covers today's London date.
    const todayResult = await paddockData.query<{ today: string }>(
      `SELECT (now() AT TIME ZONE 'Europe/London')::date::text AS today`
    )
    const todayLondon = todayResult.data[0]?.today ?? ''
    creditUsableAgain = booking.is_unlimited === true || (booking.period_end !== null && booking.period_end >= todayLondon)
  } else if (booking.redemption_source === 'session_pass_credit' && booking.redeemed_session_pass_id) {
    // releaseSessionPassCredit only releases while the pass is unexpired (its UPDATE carries an
    // expiry guard) — an expired pass keeps its counter untouched, so the credit is gone.
    await releaseSessionPassCredit(booking.redeemed_session_pass_id)
    const pass = await paddockData.query<{ id: string }>(
      `SELECT id FROM customer_session_passes WHERE id = $1 AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date`,
      [booking.redeemed_session_pass_id]
    )
    creditUsableAgain = pass.data.length > 0
  }

  // Ticked add-on credits come back with the booking; ticked paid add-ons are refunded with the
  // chosen method (or left as they are without one). The booking is already cancelled, so a
  // failure here is a warning naming what needs a manual refund (as refundBooking does).
  let addons: (CancelAddonLinesResult & { summary: string }) | undefined
  let warning: string | undefined
  const addonLineIds = req.params.addonLineIds ?? []
  if (addonLineIds.length > 0) {
    try {
      const outcome = await cancelBookingAddonLines({
        bookingId,
        lineIds: addonLineIds,
        refund: addonRefund ?? 'none',
        returnCredits: true,
        includePaidLines: addonRefund !== null,
        staffId: actingStaffId,
      })
      addons = { ...outcome, summary: describeAddonCancellation(outcome) }
      warning = outcome.warning
    } catch (err) {
      warning = `The booking was cancelled, but cancelling its add-ons failed — refund the ticked add-ons manually and check their add-on credits: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // A paid guest's money can have gone back before this cancel, which gives none itself. After the
  // add-ons, so the order's status counts them too.
  const statusWarning = await stampLinesIfSeatMoneyAllBack(bookingId)
  if (statusWarning) warning = warning ? `${warning} ${statusWarning}` : statusWarning

  return {
    cancelled: true,
    creditUsableAgain,
    booking: { id: update.data[0]!.id, status: update.data[0]!.status },
    ...(reason?.trim() ? { message: reason.trim() } : {}),
    ...(addons ? { addons } : {}),
    ...(warning ? { warning } : {}),
  }
}
