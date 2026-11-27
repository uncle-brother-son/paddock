import type { SectionSettings } from '@/lib/modules/section'
import type { MembershipCard, RichText, SessionPassCard } from '@/lib/sanity/schemas'
import { poundsWithThousands } from '@/lib/shop/money'
import type { ShopLevel, ShopPass, ShopPlan } from '@/lib/shop/read'

// W81 (WQ84-WQ86): what the Memberships and SessionPasses modules show, made from Sanity's cards (their names, lines
// and benefits) and the Worker's read (W80a: which plans and passes are on sale, every price, a yearly price's
// before-price, how long a pass lasts). Nothing here reads either, and nothing here works a price out: a price is
// only written the way the cards write it.

/** How a membership is paid for. Monthly comes first, on the switch and when the module opens. */
export type Billing = 'monthly' | 'yearly'
export const BILLINGS: readonly Billing[] = ['monthly', 'yearly']
export const BILLING_NAMES: Record<Billing, string> = { monthly: 'Monthly', yearly: 'Yearly' }

/** The two levels a card offers, in the order it lists them: Core is the one chosen at first. */
export type OfferLevel = 'core' | 'allAccess'
export const OFFER_LEVELS: readonly OfferLevel[] = ['core', 'allAccess']

/**
 * What an OfferSelector says for each level, as Figma writes it on every Membership and Session Pass card
 * (1842:46324, 1842:48611): the level's name, and under it which sessions it covers.
 */
export const OFFER_WORDS: Record<OfferLevel, { name: string; description: string }> = {
  core: { name: 'Core', description: 'Off-Peak and Core times' },
  allAccess: { name: 'All-Access', description: 'Every session, including Peak' },
}

/** The level the Worker must have for the plan or pass a card sells under each name. */
const SHOP_LEVEL: Record<OfferLevel, ShopLevel> = { core: 'core', allAccess: 'all_access' }

/** A price as a card writes it ("£490"), and for a yearly one the price it is struck against ("£540"), null with none. */
export type OfferPrice = { price: string; before: string | null }

/** One level of a Membership card: its plan (the Sanity document id), and its price under each billing, null when it can't be bought that way. */
export type PlanOffer = { level: OfferLevel; plan: string; name: string; description: string; prices: Record<Billing, OfferPrice | null> }

/** A benefit and the billing it is listed under (WQ86). */
export type CardBenefit = { key: string; text: string; showFor: 'both' | Billing }

export type MembershipCardView = {
  id: string
  name: string
  /** The line above the name ("4 Sessions a month"), null with none. */
  line: string | null
  /** The levels on sale, Core first: one or two. */
  offers: PlanOffer[]
  benefits: CardBenefit[]
  herdBenefits: CardBenefit[]
}

const words = (value: string | null): string | null => value?.trim() || null

/**
 * The Membership cards the site shows, in Sanity's order. A level is offered when the card names a plan for it, that
 * plan is on sale (it is in the Worker's read, which leaves out one with no price) and is of that level in the
 * database: a card never sells a plan under the other level's name. A card with neither level isn't shown.
 */
export function membershipCards({ cards, plans }: { cards: readonly MembershipCard[]; plans: readonly ShopPlan[] }): MembershipCardView[] {
  const onSale = new Map(plans.map((plan) => [plan.sanityId, plan]))
  return cards.flatMap((card) => {
    const offers = OFFER_LEVELS.flatMap((level): PlanOffer[] => {
      const id = level === 'core' ? card.corePlan : card.allAccessPlan
      const plan = id === null ? undefined : onSale.get(id)
      if (!plan || plan.level !== SHOP_LEVEL[level]) return []
      const monthly = plan.priceMonthly === null ? null : { price: poundsWithThousands(plan.priceMonthly), before: null }
      const yearly = plan.priceYearly === null ? null : { price: poundsWithThousands(plan.priceYearly), before: plan.yearlyBefore === null ? null : poundsWithThousands(plan.yearlyBefore) }
      return [{ level, plan: plan.sanityId, ...OFFER_WORDS[level], prices: { monthly, yearly } }]
    })
    if (offers.length === 0) return []
    const listed = (benefits: MembershipCard['benefits']): CardBenefit[] => benefits.flatMap((benefit) => (benefit.text.trim() ? [{ ...benefit, text: benefit.text.trim() }] : []))
    return [{ id: card.id, name: card.name.trim(), line: words(card.line), offers, benefits: listed(card.benefits), herdBenefits: listed(card.herdBenefits) }]
  })
}

/** The billings at least one card can be bought by, Monthly first: with only one there is nothing to switch between. */
export const billingsOf = (cards: readonly MembershipCardView[]): Billing[] => BILLINGS.filter((billing) => cards.some((card) => card.offers.some((offer) => offer.prices[billing] !== null)))

/** A level of a card as it is offered under one billing. */
export type BilledOffer = { level: OfferLevel; plan: string; name: string; description: string } & OfferPrice

/** A card under one billing: the levels that can be bought that way, and the benefits listed for it. */
export type BilledCard = { id: string; name: string; line: string | null; offers: BilledOffer[]; benefits: CardBenefit[]; herdBenefits: CardBenefit[] }

/** The cards as they are under one billing. A card with no level to buy that way isn't shown under it. */
export function cardsFor(cards: readonly MembershipCardView[], billing: Billing): BilledCard[] {
  const listed = (benefits: readonly CardBenefit[]) => benefits.filter((benefit) => benefit.showFor === 'both' || benefit.showFor === billing)
  return cards.flatMap((card) => {
    const offers = card.offers.flatMap(({ prices, ...offer }): BilledOffer[] => {
      const price = prices[billing]
      return price ? [{ ...offer, ...price }] : []
    })
    return offers.length === 0 ? [] : [{ id: card.id, name: card.name, line: card.line, offers, benefits: listed(card.benefits), herdBenefits: listed(card.herdBenefits) }]
  })
}

/**
 * The level chosen on a card: the one the visitor picked while it is offered, and Core at first (the first level
 * offered, when the card has no Core or the pick can't be bought under this billing).
 */
export function chosenLevel(offers: readonly { level: OfferLevel }[], picked: OfferLevel | undefined): OfferLevel {
  return offers.find((offer) => offer.level === picked)?.level ?? offers[0]?.level ?? 'core'
}

/** WQ85: the line under the switch, with W80a's largest yearly saving. */
export const saveUpToLine = (percent: number): string => `Save up to ${percent}% yearly`

/** The words over a card's Herd list (Figma: HerdFeatures' Title). */
export const HERD_BENEFITS_TITLE = 'Herd benefits'

/** One level of a Session Pass card: its pass (the Sanity document id), its price, and how long the pass lasts. */
export type PassOffer = { level: OfferLevel; pass: string; name: string; description: string; price: string; validFor: string }

export type PassCardView = { id: string; name: string; line: string | null; offers: PassOffer[] }

/** W80a's expiry as a card writes it: "Valid for 3 months". */
export const validForLine = (months: number): string => `Valid for ${months} ${months === 1 ? 'month' : 'months'}`

/** The Session Pass cards the site shows, in Sanity's order, by the same rule as the Membership cards. */
export function passCards({ cards, passes }: { cards: readonly SessionPassCard[]; passes: readonly ShopPass[] }): PassCardView[] {
  const onSale = new Map(passes.map((pass) => [pass.sanityId, pass]))
  return cards.flatMap((card) => {
    const offers = OFFER_LEVELS.flatMap((level): PassOffer[] => {
      const id = level === 'core' ? card.corePass : card.allAccessPass
      const pass = id === null ? undefined : onSale.get(id)
      if (!pass || pass.level !== SHOP_LEVEL[level]) return []
      return [{ level, pass: pass.sanityId, ...OFFER_WORDS[level], price: poundsWithThousands(pass.price), validFor: validForLine(pass.expiryMonths) }]
    })
    return offers.length === 0 ? [] : [{ id: card.id, name: card.name.trim(), line: words(card.line), offers }]
  })
}

/** Whether a rich text has any words: a note of empty paragraphs is no note. */
export const hasWords = (text: RichText): boolean => text.some((block) => block.children.some((span) => span.text.trim() !== ''))

/** What the Memberships module is given: its section, its heading (for screen readers), the saving, the cards and the note. */
export type MembershipsContent = SectionSettings & { heading: string | null; saveUpTo: number | null; cards: MembershipCardView[]; note: RichText }

/** What the SessionPasses module is given: its section, its heading (for screen readers) and the cards. */
export type SessionPassesContent = SectionSettings & { heading: string | null; cards: PassCardView[] }
