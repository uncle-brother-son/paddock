import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { legacyBookingDir } from '@/server/rules/testing/replay/harness'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import * as words from './failure-messages'

// W17: step D's words, moved ahead of the slices that use them. The screens' maps must be the screens', word for
// word, until each screen goes (read here from the staff app's source with the TypeScript parser, as step C's test
// does), and the old functions' words must be in the frozen copy of the old code, word for word, so a word changed on
// either side fails. The words W17 adds are checked for what they must say.

const components = path.join(staffAppDir(), 'frontend/components')
const read = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

/** A file's top-level string constants. */
function stringConstants(source: ts.SourceFile): Record<string, string> {
  const found: Record<string, string> = {}
  source.forEachChild(function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      found[node.name.text] = node.initializer.text
    }
    node.forEachChild(visit)
  })
  return found
}

/** An object literal's entries; spreads of an earlier map in `maps` and known constants are resolved. */
function objectLiteral(source: ts.SourceFile, name: string, maps: Record<string, Record<string, string>> = {}): Record<string, string> {
  const constants = stringConstants(source)
  let literal: ts.ObjectLiteralExpression | undefined
  source.forEachChild(function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      literal = node.initializer
    }
    node.forEachChild(visit)
  })
  if (!literal) throw new Error(`${name} isn't in ${source.fileName}`)
  const entries: Record<string, string> = {}
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression) && maps[property.expression.text]) {
      Object.assign(entries, maps[property.expression.text])
      continue
    }
    if (!ts.isPropertyAssignment(property)) throw new Error(`${name} has a property that isn't a plain assignment`)
    const key = property.name.getText(source)
    const value = property.initializer
    if (ts.isStringLiteralLike(value)) entries[key] = value.text
    else if (ts.isIdentifier(value) && constants[value.text] !== undefined) entries[key] = constants[value.text] as string
    else throw new Error(`${name}.${key} isn't a string or a known constant`)
  }
  return entries
}

/** Every string literal in the frozen copy, and the static text of every template literal. */
function frozenCode(): { strings: Set<string>; templates: string[] } {
  const strings = new Set<string>()
  const templates: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.ts')) {
        read(full).forEachChild(function visit(node) {
          if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.add(node.text)
          if (ts.isTemplateExpression(node)) templates.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('\u0000'))
          node.forEachChild(visit)
        })
      }
    }
  }
  walk(legacyBookingDir)
  return { strings, templates }
}

/** Whether `text` is a frozen template filled in: its static parts, in order, with anything between. */
const fillsTemplate = (templates: string[], text: string): boolean =>
  templates.some((template) => {
    const parts = template.split('\u0000')
    const pattern = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?')}$`)
    // At least a few words of fixed text: a template that is all placeholders would fit anything.
    return parts.length > 1 && parts.join('').trim().length >= 12 && pattern.test(text)
  })

describe("the screens' words, moved", () => {
  it('Move: every reason, word for word', () => {
    const screen = objectLiteral(read(path.join(components, 'MoveBookingDialog.tsx')), 'FAILURE_MESSAGES')
    expect(Object.keys(screen).length).toBeGreaterThan(25)
    expect(words.MOVE_REASON_WORDS).toEqual(screen)
  })

  it('Settle: every reason, word for word', () => {
    expect(words.SETTLE_REASON_WORDS).toEqual(objectLiteral(read(path.join(components, 'SettleLapsedPaymentDialog.tsx')), 'FAILURE_MESSAGES'))
  })

  it('Add Guest and add-ons on their own: every reason, word for word', () => {
    const source = read(path.join(components, 'AddGuestDialog.tsx'))
    const guest = objectLiteral(source, 'REASON_MESSAGES')
    expect(words.ADD_GUEST_REASON_WORDS).toEqual(guest)
    expect(words.ADD_ADDONS_REASON_WORDS).toEqual(objectLiteral(source, 'ADDONS_REASON_MESSAGES', { REASON_MESSAGES: guest }))
    expect(stringConstants(source)['ADDONS_PAYMENT_MESSAGE']).toBe(words.ADDONS_PAYMENT_MESSAGE)
  })

  it('Remove Guest: every reason, and the retry lock, word for word', () => {
    const source = read(path.join(components, 'RemoveGuestDialog.tsx'))
    expect(words.REMOVE_GUEST_REASON_WORDS).toEqual(objectLiteral(source, 'REASON_MESSAGES'))
    expect(stringConstants(source)['RETRY_LOCKED_MESSAGE']).toBe(words.RETRY_LOCKED_MESSAGE)
  })

  it("each dialog's own fallback, and the special requests words, are in its source", () => {
    const sources: Record<keyof typeof words.FALLBACK_WORDS, string> = {
      move: 'MoveBookingDialog',
      settle: 'SettleLapsedPaymentDialog',
      add_guest: 'AddGuestDialog',
      add_addons: 'AddGuestDialog',
      remove_guest: 'RemoveGuestDialog',
      remove_guest_quote: 'RemoveGuestDialog',
      part_refund: 'PartRefundDialog',
      refund_owed: 'RefundTheRestDialog',
      cancel_and_refund: 'CancelAndRefundDialog',
      cancel_credit: 'CancelCreditBookingDialog',
      cancel_payment_needed: 'CancelPaymentNeededDialog',
      remove_addon: 'RemoveBookingAddonDialog',
      special_requests: 'BookingDetailContent',
    }
    // W21: in the Part refund and Refund the rest dialogs a call that throws got no answer (W20a's rule): they show the
    // backend's no-answer words (copied, as the frontend can't import backend files) instead of their fallback.
    const noAnswerNow = new Set(['part_refund', 'refund_owed'])
    for (const [action, dialog] of Object.entries(sources)) {
      if (noAnswerNow.has(action)) continue
      expect(readFileSync(path.join(components, `${dialog}.tsx`), 'utf8'), action).toContain(`'${words.FALLBACK_WORDS[action as keyof typeof sources]}'`)
    }
    const backendWords = readFileSync(path.join(components, '../../backend/paddock/shared/bookingWorker.ts'), 'utf8')
    const noAnswer = /export const REFUND_NO_ANSWER_MESSAGE =\s*\n?\s*"([^"]+)"/.exec(backendWords)?.[1]
    expect(noAnswer).toBeTruthy()
    for (const dialog of ['PartRefundDialog', 'RefundTheRestDialog']) {
      expect(readFileSync(path.join(components, `${dialog}.tsx`), 'utf8'), dialog).toContain(`"${noAnswer}"`)
    }
    expect(readFileSync(path.join(components, 'BookingDetailContent.tsx'), 'utf8')).toContain(`'${words.SPECIAL_REQUESTS_CANCELLED_WORDS}'`)
  })
})

describe('staffSees: what each dialog showed', () => {
  it("the old function's words first", () => {
    expect(words.staffSees('move', 'reader_payment_open', words.READER_PAYMENT_OPEN_MESSAGE)).toBe(words.READER_PAYMENT_OPEN_MESSAGE)
  })
  it("then the screen's for the reason", () => {
    expect(words.staffSees('move', 'reader_payment_open')).toBe(words.MOVE_REASON_WORDS['reader_payment_open'])
    expect(words.staffSees('add_addons', 'payment_method_required')).toBe(words.ADDONS_PAYMENT_MESSAGE)
    expect(words.staffSees('special_requests', 'booking_cancelled')).toBe('Cancelled bookings cannot be edited.')
  })
  it('then the bare reason on Add Guest and Remove Guest, the fallback elsewhere', () => {
    expect(words.staffSees('add_guest', 'something_new')).toBe('something_new')
    expect(words.staffSees('remove_guest', 'something_new')).toBe('something_new')
    expect(words.staffSees('move', 'something_new')).toBe('Failed to move booking.')
    expect(words.staffSees('settle', undefined)).toBe('Failed to take the payment.')
  })
})

describe("the old functions' words, moved", () => {
  const { strings, templates } = frozenCode()

  it('every constant is in the frozen copy, word for word', () => {
    const constants = [
      words.READER_PAYMENT_OPEN_MESSAGE,
      words.CARD_CHARGE_IN_PROGRESS_MESSAGE,
      words.CARD_CHARGE_ANSWER_LOST_MESSAGE,
      words.AMOUNT_CHANGED_MESSAGE,
      words.NOTHING_LEFT_IN_CASH_MESSAGE,
      words.INACTIVE_STAFF_MESSAGE,
      words.ISSUE_REFUNDS_NEEDED_MESSAGE,
      words.WITHIN_24_HOURS_MESSAGE,
      words.REFUND_UNSURE_MESSAGE,
      ...Object.values(words.MOVE_WORDS),
      ...Object.values(words.ADD_GUEST_WORDS),
      ...Object.values(words.SETTLE_WORDS),
      ...Object.values(words.REMOVE_GUEST_WORDS),
      ...Object.values(words.REFUND_WORDS),
      ...Object.values(words.CANCEL_CREDIT_WORDS),
      ...Object.values(words.REMOVE_ADDON_WORDS),
      ...Object.values(words.STATUS_WORDS),
    ]
    expect(constants.filter((text) => !strings.has(text))).toEqual([])
    expect(constants.length).toBeGreaterThan(45)
  })

  it('every template, filled in, is one of the frozen copy\'s templates', () => {
    const filled = [
      words.amountChangedToMessage(12.5),
      words.moveReaderSetupFailedMessage('card_declined'),
      words.moveCardRefundFailedMessage(11),
      words.moveStoreCreditUnclearMessage(11),
      words.addGuestGiftCardClaimFailedMessage('connection lost'),
      words.removeGuestRefundFailedMessage('card_declined', ''),
      words.reasonRequiredMessage('a part refund'),
      words.reasonTooLongMessage(200),
      words.owedChangedMessage(20),
      words.onlyLeftMessage(20),
      words.onlyCardLeftMessage(20),
      words.notCancellableMessage('completed'),
      words.invalidStatusMessage('nope', ['pending', 'confirmed']),
    ]
    expect(filled.filter((text) => !fillsTemplate(templates, text))).toEqual([])
  })

  it('the two templates built on REFUND_UNSURE_MESSAGE (a constant inside them), as the old code put them together', () => {
    expect(words.moveRefundUnsureMessage(11)).toBe(`The £11.00 is still on the booking. ${words.REFUND_UNSURE_MESSAGE}`)
    expect(words.removeGuestUnsureMessage('timeout', '')).toBe(`The guest hasn't been removed. ${words.REFUND_UNSURE_MESSAGE} (timeout)`)
    expect(templates.some((template) => template.startsWith('The £') && template.includes(' is still on the booking. '))).toBe(true)
    expect(templates.some((template) => template.startsWith("The guest hasn't been removed. "))).toBe(true)
  })

  it('the check would catch a changed word', () => {
    expect(strings.has(`${words.REFUND_WORDS.figuresChanged} `)).toBe(false)
    expect(fillsTemplate(templates, 'Only £20.00 is left on this booking. Check the amount and confirm.')).toBe(false)
  })
})

describe('the words W17 adds', () => {
  it('the switch, as W16 worded ORDER_PATH_OFF', () => {
    expect(words.BOOKING_PATH_OFF_MESSAGE).toBe('This is switched off in the booking system. Tell a manager.')
  })

  it("Q35's two sentences, word for word as Wayne agreed them (D-plan Q35, W03-decisions 12 Nov)", () => {
    expect(words.CHANGE_PAYMENT_UNCONFIRMED_MESSAGE).toBe(
      "The card payment didn't get a clear answer, so it may or may not have been taken. The change is on hold: don't take payment again. Check the Orders page in a few minutes."
    )
    expect(words.CHANGE_REFUND_UNCONFIRMED_MESSAGE).toBe(
      "The refund didn't get a clear answer, so it may or may not have gone. Don't refund it again. Check the Orders page in a few minutes."
    )
  })

  it('a held card flow: "card payment" (W05 review 1, finding 18), and only Resolve now, never a finish or cancel button (W19, W17 review later 1)', () => {
    expect(words.CARD_PAYMENT_OPEN_MESSAGE).toContain('card payment')
    expect(words.CARD_PAYMENT_OPEN_MESSAGE).not.toContain('card reader')
    expect(words.CARD_PAYMENT_OPEN_MESSAGE).toContain('Resolve now on the Orders page after 15 minutes')
    expect(words.CARD_PAYMENT_OPEN_MESSAGE).not.toMatch(/finish|cancel/i)
  })

  it("Q37's payment line: what was paid, in Q37's own example", () => {
    expect(words.paidLineWords({ card: 15, giftCardOrStoreCredit: 5, cash: 0 })).toBe('Paid £15.00 by card and £5.00 by gift card / store credit.')
    expect(words.paidLineWords({ card: 0, giftCardOrStoreCredit: 0, cash: 20 })).toBe('Paid £20.00 in cash.')
    expect(words.paidLineWords({ card: 10, giftCardOrStoreCredit: 5, cash: 5 })).toBe('Paid £10.00 by card, £5.00 by gift card / store credit and £5.00 in cash.')
  })

  it("W21a (review S1): the Part refund dialog's line says what is left to refund", () => {
    expect(words.leftLineWords({ card: 25, giftCardOrStoreCredit: 0, cash: 0 })).toBe('Left to refund: £25.00 card money.')
    expect(words.leftLineWords({ card: 15, giftCardOrStoreCredit: 5, cash: 0 })).toBe('Left to refund: £15.00 card money and £5.00 gift card / store credit.')
    expect(words.leftLineWords({ card: 10, giftCardOrStoreCredit: 5, cash: 5 })).toBe('Left to refund: £10.00 card money, £5.00 gift card / store credit and £5.00 cash.')
    expect(words.leftLineWords({ card: 0, giftCardOrStoreCredit: 0, cash: 0 })).toBe('Nothing left to refund.')
  })

  it('W21a (review L1, L6): the old refund that reached the customer, and the later part not sent in time', () => {
    expect(words.oldRefundReachedCustomerMessage([40])).toBe(
      'An earlier card refund of £40.00 on this booking reached the customer, so nothing was refunded. Check Stripe, then use It already arrived for what arrived.'
    )
    expect(words.oldRefundReachedCustomerMessage([40, 20])).toContain('Earlier card refunds of £40.00 and £20.00 on this booking reached the customer')
    expect(words.laterCardRefundNotSentMessage(30)).toBe("A further card refund of £30.00 wasn't sent in time, so it's owed on the booking: use Refund the rest to send it to the card.")
  })
})
