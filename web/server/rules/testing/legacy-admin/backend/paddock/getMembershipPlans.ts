export type MembershipPlanLevel = 'core' | 'all_access'

export interface MembershipPlanRow {
  id: string
  sanity_plan_id: string | null
  name: string
  thumbnail_url: string | null
  price_monthly: string | null
  price_yearly: string | null
  sessions_included: number | null
  addons_included: number | null
  level: MembershipPlanLevel | null
  is_unlimited: boolean
  stripe_product_id: string | null
  stripe_price_id: string | null
  stripe_price_id_yearly: string | null
  active: boolean | null
  created_at: string
  updated_at: string
}

export default async function getMembershipPlans(): Promise<MembershipPlanRow[]> {
  const result = await paddockData.query<MembershipPlanRow>('SELECT * FROM membership_plans ORDER BY name')
  return result.data
}
