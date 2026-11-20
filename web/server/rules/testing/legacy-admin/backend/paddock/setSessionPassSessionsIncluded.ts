import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetSessionPassSessionsIncludedParams {
  passTypeId: string
  sessionsIncluded: number
}

export default async function setSessionPassSessionsIncluded(
  req: { params: SetSessionPassSessionsIncludedParams; user: User }
) {
  // The pass type edit dialog is Manage-pricing only (its Save is gated), so the server matches.
  await requireCanManagePricing(req.user.email)
  const { passTypeId, sessionsIncluded } = req.params

  const result = await paddockData.query(
    'UPDATE session_pass_types SET sessions_included = $1, updated_at = now() WHERE id = $2 RETURNING id, sessions_included',
    [sessionsIncluded, passTypeId]
  )
  return result.data[0] ?? null
}
