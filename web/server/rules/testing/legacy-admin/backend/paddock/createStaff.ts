import { requireStaffAdmin } from './shared/staffAccess'

export type StaffRole = 'admin' | 'manager' | 'staff'

const VALID_ROLES: StaffRole[] = ['admin', 'manager', 'staff']
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface CreateStaffParams {
  firstName: string
  lastName: string
  email: string
  role: StaffRole
  canIssueRefunds?: boolean
}

export interface CreateStaffRow {
  id: string
  first_name: string
  last_name: string
  email: string
  role: StaffRole
  can_issue_refunds: boolean
  can_manage_pricing: boolean
  active: boolean
  created_at: string
  updated_at: string
}

export default async function createStaff(req: { params: CreateStaffParams; user: User }): Promise<CreateStaffRow> {
  // Admins only — only role = admin may add staff.
  await requireStaffAdmin(req.user.email)

  const firstName = req.params.firstName?.trim()
  const lastName = req.params.lastName?.trim()
  const email = req.params.email?.trim().toLowerCase()
  const role = req.params.role
  const canIssueRefunds = req.params.canIssueRefunds ?? false

  if (!firstName) {
    throw new Error('First name is required')
  }
  if (!lastName) {
    throw new Error('Last name is required')
  }
  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new Error('A valid email address is required')
  }
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`)
  }

  try {
    const result = await paddockData.query<CreateStaffRow>(
      `INSERT INTO staff (first_name, last_name, email, role, can_issue_refunds, active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, first_name, last_name, email, role, can_issue_refunds, can_manage_pricing, active, created_at, updated_at`,
      [firstName, lastName, email, role, canIssueRefunds]
    )
    return result.data[0]!
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (message.includes('staff_email_key') || message.includes('duplicate key')) {
      throw new Error('A staff member with this email address already exists')
    }
    throw err
  }
}
