import 'server-only'
import type { StaffContext, StaffRole } from '@/contracts'
import type { Queryable } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { bearerToken } from './bearer'

/**
 * Authentication for /api/v1/staff/*. Only the staff app's backend functions call these routes:
 * they send the shared key (held on the Retool resource, never in a browser) and the logged-in
 * user's email from req.user, which Retool has already authenticated.
 *
 * The request can't be signed as well: Retool backend functions have no way to read a secret
 * (no process, no retoolContext, checked on the live runtime), so the key and email are the design.
 */

interface StaffRow {
  id: string
  email: string
  role: StaffRole
  can_issue_refunds: boolean | null
  can_manage_pricing: boolean | null
  active: boolean | null
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/** Constant-time: both sides are hashed to the same length, then every byte is compared. */
export async function keysMatch(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)])
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= (a[i] as number) ^ (b[i] as number)
  return difference === 0
}

export async function authenticateStaff(headers: Headers, db: Queryable, staffApiKey: string | undefined): Promise<StaffContext> {
  const token = bearerToken(headers)
  if (!staffApiKey) {
    // Fail closed: an unset secret must never match anything.
    throw new ApiError('UNAUTHORISED', 'The staff app could not be authorised.', { logDetail: 'STAFF_API_KEY is not configured' })
  }
  if (!token || !(await keysMatch(token, staffApiKey))) {
    throw new ApiError('UNAUTHORISED', 'The staff app could not be authorised.')
  }

  const email = headers.get('x-staff-email')?.trim()
  if (!email) {
    throw new ApiError('UNAUTHORISED', 'The request did not say which staff member is logged in.')
  }

  // The same exact-email match as shared/staffAccess.ts and shared/resolveStaffId.ts.
  const rows = await db.query<StaffRow>(
    'SELECT id, email, role, can_issue_refunds, can_manage_pricing, active FROM staff WHERE email = $1 LIMIT 1',
    [email]
  )
  const staff = rows[0]
  if (!staff) {
    throw new ApiError(
      'UNAUTHORISED',
      `No staff record matches the logged-in user's email (${email}). Ask an admin to add you as staff before performing this action.`
    )
  }
  if (staff.active !== true) {
    throw new ApiError('FORBIDDEN', 'This staff account is inactive. Ask an admin to reactivate it.')
  }

  return {
    id: staff.id,
    email: staff.email,
    role: staff.role,
    canIssueRefunds: staff.can_issue_refunds === true,
    canManagePricing: staff.can_manage_pricing === true,
  }
}

// The wording below matches shared/staffAccess.ts and shared/pricingStaff.ts in the staff app.

export function requireAdmin(staff: StaffContext): void {
  if (staff.role !== 'admin') {
    throw new ApiError('FORBIDDEN', 'Admins only — this action requires the admin role.')
  }
}

export function requireIssueRefunds(staff: StaffContext): void {
  if (!staff.canIssueRefunds) {
    throw new ApiError('FORBIDDEN', 'Needs Issue refunds permission — this action moves money back to the customer.')
  }
}

export function requireManagePricing(staff: StaffContext): void {
  if (!staff.canManagePricing) {
    throw new ApiError('FORBIDDEN', 'You do not have permission to manage pricing (staff.can_manage_pricing is off for your account).')
  }
}
