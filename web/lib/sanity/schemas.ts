import { z } from 'zod'

// What each read in ./queries.ts answers, as the site uses it (W72). Sanity answers null for an empty field, so every
// optional field is nullable. The types are the schemas' own, so a read and its type can't drift apart; read.test.ts
// holds a sample document of each kind.

const text = z.string().nullable()

/** An image with its alt text ("" when decorative), and what the CDN loader needs: the size, crop and hotspot. */
export const pictureSchema = z.object({
  ref: z.string(),
  width: z.number(),
  height: z.number(),
  alt: z.string(),
  crop: z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() }).nullable(),
  hotspot: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
})
export type Picture = z.infer<typeof pictureSchema>

export const mediaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), image: pictureSchema }),
  z.object({
    kind: z.literal('video'),
    url: z.string(),
    poster: pictureSchema,
    description: z.string(),
    captionsUrl: text,
  }),
])
export type Media = z.infer<typeof mediaSchema>

/** The linked document of a link: null when it isn't published. `isHome` when it is the page Site settings picks. */
const linkedDocumentSchema = z.object({
  type: z.enum(['contentPage', 'infoPage', 'event']),
  slug: z.string(),
  isHome: z.boolean(),
  thumbnail: pictureSchema.nullable(),
})

/** Where a link goes. `linkHref` (./links.ts) makes the address, or null for a link to hide. */
export const linkSchema = z.object({
  destination: z.enum(['page', 'event', 'shop', 'external']),
  document: linkedDocumentSchema.nullable(),
  url: text,
})
export type Link = z.infer<typeof linkSchema>

/** Rich text: paragraphs and bullets of plain, bold and linked words. */
export const richTextSchema = z.array(
  z.object({
    _type: z.literal('block'),
    _key: z.string(),
    style: z.literal('normal'),
    listItem: z.literal('bullet').nullable(),
    level: z.number().nullable(),
    children: z.array(z.object({ _type: z.literal('span'), _key: z.string(), text: z.string(), marks: z.array(z.string()) })),
    markDefs: z.array(z.object({ _key: z.string(), _type: z.literal('link'), link: linkSchema })),
  }),
)
export type RichText = z.infer<typeof richTextSchema>

export const seoSchema = z.object({ title: text, description: text, shareImage: pictureSchema.nullable() })
export type Seo = z.infer<typeof seoSchema>

const infoPageLinkSchema = z.object({ title: z.string(), slug: z.string() })

export const siteSettingsSchema = z.object({
  siteName: z.string(),
  defaultSeo: seoSchema.nullable(),
  termsPage: infoPageLinkSchema.nullable(),
  privacyPage: infoPageLinkSchema.nullable(),
  shippingReturnsPage: infoPageLinkSchema.nullable(),
  address: z.object({ line1: text, line2: text, town: text, county: text, postcode: text }).nullable(),
  phone: text,
  openingHours: z.array(z.object({ days: z.array(z.string()), opens: z.string(), closes: z.string() })),
  socialLinks: z.object({ tiktok: text, instagram: text, facebook: text }).nullable(),
  newsletterHeading: text,
  newsletterText: text,
  copyrightName: text,
})
export type SiteSettings = z.infer<typeof siteSettingsSchema>

const navLinkSchema = z.object({ key: z.string(), label: z.string(), link: linkSchema })
export const navigationSchema = z.object({ menuLinks: z.array(navLinkSchema), footerLinks: z.array(navLinkSchema) })
export type Navigation = z.infer<typeof navigationSchema>

/** One module of a page. Each kind of module is one more member here. */
export const moduleSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('upcomingEvents'), key: z.string(), heading: text })])

export const contentPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  isHome: z.boolean(),
  thumbnail: pictureSchema.nullable(),
  hero: z.object({ media: mediaSchema.nullable(), button: z.object({ text: z.string(), link: linkSchema.nullable() }).nullable() }).nullable(),
  modules: z.array(moduleSchema),
  seo: seoSchema.nullable(),
})
export type ContentPage = z.infer<typeof contentPageSchema>

export const infoPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  thumbnail: pictureSchema.nullable(),
  body: richTextSchema,
  seo: seoSchema.nullable(),
})
export type InfoPage = z.infer<typeof infoPageSchema>

/** The left menu of the info pages, in order. */
export const infoMenuSchema = z.array(infoPageLinkSchema)
export type InfoMenu = z.infer<typeof infoMenuSchema>

const productCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  colourName: text,
  slug: z.string(),
  category: text,
  family: text,
  newInUntil: text,
  images: z.array(pictureSchema),
})
export type ProductCard = z.infer<typeof productCardSchema>

export const productCardsSchema = z.array(productCardSchema)

const sizeGuideSchema = z.object({
  title: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  notes: richTextSchema,
})
export type SizeGuide = z.infer<typeof sizeGuideSchema>

/** `colours`: the other products of its family. `similarIds`: the editor's picks, which may be none. */
export const productSchema = productCardSchema.extend({
  description: richTextSchema,
  info: z.object({ composition: text, madeIn: text, careInstructions: text }).nullable(),
  colours: z.array(z.object({ id: z.string(), name: z.string(), colourName: text, slug: z.string(), images: z.array(pictureSchema) })),
  sizeGuide: sizeGuideSchema.nullable(),
  similarIds: z.array(z.string()),
  seo: seoSchema.nullable(),
})
export type Product = z.infer<typeof productSchema>

/** `featuredIds`: products and the gift card, in order. */
export const shopSettingsSchema = z.object({
  title: z.string(),
  intro: text,
  featuredIds: z.array(z.string()),
  shippingReturnsSummary: richTextSchema,
  seo: seoSchema.nullable(),
})
export type ShopSettings = z.infer<typeof shopSettingsSchema>

const eventCardSchema = z.object({ id: z.string(), name: z.string(), slug: z.string(), images: z.array(pictureSchema) })
export type EventCard = z.infer<typeof eventCardSchema>

export const eventCardsSchema = z.array(eventCardSchema)

export const eventSchema = eventCardSchema.extend({ description: richTextSchema, extraWaiver: text, seo: seoSchema.nullable() })
export type Event = z.infer<typeof eventSchema>

export const eventsSettingsSchema = z.object({ termsSummary: richTextSchema })
export type EventsSettings = z.infer<typeof eventsSettingsSchema>

/** `terms` still holds its {validity} placeholder: the page fills it from the staff app's expiry setting. */
export const giftCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  images: z.array(pictureSchema),
  description: richTextSchema,
  terms: richTextSchema,
  seo: seoSchema.nullable(),
})
export type GiftCard = z.infer<typeof giftCardSchema>
