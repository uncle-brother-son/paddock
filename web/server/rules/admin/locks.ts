// New in W48 (G-plan 4.2 item 2): the row locks a step G admin write takes, in LOCK_ORDER (server/rules/orders/locks.ts).
import 'server-only'
import type { Tx } from '@/server/db'
import { LOCK_ORDER } from '@/server/rules/orders/locks'

type LockName = (typeof LOCK_ORDER)[number]

/**
 * Every table a step G write may lock a row of, and its place in LOCK_ORDER. Step G's own rows are 'admin_row', the
 * first place, in the order written here; a row a money transaction also locks keeps the place it already has.
 */
export const ADMIN_LOCK_TABLES = {
  staff: 'admin_row',
  service_types: 'admin_row',
  service_type_price_tiers: 'admin_row',
  service_type_schedule_slots: 'admin_row',
  products: 'admin_row',
  addons: 'admin_row',
  session_pass_types: 'admin_row',
  gift_card_types: 'admin_row',
  gift_card_presets: 'admin_row',
  membership_plans: 'admin_row',
  session_bands: 'admin_row',
  band_rules: 'admin_row',
  membership_band_terms: 'admin_row',
  // W49 + W54 (W48 review S1): the two one-row settings tables. Their id is a boolean (`true`), see ADMIN_LOCK_ID_TYPES.
  postage_settings: 'admin_row',
  membership_settings: 'admin_row',
  promo_codes: 'promo_code',
  sessions: 'session',
  customer_memberships: 'membership',
  product_variants: 'product_variants',
  events: 'event',
} as const satisfies Record<string, LockName>
export type AdminLockTable = keyof typeof ADMIN_LOCK_TABLES

const TABLE_ORDER = Object.keys(ADMIN_LOCK_TABLES) as AdminLockTable[]
/** Where a table's lock comes: its place in LOCK_ORDER, then its place among the tables above. */
const placeOf = (table: AdminLockTable): number => LOCK_ORDER.indexOf(ADMIN_LOCK_TABLES[table]) * 100 + TABLE_ORDER.indexOf(table)

/**
 * W49 + W54 (W48 review S1): the two settings tables hold one row, whose id is the boolean `true` (a check on each
 * table keeps it so), where every other table's id is a uuid. They are locked as `ids: SETTINGS_ROW`, by a statement
 * that names the row as `id = true`: nothing is cast, and no boolean goes in as a parameter (the Worker's driver sends
 * the text 'true' in a boolean array as false, and a boolean array as a single boolean: either would lock nothing or
 * fail; pricing/admin-postgres.test.ts and admin/helpers-postgres.test.ts hold this on real Postgres).
 */
const ONE_ROW_SETTINGS_TABLES: ReadonlySet<AdminLockTable> = new Set<AdminLockTable>(['postage_settings', 'membership_settings'])
/** The one row of a settings table (postage_settings, membership_settings). */
export const SETTINGS_ROW: readonly string[] = ['true']

/**
 * W49 + W54: every row of a small table, as the table's guard. A rule that is about the whole table ("keep one
 * active admin", "keep one active Manage pricing holder": GB16; a day's band windows, which name any band: GB8)
 * can't be decided under a lock on one row: two presses on two different rows would each pass. Locking every row,
 * in id order, makes every such press take turns. Only for tables a handful of rows long whose rows are never
 * deleted (staff, session_bands): a row added while a press holds the guard is not held by it, which is safe for
 * these rules because a new row can only add a holder, never take one away.
 */
export const EVERY_ROW = 'every_row'

export interface AdminLock {
  table: AdminLockTable
  /** The rows to lock, by id, locked in id order whatever order they are given in; or EVERY_ROW, the table's guard. */
  ids: readonly string[] | typeof EVERY_ROW
}

/** The rows that exist and are now held, by table, each list in the order locked (id order). */
export type HeldAdminLocks = Partial<Record<AdminLockTable, string[]>>

/** The locks in the order they must be taken: LOCK_ORDER's, one entry per table, its ids together. */
export function inLockOrder(locks: readonly AdminLock[]): AdminLock[] {
  const byTable = new Map<AdminLockTable, Set<string> | typeof EVERY_ROW>()
  for (const lock of locks) {
    const sofar = byTable.get(lock.table)
    // Every row holds any row named beside it.
    if (lock.ids === EVERY_ROW || sofar === EVERY_ROW) {
      byTable.set(lock.table, EVERY_ROW)
      continue
    }
    const ids = sofar ?? new Set<string>()
    for (const id of lock.ids) ids.add(id)
    byTable.set(lock.table, ids)
  }
  return [...byTable].sort(([a], [b]) => placeOf(a) - placeOf(b)).map(([table, ids]) => ({ table, ids: ids === EVERY_ROW ? EVERY_ROW : [...ids].sort() }))
}

/** A uuid as text: an id that isn't one names no row, and is left out of the lock rather than failing its cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/**
 * Locks the rows, one statement for each table, in LOCK_ORDER; within a table in id order (a locking SELECT sorts
 * before it locks, as lockForBooking's sessions), so two writes that name the same rows queue and never deadlock.
 * FOR NO KEY UPDATE is the lock an UPDATE of the row takes: two edits of one row queue, while an insert that only
 * points at the row (an order line naming a product, a booking naming a session) doesn't wait. A statement each,
 * not one joined statement: these are admin presses, not the order path, and the order is then plain to read.
 * An id with no row is simply not in the answer: the caller refuses in its own words. W49: so is an id that isn't
 * a uuid at all (text a route was sent), which no row can have.
 *
 * W54 (W48 review L1): this locks rows in id order, but a bare multi-row UPDATE takes its row locks in the order its
 * scan meets them. Two presses that each change many rows of one table (a band-window save re-banding a day's
 * sessions while Block Day blocks them) can then each hold a row the other wants. So before any multi-row write of
 * sessions (or memberships), take this lock on those ids first: server/rules/pricing/admin.ts does for the re-band.
 */
export async function lockAdminRows(tx: Tx, locks: readonly AdminLock[]): Promise<HeldAdminLocks> {
  const held: HeldAdminLocks = {}
  for (const { table, ids } of inLockOrder(locks)) {
    // The table's name is one of ADMIN_LOCK_TABLES' own keys, never a value from a request.
    if (ids === EVERY_ROW) {
      // eslint-disable-next-line no-restricted-syntax -- the table is a literal from ADMIN_LOCK_TABLES; nothing else goes in
      const rows = await tx.query<{ id: unknown }>(`SELECT id FROM ${table} ORDER BY id FOR NO KEY UPDATE`)
      held[table] = rows.map((row) => String(row.id))
      continue
    }
    if (ONE_ROW_SETTINGS_TABLES.has(table)) {
      // The one row there can be: `id = true`. Asked for anything else, nothing is held.
      // eslint-disable-next-line no-restricted-syntax -- the table is a literal from ADMIN_LOCK_TABLES; nothing else goes in
      const rows = ids.includes('true') ? await tx.query<{ id: unknown }>(`SELECT id FROM ${table} WHERE id = true FOR NO KEY UPDATE`) : []
      held[table] = rows.map((row) => String(row.id))
      continue
    }
    const named = ids.filter(isUuid)
    if (named.length === 0) {
      held[table] = []
      continue
    }
    // eslint-disable-next-line no-restricted-syntax -- the table is a literal from ADMIN_LOCK_TABLES; the ids go in as $1
    const rows = await tx.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE`, [named])
    held[table] = rows.map((row) => row.id)
  }
  return held
}
