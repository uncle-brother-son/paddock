import { catalogGiftCardTypesRouteOutputSchema, emptyInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listGiftCardTypes } from '@/server/rules/catalog/passes-gift-cards'

/**
 * Brief W56 (G-plan 4.3; bug GB14): getGiftCardTypes, for Catalog -> Gift Card Types and New Order's gift card
 * section: every type with its presets, each type with the stamp of its custom amounts. Any active staff member.
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: catalogGiftCardTypesRouteOutputSchema }, async ({ db, staff }) =>
  listGiftCardTypes(db, { channel: 'staff', actor: adminActor(staff) }) as Promise<never>
)
