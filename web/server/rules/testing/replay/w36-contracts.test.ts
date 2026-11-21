import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  accountActionSchema,
  accountRefusalDetailsSchema,
  adjustMembershipCreditsInputSchema,
  adjustMembershipCreditsOutputSchema,
  adjustStoreCreditInputSchema,
  adjustStoreCreditOutputSchema,
  changePaymentDateInputSchema,
  changePaymentDateOutputSchema,
  createCustomerInputSchema,
  createCustomerOutputSchema,
  customerDetailOutputSchema,
  customerListInputSchema,
  customerListRowSchema,
  extendGiftCardInputSchema,
  extendGiftCardOutputSchema,
  giftCardFlagOutputSchema,
  giftCardListInputSchema,
  giftCardListRowSchema,
  giftCardRedemptionRowSchema,
  giftCardRowSchema,
  membershipCancelInputSchema,
  membershipCancelOutputSchema,
  membershipCancelRouteInputSchema,
  membershipCreditAdjustmentRowSchema,
  membershipListInputSchema,
  membershipListRowSchema,
  paymentDateQuoteInputSchema,
  paymentDateQuoteOutputSchema,
  savedCardMembershipsSchema,
  saveCustomerCardOutputSchema,
  setGiftCardPickedUpInputSchema,
  setGiftCardShippedInputSchema,
  setMembershipHerdInputSchema,
  setMembershipHerdOutputSchema,
  stuckCloseKindSchema,
  stuckListOutputSchema,
  stuckStepSchema,
  reconcileItemSchema,
} from '@/contracts'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide } from './harness'
import { scenarios, W36_PREFIX } from './scenarios'

// Brief W36 item 1: contracts/account.ts, ahead of the routes that use it (W37 to W42). No route parses with it yet,
// so this holds it to the one thing that exists: the old functions. Every W36 scenario is run through the frozen copy
// of the old code, and each call's own params and each answer, as the function gave it (before the recording labels
// its ids), must fit the contract for its route. So the thin wrappers W37 to W42 write can hand the Worker what the
// screens send today and hand the screens back what they read today.

vi.setConfig({ testTimeout: 30_000 })

type Row = Record<string, unknown>
interface Call {
  scenario: string
  action: string
  params: Row
  result: unknown
}
type Schema = { safeParse(value: unknown): { success: boolean; error?: { message: string } } }

const w36 = scenarios.filter((scenario) => scenario.name.startsWith(W36_PREFIX))
/** A call's params without the id that goes in the route's path. */
const body = (params: Row, ...inPath: string[]): Row => Object.fromEntries(Object.entries(params).filter(([key]) => !inPath.includes(key)))
const shapeOf = (schema: unknown): Row => (schema as { shape: Row }).shape

describe("the step F contracts fit what the old functions take and give (brief W36 item 1)", () => {
  let environment: ReplayEnvironment
  const calls: Call[] = []

  beforeAll(async () => {
    environment = await startReplay()
    for (const scenario of w36) {
      await replay(environment, scenario, (db, stripe): ReplaySide => {
        const old = oldSide(db, stripe)
        return {
          name: old.name,
          async call(action, params) {
            try {
              const result = await old.call(action, params)
              calls.push({ scenario: scenario.name, action, params: params as Row, result })
              return result
            } catch (err) {
              calls.push({ scenario: scenario.name, action, params: params as Row, result: { thrown: err instanceof Error ? err.message : String(err) } })
              throw err
            }
          },
        }
      })
    }
  }, 600_000)
  afterAll(() => environment.stop())

  const of = (action: string) => calls.filter((call) => call.action === action)
  const problems = (schema: Schema, picked: Call[], value: (call: Call) => unknown): string[] =>
    picked.flatMap((call) => {
      const parsed = schema.safeParse(value(call))
      return parsed.success ? [] : [`${call.scenario}: ${parsed.error?.message ?? 'no fit'}`]
    })
  const rowProblems = (schema: Schema, rows: Array<{ scenario: string; row: unknown }>): string[] =>
    rows.flatMap(({ scenario, row }) => {
      const parsed = schema.safeParse(row)
      return parsed.success ? [] : [`${scenario}: ${parsed.error?.message ?? 'no fit'}`]
    })
  const answered = (call: Call) => call.result !== null && typeof call.result === 'object' && !Array.isArray(call.result) && !('thrown' in (call.result as Row))
  const flag = (call: Call, name: string, value: boolean) => answered(call) && (call.result as Row)[name] === value
  /** The fields of some answers that the contract's shape doesn't have (less the old flag that says it worked). */
  const dropped = (rows: Row[], schema: unknown, ...flags: string[]): string[] => [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((field) => !flags.includes(field) && !(field in shapeOf(schema)))
  const listRows = (action: string): Array<{ scenario: string; row: Row }> => of(action).filter((call) => Array.isArray(call.result)).flatMap((call) => (call.result as Row[]).map((row) => ({ scenario: call.scenario, row })))
  /** Each refusal an old function answered as data, as the Worker's refusal details would carry it. */
  const refusals = (action: string, flagName: string, as: string): string[] =>
    problems(
      accountRefusalDetailsSchema,
      of(action).filter((call) => flag(call, flagName, false)),
      (call) => ({ reason: (call.result as Row)['reason'] ?? 'refused', message: (call.result as Row)['message'] ?? 'Refused.', action: as })
    )

  it('every W36 scenario ran, and each of the sixteen old functions was called', () => {
    expect(w36).toHaveLength(137)
    // Every scenario calls something (the lapse sweep's four place their booking with the old createOrder).
    expect(new Set(calls.map((call) => call.scenario)).size).toBe(137)
    for (const action of [
      'setMembershipCancellation',
      'changeMembershipPaymentDate',
      'getMembershipPaymentDateQuote',
      'adjustMembershipCredits',
      'getMembershipCreditAdjustments',
      'setMembershipHerd',
      'getSubscriptions',
      'createCustomer',
      'getCustomers',
      'getCustomerDetail',
      'adjustCustomerStoreCredit',
      'extendGiftCardExpiry',
      'setGiftCardPickedUp',
      'setGiftCardShipped',
      'getGiftCards',
      'getGiftCardRedemptions',
    ]) {
      expect(of(action).length, action).toBeGreaterThanOrEqual(3)
    }
  })

  it('setMembershipCancellation: the membership goes in the path and nothing in the body; every success fits the output, in the old fields', () => {
    const picked = of('setMembershipCancellation')
    expect(picked.length).toBeGreaterThan(25)
    expect(problems(membershipCancelInputSchema, picked, (call) => body(call.params, 'membershipId', 'cancel'))).toEqual([])
    expect(membershipCancelRouteInputSchema.safeParse({ membershipId: '10000000-0000-4000-8000-000000000010' }).success).toBe(true)
    expect(membershipCancelRouteInputSchema.safeParse({ membershipId: '' }).success).toBe(false)
    const successes = picked.filter((call) => flag(call, 'updated', true))
    expect(successes.length).toBeGreaterThan(18)
    expect(problems(membershipCancelOutputSchema, successes, (call) => call.result)).toEqual([])
    expect(dropped(successes.map((call) => call.result as Row), membershipCancelOutputSchema, 'updated')).toEqual([])
    // Cancels carry the end date and whether Stripe was changed; undos don't.
    expect(successes.some((call) => call.params['cancel'] === true && typeof (call.result as Row)['endDate'] === 'string' && (call.result as Row)['stripeUpdated'] === false)).toBe(true)
    expect(successes.filter((call) => call.params['cancel'] === false).every((call) => !('endDate' in (call.result as Row)))).toBe(true)
    // New: the Stripe step left for the automatic check.
    expect(membershipCancelOutputSchema.parse({ membership: { id: 'm', cancel_effective_date: '2026-12-09', billing_frequency: 'monthly' }, endDate: '2026-12-10', stripeUpdated: false, left: { stepId: 's', message: 'x' } }).left).toEqual({ stepId: 's', message: 'x' })
    expect(refusals('setMembershipCancellation', 'updated', 'cancel')).toEqual([])
  })

  it('the payment date quote: every answer fits, field for field (the old null, for no such membership, becomes NOT_FOUND)', () => {
    const picked = of('getMembershipPaymentDateQuote')
    expect(picked.length).toBeGreaterThanOrEqual(52)
    expect(problems(paymentDateQuoteInputSchema, picked, (call) => body(call.params, 'membershipId'))).toEqual([])
    const quotes = picked.filter((call) => call.result !== null)
    expect(problems(paymentDateQuoteOutputSchema, quotes, (call) => call.result)).toEqual([])
    expect(dropped(quotes.map((call) => call.result as Row), paymentDateQuoteOutputSchema)).toEqual([])
    // Every field of the contract is one the old quote gives somewhere: nothing invented.
    const given = new Set(quotes.flatMap((call) => Object.keys(call.result as Row)))
    expect(Object.keys(shapeOf(paymentDateQuoteOutputSchema)).filter((field) => !given.has(field))).toEqual([])
    expect(picked.filter((call) => call.result === null)).toHaveLength(2)
    // A date that isn't a date is the quote's to answer ("Choose a date from…"), never a VALIDATION.
    expect(paymentDateQuoteInputSchema.safeParse({ newRenewalDate: 'next Friday' }).success).toBe(true)
  })

  it('changeMembershipPaymentDate: every press fits the input, loose where the old function answered for itself; every success fits the output', () => {
    const picked = of('changeMembershipPaymentDate')
    expect(picked.length).toBeGreaterThan(50)
    expect(problems(changePaymentDateInputSchema, picked, (call) => body(call.params, 'membershipId'))).toEqual([])
    // What the old function refused itself still parses, so the rule answers the old words.
    expect(changePaymentDateInputSchema.safeParse({}).success).toBe(true)
    expect(changePaymentDateInputSchema.safeParse({ newRenewalDate: 'next Friday', override: true, overrideReason: '   ' }).success).toBe(true)
    // The new part: the figure staff were shown (Q18, FB4).
    expect(changePaymentDateInputSchema.parse({ newRenewalDate: '2026-12-27', confirmed: { amount: 21.94 } }).confirmed).toEqual({ amount: 21.94 })
    expect(changePaymentDateInputSchema.safeParse({ newRenewalDate: '2026-12-27', confirmed: { amount: '21.94' } }).success).toBe(false)
    const successes = picked.filter((call) => flag(call, 'changed', true))
    expect(successes.length).toBeGreaterThanOrEqual(10)
    expect(problems(changePaymentDateOutputSchema, successes, (call) => call.result)).toEqual([])
    expect(dropped(successes.map((call) => call.result as Row), changePaymentDateOutputSchema, 'changed')).toEqual([])
    // FB2's "success" has no order: the contract allows null there, as the old answer.
    expect(successes.some((call) => (call.result as Row)['orderId'] === null && typeof (call.result as Row)['warning'] === 'string')).toBe(true)
    // The old refusals carry words and no reason: the Worker gives each a reason (W41), and the words fit.
    const refused = picked.filter((call) => flag(call, 'changed', false))
    expect(refused.length).toBeGreaterThan(35)
    expect(refused.every((call) => typeof (call.result as Row)['message'] === 'string' && !('reason' in (call.result as Row)))).toBe(true)
    expect(refusals('changeMembershipPaymentDate', 'changed', 'payment_date')).toEqual([])
  })

  it('adjustMembershipCredits and its history: params, successes and rows fit', () => {
    const picked = of('adjustMembershipCredits')
    expect(picked.length).toBeGreaterThanOrEqual(28)
    expect(problems(adjustMembershipCreditsInputSchema, picked, (call) => body(call.params, 'membershipId'))).toEqual([])
    // An amount of 1.5 or 0, and an empty reason, are the rule's to refuse.
    expect(adjustMembershipCreditsInputSchema.safeParse({ creditType: 'gold', amount: 1.5, reason: '' }).success).toBe(true)
    const successes = picked.filter((call) => flag(call, 'adjusted', true))
    expect(successes.length).toBeGreaterThanOrEqual(15)
    expect(problems(adjustMembershipCreditsOutputSchema, successes, (call) => call.result)).toEqual([])
    expect(dropped(successes.map((call) => call.result as Row), adjustMembershipCreditsOutputSchema, 'adjusted')).toEqual([])
    expect(successes.some((call) => 'period' in (call.result as Row))).toBe(true)
    expect(successes.some((call) => 'addon_credits_remaining' in (call.result as Row))).toBe(true)
    expect(refusals('adjustMembershipCredits', 'adjusted', 'credits')).toEqual([])
    const rows = listRows('getMembershipCreditAdjustments')
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rowProblems(membershipCreditAdjustmentRowSchema, rows)).toEqual([])
    expect(dropped(rows.map(({ row }) => row), membershipCreditAdjustmentRowSchema)).toEqual([])
  })

  it('setMembershipHerd: true, false and null fit the input; every success fits the output', () => {
    const picked = of('setMembershipHerd')
    expect(picked.length).toBeGreaterThanOrEqual(10)
    expect(problems(setMembershipHerdInputSchema, picked, (call) => body(call.params, 'membershipId'))).toEqual([])
    expect(new Set(picked.map((call) => call.params['herd']))).toEqual(new Set([true, false, null]))
    expect(setMembershipHerdInputSchema.safeParse({}).success).toBe(false)
    const successes = picked.filter((call) => flag(call, 'updated', true))
    expect(successes.length).toBeGreaterThanOrEqual(5)
    expect(problems(setMembershipHerdOutputSchema, successes, (call) => call.result)).toEqual([])
    expect(dropped(successes.map((call) => call.result as Row), setMembershipHerdOutputSchema, 'updated')).toEqual([])
    expect(dropped(successes.map((call) => (call.result as Row)['membership'] as Row), setMembershipHerdOutputSchema.shape.membership)).toEqual([])
    expect(refusals('setMembershipHerd', 'updated', 'herd')).toEqual([])
  })

  it('getSubscriptions: every row fits, field for field', () => {
    const picked = of('getSubscriptions')
    expect(problems(membershipListInputSchema, picked, (call) => call.params)).toEqual([])
    const rows = listRows('getSubscriptions')
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(rowProblems(membershipListRowSchema, rows)).toEqual([])
    expect(dropped(rows.map(({ row }) => row), membershipListRowSchema)).toEqual([])
    // Every field but W40's `refunded` is one the old list gives.
    const given = new Set(rows.flatMap(({ row }) => Object.keys(row)))
    expect(Object.keys(shapeOf(membershipListRowSchema)).filter((field) => !given.has(field))).toEqual(['refunded'])
    // The old list never hands out the Stripe subscription's id.
    expect(given.has('stripe_subscription_id')).toBe(false)
    expect(rows.some(({ row }) => typeof row['payment_date_change_blocked'] === 'string')).toBe(true)
  })

  it('adjustCustomerStoreCredit: every press fits the input, whatever was typed; every success fits the output', () => {
    const picked = of('adjustCustomerStoreCredit')
    expect(picked.length).toBeGreaterThanOrEqual(23)
    expect(problems(adjustStoreCreditInputSchema, picked, (call) => body(call.params, 'customerId'))).toEqual([])
    // An amount sent as text and a reason of null are among them: the rule refuses with the old words.
    expect(picked.some((call) => typeof call.params['amount'] === 'string')).toBe(true)
    expect(picked.some((call) => call.params['reason'] === null)).toBe(true)
    const successes = picked.filter((call) => flag(call, 'ok', true))
    expect(successes.length).toBeGreaterThanOrEqual(8)
    expect(problems(adjustStoreCreditOutputSchema, successes, (call) => call.result)).toEqual([])
    expect(dropped(successes.map((call) => call.result as Row), adjustStoreCreditOutputSchema, 'ok')).toEqual([])
    expect(refusals('adjustCustomerStoreCredit', 'ok', 'store_credit')).toEqual([])
  })

  it('createCustomer, getCustomers and getCustomerDetail: params, rows and the profile fit', () => {
    const created = of('createCustomer')
    expect(created.length).toBeGreaterThan(15)
    expect(problems(createCustomerInputSchema, created, (call) => call.params)).toEqual([])
    const rows = created.filter(answered)
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(problems(createCustomerOutputSchema, rows, (call) => call.result)).toEqual([])
    expect(dropped(rows.map((call) => call.result as Row), createCustomerOutputSchema)).toEqual([])

    expect(problems(customerListInputSchema, of('getCustomers'), (call) => call.params)).toEqual([])
    const listed = listRows('getCustomers')
    expect(listed.length).toBeGreaterThan(8)
    expect(rowProblems(customerListRowSchema, listed)).toEqual([])
    expect(dropped(listed.map(({ row }) => row), customerListRowSchema)).toEqual([])
    // The list says whether a card is saved, never which.
    expect(listed.some(({ row }) => 'saved_payment_method_id' in row || 'stripe_customer_id' in row)).toBe(false)

    const profiles = of('getCustomerDetail')
    expect(profiles.length).toBeGreaterThanOrEqual(6)
    expect(problems(customerDetailOutputSchema, profiles, (call) => call.result)).toEqual([])
    expect(dropped(profiles.map((call) => call.result as Row), customerDetailOutputSchema)).toEqual([])
    const lists = (name: string): Row[] => profiles.flatMap((call) => (call.result as Record<string, Row[]>)[name] ?? [])
    const shape = customerDetailOutputSchema.shape
    for (const name of ['memberships', 'sessionPasses', 'bookingHistory', 'storeCreditHistory', 'eventBookings'] as const) expect(lists(name).length, name).toBeGreaterThan(0)
    // The old read selects `cm.*` and `csp.*`; these are the columns that brought along which no screen's type names
    // (frontend/types and the function's own interfaces). The Worker's read names its fields (F-plan 4.6), without them.
    expect(dropped(lists('memberships'), shape.memberships.element)).toEqual(['order_line_item_id'])
    expect(dropped(lists('sessionPasses'), shape.sessionPasses.element)).toEqual(['order_line_item_id'])
    expect(dropped(lists('bookingHistory'), shape.bookingHistory.element)).toEqual([])
    expect(dropped(lists('storeCreditHistory'), shape.storeCreditHistory.element)).toEqual([])
    expect(dropped(lists('eventBookings'), shape.eventBookings.element)).toEqual([])
  })

  it('the gift card actions and reads: params, successes and rows fit', () => {
    const extended = of('extendGiftCardExpiry')
    expect(extended.length).toBeGreaterThan(15)
    expect(problems(extendGiftCardInputSchema, extended, (call) => body(call.params, 'giftCardId'))).toEqual([])
    const extendedOk = extended.filter((call) => flag(call, 'updated', true))
    expect(extendedOk.length).toBeGreaterThanOrEqual(8)
    expect(problems(extendGiftCardOutputSchema, extendedOk, (call) => call.result)).toEqual([])
    expect(dropped(extendedOk.map((call) => (call.result as Row)['giftCard'] as Row), extendGiftCardOutputSchema.shape.giftCard)).toEqual([])
    expect(refusals('extendGiftCardExpiry', 'updated', 'gift_card_extend')).toEqual([])

    expect(problems(setGiftCardPickedUpInputSchema, of('setGiftCardPickedUp'), (call) => body(call.params, 'giftCardId'))).toEqual([])
    expect(problems(setGiftCardShippedInputSchema, of('setGiftCardShipped'), (call) => body(call.params, 'giftCardId'))).toEqual([])
    const flagged = [...of('setGiftCardPickedUp'), ...of('setGiftCardShipped')].filter((call) => flag(call, 'updated', true))
    expect(flagged.length).toBeGreaterThanOrEqual(6)
    expect(problems(giftCardFlagOutputSchema, flagged, (call) => call.result)).toEqual([])
    expect(dropped(flagged.map((call) => (call.result as Row)['giftCard'] as Row), giftCardRowSchema)).toEqual([])
    expect(refusals('setGiftCardPickedUp', 'updated', 'gift_card_picked_up')).toEqual([])
    expect(refusals('setGiftCardShipped', 'updated', 'gift_card_shipped')).toEqual([])

    expect(problems(giftCardListInputSchema, of('getGiftCards'), (call) => call.params)).toEqual([])
    const cards = listRows('getGiftCards')
    expect(cards.length).toBeGreaterThan(8)
    expect(rowProblems(giftCardListRowSchema, cards)).toEqual([])
    expect(dropped(cards.map(({ row }) => row), giftCardListRowSchema)).toEqual([])
    // Every column of the table is in the contract, and every field of the contract is a column or the purchaser's.
    const given = new Set(cards.flatMap(({ row }) => Object.keys(row)))
    expect(Object.keys(shapeOf(giftCardListRowSchema)).filter((field) => !given.has(field))).toEqual([])

    const used = listRows('getGiftCardRedemptions')
    expect(used.length).toBeGreaterThanOrEqual(1)
    expect(rowProblems(giftCardRedemptionRowSchema, used)).toEqual([])
    expect(dropped(used.map(({ row }) => row), giftCardRedemptionRowSchema)).toEqual([])
  })

  it("every thrown refusal's words fit the refusal details too", () => {
    const thrown = calls.filter((call) => call.result !== null && typeof call.result === 'object' && 'thrown' in (call.result as Row) && call.action !== 'createOrder')
    expect(thrown.length).toBeGreaterThanOrEqual(36)
    expect(problems(accountRefusalDetailsSchema, thrown, (call) => ({ reason: 'refused', message: (call.result as Row)['thrown'], action: 'credits' }))).toEqual([])
  })
})

describe("step F's new inputs, the saved card's addition, and the left step on the Orders page's contracts", () => {
  it('every action a refusal can come from is named, and a refusal can carry the quote, a held change and the switch kinds', () => {
    expect(accountActionSchema.options).toEqual(['cancel', 'undo_cancel', 'payment_date_quote', 'payment_date', 'credits', 'herd', 'store_credit', 'create_customer', 'gift_card_extend', 'gift_card_picked_up', 'gift_card_shipped', 'saved_card'])
    const details = { reason: 'membership_path_off', message: 'This is switched off in the booking system. Tell a manager.', action: 'cancel', kinds: ['membership_changes'] }
    expect(accountRefusalDetailsSchema.parse(details)).toEqual(details)
    expect(accountRefusalDetailsSchema.parse({ reason: 'payment_unconfirmed', message: 'Held.', action: 'payment_date', held: { changeId: 'c1' } }).held).toEqual({ changeId: 'c1' })
    expect(accountRefusalDetailsSchema.safeParse({ reason: 'x', message: 'y', action: 'refund' }).success).toBe(false)
    expect(accountRefusalDetailsSchema.safeParse({ message: 'y', action: 'cancel' }).success).toBe(false)
  })

  it("W42's addition to the saved card's answer sits beside today's five fields, which don't change", () => {
    const today = { id: 'c', stripe_customer_id: 'cus_1', saved_payment_method_id: 'pm_1', saved_card_last4: '4242', saved_card_brand: 'visa' }
    expect(saveCustomerCardOutputSchema.parse(today)).toEqual(today)
    expect(savedCardMembershipsSchema.parse({ membershipsMoved: 1, membershipsToMove: 0 })).toEqual({ membershipsMoved: 1, membershipsToMove: 0 })
    expect(savedCardMembershipsSchema.safeParse({ membershipsMoved: 1 }).success).toBe(false)
    expect(saveCustomerCardOutputSchema.extend(savedCardMembershipsSchema.shape).parse({ ...today, membershipsMoved: 2, membershipsToMove: 1 })).toMatchObject({ membershipsMoved: 2, membershipsToMove: 1 })
  })

  it("the Orders page's contracts know a left step: on the stuck list, as a reconcile item, and as something the manual close can sort", () => {
    // W40: `what` says what it is for the screen (with `lastDay` for a cancel date to set).
    const step = { stepId: 's', membershipId: 'm', subscriptionId: 'sub_1', step: 'cancel_at', what: 'cancel_date', lastDay: '2026-12-09', customerId: null, customerName: null, state: 'refused', at: '2026-11-15T10:00:00.000Z', words: 'x', close: { kind: 'left_step', orderId: 's' } }
    expect(stuckStepSchema.parse(step)).toEqual(step)
    expect(stuckStepSchema.safeParse({ ...step, step: 'trial_end' }).success).toBe(false)
    expect(stuckStepSchema.safeParse({ ...step, state: 'done' }).success).toBe(false)
    expect(stuckStepSchema.safeParse({ ...step, what: 'trial' }).success).toBe(false)
    expect(stuckStepSchema.safeParse({ ...step, what: undefined }).success).toBe(false)
    expect(stuckStepSchema.parse({ ...step, what: 'clear_cancel_date', lastDay: undefined }).lastDay).toBeUndefined()
    const list = { checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [], steps: [step], alert: null }
    expect(stuckListOutputSchema.parse(list).steps).toEqual([step])
    // W41 adds one kind after it (`held_payment_date`: a payment date change left for a person), as W36 added this one.
    // W47, a named difference: one more after those (`payment_watch`: a watched payment whose watch ran out).
    // W47r-a, a named difference: and `retry_paid_after_end` after that (Mark refunded on a payment tried again from the
    // desk that was taken after the membership's subscription had ended; the W47r review's S1).
    // W47r-d, a named difference: and `paid_after_end_owed` last (Mark as owed, the second close of that same line: a
    // payment that was for a period the member had; W47r-c "Noticed" 3).
    // W57, a named difference: and `plan_step` last (Mark sorted on a membership plan's Stripe step refused for good).
    expect(stuckCloseKindSchema.options.slice(7)).toEqual(['left_step', 'held_payment_date', 'payment_watch', 'retry_paid_after_end', 'paid_after_end_owed', 'plan_step'])
    // The seven kinds before it are as they were, in their order.
    expect(stuckCloseKindSchema.options.slice(0, 7)).toEqual(['held_order', 'changed_elsewhere', 'subscription_left', 'late_refund', 'held_flow', 'held_claim', 'refund_watch'])
    expect(reconcileItemSchema.parse({ kind: 'step', id: 's', outcome: 'left', reason: 'step_refused' })).toMatchObject({ kind: 'step' })
    // W41: and `date_change`, a payment date change still pending, after it.
    // W47r, a named difference: and `payment_retry`, a membership payment tried again from the desk and still open, after that.
    // W57, a named difference: and `plan`, a membership plan's Stripe side (a change held, a plan half made, a plan step), last.
    expect(reconcileItemSchema.shape.kind.options).toEqual(['order', 'flow', 'refund', 'claim', 'step', 'date_change', 'payment_retry', 'plan'])
    expect(reconcileItemSchema.parse({ kind: 'date_change', id: 'c', outcome: 'left', reason: 'payment_processing' })).toMatchObject({ kind: 'date_change' })
    expect(reconcileItemSchema.parse({ kind: 'payment_retry', id: 'r', outcome: 'left', reason: 'payment_processing' })).toMatchObject({ kind: 'payment_retry' })
    // A held retry has no close of its own (W47r), but for one paid after its subscription ended (W47r-a): eleven kinds.
    // W47r-d, a named difference: twelve, with Mark as owed.
    // W57, a named difference: thirteen, with Mark sorted on a plan's Stripe step (`plan_step`).
    expect(stuckCloseKindSchema.options).toHaveLength(13)
    // An older Worker's list has no `paymentDates`: the contract still reads it.
    expect(stuckListOutputSchema.parse(list).paymentDates).toBeUndefined()
  })
})
