import { catalogPassDetailsRouteInputSchema, catalogPassDetailsRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setPassDetail } from '@/server/rules/catalog/passes-gift-cards'

/**
 * Brief W56 (G-plan 4.3; bugs GB9 and GB10; Wayne's Q52; lead call L11): setSessionPassSessionsIncluded,
 * setSessionPassExpiry and setSessionPassLevel, one `field` a press. Manage pricing; GB10's whole numbers; one
 * transaction under the pass type's lock, with a `catalog.details_set` audit row (the level's with Q52's holder count).
 */
export const POST = defineRoute({ auth: 'staff', input: catalogPassDetailsRouteInputSchema, output: catalogPassDetailsRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setPassDetail(db, input.passTypeId, input.field, input.value, { actor: adminActor(staff), requestId, pressKey: idempotencyKey }) as Promise<never>
)
