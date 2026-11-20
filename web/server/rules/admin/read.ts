// New in W48 (G-plan 4.2, the reads; GB14; lead call L10; brief W48 item 3): the one shape every step G read has.
// An active staff member (the route's own staff check: an unknown or inactive one is refused before the rule runs,
// which is what none of the 30 old reads did), the admin role for the staff list, and named columns, never `*`.
// The staff app's side already gives every read 15 seconds and the "didn't answer in time" words (callWorker's
// READ_TIMEOUT_MS), so a slow Worker says so instead of blanking a page. No route calls this until W49.
import 'server-only'
import { staffRowBySignInEmail } from '@/server/auth/staff'
import type { Queryable, SqlParam } from '@/server/db'
import { requireAdminPermission, type AdminActor } from './refusal'

export interface AdminReadOptions {
  actor: AdminActor
}

export interface AdminRead {
  /** The read's name, for a refusal (`staff.list`). */
  name: string
  /** `admin` for the staff list; `staff` (any active staff member) for every other read. */
  needs: 'admin' | 'staff'
  sql: string
  params?: readonly SqlParam[]
  /** Columns that are moments: answered as ISO text, as the old functions' answers reached the screens. */
  times?: readonly string[]
}

/** A statement that reads every column of something (`SELECT *`, `b.*`, `RETURNING *`): what the old reads did. */
const READS_EVERY_COLUMN = /(^|[\s,(])(\w+\.)?\*(?=\s*(,|FROM\b|$))/im

/** `alias.column` for each column, with the ones in `asText` cast to text (money and dates as the database gives them). */
export function namedColumns(alias: string, columns: readonly string[], asText: readonly string[] = []): string {
  const text = new Set(asText)
  return columns.map((column) => (text.has(column) ? `${alias}.${column}::text AS ${column}` : `${alias}.${column}`)).join(', ')
}

const iso = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value)

/**
 * Runs one read: the permission in the old words, a statement that names its columns (one that reads `*` is a fault
 * in the rule, thrown before it runs, so a new column is a decision and never a leak), and each moment as ISO text.
 */
export async function adminRead<Row extends Record<string, unknown>>(db: Queryable, read: AdminRead, options: AdminReadOptions): Promise<Row[]> {
  requireAdminPermission(options.actor, read.needs, read.name)
  return namedRead<Row>(db, read)
}

/**
 * W50 (G-plan 4.8; brief item 3): the read itself, without the staff permission: named columns only, and each moment
 * as ISO text. For a read that takes the channel: on the staff channel it runs through adminRead (the permission
 * first); on the customer channel the rule limits the statement to the signed-in customer's own rows and runs it
 * here. Never called for a staff route without adminRead in front of it.
 */
export async function namedRead<Row extends Record<string, unknown>>(db: Queryable, read: Pick<AdminRead, 'name' | 'sql' | 'params' | 'times'>): Promise<Row[]> {
  if (READS_EVERY_COLUMN.test(read.sql)) throw new Error(`The read ${read.name} selects every column (*): name the columns it answers.`)
  const rows = await db.query<Row>(read.sql, read.params ?? [])
  const times = read.times ?? []
  if (times.length === 0) return rows
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row }
    for (const name of times) if (name in out) out[name] = iso(out[name])
    return out as Row
  })
}

/** The caller's own staff row: the columns the screen gates on, by name. */
export interface OwnStaffRow {
  id: string
  email: string
  role: 'admin' | 'manager' | 'staff'
  can_issue_refunds: boolean | null
  can_manage_pricing: boolean | null
  active: boolean | null
}

/**
 * L10's one exception (`GET staff/me`, the staff app's getCurrentStaff): the signed-in user's own staff row whether
 * active or not, so the screen can say the account is inactive; null when the email has no row. It takes the email,
 * not an actor, because an inactive member never becomes one: every other route still refuses them. Their own row
 * only, and never used for a permission check. W49 (GB16; W48 call 12): the email finds its row through the staff
 * check's own lookup (server/auth/staff.ts, staffRowBySignInEmail), in lower case on both sides, so the screen and
 * the staff check can never disagree about who a sign-in is.
 */
export async function ownStaffRow(db: Queryable, email: string): Promise<OwnStaffRow | null> {
  const row = await staffRowBySignInEmail(db, email)
  return row ? { id: row.id, email: row.email, role: row.role, can_issue_refunds: row.can_issue_refunds, can_manage_pricing: row.can_manage_pricing, active: row.active } : null
}
