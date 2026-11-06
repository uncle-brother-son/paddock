import 'server-only'
import type { StaffParityInput } from '@/contracts'
import type { Queryable } from '@/server/db'

/**
 * These columns take any JSON value, and the driver reads a bound string as JSON text, so each is
 * encoded here: a result that is the string "123" stays a string, and one that isn't JSON still
 * stores. Null and a missing value stay SQL NULL.
 */
function jsonColumn(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/** Stores one old-versus-new comparison from the staff app's shadowCompare. */
export async function recordParity(db: Queryable, entry: StaffParityInput, requestId: string): Promise<void> {
  await db.query(
    `INSERT INTO parity_log (action, request_id, old_result, new_result, matches, diff)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.action,
      requestId,
      jsonColumn(entry.oldResult),
      jsonColumn(entry.newResult),
      entry.matches,
      jsonColumn(entry.diff),
    ]
  )
}
