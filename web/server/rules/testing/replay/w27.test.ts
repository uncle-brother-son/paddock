import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { EVENT_CANCEL_REASONS, EVENT_WHOLE_CANCEL_REASONS } from '@/server/rules/events/failure-messages'
import { ORDER_REFUND_REASONS } from '@/server/rules/refunds/failure-messages'
import { compareRecordings, type AllowedDifference, type Recording } from './compare'
import { LEGACY_REFUND_ACTIONS, legacyRefundDir, oldFunctionPath, oldSide, readGolden, replay, startReplay, type ReplayEnvironment, type ReplayOptions } from './harness'
import { scenarios, W27_PREFIX } from './scenarios'

// Brief W27 item 7 (E-plan 4.13 items 1 and 2, lead call L6): step E's golden files, recorded from the old
// refundOrder, cancelEventPlaces, cancelEvent, getEventCancellationQuote and getEventCancellationOverview while they
// still exist, and replayed against the frozen copy of them (legacy-refund/). `replay.test.ts` holds every scenario
// to its golden file, twice over (the same recording every time; it matches the file). This file says, in pounds and
// pence, what each W27 scenario proves on the old functions, so that a scenario that stopped reaching the branch it
// is named for fails here; that the list covers every refusal, every kind of line and every bug the plan names; and
// (brief item 8) that a deliberate difference from a golden file is caught and an allowance nobody needs fails.
//
// W28 to W31 replay these through the Worker's routes and name each difference. Until then they are the old code's.

vi.setConfig({ testTimeout: 30_000 })

const w27 = scenarios.filter((scenario) => scenario.name.startsWith(W27_PREFIX))
type Row = Record<string, unknown>
const money = (value: unknown): string => `£${Number(value ?? 0).toFixed(2)}`
const golden = (name: string): Recording => {
  const recording = readGolden(`${W27_PREFIX}${name}`)
  if (!recording) throw new Error(`No golden file for ${W27_PREFIX}${name}: record it with UPDATE_GOLDEN=1 (testing/README.md).`)
  return recording
}

/** One step's outcome in a line: who refused and why, or what went where, in pounds and pence. Null for the set-up's own order. */
function outcome(result: unknown): string | null {
  if (result === null) return 'null'
  if (typeof result !== 'object') return String(result)
  const r = result as Row
  if ('thrown' in r) return `thrown: ${String(r['thrown'])}`
  // createOrder's own answer (set-up): not a step of the functions under test.
  if (r['success'] === true && 'orderId' in r && !('refundedAmount' in r)) return null
  if ('finalised' in r) return r['finalised'] === true ? 'reader order finalised' : `reader order not finalised: ${String(r['reason'])}`
  if ('cancelled' in r) return r['cancelled'] === true ? 'reader order cancelled' : `reader order not cancelled: ${String(r['reason'])}`
  if (r['success'] === false || r['ok'] === false) return `refused: ${String(r['reason'])}${r['warning'] ? ' (+warning)' : ''}`
  const split = `card ${money(r['cardRefundedAmount'])}, store credit ${money(r['storeCreditRefundedAmount'])}`
  if (r['success'] === true) return `refunded ${money(r['refundedAmount'])} (${split})${r['orderPaymentStatus'] ? `, order ${String(r['orderPaymentStatus'])}` : ''}${r['warning'] ? ' (+warning)' : ''}`
  if (Array.isArray(r['results'])) {
    return `event cancelled: ${(r['results'] as Row[]).map((one) => `${String(one['customerName'])} ${one['ok'] === true ? `ok (card ${money(one['cardRefundedAmount'])}, store credit ${money(one['storeCreditRefundedAmount'])})` : 'failed'}`).join('; ') || 'no bookings'}`
  }
  if (Array.isArray(r['bookings'])) {
    const bookings = (r['bookings'] as Row[]).map((one) => `${String(one['customerName'])} ${String(one['places'])} ${money(one['value'])}${one['problem'] ? ' (problem)' : ''}`)
    const pending = (r['pendingCustomers'] as string[]).length > 0 ? `, pending ${(r['pendingCustomers'] as string[]).join(', ')}` : ''
    return `overview: ${bookings.join('; ') || 'nothing to cancel'}${pending}${r['cancelledAt'] ? `, cancelled (${String(r['cancelReason'])})` : ''}${r['ended'] === true ? ', ended' : ''}`
  }
  if ('value' in r) return `quote: ${String(r['places'])} worth ${money(r['value'])} (card ${money(r['cardAmount'])}, store credit ${money(r['storeCreditAmount'])})${r['beforeCutoff'] === true ? '' : ', after the cut-off'}`
  if (r['ok'] === true) {
    const booking = r['booking'] as Row | null
    return `cancelled ${String(r['places'])}: ${money(r['refundedAmount'])} (${split})${booking ? `, booking ${String(booking['status'])}` : ''}${r['warning'] ? ' (+warning)' : ''}`
  }
  return JSON.stringify(r)
}
const outcomes = (recording: Recording): string[] => recording.results.map(outcome).filter((line): line is string => line !== null)

/**
 * What each scenario's steps do on the old functions today, one line per step (the set-up's own order left out).
 * "refunded" is refundOrder; "cancelled N" is cancelEventPlaces; "quote" and "overview" the two reads; "event
 * cancelled" is cancelEvent, booking by booking. "(+warning)" marks a success, or a refusal, that left something for
 * staff to check by hand: the half-finished states step E's one transaction removes.
 */
const WHAT_EACH_PROVES: Readonly<Record<string, readonly string[]>> = {
  'order-refund-refused-no-staff-record': ['refused: permission_denied'],
  'order-refund-refused-inactive-staff': ['thrown: This staff account is inactive. Ask an admin to reactivate it.'],
  'order-refund-refused-without-issue-refunds': ['refused: permission_denied'],
  'order-refund-refused-no-lines-chosen': ['refused: invalid_params'],
  'order-refund-refused-no-order-id': ['refused: invalid_params'],
  'order-refund-refused-method-not-card-or-credit': ['refused: invalid_params'],
  'order-refund-refused-unknown-order': ['refused: order_not_found'],
  'order-refund-refused-line-of-another-order': ['refused: line_item_not_found'],
  'order-refund-refused-event-line': ['refused: use_event_cancellation'],
  'order-refund-refused-booking-line': ['refused: booking_not_supported'],
  'order-refund-refused-already-refunded': [
    'refunded £24.00 (card £24.00, store credit £0.00), order partially_refunded',
    'refused: already_refunded',
  ],
  'order-refund-refused-no-restock-decision': ['refused: restock_decision_required'],
  'order-refund-refused-gift-card-part-spent': ['refused: gift_card_already_redeemed'],
  'order-refund-refused-gift-card-voided': ['refused: gift_card_already_redeemed'],
  'order-refund-refused-gift-card-row-not-found': ['refused: gift_card_already_redeemed'],
  'order-refund-refused-pass-used': ['refused: session_pass_already_used'],
  'order-refund-refused-pass-row-not-found': ['refused: session_pass_instance_not_found'],
  'order-refund-refused-membership-row-not-found': ['refused: membership_instance_not_found'],
  'order-refund-refused-card-on-an-order-with-no-card-payment': ['refused: no_payment_intent_for_card_refund'],
  'order-refund-refused-by-stripe-then-pressed-again': [
    'refused: refund_failed',
    'refunded £24.00 (card £24.00, store credit £0.00), order refunded',
  ],
  'order-refund-refused-when-the-card-check-cannot-be-read': ['refused: refund_failed'],
  'order-refund-refused-when-the-look-for-a-held-refund-fails': ['refused: refund_unsure'],
  'order-refund-store-credit-write-fails': ['refused: store_credit_failed'],
  'order-refund-store-credit-fails-after-the-card-part': [
    'refunded £14.00 (card £14.00, store credit £0.00) (+warning)',
    'refunded £10.00 (card £0.00, store credit £10.00), order refunded',
  ],
  'order-refund-line-stamp-fails-to-store-credit-is-rolled-back': ['refused: unexpected_error'],
  'order-refund-line-stamp-fails-after-the-card-refund': [
    'refunded £24.00 (card £24.00, store credit £0.00) (+warning)',
    'refunded £24.00 (card £24.00, store credit £0.00), order refunded',
  ],
  'order-refund-product-to-card-no-restock': ['refunded £24.00 (card £24.00, store credit £0.00), order refunded'],
  'order-refund-product-to-card-with-restock': ['refunded £24.00 (card £24.00, store credit £0.00), order refunded'],
  'order-refund-product-to-store-credit': ['refunded £24.00 (card £0.00, store credit £24.00), order refunded'],
  'order-refund-cash-order-to-store-credit-with-restock': ['refunded £24.00 (card £0.00, store credit £24.00), order refunded'],
  'order-refund-split-card-and-store-credit': ['refunded £24.00 (card £14.00, store credit £10.00), order refunded'],
  'order-refund-gift-card-part-paid-split': ['refunded £24.00 (card £14.00, store credit £10.00), order refunded'],
  'order-refund-postage-line': ['refunded £4.95 (card £4.95, store credit £0.00), order partially_refunded'],
  'order-refund-shipped-product-and-its-postage': ['refunded £24.95 (card £24.95, store credit £0.00), order refunded'],
  'order-refund-standalone-addon': ['refunded £5.00 (card £5.00, store credit £0.00), order refunded'],
  'order-refund-gift-card-unspent-is-voided': ['refunded £60.00 (card £60.00, store credit £0.00), order refunded'],
  'order-refund-pass-unused-is-emptied': ['refunded £50.00 (card £50.00, store credit £0.00), order refunded'],
  'order-refund-pass-to-store-credit': ['refunded £50.00 (card £0.00, store credit £50.00), order refunded'],
  'order-refund-membership-on-saved-card': ['refunded £40.00 (card £40.00, store credit £0.00), order refunded'],
  'order-refund-membership-to-store-credit': ['refunded £40.00 (card £0.00, store credit £40.00), order refunded'],
  'order-refund-membership-with-no-subscription': ['refunded £40.00 (card £0.00, store credit £40.00), order refunded'],
  'order-refund-membership-bought-on-the-reader': [
    'reader order finalised',
    'refunded £40.00 (card £40.00, store credit £0.00), order refunded',
  ],
  'order-refund-payment-date-change-charge-is-a-plain-line': ['refunded £6.50 (card £6.50, store credit £0.00), order refunded'],
  'order-refund-promo-line-gives-back-what-was-paid': ['refunded £13.50 (card £13.50, store credit £0.00), order partially_refunded'],
  'order-refund-a-second-refund-on-the-same-order': [
    'refunded £24.00 (card £24.00, store credit £0.00), order partially_refunded',
    'refunded £15.00 (card £0.00, store credit £15.00), order refunded',
  ],
  'order-refund-two-lines-at-once-split': ['refunded £39.00 (card £19.00, store credit £20.00), order refunded'],
  'order-refund-every-kind-of-line-at-once': ['refunded £139.00 (card £139.00, store credit £0.00), order refunded'],
  'order-refund-answer-lost-then-pressed-again': [
    'refused: refund_unsure',
    'refunded £0.00 (card £0.00, store credit £0.00), order refunded',
  ],
  'order-refund-answer-lost-then-store-credit-chosen': [
    'refused: refund_unsure',
    'refunded £0.00 (card £0.00, store credit £0.00), order refunded',
  ],
  'order-refund-held-two-days-then-found-by-its-key': [
    'refused: refund_unsure',
    'refunded £0.00 (card £0.00, store credit £0.00), order refunded',
  ],
  'order-refund-held-record-fails-too': [
    'refused: refund_unsure (+warning)',
    'refunded £24.00 (card £24.00, store credit £0.00), order refunded',
  ],
  'order-refund-died-after-the-refund-then-pressed-again': [
    'refunded £24.00 (card £24.00, store credit £0.00) (+warning)',
    'refunded £24.00 (card £24.00, store credit £0.00), order refunded',
  ],
  'order-refund-died-then-the-same-lines-in-the-other-order': [
    'refunded £39.00 (card £39.00, store credit £0.00) (+warning)',
    'refunded £39.00 (card £39.00, store credit £0.00), order refunded',
  ],
  'order-refund-died-on-one-line-then-another-line-at-the-same-figures': [
    'refunded £24.00 (card £24.00, store credit £0.00) (+warning)',
    'refunded £24.00 (card £24.00, store credit £0.00), order partially_refunded',
  ],
  'order-refund-still-no-clear-answer-on-the-next-press': [
    'refused: refund_unsure',
    'refused: refund_unsure',
    'refunded £0.00 (card £0.00, store credit £0.00), order refunded',
  ],
  'order-refund-never-reached-stripe-then-two-days-later': [
    'refused: refund_unsure',
    'refunded £24.00 (card £24.00, store credit £0.00), order refunded',
  ],
  'order-refund-held-two-days-and-the-look-fails': [
    'refused: refund_unsure',
    'refused: refund_unsure',
  ],
  'order-refund-store-credit-answer-lost-is-found-by-its-note': [
    'refunded £24.00 (card £0.00, store credit £24.00), order refunded',
    'refused: already_refunded',
  ],
  'order-refund-store-credit-that-cannot-be-looked-for-counts-as-given': ['refunded £24.00 (card £0.00, store credit £24.00), order refunded (+warning)'],
  'order-refund-store-credit-cannot-be-looked-for-then-the-stamp-fails': ['refunded £24.00 (card £0.00, store credit £24.00) (+warning)'],
  'order-refund-subscription-cancel-refused-after-the-money-went': ['refunded £40.00 (card £40.00, store credit £0.00) (+warning)'],
  'order-refund-subscription-cancel-refused-before-any-money-is-taken-back': ['refused: refund_failed'],
  'e2-order-refund-while-its-reader-payment-is-still-open': [
    'refunded £24.00 (card £0.00, store credit £24.00), order refunded',
    'reader order not cancelled: already_cancelled',
    'reader order not finalised: unexpected_state',
  ],
  'e3-membership-and-robe-on-one-card-refunded-to-card': [
    'refunded £40.00 (card £10.00, store credit £30.00), order partially_refunded',
    'refunded £10.00 (card £0.00, store credit £10.00), order refunded',
  ],
  'e4-membership-refunded-in-full-after-a-credit-session': ['refunded £40.00 (card £40.00, store credit £0.00), order refunded'],
  'e5-used-pass-refunds-in-full-once-its-type-is-edited-down': ['refunded £50.00 (card £50.00, store credit £0.00), order refunded'],
  'e5-unused-pass-is-refused-once-its-type-is-edited-up': ['refused: session_pass_already_used'],
  'event-cancel-refused-without-issue-refunds-for-a-card-refund': [
    'thrown: Needs Issue refunds permission — this action moves money back to the customer.',
    'thrown: Needs Issue refunds permission — this action moves money back to the customer.',
  ],
  'event-cancel-by-someone-with-no-staff-record': [
    'thrown: No staff record matches the logged-in user\'s email (jo@example.com). Ask an admin to add you as staff before performing this action.',
    'cancelled 1: £0.00 (card £0.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-by-an-inactive-staff-member': [
    'thrown: This staff account is inactive. Ask an admin to reactivate it.',
    'thrown: This staff account is inactive. Ask an admin to reactivate it.',
  ],
  'event-cancel-no-refund-needs-no-permission': ['cancelled 1: £0.00 (card £0.00, store credit £0.00), booking confirmed'],
  'event-cancel-refused-no-booking-chosen': ['refused: invalid_params'],
  'event-cancel-refused-no-place-chosen': ['refused: invalid_params'],
  'event-cancel-refused-refund-choice-not-known': ['refused: invalid_params'],
  'event-cancel-refused-while-its-reader-payment-is-open': [
    'refused: booking_pending',
    'refused: booking_pending',
  ],
  'event-cancel-refused-unknown-booking': ['refused: booking_not_found'],
  'event-cancel-refused-booking-already-cancelled': [
    'cancelled 2: £80.00 (card £80.00, store credit £0.00), booking cancelled',
    'refused: booking_not_confirmed',
  ],
  'event-cancel-refused-place-of-another-booking': ['refused: attendee_not_found'],
  'event-cancel-refused-place-already-cancelled': [
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
    'refused: already_cancelled',
  ],
  'event-cancel-refused-nothing-left-to-cancel': ['refused: nothing_to_cancel'],
  'event-cancel-refused-place-checked-in': [
    'refused: attendee_checked_in',
    'refused: attendee_checked_in',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-refused-after-the-cut-off-with-no-reason': [
    'refused: reason_required_after_cutoff',
    'refused: reason_required_after_cutoff',
  ],
  'event-cancel-refused-order-line-not-found': ['refused: order_not_found'],
  'event-cancel-with-no-order-line-is-worth-nothing': [
    'quote: 2 worth £0.00 (card £0.00, store credit £0.00)',
    'cancelled 2: £0.00 (card £0.00, store credit £0.00), booking cancelled',
  ],
  'event-cancel-refused-by-stripe-then-pressed-again': [
    'refused: refund_failed',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-refused-when-the-card-check-cannot-be-read': ['refused: refund_failed'],
  'event-cancel-refused-when-the-look-for-a-held-refund-fails': ['refused: refund_unsure'],
  'event-cancel-store-credit-write-fails': ['refused: store_credit_failed'],
  'event-cancel-store-credit-fails-after-the-card-part': ['cancelled 2: £50.00 (card £50.00, store credit £0.00), booking cancelled (+warning)'],
  'event-cancel-changed-by-someone-else-a-place-checked-in-meanwhile': ['refused: changed_by_someone_else (+warning)'],
  'event-cancel-recording-fails-after-the-card-refund': [
    'refused: unexpected_error (+warning)',
    'cancelled 1: £40.00 (card £0.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-recording-fails-to-store-credit-is-taken-back': ['refused: unexpected_error (+warning)'],
  'event-cancel-one-place-to-card': [
    'quote: 1 worth £40.00 (card £40.00, store credit £0.00)',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-one-place-to-store-credit': ['cancelled 1: £40.00 (card £0.00, store credit £40.00), booking confirmed'],
  'event-cancel-one-place-no-refund-with-a-reason': ['cancelled 1: £0.00 (card £0.00, store credit £0.00), booking confirmed'],
  'event-cancel-several-places-then-the-last': [
    'cancelled 2: £80.00 (card £80.00, store credit £0.00), booking confirmed',
    'quote: 1 worth £40.00 (card £40.00, store credit £0.00)',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking cancelled',
  ],
  'event-cancel-whole-booking-to-card': [
    'quote: 2 worth £80.00 (card £80.00, store credit £0.00)',
    'cancelled 2: £80.00 (card £80.00, store credit £0.00), booking cancelled',
  ],
  'event-cancel-whole-booking-to-store-credit': ['cancelled 2: £80.00 (card £0.00, store credit £80.00), booking cancelled'],
  'event-cancel-whole-booking-no-refund': ['cancelled 2: £0.00 (card £0.00, store credit £0.00), booking cancelled'],
  'event-cancel-cash-order-card-chosen-goes-to-store-credit': [
    'quote: 2 worth £80.00 (card £0.00, store credit £80.00)',
    'cancelled 2: £80.00 (card £0.00, store credit £80.00), booking cancelled',
  ],
  'event-cancel-split-card-and-store-credit': [
    'quote: 2 worth £80.00 (card £50.00, store credit £30.00)',
    'cancelled 2: £80.00 (card £50.00, store credit £30.00), booking cancelled',
  ],
  'event-cancel-gift-card-part-paid-one-place-then-the-other': [
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
    'cancelled 1: £40.00 (card £0.00, store credit £40.00), booking cancelled',
  ],
  'event-cancel-promo-line-the-last-place-takes-what-is-left': [
    'quote: 1 worth £38.34 (card £38.34, store credit £0.00)',
    'cancelled 1: £38.34 (card £38.34, store credit £0.00), booking confirmed',
    'cancelled 1: £38.34 (card £38.34, store credit £0.00), booking confirmed',
    'quote: 1 worth £38.32 (card £38.32, store credit £0.00)',
    'cancelled 1: £38.32 (card £38.32, store credit £0.00), booking cancelled',
  ],
  'event-cancel-member-price-place': [
    'cancelled 1: £20.00 (card £0.00, store credit £20.00), booking confirmed',
    'cancelled 1: £40.00 (card £0.00, store credit £40.00), booking cancelled',
  ],
  'event-cancel-after-the-cut-off-with-a-reason': [
    'quote: 1 worth £40.00 (card £40.00, store credit £0.00), after the cut-off',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
    'cancelled 1: £0.00 (card £0.00, store credit £0.00), booking cancelled',
  ],
  'e8-event-with-no-cut-off-counts-as-after-it': [
    'quote: 1 worth £40.00 (card £40.00, store credit £0.00), after the cut-off',
    'refused: reason_required_after_cutoff',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-after-the-event-has-started-a-no-show': [
    'quote: 1 worth £40.00 (card £40.00, store credit £0.00), after the cut-off',
    'cancelled 1: £40.00 (card £0.00, store credit £40.00), booking confirmed',
  ],
  'e9-figure-changes-between-the-quote-and-the-press': [
    'quote: 3 worth £115.00 (card £115.00, store credit £0.00)',
    'cancelled 1: £38.34 (card £38.34, store credit £0.00), booking confirmed',
    'cancelled 2: £76.66 (card £76.66, store credit £0.00), booking cancelled',
  ],
  'event-cancel-quote-refusals': [
    'refused: booking_not_found',
    'refused: attendee_not_found',
    'refused: attendee_checked_in',
    'refused: attendee_checked_in',
  ],
  'event-cancel-answer-lost-then-pressed-again': [
    'refused: refund_unsure',
    'cancelled 1: £40.00 (card £0.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-answer-lost-then-another-place-to-store-credit': [
    'refused: refund_unsure',
    'cancelled 1: £40.00 (card £0.00, store credit £0.00), booking confirmed',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking cancelled',
  ],
  'event-cancel-answer-lost-then-no-refund-chosen': [
    'refused: refund_unsure',
    'cancelled 1: £40.00 (card £0.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-answer-lost-then-store-credit-chosen': [
    'refused: refund_unsure',
    'cancelled 1: £40.00 (card £0.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-died-after-the-refund-then-pressed-again': [
    'refused: unexpected_error (+warning)',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-died-on-one-place-then-the-other-at-the-same-figures': [
    'refused: unexpected_error (+warning)',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
    'refused: refund_failed',
  ],
  'event-cancel-still-no-clear-answer-on-the-next-press': [
    'refused: refund_unsure',
    'refused: refund_unsure',
    'cancelled 1: £40.00 (card £0.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-held-record-fails-too': [
    'refused: refund_unsure (+warning)',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
  ],
  'event-cancel-never-reached-stripe-then-two-days-later': [
    'refused: refund_unsure',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed',
    'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking cancelled',
  ],
  'event-cancel-held-two-days-and-the-look-fails': [
    'refused: refund_unsure',
    'refused: refund_unsure',
  ],
  'event-cancel-store-credit-answer-lost-is-found-by-its-note': [
    'cancelled 1: £40.00 (card £0.00, store credit £40.00), booking confirmed',
    'refused: already_cancelled',
  ],
  'event-cancel-store-credit-that-cannot-be-looked-for-counts-as-given': ['cancelled 1: £40.00 (card £0.00, store credit £40.00), booking confirmed (+warning)'],
  'event-cancel-store-credit-cannot-be-looked-for-then-recording-fails': ['refused: unexpected_error (+warning)'],
  'event-cancel-recording-fails-and-the-take-back-answer-is-lost': ['refused: unexpected_error (+warning)'],
  'event-whole-cancel-refused-without-issue-refunds': ['thrown: Needs Issue refunds permission — this action moves money back to the customer.'],
  'event-whole-cancel-refused-no-event-chosen': ['refused: invalid_params'],
  'event-whole-cancel-refused-refund-choice-not-known': ['refused: invalid_params'],
  'event-whole-cancel-refused-no-reason': ['refused: invalid_params'],
  'event-whole-cancel-refused-unknown-event': [
    'refused: event_not_found',
    'null',
  ],
  'event-whole-cancel-refused-event-ended': [
    'overview: Sam Test 2 £80.00, ended',
    'refused: event_ended',
  ],
  'event-whole-cancel-refused-while-a-reader-payment-is-open': [
    'overview: Mo Member 1 £20.00, pending Sam Test',
    'refused: bookings_pending',
    'reader order finalised',
    'event cancelled: Mo Member ok (card £0.00, store credit £20.00); Sam Test ok (card £80.00, store credit £0.00)',
  ],
  'event-whole-cancel-card-and-cash-bookings-to-card': [
    'overview: Sam Test 2 £80.00; Mo Member 1 £20.00',
    'event cancelled: Sam Test ok (card £80.00, store credit £0.00); Mo Member ok (card £0.00, store credit £20.00)',
    'overview: nothing to cancel, cancelled (Storm)',
  ],
  'event-whole-cancel-everything-to-store-credit': [
    'event cancelled: Sam Test ok (card £0.00, store credit £80.00); Mo Member ok (card £0.00, store credit £20.00)',
  ],
  'event-whole-cancel-one-booking-fails-then-retry': [
    'overview: Sam Test 2 £0.00 (problem); Mo Member 1 £20.00',
    'event cancelled: Sam Test failed; Mo Member ok (card £0.00, store credit £20.00)',
    'overview: Sam Test 2 £0.00 (problem), cancelled (Storm)',
    'event cancelled: Sam Test ok (card £80.00, store credit £0.00)',
    'overview: nothing to cancel, cancelled (Storm)',
  ],
  'event-whole-cancel-a-card-refund-refused-by-stripe': [
    'event cancelled: Sam Test failed; Mo Member ok (card £0.00, store credit £20.00)',
    'event cancelled: Sam Test ok (card £80.00, store credit £0.00)',
  ],
  'event-whole-cancel-after-the-cut-off-and-a-place-already-cancelled': [
    'cancelled 1: £0.00 (card £0.00, store credit £0.00), booking confirmed',
    'event cancelled: Sam Test ok (card £40.00, store credit £0.00); Mo Member ok (card £0.00, store credit £20.00)',
  ],
  'e7-a-reader-order-started-between-the-check-and-the-cancel': [
    'event cancelled: Mo Member ok (card £0.00, store credit £20.00)',
    'reader order finalised',
    'overview: Sam Test 2 £80.00, cancelled (Storm)',
  ],
  'event-whole-cancel-answer-lost-then-retry': [
    'event cancelled: Sam Test failed; Mo Member ok (card £0.00, store credit £20.00)',
    'event cancelled: Sam Test ok (card £0.00, store credit £0.00)',
  ],
}

describe('W27: the step E golden files, recorded from the old functions', () => {
  it('every W27 scenario is in the table, and every one has its golden file', () => {
    expect(w27.map((scenario) => scenario.name.slice(W27_PREFIX.length))).toEqual(Object.keys(WHAT_EACH_PROVES))
    expect(w27).toHaveLength(137)
    expect(new Set(w27.map((scenario) => scenario.name)).size).toBe(137)
    for (const scenario of w27) expect(readGolden(scenario.name), scenario.name).not.toBeNull()
  })

  it.each(Object.entries(WHAT_EACH_PROVES))('%s', (name, steps) => {
    expect(outcomes(golden(name))).toEqual(steps)
  })

  it('they were recorded from, and replay against, the frozen copy of the old functions', () => {
    for (const action of LEGACY_REFUND_ACTIONS) expect(oldFunctionPath(action)).toBe(`${legacyRefundDir}/${action}.ts`)
  })
})

describe('what the W27 golden files cover (E-plan 4.13 item 1)', () => {
  const named = (test: (name: string) => boolean): Recording[] =>
    Object.keys(WHAT_EACH_PROVES)
      .filter(test)
      .map((name) => golden(name))
  const orderRefunds = named((name) => name.startsWith('order-refund-') || /^e[2-5]-/.test(name))
  const placeCancels = named((name) => name.startsWith('event-cancel-') || /^e[89]-/.test(name))
  const wholeEvents = named((name) => name.startsWith('event-whole-cancel-') || name.startsWith('e7-'))
  const refusedWith = (recordings: Recording[]): Set<string> =>
    new Set(recordings.flatMap((recording) => recording.results).flatMap((result) => (result && typeof result === 'object' && ((result as Row)['success'] === false || (result as Row)['ok'] === false) ? [String((result as Row)['reason'])] : [])))
  const rows = (recordings: Recording[], table: string): Row[] => recordings.flatMap((recording) => recording.tables[table]?.added ?? [])

  it('every reason refundOrder can refuse with is recorded (E-plan 1.2)', () => {
    const recorded = refusedWith(orderRefunds)
    expect(ORDER_REFUND_REASONS.filter((reason) => !recorded.has(reason))).toEqual([])
  })

  it('every reason a place cancel can refuse with is recorded (E-plan 1.3)', () => {
    const recorded = refusedWith(placeCancels)
    expect(EVENT_CANCEL_REASONS.filter((reason) => !recorded.has(reason))).toEqual([])
  })

  it('every reason the whole-event cancel can refuse with is recorded (E-plan 1.4)', () => {
    const recorded = refusedWith(wholeEvents)
    expect(EVENT_WHOLE_CANCEL_REASONS.filter((reason) => !recorded.has(reason))).toEqual([])
  })

  it('the refusals the old functions throw rather than answer are recorded too: no Issue refunds, no staff record, and an inactive account', () => {
    const thrown = new Set([...orderRefunds, ...placeCancels, ...wholeEvents].flatMap((recording) => recording.results).flatMap((result) => (result && typeof result === 'object' && 'thrown' in result ? [String((result as Row)['thrown'])] : [])))
    expect([...thrown].sort()).toEqual([
      'Needs Issue refunds permission — this action moves money back to the customer.',
      "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action.",
      'This staff account is inactive. Ask an admin to reactivate it.',
    ])
  })

  it('each refusal that has two texts has both recorded: the card check that cannot be read, and the look for a held refund that fails', () => {
    const words = (name: string) => String((golden(name).results.at(-1) as Row)['message'])
    expect(words('order-refund-refused-when-the-card-check-cannot-be-read')).toBe('Checking the card payment failed, so nothing was refunded: connection lost')
    expect(words('event-cancel-refused-when-the-card-check-cannot-be-read')).toBe('Checking the card payment failed, so nothing was cancelled: connection lost')
    expect(words('order-refund-refused-when-the-look-for-a-held-refund-fails')).toBe('Checking for an earlier card refund with no clear answer failed, so nothing was done: connection lost')
    expect(words('event-cancel-refused-when-the-look-for-a-held-refund-fails')).toBe('Checking for an earlier card refund with no clear answer failed, so nothing was done: connection lost')
    // Nothing was sent to Stripe in any of the four: only the order's own charge is there.
    for (const name of ['order-refund-refused-when-the-card-check-cannot-be-read', 'event-cancel-refused-when-the-card-check-cannot-be-read', 'order-refund-refused-when-the-look-for-a-held-refund-fails', 'event-cancel-refused-when-the-look-for-a-held-refund-fails']) {
      expect(golden(name).stripeCalls.map((call) => call.method), name).toEqual(['paymentIntents.create'])
    }
  })

  it('noticed in W27: someone signed in with no staff record at all can cancel an event place with No refund, and nobody is recorded as having done it', () => {
    // cancelEventPlaces checks Issue refunds only for a refund; with No refund it looks the staff member up, finds
    // none, and carries on with nobody. For the Worker step (W30): every staff route refuses someone who isn't staff.
    const recording = golden('event-cancel-by-someone-with-no-staff-record')
    expect(outcomes(recording)[1]).toBe('cancelled 1: £0.00 (card £0.00, store credit £0.00), booking confirmed')
    expect(recording.tables['event_attendees']?.added.map((place) => [place['cancelled_at'], place['cancelled_by']])).toEqual([
      ['<set>', null],
      [null, null],
    ])
    // An inactive staff member is refused either way.
    expect(golden('event-cancel-by-an-inactive-staff-member').tables['event_attendees']?.added.map((place) => place['cancelled_at'])).toEqual([null, null])
  })

  it('each kind of line is refunded: product (with and without restock), postage, standalone add-on, gift card, pass, membership', () => {
    const refunded = rows(orderRefunds, 'order_line_items').filter((line) => line['refunded_at'] !== null)
    expect([...new Set(refunded.map((line) => String(line['item_type'])))].sort()).toEqual(['addon', 'gift_card', 'membership', 'postage', 'product', 'session_pass'])
    const products = refunded.filter((line) => line['item_type'] === 'product')
    expect(products.some((line) => line['restocked'] === true)).toBe(true)
    expect(products.some((line) => line['restocked'] === false)).toBe(true)
    // A restock writes its stock adjustment; a gift card is voided; a pass is emptied; a membership is cancelled.
    expect(rows(orderRefunds, 'stock_adjustments').some((row) => String(row['reason']).startsWith('Refund Restock (Order #'))).toBe(true)
    expect(rows(orderRefunds, 'gift_cards').some((card) => card['voided'] === true)).toBe(true)
    expect(rows(orderRefunds, 'customer_session_passes').some((pass) => pass['sessions_remaining'] === 0)).toBe(true)
    expect(rows(orderRefunds, 'customer_memberships').some((membership) => membership['subscription_status'] === 'cancelled')).toBe(true)
    // The date change charge is a membership line with no membership cancelled: its scenario leaves Mo's membership active.
    const dateChange = golden('order-refund-payment-date-change-charge-is-a-plain-line')
    expect(dateChange.tables['customer_memberships']).toBeUndefined()
    expect(dateChange.stripeCalls.map((call) => call.method)).toEqual(['paymentIntents.create', 'refunds.create'])
  })

  it('the money goes back each way: to the card, to store credit, and split between them', () => {
    const lines = rows(orderRefunds, 'order_line_items').filter((line) => line['refunded_at'] !== null)
    expect([...new Set(lines.map((line) => String(line['refund_method'])))].sort()).toEqual(['card', 'credit'])
    const split = golden('order-refund-two-lines-at-once-split')
    expect(split.tables['order_line_items']?.added.map((line) => [line['refund_method'], line['card_refunded_amount']])).toEqual([
      ['card', '19.00'],
      ['credit', '0.00'],
    ])
    // Places a cancel recorded (one scenario stamps places cancelled by hand, with no method, to reach `nothing_to_cancel`).
    const places = rows(placeCancels, 'event_attendees').filter((place) => place['cancelled_at'] !== null && place['refund_method'] !== null)
    expect([...new Set(places.map((place) => String(place['refund_method'])))].sort()).toEqual(['card', 'credit', 'none'])
    expect(places.some((place) => place['refund_after_cutoff'] === true)).toBe(true)
    expect(places.some((place) => place['refund_after_cutoff'] === false)).toBe(true)
  })

  it('a promo line gives back what was paid for it, and the last place takes exactly what is left', () => {
    // E1: the £15 mug with 10% off gives back £13.50.
    expect(outcomes(golden('order-refund-promo-line-gives-back-what-was-paid'))).toEqual(['refunded £13.50 (card £13.50, store credit £0.00), order partially_refunded'])
    // £120 less a £5 code over three places: £38.34, £38.34 and the last £38.32, which add up to the £115 paid.
    const places = golden('event-cancel-promo-line-the-last-place-takes-what-is-left').tables['event_attendees']?.added ?? []
    expect(places.map((place) => place['refunded_amount'])).toEqual(['38.34', '38.34', '38.32'])
    expect(places.reduce((sum, place) => sum + Math.round(Number(place['refunded_amount']) * 100), 0)).toBe(11_500)
  })

  it("today's outcome is recorded for each bug in the plan's section 3 that a function can show", () => {
    // E1 (the dialog's sum) shows as the promo line above; E6 (Retool's 60 seconds) and E11 (the dialog's lost answer)
    // are the screen's and the platform's, not a function's answer: the W27 report says so.
    const names = Object.keys(WHAT_EACH_PROVES)
    for (const bug of ['e2-', 'e3-', 'e4-', 'e5-', 'e7-', 'e8-', 'e9-']) expect(names.some((name) => name.startsWith(bug)), bug).toBe(true)
    // E2: store credit given on an order whose reader payment was still open, which can then be neither cancelled nor finished.
    expect(outcomes(golden('e2-order-refund-while-its-reader-payment-is-still-open'))).toEqual([
      'refunded £24.00 (card £0.00, store credit £24.00), order refunded',
      'reader order not cancelled: already_cancelled',
      'reader order not finalised: unexpected_state',
    ])
    // E3: £40 membership and £10 robe on one card: £10 back on the card, £40 as store credit.
    expect(outcomes(golden('e3-membership-and-robe-on-one-card-refunded-to-card'))).toEqual([
      'refunded £40.00 (card £10.00, store credit £30.00), order partially_refunded',
      'refunded £10.00 (card £0.00, store credit £10.00), order refunded',
    ])
    // E4: a credit session taken, and the membership still refunds in full, the booking left confirmed.
    const used = golden('e4-membership-refunded-in-full-after-a-credit-session')
    expect(outcomes(used)).toEqual(['refunded £40.00 (card £40.00, store credit £0.00), order refunded'])
    expect(used.tables['bookings']?.added.map((booking) => [booking['status'], booking['redemption_source']])).toEqual([['confirmed', 'membership_credit']])
    // E7: Sam's reader order, started between the check and the cancel, ends confirmed on a cancelled event.
    const between = golden('e7-a-reader-order-started-between-the-check-and-the-cancel')
    expect(outcomes(between).at(-1)).toBe('overview: Sam Test 2 £80.00, cancelled (Storm)')
    // E8: no cut-off counts as after it.
    expect(outcomes(golden('e8-event-with-no-cut-off-counts-as-after-it'))[1]).toBe('refused: reason_required_after_cutoff')
    // E9: the dialog showed £115 for the booking; the press gave £76.66.
    expect(outcomes(golden('e9-figure-changes-between-the-quote-and-the-press'))).toEqual([
      'quote: 3 worth £115.00 (card £115.00, store credit £0.00)',
      'cancelled 1: £38.34 (card £38.34, store credit £0.00), booking confirmed',
      'cancelled 2: £76.66 (card £76.66, store credit £0.00), booking cancelled',
    ])
    // E10: the money went and the cancel was refused: "success", and the subscription is still live at Stripe.
    const live = golden('order-refund-subscription-cancel-refused-after-the-money-went')
    expect(outcomes(live)).toEqual(['refunded £40.00 (card £40.00, store credit £0.00) (+warning)'])
    expect((live.results.at(-1) as Row)['warning']).toContain('cancelling the Stripe subscription')
  })

  it('a death after the refund on one place, then the other place: £80 back on the card and one place still booked (noticed in W27)', () => {
    // The first place's £40 went with nothing recorded; the second place took the card's other £40; the first place's
    // own cancel is then refused by Stripe, as the payment has nothing left. For the Worker step (W30): one claim,
    // recorded before the refund is sent, leaves no refund without its place.
    const recording = golden('event-cancel-died-on-one-place-then-the-other-at-the-same-figures')
    expect(outcomes(recording)).toEqual(['refused: unexpected_error (+warning)', 'cancelled 1: £40.00 (card £40.00, store credit £0.00), booking confirmed', 'refused: refund_failed'])
    expect(recording.stripeCalls.filter((call) => call.method === 'refunds.create').map((call) => (call.params as { amount: number }).amount)).toEqual([4000, 4000, 4000])
    expect(recording.tables['event_attendees']?.added.map((place) => place['cancelled_at'])).toEqual([null, '<set>'])
  })
})

describe('a deliberate difference from a W27 golden file is caught, and an allowance nobody needs fails (brief W27 item 8)', () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  const scenario = (name: string) => {
    const found = w27.find((one) => one.name === `${W27_PREFIX}${name}`)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const run = (name: string, options?: ReplayOptions) => replay(environment, scenario(name), oldSide, options)
  /** The differences a tampered run shows against the golden file. */
  const against = async (name: string, tamper: NonNullable<ReplayOptions['tamper']>) => compareRecordings(golden(name), await run(name, { tamper }))
  const paths = async (name: string, tamper: (db: Db) => Promise<unknown>) => (await against(name, (db) => tamper(db).then(() => undefined))).map((difference) => difference.path)

  const ORDER = 'order-refund-split-card-and-store-credit'
  const PLACES = 'event-cancel-promo-line-the-last-place-takes-what-is-left'
  const EVENT = 'event-whole-cancel-card-and-cash-bookings-to-card'

  it('untouched, each of the three matches its golden file exactly', async () => {
    for (const name of [ORDER, PLACES, EVENT]) expect(compareRecordings(golden(name), await run(name)), name).toEqual([])
  })

  it('an order refund: a penny more card money on the line', async () => {
    expect(await paths(ORDER, (db) => db.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + 0.01'))).toContain('.tables.order_line_items.added[0].card_refunded_amount')
  })

  it('an order refund: the line recorded as store credit where the card took it', async () => {
    expect(await paths(ORDER, (db) => db.query("UPDATE order_line_items SET refund_method = 'credit'"))).toContain('.tables.order_line_items.added[0].refund_method')
  })

  it('an order refund: the store credit part given twice', async () => {
    const found = await paths(ORDER, (db) =>
      db.query("INSERT INTO store_credit_transactions (customer_id, amount, reason, balance_after, note) SELECT customer_id, amount, reason, balance_after + amount, note FROM store_credit_transactions WHERE reason = 'refund'")
    )
    expect(found.join()).toContain('.tables.store_credit_transactions.added[')
  })

  it("an order refund: the order left 'partially_refunded' when all of it went back", async () => {
    expect(await paths(ORDER, (db) => db.query("UPDATE orders SET payment_status = 'partially_refunded'"))).toContain('.tables.orders.added[0].payment_status')
  })

  it('an order refund: money owed appearing on the order (the column migration 023 adds)', async () => {
    expect(await paths(ORDER, (db) => db.query('UPDATE orders SET refund_owed_amount = 10'))).toContain('.tables.orders.added[0].refund_owed_amount')
  })

  it('event places: the last place given a penny too much', async () => {
    expect(await paths(PLACES, (db) => db.query("UPDATE event_attendees SET refunded_amount = refunded_amount + 0.01 WHERE refunded_amount = 38.32"))).toContain('.tables.event_attendees.added[2].refunded_amount')
  })

  it('event places: a place left booked on the event', async () => {
    // All three places are cancelled, so the event ends as it began and the golden file has no `events` entry: a
    // place left booked shows as that whole entry appearing.
    expect(golden(PLACES).tables['events']).toBeUndefined()
    expect(await paths(PLACES, (db) => db.query('UPDATE events SET places_booked = places_booked + 1'))).toContain('.tables.events')
  })

  it('event places: a refund recorded as after the cut-off when it was before', async () => {
    expect(await paths(PLACES, (db) => db.query('UPDATE event_attendees SET refund_after_cutoff = true'))).toContain('.tables.event_attendees.added[0].refund_after_cutoff')
  })

  it('a whole event: a booking left confirmed', async () => {
    // A confirmed booking must have a place (event_bookings_places_check), so it is given its place back too.
    const found = await paths(EVENT, (db) =>
      db.query("UPDATE event_bookings SET status = 'confirmed', places = 1, cancelled_at = NULL WHERE customer_id = (SELECT id FROM customers WHERE email = 'mo@example.com')")
    )
    expect(found).toContain('.tables.event_bookings.added[1].status')
    expect(found).toContain('.tables.event_bookings.added[1].places')
  })

  it('a whole event: a second card refund sent to Stripe', async () => {
    const differences = await against(EVENT, async (_db, stripe) => {
      const refund = stripe.calls.find((call) => call.method === 'refunds.create')
      if (refund) stripe.calls.push({ ...refund })
    })
    expect(differences.map((difference) => difference.path)).toContain('.stripeCalls[2]')
  })

  it('an allowance that is needed passes its own path only: every other difference still shows', async () => {
    const penny: AllowedDifference = { name: 'a penny on the line (test only)', decision: 'none: this test', path: /^\.tables\.order_line_items\.added\[0\]\.card_refunded_amount$/ }
    const tampered = await run(ORDER, {
      tamper: async (db) => {
        await db.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + 0.01')
        await db.query('UPDATE orders SET refund_owed_amount = 10')
      },
    })
    const left = compareRecordings(golden(ORDER), tampered, [penny])
    expect(left.map((difference) => difference.path)).toEqual(['.tables.orders.added[0].refund_owed_amount'])
  })

  it('an allowance can check the value it lets through: the wrong value on its path still fails', async () => {
    const onlyOnePenny: AllowedDifference = {
      name: 'exactly a penny more (test only)',
      decision: 'none: this test',
      path: /^\.tables\.order_line_items\.added\[0\]\.card_refunded_amount$/,
      actual: (actual, expected) => Math.round(Number(actual) * 100) === Math.round(Number(expected) * 100) + 1,
    }
    const byOne = await run(ORDER, { tamper: (db) => db.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + 0.01').then(() => undefined) })
    expect(compareRecordings(golden(ORDER), byOne, [onlyOnePenny])).toEqual([])
    const byTwo = await run(ORDER, { tamper: (db) => db.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + 0.02').then(() => undefined) })
    expect(compareRecordings(golden(ORDER), byTwo, [onlyOnePenny]).map((difference) => difference.path)).toEqual([
      '.tables.order_line_items.added[0].card_refunded_amount',
      '(allowed difference not seen: exactly a penny more (test only))',
    ])
  })

  it('an allowance nobody needs fails, naming itself and its decision, so a stale one can never stay', async () => {
    const stale: AllowedDifference = { name: 'W28 named this and no longer needs it', decision: 'E-plan 4.13 item 4', path: /^\.tables\.orders\.added\[0\]\.refund_owed_amount$/ }
    for (const name of [ORDER, PLACES, EVENT]) {
      expect(compareRecordings(golden(name), await run(name), [stale]), name).toEqual([
        { path: '(allowed difference not seen: W28 named this and no longer needs it)', expected: 'E-plan 4.13 item 4', actual: undefined },
      ])
    }
  })
})
