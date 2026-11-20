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

export interface StaffRow {
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

/**
 * W49 (GB16; W48 call 12): the one way a sign-in's email finds its staff row, for the staff check below and for
 * `GET staff/me` (server/rules/admin/read.ts, ownStaffRow), so the two can never differ. Compared in lower case on
 * both sides: a sign-in spelt "Jo@Example.com" is the staff member stored as "jo@example.com", and a row stored with
 * a capital is found by a sign-in without one. The old functions compared exactly, so such a sign-in matched nobody.
 * Staff emails are unique as stored (staff_email_key), not in lower case; should two rows ever differ only in case,
 * the one spelt exactly as the sign-in comes first, then the lower id, so the answer never changes between requests.
 */
export const STAFF_BY_SIGN_IN_EMAIL_SQL =
  'SELECT id, email, role, can_issue_refunds, can_manage_pricing, active FROM staff WHERE lower(email) = lower($1) ORDER BY (email = $1) DESC, id LIMIT 1'

export async function staffRowBySignInEmail(db: Queryable, email: string): Promise<StaffRow | null> {
  const rows = await db.query<StaffRow>(STAFF_BY_SIGN_IN_EMAIL_SQL, [email])
  return rows[0] ?? null
}

/**
 * The first half of the staff check: the shared key, and the email Retool signed in. Answers the email as sent
 * (trimmed). W49 (lead call L10): `GET staff/me` stops here (the route factory's `staff_sign_in` mode), because it
 * answers an inactive member's own row; every other staff route goes on to authenticateStaff's row check.
 */
export async function authenticateStaffSignIn(headers: Headers, staffApiKey: string | undefined): Promise<string> {
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
  return email
}

export async function authenticateStaff(headers: Headers, db: Queryable, staffApiKey: string | undefined): Promise<StaffContext> {
  const email = await authenticateStaffSignIn(headers, staffApiKey)

  // W49 (GB16): in lower case on both sides, where shared/staffAccess.ts and shared/resolveStaffId.ts compared exactly.
  const staff = await staffRowBySignInEmail(db, email)
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
