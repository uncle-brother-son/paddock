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

  it("the pipeline's refusal detail is the legacy refund route's words", () => {
    expect(words.refundRefusedDetail('Your card was declined.')).toBe('Failed to refund payment: Your card was declined.')
  })
})
