import { refuseIfStaffExists, requireStaffAdmin } from './shared/staffAccess'

export type StaffRole = 'admin' | 'manager' | 'staff'

const VALID_ROLES: StaffRole[] = ['admin', 'manager', 'staff']

export interface SetStaffRoleParams {
  staffId: string
  role: StaffRole
}

export default async function setStaffRole(req: { params: SetStaffRoleParams; user: User }) {
  const { staffId, role } = req.params

  // Admins only — only role = admin may change anyone's role.
  await requireStaffAdmin(req.user.email)

  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`)
  }

  if (role === 'admin') {
    const result = await paddockData.query(
      `UPDATE staff SET role = 'admin', updated_at = now() WHERE id = $1 RETURNING id, role`,
      [staffId]
    )
    return result.data[0] ?? null
  }

  // Never leave no active admin. One statement that locks every active admin row first, so two
  // admins demoting each other at once queue up and the second sees the first's change.
  const result = await paddockData.query(
    `WITH active_admins AS (
       SELECT id FROM staff WHERE role = 'admin' AND active = true ORDER BY id FOR UPDATE
     ), other_admins AS (
       SELECT count(*) AS n FROM active_admins WHERE id <> $1
     )
     UPDATE staff SET role = $2, updated_at = now()
     WHERE id = $3 AND (role <> 'admin' OR active IS NOT TRUE OR (SELECT n FROM other_admins) > 0)
     RETURNING id, role`,
    [staffId, role, staffId]
  )
  if (!result.data[0]) await refuseIfStaffExists(staffId)
  return result.data[0] ?? null
}
