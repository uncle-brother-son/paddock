import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetServiceTypePriceTierRangeParams {
  tierId: string
  minPeople: number
  maxPeople: number
}

export default async function setServiceTypePriceTierRange(
  req: { params: SetServiceTypePriceTierRangeParams; user: User }
) {
  // Price tier ranges are price structure — Manage pricing only.
  await requireCanManagePricing(req.user.email)
  const { tierId, minPeople, maxPeople } = req.params

  if (!Number.isInteger(minPeople) || minPeople < 1) {
    throw new Error('Min people must be a positive whole number')
  }
  if (!Number.isInteger(maxPeople) || maxPeople < 1) {
    throw new Error('Max people must be a positive whole number')
  }
  if (minPeople > maxPeople) {
    throw new Error('Min people cannot be greater than max people')
  }

  const result = await paddockData.query(
    `UPDATE service_type_price_tiers
     SET min_people = $1, max_people = $2, updated_at = now()
     WHERE id = $3
     RETURNING id, service_type_id, min_people, max_people, price`,
    [minPeople, maxPeople, tierId]
  )
  return result.data[0] ?? null
}
