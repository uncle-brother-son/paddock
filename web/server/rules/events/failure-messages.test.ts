import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { frozenWords, readSource, sourceHolds, templatesFilledBy, unionMembers } from '@/server/rules/testing/frozen-words'
import { legacyRefundDir } from '@/server/rules/testing/replay/harness'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import * as words from './failure-messages'

// Brief W27 item 5: the event cancellations' words, moved ahead of the slices that use them (W30, W31). Every reason
// must be listed, and every word moved must be the old functions', word for word, read here from the frozen copy of
// the old code (legacy-refund) with the TypeScript parser, so a word changed on either side fails. The dialogs' own
// words are held to the dialogs' source until the screens change at W30 and W31.

const { strings, templates } = frozenWords(legacyRefundDir)
const components = path.join(staffAppDir(), 'frontend/components')
const fills = (text: string): boolean => templatesFilledBy(templates, text).length > 0

/** shared/eventCancellationQuote.ts's QUOTE_REFUSALS, read as it is written: `{ key: { reason, message } }`. */
function oldQuoteRefusals(): Record<string, { reason: string; message: string }> {
  const source = readSource(path.join(legacyRefundDir, 'shared/eventCancellationQuote.ts'))
  const found: Record<string, { reason: string; message: string }> = {}
  source.forEachChild(function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'QUOTE_REFUSALS' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) throw new Error('QUOTE_REFUSALS has an entry that is not an object')
        const entry: Record<string, string> = {}
        for (const inner of property.initializer.properties) {
          if (!ts.isPropertyAssignment(inner) || !ts.isStringLiteralLike(inner.initializer)) throw new Error('QUOTE_REFUSALS has a value that is not a string')
          entry[inner.name.getText(source)] = inner.initializer.text
        }
        found[property.name.getText(source)] = { reason: entry['reason'] ?? '', message: entry['message'] ?? '' }
      }
    }
    node.forEachChild(visit)
  })
  return found
}

describe("the event cancellations' reasons and words, moved (brief W27 item 5)", () => {
  it('every reason a place cancel could answer with is listed, and no other', () => {
    const old = unionMembers(path.join(legacyRefundDir, 'shared/eventCancellationQuote.ts'), 'CancelPlacesFailureReason')
    expect(old).toHaveLength(15)
    expect([...words.EVENT_CANCEL_REASONS]).toEqual(old)
  })

  it("the quote's refusals: every reason of event_cancellation_quote with its words, word for word", () => {
    const old = oldQuoteRefusals()
    expect(Object.keys(old)).toHaveLength(6)
    expect(words.EVENT_QUOTE_REFUSALS).toEqual(old)
  })

  it('each fixed word of a place cancel is a string of the old code, word for word', () => {
    const fixed = Object.entries(words.EVENT_CANCEL_WORDS).filter(([, value]) => typeof value === 'string') as Array<[string, string]>
    expect(fixed.length).toBe(9)
    for (const [name, text] of fixed) expect(strings.has(text), name).toBe(true)
  })

  it('each word built from values fills a template of the old code, with the values in place', () => {
    const built: Array<[string, string, string]> = [
      ['cardCheckFailed', words.EVENT_CANCEL_WORDS.cardCheckFailed('the database is away'), 'Checking the card payment failed, so nothing was cancelled: the database is away'],
      ['cardRefundFailed', words.EVENT_CANCEL_WORDS.cardRefundFailed('This charge is disputed.'), 'The card refund failed, so nothing was cancelled: This charge is disputed.'],
      [
        'sameRefundBySomeoneElse',
        words.EVENT_CANCEL_WORDS.sameRefundBySomeoneElse(40),
        'Someone else cancelled these places at the same moment, with the same card refund of £40.00: it went back to the card once, on their cancellation. Reload to see it.',
      ],
      ['notRecorded', words.EVENT_CANCEL_WORDS.notRecorded('event_cancel_conflict'), 'Recording the cancellation failed, so nothing was cancelled: event_cancel_conflict'],
    ]
    const functions = Object.entries(words.EVENT_CANCEL_WORDS).filter(([, value]) => typeof value === 'function')
    expect(functions.map(([name]) => name).sort()).toEqual(built.map(([name]) => name).sort())
    for (const [name, text, expected] of built) {
      expect(text, name).toBe(expected)
      expect(fills(text), name).toBe(true)
    }
    // With no words from Stripe, the old fallback.
    expect(words.EVENT_CANCEL_WORDS.cardRefundFailed(undefined)).toBe('The card refund failed, so nothing was cancelled: unknown error')
    expect(strings.has('unknown error')).toBe(true)
  })

  it('the permission words are the ones the old functions threw', () => {
    expect(strings.has(words.EVENT_PERMISSION_WORDS.needsIssueRefunds)).toBe(true)
    const none = words.EVENT_PERMISSION_WORDS.noStaffRecord('jo@example.com')
    expect(none).toBe("No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action.")
    expect(fills(none)).toBe(true)
  })

  it("the store credit note is the old one, with and without a card part (a row the replay compares)", () => {
    expect(words.eventStoreCreditNote('Full Moon Sauna', 0)).toBe('Event refund: Full Moon Sauna.')
    expect(words.eventStoreCreditNote('Full Moon Sauna', 15)).toBe('Event refund: Full Moon Sauna (the rest went back to the card).')
    expect(fills(words.eventStoreCreditNote('Full Moon Sauna', 0))).toBe(true)
    expect(fills(words.eventStoreCreditNote('Full Moon Sauna', 15))).toBe(true)
    expect(strings.has(words.EVENT_NAME_FALLBACK)).toBe(true)
  })

  it('the whole event: every reason, and each one\'s words, word for word', () => {
    const cancelEvent = readSource(path.join(legacyRefundDir, 'cancelEvent.ts')).getFullText()
    for (const reason of words.EVENT_WHOLE_CANCEL_REASONS) expect(cancelEvent, reason).toContain(`'${reason}'`)
    // The old result's union names exactly these four.
    expect(/reason: ((?:'[a-z_]+'(?: \| )?)+); message: string/.exec(cancelEvent)?.[1]?.split(' | ').map((quoted) => quoted.replace(/'/g, ''))).toEqual([...words.EVENT_WHOLE_CANCEL_REASONS])
    const fixed = Object.entries(words.EVENT_WHOLE_CANCEL_WORDS).filter(([, value]) => typeof value === 'string') as Array<[string, string]>
    expect(fixed.length).toBe(5)
    for (const [name, text] of fixed) expect(strings.has(text), name).toBe(true)
    const pending = words.EVENT_WHOLE_CANCEL_WORDS.bookingsPending(['Sam Test', 'Mo Member'])
    expect(pending).toBe('A card reader payment is still in progress for Sam Test, Mo Member. Finish or cancel it first.')
    expect(fills(pending)).toBe(true)
  })

  it("the overview's words for a booking that can't be cancelled", () => {
    expect(strings.has(words.EVENT_OVERVIEW_WORDS.placeCheckedIn)).toBe(true)
    const other = words.EVENT_OVERVIEW_WORDS.cannotBeCancelled('booking_not_confirmed')
    expect(other).toBe("Can't be cancelled (booking_not_confirmed).")
    expect(fills(other)).toBe(true)
  })

  it("the dialogs' own words are in the dialogs' source", () => {
    const places = path.join(components, 'CancelEventPlacesDialog.tsx')
    const event = path.join(components, 'CancelEventDialog.tsx')
    expect(sourceHolds(places, words.EVENT_DIALOG_WORDS.quoteFailed)).toBe(true)
    expect(sourceHolds(places, words.EVENT_DIALOG_WORDS.cancelFallback)).toBe(true)
    expect(sourceHolds(event, words.EVENT_DIALOG_WORDS.cancelEventFallback)).toBe(true)
    expect(sourceHolds(event, words.EVENT_DIALOG_WORDS.eventEnded)).toBe(true)
    // The same sentence as the function's refusal.
    expect(words.EVENT_DIALOG_WORDS.eventEnded).toBe(words.EVENT_WHOLE_CANCEL_WORDS.eventEnded)
  })

  it('the check would catch a changed word', () => {
    expect(strings.has(words.EVENT_CANCEL_WORDS.changedBySomeoneElse)).toBe(true)
    expect(strings.has(words.EVENT_CANCEL_WORDS.changedBySomeoneElse.replace('reload', 'refresh'))).toBe(false)
    expect(fills(words.EVENT_CANCEL_WORDS.cardRefundFailed('x').replace('nothing was cancelled', 'nothing changed'))).toBe(false)
  })
})
