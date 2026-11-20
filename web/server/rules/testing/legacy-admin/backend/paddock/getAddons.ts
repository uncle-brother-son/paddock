export interface AddonRow {
  id: string
  sanity_addon_id: string | null
  name: string
  thumbnail_url: string | null
  category: string | null
  sku: string | null
  base_price: string
  member_price: string | null
  sale_price: string | null
  stripe_product_id: string | null
  stripe_price_id_base: string | null
  stripe_price_id_member: string | null
  stripe_price_id_sale: string | null
  active: boolean | null
  created_at: string
  updated_at: string
}

export default async function getAddons(): Promise<AddonRow[]> {
  const result = await paddockData.query<AddonRow>('SELECT * FROM addons ORDER BY category, name')
  return result.data
}
