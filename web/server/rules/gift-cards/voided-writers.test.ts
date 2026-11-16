import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Brief W38a item 3 (W38 review S3): a guard for Wayne's Q46 "by marks". Reactivate refuses a voided gift card only
// when one of two marks says why it was voided: its own order line is refunded, or a `migrated_from_gift_card` store
// credit movement names it. A card voided with neither mark is un-voided, as before. So the rule in
// server/rules/README.md ("Gift cards (W38)") is: anything new that voids a card must leave one of these two marks, or
// add its own to the extension's check (gift-cards/admin.ts), or Reactivate gives a voided card's value back.
//
// This test finds every statement in the Worker's own code that writes `gift_cards.voided` and holds the list to
// today's. A new one fails here until someone has read that rule and decided what mark it leaves.
//
// Not covered: a statement whose table or column name is built at run time (none is), the test-only code under
// server/rules/testing (the frozen copies of the old staff app code and the replay's set-up), and the migrations and
// database functions (the saved live schema has no function that writes `voided`; the last test here holds that).

const README_RULE =
  'server/rules/README.md, "Gift cards (W38)", Q46: anything new that voids a gift card must leave one of the two marks Reactivate checks ' +
  '(its order line refunded in the same transaction, or a `migrated_from_gift_card` store credit movement naming the card), or add its own mark to ' +
  "the extension's check in gift-cards/admin.ts. Then add the statement to this test's list."

const workerDir = path.resolve(__dirname, '../../..')
const SOURCE_DIRS = ['app', 'server', 'contracts', 'lib', 'features', 'components', 'scripts']
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|sql)$/
const TEST_ONLY = /\.test\.tsx?$|^server\/rules\/testing\//

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, found)
    else if (SOURCE.test(name)) found.push(full)
  }
  return found
}

interface Writer {
  /** `voids` for anything that could set it true (`true`, a parameter, an expression); `un-voids` for a plain `false`. */
  kind: 'voids' | 'un-voids'
  /** What the statement sets it to, or `(a column of an INSERT)`. */
  to: string
}

/**
 * Every write of `voided` on gift_cards in a piece of source text: an UPDATE of gift_cards whose text sets it, and an
 * INSERT INTO gift_cards that names the column. A statement runs from its first word to the next statement's, the
 * next backtick, or 1,500 characters, whichever comes first, so text after a short one-line statement is read too:
 * that can only find more, never less.
 */
export function voidedWriters(text: string): Writer[] {
  const writers: Writer[] = []
  const starts = /\b(UPDATE|INSERT\s+INTO)\s+(?:ONLY\s+)?(?:public\.)?"?gift_cards"?\b/gi
  const nextStatement = /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s/gi
  for (let match = starts.exec(text); match; match = starts.exec(text)) {
    const from = match.index + match[0].length
    nextStatement.lastIndex = from
    const next = nextStatement.exec(text)?.index ?? text.length
    const tick = text.indexOf('`', from)
    const statement = text.slice(from, Math.min(next, tick === -1 ? text.length : tick, from + 1500))
    if (/^INSERT/i.test(match[1] ?? '')) {
      const columns = statement.slice(0, statement.search(/\b(VALUES|SELECT)\b/i) === -1 ? statement.length : statement.search(/\b(VALUES|SELECT)\b/i))
      if (/\bvoided\b/i.test(columns)) writers.push({ kind: 'voids', to: '(a column of an INSERT)' })
      continue
    }
    // `voided = <value>`, never `voided ==` (TypeScript read after a one-line statement).
    for (const set of statement.matchAll(/"?\bvoided\b"?\s*=(?!=)\s*([^\s,)'"]+)/gi)) {
      const to = set[1] ?? ''
      writers.push({ kind: /^false$/i.test(to) ? 'un-voids' : 'voids', to })
    }
  }
  return writers
}

/** Every writer in the Worker's own code, as `file: kind (to)`, sorted. */
function workerWriters(): string[] {
  const found: string[] = []
  for (const dir of SOURCE_DIRS) {
    let files: string[]
    try {
      files = sourceFiles(path.join(workerDir, dir))
    } catch {
      continue // A folder this checkout doesn't have.
    }
    for (const file of files) {
      const relative = path.relative(workerDir, file).split(path.sep).join('/')
      if (TEST_ONLY.test(relative)) continue
      for (const writer of voidedWriters(readFileSync(file, 'utf8'))) found.push(`${relative}: ${writer.kind} (${writer.to})`)
    }
  }
  return found.sort()
}

describe('every statement that writes gift_cards.voided (brief W38a item 3; W38 review S3; Wayne\'s Q46)', () => {
  it('one statement voids a gift card: the order refund (orders/refund-lines.ts). Any other fails here, naming the rule', () => {
    const voiding = workerWriters().filter((writer) => writer.includes(': voids '))
    expect(voiding, `A new statement voids a gift card. ${README_RULE}`).toEqual(['server/rules/orders/refund-lines.ts: voids (true)'])
  })

  it('two statements un-void one: the extension, after its Q46 check, and the undo of a refund. Any other fails here', () => {
    const unvoiding = workerWriters().filter((writer) => writer.includes(': un-voids '))
    expect(unvoiding, `A new statement un-voids a gift card, outside the extension's Q46 check. ${README_RULE}`).toEqual([
      'server/rules/gift-cards/admin.ts: un-voids (false)',
      'server/rules/orders/refund-lines.ts: un-voids (false)',
    ])
  })

  it("the refund leaves its mark with the void: the line is stamped `refunded_at` after it in the same transaction, and the undo clears both in one", () => {
    const refund = readFileSync(path.join(workerDir, 'server/rules/orders/refund-lines.ts'), 'utf8')
    const voidAt = refund.indexOf("'UPDATE gift_cards SET voided = true, updated_at = now() WHERE id = $1::uuid'")
    const stampAt = refund.indexOf("'UPDATE order_line_items SET refunded_at = now(), refund_method = $1::text, restocked = $2::boolean WHERE id = $3::uuid AND refunded_at IS NULL RETURNING id'")
    expect(voidAt).toBeGreaterThan(-1)
    expect(stampAt).toBeGreaterThan(voidAt)
    // Nothing between the two opens or ends a transaction, and a stamp that didn't land throws, so the void rolls back.
    const between = refund.slice(voidAt, stampAt)
    expect(between).not.toMatch(/\.transaction\(|\bCOMMIT\b|\bROLLBACK\b/)
    expect(refund.slice(stampAt, stampAt + 600)).toContain('if (stamped.length !== 1) throw new Error(')
    // The undo: the un-void and the stamp cleared, both on the transaction's own connection.
    const undoAt = refund.indexOf("'UPDATE gift_cards SET voided = false, updated_at = now() WHERE id = $1::uuid'")
    expect(undoAt).toBeGreaterThan(stampAt)
    const around = refund.slice(undoAt - 1500, undoAt + 2500)
    expect(around).toMatch(/UPDATE order_line_items SET refunded_at = NULL/)
    expect(around).not.toMatch(/\.transaction\(/)
  })

  it('the finder has teeth: each way of writing it is found, and a read or another column is not', () => {
    const kinds = (text: string) => voidedWriters(text).map((writer) => `${writer.kind} (${writer.to})`)
    expect(kinds("await tx.query('UPDATE gift_cards SET voided = true WHERE id = $1::uuid', [id])")).toEqual(['voids (true)'])
    expect(kinds("await tx.query('update gift_cards set voided=TRUE where id = $1', [id])")).toEqual(['voids (TRUE)'])
    expect(kinds('const SQL = `\nUPDATE gift_cards g\nSET remaining_balance = 0,\n    voided = $2::boolean\nWHERE g.id = $1::uuid`')).toEqual(['voids ($2::boolean)'])
    expect(kinds('UPDATE public.gift_cards SET "voided" = NOT voided WHERE id = $1')).toEqual(['voids (NOT)'])
    expect(kinds('UPDATE gift_cards SET voided = (remaining_balance = 0) WHERE id = $1')).toEqual(['voids ((remaining_balance)'])
    expect(kinds('WITH spent AS (UPDATE gift_cards SET voided = true WHERE id = $1 RETURNING id) SELECT 1')).toEqual(['voids (true)'])
    expect(kinds('INSERT INTO gift_cards (code, voided) VALUES ($1, $2)')).toEqual(['voids ((a column of an INSERT))'])
    expect(kinds("'UPDATE gift_cards SET voided = false, updated_at = now() WHERE id = $1::uuid'")).toEqual(['un-voids (false)'])
    // Not writes of it.
    expect(kinds("'UPDATE gift_cards SET picked_up = true WHERE id = $1::uuid'\nif (card.voided === true) throw refused()")).toEqual([])
    expect(kinds('SELECT voided FROM gift_cards WHERE voided = true')).toEqual([])
    expect(kinds('INSERT INTO gift_cards (code, type) VALUES ($1, $2)')).toEqual([])
    expect(kinds('UPDATE gift_card_redemptions SET voided = true')).toEqual([])
    expect(kinds('UPDATE orders SET voided = true')).toEqual([])
    // A second statement in the same file is its own writer.
    expect(kinds("'UPDATE gift_cards SET voided = true WHERE id = $1'\n'UPDATE gift_cards SET voided = $1 WHERE id = $2'")).toEqual(['voids (true)', 'voids ($1)'])
  })

  it('no database function or trigger writes it: the saved live schema names `voided` only as the column', () => {
    const schema = readFileSync(path.join(workerDir, 'server/rules/testing/live-schema.sql'), 'utf8')
    expect(voidedWriters(schema)).toEqual([])
    expect(schema.match(/\bvoided\b/g)).toHaveLength(1)
  })
})
