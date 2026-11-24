import { catalogProductCategoriesRouteOutputSchema, emptyInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listProductCategories } from '@/server/rules/catalog/items'

/**
 * Brief W72a (WQ7): getProductCategories, for Catalog -> Products: every product category Sanity's webhook has
 * mirrored, in order, with its title. Named fields. Any active staff member.
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: catalogProductCategoriesRouteOutputSchema }, async ({ db, staff }) =>
  listProductCategories(db, { actor: adminActor(staff) })
)
