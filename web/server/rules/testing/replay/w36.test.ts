import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { STORE_CREDIT_REASONS, STORE_CREDIT_WORDS, CREATE_CUSTOMER_WORDS } from '@/server/rules/customers/failure-messages'
import { GIFT_CARD_EXTEND_REASONS, GIFT_CARD_PICKED_UP_REASONS, GIFT_CARD_SHIPPED_REASONS } from '@/server/rules/gift-cards/failure-messages'
import { MEMBERSHIP_CANCEL_REASONS, MEMBERSHIP_CREDIT_WORDS, PAYMENT_DATE_REFUSALS, PAYMENT_DATE_WORDS } from '@/server/rules/memberships/failure-messages'
import { compareRecordings, type AllowedDifference, type Recording } from './compare'
import { LEGACY_ACCOUNT_ACTIONS, legacyAccountDir, oldFunctionPath, oldSide, readGolden, replay, startReplay, type ReplayEnvironment, type ReplayOptions } from './harness'
import { scenarios, W36_PREFIX } from './scenarios'
import { WHAT_EACH_PROVES } from './w36-what-each-proves'

// Brief W36 item 4 (F-plan 4.12 items 1 and 2, lead call L5): step F's golden files, recorded from the old membership,
// customer, store credit and gift card functions and the three legacy membership routes while they still exist, and
// replayed against the frozen copy of them (legacy-account/). `replay.test.ts` holds every scenario to its golden
// file, twice over (the same recording every time; it matches the file). This file says, in pounds and pence, what
// each W36 scenario proves on the old code, so that a scenario that stopped reaching the branch it is named for fails
// here; that the list covers every refusal, every success and every bug the plan names; and (brief item 5) that a
// deliberate difference from a golden file is caught and an allowance nobody needs fails.
//
// W37 to W43 replay these through the Worker's routes and name each difference. Until then they are the old code's.

vi.setConfig({ testTimeout: 30_000 })

const w36 = scenarios.filter((scenario) => scenario.name.startsWith(W36_PREFIX))
type Row = Record<string, unknown>
const money = (value: unknown): string => `£${Number(value ?? 0).toFixed(2)}`
const golden = (name: string): Recording => {
  const recording = readGolden(`${W36_PREFIX}${name}`)
  if (!recording) throw new Error(`No golden file for ${W36_PREFIX}${name}: record it with UPDATE_GOLDEN=1 (testing/README.md).`)
  return recording
}
const said = (message: unknown): string => (typeof message === 'string' ? ` "${message}"` : '')

/**
 * One step's outcome in a line: who refused and in what words, or what changed, in pounds, pence and dates. Null for
 * a set-up order that went through (not a step of the functions under test).
 */
function outcome(result: unknown): string | null {
  if (result === null) return 'null'
  if (Array.isArray(result)) return `${result.length} ${result.length === 1 ? 'row' : 'rows'}`
  if (typeof result !== 'object') return String(result)
  const r = result as Row
  if ('thrown' in r) return `thrown: ${String(r['thrown'])}`
  // createOrder and refundOrder (set-up): only a refusal is a step worth a line.
  if ('success' in r) return r['success'] === true ? null : `order refused: ${String(r['reason'])}`
  if ('updated' in r) {
    if (r['updated'] !== true) return `refused: ${String(r['reason'] ?? 'no reason')}${said(r['message'])}`
    const membership = r['membership'] as Row | undefined
    if (membership && 'is_herd' in membership) return `Herd ${membership['is_herd'] === true ? 'on' : 'off'} (override ${String(membership['herd_override'])}), ${String(membership['addon_credits_remaining'])} add-on credits`
    if (membership) {
      const lastDay = membership['cancel_effective_date']
      const stripe = r['stripeUpdated'] === false ? ', no Stripe change' : ''
      return lastDay === null ? 'no cancellation scheduled' : `last day ${String(lastDay)}${r['endDate'] ? `, ends ${String(r['endDate'])}` : ''}${stripe}`
    }
    const card = r['giftCard'] as Row
    const flags = 'picked_up' in card ? `, picked up ${String(card['picked_up'])} (by ${card['picked_up_by'] === null ? 'nobody' : 'staff'}), shipped ${card['shipped_at'] === null ? 'no' : 'yes'} (by ${card['shipped_by'] === null ? 'nobody' : 'staff'})` : ''
    return `gift card expires ${String(card['expiry_date'])}, ${card['voided'] === true ? 'voided' : 'not voided'}${flags}`
  }
  if ('changed' in r) {
    if (r['changed'] !== true) return `refused:${said(r['message'])}`
    return `payment date moved to ${String(r['newRenewalDate'])}: ${money(r['amountCharged'])} for ${String(r['extraDays'])} days, order ${r['orderId'] === null ? 'none' : 'written'}${r['warning'] ? ` (+warning${said(r['warning'])})` : ''}`
  }
  if ('adjusted' in r) {
    if (r['adjusted'] !== true) return `refused: ${String(r['reason'])}${said(r['message'])}`
    const period = r['period'] as Row | undefined
    return period ? `session credits: ${String(period['credits_allocated'])} allocated, ${String(period['credits_used'])} used` : `add-on credits: ${String(r['addon_credits_remaining'])}`
  }
  if ('ok' in r) {
    if (r['ok'] !== true) return `refused: ${String(r['reason'] ?? 'no reason')}${said(r['message'])}`
    const applied = Number(r['appliedAmount'])
    return `store credit ${applied > 0 ? '+' : '-'}${money(Math.abs(applied))}, balance ${money(r['balance'])}`
  }
  if ('refusal' in r && 'membershipId' in r) {
    const window = r['earliestDate'] ? `${String(r['earliestDate'])} to ${String(r['latestDate'])}` : 'no window'
    const figure = r['amount'] !== undefined ? `, ${String(r['extraDays'])} days ${money(r['amount'])}` : ''
    return `quote: ${r['refusal'] === null ? 'allowed' : `refused${said(r['refusal'])}`}, ${window}${figure}${r['dateError'] ? `, date refused${said(r['dateError'])}` : ''}${r['needsOverride'] === true ? ', needs override' : ''}`
  }
  if ('first_name' in r && 'date_of_birth' in r) return `customer created: ${String(r['first_name'])} ${String(r['last_name'])} <${String(r['email'])}>, born ${String(r['date_of_birth'])}, phone ${String(r['phone'])}`
  if ('memberships' in r && 'sessionPasses' in r) {
    const count = (key: string) => (r[key] as unknown[]).length
    const blocked = (r['memberships'] as Row[]).map((membership) => membership['payment_date_change_blocked']).filter((words) => words !== null)
    return `profile: ${count('memberships')} memberships, ${count('sessionPasses')} passes, ${count('bookingHistory')} bookings, ${count('eventBookings')} event bookings, store credit ${money(r['storeCreditBalance'])} (${count('storeCreditHistory')} movements)${blocked.length > 0 ? `, payment date refused${said(blocked[0])}` : ''}`
  }
  return JSON.stringify(r)
}
const outcomes = (recording: Recording): string[] => recording.results.map(outcome).filter((line): line is string => line !== null)
const stripeCalls = (recording: Recording, method: string) => recording.stripeCalls.filter((call) => call.method === method)
const allOutcomes = (): string[] => w36.flatMap((scenario) => outcomes(golden(scenario.name.slice(W36_PREFIX.length))))

// Only when re-recording: W36_OUTCOMES_OUT=<file> writes every scenario's lines, for w36-what-each-proves.ts.
if (process.env.W36_OUTCOMES_OUT) {
  writeFileSync(process.env.W36_OUTCOMES_OUT, `${JSON.stringify(Object.fromEntries(w36.map((scenario) => [scenario.name.slice(W36_PREFIX.length), outcomes(golden(scenario.name.slice(W36_PREFIX.length)))])), null, 2)}\n`)
}

describe("step F's golden files (brief W36 item 4)", () => {
  it('137 scenarios, each with a golden file and a line here saying what it proves', () => {
    expect(w36).toHaveLength(137)
    expect(w36.map((scenario) => scenario.name.slice(W36_PREFIX.length)).sort()).toEqual(Object.keys(WHAT_EACH_PROVES).sort())
    for (const scenario of w36) expect(readGolden(scenario.name), scenario.name).not.toBeNull()
    expect(new Set(scenarios.map((scenario) => scenario.name)).size).toBe(scenarios.length)
  })

  it.each(Object.keys(WHAT_EACH_PROVES))('%s: each step ends as recorded', (name) => {
    expect(outcomes(golden(name))).toEqual(WHAT_EACH_PROVES[name])
  })

  it('they run through the frozen copy of the old code: all sixteen step F functions, loaded from it', () => {
    expect(LEGACY_ACCOUNT_ACTIONS.size).toBe(16)
    for (const action of LEGACY_ACCOUNT_ACTIONS) expect(oldFunctionPath(action).startsWith(legacyAccountDir), action).toBe(true)
  })
})

describe('the list covers every refusal, every success and every bug the plan names (F-plan 4.12 item 1)', () => {
  const lines = allOutcomes()
  const refusedWith = (words: string) => lines.some((line) => line.includes(`"${words}`))
  const thrownWith = (words: string) => lines.some((line) => line === `thrown: ${words}`)

  it("the membership cancel: only two of its five reasons are ever produced (FB5: the other three are the dialog's alone)", () => {
    const produced = MEMBERSHIP_CANCEL_REASONS.filter((reason) => lines.some((line) => line.startsWith(`refused: ${reason} `)))
    expect(produced).toEqual(['membership_not_found', 'permission_denied'])
    // Inside and after the minimum term, yearly, undo, with no subscription.
    expect(outcomes(golden('cancel-monthly-after-the-minimum-term'))).toEqual(['last day 2026-12-09, ends 2026-12-10'])
    expect(outcomes(golden('cancel-monthly-inside-the-minimum-term'))).toEqual(['last day 2027-01-09, ends 2027-01-10'])
    expect(outcomes(golden('cancel-yearly'))).toEqual(['last day 2027-01-09, ends 2027-01-10'])
    expect(outcomes(golden('cancel-then-undo')).at(-1)).toBe('no cancellation scheduled')
    expect(outcomes(golden('cancel-with-no-subscription'))[0]).toBe('last day 2026-12-09, ends 2026-12-10, no Stripe change')
  })

  it("the payment date change: every refusal of the quote, in its words, and every word of the press and the legacy route that can be reached", () => {
    for (const [name, words] of Object.entries(PAYMENT_DATE_REFUSALS)) if (typeof words === 'string') expect(refusedWith(words), name).toBe(true)
    expect(refusedWith(PAYMENT_DATE_REFUSALS.changedRecently('10 Nov 2026', '27 Dec 2026'))).toBe(true)
    const reached: Array<keyof typeof PAYMENT_DATE_WORDS> = ['paramsRequired', 'permissionDenied', 'notFound', 'noRenewalDate', 'nothingToCharge', 'overrideNeeded', 'inProgress', 'customerMismatch', 'stripeCancelScheduled', 'stripeNotMonthly', 'amountTooHigh']
    for (const name of reached) expect(refusedWith(PAYMENT_DATE_WORDS[name] as string), name).toBe(true)
    expect(refusedWith(PAYMENT_DATE_WORDS.chooseDate('11 Dec 2026', '9 Jan 2027'))).toBe(true)
    expect(refusedWith(PAYMENT_DATE_WORDS.declined('Your card was declined'))).toBe(true)
    expect(refusedWith(PAYMENT_DATE_WORDS.declined(PAYMENT_DATE_WORDS.authenticationRequired.replace(/\.$/, '')))).toBe(true)
    expect(refusedWith(PAYMENT_DATE_WORDS.stripeNotActive('past_due'))).toBe(true)
    // The stale-date guard's dates come back worded as the function words them.
    expect(refusedWith("Stripe's next payment is on 10 Dec 2026, but the membership shows 12 Dec 2026. Refresh and try again.")).toBe(true)
    expect(refusedWith(PAYMENT_DATE_WORDS.refundedInFull('This subscription cannot be updated right now.'))).toBe(true)
    // What can't be reached through the function (the W36 report says why): these two.
    expect(refusedWith(PAYMENT_DATE_WORDS.cannotWorkOut)).toBe(false)
    expect(lines.some((line) => line.includes('did not complete (status:'))).toBe(false)
  })

  it('credits, Herd, store credit, gift cards and customers: every reason and every thrown word', () => {
    for (const [name, words] of Object.entries(MEMBERSHIP_CREDIT_WORDS)) {
      if (typeof words !== 'string') continue
      expect(name === 'permissionDenied' ? refusedWith(words) : thrownWith(words), name).toBe(true)
    }
    expect(thrownWith(MEMBERSHIP_CREDIT_WORDS.belowUsed(0, 1))).toBe(true)
    expect(lines).toContain('refused: not_found')
    // Store credit: the database's `amount_required` can't be reached (the function refuses 0 first), nor its last sentence.
    expect(STORE_CREDIT_REASONS.filter((reason) => lines.some((line) => line.startsWith(`refused: ${reason} `)))).toEqual(['insufficient_store_credit', 'customer_not_found'])
    for (const name of ['customerRequired', 'modeInvalid', 'amountInvalid', 'reasonRequired', 'belowZero', 'customerGone'] as const) expect(refusedWith(STORE_CREDIT_WORDS[name]), name).toBe(true)
    expect(refusedWith(STORE_CREDIT_WORDS.refused)).toBe(false)
    for (const reason of [...GIFT_CARD_EXTEND_REASONS, ...GIFT_CARD_PICKED_UP_REASONS, ...GIFT_CARD_SHIPPED_REASONS]) expect(lines.some((line) => line.startsWith(`refused: ${reason}`)), reason).toBe(true)
    for (const [name, words] of Object.entries(CREATE_CUSTOMER_WORDS)) expect(thrownWith(words), name).toBe(true)
    // Each staff refusal, on each kind of check the old functions have.
    for (const words of ['This staff account is inactive. Ask an admin to reactivate it.', 'Needs Issue refunds permission — this action moves money back to the customer.']) expect(thrownWith(words), words).toBe(true)
    expect(lines.some((line) => line.startsWith("thrown: No staff record matches the logged-in user's email (jo@example.com)."))).toBe(true)
  })

  it("each read's shape is recorded: the seven reads, with rows in them", () => {
    const reads = ['getSubscriptions', 'getCustomers', 'getCustomerDetail', 'getGiftCards', 'getGiftCardRedemptions', 'getMembershipCreditAdjustments', 'getMembershipPaymentDateQuote']
    for (const read of reads) expect(LEGACY_ACCOUNT_ACTIONS.has(read), read).toBe(true)
    const profile = golden('customer-detail').results.find((result) => result !== null && typeof result === 'object' && 'memberships' in (result as Row)) as Row
    for (const list of ['memberships', 'bookingHistory', 'storeCreditHistory', 'eventBookings']) expect((profile[list] as unknown[]).length, list).toBeGreaterThan(0)
    expect(outcomes(golden('customer-detail'))[2]).toContain('1 passes')
    expect((golden('subscriptions-list-and-search').results[0] as unknown[]).length).toBe(2)
    expect((golden('customers-list-and-search').results[0] as unknown[]).length).toBe(2)
    expect((golden('gift-cards-list-and-search').results[0] as unknown[]).length).toBe(3)
    expect((golden('gift-card-redemptions').results.at(-2) as unknown[]).length).toBe(1)
    expect((golden('credits-session-up-and-down-with-the-history').results.at(-1) as unknown[]).length).toBe(2)
  })
})

describe("today's outcome for each bug of the plan's section 3 that can be recorded, in pounds and pence", () => {
  const charges = (name: string) => stripeCalls(golden(name), 'paymentIntents.create').map((call) => (call.params as { amount: number }).amount)
  const added = (name: string, table: string): Row[] => golden(name).tables[table]?.added ?? []

  it('FB1: the Worker dies after the charge; the press again takes £21.94 a second time. £43.88 for 17 days, one order', () => {
    const name = 'fb1-payment-date-worker-dies-after-the-charge-then-pressed-again'
    expect(charges(name)).toEqual([2194, 2194])
    expect(stripeCalls(golden(name), 'refunds.create')).toEqual([])
    expect(added(name, 'orders').map((order) => order['order_total'])).toEqual(['21.94'])
    expect(added(name, 'membership_payment_date_changes').map((row) => row['status'])).toEqual(['failed', 'done'])
    // The first charge is on no order and no record.
    expect(added(name, 'membership_payment_date_changes')[0]).toMatchObject({ stripe_payment_intent_id: null, order_id: null })
  })

  it('FB2: charged and moved in Stripe, the recording fails: "success", no order, and staff are asked to add one by hand', () => {
    for (const name of ['fb2-payment-date-charged-and-moved-then-recording-fails', 'fb2-payment-date-charged-and-moved-then-nothing-can-be-recorded']) {
      expect(charges(name)).toEqual([2194])
      expect(stripeCalls(golden(name), 'subscriptions.update')).toHaveLength(1)
      expect(added(name, 'orders')).toEqual([])
      expect(golden(name).tables['customer_memberships']).toBeUndefined()
      expect((golden(name).results[0] as Row)['warning']).toContain('Fix by hand: add a paid card order for £21.94')
    }
    expect(added('fb2-payment-date-charged-and-moved-then-recording-fails', 'membership_payment_date_changes')[0]).toMatchObject({ status: 'done', order_id: null })
    expect(added('fb2-payment-date-charged-and-moved-then-nothing-can-be-recorded', 'membership_payment_date_changes')[0]).toMatchObject({ status: 'pending' })
  })

  it('FB3: the date move is refused and the refund fails: £21.94 taken, the date not moved, "refund it in Stripe", nothing listed', () => {
    const name = 'fb3-payment-date-move-refused-and-the-refund-fails'
    expect(charges(name)).toEqual([2194])
    expect(stripeCalls(golden(name), 'refunds.create').map((call) => call.idempotencyKey)).toEqual([null])
    expect(added(name, 'membership_payment_date_changes')[0]).toMatchObject({ status: 'failed' })
    expect(String(added(name, 'membership_payment_date_changes')[0]?.['failure_message'])).toContain('refund it in Stripe')
    expect(golden(name).tables['audit_log']).toBeUndefined()
  })

  it('FB4: the dialog showed £21.94; the press took £24.68', () => {
    const name = 'fb4-payment-date-the-figure-changes-between-the-quote-and-the-press'
    expect(outcomes(golden(name))[0]).toContain('17 days £21.94')
    expect(charges(name)).toEqual([2468])
    expect(added(name, 'orders').map((order) => order['order_total'])).toEqual(['24.68'])
  })

  it('FB5: a cancel on a cancelled or failing membership goes through; an undo with nothing to undo too; an ended membership reads as running again', () => {
    expect(outcomes(golden('fb5-cancel-on-a-cancelled-membership'))).toEqual(['last day 2026-12-09, ends 2026-12-10, no Stripe change'])
    expect(outcomes(golden('fb5-cancel-on-a-membership-whose-payment-is-failing'))).toEqual(['last day 2026-12-09, ends 2026-12-10'])
    expect(outcomes(golden('fb5-undo-with-no-cancel-scheduled'))).toEqual(['no cancellation scheduled'])
    // Ended yesterday: a credit booking is refused, the undo clears the end date, and the same booking then costs nothing.
    const ended = golden('fb5-undo-on-a-membership-that-ended-yesterday')
    expect(outcomes(ended)).toEqual(['order refused: membership_not_found', 'no cancellation scheduled'])
    expect(ended.tables['bookings']?.added[0]).toMatchObject({ redemption_source: 'membership_credit', price_paid: '0.00', status: 'confirmed' })
    expect(ended.stripeCalls).toEqual([])
  })

  it('FB6 (Q33): the minimum term rolls over: started 31 December it ends 3 March, not 28 February; started 31 July, 1 October, not 30 September', () => {
    expect(outcomes(golden('fb6-monthly-started-31-december-ends-3-march'))).toEqual(['last day 2027-03-02, ends 2027-03-03'])
    expect(outcomes(golden('fb6-monthly-started-31-july-ends-1-october'))).toEqual(['last day 2026-09-30, ends 2026-10-01'])
  })

  it('FB7: two adjustments at once lose one (+2 and +1 leave 5, not 7); a booking between the check and the write leaves more used than allocated', () => {
    const lost = golden('fb7-two-session-adjustments-at-once-lose-one')
    expect(lost.tables['membership_credit_periods']?.changed[0]).toMatchObject({ credits_allocated: [4, 5] })
    expect(added('fb7-two-session-adjustments-at-once-lose-one', 'membership_credit_adjustments').map((row) => row['amount']).sort()).toEqual([1, 2])
    const overdrawn = golden('fb7-a-credit-booking-lands-between-the-check-and-the-write')
    expect(overdrawn.tables['membership_credit_periods']?.changed[0]).toMatchObject({ credits_allocated: [1, 0] })
    expect(overdrawn.tables['bookings']?.added).toHaveLength(1)
  })

  it('FB8 to FB10: a record that fails leaves credits moved with no record; a second press adds again; add-on credits go to -3; an empty reason is taken', () => {
    const unrecorded = golden('fb8-the-record-fails-after-the-credits-moved-then-retried')
    expect(unrecorded.tables['membership_credit_periods']?.changed[0]).toMatchObject({ credits_allocated: [4, 8] })
    expect(unrecorded.tables['customer_memberships']?.changed[0]).toMatchObject({ addon_credits_remaining: [2, 6] })
    expect(added('fb8-the-record-fails-after-the-credits-moved-then-retried', 'membership_credit_adjustments').map((row) => [row['credit_type'], row['amount']])).toEqual([['session', 2], ['addon', 2]])
    expect(golden('fb9-the-same-adjustment-pressed-twice-adds-twice').tables['membership_credit_periods']?.changed[0]).toMatchObject({ credits_allocated: [4, 8] })
    expect(golden('fb10-addon-credits-taken-below-zero').tables['customer_memberships']?.changed[0]).toMatchObject({ addon_credits_remaining: [2, -3] })
    expect(added('fb10-an-empty-reason-is-accepted', 'membership_credit_adjustments').map((row) => row['reason'])).toEqual(['', '   '])
  })

  it('FB11: nothing records who changed Herd; a clear that stops before the rule runs leaves the flag on with no override', () => {
    for (const name of ['herd-off-then-cleared-goes-back-to-the-automatic-rule', 'herd-on-for-a-new-member-then-cleared', 'fb11-herd-clear-stops-before-the-automatic-rule-runs']) expect(golden(name).tables['audit_log'], name).toBeUndefined()
    expect(golden('fb11-herd-clear-stops-before-the-automatic-rule-runs').tables['customer_memberships']?.changed[0]).toMatchObject({ is_herd: [false, true] })
    expect(golden('fb11-herd-clear-stops-before-the-automatic-rule-runs').tables['customer_memberships']?.changed[0]).not.toHaveProperty('herd_override')
  })

  it('FB12: the same £20 pressed twice gives £40', () => {
    const twice = golden('fb12-the-same-adjustment-pressed-twice-gives-twice')
    expect(twice.tables['customers']?.changed[0]).toMatchObject({ store_credit_balance: ['30.00', '70.00'] })
    expect(added('fb12-the-same-adjustment-pressed-twice-gives-twice', 'store_credit_transactions').map((row) => row['amount'])).toEqual(['20.00', '20.00'])
  })

  it('FB13 to FB15: a £60 card refunded to the card is reactivated and £20 of it spent; a card expired 14 months ago is still expired after "Extend"; two presses add two months', () => {
    const refunded = golden('fb13-a-card-voided-by-its-refund-is-reactivated-and-spent')
    expect(stripeCalls(refunded, 'refunds.create').map((call) => (call.params as { amount: number }).amount)).toEqual([6000])
    expect(refunded.tables['gift_cards']?.added[0]).toMatchObject({ original_value: '60.00', remaining_balance: '40.00', voided: false })
    expect(refunded.tables['gift_card_redemptions']?.added.map((row) => row['amount_used'])).toEqual(['20.00'])
    expect(outcomes(golden('fb14-a-long-expired-card-is-still-expired-after-extend'))).toEqual(['gift card expires 2025-10-10, not voided'])
    expect(outcomes(golden('fb15-extend-pressed-twice-adds-twice')).at(-1)).toBe('gift card expires 2030-03-01, not voided')
    expect(golden('fb15-extend-pressed-twice-adds-twice').tables['audit_log']).toBeUndefined()
  })

  it('FB16: every read answers an inactive staff member; FB21: nothing records who created a customer, and the same email in another case sits beside the first', () => {
    const reads = golden('fb16-every-read-answers-an-inactive-staff-member')
    expect(reads.results).toHaveLength(7)
    expect(reads.results.some((result) => result !== null && typeof result === 'object' && 'thrown' in (result as Row))).toBe(false)
    expect(golden('fb21-create-customer-with-no-staff-record').tables['customers']?.added).toHaveLength(1)
    expect(golden('fb21-create-customer-with-no-staff-record').tables['audit_log']).toBeUndefined()
    expect(golden('fb21-the-same-email-in-another-case-added-by-another-writer').tables['customers']?.added.map((row) => row['email'])).toEqual(['SAM@example.com'])
  })

  it('FB18 and FB19 (N8): a payment-needed booking with a paid guest never lapses and holds its two places; a credit seat with a paid £5 towel lapses and the £5 is kept', () => {
    const plain = golden('lapse-sweep-a-booking-with-nothing-paid-is-cancelled')
    expect(plain.tables['bookings']?.added[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed', price_paid: '0.00' })
    expect(plain.tables['sessions']).toBeUndefined()
    expect(plain.tables['audit_log']).toBeUndefined()
    const held = golden('fb18-lapse-sweep-never-lapses-a-booking-with-a-paid-guest')
    expect(held.tables['bookings']?.added[0]).toMatchObject({ status: 'payment_needed', price_paid: '20.00', party_size: 2 })
    expect(held.tables['sessions']?.changed[0]).toMatchObject({ total_booked: [0, 2] })
    const kept = golden('fb19-lapse-sweep-cancels-a-credit-booking-and-keeps-its-paid-add-on')
    expect(kept.tables['bookings']?.added[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed', price_paid: '0.00' })
    expect(kept.tables['addon_order_lines']?.added[0]).toMatchObject({ redemption_source: 'paid', price_at_purchase: '5.00', removed_at: null, refunded_amount: '0.00' })
    expect(kept.tables['orders']?.added[0]).toMatchObject({ order_total: '5.00', payment_status: 'paid' })
    expect(golden('lapse-sweep-leaves-a-booking-whose-deadline-has-not-passed').tables['bookings']?.added[0]).toMatchObject({ status: 'payment_needed' })
  })

  it('found while recording (the W36 report, "For the Worker step"): a membership with no next payment date can\'t be cancelled; a date that doesn\'t exist gets a database error; someone with no staff record can clear a gift card\'s flags', () => {
    expect(outcomes(golden('cancel-with-no-next-renewal-date'))).toEqual(["refused: no reason \"Internal server error: Cannot read properties of null (reading 'split')\""])
    expect(outcomes(golden('create-customer-a-date-that-does-not-exist'))).toEqual(['thrown: date/time field value out of range: "1990-02-30"'])
    const flags = golden('gift-card-flags-with-no-staff-record')
    expect(outcomes(flags).filter((line) => line.startsWith('gift card'))).toHaveLength(2)
    expect(flags.tables['gift_cards']?.changed).toHaveLength(2)
  })
})

describe('a deliberate difference from a W36 golden file is caught, and an allowance nobody needs fails (brief W36 item 5)', () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  const scenario = (name: string) => {
    const found = w36.find((one) => one.name === `${W36_PREFIX}${name}`)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const run = (name: string, options?: ReplayOptions) => replay(environment, scenario(name), oldSide, options)
  /** The differences a tampered run shows against the golden file. */
  const against = async (name: string, tamper: NonNullable<ReplayOptions['tamper']>) => compareRecordings(golden(name), await run(name, { tamper }))
  const paths = async (name: string, tamper: (db: Db) => Promise<unknown>) => (await against(name, (db) => tamper(db).then(() => undefined))).map((difference) => difference.path)

  const CANCEL = 'cancel-monthly-inside-the-minimum-term'
  const DATE = 'payment-date-change-17-days-on'
  const CREDITS = 'credits-session-up-and-down-with-the-history'
  const STORE_CREDIT = 'store-credit-remove'
  const GIFT_CARD = 'gift-card-extend-a-card-that-has-just-expired'
  const CUSTOMER = 'create-customer'
  const ALL = [CANCEL, DATE, CREDITS, STORE_CREDIT, GIFT_CARD, CUSTOMER]

  it('untouched, each of the six matches its golden file exactly', async () => {
    for (const name of ALL) expect(compareRecordings(golden(name), await run(name)), name).toEqual([])
  })

  it('a cancel: the last day a day out', async () => {
    expect(await paths(CANCEL, (db) => db.query("UPDATE customer_memberships SET cancel_effective_date = cancel_effective_date + 1 WHERE cancel_effective_date IS NOT NULL"))).toContain('.tables.customer_memberships.changed[0].cancel_effective_date[1]')
  })

  it('a cancel: the membership marked cancelled at once, where the old code leaves it active to its last day', async () => {
    const found = await paths(CANCEL, (db) => db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE cancel_effective_date IS NOT NULL"))
    expect(found).toContain('.tables.customer_memberships.changed[0].subscription_status')
  })

  it("a cancel: another moment sent to Stripe as the subscription's end, and a second change sent", async () => {
    const moved = await against(CANCEL, async (_db, stripe) => {
      ;(stripe.calls[0]?.params as { cancel_at: number }).cancel_at += 86_400
    })
    expect(moved.map((difference) => difference.path)).toEqual(['.stripeCalls[0].params.cancel_at'])
    const twice = await against(CANCEL, async (_db, stripe) => {
      stripe.calls.push({ ...(stripe.calls[0] as (typeof stripe.calls)[number]) })
    })
    expect(twice.map((difference) => difference.path)).toContain('.stripeCalls[1]')
  })

  it('a payment date change: a penny more charged', async () => {
    const differences = await against(DATE, async (_db, stripe) => {
      const charge = stripe.calls.find((call) => call.method === 'paymentIntents.create')
      if (charge) (charge.params as { amount: number }).amount += 1
    })
    expect(differences).toContainEqual({ path: '.stripeCalls[1].params.amount', expected: 2194, actual: 2195 })
  })

  it('a payment date change: the card charged twice (FB1, on a recording where it is charged once)', async () => {
    const differences = await against(DATE, async (_db, stripe) => {
      const charge = stripe.calls.find((call) => call.method === 'paymentIntents.create')
      if (charge) stripe.calls.push({ ...charge })
    })
    expect(differences.map((difference) => difference.path)).toContain('.stripeCalls[3]')
  })

  it("a payment date change: the order a penny out, the record left pending, the membership's date not moved", async () => {
    expect(await paths(DATE, (db) => db.query('UPDATE orders SET order_total = order_total + 0.01'))).toContain('.tables.orders.added[0].order_total')
    expect(await paths(DATE, (db) => db.query("UPDATE membership_payment_date_changes SET status = 'pending'"))).toContain('.tables.membership_payment_date_changes.added[0].status')
    expect(await paths(DATE, (db) => db.query("UPDATE customer_memberships SET next_renewal_date = '2026-12-10'"))).toContain('.tables.customer_memberships')
  })

  it('a payment date change: an audit row (the Worker will write one; the old code writes none) shows as a whole table appearing', async () => {
    expect(golden(DATE).tables['audit_log']).toBeUndefined()
    const found = await paths(DATE, (db) =>
      db.query("INSERT INTO audit_log (actor_type, action, entity_type, entity_id, details) VALUES ('system', 'membership.payment_date_changed', 'membership', 'x', '{}')")
    )
    expect(found).toContain('.tables.audit_log')
  })

  it('credits: one credit more allocated, and an adjustment with no record', async () => {
    expect(await paths(CREDITS, (db) => db.query('UPDATE membership_credit_periods SET credits_allocated = credits_allocated + 1'))).toContain('.tables.membership_credit_periods.changed[0].credits_allocated[1]')
    const found = await paths(CREDITS, (db) => db.query('DELETE FROM membership_credit_adjustments WHERE amount = -1'))
    expect(found.join()).toContain('.tables.membership_credit_adjustments.added')
  })

  it('store credit: a penny on the balance, the movement given twice, the staff member not recorded', async () => {
    expect(await paths(STORE_CREDIT, (db) => db.query('UPDATE customers SET store_credit_balance = store_credit_balance + 0.01 WHERE store_credit_balance > 0'))).toContain('.tables.customers.changed[0].store_credit_balance[1]')
    const twice = await paths(STORE_CREDIT, (db) =>
      db.query('INSERT INTO store_credit_transactions (customer_id, amount, reason, balance_after, note, staff_id) SELECT customer_id, amount, reason, balance_after + amount, note, staff_id FROM store_credit_transactions')
    )
    expect(twice.join()).toContain('.tables.store_credit_transactions.added[')
    expect(await paths(STORE_CREDIT, (db) => db.query('UPDATE store_credit_transactions SET staff_id = NULL'))).toContain('.tables.store_credit_transactions.added[0].staff_id')
  })

  it('a gift card: the expiry a day out, and the card left voided', async () => {
    expect(await paths(GIFT_CARD, (db) => db.query('UPDATE gift_cards SET expiry_date = expiry_date + 1'))).toContain('.tables.gift_cards.changed[0].expiry_date[1]')
    expect(await paths(GIFT_CARD, (db) => db.query('UPDATE gift_cards SET voided = true'))).toContain('.tables.gift_cards.changed[0].voided')
  })

  it('a customer: the email kept in the case it was typed in', async () => {
    expect(await paths(CUSTOMER, (db) => db.query("UPDATE customers SET email = 'Dee.Dale@Example.COM' WHERE email = 'dee.dale@example.com'"))).toContain('.tables.customers.added[0].email')
  })

  it('different words for staff, and a different shape of answer', async () => {
    const reworded = await compareRecordings(golden('store-credit-overdraw-refused'), {
      ...(await run('store-credit-overdraw-refused')),
      results: [{ ok: false, reason: 'insufficient_store_credit', message: 'Not enough store credit.' }],
    })
    expect(reworded.map((difference) => difference.path)).toEqual(['.results[0].message'])
    const reshaped = await compareRecordings(golden(STORE_CREDIT), { ...(await run(STORE_CREDIT)), results: [{ ok: true, appliedAmount: -10 }] })
    expect(reshaped.map((difference) => difference.path).sort()).toEqual(['.results[0].balance', '.results[0].transactionId'])
  })

  it('an allowance that is needed passes its own path only: every other difference still shows', async () => {
    const key: AllowedDifference = { name: 'a key on the charge (test only)', decision: 'none: this test', path: /^\.stripeCalls\[1\]\.idempotencyKey$/ }
    const tampered = await run(DATE, {
      tamper: async (db, stripe) => {
        const charge = stripe.calls.find((call) => call.method === 'paymentIntents.create')
        if (charge) charge.idempotencyKey = 'change-1:charge'
        await db.query('UPDATE orders SET order_total = order_total + 0.01')
      },
    })
    expect(compareRecordings(golden(DATE), tampered, [key]).map((difference) => difference.path)).toEqual(['.tables.orders.added[0].order_total'])
  })

  it('an allowance can check the value it lets through: the wrong value on its path still fails', async () => {
    const clamped: AllowedDifference = {
      name: 'the last day ends on the month\'s last day (test only)',
      decision: 'none: this test',
      path: /^\.tables\.customer_memberships\.changed\[0\]\.cancel_effective_date\[1\]$/,
      actual: (actual) => actual === '2027-01-08',
    }
    const dayEarlier = await run(CANCEL, { tamper: (db) => db.query('UPDATE customer_memberships SET cancel_effective_date = cancel_effective_date - 1 WHERE cancel_effective_date IS NOT NULL').then(() => undefined) })
    expect(compareRecordings(golden(CANCEL), dayEarlier, [clamped])).toEqual([])
    const twoEarlier = await run(CANCEL, { tamper: (db) => db.query('UPDATE customer_memberships SET cancel_effective_date = cancel_effective_date - 2 WHERE cancel_effective_date IS NOT NULL').then(() => undefined) })
    expect(compareRecordings(golden(CANCEL), twoEarlier, [clamped]).map((difference) => difference.path)).toEqual([
      '.tables.customer_memberships.changed[0].cancel_effective_date[1]',
      "(allowed difference not seen: the last day ends on the month's last day (test only))",
    ])
  })

  it('an allowance nobody needs fails, naming itself and its decision, so a stale one can never stay', async () => {
    const stale: AllowedDifference = { name: 'W40 named this and no longer needs it', decision: 'F-plan 4.12 item 4', path: /^\.tables\.audit_log$/ }
    for (const name of ALL) {
      expect(compareRecordings(golden(name), await run(name), [stale]), name).toEqual([
        { path: '(allowed difference not seen: W40 named this and no longer needs it)', expected: 'F-plan 4.12 item 4', actual: undefined },
      ])
    }
  })
})
