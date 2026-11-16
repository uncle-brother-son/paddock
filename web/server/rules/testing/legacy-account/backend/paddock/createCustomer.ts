import { isAtLeastMinimumAge } from './shared/guestValidation'
import { resolveStaffId } from './shared/resolveStaffId'

export interface CreateCustomerParams {
  firstName: string
  lastName: string
  email: string
  dateOfBirth: string
  phone?: string | null
}

export interface CreateCustomerRow {
  id: string
  first_name: string
  last_name: string
  email: string
  phone: string | null
  date_of_birth: string
  created_at: string
  updated_at: string
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// Creates a Postgres `customers` row only — no Retool user, login, or auth_user_id is created
// here. The real website's magic-link login matches against this record by email separately,
// entirely outside of this app.
export default async function createCustomer(
  req: { params: CreateCustomerParams; user: User }
): Promise<CreateCustomerRow> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const firstName = req.params.firstName?.trim()
  const lastName = req.params.lastName?.trim()
  const email = req.params.email?.trim().toLowerCase()
  const dateOfBirth = req.params.dateOfBirth?.trim()
  const phone = req.params.phone?.trim() || null

  if (!firstName) {
    throw new Error('First name is required')
  }
  if (!lastName) {
    throw new Error('Last name is required')
  }
  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new Error('A valid email address is required')
  }
  if (!dateOfBirth || !DATE_PATTERN.test(dateOfBirth) || Number.isNaN(Date.parse(dateOfBirth))) {
    throw new Error('A valid date of birth is required')
  }
  if (new Date(dateOfBirth).getTime() > Date.now()) {
    throw new Error('Date of birth cannot be in the future')
  }
  if (!isAtLeastMinimumAge(dateOfBirth)) {
    throw new Error('Customers must be 18 or over.')
  }

  try {
    const result = await paddockData.query<CreateCustomerRow>(
      `INSERT INTO customers (first_name, last_name, email, phone, date_of_birth)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, first_name, last_name, email, phone, date_of_birth, created_at, updated_at`,
      [firstName, lastName, email, phone, dateOfBirth]
    )
    return result.data[0]!
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (message.includes('customers_email_key') || message.includes('duplicate key')) {
      throw new Error('A customer with this email address already exists')
    }
    throw err
  }
}
