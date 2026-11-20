// New in W48 (G-plan 4.2, level C; brief W48 item 3): a flag on a customer's record (checked in, a waiver signed, an
// add-on prepared, a line fulfilled). One guarded statement, where the guard is the rule, and an audit row, in one
// transaction. Each call has its own key: setting a flag that is already set keeps the flag and who set it, though a
// repeat press still moves the booking's `updated_at` on Check In and writes another audit row (W50 review, "Claims"
// 1; W51 item 13). W50 is its first user (server/rules/bookings/admin.ts).
//
// W50 (W48 review L2): what the guard can be trusted with. Postgres re-checks only the row a statement updates after
// it has waited for that row's lock. A guard that reads ANOTHER table (a guest's waiver guarded by its booking's
// status) is judged on what the statement saw when it started, so a cancel that commits while the flag's statement
// runs is not seen. Such a flag names the other table's row in `holdFirst`: it is locked FOR SHARE in a statement of
// its own before the flag's statement, so a cancel in progress is waited for (its row lock conflicts), and the flag's
// statement, which starts after the wait, is decided on the committed status; and a cancel that starts later waits
// for the flag's transaction. The guard itself is only ever under lock for the row it updates.
//
// W50a (W50 review L2 and L6):
//  - The same holds when the guard reads another table about the flag's OWN row (Check In refused while a payment is
//    open on the booking: the open payment is a pending_reader_payments row). The booking is then held first too, with
//    the lock its own UPDATE takes (FOR NO KEY UPDATE), not FOR SHARE: two presses that each held it FOR SHARE and
//    then updated it would each wait for the other.
//  - Each flag says which channels it accepts (`channels`), and any other is refused before anything else. The
//    permission is only checked for staff, so a flag that never said "customer" must not run for one.
import 'server-only'
import type { AdminAction } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, SqlParam, Tx } from '@/server/db'
import type { ApiError } from '@/server/http/errors'
import { adminRefusal, requireAdminPermission, type AdminActor, type AdminNeeds } from './refusal'

/**
 * Who sets a flag. A staff member on every route there is today. W50 (brief item 7; lead call L13): the rule code
 * also takes the website's signed-in customer (a waiver signed from their own account), so the audit row says who;
 * no customer route exists yet.
 */
export type FlagActor = AdminActor | { type: 'customer'; id: string }

/** Where a flag is set from: the staff app (`staff`) or the website's signed-in customer (`customer`). The actor's type. */
export type FlagChannel = FlagActor['type']

/**
 * W50a (W50 review L6b): what a flag answers when it is pressed from a channel it doesn't accept (reason
 * `channel_not_accepted`). Nobody sees it today: only a waiver accepts a customer, and no customer route exists.
 */
export const FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE = "This can't be changed from here."

export interface FlagWriteOptions {
  actor: FlagActor
  requestId: string
  /** The call's own key: the route's Idempotency-Key (a switch sends a new one for each call, lead call L12). */
  pressKey: string | null
}

export interface FlagWrite<Row> {
  action: AdminAction
  /** Any active staff member for every flag today (G-plan 4.6); the route's own staff check has already made that. */
  needs: AdminNeeds
  /**
   * W50a (W50 review L6b): the channels this flag may be set from. An actor of any other is refused at the start,
   * before the key, the permission or any statement. `['staff']` for every flag but a guest's waiver.
   */
  channels: readonly FlagChannel[]
  entity: { type: string; id: string }
  /**
   * W50 (W48 review L2): a row of another table that the guard reads, locked FOR SHARE in its own statement before
   * the flag's statement (see the top of this file). The statement must lock at most the one row (`FOR SHARE OF …`),
   * in LOCK_ORDER's place for it: nothing else is locked before the flag's own row. Left out when the guard reads
   * only the row it updates. W50a: when the guard reads another table about the flag's own row, this holds that row
   * itself, `FOR NO KEY UPDATE` (the lock its UPDATE takes).
   */
  holdFirst?: { sql: string; params: readonly SqlParam[] }
  /**
   * The one statement: an UPDATE whose WHERE is the rule (the booking isn't cancelled, the check-in window is open,
   * the place isn't cancelled…) and whose RETURNING is the row as it is now. It answers no row when the guard refuses.
   */
  statement: { sql: string; params: readonly SqlParam[] }
  /** Why the guard refused, read in the same transaction: the refusal to throw, in the old words. */
  refusal(tx: Tx): Promise<ApiError>
  /** What the audit row keeps of the row (the flag as set, who by, the method). Default: the whole row returned. */
  recorded?(row: Row): Readonly<Record<string, unknown>>
  /** W50: what else the audit row says beside `after` and the key (which way a switch was pressed, the channel). */
  details?: Readonly<Record<string, unknown>>
}

/**
 * Sets or clears one flag:
 *  0. the channel must be one the flag accepts (W50a): a customer on a staff-only flag is refused here;
 *  1. the call's key must be there (an idempotent route);
 *  2. the permission, in the old words (a staff member's; a customer has none to check: the rule's guard is theirs);
 *  3. one transaction: the other table's row held FOR SHARE when the guard reads one (W50); the guarded statement;
 *     no row means the guard refused, and the reason is read and thrown, so nothing is kept; a row means the flag is
 *     as asked, and one audit row says who set it.
 */
export async function flagWrite<Row extends Record<string, unknown>>(db: Db, write: FlagWrite<Row>, options: FlagWriteOptions): Promise<Row> {
  if (!write.channels.includes(options.actor.type)) throw adminRefusal('FORBIDDEN', write.action, 'channel_not_accepted', FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE)
  if (!options.pressKey) throw new Error(`The flag write ${write.action} was run without a key: its route must be idempotent.`)
  const pressKey = options.pressKey
  if (options.actor.type === 'staff') requireAdminPermission(options.actor, write.needs, write.action)

  return db.transaction(async (tx) => {
    if (write.holdFirst) await tx.query(write.holdFirst.sql, write.holdFirst.params)
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
      details: { ...write.details, after: write.recorded ? write.recorded(row) : row, key: pressKey },
    })
    return row
  })
}
