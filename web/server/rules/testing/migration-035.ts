import { readFileSync } from 'node:fs'
import path from 'node:path'

// Brief W72a (Wayne's WQ7; the lead's design, 24 Nov 2026): migration 035 is written but NOT applied to live; the lead
// applies it before the W72a Worker is pushed. The saved schema (live-catalog.json, live-schema.sql) carries it
// already, as W51 did for 032, so every test runs against the schema live will have: the Worker's products read, its
// categories read and the Sanity webhook all name 035's table. Kept here: the file and its Down.
// Tests only.

export const MIGRATION_035 = path.resolve(__dirname, '../../../../supabase/migrations/035_product_categories.sql')
/** 035's table: one row for each product category published in Sanity. */
export const CATEGORIES_TABLE = 'product_categories'

/** The migration file, whole. */
export const migration035 = (): string => readFileSync(MIGRATION_035, 'utf8')

/** The file's own statements: every line that isn't a comment. */
export const statements035 = (): string =>
  migration035()
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')

const DOWN_MARK = '-- Down ('
/** The Down in the file's footer, with its comment marks taken off: a script that can be run as written. */
export function down035(): string {
  const lines = migration035().split('\n')
  const from = lines.findIndex((line) => line.startsWith(DOWN_MARK))
  if (from < 0) throw new Error("Migration 035's Down wasn't found.")
  return lines
    .slice(from + 1)
    .map((line) => line.replace(/^-- {3}/, '').replace(/^--$/, ''))
    .join('\n')
    .trim()
}

/**
 * A header check's SQL statements: the SQL under the line that starts with `mark`, up to the next line that isn't
 * SQL. In the header a check's own words are indented less than eight spaces and its SQL eight or more.
 */
export function sqlUnder035(mark: string): string[] {
  const lines = migration035().split('\n')
  const from = lines.findIndex((line) => line.startsWith(mark))
  if (from < 0) throw new Error(`No line starts "${mark}" in migration 035.`)
  const block: string[] = []
  for (const line of lines.slice(from + 1)) {
    const sql = /^-- {8,}\S/.test(line)
    if (!sql && block.length > 0) break
    if (sql) block.push(line.replace(/^--/, ''))
  }
  return block
    .join('\n')
    .split(';')
    .map((sql) => sql.trim())
    .filter((sql) => sql !== '')
}
