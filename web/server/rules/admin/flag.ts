// New in W48 (G-plan 4.2, level C; brief W48 item 3): a flag on a customer's record (checked in, a waiver signed, an
// add-on prepared, a line fulfilled). One guarded statement, where the guard is the rule, and an audit row, in one
// transaction. Each call has its own key: setting a flag that is already set changes nothing more. No route calls
// it until W50.
import 'server-only'
import type { AdminAction } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, SqlParam, Tx } from '@/server/db'
import type { ApiError } from '@/server/http/errors'
import { requireAdminPermission, type AdminActor, type AdminNeeds } from './refusal'

export interface FlagWriteOptions {
  actor: AdminActor
  requestId: string
  /** The call's own key: the route's Idempotency-Key (a switch sends a new one for each call, lead call L12). */
  pressKey: string | null
}

export interface FlagWrite<Row> {
  action: AdminAction
  /** Any active staff member for every flag today (G-plan 4.6); the route's own staff check has already made that. */
  needs: AdminNeeds
  entity: { type: string; id: string }
  /**
   * The one statement: an UPDATE whose WHERE is the rule (the booking isn't cancelled, the check-in window is open,
   * the place isn't cancelled…) and whose RETURNING is the row as it is now. It answers no row when the guard refuses.
   */
  statement: { sql: string; params: readonly SqlParam[] }
  /** Why the guard refused, read in the same transaction: the refusal to throw, in the old words. */
  refusal(tx: Tx): Promise<ApiError>
  /** What the audit row keeps of the row (the flag as set, who by, the method). Default: the whole row returned. */
  recorded?(row: Row): Readonly<Record<string, unknown>>
}

/**
 * Sets or clears one flag:
 *  1. the call's key must be there (an idempotent route);
 *  2. the permission, in the old words;
 *  3. one transaction: the guarded statement; no row means the guard refused, and the reason is read and thrown, so
 *     nothing is kept; a row means the flag is as asked, and one audit row says who set it.
 */
export async function flagWrite<Row extends Record<string, unknown>>(db: Db, write: FlagWrite<Row>, options: FlagWriteOptions): Promise<Row> {
  if (!options.pressKey) throw new Error(`The flag write ${write.action} was run without a key: its route must be idempotent.`)
  const pressKey = options.pressKey
  requireAdminPermission(options.actor, write.needs, write.action)

  return db.transaction(async (tx) => {
    const rows = await tx.query<Row>(write.statement.sql, write.statement.params)
    if (rows.length > 1) throw new Error(`The flag write ${write.action} changed ${rows.length} rows: its statement must name one.`)
    const row = rows[0]
    if (!row) throw await write.refusal(tx)
    await audit.record(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: write.action,
      entityType: write.entity.type,
      entityId: write.entity.id,
      requestId: options.requestId,
      details: { after: write.recorded ? write.recorded(row) : row, key: pressKey },
    })
    return row
  })
}
