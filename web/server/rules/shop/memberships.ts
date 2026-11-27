// Brief W80a (WQ84-WQ86): what the website reads about the memberships and the session passes. Reads only. Names,
// descriptions and benefits are Sanity's (the Membership and Session Pass cards): each row is joined to its document by
// its Sanity id, so a row with none is left out (it has no card).
//
// The one thing worked out here is WQ85's: a yearly price's "before" is 12 times the monthly price, given only when the
// yearly price is less, and "Save up to N%" is the largest of those savings across the plans on sale, rounded. Every
// row is built field by field: never a Stripe id or a database id.
import 'server-only'
import type { Queryable } from '@/server/db'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { listPlans } from '@/server/rules/catalog/plans'
import { listPassTypes } from '@/server/rules/catalog/passes-gift-cards'
import { pence } from './display-prices'

export type ShopLevel = 'core' | 'all_access'

export interface ShopPlan {
  sanityId: string
  /** Null only for a plan saved with no level (the staff app allows it; none live). */
  level: ShopLevel | null
  /** Money text ("45.00"). Null when the plan has no price for that billing: it can't be bought that way. */
  priceMonthly: string | null
  priceYearly: string | null
  /** WQ85: 12 times the monthly price, struck through beside the yearly price; null unless the yearly price is less. */
  yearlyBefore: string | null
  /** Sessions a month, or 'unlimited'. */
  sessionsPerMonth: number | 'unlimited'
  addonsIncluded: number
}

export interface ShopPass {
  sanityId: string
  level: ShopLevel
  /** Money text ("50.00"). */
  price: string
  sessions: number
  /** How long a pass lasts from the day it is bought: "Valid for N months". */
  expiryMonths: number
}

export interface ShopMemberships {
  /** By name. */
  plans: ShopPlan[]
  /** WQ85: "Save up to N%", the largest yearly saving, a whole percent; null when no plan's yearly price saves. */
  saveUpTo: number | null
  /** By name. */
  passes: ShopPass[]
}

/** The customer channel's columns used here (catalog/plans.ts): plans on sale and set up in Stripe. */
type PlanRow = {
  sanity_plan_id: string | null
  level: ShopLevel | null
  price_monthly: string | null
  price_yearly: string | null
  sessions_included: number | null
  is_unlimited: boolean
  addons_included: number | null
}

/** The customer channel's columns used here (catalog/passes-gift-cards.ts): pass types on sale. */
type PassRow = { sanity_pass_type_id: string | null; level: ShopLevel; price: string | null; sessions_included: number | null; expiry_months: number }

const moneyText = (wholePence: number): string => (wholePence / 100).toFixed(2)

/** WQ85: 12 times the monthly price, when the yearly price is less than that. */
const yearlyBeforeOf = (monthly: string | null, yearly: string | null): string | null =>
  monthly !== null && yearly !== null && pence(yearly) < 12 * pence(monthly) ? moneyText(12 * pence(monthly)) : null

/** The percent of the before-price a yearly price saves, not rounded (pence times 100 first, so 15.5 is exactly that). */
const savingOf = (plan: ShopPlan): number | null =>
  plan.yearlyBefore === null || plan.priceYearly === null ? null : ((pence(plan.yearlyBefore) - pence(plan.priceYearly)) * 100) / pence(plan.yearlyBefore)

/** Every plan on sale with a Sanity document. A plan with no price at all can't be bought, so it is left out. */
export async function listShopPlans(db: Queryable): Promise<ShopPlan[]> {
  const rows = (await listPlans(db, { channel: 'customer' })) as unknown as PlanRow[]
  return rows.flatMap((row): ShopPlan[] => {
    if (row.sanity_plan_id === null || (row.price_monthly === null && row.price_yearly === null)) return []
    return [
      {
        sanityId: row.sanity_plan_id,
        level: row.level,
        priceMonthly: row.price_monthly,
        priceYearly: row.price_yearly,
        yearlyBefore: yearlyBeforeOf(row.price_monthly, row.price_yearly),
        sessionsPerMonth: row.is_unlimited ? 'unlimited' : (row.sessions_included ?? 0),
        addonsIncluded: row.addons_included ?? 0,
      },
    ]
  })
}

/** WQ85: the largest saving of a yearly price against 12 times the monthly, rounded to a whole percent. */
export function saveUpTo(plans: readonly ShopPlan[]): number | null {
  const savings = plans.map(savingOf).filter((saving): saving is number => saving !== null)
  return savings.length === 0 ? null : Math.round(Math.max(...savings))
}

/** Every pass type on sale with a Sanity document. One with no price or no sessions can't be sold, so it is left out. */
export async function listShopPasses(db: Queryable): Promise<ShopPass[]> {
  const rows = (await listPassTypes(db, undefined, { channel: 'customer' })) as unknown as PassRow[]
  return rows.flatMap((row): ShopPass[] =>
    row.sanity_pass_type_id === null || row.price === null || row.sessions_included === null
      ? []
      : [{ sanityId: row.sanity_pass_type_id, level: row.level, price: row.price, sessions: row.sessions_included, expiryMonths: row.expiry_months }],
  )
}

export async function shopMemberships(db: Queryable): Promise<ShopMemberships> {
  const plans = await listShopPlans(db)
  return { plans, saveUpTo: saveUpTo(plans), passes: await listShopPasses(db) }
}

/** The plans, the saving and the passes on a connection of its own, for a page to call (no HTTP). */
export async function readShopMemberships(): Promise<ShopMemberships> {
  const db = openRequestDb()
  try {
    return await shopMemberships(db)
  } finally {
    await closeRequestDb(db)
  }
}
