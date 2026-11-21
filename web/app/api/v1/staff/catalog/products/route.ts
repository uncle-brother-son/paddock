import { catalogProductsRouteOutputSchema, emptyInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listProducts } from '@/server/rules/catalog/items'

/**
 * Brief W55 (G-plan 4.3; bug GB14): getProducts, for Catalog -> Products and New Order's product picker: every product
 * with its variants, each variant with its stamp. Named fields. Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: catalogProductsRouteOutputSchema }, async ({ db, staff }) =>
  listProducts(db, { channel: 'staff', actor: adminActor(staff) }) as Promise<never>
)
