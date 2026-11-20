import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { BOOKING_ADMIN_WORDS } from '@/server/rules/bookings/admin-failure-messages'
import { CATALOG_ADMIN_DIALOG_WORDS, CATALOG_ADMIN_REASONS, CATALOG_ADMIN_WORDS, LEGACY_CATALOG_ROUTE_WORDS, PLAN_PRICE_MOVE_WORDS } from '@/server/rules/catalog/failure-messages'
import { EVENT_ADMIN_REASONS, EVENT_ADMIN_WORDS } from '@/server/rules/events/admin-failure-messages'
import { ORDER_ADMIN_REASONS, ORDER_ADMIN_WORDS } from '@/server/rules/orders/admin-failure-messages'
import { PRICING_ADMIN_WORDS } from '@/server/rules/pricing/admin-failure-messages'
import { PROMO_ADMIN_REASONS, PROMO_ADMIN_WORDS } from '@/server/rules/promo/admin-failure-messages'
import { SESSION_ADMIN_DIALOG_WORDS, SESSION_ADMIN_REASONS, SESSION_ADMIN_WORDS } from '@/server/rules/sessions/admin-failure-messages'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { legacyAdminDir } from '@/server/rules/testing/replay/harness'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'

// Brief W48 item 1: every refusal reason of the 82 old step G functions, and its words, is in the Worker's words
// files, word for word, and nothing else is. The old sentences are read from the frozen copy (testing/legacy-admin)
// with the TypeScript parser, so a word changed on either side fails here; the reasons are read from each old
// function's own result type; the dialogs' own sentences from the dialogs' source in the staff app.

const COPY = path.resolve(legacyAdminDir, '../..')
/** Stands in for a value a sentence takes (`${…}` in the old source; the argument of the word's function here). */
const VALUE = '${}'

/** A literal, a template or literals joined with `+`, as one string with each `${…}` shown as ${}. Null for anything else. */
function textOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => VALUE + span.literal.text).join('')
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = textOf(node.left)
    const right = textOf(node.right)
    return left === null || right === null ? null : left + right
  }
  if (ts.isParenthesizedExpression(node)) return textOf(node.expression)
  return null
}

interface OldWord {
  kind: 'thrown' | 'message' | 'route' | 'record' | 'const' | 'fallback' | 'returned'
  text: string
}

/** Every sentence a file can show staff: thrown, answered as `message`, a route's `error`, a named message, a fallback. */
function oldWords(file: string): OldWord[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: OldWord[] = []
  const add = (kind: OldWord['kind'], node: ts.Node) => {
    const text = textOf(node)
    if (text !== null && text.trim() !== '') found.push({ kind, text })
  }
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Error' && node.arguments?.[0]) add('thrown', node.arguments[0])
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      if (node.name.text === 'message') add('message', node.initializer)
      if (node.name.text === 'error') add('route', node.initializer)
      const record = node.parent.parent
      if (ts.isVariableDeclaration(record) && ts.isIdentifier(record.name) && /MESSAGES$/.test(record.name.text)) add('record', node.initializer)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /_MESSAGE$/.test(node.name.text) && node.initializer) add('const', node.initializer)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'invalid' && node.arguments[0]) add('message', node.arguments[0])
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'extractApiErrorMessage' && node.arguments[1]) add('fallback', node.arguments[1])
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 2 && node.elements[0] && node.elements[1] && ts.isStringLiteral(node.elements[0]) && /^events_/.test(node.elements[0].text)) add('message', node.elements[1])
    if (ts.isReturnStatement(node) && node.expression && (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) && /[a-z] [a-z]/.test(node.expression.text)) add('returned', node.expression)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** The reasons a file's own result types name. */
const oldReasons = (file: string): string[] => [...new Set([...readFileSync(file, 'utf8').matchAll(/reason\??:\s*((?:\s*\|?\s*'[a-z_]+')+)/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((reason) => reason[1] ?? '')))]

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : name.endsWith('.ts') ? [full] : []
  })
}

/** The plumbing between Retool, the legacy routes and Stripe, and a state one transaction can't leave: never moved. */
const NOT_MOVED = [/returned an HTML page/, /^Unauthorized$/, /^Missing required fields/, /^Internal server error$/, /^Unparseable timestamp/, /could not be read back/]
const notMoved = (word: OldWord): boolean => word.kind === 'fallback' || NOT_MOVED.some((pattern) => pattern.test(word.text))

type Words = Record<string, Record<string, string | ((...values: unknown[]) => string)>>
/** Each word as text, a sentence that takes values shown with ${} in their place (as the old source is read). */
const sentences = (words: Words): string[] => Object.values(words).flatMap((group) => Object.values(group).map((word) => (typeof word === 'function' ? word(VALUE, VALUE, VALUE) : word)))

const NEW_WORDS: Words[] = [STAFF_ADMIN_WORDS, CATALOG_ADMIN_WORDS, LEGACY_CATALOG_ROUTE_WORDS, { lib: PLAN_PRICE_MOVE_WORDS }, PROMO_ADMIN_WORDS, PRICING_ADMIN_WORDS, SESSION_ADMIN_WORDS, BOOKING_ADMIN_WORDS, EVENT_ADMIN_WORDS, ORDER_ADMIN_WORDS]
const moved = new Set(NEW_WORDS.flatMap(sentences))
const copyFiles = filesUnder(COPY)
const everyOldWord = copyFiles.flatMap((file) => oldWords(file).map((word) => ({ ...word, file: path.relative(COPY, file) })))

describe("step G's words (brief W48 item 1)", () => {
  it('reads the frozen copy: 107 files, 214 sentences in 53 of them, 168 of them different', () => {
    expect(copyFiles).toHaveLength(107)
    expect(everyOldWord).toHaveLength(214)
    expect(new Set(everyOldWord.map((word) => word.file)).size).toBe(53)
    expect(new Set(everyOldWord.map((word) => word.text)).size).toBe(168)
  })

  it('every sentence the old functions, their modules and the legacy routes can show staff is in a words file, word for word, unless it is plumbing', () => {
    const missing = everyOldWord.filter((word) => !notMoved(word) && !moved.has(word.text)).map((word) => `${word.file}: ${word.text}`)
    expect(missing).toEqual([])
  })

  it('nothing in the words files was made up: each is a sentence of the old code', () => {
    const old = new Set(everyOldWord.map((word) => word.text))
    expect([...moved].filter((sentence) => !old.has(sentence))).toEqual([])
    // 144 different sentences moved (the access words and a few route refusals are shared by several functions).
    expect(moved.size).toBe(144)
  })

  it('the plumbing stays out: an HTML page, the shared key, missing fields, an internal error, the fallbacks, "could not be read back"', () => {
    const plumbing = everyOldWord.filter(notMoved)
    expect(plumbing.length).toBe(38)
    // One fallback is also a legacy route's own refusal, and is moved as that: the preset route's "Failed to create gift card preset".
    const routesOwn = new Set(everyOldWord.filter((word) => word.kind === 'route').map((word) => word.text))
    expect(plumbing.filter((word) => moved.has(word.text) && !routesOwn.has(word.text)).map((word) => word.text)).toEqual([])
    expect(plumbing.filter((word) => moved.has(word.text)).map((word) => word.text)).toEqual(['Failed to create gift card preset'])
    for (const sentence of moved) expect(NOT_MOVED.some((pattern) => pattern.test(sentence)), sentence).toBe(false)
  })

  it('a sentence that takes a value puts it where the old one did', () => {
    expect(STAFF_ADMIN_WORDS.pricingStaff.noStaffRecordMatchesLoggedIn('jo@example.com')).toBe("No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before managing pricing.")
    expect(STAFF_ADMIN_WORDS.resolveStaffId.noStaffRecordMatchesLoggedIn('jo@example.com')).toBe("No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action.")
    expect(SESSION_ADMIN_WORDS.addServiceTypeScheduleSlot.serviceTypeAlreadyHasSlotOn('Tuesday', '07:00')).toBe('This service type already has a slot on Tuesday at 07:00.')
    expect(CATALOG_ADMIN_WORDS.adjustVariantStock.adjustmentWouldBringStockBelowZero(5, -6)).toBe('This adjustment would bring stock below zero (current stock: 5, change: -6).')
    expect(EVENT_ADMIN_WORDS.setEventDetails.capacityCantLowerThanPlacesAlready(2)).toBe("Capacity can't be lower than the places already booked (2).")
    expect(PROMO_ADMIN_WORDS.createPromoCode.promoCodeAlreadyExistsCodesAre('ALLTEN')).toBe('A promo code "ALLTEN" already exists (codes are unique, case-insensitive).')
  })

  it("every reason an old function's result type names is listed, in its order", () => {
    const listed: Record<string, readonly string[]> = { ...CATALOG_ADMIN_REASONS, ...PROMO_ADMIN_REASONS, ...SESSION_ADMIN_REASONS, ...EVENT_ADMIN_REASONS, ...ORDER_ADMIN_REASONS }
    const old = Object.fromEntries(
      copyFiles
        .map((file) => [path.basename(file, '.ts'), oldReasons(file)] as const)
        .filter(([, reasons]) => reasons.length > 0)
    )
    expect(listed).toEqual(old)
    expect(Object.keys(old).sort()).toEqual(['createOneOffSession', 'eventCheckIn', 'resetSessionBand', 'setEventActive', 'setEventAttendeeCheckIn', 'setEventAttendeeWaiver', 'setEventDetails', 'setOrderLineItemFulfilled', 'setSessionPassLevel', 'setSessionStartTime', 'updatePromoCode'])
    // The check-in's full list of eight is its message record's keys, and the two window reasons, whose words are the
    // attendee list's own (shared/eventAttendance: "Check-in opens on the day", "Check-in has closed").
    expect(Object.keys(EVENT_ADMIN_WORDS.eventCheckIn)).toEqual(['attendee_not_found', 'attendee_cancelled', 'booking_not_confirmed', 'event_cancelled', 'waivers_outstanding', 'extra_waiver_version_missing'])
    expect(Object.values(EVENT_ADMIN_WORDS.eventAttendance)).toEqual(['Check-in opens on the day', 'Check-in has closed'])
  })

  it("the dialogs' own sentences for a reason with no words are the dialogs', word for word", () => {
    const dialogs: Record<string, Record<string, string>> = { ...SESSION_ADMIN_DIALOG_WORDS, ...CATALOG_ADMIN_DIALOG_WORDS }
    expect(Object.keys(dialogs).sort()).toEqual(['CreateOneOffSessionDialog', 'EditSessionPassTypeDialog', 'EditSessionStartTimeDialog'])
    for (const [dialog, words] of Object.entries(dialogs)) {
      const file = path.join(staffAppDir(), 'frontend/components', `${dialog}.tsx`)
      // A dialog a later slice rewrites keeps its sentence here; while the dialog names the reason, the words must match.
      if (!existsSync(file)) continue
      const source = readFileSync(file, 'utf8')
      for (const [reason, sentence] of Object.entries(words)) {
        if (!new RegExp(`\\b${reason}:`).test(source)) continue
        expect(source, `${dialog}: ${reason}`).toContain(`${reason}: '${sentence.replace(/'/g, "\\'")}'`)
      }
    }
  })
})
