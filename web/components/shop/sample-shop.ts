import type { ShopSize } from '@/contracts/shop'
import type { SizedImage } from '@/lib/sanity/image'
import type { RichText } from '@/lib/sanity/schemas'
import type { ShopCard, ShopCategoryOption, ShopItem } from '@/lib/shop/cards'
import type { GiftCardView } from '@/lib/shop/gift-card'
import { inPence, pounds } from '@/lib/shop/money'
import { priceLine, productSizes, type GalleryItem, type ProductView } from '@/lib/shop/product'

// For the Shop stories only: cards, a shop and a product as Figma draws them ("The Paddock T-Shirt", £45), with
// pictures drawn on the spot so a story fetches nothing. The site's own come from Sanity and the Worker.

/** A drawn stand-in for a product's photograph, 4 by 5 on Object/Product BG: a T-shirt from the front, or its back with a print. */
const tee = (colour: string, back = false): SizedImage => {
  const print = back ? '<circle cx="200" cy="230" r="46" fill="none" stroke="#f1eee3" stroke-width="6"/>' : '<rect x="252" y="170" width="44" height="6" fill="#f1eee3"/>'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#d6d2c2"/><path d="M140 110h120l70 50-28 44-32-20v196H130V184l-32 20-28-44z" fill="${colour}"/>${print}</svg>`
  const src = `data:image/svg+xml,${encodeURIComponent(svg)}`
  return { src, srcSet: `${src} 400w`, width: 400, height: 500 }
}

export const COLOURS = { charcoal: '#3a3a3a', navy: '#10162b', white: '#f4f3ef', brown: '#5a2e1c' } as const
type Colour = keyof typeof COLOURS

const SIZES = ['S', 'M', 'L', 'XL']

type CardOptions = Partial<Omit<ShopCard, 'price'>> & { colour?: Colour; price?: string; before?: string | null; from?: boolean }

/** A card as Figma's ProductCard: "The Paddock T-Shirt", £45, sizes S to XL, with a second picture for hover. */
export function sampleCard(id: string, { colour = 'charcoal', price = '45.00', before = null, from = false, ...over }: CardOptions = {}): ShopCard {
  return {
    id,
    href: `/shop/${id}`,
    name: 'The Paddock T-Shirt',
    picture: { ...tee(COLOURS[colour]), alt: '' },
    hoverPicture: tee(COLOURS[colour], true),
    tag: null,
    soldOut: false,
    sizes: SIZES.map((size) => ({ size, available: true })),
    ...over,
    price: { now: pounds(price), from, before: before === null ? null : pounds(before) },
  }
}

/** The four states Figma draws (258:5520), and the gift card's card (WQ41). */
export const SAMPLE_CARDS = {
  newIn: sampleCard('tee-charcoal', { tag: 'New In' }),
  plain: sampleCard('tee-white', { colour: 'white' }),
  sale: sampleCard('tee-brown', { colour: 'brown', tag: '10% Off', price: '40.50', before: '45.00' }),
  soldOut: sampleCard('tee-navy', { colour: 'navy', soldOut: true, sizes: SIZES.map((size) => ({ size, available: false })) }),
  oneSizeLeft: sampleCard('tee-last', { colour: 'navy', sizes: SIZES.map((size) => ({ size, available: size === 'L' })) }),
  fromPrice: sampleCard('tee-from', { colour: 'white', from: true }),
  giftCard: {
    id: 'gift',
    href: '/shop/gift-card',
    name: 'Gift Card',
    picture: {
      ...((): SizedImage => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#d6d2c2"/><rect x="90" y="180" width="220" height="140" rx="8" fill="#193028"/><rect x="110" y="286" width="80" height="6" fill="#f1eee3"/></svg>'
        const src = `data:image/svg+xml,${encodeURIComponent(svg)}`
        return { src, srcSet: `${src} 400w`, width: 400, height: 500 }
      })(),
      alt: '',
    },
    hoverPicture: null,
    tag: null,
    soldOut: false,
    price: { now: '£15', from: true, before: null },
    sizes: [],
  } satisfies ShopCard,
}

export const SAMPLE_CATEGORIES: ShopCategoryOption[] = [
  { id: 'cat-apparel', slug: 'apparel', title: 'Apparel' },
  { id: 'cat-hoodies', slug: 'hoodies', title: 'Hoodies' },
  { id: 'cat-gifts', slug: 'gift-card', title: 'Gift Card' },
]

const ORDER: Colour[] = ['charcoal', 'navy', 'white', 'brown']

/**
 * A shop of 30, newest first: T-shirts at rising prices (the first two New In, the fourth 10% off, the seventh sold
 * out), the last five of them Hoodies, and the gift card.
 */
export const SAMPLE_ITEMS: ShopItem[] = [
  ...Array.from({ length: 29 }, (_, index): ShopItem => {
    const sale = index === 3
    const price = sale ? '36.00' : `${30 + index}.00`
    const soldOut = index === 6
    const card = sampleCard(`item-${index + 1}`, {
      colour: ORDER[index % ORDER.length]!,
      name: index >= 24 ? 'The Paddock Hoodie' : 'The Paddock T-Shirt',
      tag: sale ? '10% Off' : index < 2 ? 'New In' : null,
      price,
      before: sale ? '40.00' : null,
      soldOut,
      ...(soldOut ? { sizes: SIZES.map((size) => ({ size, available: false })) } : {}),
    })
    return { card, category: index >= 24 ? 'cat-hoodies' : 'cat-apparel', pence: inPence(price) }
  }),
  { card: SAMPLE_CARDS.giftCard, category: 'cat-gifts', pence: 1500 },
]

/** Shop settings' Featured order: the gift card first, then two picked T-shirts. */
export const SAMPLE_FEATURED = ['gift', 'item-10', 'item-4']

const galleryItem = (key: string, colour: Colour, back: boolean, alt: string): GalleryItem => ({ key, picture: { desktop: tee(COLOURS[colour], back), mobile: tee(COLOURS[colour], back), alt }, video: null })

const block = (key: string, text: string, bullet = false): RichText[number] => ({
  _type: 'block',
  _key: key,
  style: 'normal',
  listItem: bullet ? 'bullet' : null,
  level: bullet ? 1 : null,
  children: [{ _type: 'span', _key: `${key}-1`, text, marks: [] }],
  markDefs: [],
})

/** Figma's Description (1402:53320). */
export const SAMPLE_DESCRIPTION: RichText = [
  block('d1', 'Taking its namesake from Japanese youth, MKI offers soft staples for the everyday. The Design studio t-shirt sees the label reimagine a classic silhouette, adding their signature collegiate inspired aesthetic for an elevated finish.'),
  block('d2', 'Oversized fit', true),
  block('d3', 'Dropped shoulder panelling', true),
  block('d4', 'Close fitting neckline', true),
  block('d5', 'Ribbed crewneck', true),
  block('d6', '100% heavyweight cotton', true),
]

const SAMPLE_SHIPPING: RichText = [
  block('s1', 'Orders are sent by Royal Mail within two working days, or can be collected from the Paddock.'),
  block('s2', 'Standard delivery, free over £60', true),
  block('s3', 'Returns within 30 days, unworn', true),
]

const size = (name: string, available = true, over: Partial<ShopSize> = {}): ShopSize => ({ size: name, available, price: '45.00', memberPrice: '40.00', priceBeforeSale: null, percentOff: null, ...over })

/** The sizes as the Worker gives them (W74a), for a story's own stand-in for the availability route. */
export const SAMPLE_SIZES: ShopSize[] = SIZES.map((name) => size(name))

/** Figma's Product (1684:41920): The Paddock T-Shirt in Brown, £45 (Member from £40), with White of its family. */
export const SAMPLE_PRODUCT: ProductView = {
  id: 'tee-brown',
  name: 'The Paddock T-Shirt',
  colourName: 'Brown',
  gallery: [galleryItem('g1', 'brown', false, 'The Paddock T-Shirt in brown, from the front'), galleryItem('g2', 'brown', true, 'Its back'), galleryItem('g3', 'brown', true, 'Its back again')],
  price: priceLine({ price: '45.00', memberPrice: '40.00', priceBeforeSale: null }, false),
  sizes: productSizes(SAMPLE_SIZES),
  soldOut: false,
  colours: [
    { id: 'tee-brown', href: '/shop/tee-brown', name: 'Brown', picture: { ...tee(COLOURS.brown), alt: '' }, current: true },
    { id: 'tee-white', href: '/shop/tee-white', name: 'White', picture: { ...tee(COLOURS.white), alt: '' }, current: false },
  ],
  fulfilment: 'Delivery or collection from the Paddock.',
  description: SAMPLE_DESCRIPTION,
  materials: { composition: '100% heavyweight organic cotton, 280gsm', madeIn: 'Portugal', care: 'Wash at 30 degrees, inside out.\nDo not tumble dry.' },
  shipping: SAMPLE_SHIPPING,
  sizeGuide: {
    title: 'T-shirts',
    columns: ['Size', 'Chest (cm)', 'Length (cm)'],
    rows: [
      ['S', '106', '70'],
      ['M', '112', '72'],
      ['L', '118', '74'],
      ['XL', '124', '76'],
    ],
    notes: [block('n1', 'Measured flat, across the chest. The fit is oversized: take your usual size.')],
  },
}

/** On sale: 10% off every size. */
export const SAMPLE_PRODUCT_ON_SALE: ProductView = {
  ...SAMPLE_PRODUCT,
  price: priceLine({ price: '40.50', memberPrice: '40.00', priceBeforeSale: '45.00' }, false),
  sizes: productSizes(SIZES.map((name) => size(name, true, { price: '40.50', priceBeforeSale: '45.00', percentOff: 10 }))),
}

/** Sold out: no size is left. */
export const SAMPLE_PRODUCT_SOLD_OUT: ProductView = { ...SAMPLE_PRODUCT, soldOut: true, sizes: productSizes(SIZES.map((name) => size(name, false))) }

/** One size left. */
export const SAMPLE_PRODUCT_ONE_LEFT: ProductView = { ...SAMPLE_PRODUCT, sizes: productSizes(SIZES.map((name) => size(name, name === 'L'))) }

/** A drawn stand-in for a gift card's photograph, 4 by 5 on Object/Product BG: the card itself (physical), or the card on a phone's screen (digital). */
const card = (digital: boolean, turned = false): SizedImage => {
  const drawn = digital
    ? `<rect x="120" y="90" width="160" height="320" rx="18" fill="#222222"/><rect x="132" y="${turned ? 150 : 190}" width="136" height="88" rx="6" fill="#193028"/><rect x="144" y="${turned ? 214 : 254}" width="48" height="5" fill="#f1eee3"/>`
    : `<rect x="90" y="180" width="220" height="140" rx="8" fill="#193028" ${turned ? 'transform="rotate(-8 200 250)"' : ''}/><rect x="110" y="286" width="80" height="6" fill="#f1eee3" ${turned ? 'transform="rotate(-8 200 250)"' : ''}/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#d6d2c2"/>${drawn}</svg>`
  const src = `data:image/svg+xml,${encodeURIComponent(svg)}`
  return { src, srcSet: `${src} 400w`, width: 400, height: 500 }
}

const cardItem = (key: string, digital: boolean, turned: boolean, alt: string): GalleryItem => ({ key, picture: { desktop: card(digital, turned), mobile: card(digital, turned), alt }, video: null })

/**
 * Figma's Gift card (1684:41964 digital, 1684:41977 physical): "Gift Card", the presets £15 to £150 with Other, two
 * pictures in each gallery. The amounts and limits are as W76a reads the live type: Other from £1 to £1,000, and a
 * card lasts 6 months (the terms' {validity}, already filled).
 */
export const SAMPLE_GIFT_CARD: GiftCardView = {
  id: 'gift',
  name: 'Gift Card',
  galleries: {
    digital: [cardItem('d1', true, false, 'The Paddock gift card on a phone'), cardItem('d2', true, true, 'The gift card email, opened')],
    physical: [cardItem('p1', false, false, 'The Paddock gift card'), cardItem('p2', false, true, 'The gift card, turned')],
  },
  amounts: ['15.00', '30.00', '60.00', '90.00', '150.00'].map((amount) => ({ amount, label: pounds(amount) })),
  other: { lowest: '1.00', highest: '1000.00' },
  description: [block('gd1', 'A gift card for the Paddock: sauna and contrast therapy in Hebden Bridge. It can be spent on sessions, events and anything in the shop.')],
  terms: [block('gt1', 'Valid for 6 months from the day it is bought.'), block('gt2', 'It can be spent in one go or a little at a time', true), block('gt3', 'It can’t be exchanged for cash', true)],
  shipping: SAMPLE_SHIPPING,
}

/** Similar Merch, as drawn: two New In, a plain one and one on sale. */
export const SAMPLE_SIMILAR: ShopCard[] = [SAMPLE_CARDS.newIn, sampleCard('tee-navy-2', { colour: 'navy', tag: 'New In' }), SAMPLE_CARDS.plain, SAMPLE_CARDS.sale]
