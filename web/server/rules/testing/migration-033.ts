import { readFileSync } from 'node:fs'
import path from 'node:path'

// Brief W53 item 8 (the W35 audit's row 4; G-plan lead call L7): migration 033 is written but NOT applied to live; the
// lead applies it after W53's review and before the Worker push. The saved schema (live-catalog.json, live-schema.sql)
// carries it already, as it did 023 and 032, so every test runs against the schema live will have. Kept here: which
// columns the file changes, the one it leaves, the checks it adds, and how to read the file's own SQL (its Down, and
// the checks its header gives the lead). Tests only.

export const MIGRATION_033 = path.resolve(__dirname, '../../../../supabase/migrations/033_money_columns_numeric_10_2.sql')

export const migration033 = (): string => readFileSync(MIGRATION_033, 'utf8')

/** The fourteen money columns 033 makes numeric(10,2), in the file's own order. */
export const MONEY_COLUMNS_033: ReadonlyArray<readonly [table: string, column: string]> = [
  ['addon_order_lines', 'card_refunded_amount'],
  ['addon_order_lines', 'refunded_amount'],
  ['event_attendees', 'cancelled_value'],
  ['event_attendees', 'card_refunded_amount'],
  ['event_attendees', 'refunded_amount'],
  ['membership_payment_date_changes', 'amount_charged'],
  ['membership_plans', 'price_monthly'],
  ['membership_plans', 'price_yearly'],
  ['order_line_items', 'card_refunded_amount'],
  ['order_line_items', 'discount_amount'],
  ['order_line_items', 'system_unit_price'],
  ['pending_reader_payments', 'expected_amount'],
  ['promo_code_redemptions', 'discount_amount'],
  ['promo_codes', 'min_spend'],
]

/** The one plain `numeric` column 033 leaves as it is: a fixed code's pounds, or a percentage code's percentage. */
export const LEFT_PLAIN_033 = ['promo_codes', 'discount_value'] as const

/** The eight checks 033 adds, each with the table it is on. */
export const NEW_CHECKS_033: ReadonlyArray<readonly [table: string, name: string]> = [
  ['addon_order_lines', 'addon_order_lines_refunded_within_line_check'],
  ['addon_order_lines', 'addon_order_lines_card_within_refunded_check'],
  ['membership_plans', 'membership_plans_price_monthly_check'],
  ['membership_plans', 'membership_plans_price_yearly_check'],
  ['order_line_items', 'order_line_items_card_refunded_amount_check'],
  ['order_line_items', 'order_line_items_discount_amount_check'],
  ['order_line_items', 'order_line_items_system_unit_price_check'],
  ['pending_reader_payments', 'pending_reader_payments_expected_amount_check'],
]

const DOWN_MARK = '-- Down ('

/** The file's Down, as SQL: the lines under its "Down" heading, each behind `--   `. */
export function down033(): string {
  const sql = migration033()
  const from = sql.indexOf(DOWN_MARK)
  if (from < 0) throw new Error("Migration 033's Down wasn't found.")
  return sql
    .slice(from)
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^-- {3}/, '').replace(/^--$/, ''))
    .join('\n')
    .trim()
}

/**
 * The SQL statements a part of the file's comments gives the lead: between the line that starts with `from` and the
 * line that starts with `to`, each statement runs from a line `--   SELECT …` to the line that ends with `;`. The
 * words around them (and a comment line between two statements) are left out.
 */
export function leadSql033(from: string, to: string): string[] {
  const lines = migration033().split('\n')
  const start = lines.findIndex((line) => line.startsWith(from))
  const end = lines.findIndex((line, index) => index > start && line.startsWith(to))
  if (start < 0 || end < 0) throw new Error(`Migration 033 has no block from "${from}" to "${to}".`)
  const statements: string[] = []
  let current: string[] | null = null
  for (const line of lines.slice(start + 1, end)) {
    if (current === null && /^-- {3}SELECT\b/.test(line)) current = []
    if (current === null) continue
    current.push(line.replace(/^-- {0,3}/, ''))
    if (line.trimEnd().endsWith(';')) {
      statements.push(current.join('\n').trim().replace(/;$/, ''))
      current = null
    }
  }
  if (current !== null) throw new Error(`A statement in migration 033's block "${from}" has no closing ";".`)
  return statements
}
