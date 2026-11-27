import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ShopSize } from '@/contracts/shop'
import type { GiftCard, Media, Product, ProductCard as SanityProduct } from '@/lib/sanity/schemas'

import { availabilityAddress, availabilityFrom, readAvailability } from './availability'
import { addToBag } from './bag'
import { cardTag, giftCardCard, isNewIn, londonToday, productCard, shopCategories, shopItems, type ShopItem } from './cards'
import { itemCount, SHOP_PAGE_SIZE, shopAddress, shopListing, shopQuery, sortedItems } from './listing'
import { inPence, pounds, poundsAndPence } from './money'
import { colourSwatches, fulfilmentLine, galleryItems, materialsOf, metaDescription, plainText, priceLine, productSizes, productTitle, productView, similarCards } from './product'
import type { Shop, ShopProduct } from './read'

// Brief W74: the Shop and the Product page are made from Sanity's words and pictures and the Worker's prices and sizes
// (W74a). These hold the rules of the brief that are not a matter of looks: what is listed, each card's tag and
// price, the category, sort and page of the address, a product's colours and Similar Merch, and the sizes asked
// again after load. Nothing here reads Sanity or the database.

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const picture = (name: string, alt = ''): Media => ({ kind: 'image', image: { ref: `image-${name}-800x1000-jpg`, width: 800, height: 1000, alt, crop: null, hotspot: null } })
const video = (name: string): Media => ({
  kind: 'video',
  url: `https://cdn.sanity.io/files/p/d/${name}.mp4`,
  mobileUrl: `https://cdn.sanity.io/files/p/d/${name}-phone.mp4`,
  poster: { ref: `image-${name}poster-1600x900-jpg`, width: 1600, height: 900, alt: '', crop: null, hotspot: null },
  mobilePoster: { ref: `image-${name}phone-900x1600-jpg`, width: 900, height: 1600, alt: '', crop: null, hotspot: null },
  description: 'Steam rising',
  captionsUrl: null,
  hasSound: false,
})
const APPAREL = { id: 'cat-apparel', title: 'Apparel', slug: 'apparel', order: 1 }
const HOODIES = { id: 'cat-hoodies', title: 'Hoodies', slug: 'hoodies', order: 2 }
const GIFTS = { id: 'cat-gifts', title: 'Gift Card', slug: 'gift-card', order: 3 }

const content = (id: string, over: Partial<SanityProduct> = {}): SanityProduct => ({
  id,
  name: `Product ${id}`,
  colourName: null,
  slug: `slug-${id}`,
  category: APPAREL,
  family: null,
  newInUntil: null,
  gallery: [picture(`${id}a`, 'The front'), picture(`${id}b`)],
  ...over,
})
const size = (name: string | null, available = true, over: Partial<ShopSize> = {}): ShopSize => ({ size: name, available, price: '45.00', memberPrice: null, priceBeforeSale: null, percentOff: null, ...over })
const onSale = (id: string, over: Partial<ShopProduct> = {}): ShopProduct => ({
  sanityId: id,
  category: APPAREL.id,
  fulfilmentMethod: 'both',
  price: '45.00',
  from: false,
  memberPrice: null,
  priceBeforeSale: null,
  percentOff: null,
  soldOut: false,
  sizes: [size('S'), size('M')],
  ...over,
})
const giftCard = (over: Partial<GiftCard> = {}): GiftCard => ({ id: 'gift', name: 'Gift Card', category: GIFTS, physicalGallery: [picture('physical', 'A card')], digitalGallery: [picture('digital')], description: [], terms: [], seo: null, ...over })
const shopOf = (products: ShopProduct[], over: Partial<Shop> = {}): Shop => ({ products, categories: [{ sanityId: APPAREL.id, title: 'Apparel' }], giftCards: [], ...over })
const TODAY = '2026-11-24'

describe('money as the designs write it', () => {
  it('whole pounds have no pence; anything else has two', () => {
    expect(['45.00', '40.50', '40.5', '1200.00', '0.99'].map(pounds)).toEqual(['£45', '£40.50', '£40.50', '£1,200', '£0.99'])
    // W83: the site's one money format marks thousands, and nothing below a thousand.
    expect(['999.00', '1000.00', '1308.50'].map(pounds)).toEqual(['£999', '£1,000', '£1,308.50'])
    expect(['999.00', '1000.00', '1308.50', '4.5'].map(poundsAndPence)).toEqual(['£999.00', '£1,000.00', '£1,308.50', '£4.50'])
  })
  it('prices sort as pence, not as text', () => {
    expect(inPence('100.00')).toBeGreaterThan(inPence('28.00'))
    expect(inPence('40.50')).toBe(4050)
  })
})

describe("a card's tag (WQ7, WQ40)", () => {
  it('New In shows up to and including the "New in until" day, and not after', () => {
    expect([isNewIn('2026-11-24', TODAY), isNewIn('2026-11-25', TODAY), isNewIn('2026-11-23', TODAY), isNewIn(null, TODAY)]).toEqual([true, true, false, false])
  })
  it('when more than one applies: sold out (no tag), then the sale, then New In', () => {
    expect(cardTag({ soldOut: true, percentOff: 10 }, true)).toBeNull()
    expect(cardTag({ soldOut: false, percentOff: 10 }, true)).toBe('10% Off')
    expect(cardTag({ soldOut: false, percentOff: null }, true)).toBe('New In')
    expect(cardTag({ soldOut: false, percentOff: null }, false)).toBeNull()
  })
  it("today is London's date", () => {
    // 23:30 UTC on 31 March is already 1 April in London (summer time).
    expect(londonToday(new Date('2026-03-31T23:30:00Z'))).toBe('2026-04-01')
    expect(londonToday(new Date('2026-11-24T23:30:00Z'))).toBe('2026-11-24')
  })
})

describe('a ProductCard', () => {
  it('has its name, its address, its first two pictures, its sizes in the order given, and the price as W74a gave it', () => {
    const card = productCard(content('p1'), onSale('p1', { sizes: [size('S'), size('M', false), size(null)] }), TODAY)
    expect([card.id, card.href, card.name, card.tag, card.soldOut]).toEqual(['p1', '/shop/slug-p1', 'Product p1', null, false])
    expect(card.price).toEqual({ now: '£45', from: false, before: null })
    expect(card.picture?.alt).toBe('The front')
    expect(card.picture?.src).toContain('image-p1a'.replace('image-', ''))
    expect(card.hoverPicture?.src).toContain('p1b')
    // 4 by 5, as drawn.
    expect(card.picture!.width / card.picture!.height).toBe(0.8)
    // A size with no name (a product that comes in one only) has no chip.
    expect(card.sizes).toEqual([{ size: 'S', available: true }, { size: 'M', available: false }])
  })
  it('on sale: the percent off as its tag and the price before struck beside the price; "From" when the sizes differ', () => {
    const card = productCard(content('p1', { newInUntil: '2026-12-31' }), onSale('p1', { price: '40.50', priceBeforeSale: '45.00', percentOff: 10, from: true }), TODAY)
    expect(card.tag).toBe('10% Off')
    expect(card.price).toEqual({ now: '£40.50', from: true, before: '£45' })
  })
  it('sold out (WQ40): no tag, its one price, no "From" and no sale beside it', () => {
    const card = productCard(content('p1', { newInUntil: '2026-12-31' }), onSale('p1', { soldOut: true, from: true, priceBeforeSale: '50.00', percentOff: 10, sizes: [size('S', false)] }), TODAY)
    expect([card.tag, card.soldOut]).toEqual([null, true])
    expect(card.price).toEqual({ now: '£45', from: false, before: null })
  })
  it("a video's poster stands for it; with one picture there is nothing to show on hover; with none, no picture", () => {
    const film = productCard(content('p1', { gallery: [video('film')] }), onSale('p1'), TODAY)
    expect(film.picture?.src).toContain('filmposter')
    expect(film.picture?.alt).toBe('Steam rising')
    expect(film.hoverPicture).toBeNull()
    expect(productCard(content('p1', { gallery: [] }), onSale('p1'), TODAY).picture).toBeNull()
  })
})

describe("the gift card's card (WQ19, WQ41)", () => {
  it("is its Physical gallery's first picture, \"From\" its lowest amount, to /shop/gift-card, with no tag and no sizes", () => {
    const card = giftCardCard(giftCard(), '15.00')
    expect([card.href, card.name, card.tag, card.soldOut, card.hoverPicture]).toEqual(['/shop/gift-card', 'Gift Card', null, false, null])
    expect(card.price).toEqual({ now: '£15', from: true, before: null })
    expect(card.picture?.src).toContain('physical')
    expect(card.sizes).toEqual([])
  })
  it("with no Physical picture it is the Digital one's; with no amount on sale it has no price", () => {
    const card = giftCardCard(giftCard({ physicalGallery: [] }), null)
    expect(card.picture?.src).toContain('digital')
    expect(card.price).toEqual({ now: null, from: false, before: null })
    expect(giftCardCard(giftCard({ physicalGallery: [], digitalGallery: [] }), null).picture).toBeNull()
  })
})

describe('what the Shop lists', () => {
  const products = [content('new'), content('draft-only'), content('old', { category: HOODIES })]
  const shop = shopOf([onSale('old', { category: HOODIES.id, soldOut: true }), onSale('new'), onSale('not-in-sanity')], {
    categories: [
      { sanityId: HOODIES.id, title: 'Hoodies' },
      { sanityId: APPAREL.id, title: 'Apparel' },
    ],
    giftCards: [{ sanityId: 'gift', lowestAmount: '15.00' }],
  })

  it('a product shows only when it is published in Sanity and on sale in the database; a sold-out one stays (WQ40)', () => {
    const items = shopItems({ products, giftCard: null, shop, today: TODAY })
    expect(items.map((item) => [item.card.id, item.card.soldOut, item.category, item.pence])).toEqual([
      ['new', false, APPAREL.id, 4500],
      ['old', true, HOODIES.id, 4500],
    ])
  })
  it('the gift card is a card too, after the products, only while a gift card type is on sale', () => {
    expect(shopItems({ products, giftCard: giftCard(), shop, today: TODAY }).map((item) => [item.card.id, item.category, item.pence])).toEqual([
      ['new', APPAREL.id, 4500],
      ['old', HOODIES.id, 4500],
      ['gift', GIFTS.id, 1500],
    ])
    expect(shopItems({ products, giftCard: giftCard(), shop: { ...shop, giftCards: [] }, today: TODAY }).map((item) => item.card.id)).toEqual(['new', 'old'])
  })
  it("the categories are the Worker's (those with a product on sale) and the gift card's own, in their Order (WQ7, WQ37)", () => {
    expect(shopCategories({ products, giftCard: giftCard(), shop })).toEqual([
      { id: APPAREL.id, slug: 'apparel', title: 'Apparel' },
      { id: HOODIES.id, slug: 'hoodies', title: 'Hoodies' },
      { id: GIFTS.id, slug: 'gift-card', title: 'Gift Card' },
    ])
  })
  it("the gift card's category is not listed while no gift card type is on sale, nor twice when products share it", () => {
    expect(shopCategories({ products, giftCard: giftCard(), shop: { ...shop, giftCards: [] } }).map((category) => category.slug)).toEqual(['apparel', 'hoodies'])
    expect(shopCategories({ products, giftCard: giftCard({ category: APPAREL }), shop }).map((category) => category.slug)).toEqual(['apparel', 'hoodies'])
  })
  it('a category Sanity no longer publishes keeps a place, by its id, after those with an Order', () => {
    const gone = shopOf([onSale('new')], { categories: [{ sanityId: 'cat-gone', title: 'Aardvarks' }, { sanityId: APPAREL.id, title: 'Apparel' }] })
    expect(shopCategories({ products, giftCard: null, shop: gone })).toEqual([
      { id: APPAREL.id, slug: 'apparel', title: 'Apparel' },
      { id: 'cat-gone', slug: 'cat-gone', title: 'Aardvarks' },
    ])
  })
})

describe("the Shop's address (?category=&sort=&page=)", () => {
  const categories = [
    { id: APPAREL.id, slug: 'apparel', title: 'Apparel' },
    { id: HOODIES.id, slug: 'hoodies', title: 'Hoodies' },
  ]
  it('reads the category, the sort and the page', () => {
    expect(shopQuery({ category: 'hoodies', sort: 'price-desc', page: '2' }, categories)).toEqual({ category: 'hoodies', sort: 'price-desc', page: 2 })
  })
  it('an unknown value falls back to the default, never an error', () => {
    expect(shopQuery({}, categories)).toEqual({ category: null, sort: 'featured', page: 1 })
    expect(shopQuery({ category: 'socks', sort: 'cheapest', page: 'two' }, categories)).toEqual({ category: null, sort: 'featured', page: 1 })
    for (const page of ['0', '-1', '2.5', '1e3', ' 2', '']) expect(shopQuery({ page }, categories).page).toBe(1)
    // Said twice in the address: the first.
    expect(shopQuery({ category: ['apparel', 'hoodies'], sort: ['new-in', 'x'], page: ['3', '4'] }, categories)).toEqual({ category: 'apparel', sort: 'new-in', page: 3 })
  })
  it('each is left out of the address when it is the default', () => {
    expect(shopAddress({})).toBe('/shop')
    expect(shopAddress({ category: null, sort: 'featured', page: 1 })).toBe('/shop')
    expect(shopAddress({ sort: 'price-desc' })).toBe('/shop?sort=price-desc')
    expect(shopAddress({ category: 'apparel', sort: 'new-in', page: 2 })).toBe('/shop?category=apparel&sort=new-in&page=2')
  })
})

describe("the Shop's sorts (WQ38)", () => {
  const item = (id: string, price: string | null): ShopItem => ({ card: productCard(content(id), onSale(id, { price }), TODAY), category: APPAREL.id, pence: price === null ? null : inPence(price) })
  // Newest first, as Sanity gives them.
  const items = [item('d', '30.00'), item('c', null), item('b', '100.00'), item('a', '30.00')]
  const ids = (sorted: ShopItem[]) => sorted.map((one) => one.card.id).join('')

  it("Featured, the default: Shop settings' Featured order, then the rest by New in", () => {
    expect(ids(sortedItems(items, 'featured', ['a', 'gone', 'c']))).toBe('acdb')
    expect(ids(sortedItems(items, 'featured', []))).toBe('dcba')
  })
  it('New in: newest first', () => {
    expect(ids(sortedItems(items, 'new-in', ['a']))).toBe('dcba')
  })
  it('Price: what a non-member pays, low to high or high to low; the same price keeps its New in order; no price goes last', () => {
    expect(ids(sortedItems(items, 'price-asc', ['a']))).toBe('dabc')
    expect(ids(sortedItems(items, 'price-desc', ['a']))).toBe('bdac')
  })
})

describe('one page of the Shop', () => {
  const categories = [
    { id: APPAREL.id, slug: 'apparel', title: 'Apparel' },
    { id: HOODIES.id, slug: 'hoodies', title: 'Hoodies' },
  ]
  const items = Array.from({ length: 30 }, (_, index) => {
    const id = `p${String(index + 1).padStart(2, '0')}`
    return { card: productCard(content(id), onSale(id), TODAY), category: index < 25 ? APPAREL.id : HOODIES.id, pence: 4500 }
  })
  const page = (query: Partial<{ category: string | null; sort: 'featured' | 'new-in'; page: number }>) => shopListing({ items, categories, featuredIds: [], query: { category: null, sort: 'featured', page: 1, ...query } })

  it('is twelve cards, with the count of every page and how many pages there are', () => {
    const first = page({})
    expect(SHOP_PAGE_SIZE).toBe(12)
    expect([first.cards.length, first.count, first.page, first.pages]).toEqual([12, 30, 1, 3])
    expect(first.cards[0]?.id).toBe('p01')
    const last = page({ page: 3 })
    expect([last.cards.length, last.cards[0]?.id, last.page]).toEqual([6, 'p25', 3])
  })
  it('a category holds only its own items, and counts only them', () => {
    const hoodies = page({ category: 'hoodies' })
    expect([hoodies.count, hoodies.pages, hoodies.category?.title]).toEqual([5, 1, 'Hoodies'])
    expect(hoodies.cards.map((card) => card.id)).toEqual(['p26', 'p27', 'p28', 'p29', 'p30'])
  })
  it('a page past the last is page 1; an empty shop is one empty page', () => {
    expect(page({ page: 4 }).page).toBe(1)
    expect(page({ category: 'hoodies', page: 2 }).page).toBe(1)
    const empty = shopListing({ items: [], categories: [], featuredIds: [], query: { category: null, sort: 'featured', page: 1 } })
    expect([empty.cards, empty.count, empty.page, empty.pages]).toEqual([[], 0, 1, 1])
  })
  it('counts its items in words', () => {
    expect([itemCount(42), itemCount(1), itemCount(0)]).toEqual(['42 Items', '1 Item', '0 Items'])
  })
})

const product = (id: string, over: Partial<Product> = {}): Product => ({ ...content(id), description: [], info: null, colours: [], sizeGuide: null, similarIds: [], seo: null, ...over })

describe("a product's page", () => {
  it('its price line is the price, "From" when the sizes differ, the price before a sale, and the member price when it has one', () => {
    expect(priceLine({ price: '40.50', memberPrice: '40.00', priceBeforeSale: '45.00' }, true)).toEqual({ now: '£40.50', from: true, before: '£45', member: '£40' })
    expect(priceLine({ price: '45.00', memberPrice: null, priceBeforeSale: null }, false)).toEqual({ now: '£45', from: false, before: null, member: null })
  })
  it('each size has its own price line and whether any is left, in the order W74a gave', () => {
    const sizes = productSizes([size('S', true, { price: '45.00' }), size('M', false, { price: '50.00', memberPrice: '44.00' })])
    expect(sizes.map((one) => [one.size, one.available, one.price.now, one.price.member, one.price.from])).toEqual([
      ['S', true, '£45', null, false],
      ['M', false, '£50', '£44', false],
    ])
  })
  it('the line under the button says how it can be had', () => {
    expect([fulfilmentLine('both'), fulfilmentLine('shipping'), fulfilmentLine('pickup'), fulfilmentLine(null)]).toEqual([
      'Delivery or collection from the Paddock.',
      'Delivery only.',
      'Collection from the Paddock only.',
      null,
    ])
  })
  it('Materials & Care is hidden when all three are empty', () => {
    expect(materialsOf(null)).toBeNull()
    expect(materialsOf({ composition: ' ', madeIn: null, careInstructions: '' })).toBeNull()
    expect(materialsOf({ composition: '100% cotton', madeIn: null, careInstructions: null })).toEqual({ composition: '100% cotton', madeIn: null, care: null })
  })
  it('its colours are the products of its family that are on sale, itself among them, by colour name; none without a family', () => {
    const colour = (id: string, colourName: string) => ({ id, name: 'Tee', colourName, slug: `tee-${id}`, gallery: [picture(id)] })
    const tee = product('brown', { name: 'Tee', colourName: 'Brown', family: 'fam', colours: [colour('white', 'White'), colour('ash', 'Ash'), colour('offsale', 'Blue')] })
    const swatches = colourSwatches(tee, new Set(['brown', 'white', 'ash']))
    expect(swatches.map((one) => [one.name, one.href, one.current])).toEqual([
      ['Ash', '/shop/tee-ash', false],
      ['Brown', '/shop/slug-brown', true],
      ['White', '/shop/tee-white', false],
    ])
    expect(swatches[0]?.picture?.src).toContain('ash')
    expect(colourSwatches(product('brown', { colourName: 'Brown', family: null }), new Set(['brown']))).toEqual([])
  })
  it('a video of its gallery keeps its files and posters for each width of screen (WQ35)', () => {
    const [film, still] = galleryItems([video('film'), picture('still', 'The back')])
    expect([film?.video?.url.endsWith('film.mp4'), film?.video?.phoneUrl?.endsWith('film-phone.mp4'), film?.picture.alt]).toEqual([true, true, 'Steam rising'])
    expect(film?.picture.desktop.src).toContain('filmposter')
    expect(film?.picture.mobile.src).toContain('filmphone')
    expect([still?.video, still?.picture.alt]).toEqual([null, 'The back'])
    expect(still!.picture.desktop.width / still!.picture.desktop.height).toBe(0.8)
  })
  it('is made of both: the words of Sanity, the prices and sizes of the Worker, Shop settings\' Shipping & Returns', () => {
    const view = productView({
      product: product('p1', { colourName: 'Brown' }),
      onSale: onSale('p1', { from: true, memberPrice: '40.00', fulfilmentMethod: 'pickup' }),
      settings: null,
      onSaleIds: new Set(['p1']),
    })
    expect([view.id, view.name, view.colourName, view.soldOut, view.fulfilment]).toEqual(['p1', 'Product p1', 'Brown', false, 'Collection from the Paddock only.'])
    expect(view.price).toEqual({ now: '£45', from: true, before: null, member: '£40' })
    expect(view.sizes.map((one) => one.size)).toEqual(['S', 'M'])
    expect([view.shipping, view.materials, view.sizeGuide, view.colours]).toEqual([[], null, null, []])
  })
})

describe('Similar Merch (WQ6; W78b: WQ74, the row always fills)', () => {
  const all = [content('e'), content('d', { category: HOODIES }), content('c', { family: 'fam' }), content('b'), content('a'), content('self', { family: 'fam' })]
  const shop = shopOf(all.map((one) => onSale(one.id, { category: one.category!.id, soldOut: one.id === 'b' })), { giftCards: [{ sanityId: 'gift', lowestAmount: '15.00' }] })
  const items = shopItems({ products: all, giftCard: giftCard({ category: APPAREL }), shop, today: TODAY })
  const similar = (over: Partial<Product>, length?: number) => similarCards({ product: product('self', { family: 'fam', ...over }), products: all, items, ...(length ? { length } : {}) }).map((card) => card.id)

  it("with no picks: others of its category, newest first, then every other product, then its own other colours; never itself or the gift card; a sold-out one keeps its card", () => {
    expect(similar({})).toEqual(['e', 'b', 'a', 'd'])
    expect(similar({}, 10)).toEqual(['e', 'b', 'a', 'd', 'c'])
    expect(items.find((item) => item.card.id === 'b')?.card.soldOut).toBe(true)
    expect(items.some((item) => item.card.id === 'gift')).toBe(true)
  })
  it("the editor's picks come first, in their order, then the category's, up to the row's length; nothing is shown twice", () => {
    expect(similar({ similarIds: ['d', 'a', 'off-sale', 'self'] })).toEqual(['d', 'a', 'e', 'b'])
    expect(similar({ similarIds: ['d', 'a'] }, 2)).toEqual(['d', 'a'])
    // A pick may be one of its own colours: the editor chose it.
    expect(similar({ similarIds: ['c'] })).toEqual(['c', 'e', 'b', 'a'])
    expect(similar({ similarIds: ['a', 'a', 'gift'] }, 10)).toEqual(['a', 'e', 'b', 'd', 'c'])
  })
  it('a product whose category holds nothing else is filled from the rest of the shop, newest first', () => {
    const cards = similarCards({ product: product('d', { category: HOODIES }), products: all, items }).map((card) => card.id)
    expect(cards).toEqual(['e', 'c', 'b', 'a'])
    const noCategory = shopItems({ products: all, giftCard: null, shop: shopOf(all.map((one) => onSale(one.id, { category: null }))), today: TODAY })
    expect(similarCards({ product: product('self', { family: 'fam' }), products: all, items: noCategory }).map((card) => card.id)).toEqual(['e', 'd', 'b', 'a'])
  })
  it('its own other colours fill the row when the shop has nothing else', () => {
    const colours = [content('c', { family: 'fam' }), content('self', { family: 'fam' })]
    const only = shopItems({ products: colours, giftCard: giftCard(), shop: shopOf(colours.map((one) => onSale(one.id)), { giftCards: [{ sanityId: 'gift', lowestAmount: '15.00' }] }), today: TODAY })
    expect(similarCards({ product: product('self', { family: 'fam' }), products: colours, items: only }).map((card) => card.id)).toEqual(['c'])
  })
  it('is empty only when the shop has no other product, and the row is then hidden', () => {
    const alone = shopItems({ products: [content('self')], giftCard: giftCard(), shop: shopOf([onSale('self')], { giftCards: [{ sanityId: 'gift', lowestAmount: '15.00' }] }), today: TODAY })
    expect(alone.map((item) => item.card.id)).toEqual(['self', 'gift'])
    expect(similarCards({ product: product('self'), products: [content('self')], items: alone })).toEqual([])
  })
})

describe("a product's title and description for search results", () => {
  it('"{Name} - {Colour}", or the name alone', () => {
    expect([productTitle({ name: 'The Paddock T-Shirt', colourName: 'Brown' }), productTitle({ name: 'Tote', colourName: ' ' }), productTitle({ name: 'Tote', colourName: null })]).toEqual(['The Paddock T-Shirt - Brown', 'Tote', 'Tote'])
  })
  it('the first 155 characters of its description, cut at a word; none with no description', () => {
    const block = (text: string) => ({ _type: 'block' as const, _key: text.slice(0, 4), style: 'normal' as const, listItem: null, level: null, children: [{ _type: 'span' as const, _key: 's', text, marks: [] }], markDefs: [] })
    expect(plainText([block('Soft  and warm.'), block('Oversized fit')])).toBe('Soft and warm. Oversized fit')
    expect(metaDescription('Soft and warm.')).toBe('Soft and warm.')
    const long = metaDescription('word '.repeat(60))!
    expect(long.length).toBeLessThanOrEqual(155)
    expect(long.endsWith('word…')).toBe(true)
    expect(metaDescription('   ')).toBeNull()
  })
})

describe("the sizes asked again after load (W74a's availability route)", () => {
  const answer = { ok: true, data: { product: 'p1', soldOut: false, sizes: [size('S'), size('M', false)] }, requestId: 'r' }

  it('asks the one public route for this product, its id made safe for an address', () => {
    expect(availabilityAddress('p1')).toBe('/api/v1/shop/availability?product=p1')
    expect(availabilityAddress('a b&c')).toBe('/api/v1/shop/availability?product=a%20b%26c')
  })
  it("takes the route's answer for this product", () => {
    expect(availabilityFrom(answer, 'p1')).toEqual(answer.data)
  })
  it("anything else is null, and the page keeps what it was sent with: a refusal, another product's answer, a shape it doesn't know", () => {
    expect(availabilityFrom({ ok: false, error: { code: 'NOT_FOUND', message: "This product isn't on sale." } }, 'p1')).toBeNull()
    expect(availabilityFrom(answer, 'p2')).toBeNull()
    expect(availabilityFrom({ ok: true, data: { product: 'p1', soldOut: 'no', sizes: [] } }, 'p1')).toBeNull()
    expect(availabilityFrom({ ok: true, data: { product: 'p1', soldOut: false, sizes: [{ size: 'S', available: 'yes' }] } }, 'p1')).toBeNull()
    for (const nothing of [null, undefined, 'text', 3, []]) expect(availabilityFrom(nothing, 'p1')).toBeNull()
  })
  it('never throws and never caches: no network, a refusal or a broken answer is null', async () => {
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)
    fetched.mockResolvedValueOnce({ ok: true, json: async () => answer })
    expect(await readAvailability('p1')).toEqual(answer.data)
    expect(fetched).toHaveBeenCalledWith('/api/v1/shop/availability?product=p1', { cache: 'no-store' })
    fetched.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false }) })
    expect(await readAvailability('p1')).toBeNull()
    fetched.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await readAvailability('p1')).toBeNull()
    fetched.mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('not JSON') } })
    expect(await readAvailability('p1')).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('the bag (the buying stage builds it)', () => {
  it('addToBag() is the one seam: it adds nothing yet, says so, and writes nothing to the console', () => {
    const complaints = [vi.spyOn(console, 'error').mockImplementation(() => undefined), vi.spyOn(console, 'warn').mockImplementation(() => undefined), vi.spyOn(console, 'log').mockImplementation(() => undefined)]
    expect(addToBag({ product: 'p1', size: 'M' })).toBe(false)
    expect(addToBag({ product: 'p1', size: null })).toBe(false)
    for (const complaint of complaints) expect(complaint).not.toHaveBeenCalled()
  })
})
