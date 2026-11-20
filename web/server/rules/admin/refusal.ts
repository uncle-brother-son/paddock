// New in W48 (G-plan 4.2 item 1): how every step G action refuses, and who is acting. An ApiError whose `details`
// carry the old reason (or a new one, where the old function gave only words), the words staff see and the action,
// as adminRefusalDetailsSchema, so the staff app's thin wrappers put the old result shapes back.
import 'server-only'
import type { AdminRefusalDetails, ApiErrorCode, StaffContext } from '@/contracts'
import { ApiError } from '@/server/http/errors'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'

/**
 * Who is acting on a step G route: the signed-in staff member as the route's own staff check read them (an active
 * staff member, or the route refused before the rule ran), with the switches the rule decides from. Never taken from
 * what the screen sends.
 */
export interface AdminActor {
  type: 'staff'
  id: string
  role: StaffContext['role']
  canManagePricing: boolean
  canIssueRefunds: boolean
}

export const adminActor = (staff: StaffContext): AdminActor => ({ type: 'staff', id: staff.id, role: staff.role, canManagePricing: staff.canManagePricing, canIssueRefunds: staff.canIssueRefunds })

/** What an action needs from the staff member (G-plan 4.6): the admin role, Manage pricing, or only to be an active staff member. */
export type AdminNeeds = 'admin' | 'manage_pricing' | 'staff'

export function adminRefusal(code: ApiErrorCode, action: string, reason: string, message: string, extras: { field?: string } = {}): ApiError {
  const details: AdminRefusalDetails = { reason, message, action }
  return new ApiError(code, message, { ...extras, details })
}

/**
 * The permission, from the signed-in staff member, in the old words (the staff app's shared/staffAccess.ts and
 * shared/pricingStaff.ts): thrown before anything is read or locked, so a refusal leaves nothing. `staff` needs
 * nothing more than the route's own check has already made.
 */
export function requireAdminPermission(actor: AdminActor, needs: AdminNeeds, action: string): void {
  if (needs === 'admin' && actor.role !== 'admin') throw adminRefusal('FORBIDDEN', action, 'admins_only', STAFF_ADMIN_WORDS.staffAccess.adminsOnlyActionRequiresAdminRole)
  if (needs === 'manage_pricing' && !actor.canManagePricing) throw adminRefusal('FORBIDDEN', action, 'no_pricing_permission', STAFF_ADMIN_WORDS.pricingStaff.youDoNotHavePermissionManage)
}
