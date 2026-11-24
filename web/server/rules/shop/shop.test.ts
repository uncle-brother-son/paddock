import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as availabilityRoute } from '@/app/api/v1/shop/availability/route'
import { shopAvailabilityRouteOutputSchema, type ShopAvailabilityRouteOutput } from '@/contracts'
import type { Db } from '@/server/db'
import { variantPriceFor } from '@/server/rules/orders/catalog-price'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { SHOP_WORDS } from './failure-messages'
import { listShopCategories, listShopGiftCards, listShopProducts, readShop, type ShopProduct } from './reads'

// Brief W74a: the website's shop reads and its public route, on the live schema.
vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown, closed: 0 }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {
    holder.closed += 1
  },
}))

let database: TestDatabase
let db: Db

beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())
beforeEach(async () => {
  await database.pg.exec('RESET ROLE; TRUNCATE product_variants, products, product_categories, gift_card_presets, gift_card_types CASCADE; SET ROLE paddock_worker;')
  holder.closed = 0
})

let made = 0
/** A product on sale, with its sizes: each `[size, stock, price override]`, made in the order given. */
async function product(sanityId: string | null, row: Record<string, unknown>, sizes: Array<[size: string | null, stock: number, override?: string]> = [['M', 3]]): Promise<string> {
  const id = await insert(db, 'products', { sanity_product_id: sanityId, name: sanityId ?? 'No document', stripe_product_id: `prod_${++made}`, stripe_price_id_base: `price_base_${made}`, ...row })
  for (const [index, [size, stock, override]] of sizes.entries()) {
    await insert(db, 'product_variants', {
      product_id: id,
      size,
      sku: `SKU-${made}-${index}`,
      stock_quantity: stock,
      stripe_price_id: `price_${made}_${index}`,
      price_override: override ?? null,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    })
  }
  return id
}

/** A category's row, as Sanity's webhook writes one. */
const category = (id: string, title: string, order: number | null) =>
  db.query('INSERT INTO product_categories (sanity_category_id, title, sort_order) VALUES ($1, $2, $3::integer)', [id, title, order])

async function only(): Promise<ShopProduct> {
  const products = await listShopProducts(db)
  expect(products).toHaveLength(1)
  return products[0] as ShopProduct
}

const ask = async (query: string) => {
  const response = await availabilityRoute(new Request(`https://worker.test/api/v1/shop/availability${query}`))
  const body = (await response.json()) as { ok: boolean; data?: ShopAvailabilityRouteOutput; error?: { code: string; message: string; field?: string } }
  return { status: response.status, cacheControl: response.headers.get('Cache-Control'), body }
}

/** Every field name anywhere in an answer. */
const fieldsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(fieldsOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, inner]) => [name, ...fieldsOf(inner)]) : []
const FORBIDDEN_FIELD = /stock|quantity|stripe/i

describe('products on sale', () => {
  it('each with its Sanity id, its category id, its fulfilment method and its sizes; nothing else', async () => {
    await product('tee', { category: 'productCategory-apparel', base_price: '28.00', fulfillment_method: 'shipping' }, [['M', 2]])
    expect(await only()).toEqual({
      sanityId: 'tee',
      category: 'productCategory-apparel',
      fulfilmentMethod: 'shipping',
      price: '28.00',
      from: false,
      memberPrice: null,
      priceBeforeSale: null,
      percentOff: null,
      soldOut: false,
      sizes: [{ size: 'M', available: true, price: '28.00', memberPrice: null, priceBeforeSale: null, percentOff: null }],
    })
  })

  it('an off-sale product is absent, and so is one with no Sanity document', async () => {
    await product('on', { base_price: '20.00' })
    await product('off', { base_price: '20.00', active: false })
    await product(null, { base_price: '20.00' })
    expect((await listShopProducts(db)).map((one) => one.sanityId)).toEqual(['on'])
  })

  it("in their category's Order, then by name; one whose category has no row comes last", async () => {
    await category('zed', 'Zed', 1)
    await category('ay', 'Ay', 2)
    await product('a-none', { base_price: '1.00' })
    await product('b-ay', { base_price: '1.00', category: 'ay' })
    await product('d-zed', { base_price: '1.00', category: 'zed' })
    await product('c-zed', { base_price: '1.00', category: 'zed' })
    expect((await listShopProducts(db)).map((one) => one.sanityId)).toEqual(['c-zed', 'd-zed', 'b-ay', 'a-none'])
  })
})

describe('sizes', () => {
  it('in shop order, odd sizes after the named ones and the numbers, in the order created', async () => {
    await product('tee', { base_price: '28.00' }, [['L', 1], ['Tall', 1], ['M', 1], ['10', 1], ['S', 1], ['8', 1], ['Kids', 1], ['XL', 1]])
    expect((await only()).sizes.map(({ size }) => size)).toEqual(['S', 'M', 'L', 'XL', '8', '10', 'Tall', 'Kids'])
  })

  it('"One Size" alone', async () => {
    await product('mug', { base_price: '12.00' }, [['One Size', 4]])
    expect((await only()).sizes.map(({ size, available }) => [size, available])).toEqual([['One Size', true]])
  })

  it('a size is available when its stock is above 0; a product with one size left is not sold out', async () => {
    await product('tee', { base_price: '28.00' }, [['S', 0], ['M', 1], ['L', 0]])
    const tee = await only()
    expect(tee.sizes.map(({ size, available }) => [size, available])).toEqual([['S', false], ['M', true], ['L', false]])
    expect(tee.soldOut).toBe(false)
  })

  it('with none left it is sold out, still listed, and keeps its price; so is one with no sizes yet', async () => {
    await product('tee', { base_price: '28.00' }, [['S', 0], ['M', 0]])
    expect(await only()).toMatchObject({ soldOut: true, price: '28.00' })
    await product('new', { base_price: '15.00', member_price: '12.00' }, [])
    expect((await listShopProducts(db)).find((one) => one.sanityId === 'new')).toMatchObject({ soldOut: true, sizes: [], price: '15.00', from: false, memberPrice: '12.00' })
  })
})

describe("prices for display, all from the checkout's rule", () => {
  it('a sale: the price, the price before it, and the percent off rounded to the nearest whole number', async () => {
    await product('tee', { base_price: '30.00', sale_price: '20.00' }, [['S', 1], ['M', 1]])
    expect(await only()).toMatchObject({ price: '20.00', priceBeforeSale: '30.00', percentOff: 33, from: false })
  })

  it.each([
    ['28.00', '21.00', 25],
    ['30.00', '10.00', 67],
    ['40.00', '35.00', 13],
    ['29.99', '14.99', 50],
  ])('%s to %s is %d%% off', async (base, sale, percent) => {
    await product('tee', { base_price: base, sale_price: sale })
    const tee = await only()
    expect([tee.price, tee.priceBeforeSale, tee.percentOff]).toEqual([sale, base, percent])
    expect(tee.sizes[0]).toMatchObject({ price: sale, priceBeforeSale: base, percentOff: percent })
  })

  it('no sale, a sale price with no base price, or one that is no reduction: no price before and no percent', async () => {
    await product('none', { base_price: '30.00' })
    await product('no-base', { sale_price: '20.00' })
    await product('same', { base_price: '20.00', sale_price: '20.00' })
    await product('dearer', { base_price: '20.00', sale_price: '25.00' })
    expect((await listShopProducts(db)).map((one) => [one.sanityId, one.price, one.priceBeforeSale, one.percentOff])).toEqual([
      ['dearer', '25.00', null, null],
      ['no-base', '20.00', null, null],
      ['none', '30.00', null, null],
      ['same', '20.00', null, null],
    ])
  })

  it('a member price only when the product has one', async () => {
    await product('with', { base_price: '28.00', member_price: '24.00' })
    await product('without', { base_price: '28.00', sale_price: '20.00' })
    expect((await listShopProducts(db)).map((one) => [one.sanityId, one.price, one.memberPrice, one.sizes[0]?.memberPrice])).toEqual([
      ['with', '28.00', '24.00', '24.00'],
      ['without', '20.00', null, null],
    ])
  })

  it('a product only members can buy: no non-member price', async () => {
    await product('tee', { member_price: '24.00' })
    expect(await only()).toMatchObject({ price: null, from: false, memberPrice: '24.00' })
  })

  it('sizes at different prices: "From" the lowest (as money, not as text); at one price, not', async () => {
    await product('differ', { base_price: '28.00' }, [['S', 1, '100.00'], ['M', 1, '9.50'], ['L', 1]])
    expect(await only()).toMatchObject({ price: '9.50', from: true })
    await product('same', { base_price: '28.00' }, [['S', 1, '28.00'], ['M', 1]])
    expect((await listShopProducts(db)).find((one) => one.sanityId === 'same')).toMatchObject({ price: '28.00', from: false })
  })

  it("a size at its own price isn't reduced by the product's sale, as the checkout charges it", async () => {
    await product('tee', { base_price: '30.00', sale_price: '20.00' }, [['S', 1], ['XL', 1, '35.00']])
    const tee = await only()
    expect(tee).toMatchObject({ price: '20.00', from: true, priceBeforeSale: '30.00', percentOff: 33 })
    expect(tee.sizes.map(({ size, price, priceBeforeSale }) => [size, price, priceBeforeSale])).toEqual([['S', '20.00', '30.00'], ['XL', '35.00', null]])
    await database.pg.exec("RESET ROLE; UPDATE product_variants SET price_override = '20.00' WHERE size = 'XL'; SET ROLE paddock_worker;")
    // Both sizes sell at £20.00 now and only one of them is reduced, so the product as a whole shows no reduction.
    expect(await only()).toMatchObject({ price: '20.00', from: false, priceBeforeSale: null, percentOff: null })
  })

  it("every size shows what the checkout's rule answers for it, member and not", async () => {
    const prices = { base_price: '30.00', member_price: '24.00', sale_price: '26.00' }
    await product('tee', prices, [['S', 1], ['M', 1, '31.00']])
    expect((await only()).sizes.map(({ price, memberPrice }) => [price, memberPrice])).toEqual(
      [null, '31.00'].map((price_override) => [variantPriceFor({ ...prices, price_override }, false), variantPriceFor({ ...prices, price_override }, true)])
    )
  })
})

describe('categories', () => {
  it('only those with a product on sale, in their Order, then by title; one with only off-sale products is absent', async () => {
    await category('hats', 'Hats', null)
    await category('apparel', 'Apparel', 2)
    await category('hoodies', 'Hoodies', 1)
    await category('off', 'Off sale', 0)
    await category('empty', 'Empty', 0)
    await category('bags', 'Bags', null)
    await product('1', { base_price: '1.00', category: 'hats' })
    await product('2', { base_price: '1.00', category: 'apparel' })
    await product('3', { base_price: '1.00', category: 'hoodies' }, [['M', 0]])
    await product('4', { base_price: '1.00', category: 'off', active: false })
    await product('5', { base_price: '1.00', category: 'bags' })
    await product('6', { base_price: '1.00', category: 'apparel', active: false })
    expect(await listShopCategories(db)).toEqual([
      { sanityId: 'hoodies', title: 'Hoodies' },
      { sanityId: 'apparel', title: 'Apparel' },
      { sanityId: 'bags', title: 'Bags' },
      { sanityId: 'hats', title: 'Hats' },
    ])
  })
})

describe('the gift card', () => {
  const type = (sanityId: string, row: Record<string, unknown> = {}) => insert(db, 'gift_card_types', { sanity_gift_card_type_id: sanityId, name: sanityId, stripe_product_id: `prod_gift_${sanityId}`, ...row })
  const preset = (typeId: string, amount: string, active = true) => insert(db, 'gift_card_presets', { gift_card_type_id: typeId, amount, active, stripe_price_id: `price_gift_${++made}` })

  it('the lowest active preset (as money, not as text); an inactive one is ignored', async () => {
    const gift = await type('gift')
    for (const amount of ['100.00', '25.00', '50.00']) await preset(gift, amount)
    await preset(gift, '10.00', false)
    expect(await listShopGiftCards(db)).toEqual([{ sanityId: 'gift', lowestAmount: '25.00' }])
  })

  it('none gives null, custom amounts or not; a type off sale is absent', async () => {
    const gift = await type('gift', { custom_amount_enabled: true, custom_amount_min: '5.00', custom_amount_max: '500.00' })
    await preset(gift, '10.00', false)
    const off = await type('off', { active: false })
    await preset(off, '10.00')
    expect(await listShopGiftCards(db)).toEqual([{ sanityId: 'gift', lowestAmount: null }])
  })
})

describe('GET /api/v1/shop/availability', () => {
  it("answers the product's sizes now and whether it is sold out, with no sign-in, never cached", async () => {
    await product('other', { base_price: '5.00' })
    const id = await product('tee-1', { base_price: '28.00', member_price: '24.00' }, [['L', 4], ['S', 0]])
    const { status, cacheControl, body } = await ask('?product=tee-1')
    expect([status, cacheControl]).toEqual([200, 'no-store'])
    expect(body.data).toEqual({
      product: 'tee-1',
      soldOut: false,
      sizes: [
        { size: 'S', available: false, price: '28.00', memberPrice: '24.00', priceBeforeSale: null, percentOff: null },
        { size: 'L', available: true, price: '28.00', memberPrice: '24.00', priceBeforeSale: null, percentOff: null },
      ],
    })
    await db.query('UPDATE product_variants SET stock_quantity = 0 WHERE product_id = $1::uuid', [id])
    expect((await ask('?product=tee-1')).body.data).toMatchObject({ soldOut: true, sizes: [{ available: false }, { available: false }] })
  })

  it('holds no stock number and no Stripe id, and neither does the shop read', async () => {
    await product('tee-1', { base_price: '28.00', stripe_price_id_member: 'price_member_x', stripe_price_id_sale: 'price_sale_x' }, [['M', 8731]])
    const gift = await insert(db, 'gift_card_types', { sanity_gift_card_type_id: 'gift', name: 'Gift', stripe_product_id: 'prod_gift' })
    await insert(db, 'gift_card_presets', { gift_card_type_id: gift, amount: '25.00', stripe_price_id: 'price_gift' })
    for (const answer of [(await ask('?product=tee-1')).body, await readShop()]) {
      expect(fieldsOf(answer).filter((name) => FORBIDDEN_FIELD.test(name))).toEqual([])
      expect(JSON.stringify(answer)).not.toMatch(/8731|"(prod|price)_/)
    }
    // The check sees one, and the route's contract refuses one.
    expect(fieldsOf({ sizes: [{ stock_quantity: 1 }], stripe_price_id: 'x' }).filter((name) => FORBIDDEN_FIELD.test(name))).toEqual(['stock_quantity', 'stripe_price_id'])
    const size = { size: 'M', available: true, price: '28.00', memberPrice: null, priceBeforeSale: null, percentOff: null }
    const answer = (extra: object, sizeExtra: object) => shopAvailabilityRouteOutputSchema.safeParse({ product: 'tee-1', soldOut: false, sizes: [{ ...size, ...sizeExtra }], ...extra }).success
    expect([answer({}, {}), answer({}, { stock_quantity: 3 }), answer({}, { stripe_price_id: 'price_x' }), answer({ stripe_product_id: 'prod_x' }, {})]).toEqual([true, false, false, false])
  })

  it.each([
    ['none', ''],
    ['an empty one', '?product='],
    ['a space', '?product=tee%201'],
    ['SQL', "?product=tee'%3B--"],
    ['a path', '?product=..%2Fstaff'],
    ['one starting with a dot', '?product=.tee'],
    ['one too long', `?product=${'a'.repeat(129)}`],
    ['two', '?product=tee-1&product=tee-2'],
  ])('refuses a product that is not a well-formed id (%s): 400, and nothing is read', async (_label, query) => {
    const spy = vi.spyOn(db, 'query')
    const { status, cacheControl, body } = await ask(query)
    expect([status, cacheControl, body.ok, body.error?.code, body.error?.field]).toEqual([400, 'no-store', false, 'VALIDATION', 'product'])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it.each(['3f2b1c9e-8a7d-4f6e-9b0c-112233445566', 'product-hoodie_black.v2'])('takes an id as Sanity writes one (%s)', async (id) => {
    await product(id, { base_price: '28.00' })
    expect((await ask(`?product=${id}`)).status).toBe(200)
  })

  it('an unknown product and an off-sale one are refused the same way: 404', async () => {
    await product('off', { base_price: '28.00', active: false })
    for (const id of ['unknown', 'off']) {
      const { status, cacheControl, body } = await ask(`?product=${id}`)
      expect([status, cacheControl, body.error?.code, body.error?.message]).toEqual([404, 'no-store', 'NOT_FOUND', SHOP_WORDS.notOnSale])
    }
  })
})

describe('readShop, for a page to call', () => {
  it('reads the three on a connection of its own, and closes it, a failed read included', async () => {
    await product('tee', { base_price: '28.00' })
    expect(await readShop()).toMatchObject({ products: [{ sanityId: 'tee' }], categories: [], giftCards: [] })
    expect(holder.closed).toBe(1)
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('down'))
    await expect(readShop()).rejects.toThrow('down')
    expect(holder.closed).toBe(2)
    spy.mockRestore()
  })
})
