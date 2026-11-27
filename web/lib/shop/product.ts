import type { ShopSize } from '@/contracts/shop'
import type { HeroMediaPicture } from '@/lib/modules/hero-media'
import { sizedImage } from '@/lib/sanity/image'
import { stillOf, videoOf, type ScreenVideo } from '@/lib/sanity/media'
import type { Media, Picture, Product, ProductCard as SanityProduct, RichText, ShopSettings, SizeGuide } from '@/lib/sanity/schemas'

import { CARD_RATIO, cardPictures, type CardPicture, type ShopCard, type ShopItem } from './cards'
import { pounds } from './money'
import type { ShopProduct } from './read'

// W74: what the Product page shows (Figma 1684:41920 and 1684:41990), made from Sanity's product and the Worker's.
// Nothing here reads either, and every price is one W74a's read gave: this only writes them as the designs do.

/**
 * A price line as ProductInfoContainer draws it: the price, "From" when the sizes differ, the price before a sale struck through,
 * and "(Member from £X)" when a member pays less (WQ46: the Worker's read gives a member price only then).
 */
export type PriceLine = { now: string | null; from: boolean; before: string | null; member: string | null }

type Prices = Pick<ShopSize, 'price' | 'memberPrice' | 'priceBeforeSale'>

export const priceLine = (prices: Prices, from: boolean): PriceLine => ({
  now: prices.price === null ? null : pounds(prices.price),
  from,
  before: prices.priceBeforeSale === null ? null : pounds(prices.priceBeforeSale),
  member: prices.memberPrice === null ? null : pounds(prices.memberPrice),
})

/** One size: whether any is left, and its own price line, shown once it is picked. `size` is null for a product that comes in one only. */
export type ProductSize = { size: string | null; available: boolean; price: PriceLine }

/** The sizes as the page shows them, from the Worker's (the page's own read, or the availability route's answer after load). */
export const productSizes = (sizes: readonly ShopSize[]): ProductSize[] => sizes.map((size) => ({ size: size.size, available: size.available, price: priceLine(size, false) }))

/** A colour of the product's family: its first picture, and its own page. */
export type ColourSwatch = { id: string; href: string; name: string; picture: CardPicture | null; current: boolean }

/** A picture or a video of the gallery, cut 4 by 5 for each width of screen (WQ35: a video's own file and poster for phones). */
export type GalleryItem = { key: string; picture: HeroMediaPicture; video: ScreenVideo | null }

/** Figma's gallery picture: 716 by 895 on a desktop (half the window), 390 by 487.5 on a phone (the whole of it). */
const GALLERY_WIDTHS = [780, 480, 1170, 1440, 1920] as const

export function galleryItems(gallery: Media[]): GalleryItem[] {
  return gallery.map((media, index) => {
    const still = stillOf(media)
    return {
      key: `${index}-${still.wide.ref}`,
      picture: { desktop: sizedImage(still.wide, CARD_RATIO, GALLERY_WIDTHS), mobile: sizedImage(still.phone, CARD_RATIO, GALLERY_WIDTHS), alt: still.alt },
      video: videoOf(media),
    }
  })
}

/** The line under the button, by how the product can be had; none when the staff app has not said. */
export function fulfilmentLine(method: ShopProduct['fulfilmentMethod']): string | null {
  if (method === 'both') return 'Delivery or collection from the Paddock.'
  if (method === 'shipping') return 'Delivery only.'
  if (method === 'pickup') return 'Collection from the Paddock only.'
  return null
}

/** Materials & Care: what an editor filled of the three; null when none is, and the tab is hidden. */
export type Materials = { composition: string | null; madeIn: string | null; care: string | null }

const filled = (text: string | null | undefined): string | null => text?.trim() || null

export function materialsOf(info: Product['info']): Materials | null {
  const materials = { composition: filled(info?.composition), madeIn: filled(info?.madeIn), care: filled(info?.careInstructions) }
  return materials.composition || materials.madeIn || materials.care ? materials : null
}

/**
 * The colours of the product's family that are on sale (itself among them), by colour name, so each sits in the same
 * place on every colour's page. None when the product has no family: the colour's name is then shown alone.
 */
export function colourSwatches(product: Product, onSale: ReadonlySet<string>): ColourSwatch[] {
  if (!product.family) return []
  const nameOf = (one: { name: string; colourName: string | null }): string => filled(one.colourName) ?? one.name
  const all = [{ ...product, current: true }, ...product.colours.filter((colour) => onSale.has(colour.id)).map((colour) => ({ ...colour, current: false }))]
  return all
    .map((one) => ({ id: one.id, href: `/shop/${one.slug}`, name: nameOf(one), picture: cardPictures(one.gallery).picture, current: one.current }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'))
}

export type ProductView = {
  /** The Sanity document's id: what the availability route and the bag are told. */
  id: string
  name: string
  colourName: string | null
  gallery: GalleryItem[]
  /** The product's own line, shown until a size is picked: the lowest price, "From" when the sizes differ. */
  price: PriceLine
  sizes: ProductSize[]
  soldOut: boolean
  colours: ColourSwatch[]
  fulfilment: string | null
  description: RichText
  materials: Materials | null
  /** Shop settings' Shipping & Returns summary, the same on every product. */
  shipping: RichText
  sizeGuide: SizeGuide | null
}

type ProductContent = { product: Product; onSale: ShopProduct; settings: ShopSettings | null; onSaleIds: ReadonlySet<string> }

export function productView({ product, onSale, settings, onSaleIds }: ProductContent): ProductView {
  return {
    id: product.id,
    name: product.name,
    colourName: filled(product.colourName),
    gallery: galleryItems(product.gallery),
    price: priceLine(onSale, onSale.from),
    sizes: productSizes(onSale.sizes),
    soldOut: onSale.soldOut,
    colours: colourSwatches(product, onSaleIds),
    fulfilment: fulfilmentLine(onSale.fulfilmentMethod),
    description: product.description,
    materials: materialsOf(product.info),
    shipping: settings?.shippingReturnsSummary ?? [],
    sizeGuide: product.sizeGuide,
  }
}

/**
 * The Size Guide's tab of the Product Info Panel (WQ39): the one tab with no link of its own in the list, opened by
 * "Size guide" beside the sizes. Here, not in a component: the server draws the tabs and the browser opens them.
 */
export const SIZE_GUIDE_TAB = 'size-guide'

/** Cards in the Similar Merch row, as drawn (Figma 1402:49922). */
export const SIMILAR_ROW_LENGTH = 4

type SimilarContent = { product: Product; products: SanityProduct[]; items: ShopItem[]; length?: number }

/**
 * Similar Merch (WQ6; W78b: WQ74, the row always fills), up to the row's length, in this order:
 * 1. the editor's picks, in their order (a pick may be one of the product's own colours: the editor chose it);
 * 2. other products of its category, newest first;
 * 3. every other product on sale, newest first;
 * 4. its own other colours, which the page already shows as swatches, so they come last.
 * Only products that are on sale (a sold-out one keeps its card), each once, never the product itself and never the
 * gift card. So it is empty, and the row hidden, only when the shop has no other product.
 */
export function similarCards({ product, products, items, length = SIMILAR_ROW_LENGTH }: SimilarContent): ShopCard[] {
  const sanityIds = new Set(products.map((one) => one.id))
  // Every other product on sale, newest first: what each step chooses from.
  const others = items.filter((item) => item.card.id !== product.id && sanityIds.has(item.card.id))
  const byId = new Map(others.map((item) => [item.card.id, item]))
  const category = items.find((item) => item.card.id === product.id)?.category ?? null
  const family = new Set(product.family ? products.filter((one) => one.family === product.family).map((one) => one.id) : [])
  const picks = product.similarIds.flatMap((id) => byId.get(id) ?? [])
  const notOwnColour = others.filter((item) => !family.has(item.card.id))
  const inOrder = [
    ...picks,
    ...notOwnColour.filter((item) => category !== null && item.category === category),
    ...notOwnColour,
    ...others,
  ]
  return [...new Set(inOrder)].slice(0, length).map((item) => item.card)
}

/** A rich text's words, in one line. */
export const plainText = (blocks: RichText): string =>
  blocks
    .map((block) => block.children.map((span) => span.text).join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

/** A description for search results: the first 155 characters, cut at a word (docs/build-standards.md, section 2). */
export function metaDescription(text: string, most = 155): string | null {
  const words = text.replace(/\s+/g, ' ').trim()
  if (!words) return null
  if (words.length <= most) return words
  const cut = words.slice(0, most - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[\s,;:.]+$/, '')}…`
}

/** "{Product name} - {Colour}", the product's title in search results. */
export const productTitle = (product: { name: string; colourName: string | null }): string => (filled(product.colourName) ? `${product.name} - ${filled(product.colourName)}` : product.name)

/** The product's first picture, for its link preview (a video's poster stands for it). */
export const firstPicture = (gallery: Media[]): Picture | null => (gallery[0] ? { ...stillOf(gallery[0]).wide, alt: stillOf(gallery[0]).alt } : null)
