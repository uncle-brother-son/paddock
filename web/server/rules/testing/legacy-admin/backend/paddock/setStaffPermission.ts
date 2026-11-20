import { refuseIfStaffExists, requireStaffAdmin } from './shared/staffAccess'

export type StaffPermissionField = 'can_issue_refunds' | 'active'

export interface SetStaffPermissionParams {
  staffId: string
  field: StaffPermissionField
  value: boolean
}

export default async function setStaffPermission(req: { params: SetStaffPermissionParams; user: User }) {
  const { staffId, field, value } = req.params

  // Admins only — only role = admin may change any permission switch.
  await requireStaffAdmin(req.user.email)

  // Each branch uses a fixed, literal column name in the SQL text — no dynamic interpolation
  // of the column from user input, even though `field` is already validated against the
  // StaffPermissionField union by TypeScript.
  switch (field) {
    case 'can_issue_refunds': {
      const result = await paddockData.query(
        'UPDATE staff SET can_issue_refunds = $1, updated_at = now() WHERE id = $2 RETURNING id, can_issue_refunds',
        [value, staffId]
      )
      return result.data[0] ?? null
    }
    case 'active': {
      if (value) {
        const result = await paddockData.query(
          'UPDATE staff SET active = true, updated_at = now() WHERE id = $1 RETURNING id, active',
          [staffId]
        )
        return result.data[0] ?? null
      }
      // Never leave no active admin. One statement that locks every active admin row first, so two
      // admins switching each other off at once queue up and the second sees the first's change.
      const result = await paddockData.query(
        `WITH active_admins AS (
           SELECT id FROM staff WHERE role = 'admin' AND active = true ORDER BY id FOR UPDATE
         ), other_admins AS (
           SELECT count(*) AS n FROM active_admins WHERE id <> $1
         )
         UPDATE staff SET active = false, updated_at = now()
         WHERE id = $2 AND (role <> 'admin' OR active IS NOT TRUE OR (SELECT n FROM other_admins) > 0)
         RETURNING id, active`,
        [staffId, staffId]
      )
      if (!result.data[0]) await refuseIfStaffExists(staffId)
      return result.data[0] ?? null
    }
    default: {
      const exhaustiveCheck: never = field
      throw new Error(`Invalid field: ${exhaustiveCheck}`)
    }
  }
}
