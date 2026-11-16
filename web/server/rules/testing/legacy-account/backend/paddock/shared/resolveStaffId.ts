/**
 * Resolves the acting staff member's staff.id for the logged-in Retool user, by matching
 * their email directly against the staff table (staff now has its own first_name, last_name,
 * and email columns — it is not linked to a customer record).
 *
 * Returns null if no matching staff record exists (e.g. the user isn't provisioned as staff), and
 * throws the inactive refusal for an inactive staff member. Because it can throw, call it at the
 * start of a function, never between a money movement and its reversal.
 * Every FK column that records the acting staff member (sessions.blocked_by,
 * membership_credit_adjustments.staff_id, addon_order_lines.prepared_by,
 * gift_cards.picked_up_by) references staff(id) directly.
 */
// The runtime globals (paddockData) are typed by the generated declarations in
// backend/resources/; ../globals.ts is now an empty module, kept so this import stays valid.
import '../globals'
import { refuseIfInactive } from './staffAccess'

export async function resolveStaffId(userEmail: string): Promise<string | null> {
  const staffLookup = await paddockData.query<{ id: string }>(
    `SELECT id FROM staff WHERE email = $1 AND active = true LIMIT 1`,
    [userEmail]
  )
  const staff = staffLookup.data[0]
  if (!staff) await refuseIfInactive(userEmail)
  return staff?.id ?? null
}

/**
 * Same lookup as `resolveStaffId`, but throws instead of returning null when the logged-in
 * Retool user has no matching staff record. Use this anywhere staff attribution is mandatory
 * (blocking a slot, adjusting membership credits, marking an add-on prepared or a gift card
 * picked up, etc.) so the action fails loudly rather than silently recording no attribution.
 */
export async function requireStaffId(userEmail: string): Promise<string> {
  const staffId = await resolveStaffId(userEmail)
  if (!staffId) {
    throw new Error(
      `No staff record matches the logged-in user's email (${userEmail}). Ask an admin to add you as staff before performing this action.`
    )
  }
  return staffId
}
