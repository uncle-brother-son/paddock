// Ported from backend/paddock/shared/promoCodeLookup.ts.
import 'server-only'
import type { Queryable } from '@/server/db'
import type { PromoCodeRow, PromoUsageCounts } from './promo-codes'

export interface LoadedPromo {
  promo: PromoCodeRow
  usage: PromoUsageCounts
}

/**
 * Looks the code up case-insensitively (the unique index is on upper(code)) and counts redemptions
 * for the max-uses and one-per-customer limits. The count is advisory, for clear failures.
 */
export async function loadPromoAndUsage(db: Queryable, code: string, customerId: string): Promise<LoadedPromo | null> {
  const promoLookup = await db.query<PromoCodeRow>(
    `SELECT id, code, description, discount_type, discount_value, applies_to,
            applies_on_member_prices, expires_on, max_total_uses, one_use_per_customer,
            min_spend, restricted_customer_id, active
     FROM promo_codes
     WHERE upper(code) = upper($1)
     LIMIT 1`,
    [code]
  )
  const promo = promoLookup[0]
  if (!promo) return null

  const usageLookup = await db.query<{ total_uses: string; customer_uses: string }>(
    `SELECT COUNT(*) AS total_uses,
            COUNT(*) FILTER (WHERE customer_id = $1) AS customer_uses
     FROM promo_code_redemptions
     WHERE promo_code_id = $2`,
    [customerId, promo.id]
  )
  const usageRow = usageLookup[0]
  return {
    promo,
    usage: {
      totalUses: Number.parseInt(usageRow?.total_uses ?? '0', 10),
      usesByThisCustomer: Number.parseInt(usageRow?.customer_uses ?? '0', 10),
    },
  }
}
