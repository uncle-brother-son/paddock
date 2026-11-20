import { requireCanManagePricing } from './shared/pricingStaff'

export interface CreateServiceTypePriceTierParams {
  serviceTypeId: string
  minPeople: number
  maxPeople: number
}

export default async function createServiceTypePriceTier(
  req: { params: CreateServiceTypePriceTierParams; user: User }
) {
  // A new price tier is price structure — Manage pricing only.
  await requireCanManagePricing(req.user.email)
  const { serviceTypeId, minPeople, maxPeople } = req.params

  if (!serviceTypeId) {
    throw new Error('serviceTypeId is required')
  }
  if (!Number.isInteger(minPeople) || minPeople < 1) {
    throw new Error('Min people must be a positive whole number')
  }
  if (!Number.isInteger(maxPeople) || maxPeople < 1) {
    throw new Error('Max people must be a positive whole number')
  }
  if (minPeople > maxPeople) {
    throw new Error('Min people cannot be greater than max people')
  }

  // price and stripe_price_id are intentionally left NULL — staff confirm the price afterward
  // via the Edit Price flow, which creates the Stripe Price and sets both fields atomically.
  // Private services are band-priced: ONE size group gets a tier row PER BAND (created together
  // here, from the active session_bands), so the grid always shows every band for a new size.
  // Returns ALL created rows (one per band).
  const result = await paddockData.query(
    `INSERT INTO service_type_price_tiers (service_type_id, band_id, min_people, max_people, price, stripe_price_id)
     SELECT $1, b.id, $2, $3, NULL, NULL FROM session_bands b WHERE b.active = true
     ON CONFLICT (service_type_id, band_id, min_people) DO NOTHING
     RETURNING *`,
    [serviceTypeId, minPeople, maxPeople]
  )
  return result.data
}
