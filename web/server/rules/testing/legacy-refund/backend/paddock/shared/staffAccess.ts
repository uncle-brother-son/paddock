/**
 * Staff access guards, resolving the acting staff member from the logged-in Retool user's
 * email exactly as resolveStaffId does (staff.email = user.email, no other linkage).
 *
 *  - requireStaffAdmin:    only role = 'admin' may open the staff directory, add staff, or
 *                          change any role/permission switch (enforced server-side on every
 *                          staff write, not just in the UI).
 *  - requireCanIssueRefunds: only staff with can_issue_refunds may move money back to a
 *                          customer (card reversal or store credit) via any booking refund
 *                          action — Cancel & Refund, a Move's difference refund, or a Remove
 *                          guest refund. Cancel & return credit and plain Cancel booking move
 *                          no money and stay open to all staff.
 */
export interface StaffAccessRow {
  id: string
  email: string
  role: 'admin' | 'manager' | 'staff'
  can_issue_refunds: boolean | null
  can_manage_pricing: boolean | null
  active: boolean | null
}

/** The same wording as the Worker's staff auth (server/auth/staff.ts). */
export const INACTIVE_STAFF_MESSAGE = 'This staff account is inactive. Ask an admin to reactivate it.'

/**
 * Every staff lookup filters on `active = true`, so "no row" can mean unknown or inactive. Called
 * when that lookup found nothing: throws the inactive refusal if the email has a staff row at all,
 * so an inactive member never looks like an unknown user (or carries on unattributed).
 */
export async function refuseIfInactive(userEmail: string): Promise<void> {
  const lookup = await paddockData.query<{ id: string }>('SELECT id FROM staff WHERE email = $1 LIMIT 1', [userEmail])
  if (lookup.data.length > 0) throw new Error(INACTIVE_STAFF_MESSAGE)
}

/** The caller's staff row, or null when the logged-in user is not provisioned as staff. Throws
 *  the inactive refusal for an inactive staff member. */
export async function getStaffAccessRow(userEmail: string): Promise<StaffAccessRow | null> {
  const lookup = await paddockData.query<StaffAccessRow>(
    'SELECT id, email, role, can_issue_refunds, can_manage_pricing, active FROM staff WHERE email = $1 AND active = true LIMIT 1',
    [userEmail]
  )
  const staff = lookup.data[0]
  if (!staff) await refuseIfInactive(userEmail)
  return staff ?? null
}

/** The caller's staff row whether active or not, for getCurrentStaff alone: the screen needs to
 *  know the account is inactive so it can say so. Never use this for a permission check. */
export async function getStaffRowAnyStatus(userEmail: string): Promise<StaffAccessRow | null> {
  const lookup = await paddockData.query<StaffAccessRow>(
    'SELECT id, email, role, can_issue_refunds, can_manage_pricing, active FROM staff WHERE email = $1 LIMIT 1',
    [userEmail]
  )
  return lookup.data[0] ?? null
}

export const LAST_ACTIVE_ADMIN_MESSAGE = 'There must always be at least one active admin. Make someone else an active admin first.'

/**
 * Called when a guarded update of a staff member's role or active switch changed no row: a row
 * that exists means the guard stopped it. A missing row returns, for the caller's "not found".
 */
export async function refuseIfStaffExists(staffId: string): Promise<void> {
  const lookup = await paddockData.query<{ id: string }>('SELECT id FROM staff WHERE id = $1', [staffId])
  if (lookup.data.length > 0) throw new Error(LAST_ACTIVE_ADMIN_MESSAGE)
}

/** Throws unless the caller is a provisioned staff member with role = admin. */
export async function requireStaffAdmin(userEmail: string): Promise<void> {
  const staff = await getStaffAccessRow(userEmail)
  if (!staff) {
    throw new Error(
      `No staff record matches the logged-in user's email (${userEmail}). Ask an admin to add you as staff before performing this action.`
    )
  }
  if (staff.role !== 'admin') {
    throw new Error('Admins only — this action requires the admin role.')
  }
}

/** Throws unless the caller is provisioned staff with can_issue_refunds = true. */
export async function requireCanIssueRefunds(userEmail: string): Promise<void> {
  const staff = await getStaffAccessRow(userEmail)
  if (!staff) {
    throw new Error(
      `No staff record matches the logged-in user's email (${userEmail}). Ask an admin to add you as staff before performing this action.`
    )
  }
  if (!staff.can_issue_refunds) {
    throw new Error('Needs Issue refunds permission — this action moves money back to the customer.')
  }
}
