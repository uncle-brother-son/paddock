import { catalogAddonsRouteOutputSchema, emptyInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listAddons } from '@/server/rules/catalog/items'

/**
 * Brief W55 (G-plan 4.3; bug GB14): getAddons, for Catalog -> Add-ons, New Order and Add Guest. Named fields. Any
 * active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: catalogAddonsRouteOutputSchema }, async ({ db, staff }) =>
  listAddons(db, { channel: 'staff', actor: adminActor(staff) }) as Promise<never>
)
