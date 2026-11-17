// New in W40d (W40c review S2): the two legacy membership routes (app/api/memberships/cancel and undo-cancel, which
// stay until W44) protect themselves from the new screen's check.
//
// A cancel or undo made through the new screen leaves a Stripe step, and every step that closes is checked against
// Stripe 20 minutes later (left.ts). A legacy change made inside that time is not a step: to the check it looks like
// a stale send, and the check would put the step's wish back over it (an undo over a legacy cancel keeps charging a
// member staff cancelled). Reconcile and the check never ask the switch, so this holds after a rollback with
// `membership_changes` off too. So each legacy route asks here first, before it reads or sends anything, and refuses
// while the membership has a step that is open, or closed and not yet checked.
//
// Here, not in the routes' core.ts files: those are frozen with the test-only copy (frozen-account-code.test.ts).
import 'server-only'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { LEGACY_MEMBERSHIP_CHANGE_HELD_MESSAGE } from './failure-messages'
import { stepsUnsettled } from './left'

/**
 * The words to refuse a legacy cancel or undo with (409), or null when it may go ahead. A read that fails throws: the
 * route answers 500 and changes nothing.
 */
export async function legacyMembershipChangeHeld(membershipId: unknown): Promise<string | null> {
  const db = openRequestDb()
  try {
    return (await stepsUnsettled(db, String(membershipId))) ? LEGACY_MEMBERSHIP_CHANGE_HELD_MESSAGE : null
  } finally {
    await closeRequestDb(db)
  }
}
