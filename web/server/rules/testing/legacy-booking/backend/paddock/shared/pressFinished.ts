/**
 * A press's own mark inside its final statement, for Move, Settle and Add Guest when no card was
 * charged (a card charge has its own finished row, CHARGE_FINISHED_AUDIT in bookingCardCharge.ts).
 *
 * A statement can write and lose its answer on the way back. Undoing then would put back the gift
 * card, store credit, credits and places of a change that stands. So each such press gives its
 * statement a new id, the statement writes a 'booking.press_finished' row carrying it (only when it
 * wrote the booking), and a press whose statement threw looks for that row before undoing anything.
 * Found: the write landed, so the press carries on as if the answer had come back, with the ids the
 * row kept. Not found: nothing was written, and the press undoes as before.
 *
 * Only the three write functions import this (its statement text writes).
 */

/** The row, as a CTE of a final statement whose booking CTE is `bk`. `details` is a jsonb
 *  expression that must include the press id under 'press'; `actor` and `when` are placeholders. */
export const PRESS_FINISHED_AUDIT = (actor: string, details: string, when: string) => `press_finished AS (
       INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       SELECT 'staff', ${actor}, 'booking.press_finished', 'booking', bk.id::text, ${details} FROM bk WHERE ${when}
       RETURNING id
     )`

/** A new id for one press's statement. */
export function newPressId(): string {
  return crypto.randomUUID()
}

/** The details of this press's finished row, or null when its statement wrote nothing. Throws if it
 *  can't look: the caller must then neither undo nor say it worked. */
export async function findPressFinished(bookingId: string, pressId: string): Promise<Record<string, unknown> | null> {
  const found = await paddockData.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log
     WHERE action = 'booking.press_finished' AND entity_type = 'booking' AND entity_id = $1 AND details->>'press' = $2
     LIMIT 1`,
    [bookingId, pressId]
  )
  return found.data[0]?.details ?? null
}

/** A string id kept in the row's details, or null. */
export function detailId(details: Record<string, unknown>, key: string): string | null {
  const value = details[key]
  return typeof value === 'string' ? value : null
}
