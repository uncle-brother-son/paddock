import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { oldPropertyUnionMembers, oldWords, sourceHolds, templatesFilledBy } from '@/server/rules/testing/old-words'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import * as words from './failure-messages'

// Brief W36 item 1: the gift card words, moved ahead of the slice that uses them (W38). The functions have almost no
// words of their own (most refusals are a reason alone), so each reason list is held to the old function's own, read
// (W64a item 7) from the old code's words pinned in testing/old-words.json (recorded from step F's frozen copy with the
// TypeScript parser), and the words the screens show for those reasons are held to the screens' source. W38 uses them
// (admin.ts) and adds Q46's two sentences.

const { strings, templates } = oldWords('account')
const reasonsOf = (result: string, property = 'reason') => oldPropertyUnionMembers('account', result, property)
const dialog = path.join(staffAppDir(), 'frontend/components/ExtendGiftCardDialog.tsx')
const giftCardsPage = path.join(staffAppDir(), 'frontend/pages/GiftCardsPage.tsx')
const orderLines = path.join(staffAppDir(), 'frontend/components/OrderLineItemsTable.tsx')

describe('the gift card reasons and words, moved (brief W36 item 1)', () => {
  it('every reason each old function could answer with is listed, and no other', () => {
    expect([...words.GIFT_CARD_EXTEND_REASONS]).toEqual(reasonsOf('ExtendGiftCardExpiryResult'))
    expect([...words.GIFT_CARD_PICKED_UP_REASONS]).toEqual(reasonsOf('SetGiftCardPickedUpResult'))
    expect([...words.GIFT_CARD_SHIPPED_REASONS]).toEqual(reasonsOf('SetGiftCardShippedResult'))
    expect(words.GIFT_CARD_EXTEND_REASONS).toHaveLength(3)
  })

  it("the functions' own words are strings of the functions, word for word", () => {
    expect(strings.has(words.GIFT_CARD_EXTEND_WORDS.permissionDenied)).toBe(true)
    expect(strings.has(words.GIFT_CARD_FLAG_WORDS.notReadBack)).toBe(true)
    expect(strings.has(words.INACTIVE_STAFF_MESSAGE)).toBe(true)
    const noStaff = words.noStaffRecordMessage('jo@example.com')
    expect(noStaff).toBe("No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action.")
    expect(templatesFilledBy(templates, noStaff).length).toBeGreaterThan(0)
  })

  it("the Extend dialog's own words are in the dialog's source", () => {
    for (const name of ['monthsInvalid', 'permissionFallback', 'failed'] as const) expect(sourceHolds(dialog, words.GIFT_CARD_EXTEND_WORDS[name]), name).toBe(true)
  })

  it("the picked up and shipped words are in the Gift Cards page's source, and the fallbacks in the order's line items too", () => {
    for (const name of ['notPickup', 'pickupFailed', 'notShipping', 'shippingFailed'] as const) expect(sourceHolds(giftCardsPage, words.GIFT_CARD_FLAG_WORDS[name]), name).toBe(true)
    expect(sourceHolds(orderLines, words.GIFT_CARD_FLAG_WORDS.pickupFailed)).toBe(true)
    expect(sourceHolds(orderLines, words.GIFT_CARD_FLAG_WORDS.shippingFailed)).toBe(true)
  })

  it("W38's own words (Wayne's Q46): each says why the card was voided, that it can't be reactivated, and what was done with its value, without saying where the money is now (W38a, review S1); neither is an old function's sentence", () => {
    expect([...words.GIFT_CARD_EXTEND_NEW_REASONS]).toEqual(['voided_by_refund', 'voided_to_store_credit'])
    expect(words.GIFT_CARD_EXTEND_NEW_WORDS).toEqual({
      voidedByRefund: "This gift card was voided because its order was refunded, so it can't be reactivated or extended. Its value was refunded with the order: check the order for where it went.",
      voidedToStoreCredit: "This gift card was voided because its balance was moved to the customer's store credit, so it can't be reactivated or extended. Its balance was moved to their store credit.",
    })
    for (const sentence of Object.values(words.GIFT_CARD_EXTEND_NEW_WORDS)) {
      expect(strings.has(sentence)).toBe(false)
      expect(sentence).toContain("can't be reactivated")
      // W38a (review S1): a refund's card part may be pending, held or owed, and store credit may have been spent.
      expect(sentence).not.toMatch(/gone back|is on their store credit/)
    }
    // The new reasons are not the old function's: its own three stay as they were.
    for (const reason of words.GIFT_CARD_EXTEND_NEW_REASONS) expect((words.GIFT_CARD_EXTEND_REASONS as readonly string[]).includes(reason)).toBe(false)
  })

  it('the check would catch a changed word or a reason added to an old function', () => {
    expect(strings.has(words.GIFT_CARD_EXTEND_WORDS.permissionDenied.replace('re-activate', 'reactivate'))).toBe(false)
    expect(sourceHolds(dialog, 'Enter a whole number of months above 0.')).toBe(false)
    // W38a (review S2): the old sentence, with no ceiling, is gone from the dialog; the words name the ceiling.
    expect(sourceHolds(dialog, 'Enter a whole number of months greater than 0.')).toBe(false)
    expect(words.GIFT_CARD_EXTEND_WORDS.monthsInvalid).toBe(`Enter a whole number of months from 1 to ${words.GIFT_CARD_EXTEND_MAX_MONTHS}.`)
    expect(words.GIFT_CARD_EXTEND_MAX_MONTHS).toBe(120)
    expect(sourceHolds(giftCardsPage, 'This gift card is not a pickup card')).toBe(false)
    expect(() => reasonsOf('ExtendGiftCardExpiryResult', 'outcome')).toThrow("isn't a union of strings")
  })
})
