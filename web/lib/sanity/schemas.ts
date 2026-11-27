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

/**
 * A picture or a video. `hasSound` (W73b): the editor says the video has sound, so a visitor gets a button to turn
 * it on. WQ35: a video is one film: `url` and `poster` for screens from 768px, and for narrower ones `mobileUrl`
 * and `mobilePoster` when an editor added them (null: the main file, and the main poster cropped round its
 * hotspot). WQ42: neither poster has alt text of its own (`alt` is "" on both): `description`, the editor's Video
 * Description, describes the film and its posters (lib/sanity/media.ts).
 */
export const mediaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), image: pictureSchema }),
  z.object({
    kind: z.literal('video'),
    url: z.string(),
    mobileUrl: text,
    poster: pictureSchema,
    mobilePoster: pictureSchema.nullable(),
    description: z.string(),
    captionsUrl: text,
    hasSound: z.boolean(),
  }),
])
export type Media = z.infer<typeof mediaSchema>

/**
 * The linked document of a link: null when it isn't published. `isHome` when it is the page Site settings picks.
 * `thumbnail` (W82, WQ90): a page's picture or video for the menu; an event has none.
 */
const linkedDocumentSchema = z.object({
  type: z.enum(['contentPage', 'infoPage', 'event']),
  slug: z.string(),
  isHome: z.boolean(),
  thumbnail: mediaSchema.nullable(),
})

/**
 * Where a link goes. `linkHref` (./links.ts) makes the address, or null for a link to hide. W73b: `giftCard` is
 * /shop/gift-card, and `book` is the booking panel, whose link is /book. W80 (WQ83): `section` is a section of the
 * page the link is on, by its Section ID (`sectionId`, null for every other destination): its link is `#` and the id.
 */
export const linkSchema = z.object({
  destination: z.enum(['page', 'event', 'shop', 'giftCard', 'book', 'section', 'external']),
  document: linkedDocumentSchema.nullable(),
  url: text,
  sectionId: text,
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
export type NavLink = z.infer<typeof navLinkSchema>
/** `footerGroups`: the footer's columns of links, left to right (W73). */
export const navigationSchema = z.object({
  menuLinks: z.array(navLinkSchema),
  footerGroups: z.array(z.object({ key: z.string(), links: z.array(navLinkSchema) })),
})
export type Navigation = z.infer<typeof navigationSchema>

/**
 * W80 (WQ81, WQ83): what every module carries for its section. `theme`: one of the four modes, or null for Light,
 * the page's own. `sectionId`: the id an editor gave the section, as it was typed (lib/modules/section.ts says what
 * the site takes), or null.
 */
const sectionSettings = { theme: z.enum(['light', 'dark', 'fjord', 'mud']).nullable(), sectionId: text }

/**
 * HeroMedia module (W73b; WQ24): a picture or a video across the window, null until an editor adds one, and its
 * button, null when it is switched off or has no words. A button with no link opens the booking panel.
 */
export const heroMediaModuleSchema = z.object({
  type: z.literal('heroMedia'),
  key: z.string(),
  ...sectionSettings,
  media: mediaSchema.nullable(),
  button: z.object({ text: z.string(), link: linkSchema.nullable() }).nullable(),
})
export type HeroMediaModule = z.infer<typeof heroMediaModuleSchema>

const upcomingEventsModuleSchema = z.object({ type: z.literal('upcomingEvents'), key: z.string(), ...sectionSettings, heading: text })

/** W80: a content module's button: its words and its link. A module has none (null) without both. */
const moduleButtonSchema = z.object({ text: z.string(), link: linkSchema })
export type ModuleButtonLink = z.infer<typeof moduleButtonSchema>

/** PageHeader (W80): the page's title and intro, side by side or stacked, and up to two buttons (the first two are drawn). */
const pageHeaderModuleSchema = z.object({
  type: z.literal('pageHeader'),
  key: z.string(),
  ...sectionSettings,
  title: text,
  intro: richTextSchema,
  layout: z.enum(['split', 'stacked']),
  buttons: z.array(moduleButtonSchema.extend({ key: z.string() })),
})
export type PageHeaderModule = z.infer<typeof pageHeaderModuleSchema>

/** GalleryCarousel (W80, WQ82): its pictures and videos in order; one with no file is left out. */
const galleryCarouselModuleSchema = z.object({
  type: z.literal('galleryCarousel'),
  key: z.string(),
  ...sectionSettings,
  items: z.array(z.object({ key: z.string(), media: mediaSchema })),
})
export type GalleryCarouselModule = z.infer<typeof galleryCarouselModuleSchema>

/** AccordionList (W80): a heading and its questions, each with its answer; `padding` is Figma's Padding=yes. */
const accordionListModuleSchema = z.object({
  type: z.literal('accordionList'),
  key: z.string(),
  ...sectionSettings,
  heading: text,
  padding: z.boolean(),
  items: z.array(z.object({ key: z.string(), question: z.string(), answer: richTextSchema })),
})
export type AccordionListModule = z.infer<typeof accordionListModuleSchema>

/** TextMediaSticky (W80): a heading, text and an optional button beside a picture or video; small or big; flipped or not. */
const textMediaStickyModuleSchema = z.object({
  type: z.literal('textMediaSticky'),
  key: z.string(),
  ...sectionSettings,
  heading: text,
  text: richTextSchema,
  button: moduleButtonSchema.nullable(),
  media: mediaSchema.nullable(),
  size: z.enum(['small', 'big']),
  flip: z.boolean(),
})
export type TextMediaStickyModule = z.infer<typeof textMediaStickyModuleSchema>

/** TextBlock (W80): a heading, text and an optional button, at the left, the centre or the right. */
const textBlockModuleSchema = z.object({
  type: z.literal('textBlock'),
  key: z.string(),
  ...sectionSettings,
  heading: text,
  text: richTextSchema,
  button: moduleButtonSchema.nullable(),
  align: z.enum(['left', 'center', 'right']),
})
export type TextBlockModule = z.infer<typeof textBlockModuleSchema>

/** SectionSpacer (W80): empty space; it has only what every module has. */
const sectionSpacerModuleSchema = z.object({ type: z.literal('sectionSpacer'), key: z.string(), ...sectionSettings })

/**
 * Memberships (W81): the Membership cards under the Monthly / Yearly switch. An editor gives it a heading (for
 * screen readers: Figma draws none) and the note under the cards; the cards are documents of their own.
 */
const membershipsModuleSchema = z.object({ type: z.literal('memberships'), key: z.string(), ...sectionSettings, heading: text, note: richTextSchema })
export type MembershipsModule = z.infer<typeof membershipsModuleSchema>

/** SessionPasses (W81): the Session Pass cards. An editor gives it only a heading (for screen readers). */
const sessionPassesModuleSchema = z.object({ type: z.literal('sessionPasses'), key: z.string(), ...sectionSettings, heading: text })
export type SessionPassesModule = z.infer<typeof sessionPassesModuleSchema>

/** One module of a page. Each kind of module is one more member here. */
export const moduleSchema = z.discriminatedUnion('type', [
  heroMediaModuleSchema,
  upcomingEventsModuleSchema,
  pageHeaderModuleSchema,
  galleryCarouselModuleSchema,
  accordionListModuleSchema,
  textMediaStickyModuleSchema,
  textBlockModuleSchema,
  sectionSpacerModuleSchema,
  membershipsModuleSchema,
  sessionPassesModuleSchema,
])
export type PageModule = z.infer<typeof moduleSchema>

export const contentPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  isHome: z.boolean(),
  thumbnail: mediaSchema.nullable(),
  modules: z.array(moduleSchema),
  seo: seoSchema.nullable(),
})
export type ContentPage = z.infer<typeof contentPageSchema>

export const infoPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  thumbnail: mediaSchema.nullable(),
  body: richTextSchema,
  seo: seoSchema.nullable(),
})
export type InfoPage = z.infer<typeof infoPageSchema>

/** The left menu of the info pages, in order. */
export const infoMenuSchema = z.array(infoPageLinkSchema)
export type InfoMenu = z.infer<typeof infoMenuSchema>

/**
 * A product category (W72a; WQ7), as a product or the gift card carries it. `id` is what the Worker's product row
 * holds as its `category`; `order` is its place in the shop's filter, lowest first.
 */
export const categorySchema = z.object({ id: z.string(), title: z.string(), slug: text, order: z.number().nullable() })
export type Category = z.infer<typeof categorySchema>

/** `gallery`: pictures and videos in order (WQ15); the card's picture is its first picture. */
const productCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  colourName: text,
  slug: z.string(),
  category: categorySchema.nullable(),
  family: text,
  newInUntil: text,
  gallery: z.array(mediaSchema),
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
  colours: z.array(z.object({ id: z.string(), name: z.string(), colourName: text, slug: z.string(), gallery: z.array(mediaSchema) })),
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

const eventCardSchema = z.object({ id: z.string(), name: z.string(), slug: z.string(), gallery: z.array(mediaSchema) })
export type EventCard = z.infer<typeof eventCardSchema>

export const eventCardsSchema = z.array(eventCardSchema)

export const eventSchema = eventCardSchema.extend({ description: richTextSchema, extraWaiver: text, seo: seoSchema.nullable() })
export type Event = z.infer<typeof eventSchema>

export const eventsSettingsSchema = z.object({ termsSummary: richTextSchema })
export type EventsSettings = z.infer<typeof eventsSettingsSchema>

/**
 * W75 (WQ60): the page that holds the Upcoming Events list: its slug, and whether it is the page Site settings picks as
 * home. W80 (WQ83): `sectionId` is the Section ID an editor gave that list, or null: it is then `events`.
 */
export const eventsListPageSchema = z.object({ slug: z.string(), isHome: z.boolean(), sectionId: text })
export type EventsListPage = z.infer<typeof eventsListPageSchema>

/**
 * `terms` still holds its {validity} placeholder: the page fills it from the staff app's expiry setting. The two
 * galleries are the Physical and the Digital card's (WQ19).
 */
export const giftCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: categorySchema.nullable(),
  physicalGallery: z.array(mediaSchema),
  digitalGallery: z.array(mediaSchema),
  description: richTextSchema,
  terms: richTextSchema,
  seo: seoSchema.nullable(),
})
export type GiftCard = z.infer<typeof giftCardSchema>

/** W77: each add-on's first picture, by the add-on's document id; null when it has none (its card's picture area stays empty). */
export const addonsSchema = z.array(z.object({ id: z.string(), picture: pictureSchema.nullable() }))
export type AddonPictures = z.infer<typeof addonsSchema>

/** W81 (WQ86): one benefit of a Membership card, and the billing it is listed under. */
const cardBenefitSchema = z.object({ key: z.string(), text: z.string(), showFor: z.enum(['both', 'monthly', 'yearly']) })

/**
 * W81 (WQ84): the Membership cards in their order. `corePlan` and `allAccessPlan` are the plans' document ids, null
 * with none chosen or one that isn't published: the Worker says which are on sale and what they cost.
 */
export const membershipCardsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    line: text,
    corePlan: text,
    allAccessPlan: text,
    benefits: z.array(cardBenefitSchema),
    herdBenefits: z.array(cardBenefitSchema),
  }),
)
export type MembershipCard = z.infer<typeof membershipCardsSchema>[number]

/** W81 (WQ84): the Session Pass cards in their order, each with its two passes' document ids (null as a plan's). */
export const sessionPassCardsSchema = z.array(z.object({ id: z.string(), name: z.string(), line: text, corePass: text, allAccessPass: text }))
export type SessionPassCard = z.infer<typeof sessionPassCardsSchema>[number]

/** Where an old slug's document is now (W72a): its current slug, and whether it is the page Site settings picks as home. */
export const movedSlugSchema = z.object({ slug: z.string(), isHome: z.boolean() })
export type MovedSlug = z.infer<typeof movedSlugSchema>
