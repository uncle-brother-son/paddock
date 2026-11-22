import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { frozenWords, propertyUnionMembers, readSource, unionMembers } from '../frozen-words'
import type { OldAdminWord, OldFolder, OldWords } from '../old-words'
import { legacyAccountDir, legacyAdminDir, legacyBookingDir, legacyRefundDir } from './harness'

/*
 * W64a item 7: testing/old-words.json, recorded from the frozen copies. Each part is read exactly as the test that uses
 * it read the copy before (the parsers are frozen-words.ts's and admin/words.test.ts's, moved here unchanged), so the
 * words tests hold the Worker to the same old words after W65 deletes the copies. While the copies exist this proves the
 * file equals them; `UPDATE_OLD_WORDS=1` records it again (it never should need to: the copies are frozen). W65 deletes
 * this file with the copies.
 */

const OLD_WORDS_FILE = path.join(__dirname, '..', 'old-words.json')

const DIRS: Record<OldFolder, string> = {
  account: legacyAccountDir,
  accountRoutes: path.resolve(legacyAccountDir, '../../routes'),
  refund: legacyRefundDir,
  booking: legacyBookingDir,
}

// --- admin/words.test.ts's reading of step G's copy, moved here unchanged (W48 item 1).

const ADMIN_COPY = path.resolve(legacyAdminDir, '../..')
const VALUE = '${}'

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

function adminWordsOf(file: string): Array<Omit<OldAdminWord, 'file'>> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: Array<Omit<OldAdminWord, 'file'>> = []
  const add = (kind: OldAdminWord['kind'], node: ts.Node) => {
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

const adminReasonsOf = (file: string): string[] => [
  ...new Set([...readFileSync(file, 'utf8').matchAll(/reason\??:\s*((?:\s*\|?\s*'[a-z_]+')+)/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((reason) => reason[1] ?? ''))),
]

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : name.endsWith('.ts') ? [full] : []
  })
}

// --- The one-file facts, each read as its test read it.

/** events/failure-messages.test.ts's oldQuoteRefusals, moved unchanged. */
function quoteRefusals(file: string): Record<string, { reason: string; message: string }> {
  const source = readSource(file)
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

/** Every string literal of a file, in source order, each where it first appears (memberships' frozenOrder searched the source for them). */
function stringsInOrder(file: string): string[] {
  const found: string[] = []
  readSource(file).forEachChild(function visit(node) {
    if (ts.isStringLiteral(node) && !found.includes(node.text)) found.push(node.text)
    node.forEachChild(visit)
  })
  return found
}

const lineOf = (file: string, pattern: RegExp): string => {
  const line = readFileSync(file, 'utf8').split('\n').find((one) => pattern.test(one))
  if (!line) throw new Error(`${file} has no line like ${String(pattern)}`)
  return line.trim()
}
const exported = (source: string, name: string): string => {
  const found = new RegExp(`export const ${name} = \`([^\`]*)\``).exec(source)?.[1]
  if (found === undefined) throw new Error(`no ${name}`)
  return found
}

/** What the words tests read from the copies, recorded. */
export function recordFromTheCopies(): OldWords {
  const folders = Object.fromEntries(
    (Object.keys(DIRS) as OldFolder[]).map((folder) => {
      const { strings, templates } = frozenWords(DIRS[folder])
      return [folder, { strings: [...strings].sort(), templates }]
    })
  ) as OldWords['folders']
  // Keyed by type (each is declared once), with each file named beside its folder: the W34 guards refuse a gone module's
  // path named anywhere but beside a frozen folder.
  const unions: Record<string, string[]> = {
    'refund:CancelPlacesFailureReason': unionMembers(path.join(legacyRefundDir, 'shared/eventCancellationQuote.ts'), 'CancelPlacesFailureReason'),
    'refund:RefundOrderFailureReason': unionMembers(path.join(legacyRefundDir, 'refundOrder.ts'), 'RefundOrderFailureReason'),
  }
  const propertyUnions: Record<string, string[]> = {}
  for (const [file, iface] of [
    ['adjustCustomerStoreCredit.ts', 'AdjustCustomerStoreCreditResult'],
    ['extendGiftCardExpiry.ts', 'ExtendGiftCardExpiryResult'],
    ['setGiftCardPickedUp.ts', 'SetGiftCardPickedUpResult'],
    ['setGiftCardShipped.ts', 'SetGiftCardShippedResult'],
    ['setMembershipCancellation.ts', 'SetMembershipCancellationResult'],
    ['setMembershipHerd.ts', 'SetMembershipHerdResult'],
  ] as const) {
    propertyUnions[`account:${iface}.reason`] = propertyUnionMembers(path.join(legacyAccountDir, file), iface, 'reason')
  }
  const cancelEvent = readSource(path.join(legacyRefundDir, 'cancelEvent.ts')).getFullText()
  const paymentDate = readFileSync(path.join(legacyAccountDir, 'shared/membershipPaymentDate.ts'), 'utf8')
  const loader = readFileSync(path.join(legacyAdminDir, 'shared/eventAttendeeList.ts'), 'utf8')
  const staffAccess = readFileSync(path.join(legacyAdminDir, 'shared/staffAccess.ts'), 'utf8')
  const inactive = /export const INACTIVE_STAFF_MESSAGE\s*=\s*'([^']*)'/.exec(staffAccess)?.[1]
  if (inactive === undefined) throw new Error('no INACTIVE_STAFF_MESSAGE')
  const adminFiles = filesUnder(ADMIN_COPY)
  return {
    about: 'W64a item 7: what the words tests read from the frozen copies of the old staff app code, recorded by server/rules/testing/replay/old-words.test.ts. Read by server/rules/testing/old-words.ts.',
    folders,
    unions,
    propertyUnions,
    facts: {
      minReasonLength: lineOf(path.join(legacyAccountDir, 'adjustCustomerStoreCredit.ts'), /const MIN_REASON_LENGTH = /),
      quoteRefusals: quoteRefusals(path.join(legacyRefundDir, 'shared/eventCancellationQuote.ts')),
      cancelEventReasons: /reason: ((?:'[a-z_]+'(?: \| )?)+); message: string/.exec(cancelEvent)?.[1]?.split(' | ').map((quoted) => quoted.replace(/'/g, '')) ?? [],
      cancelEventStrings: stringsInOrder(path.join(legacyRefundDir, 'cancelEvent.ts')),
      paymentDateStrings: stringsInOrder(path.join(legacyAccountDir, 'shared/membershipPaymentDate.ts')),
      paymentDateSql: { columns: exported(paymentDate, 'PAYMENT_DATE_CHANGE_COLUMNS_SQL'), join: exported(paymentDate, 'PAYMENT_DATE_CHANGE_JOIN_SQL') },
      formatIsoDateMonths: lineOf(path.join(legacyAccountDir, 'shared/formatIsoDate.ts'), /const MONTHS = /),
      attendeeListLoader: {
        read: /paid\.order_id, COALESCE\(paid\.refund_owed_amount, 0\)::numeric\(10,2\)::text AS refund_owed_amount/.exec(loader)?.[0] ?? null,
        from:
          /LEFT JOIN LATERAL \(\s+SELECT o\.id AS order_id, o\.refund_owed_amount\s+FROM order_line_items oli JOIN orders o ON o\.id = oli\.order_id\s+WHERE oli\.event_booking_id = eb\.id AND oli\.item_type = 'event'\s+ORDER BY oli\.created_at, oli\.id LIMIT 1\s+\) paid ON true/.exec(
            loader
          )?.[0] ?? null,
        writes: /\b(INSERT|UPDATE|DELETE)\b/.test(loader),
      },
      inactiveStaffMessage: inactive,
    },
    admin: {
      files: adminFiles.length,
      words: adminFiles.flatMap((file) => adminWordsOf(file).map((word) => ({ ...word, file: path.relative(ADMIN_COPY, file) }))),
      reasons: Object.fromEntries(adminFiles.map((file) => [path.basename(file, '.ts'), adminReasonsOf(file)] as const).filter(([, reasons]) => reasons.length > 0)),
    },
  }
}

describe('testing/old-words.json: the old code\'s words, pinned (W64a item 7)', () => {
  it('equals what the frozen copies hold, read as each words test read them (UPDATE_OLD_WORDS=1 records it)', () => {
    const recorded = recordFromTheCopies()
    if (process.env.UPDATE_OLD_WORDS === '1') writeFileSync(OLD_WORDS_FILE, `${JSON.stringify(recorded, null, 1)}\n`)
    expect(JSON.parse(readFileSync(OLD_WORDS_FILE, 'utf8'))).toEqual(recorded)
  })

  it('records what the tests counted before: 107 step G files with 214 sentences; 15 place-cancel reasons; 5 membership-cancel reasons', () => {
    const recorded = recordFromTheCopies()
    expect(recorded.admin.files).toBe(107)
    expect(recorded.admin.words).toHaveLength(214)
    expect(recorded.unions['refund:CancelPlacesFailureReason']).toHaveLength(15)
    expect(recorded.propertyUnions['account:SetMembershipCancellationResult.reason']).toHaveLength(5)
    expect(recorded.facts.attendeeListLoader).toMatchObject({ read: expect.any(String), from: expect.any(String), writes: false })
  })
})
