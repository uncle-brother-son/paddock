import { refuseIfInactive } from './staffAccess'

/**
 * Guard for every band-pricing write: only staff whose staff row has can_manage_pricing = true
 * may change band prices, band time windows, or member terms. The staff row is looked up from
 * the logged-in user's email, exactly as requireStaffId does. Read-only callers (the pricing
 * page itself) don't need this — they render the page read-only for everyone else.
 */
export async function requireCanManagePricing(userEmail: string): Promise<void> {
  const lookup = await paddockData.query<{ id: string; can_manage_pricing: boolean | null; active: boolean | null }>(
    'SELECT id, can_manage_pricing, active FROM staff WHERE email = $1 AND active = true LIMIT 1',
    [userEmail]
  )
  const staff = lookup.data[0]
  if (!staff) {
    await refuseIfInactive(userEmail)
    throw new Error(
      `No staff record matches the logged-in user's email (${userEmail}). Ask an admin to add you as staff before managing pricing.`
    )
  }
  if (!staff.can_manage_pricing) {
    throw new Error('You do not have permission to manage pricing (staff.can_manage_pricing is off for your account).')
  }
}
