// W49 (G-plan 1.8, 4.1, 4.3, 4.6; bug GB16; lead calls L10 and L11): the Staff page on the Worker. Ported from the
// staff app's getCurrentStaff.ts, getStaff.ts, createStaff.ts, setStaffRole.ts, setStaffPermission.ts and
// setStaffCanManagePricing.ts (as they were at W48), with their words (./failure-messages.ts).
//
// What GB16 changes. Every staff change is one transaction under the staff table's guard (every staff row, locked
// in id order: admin/locks.ts, EVERY_ROW), so two admins pressing at once take turns, and "keep one active admin" and
// "keep one active Manage pricing holder" are each decided from what the one before left. The old "last Manage
// pricing holder" check was a read, then a write, so two admins could each take the other's and leave nobody. Each
// change writes an audit row (who, the staff member's role and switches before and after, the press's key): the old
// functions recorded nobody. The sign-in email is compared in lower case (server/auth/staff.ts).
import 'server-only'
import type { AdminAction, AdminCreateStaffOutput, AdminGetCurrentStaffOutput, AdminGetStaffOutput, StaffCreateRouteInput, StaffPermissionRouteOutput, StaffRole, StaffRoleRouteOutput } from '@/contracts'
import { postgresRefusal, type Db, type Queryable, type Tx } from '@/server/db'
import type { ApiError } from '@/server/http/errors'
import { EVERY_ROW, isUuid } from '@/server/rules/admin/locks'
import { adminRead, ownStaffRow } from '@/server/rules/admin/read'
import { adminRefusal, requireAdminPermission, type AdminActor } from '@/server/rules/admin/refusal'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWriteOptions } from '@/server/rules/admin/write'
import { STAFF_ADMIN_WORDS } from './failure-messages'

const ROLES: readonly StaffRole[] = ['admin', 'manager', 'staff']
const isRole = (value: unknown): value is StaffRole => ROLES.includes(value as StaffRole)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : String(value))

/** The staff table's guard: every staff change holds it, so the two "keep one" rules are decided one press at a time. */
const STAFF_GUARD = [{ table: 'staff', ids: EVERY_ROW }] as const

/** What an audit row keeps of a staff member: the role and the three switches. Never a name or an email. */
interface StaffState {
  role: StaffRole
  can_issue_refunds: boolean | null
  can_manage_pricing: boolean | null
  active: boolean | null
}

const notFound = (action: AdminAction): ApiError => adminRefusal('NOT_FOUND', action, 'staff_not_found', STAFF_ADMIN_WORDS.setStaffCanManagePricing.staffMemberNotFound)
const lastActiveAdmin = (action: AdminAction): ApiError => adminRefusal('CONFLICT', action, 'last_active_admin', STAFF_ADMIN_WORDS.staffAccess.thereMustAlwaysAtLeastOne)
const lastPricingHolder = (action: AdminAction): ApiError => adminRefusal('CONFLICT', action, 'last_pricing_holder', STAFF_ADMIN_WORDS.setStaffCanManagePricing.cannotRemovePricingPermissionLastStaff)

/** The staff member as they are, read under the guard. An id that names nobody is the action's "not found". */
async function staffState(tx: Tx, staffId: string, action: AdminAction): Promise<StaffState> {
  if (!isUuid(staffId)) throw notFound(action)
  const [row] = await tx.query<StaffState>('SELECT role, can_issue_refunds, can_manage_pricing, active FROM staff WHERE id = $1::uuid', [staffId])
  if (!row) throw notFound(action)
  return row
}

/** Read under the guard, so the count is what the press before this one left. */
async function otherActiveAdmins(tx: Tx, staffId: string): Promise<number> {
  const [row] = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM staff WHERE role = 'admin' AND active = true AND id <> $1::uuid", [staffId])
  return row?.n ?? 0
}
async function otherActivePricingHolders(tx: Tx, staffId: string): Promise<number> {
  const [row] = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM staff WHERE can_manage_pricing = true AND active = true AND id <> $1::uuid', [staffId])
  return row?.n ?? 0
}

/**
 * getCurrentStaff (`GET staff/me`, lead call L10): the signed-in user's own staff row whether active or not, so the
 * screen can say the account is inactive, and null for a sign-in with no staff row. The one staff route an inactive
 * member reaches; it answers their own row and nothing else.
 */
export const getOwnStaffRow = (db: Queryable, signInEmail: string): Promise<AdminGetCurrentStaffOutput> => ownStaffRow(db, signInEmail)

const STAFF_LIST_SQL = `
SELECT s.id, s.first_name, s.last_name, s.email, s.role, s.can_issue_refunds, s.can_manage_pricing, s.active, s.created_at, s.updated_at
  FROM staff s
 ORDER BY s.role, s.first_name, s.last_name, s.id`

/** getStaff (`GET staff`): the staff list, for admins only, in the old words. */
export function listStaff(db: Queryable, actor: AdminActor): Promise<AdminGetStaffOutput> {
  return adminRead<AdminGetStaffOutput[number]>(db, { name: 'staff.list', needs: 'admin', sql: STAFF_LIST_SQL, times: ['created_at', 'updated_at'] }, { actor })
}

const duplicateEmail = (): ApiError => adminRefusal('CONFLICT', 'staff.created', 'duplicate_email', STAFF_ADMIN_WORDS.createStaff.staffMemberWithEmailAddressAlready, { field: 'email' })

const INSERT_STAFF_SQL = `
INSERT INTO staff (first_name, last_name, email, role, can_issue_refunds, active)
VALUES ($1, $2, $3, $4, $5, true)
RETURNING id, first_name, last_name, email, role, can_issue_refunds, can_manage_pricing, active, created_at, updated_at`

type CreatedStaffRow = Omit<AdminCreateStaffOutput, 'created_at' | 'updated_at'> & { created_at: Date | string; updated_at: Date | string }

/**
 * createStaff (`POST staff`). Admins only; then the old checks in the old order and words (each name trimmed, the
 * email trimmed and lower-cased); then, under the guard: an email already on file in any case is refused (GB16: the
 * old function relied on the table's case-sensitive key, so a row stored with a capital could be added again in
 * lower case, and one sign-in would then match two rows), the row, and a `staff.created` audit row. Two creates of one
 * email at once queue on the guard; the table's own key is still there behind it and is answered as the same refusal.
 * A new member never has Manage pricing (the column's default), as before.
 */
export async function createStaff(db: Db, input: StaffCreateRouteInput, options: AdminWriteOptions): Promise<AdminCreateStaffOutput> {
  const action = 'staff.created'
  requireAdminPermission(options.actor, 'admin', action)
  const firstName = trimmed(input.firstName)
  const lastName = trimmed(input.lastName)
  const email = trimmed(input.email).toLowerCase()
  const role = input.role
  const invalid = (reason: string, message: string, field: string) => adminRefusal('VALIDATION', action, reason, message, { field })
  if (!firstName) throw invalid('first_name_required', STAFF_ADMIN_WORDS.createStaff.firstNameRequired, 'firstName')
  if (!lastName) throw invalid('last_name_required', STAFF_ADMIN_WORDS.createStaff.lastNameRequired, 'lastName')
  if (!email || !EMAIL_PATTERN.test(email)) throw invalid('email_invalid', STAFF_ADMIN_WORDS.createStaff.validEmailAddressRequired, 'email')
  if (!isRole(role)) throw invalid('invalid_role', STAFF_ADMIN_WORDS.createStaff.invalidRole(role), 'role')

  try {
    return await adminWrite<null, StaffState, AdminCreateStaffOutput>(
      db,
      {
        action,
        needs: 'admin',
        entity: { type: 'staff', id: '' },
        locks: STAFF_GUARD,
        // W54a: a new row. There is nothing the screen read that this could put back.
        unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
        before: async () => null,
        async change(tx) {
          const [taken] = await tx.query<{ taken: number }>('SELECT 1 AS taken FROM staff WHERE lower(email) = $1 LIMIT 1', [email])
          if (taken) throw duplicateEmail()
          const [row] = await tx.query<CreatedStaffRow>(INSERT_STAFF_SQL, [firstName, lastName, email, role, input.canIssueRefunds === true])
          if (!row) throw new Error('The staff member was not written.')
          const after: StaffState = { role: row.role, can_issue_refunds: row.can_issue_refunds, can_manage_pricing: row.can_manage_pricing, active: row.active }
          return { after, answer: { ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at) }, entityId: row.id }
        },
      },
      options
    )
  } catch (err) {
    // The transaction has rolled back. The table's own key on the email stopped it: the same refusal, never a fault.
    const refused = postgresRefusal(err)
    if (refused?.code === '23505' && (refused.constraint === 'staff_email_key' || refused.message.includes('staff_email_key'))) throw duplicateEmail()
    throw err
  }
}

/**
 * setStaffRole (`POST staff/:staffId/role`). Admins only; a role that isn't one is refused in the old words; then
 * under the guard: a staff member who isn't there is refused (the staff app's function answers null, as before);
 * taking the admin role from the last active admin is refused in the old words, decided from the count read under
 * the guard (the old function decided it inside one statement, which was already safe: this keeps it so beside
 * the other staff changes); the role, and a `staff.role_set` audit row.
 */
export async function setStaffRole(db: Db, staffId: string, role: unknown, options: AdminWriteOptions): Promise<StaffRoleRouteOutput> {
  const action = 'staff.role_set'
  requireAdminPermission(options.actor, 'admin', action)
  if (!isRole(role)) throw adminRefusal('VALIDATION', action, 'invalid_role', STAFF_ADMIN_WORDS.setStaffRole.invalidRole(role), { field: 'role' })
  return adminWrite<StaffState, StaffState, StaffRoleRouteOutput>(
    db,
    {
      action,
      needs: 'admin',
      entity: { type: 'staff', id: staffId },
      locks: STAFF_GUARD,
      // W54a: one value, the role chosen. Nothing else of the row is sent, so a stale page can't put anything back.
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      before: (tx) => staffState(tx, staffId, action),
      async change(tx, before) {
        if (role !== 'admin' && before.role === 'admin' && before.active === true && (await otherActiveAdmins(tx, staffId)) === 0) throw lastActiveAdmin(action)
        const [row] = await tx.query<StaffRoleRouteOutput>('UPDATE staff SET role = $1, updated_at = now() WHERE id = $2::uuid RETURNING id, role', [role, staffId])
        if (!row) throw new Error('The staff member was held but not updated.')
        return { after: { ...before, role: row.role }, answer: row }
      },
    },
    options
  )
}

/** The three switches `POST staff/:staffId/permissions` sets, by column. */
export type StaffSwitch = 'can_issue_refunds' | 'can_manage_pricing' | 'active'
const isStaffSwitch = (value: unknown): value is StaffSwitch => value === 'can_issue_refunds' || value === 'can_manage_pricing' || value === 'active'

/** One statement for each switch: the column is a literal here, never a value from a request. */
const SET_SWITCH_SQL: Record<StaffSwitch, string> = {
  can_issue_refunds: 'UPDATE staff SET can_issue_refunds = $1, updated_at = now() WHERE id = $2::uuid RETURNING id, can_issue_refunds AS value',
  can_manage_pricing: 'UPDATE staff SET can_manage_pricing = $1, updated_at = now() WHERE id = $2::uuid RETURNING id, can_manage_pricing AS value',
  active: 'UPDATE staff SET active = $1, updated_at = now() WHERE id = $2::uuid RETURNING id, active AS value',
}

/**
 * setStaffPermission and setStaffCanManagePricing (`POST staff/:staffId/permissions`): one switch a press. Admins
 * only; a switch that isn't one of the three is refused in the old words; then under the guard:
 *  - a staff member who isn't there is refused;
 *  - switching off the last active admin is refused, in the old words;
 *  - taking Manage pricing from someone who has it, when no other active staff member has it, is refused in the old
 *    words (GB16: the old check was a read then a write, and two admins could each take the other's);
 *  - switching off the last active staff member who has Manage pricing is refused, in the same words: the old
 *    functions let that through, which left nobody able to change a price ("keep one active Manage pricing holder");
 *  - the switch, and a `staff.permission_set` audit row.
 */
export async function setStaffPermission(db: Db, staffId: string, field: unknown, value: boolean, options: AdminWriteOptions): Promise<StaffPermissionRouteOutput> {
  const action = 'staff.permission_set'
  requireAdminPermission(options.actor, 'admin', action)
  if (!isStaffSwitch(field)) throw adminRefusal('VALIDATION', action, 'invalid_field', STAFF_ADMIN_WORDS.setStaffPermission.invalidField(field), { field: 'field' })
  return adminWrite<StaffState, StaffState, StaffPermissionRouteOutput>(
    db,
    {
      action,
      needs: 'admin',
      entity: { type: 'staff', id: staffId },
      locks: STAFF_GUARD,
      // W54a: one switch a press, set to the value pressed. Nothing else of the row is sent.
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      before: (tx) => staffState(tx, staffId, action),
      async change(tx, before) {
        if (field === 'active' && !value && before.active === true) {
          if (before.role === 'admin' && (await otherActiveAdmins(tx, staffId)) === 0) throw lastActiveAdmin(action)
          if (before.can_manage_pricing === true && (await otherActivePricingHolders(tx, staffId)) === 0) throw lastPricingHolder(action)
        }
        if (field === 'can_manage_pricing' && !value && before.can_manage_pricing === true && (await otherActivePricingHolders(tx, staffId)) === 0) throw lastPricingHolder(action)
        const [row] = await tx.query<{ id: string; value: boolean }>(SET_SWITCH_SQL[field], [value, staffId])
        if (!row) throw new Error('The staff member was held but not updated.')
        return { after: { ...before, [field]: row.value }, answer: { id: row.id, [field]: row.value }, details: { field } }
      },
    },
    options
  )
}
