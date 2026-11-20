export interface GetPromoCodeRedemptionsParams {
  promoCodeId: string
}

export interface PromoCodeRedemptionRow {
  id: string
  order_id: string
  customer_id: string
  customer_first_name: string | null
  customer_last_name: string | null
  discount_amount: string
  created_at: string
  order_created_at: string
}

/** Redemption history for one promo code (order, date, customer, amount). Read is open to all
 *  staff — it renders inside the management page's expandable row; writes are gated separately. */
export default async function getPromoCodeRedemptions(
  req: { params: GetPromoCodeRedemptionsParams }
): Promise<PromoCodeRedemptionRow[]> {
  const result = await paddockData.query<PromoCodeRedemptionRow>(
    `SELECT r.id, r.order_id, r.customer_id, r.discount_amount, r.created_at,
            o.created_at AS order_created_at,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name
     FROM promo_code_redemptions r
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.promo_code_id = $1
     ORDER BY r.created_at DESC`,
    [req.params.promoCodeId]
  )
  return result.data
}
