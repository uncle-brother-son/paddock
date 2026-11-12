import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { staffAppDir } from './rules/testing/staff-app-dir'

// Brief W14a: the staff app's pure helpers for the checkout switch, tested by what they do (the staff app
// has no test runner of its own). The wrappers themselves run against the real routes in
// rules/orders/order-switch.test.ts and in the replay.

const appDir = staffAppDir()
const backend = () => import(/* @vite-ignore */ path.join(appDir, 'backend/paddock/shared/orderWorker'))
const callWorker = () => import(/* @vite-ignore */ path.join(appDir, 'backend/paddock/shared/callWorker'))
const answers = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/orderAnswers'))
const quoteHelpers = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/basketQuote'))

const OUTAGE =
  "The booking system can't be reached, so orders can't be taken right now. Don't take any payment. Note the customer's details and add the order once it's back."
// W14a2 (W14a review S1, Wayne's words): an order press with no answer may have placed the order.
const ORDER_NO_ANSWER =
  "Complete Order didn't get an answer, so the order may or may not have gone through. Don't take any payment. Check the Orders page before trying again. If the booking system can't be reached, note the customer's details and check the Orders page before adding the order once it's back."

async function workerError(code: string, message: string, details?: unknown) {
  const { WorkerError } = await callWorker()
  return new WorkerError({ code, message, ...(details !== undefined ? { details } : {}) }, 'req-1')
}

describe('the key rule (W03-plan 2.6)', () => {
  const cases: Array<[string, unknown, 'new' | 'keep']> = [
    ['the call threw (no answer)', undefined, 'keep'],
    ['an order', { success: true }, 'new'],
    ['an old-code refusal', { success: false, reason: 'insufficient_capacity' }, 'new'],
    ['a Worker refusal', { success: false, reason: 'cash_amount_changed', workerCode: 'TOTAL_CHANGED' }, 'new'],
    ['T1 rolled back (order_not_saved)', { success: false, reason: 'order_not_saved', workerCode: 'INTERNAL' }, 'new'],
    ['VALIDATION from the route', { success: false, reason: 'validation', workerCode: 'VALIDATION' }, 'new'],
    ['WORKER_UNREACHABLE', { success: false, reason: 'worker_unreachable', workerCode: 'WORKER_UNREACHABLE' }, 'keep'],
    ['CONFLICT (still running)', { success: false, reason: 'still_processing', workerCode: 'CONFLICT' }, 'keep'],
    ['IDEMPOTENCY_MISMATCH', { success: false, reason: 'changed_after_no_answer', workerCode: 'IDEMPOTENCY_MISMATCH' }, 'keep'],
    ['PAYMENT_UNCONFIRMED (held)', { success: false, reason: 'payment_unconfirmed', workerCode: 'PAYMENT_UNCONFIRMED' }, 'keep'],
    ['INTERNAL that may not have finished', { success: false, reason: 'internal', workerCode: 'INTERNAL' }, 'keep'],
  ]
  it.each(cases)('%s', async (_, answer, next) => {
    const { keyAfterAnswer } = await answers()
    expect(keyAfterAnswer(answer)).toBe(next)
  })
})

describe('the createOrder wrapper: what it sends and what the screen gets', () => {
  it('drops both keys and sends confirmed', async () => {
    const { orderBody } = await backend()
    const params = {
      customerId: 'c1',
      membershipIdempotencyKey: 'basket',
      idempotencyKey: 'press',
      confirmed: { amountDue: 30, toCollect: 25, firstInvoice: 0 },
      payment: { method: 'cash', confirmedCashAmount: 25, storeCredit: { amount: 5 } },
    }
    expect(orderBody(params)).toEqual({ customerId: 'c1', payment: { method: 'cash', storeCredit: { amount: 5 } }, confirmed: { amountDue: 30, toCollect: 25, firstInvoice: 0 } })
    // An old caller (the replay's scenarios): the tick becomes confirmed.toCollect.
    expect(orderBody({ customerId: 'c1', payment: { method: 'cash', confirmedCashAmount: 12 } })).toEqual({ customerId: 'c1', payment: { method: 'cash' }, confirmed: { toCollect: 12 } })
  })

  it("maps a paid order and a pending reader order to createOrder's fields", async () => {
    const { resultFromWorker } = await backend()
    const payment = { method: 'split', collected: 10, cardCharged: false, giftCardApplied: 5, storeCreditApplied: 0 }
    expect(
      resultFromWorker({ orderId: 'o1', status: 'paid', bookingId: 'b1', sessionPassId: null, giftCardId: null, giftCardCode: null, eventBookingId: null, membershipId: 'm1', membershipSubscription: { subscriptionId: 'sub_1', amountPaid: 40, invoiceId: null }, payment })
    ).toEqual({ success: true, orderId: 'o1', bookingId: 'b1', membershipId: 'm1', cardCharged: false, cardAmount: 10, giftCardRedeemedAmount: 5, paymentMethodUsed: 'split', membershipSubscriptionId: 'sub_1', membershipAmountPaid: 40 })
    const pendingReaderPayment = { orderId: 'o2', paymentIntentId: 'pi_1', clientSecret: 'secret', amount: 15 }
    expect(
      resultFromWorker({ orderId: 'o2', status: 'pending_reader', bookingId: null, sessionPassId: null, giftCardId: null, giftCardCode: null, eventBookingId: null, payment: { ...payment, method: 'reader' }, pendingReaderPayment })
    ).toEqual({ success: true, orderId: 'o2', cardCharged: false, paymentMethodUsed: 'reader', pendingReaderPayment })
  })

  it('a refusal keeps the old function\'s own words (the screen composes them as before), with the code', async () => {
    const { resultFromWorkerError } = await backend()
    // Over the amount: the map's words then the function's, so `message` is only the function's (none here).
    const over = await workerError('VALIDATION', 'The gift card + store credit amounts cannot exceed the amount due.', { stage: 'payment', reason: 'store_credit_amount_exceeds_total', amountDueTotal: 30 })
    expect(resultFromWorkerError(over)).toEqual({ success: false, stage: 'payment', reason: 'store_credit_amount_exceeds_total', amountDueTotal: 30, workerCode: 'VALIDATION' })
    // A new reason with no words of the old function: the Worker's words, without the bracketed code.
    const q10 = await workerError('VALIDATION', 'This customer has an order still being processed.', { stage: 'payment', reason: 'order_still_processing' })
    expect(resultFromWorkerError(q10)).toMatchObject({ reason: 'order_still_processing', message: 'This customer has an order still being processed.', workerCode: 'VALIDATION' })
    const held = await workerError('PAYMENT_UNCONFIRMED', 'On hold.', { stage: 'payment', reason: 'payment_unconfirmed', message: 'On hold.', orderId: 'o1' })
    expect(resultFromWorkerError(held)).toMatchObject({ reason: 'payment_unconfirmed', message: 'On hold.', workerCode: 'PAYMENT_UNCONFIRMED' })
  })

  it('no answer to an order press is the no-answer words, not Q15\'s; CONFLICT and a changed basket have words of their own', async () => {
    const { resultFromWorkerError, STILL_RUNNING_MESSAGE, CHANGED_AFTER_NO_ANSWER_MESSAGE } = await backend()
    expect(resultFromWorkerError(await workerError('WORKER_UNREACHABLE', 'Could not reach the Worker'))).toEqual({ success: false, reason: 'worker_unreachable', message: ORDER_NO_ANSWER, workerCode: 'WORKER_UNREACHABLE' })
    expect(resultFromWorkerError(new Error('boom'))).toMatchObject({ reason: 'worker_unreachable', message: ORDER_NO_ANSWER })
    expect(resultFromWorkerError(new Error('boom')).message).not.toBe(OUTAGE)
    expect(resultFromWorkerError(await workerError('CONFLICT', 'This request is already being processed'))).toEqual({ success: false, reason: 'still_processing', message: STILL_RUNNING_MESSAGE, workerCode: 'CONFLICT' })
    expect(resultFromWorkerError(await workerError('IDEMPOTENCY_MISMATCH', 'x'))).toMatchObject({ message: CHANGED_AFTER_NO_ANSWER_MESSAGE })
    expect(resultFromWorkerError(await workerError('FORBIDDEN', 'Your staff account is inactive.'))).toEqual({ success: false, reason: 'forbidden', message: 'Your staff account is inactive.', workerCode: 'FORBIDDEN' })
  })

  it('finalise and cancel: a failed call says the tap may or may not be dealt with; a refusal keeps its words', async () => {
    const { readerStepFailure, READER_STEP_NO_ANSWER_MESSAGE } = await backend()
    for (const code of ['WORKER_UNREACHABLE', 'CONFLICT', 'INTERNAL']) {
      expect(readerStepFailure(await workerError(code, 'x'))).toEqual({ reason: 'no_answer', message: READER_STEP_NO_ANSWER_MESSAGE })
    }
    expect(readerStepFailure(await workerError('VALIDATION', 'orderId: Invalid UUID'))).toEqual({ reason: 'validation', message: 'orderId: Invalid UUID' })
  })
})

describe('the result line (checklist 14, W9-7, Q9, review finding 10)', () => {
  const base = { methodSent: null, collected: 0, giftCardApplied: 0, storeCreditApplied: 0, promo: null, membership: null }
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['cash and gift card / store credit: the cash part counted', { methodSent: 'cash', collected: 10, giftCardApplied: 3, storeCreditApplied: 2 }, 'Paid £10.00 in cash and £5.00 by gift card / store credit.'],
    ['cash alone', { methodSent: 'cash', collected: 12.5 }, 'Paid £12.50 in cash.'],
    ['store credit alone: never "in cash"', { storeCreditApplied: 20 }, 'Paid £20.00 by gift card / store credit.'],
    ['a gift card with cash sent but nothing left for it', { methodSent: 'cash', collected: 0, giftCardApplied: 20 }, 'Paid £20.00 by gift card / store credit.'],
    ['the saved card', { methodSent: 'card', collected: 24 }, 'Paid £24.00 by saved card.'],
    ['the reader with a gift card', { methodSent: 'reader', collected: 15, giftCardApplied: 5 }, 'Paid £15.00 on the card reader and £5.00 by gift card / store credit.'],
    ['nothing owed', {}, 'Nothing was charged.'],
    ['a promo: "you save", no minus sign', { methodSent: 'cash', collected: 40.5, promo: { code: 'ALLTEN', discount: 4.5 } }, 'Paid £40.50 in cash. Promo code ALLTEN: you save £4.50.'],
    [
      'a membership on the saved card with soaps',
      { methodSent: 'card', collected: 64, membership: { onReader: false, firstInvoicePaid: 40 } },
      'Membership subscription started — Stripe charged £40.00 to the saved card for the first period. Paid £24.00 by saved card.',
    ],
    [
      'a membership on the reader',
      { methodSent: 'reader', collected: 40, membership: { onReader: true, firstInvoicePaid: 0 } },
      'Membership subscription started — the first payment was taken on the card reader; renewals bill the saved card. Paid £40.00 on the card reader.',
    ],
  ]
  it.each(cases)('%s', async (_, input, line) => {
    const { paymentSummaryLine } = await answers()
    expect(paymentSummaryLine({ ...base, ...input })).toBe(line)
  })
})

describe('reader finalise answers that hold the order', () => {
  it('held or unclear: critical; refunded and rolled back, or simply not done: not', async () => {
    const { readerAlertIsCritical } = await answers()
    for (const reason of ['finalise_failed', 'charged_without_order', 'compensation_unfinished', 'subscription_starting', 'no_answer', 'refund_failed', 'amount_mismatch']) {
      expect(readerAlertIsCritical({ reason })).toBe(true)
    }
    expect(readerAlertIsCritical({ reason: 'subscription_failed', rolledBack: true })).toBe(false)
    expect(readerAlertIsCritical({ reason: 'order_not_found' })).toBe(false)
    expect(readerAlertIsCritical(undefined)).toBe(false)
  })
})

describe('New Order on the basket quote', () => {
  const totals = {
    orderTotal: 104,
    promoDiscount: 4,
    nonMembershipDue: 60,
    membershipFirstPayment: 40,
    amountDue: 100,
    giftCardApplied: 0,
    storeCreditApplied: 70,
    spillToMembership: 10,
    spillFromStoreCredit: 10,
    spillFromGiftCard: 0,
    membershipToPay: 30,
    toCollect: { card: 0, reader: 30, cash: 0 },
    firstInvoice: 30,
  }
  const quote = {
    lines: [
      { kind: 'membership', key: 'membership', name: 'Core', lineTotal: 44, discount: 4 },
      { kind: 'product', key: 'product:0', name: 'Soap', lineTotal: 60, discount: 0 },
    ],
    postage: null,
    promo: { code: 'FOUR', discountTotal: 4, perLine: [{ key: 'membership', discount: 4 }] },
    totals,
    problems: [] as Array<{ stage: string; reason: string; message?: string }>,
  }

  it('the payment step shows only the quote\'s figures', async () => {
    const { quotePaymentFigures } = await quoteHelpers()
    expect(quotePaymentFigures(quote)).toEqual({
      amountDueNow: 60,
      totalDueNow: 100,
      remainder: 0,
      membershipAmount: 44,
      promoMembershipDiscount: 4,
      spillFromStoreCredit: 10,
      spillFromGiftCard: 0,
      membershipFirstPaymentCharged: 30,
      readerCharge: 30,
      postageAmount: 0,
      promoCode: 'FOUR',
      promoDiscountTotal: 4,
    })
  })

  it('Add Guest, Move and Settle keep their own sums, as before', async () => {
    const { legacyPaymentFigures } = await quoteHelpers()
    const figures = legacyPaymentFigures({ amountDue: 30, membershipAmount: 0, postageAmount: 0, promoCode: null, promoDiscountTotal: 0, promoMembershipDiscount: 0, giftCardApplied: 10, storeCreditApplied: 5 })
    expect(figures).toMatchObject({ amountDueNow: 30, totalDueNow: 30, remainder: 15, readerCharge: 15, membershipFirstPaymentCharged: 0 })
    // Pennies noise: £1.00 less 95p and 5p leaves nothing.
    expect(legacyPaymentFigures({ amountDue: 1, membershipAmount: 0, postageAmount: 0, promoCode: null, promoDiscountTotal: 0, promoMembershipDiscount: 0, giftCardApplied: 0.95, storeCreditApplied: 0.05 }).remainder).toBe(0)
  })

  it('confirmed is what staff saw: the amount due, what the method takes now, and a membership\'s first invoice', async () => {
    const { confirmedFigures } = await quoteHelpers()
    expect(confirmedFigures(totals, 'reader', null, true)).toEqual({ amountDue: 100, toCollect: 30, firstInvoice: 30 })
    expect(confirmedFigures(totals, 'card', null, true)).toEqual({ amountDue: 100, toCollect: 0, firstInvoice: 30 })
    expect(confirmedFigures({ ...totals, toCollect: { card: 12, reader: 12, cash: 12 } }, 'cash', 12, false)).toEqual({ amountDue: 100, toCollect: 12 })
    // An unticked cash figure confirms nothing (the order then refuses it).
    expect(confirmedFigures(totals, 'cash', null, false)).toEqual({ amountDue: 100, toCollect: 0 })
  })

  it('W9-8: the store credit follows the amount due down, never up', async () => {
    const { storeCreditThatFits } = await quoteHelpers()
    expect(storeCreditThatFits(50, 45, 0)).toBe(45)
    expect(storeCreditThatFits(50, 45, 10)).toBe(35)
    expect(storeCreditThatFits(20, 45, 0)).toBe(20)
    expect(storeCreditThatFits(10, 5, 10)).toBe(0)
  })

  it('only a quote for exactly what is on screen counts', async () => {
    const { currentQuote } = await quoteHelpers()
    expect(currentQuote({ key: 'a', status: 'ready', quote, failure: null }, 'a')).toBe(quote)
    expect(currentQuote({ key: 'a', status: 'ready', quote, failure: null }, 'b')).toBeNull()
    expect(currentQuote({ key: 'a', status: 'loading', quote, failure: null }, 'a')).toBeNull()
    expect(currentQuote(null, 'a')).toBeNull()
  })

  it('a quote that couldn\'t come: Q15\'s words when the booking system can\'t be reached', async () => {
    const { quoteFailureWords, QUOTE_FAILED_MESSAGE } = await quoteHelpers()
    expect(quoteFailureWords({ ok: false, code: 'WORKER_UNREACHABLE', message: 'x' })).toBe(OUTAGE)
    expect(quoteFailureWords({ ok: false, code: 'VALIDATION', message: 'x' })).toBe(QUOTE_FAILED_MESSAGE)
    expect(quoteFailureWords(null)).toBe(QUOTE_FAILED_MESSAGE)
  })

  it('each step stops on its own problems only', async () => {
    const { quoteProblemWords } = await quoteHelpers()
    const words = (reason: string) => ({ insufficient_stock: 'Not enough stock.' })[reason]
    const withProblems = (problems: Array<{ stage: string; reason: string; message?: string }>) => ({ ...quote, problems })
    const address = { stage: 'validation', reason: 'shipping_address_required' }
    const method = { stage: 'payment', reason: 'payment_method_required' }
    const stock = { stage: 'product', reason: 'insufficient_stock' }
    const credit = { stage: 'validation', reason: 'store_credit_insufficient', message: 'Not enough store credit.' }
    expect(quoteProblemWords(withProblems([address, stock]), 'basket', words)).toBe('Not enough stock.')
    expect(quoteProblemWords(withProblems([address]), 'delivery', words)).toBeNull()
    expect(quoteProblemWords(withProblems([method]), 'payment', words)).toBeNull()
    expect(quoteProblemWords(withProblems([{ stage: 'payment', reason: 'membership_no_saved_card', message: 'Save a card.' }]), 'basket', words)).toBeNull()
    expect(quoteProblemWords(withProblems([credit]), 'payment', words)).toBe('Not enough store credit.')
    expect(quoteProblemWords(withProblems([{ stage: 'validation', reason: 'promo_code_invalid', message: 'No.' }]), 'payment', words)).toBeNull()
  })

  it('the promo box reads the quote: the code, its total, each line named', async () => {
    const { appliedPromo, promoRefusal } = await quoteHelpers()
    expect(appliedPromo(quote)).toEqual({ code: 'FOUR', discountTotal: 4, perLine: [{ key: 'membership', label: 'Core', discount: 4 }] })
    expect(promoRefusal({ ...quote, promo: null, problems: [{ stage: 'validation', reason: 'promo_code_invalid', message: 'Promo code "X" does not exist.' }] })).toBe('Promo code "X" does not exist.')
    expect(promoRefusal(quote)).toBeNull()
  })
})
