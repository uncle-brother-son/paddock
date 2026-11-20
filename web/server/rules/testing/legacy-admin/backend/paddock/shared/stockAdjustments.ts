/**
 * Shared helpers for writing to the stock_adjustments ledger. Every change to a variant's
 * stock_quantity — manual staff corrections (adjustVariantStock.ts) and automatic
 * order-driven movements (createOrder.ts sales, refundOrder.ts restocks) — goes through
 * `insertStockAdjustment` so stock_quantity is never changed without a matching audit row.
 * `staffId` is null for system-generated entries (sales, refund restocks); manual entries
 * always have a real staff_id (see adjustVariantStock.ts, which requires it).
 */

// The runtime globals (paddockData) are typed by the generated declarations in
// backend/resources/; ../globals.ts is now an empty module, kept so this import stays valid.
import '../globals'

export interface StockAdjustmentInsertParams {
  variantId: string
  changeAmount: number
  reason: string
  staffId: string | null
}

export async function insertStockAdjustment(params: StockAdjustmentInsertParams): Promise<string> {
  const result = await paddockData.query<{ id: string }>(
    `INSERT INTO stock_adjustments (variant_id, change_amount, reason, staff_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [params.variantId, params.changeAmount, params.reason, params.staffId]
  )
  return result.data[0]!.id
}

/** Best-effort compensating delete, used to roll back a ledger row when the paired stock_quantity change didn't actually take effect. */
export async function deleteStockAdjustment(adjustmentId: string): Promise<void> {
  await paddockData.query(`DELETE FROM stock_adjustments WHERE id = $1`, [adjustmentId])
}
