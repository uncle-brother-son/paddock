import 'server-only'
import type { StaffParityInput } from '@/contracts'
import type { Queryable, SqlParam } from '@/server/db'

/** Stores one old-versus-new comparison from the staff app's shadowCompare. */
export async function recordParity(db: Queryable, entry: StaffParityInput, requestId: string): Promise<void> {
  await db.query(
    `INSERT INTO parity_log (action, request_id, old_result, new_result, matches, diff)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.action,
      requestId,
      (entry.oldResult ?? null) as SqlParam,
      (entry.newResult ?? null) as SqlParam,
      entry.matches,
      (entry.diff ?? null) as SqlParam,
    ]
  )
}
