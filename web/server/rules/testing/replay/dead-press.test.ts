import { describe, expect, it } from 'vitest'
import { ADD_GUEST_DIFFERENCES } from './booking-side'
import type { AllowedDifference } from './compare'

// Brief W25 (W20 review later 1, W24 "noticed"): the replay's allowance for a press whose answer was lost
// (`deadPressAnswerLost`) used to let any value through on every path but the reason and the words. It now says what
// the Worker's side must hold on each path, so it can't hide the Worker repeating what the old resume repeated: a
// second charge, a second order, a second place, the store credit taken twice.

const recordings = {} as never
function allowance(scenario: string): AllowedDifference {
  const found = (ADD_GUEST_DIFFERENCES.get(scenario) ?? []).find((one) => one.name.includes("the press's answer is lost"))
  if (!found?.actual) throw new Error(`No dead-press allowance for ${scenario}.`)
  return found
}
const allows = (scenario: string, value: unknown, expected: unknown, path: string): boolean => allowance(scenario).actual?.(value, expected, path, recordings) === true

describe('the dead-press allowance checks every path it covers', () => {
  it('the answer: only no_answer or pressed_after_no_answer, with their words', () => {
    const scenario = 'dies-after-the-charge-add-guest'
    expect(allows(scenario, 'no_answer', undefined, '.results[1].reason')).toBe(true)
    expect(allows(scenario, 'pressed_after_no_answer', undefined, '.results[1].reason')).toBe(true)
    expect(allows(scenario, 'card_charge_failed', undefined, '.results[1].reason')).toBe(false)
    expect(allows(scenario, "Adding didn't get an answer, so it may or may not have gone through", undefined, '.results[1].message')).toBe(true)
    expect(allows(scenario, 'Something else', undefined, '.results[1].message')).toBe(false)
  })

  it("a second Stripe call on the Worker's side is not let through (the old resume sent the charge again)", () => {
    const scenario = 'dies-after-the-charge-add-guest'
    const charge = { method: 'paymentIntents.create', params: { amount: 2000 } }
    expect(allows(scenario, undefined, charge, '.stripeCalls[2]')).toBe(true)
    expect(allows(scenario, charge, charge, '.stripeCalls[2]')).toBe(false)
    expect(allows(scenario, { ...charge, params: { amount: 4000 } }, charge, '.stripeCalls[2]')).toBe(false)
  })

  it('the next press is not an add; no second order, line or place', () => {
    const scenario = 'w17-r2a-add-guest-press-dies-after-the-charge-then-paid-on-the-card'
    expect(allows(scenario, false, true, '.results[3].added')).toBe(true)
    expect(allows(scenario, true, true, '.results[3].added')).toBe(false)
    expect(allows(scenario, undefined, { id: 'booking_guests#3' }, '.results[3].guest')).toBe(true)
    expect(allows(scenario, { id: 'booking_guests#4' }, { id: 'booking_guests#3' }, '.results[3].guest')).toBe(false)
    expect(allows(scenario, undefined, { id: 'orders#3' }, '.tables.orders.added[2]')).toBe(true)
    expect(allows(scenario, { id: 'orders#3', order_total: '40.00' }, { id: 'orders#3' }, '.tables.orders.added[2]')).toBe(false)
    expect(allows(scenario, undefined, { id: 'order_line_items#3' }, '.tables.order_line_items.added[2]')).toBe(true)
    // One place, not the old code's two; never none, never three.
    expect(allows(scenario, 3, 4, '.tables.sessions.changed[0].total_booked[1]')).toBe(true)
    expect(allows(scenario, 2, 4, '.tables.sessions.changed[0].total_booked[1]')).toBe(false)
    expect(allows(scenario, 5, 4, '.tables.sessions.changed[0].total_booked[1]')).toBe(false)
  })

  it('the gift card is never touched, and the store credit is taken once (by exactly the amount the old code took twice)', () => {
    const giftCard = 'w17-r2b-add-guest-press-dies-after-the-charge-then-resumed-with-a-gift-card'
    expect(allows(giftCard, undefined, { added: [{}] }, '.tables.gift_card_redemptions')).toBe(true)
    expect(allows(giftCard, { added: [{ amount_used: '5.00' }] }, { added: [{}] }, '.tables.gift_card_redemptions')).toBe(false)
    const held = 'w17-r2d-add-guest-press-dies-while-the-worker-charges-and-writes-no-order'
    expect(allows(held, '95.00', '90.00', '.tables.customers.changed[0].store_credit_balance[1]')).toBe(true)
    expect(allows(held, '100.00', '90.00', '.tables.customers.changed[0].store_credit_balance[1]')).toBe(false)
    expect(allows(held, '85.00', '90.00', '.tables.customers.changed[0].store_credit_balance[1]')).toBe(false)
    const claim = 'w17-r4a-add-guest-store-credit-claim-answer-lost-then-pressed-again'
    expect(allows(claim, '85.00', '70.00', '.tables.customers.changed[0].store_credit_balance[1]')).toBe(true)
    expect(allows(claim, '75.00', '70.00', '.tables.customers.changed[0].store_credit_balance[1]')).toBe(false)
    expect(allows(claim, 'orders#2', null, '.tables.store_credit_transactions.added[0].order_id')).toBe(true)
    expect(allows(claim, null, null, '.tables.store_credit_transactions.added[0].order_id')).toBe(false)
    expect(allows(claim, undefined, { amount: '-15.00' }, '.tables.store_credit_transactions.added[1]')).toBe(true)
    expect(allows(claim, { amount: '-15.00' }, { amount: '-15.00' }, '.tables.store_credit_transactions.added[1]')).toBe(false)
  })

  it('a path the allowance gives no rule for is refused, not waved through', () => {
    expect(allows('dies-after-the-charge-add-guest', 'anything', 'something', '.tables.bookings.changed[0].price_paid[1]')).toBe(false)
  })
})
