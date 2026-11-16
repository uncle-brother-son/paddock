import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { frozenWords, propertyUnionMembers, sourceHolds, templatesFilledBy } from '@/server/rules/testing/frozen-words'
import { legacyAccountDir } from '@/server/rules/testing/replay/harness'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import * as words from './failure-messages'

// Brief W36 item 1: the gift card words, moved ahead of the slice that uses them (W38). The functions have almost no
// words of their own (most refusals are a reason alone), so each reason list is held to the old function's own, read
// from the frozen copy (legacy-account) with the TypeScript parser, and the words the screens show for those reasons
// are held to the screens' source until W38 changes them.

const { strings, templates } = frozenWords(legacyAccountDir)
const fn = (name: string) => path.join(legacyAccountDir, name)
const dialog = path.join(staffAppDir(), 'frontend/components/ExtendGiftCardDialog.tsx')
const giftCardsPage = path.join(staffAppDir(), 'frontend/pages/GiftCardsPage.tsx')
const orderLines = path.join(staffAppDir(), 'frontend/components/OrderLineItemsTable.tsx')

describe('the gift card reasons and words, moved (brief W36 item 1)', () => {
  it('every reason each old function could answer with is listed, and no other', () => {
    expect([...words.GIFT_CARD_EXTEND_REASONS]).toEqual(propertyUnionMembers(fn('extendGiftCardExpiry.ts'), 'ExtendGiftCardExpiryResult', 'reason'))
    expect([...words.GIFT_CARD_PICKED_UP_REASONS]).toEqual(propertyUnionMembers(fn('setGiftCardPickedUp.ts'), 'SetGiftCardPickedUpResult', 'reason'))
    expect([...words.GIFT_CARD_SHIPPED_REASONS]).toEqual(propertyUnionMembers(fn('setGiftCardShipped.ts'), 'SetGiftCardShippedResult', 'reason'))
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

  it('the check would catch a changed word or a reason added to an old function', () => {
    expect(strings.has(words.GIFT_CARD_EXTEND_WORDS.permissionDenied.replace('re-activate', 'reactivate'))).toBe(false)
    expect(sourceHolds(dialog, 'Enter a whole number of months above 0.')).toBe(false)
    expect(sourceHolds(giftCardsPage, 'This gift card is not a pickup card')).toBe(false)
    expect(() => propertyUnionMembers(fn('extendGiftCardExpiry.ts'), 'ExtendGiftCardExpiryResult', 'outcome')).toThrow("isn't a union of strings")
  })
})
