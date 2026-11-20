import { requireStaffId } from './shared/resolveStaffId'
import { insertStockAdjustment, deleteStockAdjustment } from './shared/stockAdjustments'
// The runtime globals (paddockData, paddockBackendApi2, User) are typed by the generated
// declarations in backend/resources/ and backend/user.d.ts; globals.ts is now an empty module,
// kept so this import stays valid.
import './globals'

export type StockAdjustmentReasonCategory = 'delivery' | 'damage' | 'recount' | 'sale' | 'refund_restock' | 'other'

const VALID_REASON_CATEGORIES: StockAdjustmentReasonCategory[] = [
  'delivery',
  'damage',
  'recount',
  'sale',
  'refund_restock',
  'other',
]

const REASON_LABELS: Record<Exclude<StockAdjustmentReasonCategory, 'other'>, string> = {
  delivery: 'Delivery',
  damage: 'Damage',
  recount: 'Recount',
  sale: 'Sale',
  refund_restock: 'Refund Restock',
}

export interface AdjustVariantStockParams {
  variantId: string
  /** Positive to add stock (e.g. a delivery), negative to remove it (e.g. damage). */
  changeAmount: number
  reasonCategory: StockAdjustmentReasonCategory
  /** Required when reasonCategory is 'other'; becomes the stored reason text ("Other: <note>"). */
  note?: string
}

export interface AdjustVariantStockResult {
  id: string
  stock_quantity: number
}

// Manual, staff-facing stock correction. Every call writes one row to stock_adjustments (the
// audit ledger) alongside the actual stock_quantity change — this is the ONLY way stock_quantity
// should be edited by a human; it replaces the old raw-overwrite setProductVariantStock.ts.
// Order-driven stock movements (sales in createOrder.ts, restocks in refundOrder.ts) write to
// the same ledger automatically with staff_id NULL — see shared/stockAdjustments.ts.
export default async function adjustVariantStock(
  req: { params: AdjustVariantStockParams; user: User }
): Promise<AdjustVariantStockResult> {
  const { variantId, changeAmount, reasonCategory, note } = req.params

  if (!variantId) {
    throw new Error('variantId is required')
  }
  if (!Number.isInteger(changeAmount) || changeAmount === 0) {
    throw new Error('changeAmount must be a non-zero whole number')
  }
  if (!VALID_REASON_CATEGORIES.includes(reasonCategory)) {
    throw new Error(`Invalid reason category: ${reasonCategory}`)
  }
  if (reasonCategory === 'other' && !note?.trim()) {
    throw new Error('A note is required when the reason is "Other"')
  }

  const staffId = await requireStaffId(req.user.email)

  const lookup = await paddockData.query<{ stock_quantity: number }>(
    'SELECT stock_quantity FROM product_variants WHERE id = $1',
    [variantId]
  )
  const current = lookup.data[0]
  if (!current) {
    throw new Error('Variant not found')
  }
  if (current.stock_quantity + changeAmount < 0) {
    throw new Error(
      `This adjustment would bring stock below zero (current stock: ${current.stock_quantity}, change: ${changeAmount}).`
    )
  }

  const reason = reasonCategory === 'other' ? `Other: ${note!.trim()}` : REASON_LABELS[reasonCategory]

  const adjustmentId = await insertStockAdjustment({ variantId, changeAmount, reason, staffId })

  // Atomic guarded update — the WHERE guard catches the rare race where stock changed between
  // the pre-check above and now. The whole call is wrapped in try/catch, not just the 0-rows
  // case: if the UPDATE throws for ANY reason (a transient DB error, not just a lost race), the
  // ledger row already written above would otherwise be left orphaned with no matching stock
  // change — exactly the drift this feature exists to prevent. Note: changeAmount is bound twice
  // under two DIFFERENT placeholder numbers ($1 and $3) rather than reusing $1, since this DB
  // driver rejects reusing one placeholder number twice in the same query even for an identical
  // value.
  let claim: { data: { id: string; stock_quantity: number }[] }
  try {
    claim = await paddockData.query<{ id: string; stock_quantity: number }>(
      `UPDATE product_variants
       SET stock_quantity = stock_quantity + $1, updated_at = now()
       WHERE id = $2 AND stock_quantity + $3 >= 0
       RETURNING id, stock_quantity`,
      [changeAmount, variantId, changeAmount]
    )
  } catch (err) {
    await deleteStockAdjustment(adjustmentId)
    throw err
  }

  if (claim.data.length === 0) {
    await deleteStockAdjustment(adjustmentId)
    throw new Error('Stock changed concurrently and this adjustment would now bring it below zero — please retry.')
  }

  return { id: variantId, stock_quantity: claim.data[0]!.stock_quantity }
}
