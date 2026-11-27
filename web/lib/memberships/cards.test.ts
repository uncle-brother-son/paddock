import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { childNamed, readGlobalsCss, ruleNamed } from '@/lib/design/read-stylesheet'
import { DEFAULT_SECTION_IDS } from '@/lib/modules/section'
import { reads } from '@/lib/sanity/read'
import answers from '@/lib/sanity/sample-answers.json'
import { contentPageSchema, type MembershipCard, type SessionPassCard } from '@/lib/sanity/schemas'
import { pounds, poundsWithThousands } from '@/lib/shop/money'
import type { ShopPass, ShopPlan } from '@/lib/shop/read'

import { cardPlansLine, checkCardPlans, checkSectionIdUnique, checkSectionLink, sectionIdsOf, type PageModuleValue } from '../../../studio/lib/checks'
import { WEBHOOK_FIELDS } from '../../scripts/check-fast-level.mjs'

import { billingsOf, cardsFor, chosenLevel, hasWords, membershipCards, OFFER_WORDS, passCards, saveUpToLine, validForLine } from './cards'

// Brief W81 (WQ84-WQ86): the Memberships and SessionPasses modules. Sanity's cards are its own answer
// (lib/sanity/read.test.ts): made by its query engine over the documents in briefs/W81-logs/tools/gen-page-samples.mjs
// (staff app repo). The Worker's side is W80a's shape (server/rules/shop/memberships.ts), with the live prices.

const WEB = path.resolve(__dirname, '../..')
const source = (file: string) => readFileSync(path.join(WEB, file), 'utf8')
const studioFile = (file: string) => readFileSync(path.join(WEB, '../studio', file), 'utf8')

const plan = (sanityId: string, level: ShopPlan['level'], priceMonthly: string | null, priceYearly: string | null, yearlyBefore: string | null): ShopPlan => ({
  sanityId,
  level,
  priceMonthly,
  priceYearly,
  yearlyBefore,
  sessionsPerMonth: 4,
  addonsIncluded: 1,
})

/** The sample cards' plans as the Worker reads them: Foal's two, and Champion's Core. */
const PLANS: ShopPlan[] = [
  plan('plan-champion-core', 'core', '109.00', '1100.00', '1308.00'),
  plan('plan-foal-all', 'all_access', '59.00', '630.00', '708.00'),
  plan('plan-foal-core', 'core', '45.00', '490.00', '540.00'),
]

const pass = (sanityId: string, level: ShopPass['level'], price: string, expiryMonths: number): ShopPass => ({ sanityId, level, price, sessions: 5, expiryMonths })

const PASSES: ShopPass[] = [pass('pass-5-all', 'all_access', '90.00', 3), pass('pass-5-core', 'core', '70.00', 3)]

const CARDS: MembershipCard[] = answers.membershipCards as MembershipCard[]
const PASS_CARDS: SessionPassCard[] = answers.sessionPassCards as SessionPassCard[]

describe("Sanity's cards", () => {
  it('come in their Order, then the first made; a draft and a card with no name are not read', () => {
    expect(CARDS.map((card) => card.id)).toEqual(['card-champion', 'card-foal', 'card-yearling'])
    expect(PASS_CARDS.map((card) => card.id)).toEqual(['card-5', 'card-10'])
    for (const query of [reads.membershipCards.query, reads.sessionPassCards.query]) {
      expect(query).toContain('!(_id in path("drafts.**")) && defined(name)')
      expect(query).toContain('order(coalesce(order, 1000000) asc, _createdAt asc)')
    }
  })

  it("carry their plans' document ids: none chosen, a draft or a document that is gone is null", () => {
    expect(CARDS.map((card) => [card.corePlan, card.allAccessPlan])).toEqual([
      ['plan-champion-core', null],
      ['plan-foal-core', 'plan-foal-all'],
      [null, null],
    ])
    expect(PASS_CARDS.map((card) => [card.corePass, card.allAccessPass])).toEqual([
      ['pass-5-core', 'pass-5-all'],
      [null, null],
    ])
  })

  it('WQ86: a benefit shows for both, monthly or yearly; any other word is both, and one with no words is left out', () => {
    expect(CARDS[1]!.benefits.map((benefit) => [benefit.key, benefit.showFor])).toEqual([
      ['b1', 'both'],
      ['b2', 'monthly'],
      ['b3', 'yearly'],
      ['b5', 'both'],
    ])
    expect(CARDS[1]!.herdBenefits).toEqual([{ key: 'h1', text: '1 free smoothie per month', showFor: 'both' }])
  })

  it('never hold a price, and the queries ask for none', () => {
    for (const query of [reads.membershipCards.query, reads.sessionPassCards.query]) expect(query).not.toMatch(/price|stripe/i)
    for (const file of ['schemaTypes/membershipCard.ts', 'schemaTypes/sessionPassCard.ts', 'schemaTypes/objects/memberships.ts', 'schemaTypes/objects/sessionPasses.ts']) {
      expect(studioFile(file), file).not.toMatch(/name: '[a-zA-Z]*(price|amount|saving)[a-zA-Z]*'/i)
    }
  })
})

describe('the Membership cards the site shows', () => {
  const shown = membershipCards({ cards: CARDS, plans: PLANS })

  it('a card with no plan on sale is not shown; a level with no plan is not offered; the order is kept', () => {
    // Yearling names no plan; Champion's All-Access is only a draft in Sanity.
    expect(shown.map((card) => [card.id, card.offers.map((offer) => offer.level)])).toEqual([
      ['card-champion', ['core']],
      ['card-foal', ['core', 'allAccess']],
    ])
    expect(shown[0]).toMatchObject({ name: 'Champion', line: null, benefits: [], herdBenefits: [] })
    expect(shown[1]).toMatchObject({ name: 'Foal', line: '4 Sessions a month' })
  })

  it('every level says what Figma writes for it, with its plan and its prices as the cards write them', () => {
    expect(shown[1]!.offers).toEqual([
      { level: 'core', plan: 'plan-foal-core', name: 'Core', description: 'Off-Peak and Core times', prices: { monthly: { price: '£45', before: null }, yearly: { price: '£490', before: '£540' } } },
      { level: 'allAccess', plan: 'plan-foal-all', name: 'All-Access', description: 'Every session, including Peak', prices: { monthly: { price: '£59', before: null }, yearly: { price: '£630', before: '£708' } } },
    ])
    // Thousands are marked, as Figma writes "£1,308" and "£1,100".
    expect(shown[0]!.offers[0]!.prices.yearly).toEqual({ price: '£1,100', before: '£1,308' })
    expect(OFFER_WORDS.core.name).toBe('Core')
  })

  it('a plan that is off sale (not in the read) is not offered; with neither on sale the card is not shown; nothing throws', () => {
    const foalCoreOnly = membershipCards({ cards: CARDS, plans: PLANS.filter((one) => one.sanityId !== 'plan-foal-all') })
    expect(foalCoreOnly.map((card) => [card.id, card.offers.map((offer) => offer.level)])).toEqual([
      ['card-champion', ['core']],
      ['card-foal', ['core']],
    ])
    expect(membershipCards({ cards: CARDS, plans: PLANS.filter((one) => one.sanityId === 'plan-foal-all') }).map((card) => [card.id, card.offers.map((offer) => offer.level)])).toEqual([['card-foal', ['allAccess']]])
    expect(membershipCards({ cards: CARDS, plans: [] })).toEqual([])
    expect(membershipCards({ cards: [], plans: PLANS })).toEqual([])
  })

  it('a card never sells a plan under the other level\'s name: the database\'s level must be the one the card gives it', () => {
    const swapped = PLANS.map((one) => (one.sanityId === 'plan-foal-core' ? { ...one, level: 'all_access' as const } : one.sanityId === 'plan-champion-core' ? { ...one, level: null } : one))
    expect(membershipCards({ cards: CARDS, plans: swapped }).map((card) => [card.id, card.offers.map((offer) => offer.plan)])).toEqual([['card-foal', ['plan-foal-all']]])
    // One plan chosen for both levels is offered once, under its own.
    const twice: MembershipCard[] = [{ ...CARDS[1]!, allAccessPlan: 'plan-foal-core' }]
    expect(membershipCards({ cards: twice, plans: PLANS })[0]!.offers.map((offer) => [offer.level, offer.plan])).toEqual([['core', 'plan-foal-core']])
  })

  it('a yearly price that saves nothing has no before-price; a plan with one price is offered under that billing only', () => {
    const plans = [plan('plan-foal-core', 'core', '45.00', '540.00', null), plan('plan-foal-all', 'all_access', '59.00', null, null), plan('plan-champion-core', 'core', null, '1100.00', null)]
    const cards = membershipCards({ cards: CARDS, plans })
    expect(cards[1]!.offers.map((offer) => offer.prices)).toEqual([
      { monthly: { price: '£45', before: null }, yearly: { price: '£540', before: null } },
      { monthly: { price: '£59', before: null }, yearly: null },
    ])
    expect(billingsOf(cards)).toEqual(['monthly', 'yearly'])
    // Monthly: Champion can't be bought monthly, so it is not shown; Foal offers both levels.
    expect(cardsFor(cards, 'monthly').map((card) => [card.id, card.offers.map((offer) => offer.level)])).toEqual([['card-foal', ['core', 'allAccess']]])
    // Yearly: Foal's All-Access has no yearly price, so only Core is offered.
    expect(cardsFor(cards, 'yearly').map((card) => [card.id, card.offers.map((offer) => `${offer.level} ${offer.price}`)])).toEqual([
      ['card-champion', ['core £1,100']],
      ['card-foal', ['core £540']],
    ])
  })

  it('Monthly comes first; with only one billing to buy by there is one, and with none there is nothing', () => {
    expect(billingsOf(shown)).toEqual(['monthly', 'yearly'])
    const monthlyOnly = membershipCards({ cards: CARDS, plans: PLANS.map((one) => ({ ...one, priceYearly: null, yearlyBefore: null })) })
    expect(billingsOf(monthlyOnly)).toEqual(['monthly'])
    expect(billingsOf(membershipCards({ cards: CARDS, plans: PLANS.map((one) => ({ ...one, priceMonthly: null })) }))).toEqual(['yearly'])
    expect(billingsOf([])).toEqual([])
  })

  it('WQ86: under a billing a card lists the benefits for both and for that billing, in order', () => {
    const texts = (billing: 'monthly' | 'yearly') => cardsFor(shown, billing)[1]!.benefits.map((benefit) => benefit.text)
    expect(texts('monthly')).toEqual(['4 Sessions a month', 'Herd benefits after 6 months', 'Personalised sauna hat'])
    expect(texts('yearly')).toEqual(['4 Sessions a month', 'Immediate Herd benefits', 'Personalised sauna hat'])
    expect(cardsFor(shown, 'yearly')[1]!.herdBenefits.map((benefit) => benefit.text)).toEqual(['1 free smoothie per month'])
    expect(cardsFor(shown, 'yearly')[1]!.offers[0]).toEqual({ level: 'core', plan: 'plan-foal-core', name: 'Core', description: 'Off-Peak and Core times', price: '£490', before: '£540' })
    expect(cardsFor(shown, 'monthly')[1]!.offers[0]).toMatchObject({ price: '£45', before: null })
  })

  it('Core is chosen at first; a pick stays while it is offered; a card with no Core starts on what it has', () => {
    const both = [{ level: 'core' as const }, { level: 'allAccess' as const }]
    expect(chosenLevel(both, undefined)).toBe('core')
    expect(chosenLevel(both, 'allAccess')).toBe('allAccess')
    expect(chosenLevel([{ level: 'allAccess' }], undefined)).toBe('allAccess')
    expect(chosenLevel([{ level: 'core' }], 'allAccess')).toBe('core')
  })

  it('WQ85: "Save up to N% yearly" is written from the Worker\'s number; a note of empty paragraphs is no note', () => {
    expect(saveUpToLine(16)).toBe('Save up to 16% yearly')
    const page = contentPageSchema.parse(answers.contentPage)
    const notes = page.modules.flatMap((one) => (one.type === 'memberships' ? [one.note] : []))
    expect(notes.map(hasWords)).toEqual([true, false])
    expect(hasWords([{ ...notes[0]![0]!, children: [{ ...notes[0]![0]!.children[0]!, text: '  ' }] }])).toBe(false)
  })
})

describe('the Session Pass cards the site shows', () => {
  it('each level with its pass, its price and how long it lasts; a card with no pass on sale is not shown', () => {
    expect(passCards({ cards: PASS_CARDS, passes: PASSES })).toEqual([
      {
        id: 'card-5',
        name: '5 Session',
        line: 'Session Pass',
        offers: [
          { level: 'core', pass: 'pass-5-core', name: 'Core', description: 'Off-Peak and Core times', price: '£70', validFor: 'Valid for 3 months' },
          { level: 'allAccess', pass: 'pass-5-all', name: 'All-Access', description: 'Every session, including Peak', price: '£90', validFor: 'Valid for 3 months' },
        ],
      },
    ])
  })

  it('a pass off sale, or of the other level, is not offered; nothing throws', () => {
    expect(passCards({ cards: PASS_CARDS, passes: [PASSES[1]!] })[0]!.offers.map((offer) => offer.level)).toEqual(['core'])
    expect(passCards({ cards: PASS_CARDS, passes: [{ ...PASSES[1]!, level: 'all_access' }] })).toEqual([])
    expect(passCards({ cards: PASS_CARDS, passes: [] })).toEqual([])
    expect([validForLine(1), validForLine(6)]).toEqual(['Valid for 1 month', 'Valid for 6 months'])
  })
})

describe('prices on the cards', () => {
  it('are written with their thousands marked, and are text from first to last', () => {
    expect(['45.00', '490.00', '1308.00', '1100.50', '12345.00', '1000000.00'].map(poundsWithThousands)).toEqual(['£45', '£490', '£1,308', '£1,100.50', '£12,345', '£1,000,000'])
    // Below a thousand it is `pounds`.
    for (const money of ['0.00', '70.00', '999.99']) expect(poundsWithThousands(money)).toBe(pounds(money))
  })

  const files = [
    'lib/memberships/cards.ts',
    'lib/memberships/pages.ts',
    'components/modules/MembershipsModule.tsx',
    'components/modules/content/Memberships.tsx',
    'components/modules/content/SessionPasses.tsx',
    'components/modules/content/PlanCardRow.tsx',
    ...readdirSync(path.join(WEB, 'components/components/memberships'))
      .filter((name) => /\.tsx?$/.test(name) && !/\.stories\./.test(name))
      .map((name) => `components/components/memberships/${name}`),
  ]

  it('nothing in the modules works a price out, reads the database or names Stripe: every figure is the read\'s', () => {
    expect(files).toContain('components/components/memberships/OfferSelector.tsx')
    for (const file of files) {
      const code = source(file)
      expect(code, file).not.toMatch(/['"](@\/server|(\.\.\/)+server)[/'"]/)
      expect(code, file).not.toMatch(/parseFloat|parseInt|toFixed|Number\(|Math\.|stripe/i)
    }
    // The one way in: lib/shop/read.ts, kept as the shop is.
    expect(source('lib/memberships/pages.ts')).toContain("import { readShopMembershipsKept } from '@/lib/shop/read'")
    expect(source('lib/shop/read.ts')).toContain("unstable_cache(async (): Promise<ShopMemberships> => readShopMemberships(), ['shop-memberships'], { revalidate: SHOP_KEPT_SECONDS })")
  })

  it('Add to bag hands the bag the plan and the billing, or the pass: never a price', () => {
    expect(source('components/modules/content/Memberships.tsx')).toContain('onAdd({ membershipPlan: chosen.plan, billing })')
    expect(source('components/modules/content/SessionPasses.tsx')).toContain('onAdd({ sessionPass: chosen.pass })')
    expect(source('lib/shop/bag.ts')).toContain("export type MembershipLine = { membershipPlan: string; billing: 'monthly' | 'yearly' }")
    expect(source('lib/shop/bag.ts')).toContain('export type SessionPassLine = { sessionPass: string }')
  })
})

describe('the modules on a page', () => {
  const page = contentPageSchema.parse(answers.contentPage)

  it("an editor gives Memberships a heading and a note, Session Passes a heading; each has its section's settings", () => {
    expect(page.modules.filter((one) => one.type === 'memberships' || one.type === 'sessionPasses').map((one) => [one.key, one.heading, one.theme, one.sectionId])).toEqual([
      ['mb1', 'Memberships', 'dark', null],
      ['mb2', null, null, null],
      ['sp1', 'Session Passes', null, 'session-passes'],
      ['sp2', null, null, null],
    ])
  })

  it('WQ83: with no ID of its own, the first Memberships module is `memberships` and the first Session Passes module `passes`', () => {
    expect(DEFAULT_SECTION_IDS).toEqual({ memberships: 'memberships', sessionPasses: 'passes' })
    const modules = source('components/modules/PageModules.tsx')
    expect(modules).toContain('sectionId={one.section.sectionId ?? (index === firstMemberships ? DEFAULT_SECTION_IDS.memberships : null)}')
    expect(modules).toContain('sectionId={one.section.sectionId ?? (index === firstPasses ? DEFAULT_SECTION_IDS.sessionPasses : null)}')
    expect(modules).toContain("const firstMemberships = shown.findIndex((one) => one.kind === 'memberships')")
    expect(modules).toContain("const firstPasses = shown.findIndex((one) => one.kind === 'passes')")
  })

  it('WQ91: every theme, as W80\'s modules: the site takes the section as given and the Studio offers all four', () => {
    const modules = source('components/modules/PageModules.tsx')
    expect(modules).toContain("return [{ key, kind: 'memberships', heading: module.heading, note: module.note, section: sectionSettings(module) }]")
    expect(modules).toContain("return [{ key, kind: 'passes', heading: module.heading, section: sectionSettings(module) }]")
    for (const name of ['memberships', 'sessionPasses']) expect(studioFile(`schemaTypes/objects/${name}.ts`), name).not.toMatch(/themes:|theme:/)
    expect(studioFile('schemaTypes/fields/sectionSettings.ts')).toContain("options: { list: THEMES, layout: 'radio', direction: 'horizontal' },")
    expect(source('../web/docs/build-standards.md')).toContain('Except the Memberships and SessionPasses modules: every theme, as drawn; Wayne accepts their muted words on Mud at 3.55:1, and on Fjord at 3.64:1 the same way (WQ91).')
  })

  it('the Studio knows those ids: a second section cannot take one, and a link can go to one', () => {
    const PAGE: PageModuleValue[] = [
      { _key: 'a', _type: 'pageHeader' },
      { _key: 'b', _type: 'memberships' },
      { _key: 'c', _type: 'memberships' },
      { _key: 'd', _type: 'sessionPasses', sectionId: 'session-passes' },
      { _key: 'e', _type: 'sessionPasses' },
      { _key: 'f', _type: 'textBlock' },
    ]
    // The first of each kind has its id by default; a first one with an id of its own does not, and nor does the second.
    expect(sectionIdsOf(PAGE)).toEqual([
      { key: 'b', id: 'memberships' },
      { key: 'd', id: 'session-passes' },
    ])
    expect(checkSectionIdUnique('memberships', 'f', PAGE)).toBe('Another section on this page is "memberships" (the Memberships module is, unless it has an ID of its own).')
    expect(checkSectionIdUnique('passes', 'f', PAGE)).toBe(true)
    expect(checkSectionIdUnique('memberships', 'b', PAGE)).toBe(true)
    const passesByDefault = PAGE.map((one) => (one._key === 'd' ? { _key: 'd', _type: 'sessionPasses' } : one))
    expect(checkSectionIdUnique('passes', 'f', passesByDefault)).toBe('Another section on this page is "passes" (the Session Passes module is, unless it has an ID of its own).')
    // An id somebody typed is named plainly.
    expect(checkSectionIdUnique('session-passes', 'f', PAGE)).toBe('Another section on this page has the ID "session-passes".')
    const link = (sectionId: string) => ({ destination: 'section', sectionId })
    expect(checkSectionLink(link('memberships'), 'contentPage', PAGE)).toBe(true)
    expect(checkSectionLink(link('passes'), 'contentPage', passesByDefault)).toBe(true)
    expect(checkSectionLink(link('passes'), 'contentPage', PAGE)).toContain('No section on this page has the ID "passes"')
  })

  it('the row of cards: 5 of 6 columns on a phone; from 768px the cards share the row and none is narrower than Figma\'s narrowest', () => {
    const css = readGlobalsCss()
    const base = childNamed(css, '@layer base')
    const root = childNamed(base, ':root').declarations
    const desktop = childNamed(childNamed(base, '@media (width >= 48rem)'), ':root').declarations
    expect([root['--plan-card-columns'], root['--plan-cards-share'], desktop['--plan-cards-share']]).toEqual(['5', '0', '1'])
    const strip = ruleNamed(css, '@utility plan-strip').declarations
    expect(strip['--plan-card-least']).toBe('297px')
    expect(strip['--plan-card-alone']).toBe('calc(var(--plan-card-columns) * var(--plan-column) + (var(--plan-card-columns) - 1) * var(--grid-gutter))')
    expect(strip['--plan-inset']).toBe('calc(var(--plan-cards-share) * var(--plan-inset-columns, 0) * (var(--plan-column) + var(--grid-gutter)))')
    expect(strip['overflow-x']).toBe('auto')
    expect(ruleNamed(css, '@utility plan-card').declarations.width).toBe('calc(var(--plan-cards-share) * var(--plan-card-shared) + (1 - var(--plan-cards-share)) * var(--plan-card-alone))')
    // Figma's empty columns each side: one for the memberships (three cards in 22), four for the passes (two in 16).
    expect(source('components/modules/content/Memberships.tsx')).toContain('const INSET_COLUMNS = 1')
    expect(source('components/modules/content/Memberships.tsx')).toContain('const CARDS_DRAWN = 3')
    expect(source('components/modules/content/SessionPasses.tsx')).toContain('const INSET_COLUMNS = 4')
    expect(source('components/modules/content/SessionPasses.tsx')).toContain('const CARDS_DRAWN = 2')
    // With fewer cards than Figma draws each keeps its drawn share of the row; with more they share it.
    expect(source('components/modules/content/PlanCardRow.tsx')).toContain('const sharedBy = cards.length > drawn ? cards.length : drawn')
    // The keyboard brings a card that is partly off the screen into the strip; a pointer's press moves nothing.
    expect(source('components/modules/content/PlanCardRow.tsx')).toContain("if (document.documentElement.dataset.input === 'pointer') return")
    expect(source('components/modules/content/PlanCardRow.tsx')).toContain('onFocus={bringCardIntoView}')
  })
})

describe('the Studio', () => {
  it('has the two card documents and the two modules, registered, on a page and in the desk beside the plans', () => {
    const index = studioFile('schemaTypes/index.ts')
    for (const name of ['membershipCard', 'sessionPassCard', 'planBenefit', 'memberships', 'sessionPasses']) expect(index, name).toMatch(new RegExp(`\\n  ${name},\\n`))
    const page = studioFile('schemaTypes/contentPage.ts')
    for (const name of ['memberships', 'sessionPasses']) {
      expect(page, name).toContain(`defineArrayMember({ type: '${name}' })`)
      const schema = studioFile(`schemaTypes/objects/${name}.ts`)
      expect(schema, name).toContain("import { sectionFields, sectionFieldset } from '../fields/sectionSettings'")
      expect(schema, name).toContain('fieldsets: [sectionFieldset],')
      expect(schema, name).toMatch(/\.\.\.sectionFields\(/)
    }
    expect(studioFile('schemaTypes/objects/memberships.ts')).toMatch(/name: 'note',\s+title: 'Note under the cards',\s+type: 'richText',/)
    const desk = studioFile('structure.ts')
    for (const type of ['membershipCard', 'membershipPlan', 'sessionPassCard', 'sessionPassType']) expect(desk, type).toContain(`S.documentTypeList('${type}')`)
    expect(desk.indexOf("S.documentTypeList('membershipCard')")).toBeLessThan(desk.indexOf("S.documentTypeList('membershipPlan')"))
    expect(desk.match(/defaultOrdering\(\[\{field: 'order', direction: 'asc'\}\]\)/g)).toHaveLength(3)
  })

  it('a Membership has its name, line, two plans, benefits, Herd benefits and order; a Session Pass its name, line, two passes and order', () => {
    const fields = (file: string) => [...studioFile(file).matchAll(/defineField\(\{\s*name: '([a-zA-Z]+)'/g)].map((match) => match[1])
    expect(fields('schemaTypes/membershipCard.ts')).toEqual(['text', 'showFor', 'name', 'line', 'corePlan', 'allAccessPlan', 'benefits', 'herdBenefits', 'order'])
    expect(fields('schemaTypes/sessionPassCard.ts')).toEqual(['name', 'line', 'corePass', 'allAccessPass', 'order'])
    const membership = studioFile('schemaTypes/membershipCard.ts')
    expect(membership.match(/to: \[\{ type: 'membershipPlan' \}\]/g)).toHaveLength(2)
    expect(studioFile('schemaTypes/sessionPassCard.ts').match(/to: \[\{ type: 'sessionPassType' \}\]/g)).toHaveLength(2)
    // WQ86: Show for both, monthly or yearly; both unless an editor says.
    expect([...membership.matchAll(/value: '([a-z]+)' \}/g)].map((match) => match[1])).toEqual(['both', 'monthly', 'yearly'])
    expect(membership).toContain("initialValue: 'both'")
  })

  it("a card's two levels are two documents; its line in a list is its two plans", () => {
    expect(checkCardPlans({ _ref: 'a' }, { _ref: 'b' }, 'plan')).toBe(true)
    expect(checkCardPlans(undefined, { _ref: 'b' }, 'plan')).toBe(true)
    expect(checkCardPlans({ _ref: 'a' }, undefined, 'pass')).toBe(true)
    expect(checkCardPlans({ _ref: 'a' }, { _ref: 'a' }, 'plan')).toBe('This is the same plan as Core. Choose a different plan for each, or leave one empty.')
    expect(checkCardPlans({ _ref: 'a' }, { _ref: 'a' }, 'pass')).toContain('the same pass as Core')
    expect(cardPlansLine('Foal - Core', 'Foal - All-Access', 'plan')).toBe('Foal - Core · Foal - All-Access')
    expect(cardPlansLine(undefined, '5 Session - All-Access', 'pass')).toBe('5 Session - All-Access')
    expect(cardPlansLine(undefined, ' ', 'pass')).toBe('No pass chosen yet: the site does not show this card')
  })

  it("webhook safety: the Worker's Sanity webhook reads neither card, neither module and no benefit, and a plan's and a pass's fields are as they were", () => {
    const read = Object.keys(WEBHOOK_FIELDS)
    for (const name of ['membershipCard', 'sessionPassCard', 'planBenefit', 'memberships', 'sessionPasses']) expect(read, name).not.toContain(name)
    // What it does read of a plan and of a pass, and nothing of them was changed for the cards.
    expect([WEBHOOK_FIELDS.membershipPlan, WEBHOOK_FIELDS.sessionPassType]).toEqual([
      ['name', 'images'],
      ['name', 'images'],
    ])
    const webhook = source('app/api/sanity/webhook/route.ts')
    for (const name of ['membershipCard', 'sessionPassCard', 'planBenefit', 'corePlan', 'allAccessPlan', 'corePass', 'herdBenefits', 'sessionPasses']) expect(webhook, name).not.toContain(name)
    // It acts on its own seven types and the categories, and on nothing else it is sent.
    expect(webhook).toContain("new Set<SanityKind>(['serviceType', 'product', 'addon', 'membershipPlan', 'sessionPassType', 'giftCardType', 'event'])")
    expect(webhook).toContain('if (!_type || !CATALOG_TYPES.has(_type)) {')
    // The filter Sanity is set up with names none of the new types.
    const setup = readFileSync(path.join(WEB, '../WEBHOOK-SETUP.md'), 'utf8')
    expect(setup).toContain('`_type in ["serviceType", "product", "addon", "membershipPlan", "sessionPassType", "giftCardType", "event", "productCategory"]`')
    for (const file of ['schemaTypes/membershipPlan.ts', 'schemaTypes/sessionPassType.ts']) expect(studioFile(file), file).not.toMatch(/membershipCard|sessionPassCard/)
  })
})
