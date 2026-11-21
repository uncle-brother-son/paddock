// Brief W55 (G-plan 1.2, 4.1, 4.3, 4.6; bugs GB13 and GB14): stock adjustments and their history on the Worker.
// Ported from the staff app's adjustVariantStock.ts, getStockAdjustments.ts and shared/stockAdjustments.ts (frozen at
// W48 in testing/legacy-admin), with their words.
//
// GB13. The old adjustment wrote the ledger row, then changed the stock in a second statement, deleting the ledger row
// again if that failed; and it had no press key, so a delivery of 10 whose answer was lost, pressed again, counted 20.
// Now it is one transaction under the VARIANT's own row lock, the lock an order takes before it takes stock
// (orders/locks.ts: LOCK_ORDER's 'product_variants'): the stock is read under the lock, refused in the old words if it
// would go below zero, and the ledger row, the stock and an audit row are written together, or none of them. The route
// is idempotent, so the same press made again is answered from the first and changes nothing. Any active staff member,
// as before. (A stock change is a press that moves a number, not a whole row sent back, so it carries no stamp.)
import 'server-only'
import type { AdminAction } from '@/contracts'
import type { Db, Queryable } from '@/server/db'
import { isUuid } from '@/server/rules/admin/locks'
import { adminRead } from '@/server/rules/admin/read'
import { adminRefusal, type AdminActor } from '@/server/rules/admin/refusal'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWriteOptions } from '@/server/rules/admin/write'
import { CATALOG_ADMIN_WORDS } from './failure-messages'
import { CATALOG_ITEM_NEW_WORDS, STOCK_LIMIT } from './item-failure-messages'

const WORDS = CATALOG_ADMIN_WORDS.adjustVariantStock

export const STOCK_REASON_CATEGORIES = ['delivery', 'damage', 'recount', 'sale', 'refund_restock', 'other'] as const
export type StockReasonCategory = (typeof STOCK_REASON_CATEGORIES)[number]
/** The ledger's words for each reason, as before ("Other: <note>" for other). */
const REASON_LABELS: Readonly<Record<Exclude<StockReasonCategory, 'other'>, string>> = {
  delivery: 'Delivery',
  damage: 'Damage',
  recount: 'Recount',
  sale: 'Sale',
  refund_restock: 'Refund Restock',
}

export interface StockAdjustInput {
  variantId: string
  changeAmount?: unknown
  reasonCategory?: unknown
  note?: unknown
}

/** The old checks of what was sent, in their order and words. Answers the ledger's reason text and the change. */
function checkedAdjustment(action: AdminAction, input: StockAdjustInput): { change: number; reason: string } {
  const invalid = (message: string, field: string) => adminRefusal('VALIDATION', action, 'invalid_params', message, { field })
  const { changeAmount, reasonCategory, note } = input
  if (typeof changeAmount !== 'number' || !Number.isInteger(changeAmount) || changeAmount === 0) throw invalid(WORDS.changeamountMustNonZeroWholeNumber, 'changeAmount')
  if (typeof reasonCategory !== 'string' || !(STOCK_REASON_CATEGORIES as readonly string[]).includes(reasonCategory)) throw invalid(WORDS.invalidReasonCategory(reasonCategory), 'reasonCategory')
  const trimmed = typeof note === 'string' ? note.trim() : ''
  if (reasonCategory === 'other' && !trimmed) throw invalid(WORDS.noteRequiredWhenReasonOther, 'note')
  const reason = reasonCategory === 'other' ? `Other: ${trimmed}` : REASON_LABELS[reasonCategory as Exclude<StockReasonCategory, 'other'>]
  return { change: changeAmount, reason }
}

/**
 * adjustVariantStock (`POST catalog/variants/:variantId/stock`). Any active staff member. The old checks; then one
 * transaction under the variant's lock: the variant must be there ("Variant not found"); the stock read under the
 * lock, so an order taking stock waits or goes first and the figure is never stale; below zero refused in the old
 * words (with the stock and the change); the ledger row naming the staff member, the stock, and a `stock.adjusted`
 * audit row with the stock before and after, the change and the reason. Answers the variant's id and its new stock.
 */
export async function adjustStock(db: Db, input: StockAdjustInput, options: AdminWriteOptions): Promise<{ id: string; stock_quantity: number }> {
  const action: AdminAction = 'stock.adjusted'
  const { change, reason } = checkedAdjustment(action, input)
  const { variantId } = input
  const gone = () => adminRefusal('NOT_FOUND', action, 'variant_not_found', WORDS.variantNotFound)
  type Stock = { stock_quantity: number }
  return adminWrite<Stock, Stock, { id: string; stock_quantity: number }>(
    db,
    {
      action,
      needs: 'staff',
      entity: { type: 'product_variant', id: variantId },
      locks: [{ table: 'product_variants', ids: [variantId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held.product_variants?.length) throw gone()
        const [row] = await tx.query<{ stock_quantity: unknown }>('SELECT stock_quantity FROM product_variants WHERE id = $1::uuid', [variantId])
        if (!row) throw gone()
        return { stock_quantity: Number(row.stock_quantity) }
      },
      async change(tx, before) {
        if (before.stock_quantity + change < 0) {
          throw adminRefusal('CONFLICT', action, 'stock_below_zero', WORDS.adjustmentWouldBringStockBelowZero(before.stock_quantity, change), { field: 'changeAmount' })
        }
        // W55a (review N4): the stock and the ledger's change are int columns. Above their limit the cast failed and
        // the press read as no answer; now it is refused in words, with the figures, before anything is written.
        if (change > STOCK_LIMIT || before.stock_quantity + change > STOCK_LIMIT) {
          throw adminRefusal('VALIDATION', action, 'stock_above_limit', CATALOG_ITEM_NEW_WORDS.stockAboveLimit(before.stock_quantity, change), { field: 'changeAmount' })
        }
        await tx.query('INSERT INTO stock_adjustments (variant_id, change_amount, reason, staff_id) VALUES ($1::uuid, $2::int, $3::text, $4::uuid)', [variantId, change, reason, options.actor.id])
        const [row] = await tx.query<{ id: string; stock_quantity: unknown }>(
          'UPDATE product_variants SET stock_quantity = stock_quantity + $1::int, updated_at = now() WHERE id = $2::uuid RETURNING id, stock_quantity',
          [change, variantId]
        )
        if (!row) throw new Error('The variant was held but its stock not updated.')
        const after = { stock_quantity: Number(row.stock_quantity) }
        return { after, details: { changeAmount: change, reason }, answer: { id: row.id, stock_quantity: after.stock_quantity } }
      },
    },
    options
  )
}

/** A variant's history, newest first, with who made each change (sales and restocks by an order name nobody). */
const HISTORY_SQL = `
SELECT sa.id, sa.variant_id, sa.change_amount, sa.reason, sa.staff_id, s.first_name AS staff_first_name, s.last_name AS staff_last_name, sa.created_at
  FROM stock_adjustments sa
  LEFT JOIN staff s ON s.id = sa.staff_id
 WHERE sa.variant_id = $1::uuid
 ORDER BY sa.created_at DESC`

/**
 * getStockAdjustments (`GET catalog/variants/:variantId/stock-adjustments`, with `limit` for the newest N): any active
 * staff member (GB14: the old read checked nobody). A limit that isn't a whole number of 1 or more is no limit, and an
 * id that names no variant has no history, as before.
 */
export async function stockHistory(db: Queryable, variantId: string, limit: unknown, actor: AdminActor): Promise<Array<Record<string, unknown>>> {
  const read = { name: 'catalog.stock_adjustments', needs: 'staff' as const, times: ['created_at'] }
  const n = typeof limit === 'number' ? limit : typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : null
  // An id that isn't one names no variant, so it has no history (the route's staff check has already run).
  if (!isUuid(variantId)) return []
  if (n !== null && Number.isInteger(n) && n >= 1) return adminRead(db, { ...read, sql: `${HISTORY_SQL}\n LIMIT $2::int`, params: [variantId, n] }, { actor })
  return adminRead(db, { ...read, sql: HISTORY_SQL, params: [variantId] }, { actor })
}
