import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { reads } from '@/lib/sanity/read'
import answers from '@/lib/sanity/sample-answers.json'

import type { Shop, ShopProduct } from './read'

// Brief W74, item 5: what /shop and /shop/[slug] answer. A product shows only when it is published in Sanity and on
// sale in the database; an old slug is a permanent redirect (W72a), anything else a 404. Sanity is stood in for by
// the samples its own engine made (lib/sanity/sample-answers.json: the Herd Hoodie in Moss and in Sand, the gift
// card, Shop settings), the Worker's read by a shop made here.

const fetched = vi.hoisted(() => vi.fn())
const readShop = vi.hoisted(() => vi.fn())
const kept = vi.hoisted(() => ({ calls: [] as Array<{ keys: unknown; options: unknown }> }))
vi.mock('@sanity/client', () => ({ createClient: () => ({ fetch: fetched }) }))
// Outside a request there is nothing to wait for.
vi.mock('next/server', () => ({ connection: async () => undefined }))
// React's `cache` shares a read inside one request; here every call is its own.
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), cache: <T>(read: T) => read }))
// Next's data cache: here it keeps nothing, and says what it was asked to keep and for how long.
vi.mock('next/cache', () => ({
  unstable_cache: <T>(read: T, keys: unknown, options: unknown): T => {
    kept.calls.push({ keys, options })
    return read
  },
}))
vi.mock('@/server/rules/shop/reads', () => ({ readShop }))
// W75: lib/shop/read.ts reads the events too; the shop's pages never ask for them.
vi.mock('@/server/rules/shop/events', () => ({ readShopEvents: vi.fn(), readShopEvent: vi.fn() }))

const { findProductPage, readShopCatalogue } = await import('./pages')
const { SHOP_KEPT_SECONDS } = await import('./read')

const size = (name: string, available = true) => ({ size: name, available, price: '60.00', memberPrice: '54.00', priceBeforeSale: null, percentOff: null })
const onSale = (id: string, over: Partial<ShopProduct> = {}): ShopProduct => ({
  sanityId: id,
  category: 'cat-apparel',
  fulfilmentMethod: 'both',
  price: '60.00',
  from: false,
  memberPrice: '54.00',
  priceBeforeSale: null,
  percentOff: null,
  soldOut: false,
  sizes: [size('S'), size('M', false)],
  ...over,
})
const shopOf = (over: Partial<Shop> = {}): Shop => ({
  products: [onSale('prod-1'), onSale('prod-2', { category: null })],
  categories: [{ sanityId: 'cat-apparel', title: 'Apparel' }],
  giftCards: [{ sanityId: 'gift', lowestAmount: '15.00' }],
  ...over,
})

/** Sanity, answering by the query it is sent. */
const sanity = (products: Record<string, unknown>, moved: Record<string, { slug: string; isHome: boolean }> = {}) => {
  fetched.mockImplementation(async (query: string, params: { slug?: string; type?: string }) => {
    if (query === reads.movedSlug.query) return moved[`${params.type} ${params.slug}`] ?? null
    if (query === reads.product.query) return products[params.slug ?? ''] ?? null
    if (query === reads.productCards.query) return answers.productCards
    if (query === reads.giftCard.query) return answers.giftCard
    if (query === reads.shopSettings.query) return answers.shopSettings
    throw new Error(`A read the shop's pages should not make: ${query.slice(0, 60)}`)
  })
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
  readShop.mockResolvedValue(shopOf())
})
afterEach(() => {
  vi.unstubAllEnvs()
  fetched.mockReset()
  readShop.mockReset()
})

describe('the Shop, at /shop', () => {
  it("is Shop settings, every product that is published and on sale as its card, the gift card, and the Worker's categories", async () => {
    sanity({})
    const { settings, items, categories } = await readShopCatalogue()
    expect([settings?.title, settings?.featuredIds]).toEqual(['Shop', ['gift', 'prod-1']])
    // Sanity's order (newest first), then the gift card.
    expect(items.map((item) => [item.card.id, item.card.href, item.category])).toEqual([
      ['prod-2', '/shop/herd-hoodie-sand', null],
      ['prod-1', '/shop/herd-hoodie-moss', 'cat-apparel'],
      ['gift', '/shop/gift-card', 'cat-apparel'],
    ])
    expect(items.find((item) => item.card.id === 'gift')?.card.price).toEqual({ now: '£15', from: true, before: null })
    expect(categories).toEqual([{ id: 'cat-apparel', slug: 'apparel', title: 'Apparel' }])
  })
  it('a product published in Sanity but not on sale in the database is not listed', async () => {
    sanity({})
    readShop.mockResolvedValue(shopOf({ products: [onSale('prod-1')] }))
    expect((await readShopCatalogue()).items.map((item) => item.card.id)).toEqual(['prod-1', 'gift'])
  })
  it('a shop that could not be read is an error, never an empty shop', async () => {
    sanity({})
    readShop.mockRejectedValue(new Error('The database connection is not set up'))
    await expect(readShopCatalogue()).rejects.toThrow('The database connection is not set up')
  })
})

describe('a product, at /shop/[slug]', () => {
  it('published in Sanity and on sale in the database: its page, with its sizes, its family and Similar Merch', async () => {
    sanity({ 'herd-hoodie-moss': answers.product })
    const { page, movedTo } = await findProductPage('herd-hoodie-moss')
    expect(movedTo).toBeNull()
    expect([page?.product.slug, page?.view.id, page?.view.name, page?.view.colourName]).toEqual(['herd-hoodie-moss', 'prod-1', 'Herd Hoodie', 'Moss'])
    expect(page?.view.price).toEqual({ now: '£60', from: false, before: null, member: '£54' })
    expect(page?.view.sizes.map((one) => [one.size, one.available])).toEqual([
      ['S', true],
      ['M', false],
    ])
    // Its family: itself and the Sand one, which is on sale.
    expect(page?.view.colours.map((colour) => [colour.name, colour.current])).toEqual([
      ['Moss', true],
      ['Sand', false],
    ])
    expect(page?.view.fulfilment).toBe('Delivery or collection from the Paddock.')
    expect(page?.view.shipping.length).toBeGreaterThan(0)
  })
  it('published in Sanity but off sale in the database: nothing (a 404)', async () => {
    sanity({ 'herd-hoodie-moss': answers.product })
    readShop.mockResolvedValue(shopOf({ products: [onSale('prod-2')] }))
    expect(await findProductPage('herd-hoodie-moss')).toEqual({ page: null, movedTo: null })
  })
  it('a slug the product had before: where it is now (a 308), and the database is not asked', async () => {
    sanity({}, { 'product old-hoodie': { slug: 'herd-hoodie-moss', isHome: false } })
    expect(await findProductPage('old-hoodie')).toEqual({ page: null, movedTo: '/shop/herd-hoodie-moss' })
    expect(readShop).not.toHaveBeenCalled()
  })
  it('a slug no product has or had: nothing (a 404); the gift card\'s own address is not a product', async () => {
    sanity({})
    expect(await findProductPage('no-such-thing')).toEqual({ page: null, movedTo: null })
    expect(await findProductPage('gift-card')).toEqual({ page: null, movedTo: null })
    expect(readShop).not.toHaveBeenCalled()
  })
  it('a colour of its family that is off sale has no swatch', async () => {
    sanity({ 'herd-hoodie-moss': answers.product })
    readShop.mockResolvedValue(shopOf({ products: [onSale('prod-1')] }))
    const { page } = await findProductPage('herd-hoodie-moss')
    expect(page?.view.colours.map((colour) => colour.name)).toEqual(['Moss'])
  })
})

describe("the Worker's read of the shop", () => {
  it('is kept for at most 60 seconds, under one key; W75: the events list and each event under their own', () => {
    expect(SHOP_KEPT_SECONDS).toBe(60)
    expect(kept.calls).toEqual([
      { keys: ['shop'], options: { revalidate: 60 } },
      { keys: ['shop-events'], options: { revalidate: 60 } },
      { keys: ['shop-event'], options: { revalidate: 60 } },
    ])
  })

  const web = path.resolve(__dirname, '../..')
  const filesIn = (folder: string): string[] =>
    readdirSync(path.join(web, folder)).flatMap((name) => {
      const file = path.join(folder, name)
      return statSync(path.join(web, file)).isDirectory() ? filesIn(file) : /\.(ts|tsx)$/.test(name) && !/\.(test|stories)\./.test(name) ? [file] : []
    })

  it('lib/shop/read.ts is the one file of the shop that reads through server code, and gift-card-amount.ts brings the Other rule (W76a): no page or component reads a table or works a price out', () => {
    const users = ['app/shop', 'components/shop', 'lib/shop'].flatMap(filesIn).filter((file) => /['"](@\/server|(\.\.\/)+server)[/'"]/.test(readFileSync(path.join(web, file), 'utf8')))
    expect(users).toEqual(['lib/shop/gift-card-amount.ts', 'lib/shop/read.ts'])
  })
  it('and nothing in the shop writes a price by arithmetic: every figure shown is one of W74a\'s, through pounds()', () => {
    const source = (file: string) => readFileSync(path.join(web, file), 'utf8')
    // The stories' sample shop (sample-shop.ts) is not the site.
    for (const file of [...filesIn('components/shop'), ...filesIn('app/shop')].filter((one) => !path.basename(one).startsWith('sample-'))) {
      expect(source(file), file).not.toMatch(/toFixed|parseFloat|Number\(|inPence/)
    }
  })
})
