import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { FAILURE_MESSAGES, FALLBACK_MESSAGE, herdWaitMessage, staffSees } from './failure-messages'

// The words moved from the staff app's checkout screen. Until the screen goes at W14, the Worker's
// copy must be the screen's, word for word: read here from the screen's source with the TypeScript
// parser, so a word changed on either side fails.

const frontend = path.join(staffAppDir(), 'frontend')

/** A file's string constants, and its object literal `name`, with identifiers resolved through `constants`. */
function readSource(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

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

function objectLiteral(source: ts.SourceFile, name: string, constants: Record<string, string>): Record<string, string> {
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
    if (!ts.isPropertyAssignment(property)) throw new Error(`${name} has a property that isn't a plain assignment`)
    const key = property.name.getText(source)
    const value = property.initializer
    if (ts.isStringLiteralLike(value)) entries[key] = value.text
    else if (ts.isIdentifier(value) && constants[value.text] !== undefined) entries[key] = constants[value.text] as string
    else throw new Error(`${name}.${key} isn't a string or a known constant`)
  }
  return entries
}

describe("the screen's words, moved", () => {
  const readiness = stringConstants(readSource(path.join(frontend, 'utils/quoteReadiness.ts')))
  const screen = objectLiteral(readSource(path.join(frontend, 'components/CheckoutDialog.tsx')), 'FAILURE_MESSAGES', readiness)

  it('every reason, word for word', () => {
    expect(Object.keys(screen).length).toBeGreaterThan(80)
    expect(FAILURE_MESSAGES).toEqual(screen)
  })

  it("the Herd gate's words, as the screen builds them", () => {
    const dialog = readFileSync(path.join(frontend, 'components/CheckoutDialog.tsx'), 'utf8')
    expect(dialog).toContain(
      "`That membership is not a Herd member yet — add-on credits unlock for Herd members (monthly members after ${membershipSettings.addonCreditWaitMonths} month${membershipSettings.addonCreditWaitMonths === 1 ? '' : 's'}, yearly members straight away).`"
    )
    expect(herdWaitMessage(6)).toBe('That membership is not a Herd member yet — add-on credits unlock for Herd members (monthly members after 6 months, yearly members straight away).')
    expect(herdWaitMessage(1)).toContain('after 1 month,')
  })

  it("the fallback is the screen's", () => {
    const dialog = readFileSync(path.join(frontend, 'components/CheckoutDialog.tsx'), 'utf8')
    expect(dialog.match(/'Failed to complete the order\.'/g)?.length).toBeGreaterThanOrEqual(2)
    expect(FALLBACK_MESSAGE).toBe('Failed to complete the order.')
  })
})

describe('what staff see, in the screen\'s order', () => {
  it('1. a changed cash figure shows its own words', () => {
    const message = 'The amount due has changed to £45.00. Check it with the customer and confirm again.'
    expect(staffSees({ reason: 'cash_amount_changed', message, amountDueTotal: 45 })).toBe(message)
  })

  it('2. any other refusal over the amount: the map, then the function', () => {
    expect(staffSees({ reason: 'payment_method_required', amountDueTotal: 20 })).toBe('Select how to pay the remaining amount.')
    expect(staffSees({ reason: 'payment_method_required', message: 'More.', amountDueTotal: 20 })).toBe('Select how to pay the remaining amount. More.')
  })

  it('3. the Herd gate, when the setting can be read', () => {
    expect(staffSees({ reason: 'addon_membership_too_new' }, { addonCreditWaitMonths: 3 })).toBe(herdWaitMessage(3))
    expect(staffSees({ reason: 'addon_membership_too_new' }, { addonCreditWaitMonths: null })).toBe(FAILURE_MESSAGES['addon_membership_too_new'])
  })

  it("4. the function's words, else the map's, else the fallback", () => {
    expect(staffSees({ reason: 'session_pass_not_valid_for_band', message: 'Own words.' })).toBe('Own words.')
    expect(staffSees({ reason: 'insufficient_capacity' })).toBe(FAILURE_MESSAGES['insufficient_capacity'])
    // The eight createBooking reasons with no words anywhere (W03-plan 1.1).
    for (const reason of [
      'customer_id_required',
      'invalid_redemption_source',
      'membership_id_required',
      'membership_not_found',
      'session_pass_id_required',
      'session_pass_not_found',
      'insufficient_membership_credit',
      'insufficient_session_pass_credit',
    ]) {
      expect(FAILURE_MESSAGES[reason]).toBeUndefined()
      expect(staffSees({ reason })).toBe(FALLBACK_MESSAGE)
    }
  })
})
