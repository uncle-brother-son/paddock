import { type RefundMethod } from './refundBooking'
import { REFUND_UNSURE_MESSAGE, giveBookingMoneyBack, shortfallStaysOnBookingWarnings, stampRemovedGuestLine, takeBackStoreCredit } from './shared/bookingRefund'
import { AMOUNT_CHANGED_MESSAGE } from './shared/cashConfirmation'
import { claimGuestRefund, finishRefundClaim, putBackAsOwed, putBackGuestRefund } from './shared/bookingMoneyClaim'
import { READER_PAYMENT_OPEN_MESSAGE, anyReaderPaymentOpenOnBooking } from './shared/readerPaymentOpen'
import { resolveStaffId } from './shared/resolveStaffId'
import { getStaffAccessRow } from './shared/staffAccess'

export interface RemoveBookingGuestParams {
  guestId: string
  /**
   * Step 2 only: the staff-confirmed refund amount (in pounds). The first call (without this)
   * quotes what removing the guest would refund and changes nothing; the second call must pass
   * back exactly that amount so a guest is never removed on a stale/incorrect quote.
   */
  confirmedRefundAmount?: number
  /** Step 2 only — how the confirmed refund is issued (original card reversal or store credit). */
  refundMethod?: RefundMethod
}

export interface RemoveBookingGuestQuote {
  bookingId: string
  bookingType: 'public' | 'private'
  /** What removing this guest refunds, in pounds — the guest's own recorded unit_price, or what is
   *  left on the booking if that is less (after a part refund, and never money owed); 0 for legacy guest rows recorded
   *  before band pricing (no per-seat price) or credit-covered seats. */
  refundAmount: number
  /** True when the seat was paid with money (pay_by 'paid') — only those seats get a refund. */
  refundable: boolean
  partySize: number
}

export interface RemoveBookingGuestResult {
  removed: boolean
  blocked: boolean
  guestId: string
  /** Present, with `removed: false`, on the quoting step — staff confirm this amount before the
   *  removal (and any refund) actually happens. Also present when the confirmed amount was
   *  refused, or when a failed removal left less to refund, so the screen moves to the new figure. */
  quote?: RemoveBookingGuestQuote
  /** Set on the confirming call: what was actually given back (0 when nothing was due). Less than
   *  the confirmed amount when store credit failed partway; `warning` then says so. */
  refundedAmount?: number
  /** Set with `removed: true`: what actually went to the card and to store credit. */
  cardRefundedAmount?: number
  storeCreditRefundedAmount?: number
  /** Present when the refund was issued to STORE CREDIT — the customer's balance after the
   *  movement, from the store credit refund. */
  storeCreditBalance?: number
  /** Set when the refund succeeded but a bookkeeping step (recording the card-refunded amount)
   *  failed and needs a manual check, or when part of it is still on the booking, for Refund the rest. */
  warning?: string
  reason?: string
  /** What staff are told. A failed refund or removal is worded here, because only this function
   *  knows where the money ended up; the detail after the reason's colon is in brackets at the end. */
  message?: string
  /** Set after a failed removal when pressing again would refund money a second time: store credit
   *  that couldn't be taken back, card money that couldn't be taken off the seat, or a refund with no
   *  clear answer. The screen locks Remove until staff close it, which reloads the booking. */
  retryLocked?: boolean
  /** Present, with removed: false, when removing this guest would refund money but the
   *  caller lacks can_issue_refunds — nothing was removed and no money moved. */
  blockedByRefundPermission?: boolean
}

/**
 * Removes one additional guest from a booking. Two-step so staff always confirm the money before
 * anything moves:
 *   1. Call with just `guestId` — returns `quote.refundAmount` (the guest's recorded unit_price,
 *      capped at the booking's price_paid) without touching anything.
 *   2. Call again with `confirmedRefundAmount` (and `refundMethod`) — the confirmed amount (it
 *      must match that quote) is claimed off the booking and the seat in one guarded statement
 *      (shared/bookingMoneyClaim), then refunded in Retool (shared/bookingRefund: card against the
 *      booking's orders, each capped at its card portion; the rest to store credit), then the
 *      guest row is deleted, the session's capacity released and party_size kept consistent. A
 *      failed refund puts the claim back, so the guest stays as they were and the error is
 *      surfaced; a failed removal after the refund is handled so no money is left unrecorded. A
 *      refund with no clear answer keeps the claim: the seat stays lowered, so pressing Remove
 *      again refunds nothing, and the money is owed on the booking.
 */
const round2 = (n: number) => Math.round(n * 100) / 100

/** A failed removal, in words that match where the money ended up. `refundStanding` is what is
 *  still with the customer: card money can't be taken back, store credit usually can. */
function removalFailedMessage(refundAmount: number, refundStanding: number, notes: string[], failure: string): string {
  const outcome =
    refundStanding <= 0.005
      ? "The guest couldn't be removed and nothing was refunded. Please try again."
      : refundStanding >= refundAmount - 0.005
        ? "The refund went through, but the guest couldn't be removed. Check the booking before trying again."
        : "Part of the refund went through, but the guest couldn't be removed. Check the booking before trying again."
  return [outcome, ...notes, `(${failure})`].join(' ')
}

/**
 * Single round-trip lookup: the guest row and its booking/session/service type in one query.
 * LEFT JOINs so a guest whose booking no longer exists still yields the guest row (and the same
 * booking_not_found outcome as the old two-lookup flow).
 */
interface GuestBookingLookupRow {
  id: string
  booking_id: string
  guest_type: string
  guest_name: string
  unit_price: string | null
  pay_by: string | null
  bk_id: string | null
  customer_id: string | null
  party_size: number | null
  price_paid: string | null
  refund_owed_amount: string | null
  status: string | null
  session_id: string | null
  booking_type: 'public' | 'private' | null
}

export default async function removeBookingGuest(
  req: { params: RemoveBookingGuestParams; user: User }
): Promise<RemoveBookingGuestResult> {
  const { guestId, confirmedRefundAmount, refundMethod } = req.params

  // Guest + booking arrive in ONE round-trip instead of two sequential lookups.
  const lookup = await paddockData.query<GuestBookingLookupRow>(
    `SELECT g.id, g.booking_id, g.guest_type, g.guest_name, g.unit_price, g.pay_by,
            b.id AS bk_id, b.customer_id, b.party_size, b.price_paid, b.refund_owed_amount, b.status, b.session_id, st.booking_type
     FROM booking_guests g
     LEFT JOIN bookings b ON b.id = g.booking_id
     LEFT JOIN sessions s ON s.id = b.session_id
     LEFT JOIN service_types st ON st.id = s.service_type_id
     WHERE g.id = $1`,
    [guestId]
  )
  const row = lookup.data[0]
  if (!row) {
    return { removed: false, blocked: false, guestId, reason: 'guest_not_found' }
  }

  if (row.guest_type === 'account_holder') {
    return { removed: false, blocked: true, guestId }
  }

  if (row.bk_id === null) {
    return { removed: false, blocked: false, guestId, reason: 'booking_not_found' }
  }

  const guest = {
    id: row.id,
    booking_id: row.booking_id,
    guest_type: row.guest_type,
    guest_name: row.guest_name,
    unit_price: row.unit_price,
    pay_by: row.pay_by,
  }
  const booking = {
    id: row.bk_id,
    party_size: row.party_size!,
    price_paid: row.price_paid,
    refund_owed_amount: row.refund_owed_amount ?? '0',
    status: row.status!,
    session_id: row.session_id!,
    booking_type: row.booking_type!,
  }
  if (booking.status === 'cancelled') {
    return { removed: false, blocked: false, guestId, reason: 'booking_cancelled' }
  }

  // Only seats actually paid with money are refundable — legacy rows (recorded before band
  // pricing added per-seat prices) have no unit_price and refund nothing. A part refund may already
  // have given the seat's money back, so the refund stops at what is left on the booking. Money
  // owed after a failed refund isn't this seat's: it stays owed, for Refund the rest to give.
  const refundable = guest.pay_by === 'paid' && guest.unit_price !== null
  const moneyLeft = Number.parseFloat(booking.price_paid ?? '0') - Number.parseFloat(booking.refund_owed_amount)
  const refundAmount = refundable ? round2(Math.min(Number.parseFloat(guest.unit_price!), Math.max(moneyLeft, 0))) : 0

  const quote = {
    bookingId: booking.id,
    bookingType: booking.booking_type,
    refundAmount,
    refundable,
    partySize: booking.party_size,
  }

  // --- Step 1: quote ---
  if (confirmedRefundAmount === undefined) {
    return { removed: false, blocked: false, guestId, quote }
  }

  // --- Step 2: staff-confirmed removal ---
  if (await anyReaderPaymentOpenOnBooking(booking.id)) {
    return { removed: false, blocked: false, guestId, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
  }
  if (refundable && confirmedRefundAmount > 0) {
    // Removing a paid seat refunds money, so the caller must hold can_issue_refunds — checked
    // before anything is removed or refunded. Seats that refund nothing (credit-covered or
    // legacy rows) stay removable by anyone.
    const refundPermission = await getStaffAccessRow(req.user.email)
    if (!refundPermission?.can_issue_refunds) {
      return { removed: false, blocked: false, guestId, reason: 'no_refund_permission', blockedByRefundPermission: true }
    }
  }
  // Not only for a refundable seat: one that stopped being refundable would otherwise be removed
  // with nothing refunded, after staff confirmed a refund. Both refusals carry the new figure.
  if (Math.abs(confirmedRefundAmount - refundAmount) > 0.01) {
    return { removed: false, blocked: false, guestId, reason: 'refund_amount_mismatch', message: AMOUNT_CHANGED_MESSAGE, quote }
  }
  if (refundable && confirmedRefundAmount > 0 && !refundMethod) {
    return { removed: false, blocked: false, guestId, reason: 'refund_method_required', quote }
  }

  // Claim the money, then refund it in Retool (shared/bookingRefund): card against the booking's
  // orders newest first (a guest added later was paid on the newest), each capped at its card
  // portion and recorded on its booking line; the rest to store credit. A refund that fails moves
  // nothing, and the claim goes back.
  const staffId = await resolveStaffId(req.user.email)
  let given: Awaited<ReturnType<typeof giveBookingMoneyBack>> | null = null
  let claimId: string | null = null
  if (refundable && refundAmount > 0) {
    claimId = await claimGuestRefund({
      bookingId: booking.id,
      guestId,
      seenUnitPrice: Number.parseFloat(guest.unit_price!),
      amount: refundAmount,
      seenPricePaid: Number.parseFloat(booking.price_paid ?? '0'),
      staffId,
      method: refundMethod ?? 'card',
    })
    if (!claimId) {
      // Something changed since the lookup: nothing has moved, so answer with the new figures.
      const fresh = await removeBookingGuest({ params: { guestId }, user: req.user })
      if (!fresh.quote) return fresh
      if (await anyReaderPaymentOpenOnBooking(booking.id)) {
        return { removed: false, blocked: false, guestId, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
      }
      return { ...fresh, reason: 'refund_amount_mismatch', message: AMOUNT_CHANGED_MESSAGE }
    }
    given = await giveBookingMoneyBack({
      bookingId: booking.id,
      customerId: row.customer_id!,
      amount: refundAmount,
      method: refundMethod ?? 'card',
      staffId,
      user: req.user,
      note: `Refund for a guest removed from the booking (${guest.guest_name})`,
      recordCardOnLines: true,
      pricePaidBefore: Number.parseFloat(booking.price_paid ?? '0'),
    })
    if (!given.ok && given.unsure) {
      // The money may have gone. The seat stays lowered, so a second Remove can't refund it again.
      let stuck = ''
      try {
        await putBackAsOwed(booking.id, refundAmount)
      } catch (err) {
        stuck = ` Marking the £${refundAmount.toFixed(2)} as owed failed, so check the booking and add it by hand: ${err instanceof Error ? err.message : String(err)}`
      }
      await finishRefundClaim({ claimId, bookingId: booking.id, staffId, outcome: 'owed', owed: refundAmount })
      return {
        removed: false,
        blocked: false,
        guestId,
        reason: `refund_unsure: ${given.message}`,
        message: `The guest hasn't been removed. ${REFUND_UNSURE_MESSAGE} (${given.message})${stuck}`,
        retryLocked: true,
        quote: { ...quote, refundAmount: 0 },
      }
    }
    if (!given.ok) {
      // Only returned when no money moved, and the guest hasn't been touched yet.
      let stuck = ''
      try {
        await putBackGuestRefund({ bookingId: booking.id, guestId, amount: refundAmount })
      } catch (err) {
        stuck = ` Putting the £${refundAmount.toFixed(2)} back on the booking failed, so its price paid and the guest's seat are that much too low: ${err instanceof Error ? err.message : String(err)}`
      }
      await finishRefundClaim({ claimId, bookingId: booking.id, staffId, outcome: 'put_back' })
      return {
        removed: false,
        blocked: false,
        guestId,
        reason: `refund_failed: ${given.message}`,
        message: `The refund didn't go through, so the guest hasn't been removed. Please try again. (${given.message})${stuck}`,
      }
    }
  }
  const back = given?.ok ? given.result : null
  const givenBack = back ? round2(back.cardRefunded + back.storeCreditRefunded) : 0

  // One atomic round-trip: guest deletion, capacity release and the booking's party size. The
  // order's totals are NOT lowered — the refund itself is recorded (card on the booking line, store
  // credit as a movement), and lowering order_total as well counted the same refund twice in the
  // order's card portion. price_paid already fell with the claim, so store credit that failed
  // partway goes back on it, owed, for Refund the rest. Placeholders are bound once each, in
  // ascending order.
  let removedOk = false
  let guestAlreadyGone = false
  let failure = ''
  try {
    const removed = await paddockData.query<{ deleted: boolean }>(
      `WITH del AS (
         DELETE FROM booking_guests WHERE id = $1 RETURNING id
       ),
       rel AS (
         UPDATE sessions SET total_booked = GREATEST(total_booked - 1, 0), updated_at = now()
         WHERE id = $2 AND $3::bool AND EXISTS (SELECT 1 FROM del)
         RETURNING id
       ),
       bk AS (
         UPDATE bookings
         SET party_size = GREATEST(party_size - 1, 1), price_paid = price_paid + $4::numeric,
             refund_owed_amount = refund_owed_amount + $5::numeric, updated_at = now()
         WHERE id = $6 AND EXISTS (SELECT 1 FROM del)
         RETURNING id
       )
       SELECT (SELECT count(*) FROM del) > 0 AS deleted`,
      [
        guestId,                                        // $1
        booking.session_id,                             // $2
        booking.booking_type === 'public',              // $3
        back?.shortfall ?? 0,                           // $4
        back?.shortfall ?? 0,                           // $5
        booking.id,                                     // $6
      ]
    )
    removedOk = removed.data[0]?.deleted === true
    if (!removedOk) {
      guestAlreadyGone = true
      failure = 'the guest was already removed'
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }

  if (!removedOk) {
    // Nothing removed: never leave money given back with nothing recorded. The card part is already
    // recorded on its order line and came off the seat and price paid with the claim, so a retry
    // refunds only the rest. Everything else goes back on them: the store credit is taken back, or
    // staff are told to remove it by hand, and a shortfall never left.
    // A shortfall stays on the seat, so a retry refunds it: "add it by hand" would pay it twice.
    const refundWarning = back?.shortfall ? back.warningWithoutShortfall : back?.warning
    const notes: string[] = refundWarning ? [refundWarning] : []
    // A shortfall with no clear answer may have reached the customer: it goes on the booking as owed,
    // never back on the seat, where a retry would refund it again with a new key.
    const unsureShortfall = back?.unsure && back.shortfall ? back.shortfall : 0
    if (back?.shortfall && !unsureShortfall) notes.push(`The other £${back.shortfall.toFixed(2)} wasn't added to store credit, so it's still to refund.`)
    let refundStanding = 0
    let creditStuck = false
    if (back && back.storeCreditRefunded > 0) {
      const ok = await takeBackStoreCredit({
        customerId: row.customer_id!,
        amount: back.storeCreditRefunded,
        orderId: back.ownOrderId,
        bookingId: booking.id,
        staffId,
      })
      if (!ok) {
        refundStanding += back.storeCreditRefunded
        creditStuck = true
      }
      notes.push(ok ? `The £${back.storeCreditRefunded.toFixed(2)} store credit was taken back.` : `Taking back the £${back.storeCreditRefunded.toFixed(2)} store credit failed — remove it by hand.`)
    }
    const notGone = back ? round2(refundAmount - back.cardRefunded - unsureShortfall) : 0
    let claimStands = false
    if (notGone > 0) {
      try {
        await putBackGuestRefund({ bookingId: booking.id, guestId, amount: notGone })
      } catch (err) {
        claimStands = true
        notes.push(`Putting the £${notGone.toFixed(2)} back on the booking failed, so its price paid is that much too low: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (unsureShortfall > 0) {
      try {
        await putBackAsOwed(booking.id, unsureShortfall)
        notes.push(`The other £${unsureShortfall.toFixed(2)} is still on the booking. ${REFUND_UNSURE_MESSAGE}`)
      } catch (err) {
        claimStands = true
        notes.push(
          `The other £${unsureShortfall.toFixed(2)} may have gone through, and marking it as owed failed, so check Stripe and their balance before refunding it: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    const seatLowered = !guestAlreadyGone && (back?.cardRefunded ?? 0) > 0
    if (back && back.cardRefunded > 0) {
      refundStanding += back.cardRefunded
      notes.push(
        guestAlreadyGone
          ? `£${back.cardRefunded.toFixed(2)} had already gone back to the card; it was taken off the booking's price paid.`
          : `£${back.cardRefunded.toFixed(2)} had already gone back to the card; it was taken off the guest's seat, so retrying refunds only the rest.`
      )
    }
    // With the guest gone a retry refunds nothing: it only finds them gone.
    const retryLocked = !guestAlreadyGone && (creditStuck || claimStands || back?.unsure === true)
    if (claimId) {
      await finishRefundClaim({
        claimId,
        bookingId: booking.id,
        staffId,
        outcome: unsureShortfall > 0 ? 'owed' : 'put_back',
        cardRefunded: back?.cardRefunded ?? 0,
        storeCreditRefunded: creditStuck ? (back?.storeCreditRefunded ?? 0) : 0,
        ...(unsureShortfall > 0 ? { owed: unsureShortfall } : {}),
      })
    }
    return {
      removed: false,
      blocked: false,
      guestId,
      reason: `guest_remove_failed: ${failure}`,
      message: removalFailedMessage(refundAmount, refundStanding, notes, failure),
      ...(retryLocked ? { retryLocked } : {}),
      // The seat now holds less, so the screen must not keep offering the old refund.
      ...(seatLowered && back ? { quote: { ...quote, refundAmount: round2(Math.max(refundAmount - back.cardRefunded, 0)) } } : {}),
    }
  }

  const warnings = back ? shortfallStaysOnBookingWarnings(back) : []
  // The seat's money has all gone back, unless store credit fell short: what stopped at what was
  // left only stopped because the rest had gone already.
  if (refundable && !back?.shortfall) {
    const stampWarning = await stampRemovedGuestLine(booking.id, Number.parseFloat(guest.unit_price!))
    if (stampWarning) warnings.push(stampWarning)
  }
  if (claimId) {
    const owed = back?.shortfall ?? 0
    await finishRefundClaim({
      claimId,
      bookingId: booking.id,
      staffId,
      outcome: owed > 0 ? 'owed' : 'given',
      cardRefunded: back?.cardRefunded ?? 0,
      storeCreditRefunded: back?.storeCreditRefunded ?? 0,
      owed,
    })
  }
  return {
    removed: true,
    blocked: false,
    guestId,
    refundedAmount: givenBack,
    cardRefundedAmount: back?.cardRefunded ?? 0,
    storeCreditRefundedAmount: back?.storeCreditRefunded ?? 0,
    ...(back?.storeCreditBalance !== undefined ? { storeCreditBalance: back.storeCreditBalance } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  }
}
