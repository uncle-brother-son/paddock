// Brief W48 item 1 (G-plan 4.1): the words of the staff list and who may do what (W49), and the three access checks
// every other step G action shares, moved word for word from the staff app's old
// functions as they were at W48. Each action that moved (W49 to W57) answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts holds this file to the old
// sentences (read from the old code with the TypeScript parser, pinned in testing/old-words.json), both ways. A sentence that takes a value is a
// function of it. Not here, on purpose (the same test holds that they stay out): the plumbing between Retool and
// the legacy routes ("returned an HTML page", "Unauthorized", "Missing required fields", "Internal server
// error", the fallbacks for an error with no words) and "saved but could not be read back", which one transaction
// can't leave.

export const STAFF_ADMIN_WORDS = {
  /** staffAccess */
  staffAccess: {
    staffAccountInactiveAskAdminReactivate: 'This staff account is inactive. Ask an admin to reactivate it.',
    thereMustAlwaysAtLeastOne: 'There must always be at least one active admin. Make someone else an active admin first.',
    noStaffRecordMatchesLoggedIn: (first: unknown): string => `No staff record matches the logged-in user's email (${String(first)}). Ask an admin to add you as staff before performing this action.`,
    adminsOnlyActionRequiresAdminRole: 'Admins only — this action requires the admin role.',
  },
  /** resolveStaffId */
  resolveStaffId: {
    noStaffRecordMatchesLoggedIn: (first: unknown): string => `No staff record matches the logged-in user's email (${String(first)}). Ask an admin to add you as staff before performing this action.`,
  },
  /** pricingStaff */
  pricingStaff: {
    noStaffRecordMatchesLoggedIn: (first: unknown): string => `No staff record matches the logged-in user's email (${String(first)}). Ask an admin to add you as staff before managing pricing.`,
    youDoNotHavePermissionManage: 'You do not have permission to manage pricing (staff.can_manage_pricing is off for your account).',
  },
  /** createStaff */
  createStaff: {
    firstNameRequired: 'First name is required',
    lastNameRequired: 'Last name is required',
    validEmailAddressRequired: 'A valid email address is required',
    invalidRole: (first: unknown): string => `Invalid role: ${String(first)}`,
    staffMemberWithEmailAddressAlready: 'A staff member with this email address already exists',
  },
  /** setStaffRole */
  setStaffRole: {
    invalidRole: (first: unknown): string => `Invalid role: ${String(first)}`,
  },
  /** setStaffPermission */
  setStaffPermission: {
    invalidField: (first: unknown): string => `Invalid field: ${String(first)}`,
  },
  /** setStaffCanManagePricing */
  setStaffCanManagePricing: {
    staffMemberNotFound: 'Staff member not found.',
    cannotRemovePricingPermissionLastStaff: 'Cannot remove pricing permission: this is the last staff member with can_manage_pricing enabled. Grant it to another staff member first.',
  },
} as const
