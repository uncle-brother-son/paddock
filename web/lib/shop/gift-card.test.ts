import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { RichText } from '@/lib/sanity/schemas'

import { addToBag } from './bag'
import {
  amountOf,
  charactersLeft,
  filledTerms,
  firstChoice,
  FORMAT_LINES,
  GIFT_MESSAGE_MOST,
  giftCardAddress,
  giftCardFormat,
  missingLabel,
  priceShown,
  recipientWrong,
  validityWords,
  type GiftCardAmount,
} from './gift-card'

// Brief W76: the Gift Card page's rules that are not a matter of looks. How it is sent is the address's; the price
// line is the chosen amount; Other is W76a's one rule, asked as the customer types; a gift needs a name and an email
// address. No amount is worked out here: a preset is W76a's own text, and an Other amount is what its rule answers.

const AMOUNTS: GiftCardAmount[] = [
  { amount: '15.00', label: '£15' },
  { amount: '30.00', label: '£30' },
  { amount: '150.00', label: '£150' },
]
const LIMITS = { lowest: '1.00', highest: '1000.00' }

describe('how the gift card is sent (item 1)', () => {
  it.each([
    ['physical', 'physical'],
    ['digital', 'digital'],
    [undefined, 'digital'],
    [null, 'digital'],
    ['', 'digital'],
    ['Physical', 'digital'],
    ['post', 'digital'],
    [['physical', 'digital'], 'digital'],
  ] as const)('?format=%s is %s: an unknown value is Digital, never an error', (asked, format) => {
    expect(giftCardFormat(asked as string | string[] | null | undefined)).toBe(format)
  })
  it("each has an address to share: Digital is the page's own, Physical carries ?format=physical", () => {
    expect([giftCardAddress('digital'), giftCardAddress('physical')]).toEqual(['/shop/gift-card', '/shop/gift-card?format=physical'])
    expect(giftCardFormat(new URL(giftCardAddress('physical'), 'https://x.test').searchParams.get('format'))).toBe('physical')
  })
  it('the line under the button, as drawn for each', () => {
    expect(FORMAT_LINES).toEqual({ digital: 'Your gift card will be sent by email', physical: 'Delivery or collection from the Paddock.' })
  })
})

describe('the amount (item 2)', () => {
  it('the page opens on the lowest preset, chosen, as drawn; with no presets on Other; with neither on nothing', () => {
    expect(firstChoice({ amounts: AMOUNTS, other: LIMITS })).toEqual({ kind: 'preset', amount: '15.00' })
    expect(firstChoice({ amounts: [], other: LIMITS })).toEqual({ kind: 'other', typed: '' })
    expect(firstChoice({ amounts: [], other: null })).toBeNull()
  })
  it("a preset is its own amount, W76a's text untouched", () => {
    expect(amountOf({ kind: 'preset', amount: '30.00' }, LIMITS)).toEqual({ amount: '30.00', wrong: null, empty: false })
  })
  it('Other with nothing typed has no amount and nothing wrong yet', () => {
    expect(amountOf({ kind: 'other', typed: '' }, LIMITS)).toEqual({ amount: null, wrong: null, empty: true })
    expect(amountOf({ kind: 'other', typed: '  ' }, LIMITS)).toEqual({ amount: null, wrong: null, empty: true })
  })
  it.each([
    ['200', '200.00'],
    ['1', '1.00'],
    ['1000', '1000.00'],
    ['1,000', '1000.00'],
    ['25.00', '25.00'],
  ])("Other, %s typed: W76a's rule answers %s", (typed, amount) => {
    expect(amountOf({ kind: 'other', typed }, LIMITS)).toEqual({ amount, wrong: null, empty: false })
  })
  it.each([
    ['0', 'Enter an amount between £1 and £1,000'],
    ['1001', 'Enter an amount between £1 and £1,000'],
    ['25.50', 'Enter an amount in whole pounds'],
    ['abc', 'Enter an amount in whole pounds'],
    ['-5', 'Enter an amount in whole pounds'],
  ])("Other, %s typed: no amount, and W76a's words for why (WQ63)", (typed, words) => {
    expect(amountOf({ kind: 'other', typed }, LIMITS)).toEqual({ amount: null, wrong: words, empty: false })
  })
  it("the words name the type's own limits", () => {
    expect(amountOf({ kind: 'other', typed: '5' }, { lowest: '10.00', highest: '250.00' }).wrong).toBe('Enter an amount between £10 and £250')
  })
  it('the price line is the chosen amount, and until there is one the lowest on sale', () => {
    expect(priceShown(amountOf({ kind: 'preset', amount: '150.00' }, LIMITS), AMOUNTS)).toBe('£150')
    expect(priceShown(amountOf({ kind: 'other', typed: '200' }, LIMITS), AMOUNTS)).toBe('£200')
    expect(priceShown(amountOf({ kind: 'other', typed: '' }, LIMITS), AMOUNTS)).toBe('£15')
    expect(priceShown(amountOf({ kind: 'other', typed: '25.50' }, LIMITS), AMOUNTS)).toBe('£15')
    expect(priceShown(amountOf({ kind: 'other', typed: '' }, LIMITS), [])).toBeNull()
  })
})

describe('sending to someone else (item 3)', () => {
  it('needs a name and an email address that reads as one; the message is not needed', () => {
    expect(recipientWrong({ name: '', email: '', message: '' })).toEqual({ name: 'Enter the recipient’s name', email: 'Enter the recipient’s email' })
    expect(recipientWrong({ name: '  ', email: 'sam', message: 'Happy birthday' })).toEqual({ name: 'Enter the recipient’s name', email: 'Enter a valid email address' })
    expect(recipientWrong({ name: 'Sam', email: 'sam@example', message: '' })).toEqual({ name: null, email: 'Enter a valid email address' })
    expect(recipientWrong({ name: 'Sam', email: ' sam@example.com ', message: '' })).toEqual({ name: null, email: null })
  })
  it('the message holds 150 characters, and its counter says how many are left', () => {
    expect(GIFT_MESSAGE_MOST).toBe(150)
    expect(charactersLeft('')).toBe('150 characters left')
    expect(charactersLeft('Happy birthday')).toBe('136 characters left')
    expect(charactersLeft('x'.repeat(149))).toBe('1 character left')
    expect(charactersLeft('x'.repeat(150))).toBe('0 characters left')
    expect(charactersLeft('x'.repeat(170))).toBe('0 characters left')
  })
})

describe('Add to bag (item 4)', () => {
  const chosen = amountOf({ kind: 'preset', amount: '15.00' }, LIMITS)
  it('what a mouse over the button says while something is missing (WQ51): the amount first, then the recipient', () => {
    expect(missingLabel({ amount: amountOf({ kind: 'other', typed: '' }, LIMITS), recipient: null })).toBe('Enter amount')
    expect(missingLabel({ amount: amountOf({ kind: 'other', typed: '25.50' }, LIMITS), recipient: { name: '', email: '', message: '' } })).toBe('Enter amount')
    expect(missingLabel({ amount: chosen, recipient: { name: 'Sam', email: '', message: '' } })).toBe('Add recipient')
    expect(missingLabel({ amount: chosen, recipient: { name: 'Sam', email: 'sam@example.com', message: '' } })).toBeNull()
    expect(missingLabel({ amount: chosen, recipient: null })).toBeNull()
  })
  it('the bag takes a gift card line, and has nowhere to put it yet', () => {
    expect(addToBag({ giftCard: 'gift', format: 'physical', amount: '15.00', recipient: null })).toBe(false)
    expect(addToBag({ giftCard: 'gift', format: 'digital', amount: '200.00', recipient: { name: 'Sam', email: 'sam@example.com', message: '' } })).toBe(false)
  })
})

describe('Gift Card Terms & Conditions (item 5)', () => {
  const block = (key: string, text: string): RichText[number] => ({ _type: 'block', _key: key, style: 'normal', listItem: null, level: null, children: [{ _type: 'span', _key: `${key}-1`, text, marks: [] }], markDefs: [] })
  it("{validity} is filled from the staff app's months, wherever it stands", () => {
    expect(validityWords(6)).toBe('6 months')
    expect(validityWords(1)).toBe('1 month')
    expect(validityWords(12)).toBe('12 months')
    const filled = filledTerms([block('a', 'Valid for {validity} from the day it is bought.'), block('b', 'After {validity} it can be extended; {validity} is the least.'), block('c', 'No placeholder here.')], 6)
    expect(filled.map((one) => one.children[0]?.text)).toEqual(['Valid for 6 months from the day it is bought.', 'After 6 months it can be extended; 6 months is the least.', 'No placeholder here.'])
  })
})

describe('the page', () => {
  const web = path.resolve(__dirname, '../..')
  const source = (file: string) => readFileSync(path.join(web, file), 'utf8')

  it("asks the Other rule through lib/shop/gift-card-amount.ts only: no component imports the server's rule itself", () => {
    expect(source('lib/shop/gift-card.ts')).toContain("from './gift-card-amount'")
    for (const file of ['components/shop/GiftCardBuy.tsx', 'components/shop/OptionsAmount.tsx', 'components/shop/GiftCardDetail.tsx', 'components/shop/RecipientInfo.tsx', 'app/shop/gift-card/page.tsx']) {
      expect(source(file), file).not.toMatch(/@\/server|checkOtherAmount/)
    }
  })
  it('is a 404 with nothing on sale, and its canonical address is its own whichever format is shown', () => {
    const page = source('app/shop/gift-card/page.tsx')
    expect(page).toContain('if (!page) notFound()')
    expect(page).toContain('path: GIFT_CARD_ADDRESS')
    expect(page).toContain('format={giftCardFormat(params.format)}')
  })
  it('switching Digital and Physical changes the address where the page stands: no navigation, so no page transition', () => {
    const detail = source('components/shop/GiftCardDetail.tsx')
    expect(detail).toContain("window.history.replaceState(null, '', address)")
    expect(detail).not.toMatch(/useRouter|SiteLink|next\/link/)
  })
})
