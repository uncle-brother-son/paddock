import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOKING_PATH_OFF_MESSAGE, CHANGE_PAYMENT_UNCONFIRMED_MESSAGE } from '@/server/rules/bookings/failure-messages'
import { PAYMENT_UNCONFIRMED_MESSAGE } from '@/server/rules/orders/failure-messages'
import { REFUND_PATH_OFF_MESSAGE } from '@/server/rules/refunds/failure-messages'
import { OLD_WORDS, oldPropertyUnionMembers, oldWords, sourceHolds, templatesFilledBy } from '@/server/rules/testing/old-words'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import * as words from './failure-messages'

// Brief W36 item 1: the membership words, moved ahead of the slices that use them (W37, W40, W41). Every word moved
// must be the old code's, word for word, read (W64a item 7) from the old code's words pinned in testing/old-words.json
// (recorded from step F's frozen copy, the staff app's functions and the three legacy routes, with the TypeScript
// parser), so a word changed on either side fails. The dialogs' own words are held to the dialogs' source until each
// screen changes with its slice.

const functions = oldWords('account')
const routes = oldWords('accountRoutes')
const component = (name: string) => path.join(staffAppDir(), 'frontend/components', name)
const page = (name: string) => path.join(staffAppDir(), 'frontend/pages', name)
const reasonsOf = (result: string) => oldPropertyUnionMembers('account', result, 'reason')

const stringsOf = (group: Record<string, unknown>): Array<[string, string]> => Object.entries(group).filter(([, value]) => typeof value === 'string') as Array<[string, string]>
const functionsOf = (group: Record<string, unknown>): string[] => Object.entries(group).filter(([, value]) => typeof value === 'function').map(([name]) => name)
/** A moved word that is a plain string must be a literal of the old code; one built from values must fill a template of it. */
const isOldWord = (text: string, from = functions): boolean => from.strings.has(text) || templatesFilledBy(from.templates, text).length > 0

describe("the membership cancel's reasons and words, moved (brief W36 item 1)", () => {
  it('every reason the old function could answer with is listed, and no other', () => {
    const old = reasonsOf('SetMembershipCancellationResult')
    expect(old).toHaveLength(5)
    expect([...words.MEMBERSHIP_CANCEL_REASONS]).toEqual(old)
  })

  it("the function's words are strings of the function, and the routes' words strings of the two legacy routes", () => {
    expect(functions.strings.has(words.MEMBERSHIP_CANCEL_WORDS.membershipIdRequired)).toBe(true)
    expect(functions.strings.has(words.MEMBERSHIP_CANCEL_WORDS.permissionDenied)).toBe(true)
    for (const name of ['notFound', 'recordFailed', 'stripeFailed'] as const) expect(routes.strings.has(words.MEMBERSHIP_CANCEL_WORDS[name]), name).toBe(true)
    expect(Object.keys(words.MEMBERSHIP_CANCEL_WORDS)).toHaveLength(5)
  })

  it("the dialog's own words for the four reasons, and its fallback, are in the dialog's source", () => {
    const dialog = component('CancelMembershipDialog.tsx')
    expect(Object.keys(words.MEMBERSHIP_CANCEL_DIALOG_WORDS).sort()).toEqual(words.MEMBERSHIP_CANCEL_REASONS.filter((reason) => reason !== 'permission_denied').sort())
    for (const [reason, text] of Object.entries(words.MEMBERSHIP_CANCEL_DIALOG_WORDS)) expect(sourceHolds(dialog, text), reason).toBe(true)
    expect(sourceHolds(dialog, words.MEMBERSHIP_CANCEL_FALLBACK)).toBe(true)
  })
})

describe("the payment date change's words, moved (brief W36 item 1)", () => {
  it("each of the quote's refusals is a string of shared/membershipPaymentDate, in the old order", () => {
    const fixed = stringsOf(words.PAYMENT_DATE_REFUSALS)
    expect(fixed.map(([name]) => name)).toEqual(['yearly', 'paymentFailing', 'notActive', 'cancelScheduled', 'renewalOverdue', 'paymentNeeded', 'noSubscription', 'noSavedCard', 'inProgress', 'noMonthlyPrice'])
    for (const [name, text] of fixed) expect(functions.strings.has(text), name).toBe(true)
    // The old order, as the function tests them (the plan's price comes last, in loadPaymentDateQuote).
    const source = frozenOrder(fixed.map(([, text]) => text))
    expect(source).toEqual([...source].sort((a, b) => a - b))
  })

  it('"It can be changed again from…" is built as the old function builds it, with and without the day it was changed', () => {
    expect(words.PAYMENT_DATE_REFUSALS.changedRecently('10 Nov 2026', '27 Dec 2026')).toBe('Changed on 10 Nov 2026. It can be changed again from 27 Dec 2026.')
    expect(words.PAYMENT_DATE_REFUSALS.changedRecently(null, '27 Dec 2026')).toBe('It can be changed again from 27 Dec 2026.')
    // Its two parts, as the old module writes them: two templates.
    expect(templatesFilledBy(functions.templates, 'Changed on 10 Nov 2026. ').length).toBeGreaterThan(0)
    expect(templatesFilledBy(functions.templates, 'Changed on 10 Nov 2026. It can be changed again from 27 Dec 2026.').length).toBeGreaterThan(0)
    expect(functionsOf(words.PAYMENT_DATE_REFUSALS)).toEqual(['changedRecently'])
  })

  it("the press's fixed words are strings of the function, and the legacy route's of the route", () => {
    for (const name of ['paramsRequired', 'permissionDenied', 'notFound', 'noRenewalDate', 'cannotWorkOut', 'nothingToCharge', 'overrideNeeded', 'inProgress'] as const) {
      expect(functions.strings.has(words.PAYMENT_DATE_WORDS[name]), name).toBe(true)
    }
    for (const name of ['customerMismatch', 'stripeCancelScheduled', 'stripeNotMonthly', 'amountTooHigh', 'authenticationRequired'] as const) {
      expect(routes.strings.has(words.PAYMENT_DATE_WORDS[name]), name).toBe(true)
    }
    expect(stringsOf(words.PAYMENT_DATE_WORDS)).toHaveLength(13)
    // The press's "in progress" has a full stop; the quote's refusal has none. Both are the old code's.
    expect(words.PAYMENT_DATE_WORDS.inProgress).toBe(`${words.PAYMENT_DATE_REFUSALS.inProgress}.`)
  })

  it('each word built from values fills a template of the old code, with the values in place', () => {
    const built: Array<[string, string, string, typeof functions]> = [
      ['chooseDate', words.PAYMENT_DATE_WORDS.chooseDate('11 Dec 2026', '9 Jan 2027'), 'Choose a date from 11 Dec 2026 to 9 Jan 2027', functions],
      [
        'declined',
        words.PAYMENT_DATE_WORDS.declined('Your card was declined'),
        'The card was declined: Your card was declined. Nothing was charged and the payment date has not changed.',
        functions,
      ],
      ['stripeNotActive', words.PAYMENT_DATE_WORDS.stripeNotActive('past_due'), 'The Stripe subscription is past_due, not active', routes],
      [
        'staleRenewalDate',
        words.PAYMENT_DATE_WORDS.staleRenewalDate('2026-12-10', '2026-12-12'),
        "Stripe's next payment is on 2026-12-10, but the membership shows 2026-12-12. Refresh and try again.",
        routes,
      ],
      ['paymentNotCompleted', words.PAYMENT_DATE_WORDS.paymentNotCompleted('processing'), 'The card payment did not complete (status: processing)', routes],
      ['refundedInFull', words.PAYMENT_DATE_WORDS.refundedInFull('No such subscription'), 'No such subscription. The part-month charge was refunded in full.', routes],
      ['chargeDescription', words.PAYMENT_DATE_WORDS.chargeDescription(17), 'Payment date change: 17 extra days', routes],
      // W41 keeps the two warnings on a change that went through: the legacy route's, and the old function's.
      [
        'stripeReports',
        words.PAYMENT_DATE_WORDS.stripeReports(1798329600, 1798329600, 1798326000),
        'Stripe accepted the change but reports trial_end 1798329600 and billing_cycle_anchor 1798329600, expected 1798326000: check the subscription in Stripe.',
        routes,
      ],
      [
        'nextPaymentNowOn',
        words.PAYMENT_DATE_WORDS.nextPaymentNowOn('28 Dec 2026', '27 Dec 2026'),
        "Stripe's next payment is now on 28 Dec 2026, not 27 Dec 2026: check the subscription in Stripe.",
        functions,
      ],
    ]
    expect(functionsOf(words.PAYMENT_DATE_WORDS).sort()).toEqual(built.map(([name]) => name).sort())
    for (const [name, text, expected, from] of built) {
      expect(text, name).toBe(expected)
      expect(templatesFilledBy(from.templates, text).length, name).toBeGreaterThan(0)
    }
  })

  it("the dialog's own words are in the dialog's source", () => {
    const dialog = component('ChangePaymentDateDialog.tsx')
    for (const [name, text] of Object.entries(words.PAYMENT_DATE_DIALOG_WORDS)) expect(sourceHolds(dialog, text), name).toBe(true)
  })

  it("what describes a state the Worker can't leave is not moved (FB1 to FB3, and the plumbing between Retool and the Worker)", () => {
    const moved = JSON.stringify([words.PAYMENT_DATE_WORDS, words.PAYMENT_DATE_REFUSALS, words.MEMBERSHIP_CANCEL_WORDS, words.PAYMENT_DATE_DIALOG_WORDS].map((group) => stringsOf(group)))
    for (const phrase of ['check Stripe for a', 'refund it in Stripe', 'Fix by hand', 'could not be marked failed', 'HTML page', 'did not report success']) {
      expect(moved).not.toContain(phrase)
      // Each is in the old code, so leaving it out is a choice, not an oversight of this list.
      expect([...functions.strings, ...functions.templates, ...routes.strings, ...routes.templates].some((text) => text.includes(phrase)), phrase).toBe(true)
    }
  })
})

describe("the credit and Herd words, moved (brief W36 item 1)", () => {
  it("each fixed word is a string of adjustMembershipCredits, word for word, and the one built from numbers fills its template", () => {
    const fixed = stringsOf(words.MEMBERSHIP_CREDIT_WORDS)
    expect(fixed).toHaveLength(5)
    for (const [name, text] of fixed) expect(functions.strings.has(text), name).toBe(true)
    expect(functionsOf(words.MEMBERSHIP_CREDIT_WORDS)).toEqual(['belowUsed'])
    const below = words.MEMBERSHIP_CREDIT_WORDS.belowUsed(0, 1)
    expect(below).toBe('Adjustment rejected: the period would be left with 0 allocated credit(s), below the 1 already used.')
    expect(templatesFilledBy(functions.templates, below).length).toBeGreaterThan(0)
  })

  it("the dialog's own words are in the dialog's source", () => {
    const dialog = component('MembershipCreditDialog.tsx')
    for (const [name, text] of Object.entries(words.MEMBERSHIP_CREDIT_DIALOG_WORDS)) expect(sourceHolds(dialog, text), name).toBe(true)
  })

  it("Herd has one reason and no words of its own; the Customers page's fallback is in the page's source", () => {
    expect([...words.HERD_REASONS]).toEqual(reasonsOf('SetMembershipHerdResult'))
    expect(sourceHolds(page('CustomersPage.tsx'), words.HERD_FALLBACK)).toBe(true)
  })

  it("the staff words are the old shared/staffAccess's, as the Worker's staff check already says them", () => {
    expect(functions.strings.has(words.INACTIVE_STAFF_MESSAGE)).toBe(true)
    expect(functions.strings.has(words.ISSUE_REFUNDS_NEEDED_MESSAGE)).toBe(true)
  })
})

describe('the words W37 adds for a credit adjustment (brief W37 item 2; FB10)', () => {
  it("a missing reason is refused in the dialog's own sentence, which staff already see", () => {
    expect(words.MEMBERSHIP_CREDIT_NEW_WORDS.reasonRequired).toBe('A reason is required for the audit trail')
    expect(words.MEMBERSHIP_CREDIT_NEW_WORDS.reasonRequired).toBe(words.MEMBERSHIP_CREDIT_DIALOG_WORDS.reasonRequired)
    expect(sourceHolds(component('MembershipCreditDialog.tsx'), words.MEMBERSHIP_CREDIT_NEW_WORDS.reasonRequired)).toBe(true)
  })

  it('below zero is worded as "below what is used" is, with the figure it would be left at; a credit type that is neither kind names the two', () => {
    expect(words.MEMBERSHIP_CREDIT_NEW_WORDS.addonBelowZero(-3)).toBe('Adjustment rejected: the membership would be left with minus 3 add-on credit(s), below zero.')
    expect(words.MEMBERSHIP_CREDIT_NEW_WORDS.addonBelowZero(-1).startsWith('Adjustment rejected: the ')).toBe(true)
    expect(words.MEMBERSHIP_CREDIT_WORDS.belowUsed(0, 1).startsWith('Adjustment rejected: the ')).toBe(true)
    expect(words.MEMBERSHIP_CREDIT_NEW_WORDS.creditTypeInvalid).toBe('Credit type must be "session" or "addon".')
    expect(Object.keys(words.MEMBERSHIP_CREDIT_NEW_WORDS)).toEqual(['reasonRequired', 'addonBelowZero', 'creditTypeInvalid'])
    // None of the three is an old word of the function: the old function refused none of them.
    expect(isOldWord(words.MEMBERSHIP_CREDIT_NEW_WORDS.addonBelowZero(-3))).toBe(false)
    expect(isOldWord(words.MEMBERSHIP_CREDIT_NEW_WORDS.creditTypeInvalid)).toBe(false)
  })

  it("Herd's `not_found` carries the membership's own old sentence in its details", () => {
    expect(words.HERD_NOT_FOUND_MESSAGE).toBe('Membership not found.')
    expect(isOldWord(words.HERD_NOT_FOUND_MESSAGE)).toBe(true)
  })
})

describe('the words W36 adds', () => {
  it('the switch, worded as steps C, D and E worded theirs', () => {
    expect(words.MEMBERSHIP_PATH_OFF_MESSAGE).toBe('This is switched off in the booking system. Tell a manager.')
    expect(words.MEMBERSHIP_PATH_OFF_MESSAGE).toBe(BOOKING_PATH_OFF_MESSAGE)
    expect(words.MEMBERSHIP_PATH_OFF_MESSAGE).toBe(REFUND_PATH_OFF_MESSAGE)
  })

  it("lead call L15, as the W36 review's L5 changed it (lead, 17 Nov): a held payment date change says step D's saved-card sentence, not step C's (it has no order until it is finished)", () => {
    expect(words.PAYMENT_DATE_HELD_MESSAGE).toBe(CHANGE_PAYMENT_UNCONFIRMED_MESSAGE)
    expect(words.PAYMENT_DATE_HELD_MESSAGE).not.toBe(PAYMENT_UNCONFIRMED_MESSAGE)
    expect(words.PAYMENT_DATE_HELD_MESSAGE).toBe(
      "The card payment didn't get a clear answer, so it may or may not have been taken. The change is on hold: don't take payment again. Check the Orders page in a few minutes."
    )
  })

  it("a left step's lines: still being sent says the check is trying and what to do if it stays (W36 review S2); refused says what to do in Stripe and to press Mark sorted; a subscription Stripe can't find says so (L2)", () => {
    const { cancel_at: cancel, payment_method: card } = words.LEFT_STEP_WORDS
    // S2: "nothing to do yet" could stay for ever (a 403 on every run, an outage of a day). The step is read before it
    // is sent, so setting it in Stripe by hand closes it on the next check.
    const ifItStays = ' The automatic check tries again every 5 minutes. If this is still here after an hour, set it in Stripe by hand (or tell a manager): the next check then sees it and takes it off the list.'
    expect(cancel.left('sub_1')).toBe(
      `A membership's cancellation was recorded, but its subscription (sub_1) couldn't be confirmed changed in Stripe yet, so it could still renew past its last day.${ifItStays}`
    )
    expect(cancel.refused('sub_1')).toBe(
      "A membership's cancellation was recorded, but Stripe refused to change its subscription (sub_1), so the automatic check has stopped trying and it could still renew past its last day. Set or clear its cancel date in Stripe by hand to match the membership (or tell a manager), then press Mark sorted (needs the Issue refunds permission)."
    )
    expect(cancel.missing('sub_1')).toBe(
      "A membership's cancellation was recorded, but Stripe can't find its subscription (sub_1) with the club's payment account details, so the automatic check has stopped trying. Tell a manager: the subscription may have been deleted in Stripe, or belong to the other mode. Once the membership and Stripe agree, press Mark sorted (needs the Issue refunds permission)."
    )
    expect(card.left('sub_1')).toBe(
      `A customer's card was replaced, but a membership's subscription (sub_1) couldn't be confirmed moved to the new card in Stripe yet, so its next payment could still go to the old card.${ifItStays}`
    )
    expect(card.refused('sub_1')).toBe(
      "A customer's card was replaced, but Stripe refused to move a membership's subscription (sub_1) to the new card, so the automatic check has stopped trying and its next payment could still go to the old card. Set the subscription's payment method in Stripe by hand (or tell a manager), then press Mark sorted (needs the Issue refunds permission)."
    )
    expect(card.missing('sub_1')).toBe(
      "A customer's card was replaced, but Stripe can't find a membership's subscription (sub_1) with the club's payment account details, so the automatic check has stopped trying. Tell a manager: the subscription may have been deleted in Stripe, or belong to the other mode. Once the membership and Stripe agree, press Mark sorted (needs the Issue refunds permission)."
    )
    for (const line of [cancel.left('s'), card.left('s')]) {
      expect(line).not.toContain('Mark sorted')
      expect(line).not.toContain('nothing to do')
    }
    for (const line of [cancel.refused('s'), card.refused('s'), cancel.missing('s'), card.missing('s')]) expect(line).not.toContain('tries again')
    for (const line of [cancel.missing('s'), card.missing('s')]) expect(line).not.toContain('refused')
    expect(words.LEFT_STEP_WORDS.sorted).toBe('Marked as sorted. It is no longer listed.')
    expect(words.LEFT_STEP_WORDS.notListed).toBe('This is no longer on the list (it was sorted in the meantime). Nothing was changed.')
    expect(words.LEFT_STEP_WORDS.stillTrying).toBe("Stripe hasn't refused this: the automatic check is still sending it. Nothing was changed. Wait for the next check (every 5 minutes) and look again.")
  })

  it('the check would catch a changed word: one letter off is not an old word, and a loose template is not accepted', () => {
    expect(isOldWord(words.PAYMENT_DATE_REFUSALS.notActive)).toBe(true)
    expect(isOldWord(words.PAYMENT_DATE_REFUSALS.notActive.replace("isn't", 'is not'))).toBe(false)
    expect(isOldWord(words.MEMBERSHIP_CREDIT_WORDS.belowUsed(0, 1).replace('already used', 'used already'))).toBe(false)
    expect(isOldWord(words.MEMBERSHIP_CANCEL_WORDS.notFound, routes)).toBe(true)
    expect(isOldWord(`${words.MEMBERSHIP_CANCEL_WORDS.notFound}.`, routes)).toBe(false)
    expect(isOldWord('Choose a date')).toBe(false)
    expect(sourceHolds(component('CancelMembershipDialog.tsx'), 'This membership is not active.')).toBe(false)
  })
})

/**
 * Where each of `texts` first appears among the old shared/membershipPaymentDate.ts's string literals (pinned in source
 * order, W64a item 7): for "in the old order" checks.
 */
function frozenOrder(texts: string[]): number[] {
  const inOrder = OLD_WORDS.facts.paymentDateStrings
  return texts.map((text) => {
    const at = inOrder.indexOf(text)
    if (at < 0) throw new Error(`shared/membershipPaymentDate.ts doesn't hold: ${text}`)
    return at
  })
}
