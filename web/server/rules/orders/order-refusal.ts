// The refusals of backend/paddock/createOrder.ts and createBooking.ts, as errors (W03-plan 2.3).
import 'server-only'
import type { ApiErrorCode, BasketProblem, OrderRefusalDetails } from '@/contracts'
import { ApiError } from '@/server/http/errors'
import { staffSees } from './failure-messages'

/** W03-plan 2.3's table. Anything it doesn't name is VALIDATION. */
const CODE_BY_REASON: Readonly<Record<string, ApiErrorCode>> = {
  cash_amount_changed: 'TOTAL_CHANGED',
  amount_changed: 'TOTAL_CHANGED',
  insufficient_capacity: 'SESSION_FULL',
  duplicate_day_booking: 'DAY_ALREADY_BOOKED',
  insufficient_stock: 'OUT_OF_STOCK',
  event_full: 'EVENT_SOLD_OUT',
  event_cancelled: 'EVENT_NOT_OPEN',
  event_not_on_sale: 'EVENT_NOT_OPEN',
  event_started: 'EVENT_NOT_OPEN',
  event_members_only: 'EVENT_NOT_OPEN',
  event_not_released_yet: 'EVENT_NOT_OPEN',
  guests_over_18_not_confirmed: 'AGE_CONFIRMATION_REQUIRED',
  charge_failed: 'PAYMENT_FAILED',
  membership_payment_failed: 'PAYMENT_FAILED',
  // W11: the reader's intent couldn't be made, so no payment could be taken.
  reader_intent_failed: 'PAYMENT_FAILED',
}

export function refusalCode(reason: string): ApiErrorCode {
  const named = CODE_BY_REASON[reason]
  if (named) return named
  return reason.endsWith('_not_found') ? 'NOT_FOUND' : 'VALIDATION'
}

/**
 * A refusal, thrown so that db.transaction rolls everything back: a `return` inside it would commit.
 * The message is what staff see; `details` is the old createOrder's answer, so the staff app can
 * give the screen what it reads today.
 */
export function orderRefusal(
  problem: BasketProblem,
  settings: { addonCreditWaitMonths?: number | null } = {},
  /** W10: a card that needs authentication is charge_failed, as the old route said, under its own code (W03-plan 2.3). */
  code: ApiErrorCode = refusalCode(problem.reason)
): ApiError {
  const details: OrderRefusalDetails = {
    stage: problem.stage,
    reason: problem.reason,
    ...(problem.message !== undefined ? { message: problem.message } : {}),
    ...(problem.bookingFailureReason !== undefined ? { bookingFailureReason: problem.bookingFailureReason } : {}),
    ...(problem.productVariantId !== undefined ? { productVariantId: problem.productVariantId } : {}),
    ...(problem.amountDueTotal !== undefined ? { amountDueTotal: problem.amountDueTotal } : {}),
    ...(problem.guestIndex !== undefined ? { guestIndex: problem.guestIndex } : {}),
  }
  return new ApiError(code, staffSees(problem, settings), { details })
}

/** Why an order is held pending (W10): its details, beside a refusal's stage and reason. */
export type UnconfirmedReason = 'payment_unconfirmed' | 'paid_not_finished' | 'charged_without_order'

/**
 * PAYMENT_UNCONFIRMED (W03-plan 2.5): the order is held pending, with its claims, because its card
 * payment isn't settled. It is never undone from here. `details` names the order so staff can find it,
 * and `logDetail` keeps what Stripe or the database said, for the log only.
 */
export function paymentUnconfirmed(reason: UnconfirmedReason, message: string, orderId: string, logDetail: string): ApiError {
  return new ApiError('PAYMENT_UNCONFIRMED', message, { details: { stage: 'payment', reason, message, orderId }, logDetail })
}

/** A booking refusal: createOrder answered these with the reason twice, once as bookingFailureReason. */
export function bookingRefusal(reason: string, message?: string): ApiError {
  return orderRefusal({ stage: 'booking', reason, bookingFailureReason: reason, ...(message !== undefined ? { message } : {}) })
}

/** The refusal an ApiError carries, when it is one of these. */
export function refusalDetails(err: unknown): OrderRefusalDetails | null {
  if (!(err instanceof ApiError)) return null
  const details = err.details as Partial<OrderRefusalDetails> | undefined
  return details && typeof details.reason === 'string' && typeof details.stage === 'string' ? (details as OrderRefusalDetails) : null
}
