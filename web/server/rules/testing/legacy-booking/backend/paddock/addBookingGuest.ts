import {
  MAX_GUESTS_PER_PUBLIC_BOOKING,
  MAX_GUESTS_PER_PRIVATE_BOOKING,
  GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE,
} from './shared/guestValidation'
import type { BandSeatQuote } from './shared/bandPricing'
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
import { PRESS_FINISHED_AUDIT, detailId, findPressFinished, newPressId } from './shared/pressFinished'
import { reverseSavedCardCharge } from './shared/bookingRefund'
import { applyStoreCredit } from './shared/storeCredit'
import { storeCreditMoved } from './shared/storeCreditRefund'
import { resolveStaffId } from './shared/resolveStaffId'
import { createTerminalPaymentIntentUnguarded as createTerminalPaymentIntent } from './createTerminalPaymentIntent'
import { type PendingReaderSnapshot } from './shared/pendingReaderFlows'
import { getStaffAccessRow } from './shared/staffAccess'
import { reserveMembershipAddonCredit, releaseMembershipAddonCredit } from './shared/creditRedemption'
import { addonSystemPrice, customerHasActiveMembership, loadAddonCatalog } from './shared/addonPricing'
import { AMOUNT_CHANGED_MESSAGE, amountLeftToPay, cashDifferenceRefusal, exceedsAmount } from './shared/cashConfirmation'
import { NO_READER_PAYMENT_OPEN, READER_PAYMENT_OPEN_MESSAGE, anyReaderPaymentOpenOnBooking } from './shared/readerPaymentOpen'

export interface AddBookingGuestPaymentInput {
  giftCard?: { giftCardId: string; amount: number }
  /** Store credit drawn from the customer's own store_credit_balance — a separate payment part
   *  from the gift card, applied (claimed, negative) before any card money. */
  storeCredit?: { amount: number }
  method?: 'card' | 'reader' | 'cash'
  /** Cash only: the figure on the tick staff confirmed. Refused if the amount works out different
   *  (shared/cashConfirmation). */
  confirmedCashAmount?: number
}

/** An add-on to add to the booking — the same shape and rules as New Order's booking add-ons. */
export interface BookingAddonInput {
  addonId: string
  quantity: number
  /** Ignored unless the caller has Manage pricing (then a different price needs a reason), as in
   *  New Order: the system price (shared/addonPricing) is charged otherwise. */
  unitPrice?: number
  priceOverrideReason?: string
  redemptionSource?: 'paid' | 'membership_credit'
  /** Required for 'membership_credit': one of the customer's memberships with add-on credit. */
  membershipId?: string
}

export interface AddBookingGuestParams {
  bookingId: string
  /** The guest to add. Omit (with `addons`) to add add-ons on their own. */
  guestName?: string
  guestEmail?: string
  /** "This guest is 18 or over" — required true (guests give no date of birth, 28 Oct). Sets the
   *  booking's guests_over_18_confirmed_at when it was still NULL. */
  guestsOver18Confirmed?: boolean
  /**
   * Staff's resolved choice from a previous "quote" call's `priceImpact` — set to true to redeem
   * the booking's existing membership/session-pass credit for this guest instead of paying.
   * Legacy: band pricing removed credit-covered guest seats on PUBLIC bookings (guests are
   * always paid), so a public booking rejects this with `credit_not_available_for_guests`.
   * Mutually exclusive with `payment`.
   */
  useExistingCredit?: boolean
  /** Required when `priceImpact.amountDue > 0` and staff chose to pay rather than use a credit. */
  payment?: AddBookingGuestPaymentInput
  /** Add-ons to add in the same payment (until the session starts). Membership-credit lines draw
   *  the member's add-on credits (Herd only) and need no payment. */
  addons?: BookingAddonInput[]
}

export interface AddBookingGuestPriceImpact {
  /** What adding this guest (and any paid add-ons) costs, in pounds — 0 when it's free (e.g. a
   *  private booking that doesn't cross into a higher headcount tier, promo or not). */
  amountDue: number
  /** The guest's part of amountDue (0 with no guest). */
  guestAmount: number
  /** The paid add-ons' part of amountDue. */
  addonsAmount: number
  /** True when the booking's existing membership/session-pass credit still has room for one more
   *  guest — legacy shape only (public guests are always paid under band pricing). */
  creditAvailable: boolean
  creditLabel?: string
}

export interface AddBookingGuestResult {
  added: boolean
  limitReached?: boolean
  guest?: Record<string, unknown> | null
  /** Present, with `added: false`, when a price/credit decision is needed and wasn't yet resolved
   *  — the caller should show this to staff, then re-call with `useExistingCredit` or `payment`.
   *  Also present with every refusal over the amount, so the screen moves to the new figures. */
  priceImpact?: AddBookingGuestPriceImpact
  reason?: string
  message?: string
  /** Present when method is 'reader' (new flow): the guest is added and PENDING the reader
   *  charge — the frontend collects on the reader then calls finaliseReaderPayment({ pendingId });
   *  a reader failure calls cancelReaderPayment, which removes the guest and releases the seat. */
  /** The add-on lines written (pending until finalise on the reader path). */
  addonLineIds?: string[]
  pendingReaderPayment?: {
    flow: 'add_guest'
    recordId: string
    pendingId: string
    paymentIntentId: string
    clientSecret: string
    amount: number
  }
}

/** Saving the guest or add-ons gave no answer, and looking for its finished row failed too. */
const ADD_SAVE_UNCLEAR_MESSAGE =
  "Saving this gave no answer, and checking whether it was saved failed too, so nothing was put back. Reload the booking: if the guest or add-ons are there, it is done. If not, check the session's places and give back by hand any gift card, store credit, credits or cash taken for it."

/** A press that lost to another one with the same payment, or whose own statement wrote and lost its answer. */
const ADDED_WITH_THIS_PAYMENT =
  'This was already added with the same payment (by a press at the same moment, or this one with its answer lost), so it was only taken once. Reload the booking.'

/**
 * Single round-trip lookup: booking, session, service type, guest count AND the price of the new
 * seat (headcount tier for private bookings, band quote for public ones) are all fetched in one
 * query. The two price branches are lazily-evaluated CASE scalar subqueries, so quote_booking is
 * never called for private sessions (it raises an exception for non-public sessions).
 */
interface BookingLookupRow {
  id: string
  customer_id: string
  price_paid: string
  redemption_source: string
  redeemed_membership_id: string | null
  redeemed_session_pass_id: string | null
  status: string
  party_size: number
  /** As text: part of the card charge's key, so it must come back exactly as it went in. */
  updated_at: string
  session_id: string
  booking_type: 'public' | 'private'
  service_type_id: string
  /** True when the booking's session has already started (or is in the past) — start_time is
   *  stored as London wall-clock labelled UTC, so it's compared like for like against London
   *  wall-clock now, never against raw now(). */
  session_started: boolean
  /** Current number of guest rows on the booking (COUNT cast to int). */
  guest_count: number
  /** Public only: the LAST seat row of quote_booking at party = current count + 1. */
  seat_quote: BandSeatQuote | null
  /** Private only: the tier row covering the new party size at the booking's band (null when no
   *  row exists — distinguishable from a row with no price set yet). */
  tier_row: { price: string | null } | null
  /** Private only: the promo taken off this booking, summed over its booking lines (0 for public,
   *  which never reads it). price_paid is net of this. */
  promo_share: string
  /** What part refunds have given back on this booking (refundBooking keeps it). */
  part_refunded_amount: string
  /** Money owed after a failed refund. It sits inside price_paid but paid for nothing. */
  refund_owed_amount: string
}

/**
 * Adding a guest to an existing booking has real price consequences that must never be silently
 * absorbed:
 *  - Private bookings are priced by headcount tier — crossing into a higher tier means the
 *    difference must be collected via a real payment method (private bookings never use credit,
 *    per policy). A promo is kept and a part refund stays with the customer: the difference is
 *    measured from what was paid plus the promo share plus the part refunds, so the same tier is
 *    free and a higher tier costs the tier difference only (Q25, Q27).
 *  - Public bookings are band-priced: the new guest's seat is quoted from quote_booking at the
 *    booking's session and is ALWAYS paid (guests are never credit-covered under band pricing),
 *    so the seat's full band price is collected via a real payment method.
 *
 * This is a two-step "quote, then confirm" flow, same shape as checkout's basket → payment step:
 * call once with just the guest's name/email; if a payment is required, `priceImpact` comes back
 * and no guest is added yet; call again with `payment` to actually add them.
 */
export default async function addBookingGuest(
  req: { params: AddBookingGuestParams; user: User }
): Promise<AddBookingGuestResult> {
  const { bookingId, guestEmail, useExistingCredit, payment } = req.params
  // First, so an inactive account is refused before anything happens, and so nothing below has to
  // look this up between taking money and reversing it.
  const actingStaffId = await resolveStaffId(req.user.email)
  const guestName = typeof req.params.guestName === 'string' ? req.params.guestName.trim() : ''
  const addonInputs = Array.isArray(req.params.addons) ? req.params.addons : []
  const addingGuest = guestName !== ''

  if (!addingGuest && addonInputs.length === 0) {
    throw new Error('Guest name is required')
  }
  if (addingGuest && req.params.guestsOver18Confirmed !== true) {
    return { added: false, reason: 'guests_over_18_not_confirmed', message: GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE }
  }

  // Booking, guest count and the new seat's price all arrive in ONE round-trip (see
  // BookingLookupRow) instead of two sequential waves.
  const bookingLookup = await paddockData.query<BookingLookupRow>(
    `SELECT b.id, b.customer_id, b.price_paid, b.part_refunded_amount, b.refund_owed_amount, b.redemption_source, b.redeemed_membership_id, b.redeemed_session_pass_id,
            b.status, b.party_size, b.updated_at::text AS updated_at, b.session_id, st.booking_type, st.id AS service_type_id,
            (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS session_started,
            (SELECT COUNT(*) FROM booking_guests bg WHERE bg.booking_id = b.id)::int AS guest_count,
            CASE WHEN st.booking_type = 'public' THEN (
              SELECT to_jsonb(q)
              FROM quote_booking(b.session_id, b.customer_id,
                    ((SELECT COUNT(*) FROM booking_guests bg WHERE bg.booking_id = b.id) + 1)::int) q
              ORDER BY q.seat_no DESC
              LIMIT 1
            ) ELSE NULL END AS seat_quote,
            CASE WHEN st.booking_type = 'private' THEN (
              SELECT to_jsonb(t)
              FROM service_type_price_tiers t
              WHERE t.service_type_id = st.id
                AND t.band_id = b.band_id
                AND t.min_people <= (SELECT COUNT(*) FROM booking_guests bg WHERE bg.booking_id = b.id) + 1
                AND t.max_people >= (SELECT COUNT(*) FROM booking_guests bg WHERE bg.booking_id = b.id) + 1
              LIMIT 1
            ) ELSE NULL END AS tier_row,
            CASE WHEN st.booking_type = 'private' THEN (
              SELECT COALESCE(SUM(oli.discount_amount), 0)
              FROM order_line_items oli
              WHERE oli.booking_id = b.id AND oli.item_type = 'booking'
            ) ELSE 0 END AS promo_share
     FROM bookings b
     JOIN sessions s ON s.id = b.session_id
     JOIN service_types st ON st.id = s.service_type_id
     WHERE b.id = $1`,
    [bookingId]
  )
  const booking = bookingLookup.data[0]
  if (!booking) {
    return { added: false, reason: 'booking_not_found' }
  }
  if (booking.status === 'cancelled') {
    return { added: false, reason: 'booking_cancelled' }
  }
  // Any open reader payment: a first guest's price is already in price_paid, so a second would be
  // priced on money not collected, and a checkout's rollback deletes the booking.
  if (await anyReaderPaymentOpenOnBooking(bookingId)) {
    return { added: false, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
  }
  if (booking.session_started) {
    return { added: false, reason: 'session_already_started' }
  }

  const currentCount = booking.guest_count
  const maxGuests = booking.booking_type === 'public' ? MAX_GUESTS_PER_PUBLIC_BOOKING : MAX_GUESTS_PER_PRIVATE_BOOKING
  if (addingGuest && currentCount >= maxGuests) {
    return { added: false, limitReached: true, guest: null }
  }

  // --- Add-ons: priced exactly as New Order (shared/addonPricing), validated before anything is
  // taken. Membership-credit lines need a membership of this customer; the credit itself is
  // claimed (Herd and credits left) further down with the same helper New Order uses.
  const addonCatalog = await loadAddonCatalog(addonInputs.map((a) => a.addonId))
  const [hasActiveMembership, staffAccess] = await Promise.all([
    addonInputs.length > 0 ? customerHasActiveMembership(booking.customer_id) : Promise.resolve(false),
    addonInputs.length > 0 ? getStaffAccessRow(req.user.email) : Promise.resolve(null),
  ])
  const addonLines: Array<{
    addonId: string
    quantity: number
    unitPrice: number
    sku: string
    redemptionSource: 'paid' | 'membership_credit'
    membershipId: string | null
  }> = []
  for (const input of addonInputs) {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) return { added: false, reason: 'invalid_addon_quantity' }
    const addon = addonCatalog.get(input.addonId)
    if (!addon) return { added: false, reason: 'addon_not_found' }
    if (addon.active === false) return { added: false, reason: 'addon_inactive' }
    const system = addonSystemPrice(addon, hasActiveMembership)
    let unitPrice = system
    if (staffAccess?.can_manage_pricing === true && typeof input.unitPrice === 'number' && Number.isFinite(input.unitPrice)) {
      if (input.unitPrice < 0) return { added: false, reason: 'invalid_addon_price' }
      if (Math.round(input.unitPrice * 100) !== Math.round(system * 100) && !(input.priceOverrideReason ?? '').trim()) {
        return {
          added: false,
          reason: 'price_override_reason_required',
          message: 'An add-on price was changed from the system price — enter a reason for the change.',
        }
      }
      unitPrice = input.unitPrice
    }
    const redemptionSource = input.redemptionSource === 'membership_credit' ? 'membership_credit' : 'paid'
    if (redemptionSource === 'membership_credit' && !input.membershipId) {
      return { added: false, reason: 'addon_membership_id_required' }
    }
    addonLines.push({
      addonId: addon.id,
      quantity: input.quantity,
      unitPrice,
      sku: addon.sku ?? addon.id,
      redemptionSource,
      membershipId: redemptionSource === 'membership_credit' ? input.membershipId! : null,
    })
  }
  const creditMembershipIds = [...new Set(addonLines.filter((l) => l.membershipId).map((l) => l.membershipId!))]
  if (creditMembershipIds.length > 0) {
    const owned = await paddockData.query<{ id: string }>(
      `SELECT id FROM customer_memberships
       WHERE id = ANY($1::uuid[]) AND customer_id = $2 AND subscription_status = 'active'
         AND (cancel_effective_date IS NULL OR cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)`,
      [creditMembershipIds, booking.customer_id]
    )
    if (owned.data.length !== creditMembershipIds.length) return { added: false, reason: 'addon_membership_not_found' }
  }
  const addonsAmount =
    Math.round(addonLines.reduce((sum, l) => (l.redemptionSource === 'paid' ? sum + l.unitPrice * l.quantity : sum), 0) * 100) / 100

  // --- Resolve the price impact of adding this guest ---
  let amountDue = 0

  if (!addingGuest) {
    // Add-ons on their own: no seat to price.
  } else if (booking.booking_type === 'private') {
    // Private bookings are always real money — priced by headcount tier AT THE SESSION'S BAND
    // (band pricing). Crossing into a higher tier means the difference must be collected via a
    // real payment method (private bookings never use credit, per policy).
    const tier = booking.tier_row
    if (!tier) {
      return {
        added: false,
        reason: 'private_price_not_set',
        message: 'No private price is set for this group size and band — add one under Catalog → Session Types first.',
      }
    }
    if (tier.price === null) {
      return { added: false, reason: 'price_pending' }
    }
    // price_paid is net of any promo (Q24) and of any part refund, so both go back on before
    // comparing, or they would be asked for again as a tier difference (Q25, Q27). The difference
    // isn't discounted, and price_paid grows by exactly it, so price_paid stays what was actually
    // paid less what was given back, and Cancel & Refund gives back that. Money owed is still the
    // customer's, so it covers nothing here and stays owed.
    const groupPriceCovered =
      Number.parseFloat(booking.price_paid) -
      Number.parseFloat(booking.refund_owed_amount) +
      Number.parseFloat(booking.promo_share) +
      Number.parseFloat(booking.part_refunded_amount)
    amountDue = Math.max(0, Math.round((Number.parseFloat(tier.price) - groupPriceCovered) * 100) / 100)
  } else {
    // Public bookings are band-priced: the new guest's seat is quoted from the database's
    // quote_booking at the booking's session (party = current headcount + 1). Guests are ALWAYS
    // paid — never credit-covered — so the seat's full band price is due, no credit option exists
    // for guests, and useExistingCredit is rejected outright rather than honored.
    if (useExistingCredit) {
      return { added: false, reason: 'credit_not_available_for_guests' }
    }
    const seat = booking.seat_quote
    if (!seat) {
      return { added: false, reason: 'price_pending' }
    }
    amountDue = Number.parseFloat(seat.unit_price)
  }

  // Guests are never credit-covered under band pricing — reject the legacy useExistingCredit
  // choice outright rather than silently ignoring it.
  if (useExistingCredit) {
    return { added: false, reason: 'credit_not_available_for_guests' }
  }

  // The guest's seat goes on the booking's price_paid; the paid add-ons are charged with it but
  // recorded on their own add-on lines (as in New Order, add-ons aren't part of price_paid).
  const guestAmount = amountDue
  amountDue = Math.round((guestAmount + addonsAmount) * 100) / 100

  const priceImpact: AddBookingGuestPriceImpact = { amountDue, guestAmount, addonsAmount, creditAvailable: false }
  const decisionNeeded = amountDue > 0
  const decisionResolved = payment !== undefined
  if (decisionNeeded && !decisionResolved) {
    return { added: false, priceImpact }
  }
  const description = addingGuest
    ? addonLines.length > 0
      ? `Guest and add-ons added to booking ${bookingId}`
      : `Additional guest added to booking ${bookingId}`
    : `Add-ons added to booking ${bookingId}`

  // --- Resolve payment, then claim capacity and record the guest ---
  let priceIncrement = 0
  // Payment parts actually taken, tracked for the reversal paths below — any failure after one
  // of these is taken must put every part back (store credit 'redemption_reversal', gift card
  // balance restored, card charge refunded against its own PaymentIntent).
  let giftCardClaimedAmount = 0
  let cardChargedAmount = 0
  /** The saved-card charge's PaymentIntent — a reversal refunds exactly this. */
  let cardChargedPaymentIntentId: string | null = null
  const readerPending = payment?.method === 'reader'
  // Whether the extra money lands on its OWN payment order: the saved-card charge
  // (chargeSavedCard → the Worker writes its own 'paid' orders row) and the reader charge
  // (recordReaderChargeOrder at finalise) each create a separate order — exactly like the move
  // flow — so the booking's ORIGINAL order must NOT also gain a line/order_total bump for the
  // same money (that double-counted the guest: £35 of order rows for £17.50 actually paid).
  // Cash writes no separate order, so the original order's line + bump IS the single record;
  // the same applies when gift card/store credit covers everything (no method, remainder 0 —
  // there is no separate payment order to record it on).
  const cardRemainder = payment ? amountDue - (payment.giftCard?.amount ?? 0) - (payment.storeCredit?.amount ?? 0) : 0
  const separatePaymentOrder = readerPending || (payment?.method === 'card' && cardRemainder > 0.005)

  // Cash comes first, whatever the price has become: it is worked out again on this call and can
  // have gone up, come down, or dropped to nothing. Nothing has been claimed or written yet, so
  // there is nothing to put back.
  if (payment) {
    const giftCardAmount = payment.giftCard?.amount ?? 0
    const storeCreditAmount = payment.storeCredit?.amount ?? 0
    const remainder = amountLeftToPay(amountDue, giftCardAmount, storeCreditAmount)
    const cashRefusal = cashDifferenceRefusal(payment.method, remainder, payment.confirmedCashAmount)
    if (cashRefusal) {
      return { added: false, reason: cashRefusal.reason, message: cashRefusal.message, priceImpact }
    }
    // These hold when nothing is owed too: a price can fall to £0 after staff applied store credit,
    // which would otherwise be taken for a free guest. Each refusal carries the figures, because
    // the screen's can be out of date, and a price that rose from nothing has no payment choices
    // on screen until they move.
    if (exceedsAmount(giftCardAmount, amountDue)) {
      return { added: false, reason: 'gift_card_amount_exceeds_total', priceImpact }
    }
    if (exceedsAmount(giftCardAmount + storeCreditAmount, amountDue)) {
      return { added: false, reason: 'store_credit_amount_exceeds_total', priceImpact }
    }
    if (remainder > 0 && !payment.method) {
      return { added: false, reason: 'payment_method_required', priceImpact }
    }
    // New reader flow: no pre-charged PaymentIntent — the guest is added first (pending), then
    // the PaymentIntent is created with metadata and the frontend collects + finalises. There
    // must be something for the reader to charge. The screen only sends the reader with something
    // left to pay, so here the amount has changed.
    if (payment.method === 'reader' && remainder <= 0.005) {
      return { added: false, reason: 'payment_method_required', message: AMOUNT_CHANGED_MESSAGE, priceImpact }
    }
    priceIncrement = guestAmount
  }

  // Another press may be taking this same payment now: wait for it. Or one died after its charge,
  // having taken everything below too, and nothing gave it back: its seat, add-on credits, store
  // credit and gift card are counted as taken, and not taken again.
  const cardCharge = { flow: 'add_guest' as const, bookingId, customerId: booking.customer_id, bookingUpdatedAt: booking.updated_at, amount: amountLeftToPay(amountDue, payment?.giftCard?.amount ?? 0, payment?.storeCredit?.amount ?? 0) }
  const earlier = payment?.method === 'card' && cardCharge.amount > 0 ? await earlierCardCharge(cardCharge) : ({ state: 'none' } as const)
  if (earlier.state === 'in_progress') {
    return { added: false, reason: 'card_charge_in_progress', message: CARD_CHARGE_IN_PROGRESS_MESSAGE }
  }
  const resuming = earlier.state === 'resume'
  /** Whose parts this press holds: its own started row, or the dead press's it resumed. */
  let partsFrom: string | null = earlier.state === 'resume' ? earlier.startedId : null
  /** This press's own started row. */
  let ownStartedId: string | null = null

  // Claim capacity for the extra attendee only after the payment/credit decision is resolved, so
  // a capacity failure never leaves a charge or reserved credit with no guest to show for it.
  //
  // Private bookings are skipped entirely here: a private session claims its ENTIRE capacity the
  // moment the booking is first created (see shared/sessionCapacity.ts), regardless of that
  // booking's actual party size, so there is no additional capacity left to claim (or release)
  // when adding another guest within the same booking's max headcount — that headcount limit was
  // already enforced above via MAX_GUESTS_PER_PRIVATE_BOOKING. Attempting the usual +1 claim here
  // for a private booking would always fail (total_booked already equals capacity), incorrectly
  // rejecting every guest addition.
  let claimedExtraCapacity = addingGuest && booking.booking_type === 'public' && resuming
  if (addingGuest && booking.booking_type === 'public' && !resuming) {
    const claimResult = await paddockData.query<{ id: string }>(
      `UPDATE sessions SET total_booked = total_booked + 1, updated_at = now()
       WHERE id = $1 AND status = 'open' AND (capacity - total_booked) >= 1
       RETURNING id`,
      [booking.session_id]
    )
    if (claimResult.data.length === 0) {
      return { added: false, reason: 'insufficient_capacity' }
    }
    claimedExtraCapacity = true
  }

  // Add-on credits (membership_credit lines), claimed with New Order's helper (Herd and enough
  // credits left, re-checked inside the claim). A refusal releases what was claimed so far.
  const reservedAddonCredits: Array<{ membershipId: string; quantity: number }> = []
  const releaseReservedAddonCredits = async (): Promise<boolean> => {
    let ok = true
    for (const r of reservedAddonCredits.splice(0)) {
      try {
        await releaseMembershipAddonCredit(r.membershipId, r.quantity)
      } catch {
        ok = false
      }
    }
    return ok
  }
  for (const line of addonLines) {
    if (line.redemptionSource !== 'membership_credit' || !line.membershipId) continue
    if (resuming) {
      reservedAddonCredits.push({ membershipId: line.membershipId, quantity: line.quantity })
      continue
    }
    const reserved = await reserveMembershipAddonCredit(line.membershipId, line.quantity)
    if (!reserved.reserved) {
      await releaseReservedAddonCredits()
      if (claimedExtraCapacity) {
        try {
          await paddockData.query(`UPDATE sessions SET total_booked = total_booked - 1, updated_at = now() WHERE id = $1`, [
            booking.session_id,
          ])
        } catch {
          // Best-effort — the reason below is returned either way.
        }
      }
      return {
        added: false,
        reason: reserved.reason === 'membership_too_new' ? 'addon_membership_too_new' : 'insufficient_addon_membership_credit',
      }
    }
    reservedAddonCredits.push({ membershipId: line.membershipId, quantity: line.quantity })
  }

  // Card charges happen after capacity is claimed and the store credit is redeemed. Store credit
  // is claimed BEFORE the card money, and every failure below reverses everything taken so far
  // via reverseTakenMoney (seat released, positive 'redemption_reversal', gift card balance
  // restored, card charge refunded).
  let storeCreditClaimed = resuming && (payment?.storeCredit?.amount ?? 0) > 0
  let storeCreditTransactionId: string | null = null
  if (payment && payment.storeCredit && payment.storeCredit.amount > 0 && !resuming) {
    const applied = await applyStoreCredit({
      customerId: booking.customer_id,
      amount: -payment.storeCredit.amount,
      reason: 'redemption',
      bookingId,
      staffId: actingStaffId,
      note: `Store credit redeemed: ${description.toLowerCase()}.`,
    })
    if (!applied.ok) {
      // The seat (and any add-on credits) were already claimed above — release them so a failed
      // payment part never leaves phantom capacity or credits taken.
      await releaseReservedAddonCredits()
      if (claimedExtraCapacity) {
        try {
          await paddockData.query(
            `UPDATE sessions SET total_booked = total_booked - 1, updated_at = now() WHERE id = $1`,
            [booking.session_id]
          )
        } catch {
          // Best-effort — the reason below is returned either way; a retry re-claims cleanly.
        }
      }
      return {
        added: false,
        reason: applied.reason === 'insufficient_store_credit' ? 'store_credit_insufficient_or_invalid' : 'store_credit_failed',
      }
    }
    storeCreditClaimed = true
    storeCreditTransactionId = applied.transactionId ?? null
  }

  // Best-effort reversal of everything taken so far: the claimed seat, the store credit (positive
  // 'redemption_reversal' movement), the gift card balance, and the card charge (refunded via the
  // charge's own PaymentIntent — reverseSavedCardCharge). Returns true when every part was put back. Safe to call
  // more than once — only the first call reverses anything.
  let moneyReversed = false
  /** Set by reverseTakenMoney: another press (or this one's statement, whose answer was lost) wrote
   *  the booking with this payment, so it was taken once and not refunded. */
  let addedWithThisPayment = false
  const reverseTakenMoney = async (): Promise<boolean> => {
    if (moneyReversed) return true
    moneyReversed = true
    // A refunded PaymentIntent still replays as paid, so its key must be finished with before it is
    // refunded. If it can't be, everything stays taken, and pressing again finishes the guest. With
    // the key retired, a finished row for the payment means it is the booking's: never refunded, and
    // the parts go back only if the press that finished didn't count them as its own.
    if (cardChargedAmount > 0) {
      try {
        await retireCardCharge(bookingId)
      } catch {
        return false
      }
      if (cardChargedPaymentIntentId) {
        try {
          const winner = await cardChargeWinner(bookingId, cardChargedPaymentIntentId)
          addedWithThisPayment = winner !== null
          if (winner !== null && winner.partsFrom === partsFrom) return true
        } catch {
          return false
        }
      }
    }
    let allReversed = await releaseReservedAddonCredits()
    if (claimedExtraCapacity) {
      try {
        await paddockData.query(
          `UPDATE sessions SET total_booked = total_booked - 1, updated_at = now() WHERE id = $1`,
          [booking.session_id]
        )
      } catch {
        allReversed = false
      }
    }
    if (storeCreditClaimed && payment?.storeCredit) {
      const back = await storeCreditMoved({
        customerId: booking.customer_id,
        amount: payment.storeCredit.amount,
        reason: 'redemption_reversal',
        bookingId,
        staffId: actingStaffId,
        note: 'Automatic reversal — adding to the booking failed after the store credit was redeemed.',
      })
      if (!back) allReversed = false
    }
    if (giftCardClaimedAmount > 0 && payment?.giftCard) {
      try {
        // The claim only marks the card redeemed_at when it drives the balance to exactly zero —
        // restoring the balance past zero un-marks it (a card already redeemed at a positive
        // balance keeps its mark).
        await paddockData.query(
          `UPDATE gift_cards
           SET remaining_balance = remaining_balance + $1,
               redeemed_at = CASE WHEN remaining_balance <= 0 THEN NULL ELSE redeemed_at END,
               updated_at = now()
           WHERE id = $2`,
          [giftCardClaimedAmount, payment.giftCard.giftCardId]
        )
      } catch {
        allReversed = false
      }
    }
    if (cardChargedAmount > 0 && !addedWithThisPayment) {
      // Refund exactly the charge THIS call just took (its own PaymentIntent and amount); no
      // permission check — returning money the caller's own action just took must not depend on
      // can_issue_refunds.
      if (!cardChargedPaymentIntentId) {
        allReversed = false
      } else {
        const reversed = await reverseSavedCardCharge(cardChargedPaymentIntentId, cardChargedAmount).catch(() => ({ ok: false }))
        if (!reversed.ok) allReversed = false
      }
    }
    return allReversed
  }

  // Gift card before the card, as in Move and Settle: the card is the last thing taken, so a gift
  // card that can't be claimed never needs a refund. Debit and the redeemed-at mark run as CTEs in
  // one statement — the mark only fires when the debited balance hits zero.
  if (payment?.giftCard && amountDue > 0 && resuming) {
    giftCardClaimedAmount = payment.giftCard.amount
  } else if (payment?.giftCard && amountDue > 0) {
    let claim: { data: Array<{ id: string; remaining_balance: string }> }
    try {
      claim = await paddockData.query<{ id: string; remaining_balance: string }>(
        `WITH claim AS (
           UPDATE gift_cards SET remaining_balance = remaining_balance - $1, updated_at = now()
           WHERE id = $2 AND remaining_balance >= $3 AND voided IS NOT TRUE AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
           RETURNING id, remaining_balance
         ),
         mark_redeemed AS (
           UPDATE gift_cards SET redeemed_at = now()
           WHERE id = $4 AND redeemed_at IS NULL
             AND EXISTS (SELECT 1 FROM claim WHERE remaining_balance <= 0)
           RETURNING id
         )
         SELECT id, remaining_balance FROM claim`,
        [payment.giftCard.amount, payment.giftCard.giftCardId, payment.giftCard.amount, payment.giftCard.giftCardId]
      )
    } catch (err) {
      // A database error can't say whether the claim landed, unlike finding no row.
      const allReversed = await reverseTakenMoney()
      return {
        added: false,
        reason: allReversed ? 'guest_add_failed' : 'guest_add_failed_reversal_incomplete',
        message: `Claiming the gift card failed (${err instanceof Error ? err.message : String(err)}). Nothing was charged to the card. Check the gift card's balance before trying again.`,
      }
    }
    if (claim.data.length === 0) {
      const allReversed = await reverseTakenMoney()
      return { added: false, reason: allReversed ? 'gift_card_insufficient_or_invalid' : 'guest_add_failed_reversal_incomplete' }
    }
    giftCardClaimedAmount = payment.giftCard.amount
    // A zero remaining balance was already marked redeemed_at by the mark_redeemed CTE above.
  }

  // The order the Worker writes for a saved-card charge — the add-on lines are linked to it.
  let cardPaymentOrderId: string | null = null
  if (payment && payment.method === 'card' && cardCharge.amount > 0) {
    const remainder = cardCharge.amount
    try {
      const charged = await chargeBookingCard({
        ...cardCharge,
        staffId: actingStaffId,
        description,
        // A guest's payment is recorded as a booking line; an add-ons-only payment has none
        // (its money is on the add-on lines linked to this order).
        ...(addingGuest ? { lineItems: [{ itemType: 'booking' as const, quantity: 1, unitPrice: remainder, bookingId }] } : {}),
      })
      cardChargedAmount = remainder
      cardChargedPaymentIntentId = charged.paymentIntentId
      cardPaymentOrderId = charged.orderId
      ownStartedId = charged.startedId
      partsFrom ??= charged.startedId
      if (!cardPaymentOrderId && charged.paymentIntentId) {
        const byIntent = await paddockData.query<{ id: string }>(
          'SELECT id FROM orders WHERE stripe_payment_intent_id = $1 ORDER BY created_at DESC LIMIT 1',
          [charged.paymentIntentId]
        )
        cardPaymentOrderId = byIntent.data[0]?.id ?? null
      }
    } catch (err) {
      // Nothing has been written yet — put back the claimed seat, the store credit and the gift
      // card; the card charge never went through so there is nothing to refund. After the charge,
      // the only thing that can throw here is finding its order, and that refunds it too.
      const allReversed = await reverseTakenMoney()
      // No clear answer: the charge may land later. The parts are back, so the next press must take
      // them again rather than count them.
      const unsure = cardChargeUnsure(err)
      if (unsure) {
        const marked = allReversed && (await markCardChargePartsReturned(bookingId, [unsure.startedId, ...(partsFrom ? [partsFrom] : [])], actingStaffId))
        return {
          added: false,
          reason: unsure.message,
          message: marked
            ? unsure.message
            : `${unsure.message} Putting back the place, store credit or gift card didn't fully work: check the session's places, their balance and the gift card by hand.`,
        }
      }
      return { added: false, reason: err instanceof Error ? err.message : 'charge_failed' }
    }
  }

  // One atomic round-trip writes everything: the guest (when there is one), the booking's
  // price/party bump, the add-on lines, and the payment's own order when no separate payment order
  // records it. Every extra payment is recorded as its own order: the saved-card charge (the
  // Worker writes it) and the reader charge (recordReaderChargeOrder at finalise) already were;
  // cash / gift card / store credit now are too, instead of being added onto the booking's
  // ORIGINAL order — added there, that money counted towards the original order's card portion
  // (shared/orderCardPortion), so a later card refund could send back money the card never took.
  // The add-on lines carry the order that paid for them (order_id) so their refunds go against it.
  // A gift card part is recorded in gift_card_redemptions (it never was for add-ons / added guests,
  // so it was missing from the gift card's history) — on the reader path at finalise instead. The
  // values used more than once come from the params CTE, so every placeholder is bound once, in
  // ascending first-use order (see adjustVariantStock.ts).
  const giftCardPart = payment?.giftCard && giftCardClaimedAmount > 0 ? giftCardClaimedAmount : 0
  const cashOrOtherRemainder = Math.max(0, Math.round((cardRemainder) * 100) / 100)

  // New reader flow: create the PaymentIntent (metadata flow/record_id) first, as nothing is charged
  // until the frontend collects on the reader. The pending row then goes in with the guest, so
  // price_paid never holds this money without the row that stops it being refunded.
  // The reader takes only the part not already covered by the gift card/store credit — the same
  // remainder move/settle charge (and the figure the UI shows as "Charged on card reader now"). The
  // claimed gift/credit parts stay claimed on success and are reversed on cancel/failure; charging
  // the full amountDue here would double-charge the covered part.
  const readerChargeAmount = cardRemainder
  // Finalise links the add-on lines to the reader charge's order; an undo deletes them and gives
  // the add-on credits back. The statement below adds the guest row and those lines to this.
  const readerSnapshot: PendingReaderSnapshot = {
    customer_id: booking.customer_id,
    description,
    booking_id: bookingId,
    session_id: booking.session_id,
    ...(reservedAddonCredits.length > 0
      ? { addon_credits: reservedAddonCredits.map((r) => ({ membership_id: r.membershipId, quantity: r.quantity })) }
      : {}),
    price_increment: priceIncrement,
    claimed_extra_capacity: claimedExtraCapacity,
    ...(payment?.storeCredit && payment.storeCredit.amount > 0 ? { store_credit_amount: payment.storeCredit.amount } : {}),
    ...(payment?.giftCard && giftCardClaimedAmount > 0
      ? { gift_card: { gift_card_id: payment.giftCard.giftCardId, amount: giftCardClaimedAmount } }
      : {}),
  }
  let intent: { paymentIntentId: string; clientSecret: string } | null = null
  if (readerPending) {
    try {
      intent = await createTerminalPaymentIntent({
        params: {
          customerId: booking.customer_id,
          amount: readerChargeAmount,
          saveCard: false,
          metadata: { flow: 'add_guest', record_id: bookingId },
          description,
        },
      })
    } catch (err) {
      const allReversed = await reverseTakenMoney()
      const message = err instanceof Error ? err.message : String(err)
      return {
        added: false,
        reason: 'guest_add_failed',
        message: `Creating the card reader payment failed — the ${addingGuest ? 'guest was' : 'add-ons were'} removed and nothing was charged (${message})${
          allReversed ? '' : " — check the session's places, the store credit and the gift card by hand"
        }.`,
      }
    }
  }
  const ownPaymentOrder = !separatePaymentOrder && amountDue > 0
  const ownOrderPaymentMethod =
    giftCardPart > 0 && cashOrOtherRemainder > 0.005
      ? 'split'
      : giftCardPart > 0
        ? 'gift_card'
        : cashOrOtherRemainder > 0.005 && payment?.method === 'cash'
          ? 'cash'
          : null
  interface FinalWrite {
    guest: Record<string, unknown> | null
    order_id: string | null
    addon_line_ids: string[] | null
    pending_id: string | null
    allowed: boolean
  }
  // With no card charge, this press marks its own write (shared/pressFinished), so an answer lost
  // after the statement wrote is never undone. A card charge has its finished row for that.
  const pressId = cardChargedAmount > 0 ? null : newPressId()
  let finalResult: { data: FinalWrite[] }
  try {
    finalResult = await paddockData.query<FinalWrite>(
    `WITH p AS (
       SELECT $1::boolean AS add_guest, $2::text AS guest_name, $3::text AS guest_email, $4::numeric AS seat_price,
              $5::text AS seat_pay_by, $6::uuid AS booking_id, $7::numeric AS price_increment, $8::boolean AS own_order,
              $9::uuid AS customer_id, $10::numeric AS amount_due, $11::text AS payment_method, $12::uuid AS payment_order_id,
              $13::uuid[] AS addon_ids, $14::int[] AS addon_qty, $15::numeric[] AS addon_price, $16::text[] AS addon_sku,
              $17::text[] AS addon_src, $18::uuid[] AS addon_mem, $19::uuid AS gift_card_id, $20::numeric AS gift_amount,
              $21::boolean AS record_gift, $22::uuid AS store_credit_tx_id, $23::numeric AS seen_price_paid,
              $24::text AS reader_intent, $25::numeric AS reader_amount, $26::jsonb AS reader_snapshot,
              $27::int AS seen_party_size
     ),
     -- Nothing below happens unless this finds the booking still live, with the price_paid and party
     -- size this was worked out from and nothing open on the reader. It locks the row, so a statement
     -- that waited here checks the newest figures. The party size matters on its own: two free guests
     -- at once change no price_paid, and could both price at the old size and cross a tier unpaid.
     ok AS (
       SELECT b.id FROM bookings b, p
       WHERE b.id = p.booking_id AND b.status <> 'cancelled' AND b.price_paid = p.seen_price_paid
         AND b.party_size = p.seen_party_size
         AND ${CHARGE_KEY_STILL_STANDS('b', '$28')}
         AND ${NO_READER_PAYMENT_OPEN}
       FOR UPDATE OF b
     ),
     g AS (
       INSERT INTO booking_guests (guest_type, guest_name, guest_email, waiver_accepted, unit_price, pay_by, booking_id)
       SELECT 'additional_guest', p.guest_name, p.guest_email, false, p.seat_price, p.seat_pay_by, p.booking_id
       FROM p, ok WHERE p.add_guest
       RETURNING id, guest_name, guest_email, guest_type, unit_price, pay_by
     ),
     -- Always, add-ons alone too: updated_at is in the card charge's key, so a second add-on at the
     -- same price the same day would otherwise get the first payment back, and go unpaid.
     bk AS (
       UPDATE bookings b
       SET price_paid = b.price_paid + p.price_increment,
           party_size = b.party_size + CASE WHEN p.add_guest THEN 1 ELSE 0 END,
           guests_over_18_confirmed_at = CASE WHEN p.add_guest THEN COALESCE(b.guests_over_18_confirmed_at, now())
                                              ELSE b.guests_over_18_confirmed_at END,
           updated_at = now()
       FROM p, ok
       WHERE b.id = ok.id
       RETURNING b.id
     ),
     o AS (
       INSERT INTO orders (customer_id, order_total, payment_status, order_source, payment_method)
       SELECT p.customer_id, p.amount_due, 'paid', 'staff_created', p.payment_method FROM p, ok WHERE p.own_order
       RETURNING id
     ),
     -- The guest's seat is the order's booking line; add-on money lives on the add-on lines, so
     -- an add-ons-only order has no booking line (it can then reach 'refunded' when they are).
     oli AS (
       INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, booking_id)
       SELECT o.id, 'booking', 1, p.price_increment, p.price_increment, p.booking_id FROM o, p WHERE p.add_guest
       RETURNING id
     ),
     al AS (
       INSERT INTO addon_order_lines (booking_id, addon_id, quantity, price_at_purchase, sku_at_purchase,
                                      redemption_source, redeemed_membership_id, order_id)
       SELECT p.booking_id, x.addon_id, x.qty, x.price, x.sku, x.src, x.mem, COALESCE((SELECT id FROM o), p.payment_order_id)
       FROM p, ok, unnest(p.addon_ids, p.addon_qty, p.addon_price, p.addon_sku, p.addon_src, p.addon_mem)
              AS x(addon_id, qty, price, sku, src, mem)
       RETURNING id
     ),
     gcr AS (
       INSERT INTO gift_card_redemptions (gift_card_id, order_id, booking_id, amount_used, redeemed_at)
       SELECT p.gift_card_id, (SELECT id FROM o), p.booking_id, p.gift_amount, now() FROM p, ok WHERE p.record_gift
       RETURNING id
     ),
     sct AS (
       UPDATE store_credit_transactions t SET order_id = (SELECT id FROM o)
       FROM p
       WHERE t.id = p.store_credit_tx_id AND EXISTS (SELECT 1 FROM o)
       RETURNING t.id
     ),
     pending AS (
       INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status)
       SELECT 'add_guest', ok.id, p.reader_intent, p.reader_amount,
              p.reader_snapshot || jsonb_strip_nulls(jsonb_build_object(
                'guest_row_id', (SELECT id FROM g),
                'addon_line_ids', (SELECT jsonb_agg(id) FROM al)
              )),
              'pending'
       FROM p, ok WHERE p.reader_intent IS NOT NULL
       RETURNING id
     ),
     ${CHARGE_FINISHED_AUDIT('$29', '$30', '$31::boolean')},
     ${PRESS_FINISHED_AUDIT(
       '$32',
       `jsonb_build_object('press', $33::text, 'guest', (SELECT id FROM g), 'order', (SELECT id FROM o),
                           'addon_lines', (SELECT jsonb_agg(id) FROM al), 'pending', (SELECT id FROM pending))`,
       '$34::boolean'
     )}
     SELECT (SELECT to_jsonb(g) FROM g) AS guest, (SELECT id FROM o) AS order_id,
            (SELECT array_agg(id) FROM al) AS addon_line_ids,
            (SELECT id FROM pending) AS pending_id, EXISTS (SELECT 1 FROM ok) AS allowed,
            (SELECT count(*) FROM bk) AS booking_rows, (SELECT count(*) FROM oli) AS order_lines,
            (SELECT count(*) FROM gcr) AS gift_rows, (SELECT count(*) FROM sct) AS credit_rows`,
    [
      addingGuest,                                                         // $1
      addingGuest ? guestName : null,                                      // $2
      guestEmail?.trim() || null,                                          // $3
      addingGuest && booking.booking_type === 'public' ? guestAmount : null, // $4
      addingGuest && booking.booking_type === 'public' ? 'paid' : null,    // $5
      bookingId,                                                           // $6
      priceIncrement,                                                      // $7
      ownPaymentOrder,                                                     // $8
      booking.customer_id,                                                 // $9
      amountDue,                                                           // $10
      ownOrderPaymentMethod,                                               // $11
      cardPaymentOrderId,                                                  // $12
      addonLines.map((l) => l.addonId),                                    // $13
      addonLines.map((l) => l.quantity),                                   // $14
      addonLines.map((l) => l.unitPrice),                                  // $15
      addonLines.map((l) => l.sku),                                        // $16
      addonLines.map((l) => l.redemptionSource),                           // $17
      addonLines.map((l) => l.membershipId),                               // $18
      payment?.giftCard?.giftCardId ?? null,                               // $19
      giftCardPart,                                                        // $20
      giftCardPart > 0 && !readerPending,                                  // $21
      ownPaymentOrder ? storeCreditTransactionId : null,                   // $22
      Number.parseFloat(booking.price_paid),                               // $23
      intent?.paymentIntentId ?? null,                                     // $24
      readerChargeAmount,                                                  // $25
      JSON.stringify(readerSnapshot),                                      // $26
      booking.party_size,                                                  // $27
      cardChargedAmount > 0 ? booking.updated_at : null,                   // $28
      actingStaffId,                                                       // $29
      chargeFinishedDetails(
        cardCharge,
        cardChargedAmount > 0 && partsFrom && ownStartedId ? { paymentIntentId: cardChargedPaymentIntentId, partsFrom, by: ownStartedId, resumed: resuming } : null
      ),                                                                   // $30
      cardChargedAmount > 0,                                               // $31
      actingStaffId,                                                       // $32
      pressId,                                                             // $33
      pressId !== null,                                                    // $34
    ]
    )
  } catch {
    // The statement may have written and lost its answer: then its row is there, and the add goes on
    // as if the answer had come back (the screen reloads the booking for the guest). Not there:
    // nothing was written, so everything goes back below.
    let landed: Record<string, unknown> | null = null
    if (pressId) {
      try {
        landed = await findPressFinished(bookingId, pressId)
      } catch {
        return { added: false, reason: 'guest_add_failed_reversal_incomplete', message: ADD_SAVE_UNCLEAR_MESSAGE }
      }
    }
    if (landed) {
      const addonLines = landed['addon_lines']
      finalResult = {
        data: [
          {
            guest: null,
            order_id: detailId(landed, 'order'),
            addon_line_ids: Array.isArray(addonLines) ? addonLines.filter((id): id is string => typeof id === 'string') : null,
            pending_id: detailId(landed, 'pending'),
            allowed: true,
          },
        ],
      }
    } else {
      // The final write failed AFTER the money was taken — without this reversal the customer
      // would be charged with nothing added and the claimed seat / add-on credits held. Put
      // everything back: the seat, the add-on credits, the store credit, the gift card balance,
      // and the card charge (refunded against its own PaymentIntent).
      const allReversed = await reverseTakenMoney()
      if (allReversed && addedWithThisPayment) return { added: false, reason: 'already_added', message: ADDED_WITH_THIS_PAYMENT }
      if (!allReversed) {
        return { added: false, reason: 'guest_add_failed_reversal_incomplete' }
      }
      return { added: false, reason: 'guest_add_failed' }
    }
  }
  if (finalResult.data[0]?.allowed !== true) {
    // Nothing was written. Whatever the reader's PaymentIntent was for, nobody can collect it.
    const allReversed = await reverseTakenMoney()
    if (allReversed && addedWithThisPayment) return { added: false, reason: 'already_added', message: ADDED_WITH_THIS_PAYMENT }
    if (!allReversed) return { added: false, reason: 'guest_add_failed_reversal_incomplete' }
    if (await anyReaderPaymentOpenOnBooking(bookingId)) {
      return { added: false, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
    }
    return {
      added: false,
      reason: 'booking_changed',
      message: 'The booking changed while this was being added, so nothing was added and any payment was put back. Check it and try again.',
    }
  }
  const addonLineIds = finalResult.data[0]?.addon_line_ids ?? []

  // The guest is added and PENDING: hand back to the frontend to collect on the reader. A reader
  // failure calls cancelReaderPayment, which removes the guest and releases the seat.
  if (intent) {
    return {
      added: true,
      guest: finalResult.data[0]?.guest ?? null,
      addonLineIds,
      pendingReaderPayment: {
        flow: 'add_guest',
        recordId: bookingId,
        pendingId: finalResult.data[0]!.pending_id!,
        paymentIntentId: intent.paymentIntentId,
        clientSecret: intent.clientSecret,
        amount: readerChargeAmount,
      },
    }
  }

  return { added: true, limitReached: false, guest: finalResult.data[0]?.guest ?? null, addonLineIds }
}
