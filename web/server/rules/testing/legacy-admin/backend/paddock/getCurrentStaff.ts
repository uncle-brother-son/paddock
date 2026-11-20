import { getStaffRowAnyStatus, type StaffAccessRow } from './shared/staffAccess'

/**
 * The logged-in user's own staff row (role + permission flags), or null when they are not
 * provisioned as staff. An inactive member's row comes back too, with active false, so the screen
 * can say the account is inactive instead of treating them as unknown. Drives UI gating: hiding the Staff menu item and page for non-admins,
 * disabling refund buttons without can_issue_refunds, and making checkout line prices read-only
 * without can_manage_pricing. The same rules are re-enforced server-side on every write.
 */
export default async function getCurrentStaff(req: { user: User }): Promise<StaffAccessRow | null> {
  return getStaffRowAnyStatus(req.user.email)
}
