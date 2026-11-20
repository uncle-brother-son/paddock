import { requireCanManagePricing } from './shared/pricingStaff'
import {
  normalizePromoCodeText,
  validatePromoCodeFields,
  type PromoAppliesTo,
} from './shared/promoCodes'

export interface CreatePromoCodeParams {
  code: string
  description?: string
  discountType: 'percentage' | 'fixed'
  discountValue: number
  appliesTo: PromoAppliesTo[]
  appliesOnMemberPrices: boolean
  expiresOn: string | null
  maxTotalUses: number | null
  oneUsePerCustomer: boolean
  minSpend: number | null
  restrictedCustomerId: string | null
}

export interface PromoCodeCreatedRow {
  id: string
  code: string
  description: string | null
  discount_type: string
  discount_value: string
  applies_to: string[]
  applies_on_member_prices: boolean
  expires_on: string | null
  max_total_uses: number | null
  one_use_per_customer: boolean
  min_spend: string | null
  restricted_customer_id: string | null
  active: boolean
  created_by: string | null
}

/** Creates a promo code — Manage pricing permission required (any staff can USE a code). */
export default async function createPromoCode(
  req: { params: CreatePromoCodeParams; user: User }
): Promise<PromoCodeCreatedRow> {
  await requireCanManagePricing(req.user.email)
  const p = req.params

  const codeCheck = normalizePromoCodeText(p.code)
  if (!codeCheck.ok) throw new Error(codeCheck.message)

  const fieldError = validatePromoCodeFields({
    discountType: p.discountType,
    discountValue: p.discountValue,
    appliesTo: p.appliesTo,
    expiresOn: p.expiresOn,
    maxTotalUses: p.maxTotalUses,
    minSpend: p.minSpend,
  })
  if (fieldError) throw new Error(fieldError)

  if (p.restrictedCustomerId) {
    const customer = await paddockData.query<{ id: string }>(
      'SELECT id FROM customers WHERE id = $1',
      [p.restrictedCustomerId]
    )
    if (!customer.data[0]) throw new Error('The restricted customer does not exist.')
  }

  try {
    const result = await paddockData.query<PromoCodeCreatedRow>(
      `INSERT INTO promo_codes
         (code, description, discount_type, discount_value, applies_to, applies_on_member_prices,
          expires_on, max_total_uses, one_use_per_customer, min_spend, restricted_customer_id,
          active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12)
       RETURNING id, code, description, discount_type, discount_value, applies_to,
                 applies_on_member_prices, expires_on, max_total_uses, one_use_per_customer,
                 min_spend, restricted_customer_id, active, created_by`,
      [
        codeCheck.code,
        p.description?.trim() || null,
        p.discountType,
        p.discountValue,
        p.appliesTo,
        p.appliesOnMemberPrices === true,
        p.expiresOn,
        p.maxTotalUses,
        p.oneUsePerCustomer === true,
        p.minSpend,
        p.restrictedCustomerId,
        req.user.email,
      ]
    )
    return result.data[0]!
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('promo_codes_code_upper_key')) {
      throw new Error(`A promo code "${codeCheck.code}" already exists (codes are unique, case-insensitive).`)
    }
    throw err
  }
}
