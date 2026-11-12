import type { PromoCodeRow, PromoUsageCounts } from '@retool-app/backend/paddock/shared/promoCodes'

export interface LoadedPromo {
  promo: PromoCodeRow
  usage: PromoUsageCounts
}

/**
 * Database-facing loader for createOrder.ts (authoritative in-order validation). The staff preview
 * now comes from the Worker, through validatePromoCode.ts; the order still uses this Retool copy
 * until step C, so until then any promo rule change must be made in both. Looks the code up case-insensitively (the unique index is on upper(code)) and counts
 * redemptions for the max-uses and one-per-customer limits.
 *
 * Race safety note: the COUNT here is advisory (for clear staff-facing failures). The
 * authoritative limit enforcement in createOrder.ts is insert-then-count against
 * promo_code_redemptions — see the comment there.
 */
export async function loadPromoAndUsage(code: string, customerId: string): Promise<LoadedPromo | null> {
  const promoLookup = await paddockData.query<PromoCodeRow>(
    `SELECT id, code, description, discount_type, discount_value, applies_to,
            applies_on_member_prices, expires_on, max_total_uses, one_use_per_customer,
            min_spend, restricted_customer_id, active
     FROM promo_codes
     WHERE upper(code) = upper($1)
     LIMIT 1`,
    [code]
  )
  const promo = promoLookup.data[0]
  if (!promo) return null

  const usageLookup = await paddockData.query<{ total_uses: string; customer_uses: string }>(
    `SELECT COUNT(*) AS total_uses,
            COUNT(*) FILTER (WHERE customer_id = $1) AS customer_uses
     FROM promo_code_redemptions
     WHERE promo_code_id = $2`,
    [customerId, promo.id]
  )
  const usageRow = usageLookup.data[0]
  return {
    promo,
    usage: {
      totalUses: Number.parseInt(usageRow?.total_uses ?? '0', 10),
      usesByThisCustomer: Number.parseInt(usageRow?.customer_uses ?? '0', 10),
    },
  }
}
