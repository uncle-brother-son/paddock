// New in W48 (G-plan 4.2, level B; brief W48 item 3): the one shape every step G admin write has. One transaction
// under the row's lock, holding the change and an audit row with the row before and after; the permission from the
// signed-in staff member, in the old words; and the press's key, so a press made twice acts once. No Stripe: nothing
// here can be held or left. No route calls it until W49.
import 'server-only'
import type { AdminAction } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Tx } from '@/server/db'
import { lockAdminRows, type AdminLock, type HeldAdminLocks } from './locks'
import { adminRefusal, requireAdminPermission, type AdminActor, type AdminNeeds } from './refusal'
import { CHANGED_SINCE_REASON, CHANGED_SINCE_WORDS, sameStamp } from './stamp'

export interface AdminWriteOptions {
  actor: AdminActor
  requestId: string
  /**
   * The press's own key: the route's Idempotency-Key. A step G write is only ever run by an idempotent route, which
   * answers a repeated key from the stored answer without running this again; a write with no key is a route built
   * wrongly, and is refused before anything is read.
   */
  pressKey: string | null
}

/**
 * W54a (the step G rule; W49 + W54 review S1): what a write that sends a whole row back says about the row it read.
 * `seen` is the stamp the press sent, as the screen's read answered it (admin/stamp.ts); `now` reads the row's stamp
 * as it is under the locks. They must be the same, or the press is refused `changed_since` and nothing is written.
 */
export interface UnchangedSince<Before> {
  /** What the press sent. Anything: a press with no stamp (an older screen) is refused like a stale one. */
  seen: unknown
  /** The row's stamp now, read in its own statement after the locks and after `before`. */
  now(tx: Tx, before: Before, held: HeldAdminLocks): Promise<string>
}

/**
 * For a write that puts back nothing the screen read: a new row, or one value set (a band's price, a switch). Such
 * a press can only write what was pressed, so a stale page can't undo anyone else's change with it.
 */
export const WRITES_ONLY_WHAT_WAS_PRESSED = 'writes_only_what_was_pressed'

export interface AdminWrite<Before, After, Answer> {
  /** What is recorded: an audit action (`catalog.price_set`), which also names the action in a refusal. */
  action: AdminAction
  needs: AdminNeeds
  /** What the audit row is about: the row edited (or, for a new row, set by `change`'s `entityId`). */
  entity: { type: string; id: string }
  /** The rows to lock, taken in LOCK_ORDER before anything is read. */
  locks: readonly AdminLock[]
  /**
   * W54a: every write says which it is, so a new one can't leave the question out. A write that sends a whole row
   * (or a whole day's rows) back as the screen showed it gives the stamp the press sent and how to read the row's
   * stamp now; a write that only sets what was pressed says WRITES_ONLY_WHAT_WAS_PRESSED.
   */
  unchangedSince: UnchangedSince<Before> | typeof WRITES_ONLY_WHAT_WAS_PRESSED
  /**
   * The row as it is, read in its own statement after the locks (a statement that waited for a lock still sees what
   * it saw before waiting). Throws the action's own refusal when the row isn't there.
   */
  before(tx: Tx, held: HeldAdminLocks): Promise<Before>
  /**
   * The old checks, each a thrown refusal in the old words, then the change. Answers the row as it is now and what
   * staff are told. `details` adds to the audit row (a count shown before the press, a reason).
   */
  change(tx: Tx, before: Before, held: HeldAdminLocks): Promise<{ after: After; answer: Answer; entityId?: string; details?: Readonly<Record<string, unknown>> }>
}

/**
 * Runs one admin write:
 *  1. the press's key must be there (an idempotent route);
 *  2. the permission, from the signed-in staff member, in the old words: refused before anything is read;
 *  3. one transaction: the locks in LOCK_ORDER, the row read, the stamp the press sent against the row's stamp now
 *     (W54a: a row changed since the screen read it is refused `changed_since`, before any other check of the
 *     change), the old checks and the change, and one audit row with who, the row before and after, and the key.
 * A refusal anywhere is a throw, so nothing of it is kept: no change, no audit row.
 */
export async function adminWrite<Before, After, Answer>(db: Db, write: AdminWrite<Before, After, Answer>, options: AdminWriteOptions): Promise<Answer> {
  if (!options.pressKey) throw new Error(`The admin write ${write.action} was run without a press key: its route must be idempotent.`)
  const pressKey = options.pressKey
  requireAdminPermission(options.actor, write.needs, write.action)

  return db.transaction(async (tx) => {
    const held = await lockAdminRows(tx, write.locks)
    const before = await write.before(tx, held)
    if (write.unchangedSince !== WRITES_ONLY_WHAT_WAS_PRESSED) {
      const now = await write.unchangedSince.now(tx, before, held)
      if (!sameStamp(write.unchangedSince.seen, now)) throw adminRefusal('CONFLICT', write.action, CHANGED_SINCE_REASON, CHANGED_SINCE_WORDS)
    }
    const { after, answer, entityId, details } = await write.change(tx, before, held)
    await audit.record(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: write.action,
      entityType: write.entity.type,
      entityId: entityId ?? write.entity.id,
      requestId: options.requestId,
      details: { ...details, before, after, key: pressKey },
    })
    return answer
  })
}
