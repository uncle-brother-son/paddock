import type { PromoCodeRow } from './shared/promoCodes'

export interface PromoCodeListRow extends PromoCodeRow {
  /** Redemptions recorded for this code across all customers. */
  used_count: number
  /** "First Last" of the restricted customer, null when the code is not restricted. */
  restricted_customer_name: string | null
}

/**
 * Lists every promo code with its usage count and restricted-customer name. Reads are open to
 * all staff (the management page renders read-only without Manage pricing, exactly like the
 * other pricing/catalog pages); every write path is gated by requireCanManagePricing.
 */
export default async function getPromoCodes(): Promise<PromoCodeListRow[]> {
  const result = await paddockData.query<PromoCodeListRow>(
    `SELECT pc.id, pc.code, pc.description, pc.discount_type, pc.discount_value, pc.applies_to,
            pc.applies_on_member_prices, pc.expires_on, pc.max_total_uses, pc.one_use_per_customer,
            pc.min_spend, pc.restricted_customer_id, pc.active, pc.created_by, pc.created_at, pc.updated_at,
            (SELECT COUNT(*) FROM promo_code_redemptions r WHERE r.promo_code_id = pc.id) AS used_count,
            CASE WHEN c.id IS NULL THEN NULL ELSE trim(c.first_name || ' ' || c.last_name) END AS restricted_customer_name
     FROM promo_codes pc
     LEFT JOIN customers c ON c.id = pc.restricted_customer_id
     ORDER BY pc.created_at DESC`,
    []
  )
  return result.data
}
