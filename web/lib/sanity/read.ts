import { createClient } from '@sanity/client'
import { z } from 'zod'
import {
  ADDONS_QUERY,
  CONTENT_PAGE_QUERY,
  EVENT_CARDS_QUERY,
  EVENT_QUERY,
  EVENTS_LIST_PAGE_QUERY,
  EVENTS_SETTINGS_QUERY,
  GIFT_CARD_QUERY,
  HOME_PAGE_QUERY,
  INFO_MENU_QUERY,
  INFO_PAGE_QUERY,
  MEMBERSHIP_CARDS_QUERY,
  MOVED_SLUG_QUERY,
  NAVIGATION_QUERY,
  PRODUCT_CARDS_QUERY,
  PRODUCT_QUERY,
  SESSION_PASS_CARDS_QUERY,
  SHOP_SETTINGS_QUERY,
  SITE_SETTINGS_QUERY,
} from './queries'
import {
  addonsSchema,
  contentPageSchema,
  eventCardsSchema,
  eventSchema,
  eventsListPageSchema,
  eventsSettingsSchema,
  giftCardSchema,
  infoMenuSchema,
  infoPageSchema,
  membershipCardsSchema,
  movedSlugSchema,
  navigationSchema,
  productCardsSchema,
  productSchema,
  sessionPassCardsSchema,
  shopSettingsSchema,
  siteSettingsSchema,
} from './schemas'

// Every read of Sanity the site makes (W72): a query and the schema its answer must fit. A document that isn't there
// (or isn't published) is null.

type Read<Schema extends z.ZodType> = { query: string; schema: Schema }

const read = <Schema extends z.ZodType>(query: string, schema: Schema): Read<Schema> => ({ query, schema })

export const reads = {
  siteSettings: read(SITE_SETTINGS_QUERY, siteSettingsSchema.nullable()),
  navigation: read(NAVIGATION_QUERY, navigationSchema.nullable()),
  homePage: read(HOME_PAGE_QUERY, contentPageSchema.nullable()),
  contentPage: read(CONTENT_PAGE_QUERY, contentPageSchema.nullable()),
  infoPage: read(INFO_PAGE_QUERY, infoPageSchema.nullable()),
  infoMenu: read(INFO_MENU_QUERY, infoMenuSchema),
  productCards: read(PRODUCT_CARDS_QUERY, productCardsSchema),
  product: read(PRODUCT_QUERY, productSchema.nullable()),
  shopSettings: read(SHOP_SETTINGS_QUERY, shopSettingsSchema.nullable()),
  eventCards: read(EVENT_CARDS_QUERY, eventCardsSchema),
  event: read(EVENT_QUERY, eventSchema.nullable()),
  eventsSettings: read(EVENTS_SETTINGS_QUERY, eventsSettingsSchema.nullable()),
  eventsListPage: read(EVENTS_LIST_PAGE_QUERY, eventsListPageSchema.nullable()),
  giftCard: read(GIFT_CARD_QUERY, giftCardSchema.nullable()),
  addons: read(ADDONS_QUERY, addonsSchema),
  membershipCards: read(MEMBERSHIP_CARDS_QUERY, membershipCardsSchema),
  sessionPassCards: read(SESSION_PASS_CARDS_QUERY, sessionPassCardsSchema),
  movedSlug: read(MOVED_SLUG_QUERY, movedSlugSchema.nullable()),
} as const

type Reads = typeof reads

/** The reads of one document by its address, which take its slug. */
type BySlug = 'contentPage' | 'infoPage' | 'product' | 'event'

/** W72a: the read of where an old slug went takes the slug and the document type it was a slug of. */
type ByOldSlug = 'movedSlug'

/**
 * Reads one of them, published documents only. The client is made here, not at load: a build may have no settings.
 * It reads through Sanity's CDN (`useCdn`), which keeps each query's answer until the dataset next changes.
 */
export async function readSanity<Name extends keyof Reads>(
  name: Name,
  ...[slug, type]: Name extends BySlug ? [slug: string] : Name extends ByOldSlug ? [slug: string, type: string] : []
): Promise<z.output<Reads[Name]['schema']>> {
  const client = createClient({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
    apiVersion: '2025-02-19',
    useCdn: true,
    perspective: 'published',
  })
  const { query, schema } = reads[name]
  const params: Record<string, string> = {}
  if (slug !== undefined) params.slug = slug
  if (type !== undefined) params.type = type
  const answer: unknown = await client.fetch(query, params)
  return schema.parse(answer) as z.output<Reads[Name]['schema']>
}
