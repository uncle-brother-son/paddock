import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { frozenWords, sourceHolds, templatesFilledBy, unionMembers } from '@/server/rules/testing/frozen-words'
import { legacyRefundDir } from '@/server/rules/testing/replay/harness'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import * as words from './failure-messages'

// Brief W27 item 5: the order refund's words, moved ahead of the slices that use them (W28, W29). Every reason of
// refundOrder must be listed, and every word moved must be the old function's, word for word, read here from the
// frozen copy of the old code (legacy-refund) with the TypeScript parser, so a word changed on either side fails.
// The dialog's own words are held to the dialog's source until the screen changes at W28.

const { strings, templates } = frozenWords(legacyRefundDir)
const dialog = path.join(staffAppDir(), 'frontend/components/RefundOrderDialog.tsx')
const LINE = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

/** A moved word that is a plain string must be a literal of the old code; one built from values must fill a template of it. */
function isOldWord(text: string): boolean {
  return strings.has(text) || templatesFilledBy(templates, text).length > 0
}

describe("refundOrder's reasons and words, moved (brief W27 item 5)", () => {
  it('every reason the old function could answer with is listed, and no other', () => {
    const old = unionMembers(path.join(legacyRefundDir, 'refundOrder.ts'), 'RefundOrderFailureReason')
    expect(old).toHaveLength(17)
    expect([...words.ORDER_REFUND_REASONS]).toEqual(old)
  })

  it('each fixed word is a string of the old function, word for word', () => {
    const fixed = Object.entries(words.ORDER_REFUND_WORDS).filter(([, value]) => typeof value === 'string') as Array<[string, string]>
    expect(fixed.length).toBe(12)
    for (const [name, text] of fixed) expect(strings.has(text), name).toBe(true)
  })

  it('each word built from values fills a template of the old function, with the values in place', () => {
    const built: Array<[string, string, string]> = [
      ['noStaffRecord', words.ORDER_REFUND_WORDS.noStaffRecord('jo@example.com'), "No staff record matches the logged-in user's email (jo@example.com)."],
      ['alreadyRefunded', words.ORDER_REFUND_WORDS.alreadyRefunded([LINE, 'b']), `Already refunded: ${LINE}, b`],
      ['restockDecisionRequired', words.ORDER_REFUND_WORDS.restockDecisionRequired(LINE), `A restock decision (true or false) is required for product line item ${LINE}.`],
      ['giftCardNotFound', words.ORDER_REFUND_WORDS.giftCardNotFound(LINE), `Gift card for line item ${LINE} not found.`],
      [
        'giftCardRedeemed',
        words.ORDER_REFUND_WORDS.giftCardRedeemed(LINE),
        `Gift card for line item ${LINE} has already been redeemed (or voided) in part or in full — it can no longer be refunded.`,
      ],
      ['passNotFound', words.ORDER_REFUND_WORDS.passNotFound(LINE), `No customer_session_passes row references line item ${LINE}.`],
      [
        'passUsed',
        words.ORDER_REFUND_WORDS.passUsed(LINE, 7, 10),
        `Session pass for line item ${LINE} has already had sessions used from it (7 of 10 remaining) — it can no longer be refunded.`,
      ],
      ['membershipNotFound', words.ORDER_REFUND_WORDS.membershipNotFound(LINE), `No customer_memberships row references line item ${LINE}.`],
      ['cardCheckFailed', words.ORDER_REFUND_WORDS.cardCheckFailed('the database is away'), 'Checking the card payment failed, so nothing was refunded: the database is away'],
    ]
    const functions = Object.entries(words.ORDER_REFUND_WORDS).filter(([, value]) => typeof value === 'function')
    expect(functions.map(([name]) => name).sort()).toEqual(built.map(([name]) => name).sort())
    for (const [name, text, expected] of built) {
      expect(text, name).toBe(expected)
      expect(templatesFilledBy(templates, text).length, name).toBeGreaterThan(0)
    }
  })

  it('the held words are the old ones, word for word (shared/heldCardRefund.ts builds them from two strings)', () => {
    expect(words.heldRefundMessage(24)).toBe(
      "The card refund of £24.00 gave no clear answer, so it may have gone through, and nothing else was done. Check Stripe, but don't refund it there by hand: pressing again first finds out whether it went, and can't pay it twice."
    )
    // Its two halves, as the old module writes them: a template with the amount, then a plain string.
    expect(templatesFilledBy(templates, 'The card refund of £24.00 gave no clear answer, so it may have gone through, and nothing else was done. ').length).toBeGreaterThan(0)
    expect(strings.has("Check Stripe, but don't refund it there by hand: pressing again first finds out whether it went, and can't pay it twice.")).toBe(true)
  })

  it("the store credit notes and the restock reason are the old function's (rows the replay compares)", () => {
    expect(strings.has(words.ORDER_REFUND_NOTES.storeCreditAfterCard)).toBe(true)
    expect(strings.has(words.ORDER_REFUND_NOTES.storeCredit)).toBe(true)
    const restock = words.ORDER_REFUND_NOTES.restock(LINE)
    expect(restock).toBe(`Refund Restock (Order #${LINE})`)
    expect(templatesFilledBy(templates, restock).length).toBeGreaterThan(0)
  })

  it("the dialog's own words are in the dialog's source", () => {
    expect(sourceHolds(dialog, words.ORDER_REFUND_DIALOG_WORDS.restockChoiceMissing)).toBe(true)
    expect(sourceHolds(dialog, words.ORDER_REFUND_DIALOG_WORDS.noResponse)).toBe(true)
    expect(sourceHolds(dialog, words.ORDER_REFUND_DIALOG_WORDS.fallback)).toBe(true)
    expect(words.ORDER_REFUND_DIALOG_WORDS.refusedWithNoWords('order_not_found')).toBe('Refund failed (order_not_found).')
    expect(words.ORDER_REFUND_DIALOG_WORDS.refusedWithNoWords(undefined)).toBe('Refund failed (unknown reason).')
    expect(sourceHolds(dialog, "Refund failed (${result.reason ?? 'unknown reason'}).")).toBe(true)
  })

  it('the check would catch a changed word: one letter off is not an old word, and a loose template is not accepted', () => {
    expect(isOldWord(words.ORDER_REFUND_WORDS.lineNotOnOrder)).toBe(true)
    expect(isOldWord(words.ORDER_REFUND_WORDS.lineNotOnOrder.replace('do not exist', "don't exist"))).toBe(false)
    expect(isOldWord(words.ORDER_REFUND_WORDS.passUsed(LINE, 7, 10).replace('can no longer', 'cannot'))).toBe(false)
    expect(isOldWord('Already refunded')).toBe(false)
  })
})

describe('the words W27 adds', () => {
  it('the switch, worded as steps C and D worded theirs', () => {
    expect(words.REFUND_PATH_OFF_MESSAGE).toBe('This is switched off in the booking system. Tell a manager.')
  })

  it("an open claim's words name the subject, and tell staff not to refund again", () => {
    for (const message of [words.ORDER_REFUND_OPEN_MESSAGE, words.EVENT_BOOKING_REFUND_OPEN_MESSAGE]) {
      expect(message).toContain("Don't refund it again")
      expect(message).toContain('Orders page')
    }
    expect(words.ORDER_REFUND_OPEN_MESSAGE).toContain('this order')
    expect(words.EVENT_BOOKING_REFUND_OPEN_MESSAGE).toContain('this event booking')
  })

  it("W31 (W30a \"Noticed\" 2): with no cash left the words say it can't be handed back in cash, never that it can only go to store credit (on a card order Card is possible too)", () => {
    expect(words.ORDER_REFUND_NEW_WORDS.noCashLeft).toBe("No cash paid on this order is left to hand back, so it can't be handed back in cash.")
    expect(words.ORDER_REFUND_NEW_WORDS.noCashLeft).not.toContain('only go to store credit')
  })

  it('review S2 (W28a) and W30a (W30 review S1): the not-put-back words say the card refund didn\'t go back (never "nothing went back"), name the plan\'s store credit, say "wasn\'t sent in time" for a part never sent, and always end with Refund the rest', () => {
    const declined = 'Failed to refund payment: Your card was declined.'
    const added = words.ORDER_REFUND_NEW_WORDS
    expect(added.putBackBlocked(declined, 24)).toBe(
      "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card, and the order can't be put back as it was: stock it returned has been sold since. The refund stands, and £24.00 shows on the order as still to refund. Use Refund the rest to give it another way."
    )
    expect(added.putBackFailed(declined, 24)).toBe(
      "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card, and the order couldn't be put back as it was. The refund stands, and £24.00 shows on the order as still to refund. Use Refund the rest to give it another way."
    )
    // The split case: £14 refused, the plan's £10 of store credit given, and named.
    expect(added.putBackBlocked(declined, 14, 10)).toBe(
      "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card (£10.00 went to store credit as planned), and the order can't be put back as it was: stock it returned has been sold since. The refund stands, and £14.00 shows on the order as still to refund. Use Refund the rest to give it another way."
    )
    expect(added.putBackFailed(declined, 14, 10)).toContain("so it didn't go back to the card (£10.00 went to store credit as planned), and the order couldn't be put back as it was.")
    // Not sent in time: nothing reached Stripe, so it wasn't refused and there is nothing to check there.
    const notSent = added.notSentDetail
    expect(added.putBackBlocked(notSent, 14, 10)).toBe(
      "The card refund wasn't sent in time, so it didn't go back to the card (£10.00 went to store credit as planned), and the order can't be put back as it was: stock it returned has been sold since. The refund stands, and £14.00 shows on the order as still to refund. Use Refund the rest to give it another way."
    )
    expect(added.putBackFailed(notSent, 24)).toBe(
      "The card refund wasn't sent in time, so it didn't go back to the card, and the order couldn't be put back as it was. The refund stands, and £24.00 shows on the order as still to refund. Use Refund the rest to give it another way."
    )
    for (const detail of [declined, notSent]) {
      for (const text of [added.putBackBlocked(detail, 14, 10), added.putBackFailed(detail, 14, 10), added.putBackBlocked(detail, 24), added.putBackFailed(detail, 24)]) {
        expect(text).not.toContain('nothing went back')
        expect(text).not.toContain('Check Stripe')
      }
    }
    for (const text of [added.putBackBlockedNotRecorded(notSent), added.putBackFailedNotRecorded(notSent)]) {
      expect(text).not.toContain('was refused')
      expect(text.startsWith("The card refund wasn't sent in time, so nothing went back, and the order ")).toBe(true)
    }
    // R2 failed too: nothing was given, store credit included, so "nothing went back" is true there.
    expect(added.putBackBlockedNotRecorded(declined)).toContain("(Failed to refund payment: Your card was declined.), so nothing went back, and the order can't be put back as it was")
  })

  it('W29: the membership words, word for word: Q41\'s line under the line, Q40\'s two refusals, and the cancel left (to staff, and on the stuck list)', () => {
    expect(words.membershipUsedWords(0, 0)).toBeNull()
    expect(words.membershipUsedWords(1, 0)).toBe('1 credit session already taken.')
    expect(words.membershipUsedWords(0, 1)).toBe('1 future credit booking will need payment.')
    expect(words.membershipUsedWords(4, 2)).toBe('4 credit sessions already taken; 2 future credit bookings will need payment.')
    expect(words.MEMBERSHIP_REFUND_WORDS.refundAlone).toBe(
      'This membership was paid by its own card payment, separate from the rest of the order. To refund it to the card, refund the membership line on its own, then the other lines.'
    )
    expect(words.MEMBERSHIP_REFUND_WORDS.paymentNotRecorded).toBe(
      "This membership was paid by its own card payment, which this order doesn't name, so it can't go back to the card from here. Use store credit instead, or tell a manager."
    )
    expect(words.MEMBERSHIP_REFUND_WORDS.cancelLeft('sub_1')).toBe(
      "The refund is done, but the membership's subscription (sub_1) couldn't be confirmed cancelled in Stripe yet, so it could still take its next payment. The automatic check tries again every 5 minutes, and it shows on the Orders page until it is cancelled. Don't refund it again."
    )
    expect(words.MEMBERSHIP_REFUND_WORDS.cancelLeftListed('sub_1')).toBe(
      "A membership was refunded, but its subscription (sub_1) couldn't be confirmed cancelled in Stripe yet, so it could still take its next payment. The automatic check tries again every 5 minutes. If this stays, cancel it in Stripe by hand, then press Mark sorted (needs the Issue refunds permission)."
    )
    // W28's stand-in refusal is gone with its reason.
    expect(words.ORDER_REFUND_NEW_REASONS).not.toContain('membership_not_built')
    expect(words.ORDER_REFUND_NEW_REASONS).toEqual(expect.arrayContaining(['membership_refund_alone', 'membership_payment_not_recorded']))
    expect('membershipNotBuilt' in words.ORDER_REFUND_NEW_WORDS).toBe(false)
  })

  it("the pipeline's refusal detail is the legacy refund route's words", () => {
    expect(words.refundRefusedDetail('Your card was declined.')).toBe('Failed to refund payment: Your card was declined.')
  })
})
