import { membershipCards, passCards, type MembershipCardView, type PassCardView } from '@/lib/memberships/cards'
import type { MembershipCard, RichText, SessionPassCard } from '@/lib/sanity/schemas'
import type { ShopPass, ShopPlan } from '@/lib/shop/read'

// For the stories of W81's Memberships and SessionPasses modules and their card: Figma's own words (1842:46324,
// 1842:48611) as Sanity's cards would hold them, and the prices Figma draws, which are the live ones (W80a's read),
// put together by the site's own rule (lib/memberships/cards.ts), so a story shows what a page would.

const benefit = (key: string, text: string, showFor: 'both' | 'monthly' | 'yearly' = 'both') => ({ key, text, showFor })

/** WQ86: the third line of every card differs by billing. */
const included = (first: string) => [benefit('b1', first), benefit('b2', 'Personalised sauna hat'), benefit('b3', 'Herd benefits after 6 months', 'monthly'), benefit('b4', 'Immediate Herd benefits', 'yearly')]

export const SAMPLE_MEMBERSHIP_DOCUMENTS: MembershipCard[] = [
  {
    id: 'card-foal',
    name: 'Foal',
    line: '4 Sessions a month',
    corePlan: 'plan-foal-core',
    allAccessPlan: 'plan-foal-all',
    benefits: included('4 Sessions a month'),
    herdBenefits: [benefit('h1', '1 free smoothie per month'), benefit('h2', '3rd group access to free workshops'), benefit('h3', 'Member event and merch pricing')],
  },
  {
    id: 'card-yearling',
    name: 'Yearling',
    line: '8 Sessions a month',
    corePlan: 'plan-yearling-core',
    allAccessPlan: 'plan-yearling-all',
    benefits: included('8 Sessions a month'),
    herdBenefits: [benefit('h1', '2 free Smoothies per month'), benefit('h2', '2nd group access to free workshops'), benefit('h3', 'Member event and merch pricing')],
  },
  {
    id: 'card-champion',
    name: 'Champion',
    line: 'Unlimited sessions',
    corePlan: 'plan-champion-core',
    allAccessPlan: 'plan-champion-all',
    benefits: included('Unlimited sessions'),
    herdBenefits: [
      benefit('h1', '3 free Smoothies per month'),
      benefit('h2', 'First access to free workshops'),
      benefit('h3', 'Member event and merch pricing'),
      benefit('h4', 'Invite to bi-annual Supper Club'),
    ],
  },
]

const plan = (sanityId: string, level: ShopPlan['level'], priceMonthly: string, priceYearly: string, yearlyBefore: string, sessionsPerMonth: ShopPlan['sessionsPerMonth'], addonsIncluded: number): ShopPlan => ({
  sanityId,
  level,
  priceMonthly,
  priceYearly,
  yearlyBefore,
  sessionsPerMonth,
  addonsIncluded,
})

/** The six plans as W80a's read gives them (briefs/W80a-report.md). */
export const SAMPLE_PLANS: ShopPlan[] = [
  plan('plan-champion-all', 'all_access', '149.00', '1600.00', '1788.00', 'unlimited', 4),
  plan('plan-champion-core', 'core', '109.00', '1100.00', '1308.00', 'unlimited', 4),
  plan('plan-foal-all', 'all_access', '59.00', '630.00', '708.00', 4, 1),
  plan('plan-foal-core', 'core', '45.00', '490.00', '540.00', 4, 1),
  plan('plan-yearling-all', 'all_access', '105.00', '1100.00', '1260.00', 8, 2),
  plan('plan-yearling-core', 'core', '79.00', '850.00', '948.00', 8, 2),
]

/** W80a's largest yearly saving: Champion - Core, 15.9%. */
export const SAMPLE_SAVE_UP_TO = 16

export const SAMPLE_MEMBERSHIP_CARDS: MembershipCardView[] = membershipCards({ cards: SAMPLE_MEMBERSHIP_DOCUMENTS, plans: SAMPLE_PLANS })

/** Item 4 of the brief: Foal's All-Access plan is off sale, so its card offers Core alone. */
export const SAMPLE_CARDS_ONE_OPTION: MembershipCardView[] = membershipCards({ cards: SAMPLE_MEMBERSHIP_DOCUMENTS, plans: SAMPLE_PLANS.filter((one) => one.sanityId !== 'plan-foal-all') })

/** No plan has a yearly price: there is nothing to switch between. */
export const SAMPLE_CARDS_MONTHLY_ONLY: MembershipCardView[] = membershipCards({ cards: SAMPLE_MEMBERSHIP_DOCUMENTS, plans: SAMPLE_PLANS.map((one) => ({ ...one, priceYearly: null, yearlyBefore: null })) })

/** Figma's note under the cards, as Sanity's rich text. */
export const SAMPLE_NOTE: RichText = [
  {
    _type: 'block',
    _key: 'n1',
    style: 'normal',
    listItem: null,
    level: null,
    children: [
      {
        _type: 'span',
        _key: 'n1s',
        text: 'Monthly memberships have a 2 month minimum and your Herd benefits start after the first 6 months. Yearly memberships include Herd benefits from day one.',
        marks: [],
      },
    ],
    markDefs: [],
  },
]

export const SAMPLE_PASS_DOCUMENTS: SessionPassCard[] = [
  { id: 'card-5', name: '5 Session', line: 'Session Pass', corePass: 'pass-5-core', allAccessPass: 'pass-5-all' },
  { id: 'card-10', name: '10 Session', line: 'Session Pass', corePass: 'pass-10-core', allAccessPass: 'pass-10-all' },
]

const pass = (sanityId: string, level: ShopPass['level'], price: string, sessions: number, expiryMonths: number): ShopPass => ({ sanityId, level, price, sessions, expiryMonths })

/** The four passes as W80a's read gives them. */
export const SAMPLE_PASSES: ShopPass[] = [pass('pass-10-all', 'all_access', '175.00', 10, 6), pass('pass-10-core', 'core', '135.00', 10, 6), pass('pass-5-all', 'all_access', '90.00', 5, 3), pass('pass-5-core', 'core', '70.00', 5, 3)]

export const SAMPLE_PASS_CARDS: PassCardView[] = passCards({ cards: SAMPLE_PASS_DOCUMENTS, passes: SAMPLE_PASSES })

/** A card whose two passes last differently: its "Valid for" line follows the pass that is chosen. */
export const SAMPLE_PASS_CARDS_TWO_LENGTHS: PassCardView[] = passCards({
  cards: SAMPLE_PASS_DOCUMENTS,
  passes: SAMPLE_PASSES.map((one) => (one.sanityId === 'pass-10-all' ? { ...one, expiryMonths: 12 } : one)),
})
