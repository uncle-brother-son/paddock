import { requireStaffAdmin } from './shared/staffAccess'

export type StaffRole = 'admin' | 'manager' | 'staff'

export interface StaffRow {
  id: string
  first_name: string
  last_name: string
  email: string
  role: StaffRole
  can_issue_refunds: boolean | null
  can_manage_pricing: boolean | null
  active: boolean | null
  created_at: string
  updated_at: string
}

export default async function getStaff(req: { user: User }): Promise<StaffRow[]> {
  // Admins only — the whole staff directory (emails, roles, permission flags) is restricted to
  // staff with role = admin. Everyone else gets the same error the UI shows as "Admins only".
  await requireStaffAdmin(req.user.email)

  const result = await paddockData.query<StaffRow>(
    `SELECT
       id,
       first_name,
       last_name,
       email,
       role,
       can_issue_refunds,
       can_manage_pricing,
       active,
       created_at,
       updated_at
     FROM staff
     ORDER BY role, first_name, last_name`
  )
  return result.data
}
