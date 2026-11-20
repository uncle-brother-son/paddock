export interface GetStockAdjustmentsParams {
  variantId: string
  /** Omit for the full history; pass a number (e.g. 10) to cap it to the most recent N rows. */
  limit?: number
}

export interface StockAdjustmentRow {
  id: string
  variant_id: string
  change_amount: number
  reason: string
  staff_id: string | null
  staff_first_name: string | null
  staff_last_name: string | null
  created_at: string
}

export default async function getStockAdjustments(
  req: { params: GetStockAdjustmentsParams }
): Promise<StockAdjustmentRow[]> {
  const { variantId, limit } = req.params
  if (!variantId) {
    throw new Error('variantId is required')
  }

  const result = limit
    ? await paddockData.query<StockAdjustmentRow>(
        `SELECT sa.id, sa.variant_id, sa.change_amount, sa.reason, sa.staff_id,
                s.first_name AS staff_first_name, s.last_name AS staff_last_name, sa.created_at
         FROM stock_adjustments sa
         LEFT JOIN staff s ON s.id = sa.staff_id
         WHERE sa.variant_id = $1
         ORDER BY sa.created_at DESC
         LIMIT $2`,
        [variantId, limit]
      )
    : await paddockData.query<StockAdjustmentRow>(
        `SELECT sa.id, sa.variant_id, sa.change_amount, sa.reason, sa.staff_id,
                s.first_name AS staff_first_name, s.last_name AS staff_last_name, sa.created_at
         FROM stock_adjustments sa
         LEFT JOIN staff s ON s.id = sa.staff_id
         WHERE sa.variant_id = $1
         ORDER BY sa.created_at DESC`,
        [variantId]
      )

  return result.data
}
