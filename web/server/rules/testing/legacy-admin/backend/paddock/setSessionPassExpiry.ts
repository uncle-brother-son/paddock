import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetSessionPassExpiryParams {
  passTypeId: string
  expiryMonths: number
}

export default async function setSessionPassExpiry(req: { params: SetSessionPassExpiryParams; user: User }) {
  // The pass type edit dialog is Manage-pricing only (its Save is gated), so the server matches.
  await requireCanManagePricing(req.user.email)
  const { passTypeId, expiryMonths } = req.params
  const result = await paddockData.query(
    'UPDATE session_pass_types SET expiry_months = $1, updated_at = now() WHERE id = $2 RETURNING id, expiry_months',
    [expiryMonths, passTypeId]
  )
  return result.data[0] ?? null
}
