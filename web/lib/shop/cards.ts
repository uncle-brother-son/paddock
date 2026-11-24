import { sizedImage, type SizedImage } from '@/lib/sanity/image'
import { GIFT_CARD_ADDRESS } from '@/lib/sanity/links'
import { stillOf } from '@/lib/sanity/media'
import type { GiftCard, Media, ProductCard as SanityProduct } from '@/lib/sanity/schemas'

import { inPence, pounds } from './money'
import type { Shop, ShopProduct } from './read'

// W74: what a ProductCard shows (Figma 258:5520), made from Sanity's product (name, pictures, "New in until") and the
// Worker's (prices, sizes, whether any is left). Nothing here reads either, and nothing here works a price out: every
// figure is one W74a's read gave.

/** Figma's card picture: 400 by 500. */
export const CARD_RATIO = 400 / 500

/** A card is a quarter of a desktop window and half a phone's; in the Similar Merch row a little more. The first is the plain `src`. */
const CARD_WIDTHS = [360, 240, 480, 720, 960] as const

/** How wide a card's picture is drawn, for its `sizes`: in the Shop's grid a quarter of the window from 768px and half below. */
export const LISTING_CARD_SIZES = '(min-width: 768px) 25vw, 50vw'

/** In the Similar Merch row a card is 7 of the grid's 24 columns from 768px, and half the window below. */
export const ROW_CARD_SIZES = '(min-width: 768px) 29vw, 50vw'

export type CardPicture = SizedImage & { alt: string }

/** `before`: the price before a sale, struck through beside the price. `from`: the sizes differ in price (or it is the gift card's lowest amount). */
export type CardPrice = { now: string | null; from: boolean; before: string | null }

/** One size of the hover strip. A product's size with no name (it comes in one only) has no chip. */
export type CardSize = { size: string; available: boolean }

export type ShopCard = {
  /** The Sanity document's id: what the bag is told, and the card's key. */
  id: string
  href: string
  name: string
  /** The gallery's first picture (a video's poster stands for it), or none yet. */
  picture: CardPicture | null
  /** The gallery's second picture, shown on hover. */
  hoverPicture: SizedImage | null
  /** "10% Off" or "New In"; never on a sold-out card (WQ40). */
  tag: string | null
  soldOut: boolean
  price: CardPrice
  /** In shop order. None for the gift card (WQ41: no hover sizes). */
  sizes: CardSize[]
}

/** A card with what the Shop sorts and filters by. */
export type ShopItem = {
  card: ShopCard
  /** Its category's Sanity id, as the Worker's row holds it. */
  category: string | null
  /** What a non-member pays, in pence (WQ38); null with no price. */
  pence: number | null
}

const sized = (media: Media | undefined): CardPicture | null => {
  if (!media) return null
  const still = stillOf(media)
  return { ...sizedImage(still.wide, CARD_RATIO, CARD_WIDTHS), alt: still.alt }
}

/** A gallery's first two pictures as a card shows them. */
export function cardPictures(gallery: Media[]): Pick<ShopCard, 'picture' | 'hoverPicture'> {
  const second = sized(gallery[1])
  return { picture: sized(gallery[0]), hoverPicture: second ? { src: second.src, srcSet: second.srcSet, width: second.width, height: second.height } : null }
}

/** "New In" shows up to and including the editor's "New in until" day (`today`: the London date, YYYY-MM-DD). */
export const isNewIn = (newInUntil: string | null, today: string): boolean => newInUntil !== null && today <= newInUntil

/** The tag of a card. When more than one applies: sold out (no tag), then the sale, then New In (WQ7, WQ40). */
export function cardTag(product: Pick<ShopProduct, 'soldOut' | 'percentOff'>, newIn: boolean): string | null {
  if (product.soldOut) return null
  if (product.percentOff !== null) return `${product.percentOff}% Off`
  return newIn ? 'New In' : null
}

/** A product's card. */
export function productCard(content: SanityProduct, product: ShopProduct, today: string): ShopCard {
  return {
    id: content.id,
    href: `/shop/${content.slug}`,
    name: content.name,
    ...cardPictures(content.gallery),
    tag: cardTag(product, isNewIn(content.newInUntil, today)),
    soldOut: product.soldOut,
    price: {
      now: product.price === null ? null : pounds(product.price),
      // A sold-out card shows its one price struck through, as drawn: no "From", no sale beside it.
      from: product.from && !product.soldOut,
      before: product.priceBeforeSale === null || product.soldOut ? null : pounds(product.priceBeforeSale),
    },
    sizes: product.sizes.flatMap(({ size, available }) => (size === null ? [] : [{ size, available }])),
  }
}

/**
 * The gift card's card (WQ19, WQ41): its Physical gallery's first picture, else the Digital one's; "From" its lowest
 * amount on sale; no tag and no sizes. It goes to the gift card's own page.
 */
export function giftCardCard(content: GiftCard, lowestAmount: string | null): ShopCard {
  const gallery = content.physicalGallery.length > 0 ? content.physicalGallery : content.digitalGallery
  return {
    id: content.id,
    href: GIFT_CARD_ADDRESS,
    name: content.name,
    picture: sized(gallery[0]),
    hoverPicture: null,
    tag: null,
    soldOut: false,
    price: { now: lowestAmount === null ? null : pounds(lowestAmount), from: lowestAmount !== null, before: null },
    sizes: [],
  }
}

type ShopContent = {
  /** Sanity's products, newest first (lib/sanity/queries.ts). */
  products: SanityProduct[]
  giftCard: GiftCard | null
  shop: Shop
  today: string
}

/**
 * Everything the Shop lists, newest first: each product that is published in Sanity and on sale in the database
 * (sold-out ones stay: WQ40), then the gift card when a gift card type is on sale.
 */
export function shopItems({ products, giftCard, shop, today }: ShopContent): ShopItem[] {
  const onSale = new Map(shop.products.map((product) => [product.sanityId, product]))
  const items: ShopItem[] = products.flatMap((content) => {
    const product = onSale.get(content.id)
    if (!product) return []
    return [{ card: productCard(content, product, today), category: product.category, pence: product.price === null ? null : inPence(product.price) }]
  })
  const type = giftCard ? shop.giftCards.find((one) => one.sanityId === giftCard.id) : undefined
  if (giftCard && type) {
    items.push({ card: giftCardCard(giftCard, type.lowestAmount), category: giftCard.category?.id ?? null, pence: type.lowestAmount === null ? null : inPence(type.lowestAmount) })
  }
  return items
}

/** A category in the Shop's "All" list: `slug` is what the address carries (?category=). */
export type ShopCategoryOption = { id: string; slug: string; title: string }

/**
 * The Shop's categories (WQ7, WQ37): those the Worker says have a product on sale, and the gift card's own when a
 * gift card type is on sale (it has no product row: W74a, "For the lead" 4), in the categories' Order, then by title.
 * The slug and the Order are Sanity's; a category Sanity no longer publishes keeps its place by its id.
 */
export function shopCategories({ products, giftCard, shop }: Omit<ShopContent, 'today'>): ShopCategoryOption[] {
  const known = new Map<string, { slug: string | null; order: number | null }>()
  for (const { category } of [...products, ...(giftCard ? [giftCard] : [])]) {
    if (category) known.set(category.id, { slug: category.slug, order: category.order })
  }
  const listed = shop.categories.map((category) => ({ id: category.sanityId, title: category.title }))
  const giftCardOnSale = giftCard !== null && shop.giftCards.some((one) => one.sanityId === giftCard.id)
  const own = giftCard?.category
  if (giftCardOnSale && own && !listed.some((category) => category.id === own.id)) listed.push({ id: own.id, title: own.title })
  return listed
    .map((category) => ({ ...category, slug: known.get(category.id)?.slug ?? category.id, order: known.get(category.id)?.order ?? null }))
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title, 'en-GB'))
    .map(({ id, slug, title }) => ({ id, slug, title }))
}

/** Today's date in London (YYYY-MM-DD): the day "New in until" is compared with. */
export const londonToday = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
