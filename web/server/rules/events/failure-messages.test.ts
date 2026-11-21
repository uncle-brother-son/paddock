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
    // W30: the dialog's "Failed to cancel" went with the press key (a thrown call is no answer, with its own words).
    expect(sourceHolds(places, 'Failed to cancel')).toBe(false)
    // W31: the event dialog's "Failed to cancel the event" went the same way (a thrown call is no answer).
    expect(sourceHolds(event, 'Failed to cancel the event')).toBe(false)
    expect('cancelEventFallback' in words.EVENT_DIALOG_WORDS).toBe(false)
    expect(sourceHolds(event, words.EVENT_DIALOG_WORDS.eventEnded)).toBe(true)
    // The same sentence as the function's refusal.
    expect(words.EVENT_DIALOG_WORDS.eventEnded).toBe(words.EVENT_WHOLE_CANCEL_WORDS.eventEnded)
  })

  it('W30: the words the Worker adds for a place cancel, word for word', () => {
    const added = words.EVENT_CANCEL_NEW_WORDS
    expect(added.amountNotConfirmed).toBe('Check the refund figure and confirm again.')
    expect(added.figuresChanged).toBe('The figures on this event booking have just changed. Check them and confirm again.')
    // W30a (review L7): on a card order Card is possible too, so the words don't say "only store credit".
    expect(added.noCashLeft).toBe("No cash paid on this booking's order is left to hand back, so it can't be handed back in cash.")
    expect(added.notSaved).toBe("The cancellation couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was cancelled. Try again.")
    expect(added.notSentInTime).toBe("The card refund wasn't sent in time, so nothing was cancelled. Try again.")
    expect(added.unconfirmed).toBe("The places are cancelled, but the card refund didn't get a clear answer, so it may or may not have gone. Don't refund it again. Check the Orders page in a few minutes.")
    expect(added.goneNotRecorded(40)).toBe("The places are cancelled and £40.00 went back to the card, but the refund couldn't be finished on the booking yet. It's on hold: don't refund it again. Check the Orders page in a few minutes.")
    const refusedBy = 'Failed to refund payment: Your card was declined.'
    // W30a (review S1): the card refund didn't go back (never "nothing went back": the plan's store credit did).
    expect(added.putBackBlocked(refusedBy, 40)).toBe(
      "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card, and the places can't be put back: they have been booked by someone else since. The cancellation stands, and £40.00 shows on this booking as still to refund. Use Refund the rest to give it another way."
    )
    expect(added.putBackFailed(refusedBy, 40)).toBe(
      "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card, and the places couldn't be put back. The cancellation stands, and £40.00 shows on this booking as still to refund. Use Refund the rest to give it another way."
    )
    // The split case: £50 refused, the plan's £30 of store credit given, and named.
    expect(added.putBackBlocked(refusedBy, 50, 30)).toBe(
      "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card (£30.00 went to store credit as planned), and the places can't be put back: they have been booked by someone else since. The cancellation stands, and £50.00 shows on this booking as still to refund. Use Refund the rest to give it another way."
    )
    expect(added.putBackFailed(refusedBy, 50, 30)).toContain("so it didn't go back to the card (£30.00 went to store credit as planned), and the places couldn't be put back.")
    // A refund the press had no time to send was never refused: "wasn't sent in time", and nothing to check in Stripe.
    expect(added.putBackBlocked(added.notSentDetail, 50, 30)).toBe(
      "The card refund wasn't sent in time, so it didn't go back to the card (£30.00 went to store credit as planned), and the places can't be put back: they have been booked by someone else since. The cancellation stands, and £50.00 shows on this booking as still to refund. Use Refund the rest to give it another way."
    )
    expect(added.putBackFailed(added.notSentDetail, 40)).toBe(
      "The card refund wasn't sent in time, so it didn't go back to the card, and the places couldn't be put back. The cancellation stands, and £40.00 shows on this booking as still to refund. Use Refund the rest to give it another way."
    )
    const everyNotPutBack = [refusedBy, added.notSentDetail].flatMap((detail) => [added.putBackBlocked(detail, 50, 30), added.putBackFailed(detail, 50, 30), added.putBackBlocked(detail, 40), added.putBackFailed(detail, 40)])
    for (const text of everyNotPutBack) {
      expect(text).not.toContain('nothing went back')
      expect(text).not.toContain('Check Stripe')
    }
    for (const text of [added.putBackBlocked(added.notSentDetail, 40), added.putBackFailed(added.notSentDetail, 40), added.putBackBlockedNotRecorded(added.notSentDetail), added.putBackFailedNotRecorded(added.notSentDetail)]) {
      expect(text).not.toContain('was refused')
      expect(text.startsWith("The card refund wasn't sent in time, so ")).toBe(true)
    }
    // R2 failed too: nothing was given, store credit included, so "nothing went back" is true there.
    expect(added.putBackBlockedNotRecorded(refusedBy)).toContain('(Failed to refund payment: Your card was declined.), so nothing went back, and the places can\'t be put back')
    for (const text of [added.putBackBlockedNotRecorded(refusedBy), added.putBackFailedNotRecorded(refusedBy)]) {
      expect(text.endsWith("The cancellation stands, but the money still to refund couldn't be recorded yet. Don't refund it again: check the Orders page in a few minutes.")).toBe(true)
    }
    expect(words.EVENT_STORE_CREDIT_AFTER_CASH_NOTE('Full Moon Sauna')).toBe('Event refund: Full Moon Sauna (the rest was handed back in cash).')
    expect([...words.EVENT_CANCEL_NEW_REASONS]).toEqual(['refund_open', 'amount_not_confirmed', 'figures_changed', 'no_cash_left', 'cancel_not_saved'])
    // The old reasons are all still there: none was renamed.
    expect(words.EVENT_CANCEL_REASONS).toContain('changed_by_someone_else')
    expect(words.EVENT_CANCEL_REASONS.some((reason) => (words.EVENT_CANCEL_NEW_REASONS as readonly string[]).includes(reason))).toBe(false)
  })

  it('W31: the words the Worker adds for the whole event, word for word', () => {
    const added = words.EVENT_WHOLE_CANCEL_NEW_WORDS
    expect(added.eventNotCancelled).toBe("This event hasn't been cancelled, so its bookings can't be cancelled as a whole event. Close this, reload and try again.")
    expect(added.notSaved).toBe("The event's cancellation couldn't be saved (the system was busy, or one of its records couldn't be written), so the event wasn't cancelled. Try again.")
    // W52 (W35 audit F5): No refund on an event the club has cancelled, without Issue refunds, in words of its own.
    expect(added.noRefundNeedsIssueRefunds).toBe('The club has cancelled this event, so cancelling a place on it with no refund needs the Issue refunds permission.')
    expect(added.noRefundNeedsIssueRefunds).not.toContain('moves money back')
    expect([...words.EVENT_WHOLE_CANCEL_NEW_REASONS]).toEqual(['event_not_cancelled', 'cancel_not_saved'])
    // The old reasons are all still there, and none is also a new one.
    expect([...words.EVENT_WHOLE_CANCEL_REASONS]).toEqual(['invalid_params', 'event_not_found', 'event_ended', 'bookings_pending'])
    // Review L1: the places can't go back because the event has been cancelled since. Never "nothing went back" when
    // store credit was given, and the same advice as when the places were resold.
    const refusedBy = 'Failed to refund payment: Your card was declined.'
    const places = words.EVENT_CANCEL_NEW_WORDS
    expect(places.putBackEventCancelled(refusedBy, 40)).toBe(
      "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card, and the places can't be put back: the event has been cancelled since. The cancellation stands, and £40.00 shows on this booking as still to refund. Use Refund the rest to give it another way."
    )
    expect(places.putBackEventCancelled(refusedBy, 50, 30)).toBe(
      "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card (£30.00 went to store credit as planned), and the places can't be put back: the event has been cancelled since. The cancellation stands, and £50.00 shows on this booking as still to refund. Use Refund the rest to give it another way."
    )
    expect(places.putBackEventCancelled(places.notSentDetail, 40).startsWith("The card refund wasn't sent in time, so it didn't go back to the card, and the places can't be put back: the event has been cancelled since.")).toBe(true)
    expect(places.putBackEventCancelledNotRecorded(refusedBy)).toBe(
      "The card refund was refused (Failed to refund payment: Your card was declined.), so nothing went back, and the places can't be put back: the event has been cancelled since. The cancellation stands, but the money still to refund couldn't be recorded yet. Don't refund it again: check the Orders page in a few minutes."
    )
  })

  it('the check would catch a changed word', () => {
    expect(strings.has(words.EVENT_CANCEL_WORDS.changedBySomeoneElse)).toBe(true)
    expect(strings.has(words.EVENT_CANCEL_WORDS.changedBySomeoneElse.replace('reload', 'refresh'))).toBe(false)
    expect(fills(words.EVENT_CANCEL_WORDS.cardRefundFailed('x').replace('nothing was cancelled', 'nothing changed'))).toBe(false)
  })
})
