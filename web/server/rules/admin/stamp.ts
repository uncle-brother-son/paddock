// New in W54a (W49 + W54 review S1; the lead's call, 20 Nov: one step G rule). An edit that writes a whole row, or
// a whole set of rows, is refused when the row has changed since the screen read it. Each read answers a stamp
// beside what it shows; the press sends it back; admin/write.ts compares it under the lock the write already holds.
//
// The money case this closes: a page loaded before someone else's change sends every field as it was loaded, so a
// promo code's on/off switch puts an old discount back, and a postage save puts an old price back.
//
// Read-only: SQL fragments and plain functions, so a read may import it (no write statement lives here).
import 'server-only'

/** What staff are told. The screens read their data again on this refusal. */
export const CHANGED_SINCE_WORDS = 'This was changed by someone else since the page loaded. The page has been reloaded: check it and save again.'
/** The refusal's reason: the one an order's undo already uses for "this is no longer what was held". */
export const CHANGED_SINCE_REASON = 'changed_since'

/**
 * The stamp of a row that isn't there yet (a member term's first save): a screen that saw no row sends this, and
 * the save is refused if someone has written the row since.
 */
export const NO_ROW_STAMP = 'none'

/**
 * SQL for one row's stamp: its `updated_at`, to the microsecond, in UTC, then a fingerprint of the whole row.
 * `alias` is the table's alias in the statement (or the table's own name in a RETURNING), a literal in the rule's
 * own file.
 *
 * The fingerprint is what decides. It is every column of the row as text (`updated_at` among them), so any change
 * to the row changes the stamp, and a row that is back to exactly what the screen read has the stamp the screen
 * holds. `updated_at` alone, the moment the changing transaction began, would miss two changes: one made in the
 * same instant as the one before it (the test database's clock ticks in milliseconds, and the replay's is frozen),
 * and one that doesn't move `updated_at` (`promo_codes` and `postage_settings` have no `update_updated_at_column`
 * trigger: the Worker's own statements set it, a correction made by hand in SQL might not).
 *
 * The moment in front is for a person reading a stamp (in a log, on a refused press): it says when the row the
 * screen saw was last changed. Written out rather than cast, so it reads the same whatever a connection's time zone.
 *
 * Every connection the Worker opens has the same settings (server/db/postgres-driver.ts: UTC), so the row's text
 * is the same on the connection that reads and the one that writes; if that ever stopped being so, every stamped
 * save would be refused, never let through.
 */
export const rowStampSql = (alias: string): string => `(to_char(${alias}.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '#' || md5(${alias}::text))`

/** A row as a set's stamp needs it: its id and its own stamp (rowStampSql). */
export interface StampedRow {
  id: string
  stamp: string
}

/**
 * The stamp of a set of rows written together (a day's band windows): each row's id and stamp, in id order. Made in
 * one place from the rows a single statement read, so the read and the write can't make it two ways, and so a read
 * never pairs one moment's rows with another moment's stamp. No rows is its own stamp (the empty text is never one).
 */
export function rowsStamp(rows: readonly StampedRow[]): string {
  if (rows.length === 0) return NO_ROW_STAMP
  return [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => `${row.id}@${row.stamp}`)
    .join(',')
}

/** Whether the stamp a press sent is the one the row has now. A press that sent none, or something that isn't text, never is. */
export const sameStamp = (seen: unknown, now: string): boolean => typeof seen === 'string' && seen !== '' && seen === now
