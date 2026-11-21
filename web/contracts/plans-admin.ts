import { z } from 'zod'
import { adminGetMembershipPlansOutputSchema } from './admin'

// Brief W57 (G-plan 1.4, 4.3, 4.4; bugs GB1, GB2, GB19, GB20; Wayne's Q53; lead calls L3, L11; W54a's stale-page
// rule): membership plans' and membership settings' routes' own inputs and answers. The plan rows are the old read's
// (W48's contract), with what the page needs beside them. A refusal is an error whose `details` carry the old reason
// (or a new one) and the words (adminRefusalDetailsSchema). Every field the old function checked for itself is loose,
// so the rule answers in the old words. In their own file, exported last from index.ts, so the staff app's generated
// types keep the order of every earlier union.

/** A field the rule checks for itself: anything, or left out (refused by the rule, in the old words or new ones). */
const loose = z.unknown().optional()

/** The old read's row (getMembershipPlans), every column by name. */
export const planRowSchema = adminGetMembershipPlansOutputSchema.element
export type PlanRowOutput = z.infer<typeof planRowSchema>

/**
 * `GET catalog/membership-plans`: getMembershipPlans' rows by name, each with the stamp of the columns the edit dialog
 * sends back (W54a), its live members on each price (Q53: the dialog's words and the count it sends), whether it is
 * set up in Stripe (GB20) and whether a price change on it is still being made. A plan whose Stripe set-up failed for
 * good is left out.
 */
export const catalogPlansRouteOutputSchema = z.array(
  planRowSchema.extend({
    stamp: z.string(),
    members_monthly: z.number(),
    members_yearly: z.number(),
    setup: z.enum(['ready', 'being_set_up', 'not_set_up']),
    price_change_open: z.boolean(),
  })
)
export type CatalogPlansRouteOutput = z.infer<typeof catalogPlansRouteOutputSchema>

/** `POST catalog/membership-plans` (createMembershipPlan): the old params, each checked by the rule. */
export const catalogPlanCreateRouteInputSchema = z.object({ name: loose, level: loose, sessionsIncluded: loose, addonsIncluded: loose, isUnlimited: loose, priceMonthly: loose, priceYearly: loose })
export type CatalogPlanCreateRouteInput = z.infer<typeof catalogPlanCreateRouteInputSchema>
/** The plan as made (on sale), or (GB20) off sale with `create` saying its Stripe set-up is held for the automatic check. */
export const catalogPlanCreateRouteOutputSchema = planRowSchema.extend({ create: z.object({ state: z.literal('held'), message: z.string() }).optional() })
export type CatalogPlanCreateRouteOutput = z.infer<typeof catalogPlanCreateRouteOutputSchema>

/** `POST catalog/membership-plans/:planId/active` (setMembershipPlanActive). */
export const catalogPlanActiveRouteInputSchema = z.object({ planId: z.string(), active: loose })
export type CatalogPlanActiveRouteInput = z.infer<typeof catalogPlanActiveRouteInputSchema>
export const catalogPlanActiveRouteOutputSchema = z.object({ id: z.string(), active: z.boolean() })
export type CatalogPlanActiveRouteOutput = z.infer<typeof catalogPlanActiveRouteOutputSchema>

/**
 * `POST catalog/membership-plans/:planId/details` (setMembershipPlanDetails, and updateCatalogItemPrice's plan
 * branch as a price-only press: no `level`, its own price fields). `membersToMove`: Q53's count, as the dialog showed
 * it, needed when a price changes. `stamp`: the row's, from the list (a details press only).
 */
export const catalogPlanDetailsRouteInputSchema = z.object({
  planId: z.string(),
  name: loose,
  level: loose,
  isUnlimited: loose,
  sessionsIncluded: loose,
  addonsIncluded: loose,
  priceMonthly: loose,
  priceYearly: loose,
  monthlyPrice: loose,
  yearlyPrice: loose,
  basePrice: loose,
  memberPrice: loose,
  salePrice: loose,
  membersToMove: loose,
  stamp: loose,
})
export type CatalogPlanDetailsRouteInput = z.infer<typeof catalogPlanDetailsRouteInputSchema>
/** What a price change came to (Q53): done (with how many moved and how many are still to move), or held for the automatic check. */
export const planPriceChangeSchema = z.object({
  changeId: z.string(),
  state: z.enum(['done', 'held']),
  membersToMove: z.number(),
  moved: z.number(),
  toMove: z.number(),
  message: z.string(),
})
export type PlanPriceChangeOutput = z.infer<typeof planPriceChangeSchema>
export const catalogPlanDetailsRouteOutputSchema = z.object({
  plan: planRowSchema,
  stamp: z.string(),
  priceChange: planPriceChangeSchema.nullable(),
  /** A price-only press: each price set, as the number sent (the legacy route's `pricesUpdated`). */
  pricesUpdated: z.record(z.string(), z.number()).optional(),
})
export type CatalogPlanDetailsRouteOutput = z.infer<typeof catalogPlanDetailsRouteOutputSchema>

/** `GET membership-settings` (getMembershipSettings). */
export const membershipSettingsRouteOutputSchema = z.object({ addonCreditWaitMonths: z.number() })
export type MembershipSettingsRouteOutput = z.infer<typeof membershipSettingsRouteOutputSchema>

/**
 * `GET membership-settings/quote` (GB19): how many members' Herd status a waiting period would change, before the press.
 * W57a (W57 review L11): an empty value (`?addonCreditWaitMonths=`) is no value, refused by the rule in the old words,
 * never read as 0 (which `z.coerce.number()` alone would make of it).
 */
const emptyIsNone = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? undefined : value)
export const membershipSettingsQuoteRouteInputSchema = z.object({ addonCreditWaitMonths: z.preprocess(emptyIsNone, z.coerce.number().optional()).optional() })
export type MembershipSettingsQuoteRouteInput = z.infer<typeof membershipSettingsQuoteRouteInputSchema>
export const membershipSettingsQuoteRouteOutputSchema = z.object({
  addonCreditWaitMonths: z.number(),
  herdFlagsToChange: z.number(),
  becomeHerd: z.number(),
  leaveHerd: z.number(),
  message: z.string(),
})
export type MembershipSettingsQuoteRouteOutput = z.infer<typeof membershipSettingsQuoteRouteOutputSchema>

/** `POST membership-settings` (setMembershipSettings; GB19): the period, and the count the control showed. */
export const membershipSettingsSetRouteInputSchema = z.object({ addonCreditWaitMonths: loose, herdFlagsToChange: loose })
export type MembershipSettingsSetRouteInput = z.infer<typeof membershipSettingsSetRouteInputSchema>
export const membershipSettingsSetRouteOutputSchema = z.object({ addonCreditWaitMonths: z.number(), herdFlagsChanged: z.number() })
export type MembershipSettingsSetRouteOutput = z.infer<typeof membershipSettingsSetRouteOutputSchema>
