import { catalogPassTypesRouteInputSchema, catalogPassTypesRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listPassTypes } from '@/server/rules/catalog/passes-gift-cards'

/**
 * Brief W56 (G-plan 4.3; bug GB14): getSessionPassTypes, for Catalog -> Session Passes and New Order (with `sessionId`,
 * each pass type says whether its level covers that session). Named fields. Any active staff member.
 */
export const GET = defineRoute({ auth: 'staff', input: catalogPassTypesRouteInputSchema, output: catalogPassTypesRouteOutputSchema }, async ({ db, input, staff }) =>
  listPassTypes(db, input.sessionId, { channel: 'staff', actor: adminActor(staff) }) as Promise<never>
)
