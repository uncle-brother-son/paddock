import { catalogStockHistoryRouteInputSchema, catalogStockHistoryRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { stockHistory } from '@/server/rules/catalog/stock'

/**
 * Brief W55 (G-plan 4.3; bug GB14): getStockAdjustments, a variant's stock history, newest first (`limit`: the newest
 * N). Named fields. Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: catalogStockHistoryRouteInputSchema, output: catalogStockHistoryRouteOutputSchema }, async ({ db, input, staff }) =>
  stockHistory(db, input.variantId, input.limit, adminActor(staff)) as Promise<never>
)
