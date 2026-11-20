import { requireCanManagePricing } from './shared/pricingStaff'
import { normalizePromoCodeText, validatePromoCodeFields, type PromoAppliesTo } from './shared/promoCodes'

export interface UpdatePromoCodeParams {
  id: string
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
  active: boolean
}

export interface UpdatePromoCodeResult {
  updated: boolean
  reason?: 'not_found' | 'code_locked'
  message?: string
  promo?: Record<string, unknown>
}

/**
 * Edits a promo code — Manage pricing permission required. The code TEXT is locked once the
 * code has been redeemed at least once (the visible code must stay stable for audit); every
 * other field, including the active flag (deactivate / reactivate), stays editable.
 */
export default async function updatePromoCode(
  req: { params: UpdatePromoCodeParams; user: User }
): Promise<UpdatePromoCodeResult> {
  await requireCanManagePricing(req.user.email)
  const p = req.params

  const existing = await paddockData.query<{ id: string; code: string }>(
    'SELECT id, code FROM promo_codes WHERE id = $1',
    [p.id]
  )
  const current = existing.data[0]
  if (!current) return { updated: false, reason: 'not_found', message: 'That promo code no longer exists.' }

  const codeCheck = normalizePromoCodeText(p.code)
  if (!codeCheck.ok) throw new Error(codeCheck.message)
  if (codeCheck.code !== current.code) {
    const usage = await paddockData.query<{ uses: string }>(
      'SELECT COUNT(*) AS uses FROM promo_code_redemptions WHERE promo_code_id = $1',
      [p.id]
    )
    if (Number.parseInt(usage.data[0]?.uses ?? '0', 10) > 0) {
      return {
        updated: false,
        reason: 'code_locked',
        message:
          'This code has been redeemed at least once — its text can no longer be changed. Deactivate it and create a new code instead.',
      }
    }
  }

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
    const result = await paddockData.query<Record<string, unknown>>(
      `UPDATE promo_codes
       SET code = $1, description = $2, discount_type = $3, discount_value = $4, applies_to = $5,
           applies_on_member_prices = $6, expires_on = $7, max_total_uses = $8,
           one_use_per_customer = $9, min_spend = $10, restricted_customer_id = $11,
           active = $12, updated_at = now()
       WHERE id = $13
       RETURNING *`,
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
        p.active === true,
        p.id,
      ]
    )
    if (!result.data[0]) return { updated: false, reason: 'not_found', message: 'That promo code no longer exists.' }
    return { updated: true, promo: result.data[0] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('promo_codes_code_upper_key')) {
      throw new Error(`A promo code "${codeCheck.code}" already exists (codes are unique, case-insensitive).`)
    }
    throw err
  }
}
