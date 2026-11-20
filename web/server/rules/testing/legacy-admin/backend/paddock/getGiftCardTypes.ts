export interface GiftCardTypeRow {
  id: string
  sanity_gift_card_type_id: string | null
  name: string
  thumbnail_url: string | null
  active: boolean
  stripe_product_id: string | null
  custom_amount_enabled: boolean
  custom_amount_min: string | null
  custom_amount_max: string | null
  /** Months from issue_date to expiry_date for a gift card issued from this type — same field
   *  shape and derivation pattern as session_pass_types.expiry_months (see createOrder.ts). */
  expiry_months: number | null
  created_at: string
  updated_at: string
}

export interface GiftCardPresetRow {
  id: string
  gift_card_type_id: string
  amount: string
  active: boolean
  stripe_price_id: string | null
  created_at: string
  updated_at: string
}

export interface GiftCardTypeWithPresets extends GiftCardTypeRow {
  presets: GiftCardPresetRow[]
}

// Catalog-backed gift card types (synced from Sanity — name/thumbnail_url mirror Sanity content,
// same pattern as service_types/products) and their fixed-amount presets. Custom amounts are
// only allowed when custom_amount_enabled is true, constrained to [custom_amount_min,
// custom_amount_max]. createOrder.ts is the authoritative validator of a purchase against these
// — this function is purely for populating the checkout picker.
export default async function getGiftCardTypes(): Promise<GiftCardTypeWithPresets[]> {
  const [types, presets] = await Promise.all([
    paddockData.query<GiftCardTypeRow>('SELECT * FROM gift_card_types ORDER BY name'),
    paddockData.query<GiftCardPresetRow>('SELECT * FROM gift_card_presets ORDER BY amount'),
  ])

  return types.data.map((t) => ({
    ...t,
    presets: presets.data.filter((p) => p.gift_card_type_id === t.id),
  }))
}
