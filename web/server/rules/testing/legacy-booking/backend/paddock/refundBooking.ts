import { requireCanIssueRefunds } from './shared/staffAccess'
import { resolveStaffId } from './shared/resolveStaffId'
import { READER_PAYMENT_OPEN_MESSAGE, anyReaderPaymentOpenOnBooking } from './shared/readerPaymentOpen'
import { cancelBookingAddonLines, describeAddonCancellation, type CancelAddonLinesResult } from './shared/bookingAddonCancellation'
import { REFUND_UNSURE_MESSAGE, auditBookingRefund, cancelAndRefundBooking, giveBookingMoneyBack, shortfallStaysOnBookingWarnings } from './shared/bookingRefund'
import { claimOwedMoney, claimPartRefund, clearOwedMoneyThatArrived, finishRefundClaim, putBackAsOwed, putBackPartRefund } from './shared/bookingMoneyClaim'
import { loadBookingMoneyLeft, type BookingMoneyLeft } from './shared/bookingMoneyLeft'

export type RefundMethod = 'card' | 'credit'

export interface RefundBookingParams {
  bookingId: string
  refundMethod: RefundMethod
  /** The amount staff confirmed, in pounds: refunds that much of the booking's seat money without
   *  cancelling it. Omitted: Cancel & Refund — the whole booking is refunded and cancelled. */
  amount?: number
  /** Part refund and It already arrived: why, required, at most 200 characters. */
  reason?: string
  /** With `amount`: Refund the rest, giving the money owed after a failed refund, and no more. */
  refundOwed?: boolean
  /** With `amount` and `reason`: It already arrived. What is owed reached the customer after all,
   *  so it comes off the booking and no money moves. `refundMethod` isn't used. */
  owedArrived?: boolean
  /** Cancel & Refund only (full refund): the booking's add-on lines to cancel and refund with the
   *  same method (staff untick any already used — those are kept with no refund). */
  addonLineIds?: string[]
}

export interface RefundBookingResponse {
  warning?: string
  cardRefundedAmount?: number
  storeCreditRefundedAmount?: number
  /** The customer's store credit balance after the refund (store credit part only). */
  storeCreditBalance?: number
  /** Set when add-on lines were sent with a full refund: what happened to them. */
  addons?: CancelAddonLinesResult & { summary: string }
  /** Part refund, Refund the rest and It already arrived: price_paid afterwards. */
  pricePaid?: number
  /** Nothing moved, because the amount staff confirmed isn't what would be given: the new figures. */
  refused?: { message: string; figures: BookingMoneyLeft }
  /** Nobody can say whether the money went, so it is on the booking as owed. The screen stops here:
   *  pressing again could pay it twice. */
  unsure?: { message: string }
}

const REASON_MAX_LENGTH = 200
const round2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => `£${n.toFixed(2)}`
/** Rounded first, as the cash rule is: taking pounds from pounds leaves noise. */
const overHalfPenny = (amount: number, limit: number) => Math.round((amount - limit) * 1e6) / 1e6 > 0.005
const detailOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** What a part refund, Refund the rest and It already arrived all refuse outright. */
async function liveBookingMoney(bookingId: string, amount: unknown): Promise<BookingMoneyLeft> {
  const figures = await loadBookingMoneyLeft(bookingId)
  if (!figures) throw new Error('Booking not found.')
  // price_paid stays on a cancelled booking after its refund, so it would pay out a second time.
  if (figures.status === 'cancelled') throw new Error('This booking is already cancelled.')
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !(round2(amount) > 0)) {
    throw new Error('The refund amount must be more than £0.')
  }
  return figures
}

function requiredReason(value: unknown, what: string): string {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (!reason) throw new Error(`A reason is required for ${what}.`)
  if (reason.length > REASON_MAX_LENGTH) throw new Error(`The reason must be ${REASON_MAX_LENGTH} characters or fewer.`)
  return reason
}

/** A claim touched no row, so nothing has moved: says what changed, with the new figures. */
async function refusedAfterClaim(bookingId: string): Promise<RefundBookingResponse> {
  const figures = await loadBookingMoneyLeft(bookingId)
  if (!figures) throw new Error('Booking not found.')
  if (figures.status === 'cancelled') throw new Error('This booking is already cancelled.')
  if (await anyReaderPaymentOpenOnBooking(bookingId)) throw new Error(READER_PAYMENT_OPEN_MESSAGE)
  return { refused: { message: 'The figures on this booking have just changed. Check them and confirm again.', figures } }
}

/** What Refund the rest and It already arrived both refuse: the amount must be what is owed. */
function owedRefusal(amount: number, figures: BookingMoneyLeft): RefundBookingResponse | null {
  if (figures.refundOwed <= 0) return { refused: { message: 'Nothing is owed on this booking any more.', figures } }
  if (overHalfPenny(amount, figures.refundOwed) || overHalfPenny(figures.refundOwed, amount)) {
    return { refused: { message: `The amount owed has changed to ${money(figures.refundOwed)}. Check it and confirm again.`, figures } }
  }
  return null
}

/** Part refund: gives `amount` of what is left, and keeps the booking. */
async function partRefund(args: {
  bookingId: string
  refundMethod: RefundMethod
  amount: number
  reason: unknown
  staffId: string | null
  user: User
}): Promise<RefundBookingResponse> {
  const { bookingId, refundMethod, amount, staffId } = args
  const figures = await liveBookingMoney(bookingId, amount)
  const reason = requiredReason(args.reason, 'a part refund')
  if (figures.left <= 0) {
    return { refused: { message: "There's nothing left to refund on this booking.", figures } }
  }
  if (overHalfPenny(amount, figures.left)) {
    return { refused: { message: `Only ${money(figures.left)} is left on this booking. Check the amount and confirm again.`, figures } }
  }
  const limit = refundMethod === 'card' ? figures.parts.card : figures.left
  if (overHalfPenny(amount, limit)) {
    const message =
      limit > 0
        ? `Only ${money(limit)} of card money is left on this booking. Check the amount and confirm again.`
        : 'No card money is left on this booking, so this can only go to store credit.'
    return { refused: { message, figures } }
  }
  const give = round2(Math.min(amount, limit))
  // part_refunded_amount is what Add Guest and Move read so that a part refund stays with the
  // customer (Q27, Q28), so it takes the whole amount staff agreed: what fails partway is goodwill
  // still on its way, and Refund the rest never raises it, so counting only what arrived would have
  // the next move ask the customer for that money.
  const claimId = await claimPartRefund({ bookingId, amount: give, seenPricePaid: figures.pricePaid, staffId, method: refundMethod, reason })
  if (!claimId) return refusedAfterClaim(bookingId)
  const given = await giveBookingMoneyBack({
    bookingId,
    customerId: figures.customerId,
    amount: give,
    method: refundMethod,
    staffId,
    user: args.user,
    note: `Booking partial refund: ${reason}`,
    recordCardOnLines: true,
    pricePaidBefore: figures.pricePaid,
  })
  if (!given.ok) {
    if (given.unsure) return keptAsOwed({ bookingId, claimId, staffId, amount: give })
    try {
      await putBackPartRefund(bookingId, give)
    } catch (err) {
      throw new Error(`${given.message} Putting the ${money(give)} back on the booking failed, so its price paid is that much too low: ${detailOf(err)}`)
    }
    await finishRefundClaim({ claimId, bookingId, staffId, outcome: 'put_back' })
    throw new Error(given.message)
  }
  const { cardRefunded, storeCreditRefunded } = given.result
  const owed = given.result.shortfall ?? 0
  const warnings = shortfallStaysOnBookingWarnings(given.result)
  // The money has gone, so a failure here is a warning, never a thrown error: staff would read that
  // as nothing refunded.
  const pricePaid = await keepStillOwed(bookingId, owed, figures.pricePaid - give, warnings)
  const auditWarning = await auditBookingRefund({
    action: 'booking.part_refund',
    bookingId,
    staffId,
    details: { amount: give, reason, method: refundMethod, cardRefunded, storeCreditRefunded, owed },
  })
  if (auditWarning) warnings.push(auditWarning)
  await finishRefundClaim({ claimId, bookingId, staffId, outcome: owed > 0 ? 'owed' : 'given', cardRefunded, storeCreditRefunded, owed })
  return {
    cardRefundedAmount: cardRefunded,
    storeCreditRefundedAmount: storeCreditRefunded,
    ...(given.result.storeCreditBalance !== undefined ? { storeCreditBalance: given.result.storeCreditBalance } : {}),
    ...(pricePaid !== undefined ? { pricePaid } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  }
}

/** No clear answer, and nothing else went: the claim stands, the money is owed, and staff check. */
async function keptAsOwed(args: { bookingId: string; claimId: string; staffId: string | null; amount: number }): Promise<RefundBookingResponse> {
  const { bookingId, claimId, staffId, amount } = args
  try {
    await putBackAsOwed(bookingId, amount)
  } catch (err) {
    throw new Error(`${REFUND_UNSURE_MESSAGE} Marking the ${money(amount)} as owed failed, so check the booking and add it by hand: ${detailOf(err)}`)
  }
  await finishRefundClaim({ claimId, bookingId, staffId, outcome: 'owed', owed: amount })
  return { unsure: { message: REFUND_UNSURE_MESSAGE } }
}

/** Puts back on the booking, as owed, what a claim took and didn't reach the customer. Answers
 *  price_paid afterwards, or nothing if that failed, when `warnings` says so. */
async function keepStillOwed(bookingId: string, owed: number, pricePaidAfterClaim: number, warnings: string[]): Promise<number | undefined> {
  if (owed <= 0) return round2(pricePaidAfterClaim)
  try {
    await putBackAsOwed(bookingId, owed)
    return round2(pricePaidAfterClaim + owed)
  } catch (err) {
    warnings.push(`Putting the ${money(owed)} that didn't go back on the booking failed, so it shows as refunded — check the booking and add it by hand: ${detailOf(err)}`)
    return undefined
  }
}

/** Refund the rest: gives exactly what a failed refund left owed. With card chosen, what the card
 *  can't take goes to store credit, so the whole amount is given. Never a part refund: this money
 *  was never paid toward the booking, so a move or a guest has nothing to count it against. */
async function refundTheRest(args: {
  bookingId: string
  refundMethod: RefundMethod
  amount: number
  staffId: string | null
  user: User
}): Promise<RefundBookingResponse> {
  const { bookingId, refundMethod, amount, staffId } = args
  const figures = await liveBookingMoney(bookingId, amount)
  const refusal = owedRefusal(amount, figures)
  if (refusal) return refusal
  const owedNow = figures.refundOwed
  const claimId = await claimOwedMoney({ bookingId, amount: owedNow, seenPricePaid: figures.pricePaid, staffId, method: refundMethod })
  if (!claimId) return refusedAfterClaim(bookingId)
  const given = await giveBookingMoneyBack({
    bookingId,
    customerId: figures.customerId,
    amount: owedNow,
    method: refundMethod,
    staffId,
    user: args.user,
    note: 'Refund the rest of a failed booking refund',
    recordCardOnLines: true,
    pricePaidBefore: figures.pricePaid,
  })
  if (!given.ok) {
    if (given.unsure) return keptAsOwed({ bookingId, claimId, staffId, amount: owedNow })
    try {
      await putBackAsOwed(bookingId, owedNow)
    } catch (err) {
      throw new Error(`${given.message} Putting the ${money(owedNow)} back on the booking failed, so it no longer shows as owed: ${detailOf(err)}`)
    }
    await finishRefundClaim({ claimId, bookingId, staffId, outcome: 'owed', owed: owedNow })
    throw new Error(given.message)
  }
  const { cardRefunded, storeCreditRefunded } = given.result
  const stillOwed = given.result.shortfall ?? 0
  const warnings = shortfallStaysOnBookingWarnings(given.result)
  // What failed again stays owed. As in a part refund, this can't be an error: the money has gone.
  const pricePaid = await keepStillOwed(bookingId, stillOwed, figures.pricePaid - owedNow, warnings)
  const auditWarning = await auditBookingRefund({
    action: 'booking.refund_owed',
    bookingId,
    staffId,
    details: { amount: owedNow, method: refundMethod, cardRefunded, storeCreditRefunded, owed: stillOwed },
  })
  if (auditWarning) warnings.push(auditWarning)
  await finishRefundClaim({ claimId, bookingId, staffId, outcome: stillOwed > 0 ? 'owed' : 'given', cardRefunded, storeCreditRefunded, owed: stillOwed })
  return {
    cardRefundedAmount: cardRefunded,
    storeCreditRefundedAmount: storeCreditRefunded,
    ...(given.result.storeCreditBalance !== undefined ? { storeCreditBalance: given.result.storeCreditBalance } : {}),
    ...(pricePaid !== undefined ? { pricePaid } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  }
}

/** It already arrived: staff found what is owed in the customer's balance, so paying it would give
 *  it twice. It comes off the booking, no money moves, and audit_log says who said so and why. */
async function owedArrived(args: { bookingId: string; amount: number; reason: unknown; staffId: string | null }): Promise<RefundBookingResponse> {
  const { bookingId, amount, staffId } = args
  const figures = await liveBookingMoney(bookingId, amount)
  const reason = requiredReason(args.reason, 'this')
  const refusal = owedRefusal(amount, figures)
  if (refusal) return refusal
  const cleared = await clearOwedMoneyThatArrived({ bookingId, amount: figures.refundOwed, seenPricePaid: figures.pricePaid, staffId, reason })
  if (!cleared) return refusedAfterClaim(bookingId)
  return { cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: round2(figures.pricePaid - figures.refundOwed) }
}

/**
 * Staff-facing booking refund (Cancel & Refund, Part refund, Refund the rest and It already
 * arrived): requires the caller to hold can_issue_refunds, since it moves money back to the customer. Done in Retool
 * (shared/bookingRefund) — card refunds name the PaymentIntent and amount on each order that paid
 * for the booking, capped at its card portion, the rest to store credit; the Worker's booking
 * refund endpoints are no longer called for money. Money-free cancellations (Cancel & return
 * credit, Cancel booking) go through cancelCreditBooking.ts instead and are open to all staff.
 * Failures are thrown with their message (the dialog shows it), including any warning about money
 * that had already moved.
 */
export default async function refundBooking(
  req: { params: RefundBookingParams; user: User }
): Promise<RefundBookingResponse> {
  await requireCanIssueRefunds(req.user.email)
  const { bookingId, refundMethod } = req.params
  if (!bookingId) throw new Error('bookingId is required')
  if (refundMethod !== 'card' && refundMethod !== 'credit') throw new Error('refundMethod must be "card" or "credit"')
  const staffId = await resolveStaffId(req.user.email)
  // The claims check this too, in the statement. This is what staff usually meet.
  if (await anyReaderPaymentOpenOnBooking(bookingId)) throw new Error(READER_PAYMENT_OPEN_MESSAGE)

  // Without an amount these would fall through to Cancel & Refund and cancel the booking.
  const aboutOwedMoney = req.params.refundOwed === true || req.params.owedArrived === true
  if (aboutOwedMoney && req.params.amount === undefined) throw new Error('The amount owed is required.')
  if (req.params.amount !== undefined) {
    const { amount } = req.params
    if (req.params.owedArrived === true) return owedArrived({ bookingId, amount, reason: req.params.reason, staffId })
    return req.params.refundOwed === true
      ? refundTheRest({ bookingId, refundMethod, amount, staffId, user: req.user })
      : partRefund({ bookingId, refundMethod, amount, reason: req.params.reason, staffId, user: req.user })
  }

  // Cancel & Refund.
  const cancelled = await cancelAndRefundBooking({ bookingId, method: refundMethod, staffId, user: req.user })
  if (cancelled.reason === 'refund_unsure') {
    return {
      unsure: { message: cancelled.message ?? REFUND_UNSURE_MESSAGE },
      ...(cancelled.warning ? { warning: cancelled.warning } : {}),
    }
  }
  if (!cancelled.cancelled) {
    throw new Error([cancelled.message ?? 'The booking could not be refunded.', cancelled.warning].filter(Boolean).join(' '))
  }
  const response: RefundBookingResponse = {
    cardRefundedAmount: cancelled.cardRefundedAmount ?? 0,
    storeCreditRefundedAmount: cancelled.storeCreditRefundedAmount ?? 0,
    ...(cancelled.storeCreditBalance !== undefined ? { storeCreditBalance: cancelled.storeCreditBalance } : {}),
    ...(cancelled.warning ? { warning: cancelled.warning } : {}),
  }

  // Cancel & Refund: the booking's ticked add-ons follow it, refunded the same way (card first on
  // their own order, the rest to store credit; credits back to the membership), under the same
  // 24-hour rule. The booking refund has already succeeded, so a failure here is a warning saying
  // exactly what needs refunding by hand.
  const addonLineIds = req.params.addonLineIds ?? []
  if (addonLineIds.length > 0) {
    try {
      const addons = await cancelBookingAddonLines({
        bookingId,
        lineIds: addonLineIds,
        refund: refundMethod,
        returnCredits: true,
        includePaidLines: true,
        staffId,
      })
      response.addons = { ...addons, summary: describeAddonCancellation(addons) }
      if (addons.warning) response.warning = response.warning ? `${response.warning} ${addons.warning}` : addons.warning
    } catch (err) {
      const note = `The booking was refunded, but refunding its add-ons failed — refund the ticked add-ons manually: ${err instanceof Error ? err.message : String(err)}`
      response.warning = response.warning ? `${response.warning} ${note}` : note
    }
  }
  return response
}
