import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { frozenWords, propertyUnionMembers, sourceHolds, templatesFilledBy } from '@/server/rules/testing/frozen-words'
import { legacyAccountDir } from '@/server/rules/testing/replay/harness'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import * as words from './failure-messages'

// Brief W36 item 1: the customer words (store credit, creating a customer, the saved card's screen), moved ahead of
// the slices that use them (W37, W39, W42). Every word moved must be the old function's, word for word, read here
// from the frozen copy of the old code (legacy-account) with the TypeScript parser, so a word changed on either side
// fails. The dialogs' own words are held to the dialogs' source until each screen changes with its slice.

const { strings, templates } = frozenWords(legacyAccountDir)
const component = (name: string) => path.join(staffAppDir(), 'frontend/components', name)
const fn = (name: string) => path.join(legacyAccountDir, name)
const isOldWord = (text: string): boolean => strings.has(text) || templatesFilledBy(templates, text).length > 0

describe("adjustCustomerStoreCredit's reasons and words, moved (brief W36 item 1)", () => {
  it('every reason the old function could answer with is listed, and no other', () => {
    const old = propertyUnionMembers(fn('adjustCustomerStoreCredit.ts'), 'AdjustCustomerStoreCreditResult', 'reason')
    expect(old).toHaveLength(3)
    expect([...words.STORE_CREDIT_REASONS]).toEqual(old)
  })

  it('each word is a string of the old function, word for word', () => {
    const fixed = Object.entries(words.STORE_CREDIT_WORDS)
    expect(fixed).toHaveLength(7)
    for (const [name, text] of fixed) expect(strings.has(text), name).toBe(true)
  })

  it("the shortest reason allowed is the old function's and the dialog's (5 characters)", () => {
    expect(words.STORE_CREDIT_MIN_REASON_LENGTH).toBe(5)
    expect(words.STORE_CREDIT_WORDS.reasonRequired).toContain(`at least ${words.STORE_CREDIT_MIN_REASON_LENGTH} characters`)
    for (const file of [fn('adjustCustomerStoreCredit.ts'), component('AdjustStoreCreditDialog.tsx')]) expect(readFileSync(file, 'utf8'), file).toContain('const MIN_REASON_LENGTH = 5')
  })

  it("the dialog's own words are in the dialog's source, and its fallback is the function's own sentence", () => {
    const dialog = component('AdjustStoreCreditDialog.tsx')
    for (const [name, text] of Object.entries(words.STORE_CREDIT_DIALOG_WORDS)) expect(sourceHolds(dialog, text), name).toBe(true)
    expect(sourceHolds(dialog, words.STORE_CREDIT_WORDS.refused)).toBe(true)
  })
})

describe("createCustomer's words, moved (brief W36 item 1)", () => {
  it('each word is a string of the old function, word for word', () => {
    const fixed = Object.entries(words.CREATE_CUSTOMER_WORDS)
    expect(fixed).toHaveLength(7)
    for (const [name, text] of fixed) expect(strings.has(text), name).toBe(true)
  })

  it("the dialog's own words are in the dialog's source (each with the full stop the function's lack)", () => {
    const dialog = component('NewCustomerDialog.tsx')
    for (const [name, text] of Object.entries(words.CREATE_CUSTOMER_DIALOG_WORDS)) expect(sourceHolds(dialog, text), name).toBe(true)
    expect(words.CREATE_CUSTOMER_DIALOG_WORDS.firstNameRequired).toBe(`${words.CREATE_CUSTOMER_WORDS.firstNameRequired}.`)
    // The one sentence both say the same way.
    expect(words.CREATE_CUSTOMER_DIALOG_WORDS.under18).toBe(words.CREATE_CUSTOMER_WORDS.under18)
  })
})

describe('the staff words and the saved card screen', () => {
  it("the staff words are the old shared/staffAccess's, as the Worker's staff check already says them", () => {
    expect(strings.has(words.INACTIVE_STAFF_MESSAGE)).toBe(true)
    expect(strings.has(words.ISSUE_REFUNDS_NEEDED_MESSAGE)).toBe(true)
  })

  it("the saved card's screen words are in the button's and the reader helper's source", () => {
    expect(sourceHolds(component('SaveCardOnReaderButton.tsx'), words.SAVED_CARD_DIALOG_WORDS.failed)).toBe(true)
    expect(sourceHolds(path.join(staffAppDir(), 'frontend/utils/saveCardViaReader.ts'), words.SAVED_CARD_DIALOG_WORDS.notSaved)).toBe(true)
  })

  it('the check would catch a changed word: one letter off is not an old word', () => {
    expect(isOldWord(words.STORE_CREDIT_WORDS.belowZero)).toBe(true)
    expect(isOldWord(words.STORE_CREDIT_WORDS.belowZero.replace('—', '-'))).toBe(false)
    expect(isOldWord(words.CREATE_CUSTOMER_WORDS.under18.replace('18 or over', 'over 18'))).toBe(false)
    expect(isOldWord(`${words.CREATE_CUSTOMER_WORDS.firstNameRequired}.`)).toBe(false)
    expect(sourceHolds(component('NewCustomerDialog.tsx'), 'Customers must be over 18.')).toBe(false)
  })
})
