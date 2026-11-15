// New in W33 (E-plan 4.11; Wayne's Q44, 15 Nov; lead call L9): the website's cancels, as the four customer routes
// call them. The rules are step D's and E's own, on the customer channel (bookings/cancel.ts cancelForCustomer,
// events/cancel-places.ts cancelEventPlacesForCustomer): this file only shapes the answers for a customer and puts
// every refusal into the customer's words (cancel-words.ts), so no staff sentence, staff figure (the card part, cash,
// money owed) or staff term reaches the website.
//
// A quote answers what a cancel would give and, in `blocked`, why it can't be made now; it is refused only for a
// booking that isn't the customer's (as not found) or a place that isn't on it. A cancel is refused with the same
// reasons and words, and with the quote as it now stands when the amount confirmed is missing or has changed (Q18).
import 'server-only'
import type {
  CustomerBookingCancelInput,
  CustomerBookingCancelOutput,
  CustomerBookingCancelQuote,
  CustomerCancelBlocked,
  CustomerContext,
  CustomerEventCancelInput,
  CustomerEventCancelOutput,
  CustomerEventCancelQuote,
} from '@/contracts'
import type { Db } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { cancelForCustomer, quoteCancelForCustomer } from '@/server/rules/bookings/cancel'
import { cancelEventPlacesForCustomer, quoteEventPlacesCancelForCustomer } from '@/server/rules/events/cancel-places'
import { CUSTOMER_BOOKING_REFUSAL_WORDS, CUSTOMER_CANCEL_WORDS, CUSTOMER_EVENT_REFUSAL_WORDS } from './cancel-words'

const round2 = (n: number): number => Math.round(n * 100) / 100

type Words = Readonly<Record<string, string>>

const reasonOf = (err: ApiError): string => (err.details as { reason?: string } | undefined)?.reason ?? 'refused'

const inWords = (reason: string, words: Words): CustomerCancelBlocked => ({ reason, message: words[reason] ?? CUSTOMER_CANCEL_WORDS.fallback })

/**
 * A rule's refusal as the customer is told it: the same code and reason, the customer's words, and nothing else of the
 * staff details. The staff words go to the log, so a refusal that fell back to "get in touch" can be traced.
 */
export function forCustomer(err: unknown, words: Words, quote?: CustomerBookingCancelQuote | CustomerEventCancelQuote): unknown {
  if (!(err instanceof ApiError)) return err
  const told = inWords(reasonOf(err), words)
  return new ApiError(err.code, told.message, {
    ...(err.field ? { field: err.field } : {}),
    logDetail: err.logDetail ?? `${told.reason}: ${err.message}`,
    details: { ...told, ...(quote ? { quote } : {}) },
  })
}

/** The amount the customer confirmed (Q18): required. */
function confirmedStoreCredit(input: { confirmed?: { storeCredit?: number | undefined } | undefined }): number {
  const amount = input.confirmed?.storeCredit
  if (typeof amount === 'number' && Number.isFinite(amount)) return amount
  const message = CUSTOMER_CANCEL_WORDS.amountNotConfirmed
  throw new ApiError('VALIDATION', message, { field: 'confirmed', details: { reason: 'amount_not_confirmed', message } })
}

// --- A session booking

/** POST /api/v1/customer/bookings/:bookingId/cancel/quote. */
export async function quoteCustomerBookingCancel(db: Db, bookingId: string, customer: CustomerContext): Promise<CustomerBookingCancelQuote> {
  try {
    const { quote, returnsCredit } = await quoteCancelForCustomer(db, bookingId, customer.customerId)
    const blocked = quote.blocked ? inWords(quote.blocked.reason, CUSTOMER_BOOKING_REFUSAL_WORDS) : null
    return { bookingId, canCancel: blocked === null, storeCredit: blocked ? 0 : round2(quote.refund + quote.addonsRefund), creditReturned: returnsCredit, blocked }
  } catch (err) {
    throw forCustomer(err, CUSTOMER_BOOKING_REFUSAL_WORDS)
  }
}

/** POST /api/v1/customer/bookings/:bookingId/cancel: the whole booking, everything paid to store credit, the credit back. */
export async function cancelCustomerBooking(db: Db, bookingId: string, input: CustomerBookingCancelInput, customer: CustomerContext, requestId: string): Promise<CustomerBookingCancelOutput> {
  const total = confirmedStoreCredit(input)
  try {
    const done = await cancelForCustomer(db, bookingId, { id: customer.customerId, total }, requestId)
    return {
      cancelled: true,
      bookingId,
      storeCreditRefunded: done.storeCreditRefunded,
      ...(done.storeCreditBalance !== undefined ? { storeCreditBalance: done.storeCreditBalance } : {}),
      creditReturned: done.returnsCredit,
      creditUsableAgain: done.creditUsableAgain,
      addonCreditsReturned: done.addonCreditsReturned,
    }
  } catch (err) {
    // Q18: the amount has changed. Nothing was cancelled; the quote is read again, as it now stands.
    const changed = err instanceof ApiError && reasonOf(err) === 'refund_changed'
    throw forCustomer(err, CUSTOMER_BOOKING_REFUSAL_WORDS, changed ? await quoteCustomerBookingCancel(db, bookingId, customer).catch(() => undefined) : undefined)
  }
}

// --- Event places

const blockedEventQuote = (eventBookingId: string, blocked: CustomerCancelBlocked): CustomerEventCancelQuote => ({
  eventBookingId,
  canCancel: false,
  places: 0,
  wholeBooking: false,
  storeCredit: 0,
  refundCutoffAt: null,
  blocked,
})

/**
 * POST /api/v1/customer/event-bookings/:eventBookingId/cancel/quote. A cancel that can't be made now (after the
 * cut-off, a payment or refund still open, a place checked in, a cancelled event) answers `blocked`; a booking that
 * isn't the customer's, or a place that isn't on it, is refused.
 */
export async function quoteCustomerEventCancel(db: Db, eventBookingId: string, attendeeIds: readonly string[] | undefined, customer: CustomerContext): Promise<CustomerEventCancelQuote> {
  try {
    const quote = await quoteEventPlacesCancelForCustomer(db, eventBookingId, attendeeIds, customer.customerId)
    return { eventBookingId, canCancel: true, places: quote.places, wholeBooking: quote.wholeBooking, storeCredit: quote.value, refundCutoffAt: quote.refundCutoffAt, blocked: null }
  } catch (err) {
    if (err instanceof ApiError && err.code === 'CONFLICT') return blockedEventQuote(eventBookingId, inWords(reasonOf(err), CUSTOMER_EVENT_REFUSAL_WORDS))
    throw forCustomer(err, CUSTOMER_EVENT_REFUSAL_WORDS)
  }
}

/** POST /api/v1/customer/event-bookings/:eventBookingId/cancel: chosen places, or the whole booking, to store credit. */
export async function cancelCustomerEventPlaces(db: Db, eventBookingId: string, input: CustomerEventCancelInput, customer: CustomerContext, requestId: string): Promise<CustomerEventCancelOutput> {
  const refund = confirmedStoreCredit(input)
  try {
    const done = await cancelEventPlacesForCustomer(db, eventBookingId, { attendeeIds: input.attendeeIds, confirmed: { refund } }, { id: customer.customerId }, requestId)
    return {
      cancelled: true,
      eventBookingId,
      places: done.places,
      storeCreditRefunded: done.storeCreditRefundedAmount,
      ...(done.storeCreditBalance !== undefined ? { storeCreditBalance: done.storeCreditBalance } : {}),
      bookingCancelled: done.booking?.status === 'cancelled',
      placesLeft: done.booking?.places ?? 0,
    }
  } catch (err) {
    const changed = err instanceof ApiError && reasonOf(err) === 'figures_changed'
    throw forCustomer(err, CUSTOMER_EVENT_REFUSAL_WORDS, changed ? await quoteCustomerEventCancel(db, eventBookingId, input.attendeeIds, customer).catch(() => undefined) : undefined)
  }
}
