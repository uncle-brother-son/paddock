import { catalogServiceTypesRouteOutputSchema, emptyInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listServiceTypes } from '@/server/rules/catalog/service-types'

/**
 * Brief W56 (G-plan 4.3; bug GB14; W51 report "Noticed" 7): getServiceTypes, for Catalog -> Service Types, New Order's
 * booking section and Move: every service type with its tiers and weekly slots, each type with its stamp and each tier
 * with its size group's stamp. Named fields. Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: catalogServiceTypesRouteOutputSchema }, async ({ db, staff }) =>
  listServiceTypes(db, adminActor(staff)) as Promise<never>
)
