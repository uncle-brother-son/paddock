import { catalogStockAdjustRouteInputSchema, catalogStockAdjustRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { adjustStock } from '@/server/rules/catalog/stock'

/**
 * Brief W55 (G-plan 4.3; bug GB13): adjustVariantStock. Any active staff member. One transaction under the variant's
 * own lock (the one an order takes before it takes stock): the stock can't go below zero, and the ledger row, the
 * stock and a `stock.adjusted` audit row are written together. Idempotent: the stock row keeps its key after no
 * answer, so the same press made again is answered from the first and never counts twice.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogStockAdjustRouteInputSchema, output: catalogStockAdjustRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  adjustStock(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
