import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as addonActiveRoute } from '@/app/api/v1/staff/catalog/addons/[addonId]/active/route'
import { POST as addonPriceRoute } from '@/app/api/v1/staff/catalog/addons/[addonId]/price/route'
import { POST as addonSkuRoute } from '@/app/api/v1/staff/catalog/addons/[addonId]/sku/route'
import { GET as addonsRoute } from '@/app/api/v1/staff/catalog/addons/route'
import { POST as presetActiveRoute } from '@/app/api/v1/staff/catalog/gift-card-presets/[presetId]/active/route'
import { POST as presetPriceRoute } from '@/app/api/v1/staff/catalog/gift-card-presets/[presetId]/price/route'
import { POST as giftTypeActiveRoute } from '@/app/api/v1/staff/catalog/gift-card-types/[giftCardTypeId]/active/route'
import { POST as giftTypeDetailsRoute } from '@/app/api/v1/staff/catalog/gift-card-types/[giftCardTypeId]/details/route'
import { POST as presetCreateRoute } from '@/app/api/v1/staff/catalog/gift-card-types/[giftCardTypeId]/presets/route'
import { GET as giftTypesRoute } from '@/app/api/v1/staff/catalog/gift-card-types/route'
import { POST as productActiveRoute } from '@/app/api/v1/staff/catalog/products/[productId]/active/route'
import { POST as fulfilmentRoute } from '@/app/api/v1/staff/catalog/products/[productId]/fulfilment/route'
import { POST as productPriceRoute } from '@/app/api/v1/staff/catalog/products/[productId]/price/route'
import { POST as variantCreateRoute } from '@/app/api/v1/staff/catalog/products/[productId]/variants/route'
import { GET as productsRoute } from '@/app/api/v1/staff/catalog/products/route'
import { POST as serviceTypeActiveRoute } from '@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/active/route'
import { POST as serviceTypeDetailsRoute } from '@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/details/route'
import { POST as tierCreateRoute } from '@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/tiers/route'
import { GET as serviceTypesRoute } from '@/app/api/v1/staff/catalog/service-types/route'
import { POST as passActiveRoute } from '@/app/api/v1/staff/catalog/session-pass-types/[passTypeId]/active/route'
import { POST as passDetailsRoute } from '@/app/api/v1/staff/catalog/session-pass-types/[passTypeId]/details/route'
import { GET as levelQuoteRoute } from '@/app/api/v1/staff/catalog/session-pass-types/[passTypeId]/level-quote/route'
import { POST as passPriceRoute } from '@/app/api/v1/staff/catalog/session-pass-types/[passTypeId]/price/route'
import { GET as passTypesRoute } from '@/app/api/v1/staff/catalog/session-pass-types/route'
import { POST as tierRangeRoute } from '@/app/api/v1/staff/catalog/tier-groups/range/route'
import { POST as tierPriceRoute } from '@/app/api/v1/staff/catalog/tiers/[tierId]/price/route'
import { POST as variantDetailsRoute } from '@/app/api/v1/staff/catalog/variants/[variantId]/details/route'
import { GET as historyRoute } from '@/app/api/v1/staff/catalog/variants/[variantId]/stock-adjustments/route'
import { POST as stockRoute } from '@/app/api/v1/staff/catalog/variants/[variantId]/stock/route'
import { catalogAddonsRouteOutputSchema, catalogProductsRouteOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { CHANGED_SINCE_WORDS } from '@/server/rules/admin/stamp'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { ADMIN_TEST_KEY, auditRowsOf, pressRoute, type AdminAnswer, type AdminRouteHandler } from '@/server/rules/testing/admin-routes'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { CATALOG_ADMIN_DIALOG_WORDS, CATALOG_ADMIN_WORDS } from './failure-messages'
import { CATALOG_ITEM_NEW_WORDS, passLevelHolderWords } from './item-failure-messages'
import { isPoundsAndPence, listAddons, listProducts, priceText } from './items'
import { listGiftCardTypes, listPassTypes } from './passes-gift-cards'

// Briefs W55 + W56: the catalogue's rules through their real routes, on the live schema.
vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const JO = 'jo@example.com'
const TIA = 'tia@example.com'
const INA = 'ina@example.com'
const NOBODY = 'nobody@example.com'
const OLD = CATALOG_ADMIN_WORDS
const NEW = CATALOG_ITEM_NEW_WORDS
const INACTIVE = STAFF_ADMIN_WORDS.staffAccess.staffAccountInactiveAskAdminReactivate
const NO_STAFF_ROW = STAFF_ADMIN_WORDS.staffAccess.noStaffRecordMatchesLoggedIn(NOBODY)
const NO_PRICING = STAFF_ADMIN_WORDS.pricingStaff.youDoNotHavePermissionManage
const UNKNOWN_ID = '10000000-0000-4000-8000-000000000f55'

let database: TestDatabase
let db: Db
let jo = ''
let product = ''
let variant = ''
let addon = ''
let serviceType = ''
let privateType = ''
let core = ''
let peak = ''
let passType = ''
let giftType = ''
let preset = ''

beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())

/** Jo (admin, Manage pricing), Tia (staff, no Manage pricing), Ina (inactive); one of each catalogue item. */
beforeEach(async () => {
  await database.pg.exec(
    'RESET ROLE; TRUNCATE audit_log, api_idempotency, stock_adjustments, product_variants, products, addons, service_type_price_tiers, service_types, session_bands, customer_session_passes, session_pass_types, gift_cards, gift_card_presets, gift_card_types, customers, staff CASCADE; SET ROLE paddock_worker;'
  )
  jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  await insert(db, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: TIA })
  await insert(db, 'staff', { role: 'staff', first_name: 'Ina', last_name: 'Gone', email: INA, active: false })
  product = await insert(db, 'products', { name: 'T-shirt', category: 'Merch', base_price: '20.00', stripe_product_id: 'prod_tee', stripe_price_id_base: 'price_tee_base' })
  variant = await insert(db, 'product_variants', { product_id: product, size: 'M', sku: 'TEE-M', stock_quantity: 5 })
  addon = await insert(db, 'addons', { name: 'Towel', category: 'Extras', sku: 'TOWEL', base_price: '5.00' })
  serviceType = await fixtures.serviceType(db, { duration: 60, capacity: 10 })
  privateType = await fixtures.serviceType(db, { booking_type: 'private', duration: 120, capacity: 12 })
  core = await fixtures.band(db, { name: 'Core' })
  peak = await fixtures.band(db, { name: 'Peak', price: '25.00' })
  passType = await fixtures.passType(db, { price: '50.00', sessions_included: 5, expiry_months: 12, level: 'all_access' })
  giftType = await insert(db, 'gift_card_types', { name: 'Gift card', expiry_months: 12 })
  preset = await insert(db, 'gift_card_presets', { gift_card_type_id: giftType, amount: '60.00' })
})

const press = <T = unknown>(handler: AdminRouteHandler, params: Record<string, string>, body: unknown = {}, email: string | null = JO, key?: string): Promise<AdminAnswer<T>> =>
  pressRoute<T>(handler, 'POST', { email, params, body, ...(key ? { key } : {}) })
const read = <T = unknown>(handler: AdminRouteHandler, params: Record<string, string> = {}, email: string | null = JO): Promise<AdminAnswer<T>> => pressRoute<T>(handler, 'GET', { email, params })
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> => (await db.query<T>(sql, params as never[]))[0] as T

describe('W53 review L7: a price must be pounds and pence', () => {
  it('isPoundsAndPence: two decimals or fewer, 0 or more as the caller decides, below £100,000,000', () => {
    for (const ok of [0, 1, 9.99, 14, 11.5, 99_999_999.99, 0.1 + 0.2]) expect(isPoundsAndPence(ok), String(ok)).toBe(true)
    for (const no of [39.995, 0.001, 1.234, 100_000_000, Number.NaN, Number.POSITIVE_INFINITY]) expect(isPoundsAndPence(no), String(no)).toBe(false)
    expect(priceText(0.1 + 0.2)).toBe('0.30')
    expect(priceText(9.99)).toBe('9.99')
  })

  it.each([
    ['a product', productPriceRoute, { productId: '' }, { basePrice: 19.995 }, 'basePrice'],
    ['an add-on', addonPriceRoute, { addonId: '' }, { memberPrice: 4.001 }, 'memberPrice'],
    ['a pass type', passPriceRoute, { passTypeId: '' }, { basePrice: 100_000_000 }, 'basePrice'],
    ['a tier', tierPriceRoute, { tierId: '' }, { price: 120.125 }, 'price'],
  ] as const)('%s: a price with three decimals, or too big, is refused in words and nothing is written', async (_label, handler, params, body, field) => {
    const ids: Record<string, string> = { productId: product, addonId: addon, passTypeId: passType }
    const tier = await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: core, min_people: 1, max_people: 4, price: '100.00' })
    const filled = Object.fromEntries(Object.keys(params).map((name) => [name, name === 'tierId' ? tier : (ids[name] ?? '')]))
    const answer = await press(handler, filled, body)
    expect(answer.status).toBe(400)
    expect(answer.reason).toBe('not_pounds_and_pence')
    expect(answer.error?.message).toBe(NEW.notPoundsAndPence(field))
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('a preset amount and custom amounts: three decimals refused; whole pounds and pence saved exactly', async () => {
    expect((await press(presetCreateRoute, { giftCardTypeId: giftType }, { amount: 25.555 })).error?.message).toBe(NEW.notPoundsAndPence('amount'))
    expect((await press(presetPriceRoute, { presetId: preset }, { amount: 60.001 })).error?.message).toBe(NEW.notPoundsAndPence('amount'))
    const stamp = (await read<Array<{ stamp: string }>>(giftTypesRoute)).data?.[0]?.stamp
    const custom = { field: 'custom_amounts', customAmountEnabled: true, customAmountMin: 5.005, customAmountMax: 250, stamp }
    expect((await press(giftTypeDetailsRoute, { giftCardTypeId: giftType }, custom)).error?.message).toBe(NEW.notPoundsAndPence('customAmountMin'))
    const saved = await press<{ preset: { amount: string } }>(presetPriceRoute, { presetId: preset }, { amount: 0.1 + 0.2 })
    expect(saved.data?.preset.amount).toBe('0.30')
  })
})

describe('Manage pricing on each write, and the staff check on every route', () => {
  it.each([
    ['product on/off sale', productActiveRoute, () => ({ productId: product }), { active: false }],
    ['product price', productPriceRoute, () => ({ productId: product }), { basePrice: 21 }],
    ['fulfilment', fulfilmentRoute, () => ({ productId: product }), { fulfillmentMethod: 'pickup' }],
    ['new variant (GB12)', variantCreateRoute, () => ({ productId: product }), { size: 'L', sku: 'TEE-L', stockQuantity: 3 }],
    ['variant details', variantDetailsRoute, () => ({ variantId: variant }), { size: 'S', sku: 'TEE-S', stamp: 'x' }],
    ['add-on on/off sale', addonActiveRoute, () => ({ addonId: addon }), { active: false }],
    ['add-on price', addonPriceRoute, () => ({ addonId: addon }), { basePrice: 6 }],
    ['add-on SKU', addonSkuRoute, () => ({ addonId: addon }), { sku: 'T2' }],
    ['service type on/off sale', serviceTypeActiveRoute, () => ({ serviceTypeId: serviceType }), { active: false }],
    ['service type details', serviceTypeDetailsRoute, () => ({ serviceTypeId: serviceType }), { duration: 60, capacity: 8, bookingType: 'public', stamp: 'x' }],
    ['new size group', tierCreateRoute, () => ({ serviceTypeId: privateType }), { minPeople: 1, maxPeople: 4 }],
    ['pass on/off sale', passActiveRoute, () => ({ passTypeId: passType }), { active: false }],
    ['pass price', passPriceRoute, () => ({ passTypeId: passType }), { basePrice: 55 }],
    ['pass sessions', passDetailsRoute, () => ({ passTypeId: passType }), { field: 'sessions_included', value: 10 }],
    ['pass expiry', passDetailsRoute, () => ({ passTypeId: passType }), { field: 'expiry_months', value: 6 }],
    ['gift card type on/off sale', giftTypeActiveRoute, () => ({ giftCardTypeId: giftType }), { active: false }],
    ['gift card type expiry', giftTypeDetailsRoute, () => ({ giftCardTypeId: giftType }), { field: 'expiry_months', value: 6 }],
    ['new preset', presetCreateRoute, () => ({ giftCardTypeId: giftType }), { amount: 25 }],
    ['preset price', presetPriceRoute, () => ({ presetId: preset }), { amount: 75 }],
    ['preset on/off sale', presetActiveRoute, () => ({ presetId: preset }), { active: false }],
  ] as const)('%s: refused without Manage pricing, and for an inactive account or a sign-in with no staff row; nothing written', async (_label, handler, params, body) => {
    const tia = await press(handler, params(), body, TIA)
    expect(tia.status).toBe(403)
    expect(tia.error?.message).toBe(NO_PRICING)
    expect((await press(handler, params(), body, INA)).error?.message).toBe(INACTIVE)
    expect((await press(handler, params(), body, NOBODY)).error?.message).toBe(NO_STAFF_ROW)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it("the pass level's refusal keeps its old reason and the dialog's words", async () => {
    const answer = await press(passDetailsRoute, { passTypeId: passType }, { field: 'level', value: 'core' }, TIA)
    expect(answer.reason).toBe('no_pricing_permission')
    expect(answer.error?.message).toBe(CATALOG_ADMIN_DIALOG_WORDS.EditSessionPassTypeDialog.no_pricing_permission)
  })

  it('stock adjustments stay open to every active staff member, as before; the inactive and the unknown are refused', async () => {
    const tia = await press<{ stock_quantity: number }>(stockRoute, { variantId: variant }, { changeAmount: 2, reasonCategory: 'delivery' }, TIA)
    expect(tia.data?.stock_quantity).toBe(7)
    expect((await press(stockRoute, { variantId: variant }, { changeAmount: 2, reasonCategory: 'delivery' }, INA)).error?.message).toBe(INACTIVE)
    expect((await press(stockRoute, { variantId: variant }, { changeAmount: 2, reasonCategory: 'delivery' }, NOBODY)).error?.message).toBe(NO_STAFF_ROW)
  })

  it.each([
    ['products', productsRoute, {}],
    ['add-ons', addonsRoute, {}],
    ['service types', serviceTypesRoute, {}],
    ['pass types', passTypesRoute, {}],
    ['gift card types', giftTypesRoute, {}],
    ['stock history', historyRoute, () => ({ variantId: variant })],
    ['level quote', levelQuoteRoute, () => ({ passTypeId: passType })],
  ] as const)('GB14: the %s read refuses an inactive account and a sign-in with no staff row; any active staff member reads it', async (_label, handler, params) => {
    const values = typeof params === 'function' ? params() : params
    expect((await read(handler, values, INA)).error?.message).toBe(INACTIVE)
    expect((await read(handler, values, NOBODY)).error?.message).toBe(NO_STAFF_ROW)
    expect((await read(handler, values, TIA)).ok).toBe(true)
  })

  // W72b (W72a's report, "Noticed" 1): an item new from Sanity arrives off sale with no price (Q57) and has none until
  // staff set it. The two reads' contracts said `base_price` was always text, so under test (and `next dev`, where an
  // answer is held to its contract) the Products and Add-ons pages' reads answered 500 with such a row in the table.
  it('W72b: a product and an add-on with no price yet are read with a null base price, beside the priced ones; the contract still refuses a price that is not text', async () => {
    const bare = await insert(db, 'products', { name: 'New from Sanity', sanity_product_id: 'w72b-product', active: false })
    const bareVariant = await insert(db, 'product_variants', { product_id: bare, size: 'S', sku: 'W72B-S', stock_quantity: 0 })
    const bareAddon = await insert(db, 'addons', { name: 'New add-on from Sanity', sanity_addon_id: 'w72b-addon', active: false })
    type Row = { id: string; base_price: string | null; member_price: string | null; sale_price: string | null; active: boolean | null; variants?: Array<{ id: string }> }

    const products = await read<Row[]>(productsRoute, {}, TIA)
    expect([products.status, products.ok]).toEqual([200, true])
    expect(products.data?.map((row) => [row.id, row.base_price, row.member_price, row.sale_price, row.active, row.variants?.map((one) => one.id)])).toEqual([
      [product, '20.00', null, null, true, [variant]],
      [bare, null, null, null, false, [bareVariant]],
    ])
    expect(catalogProductsRouteOutputSchema.parse(products.data)).toEqual(products.data)

    const addons = await read<Row[]>(addonsRoute, {}, TIA)
    expect([addons.status, addons.ok]).toEqual([200, true])
    expect(addons.data?.map((row) => [row.id, row.base_price, row.member_price, row.sale_price, row.active])).toEqual([
      [addon, '5.00', null, null, true],
      [bareAddon, null, null, null, false],
    ])
    expect(catalogAddonsRouteOutputSchema.parse(addons.data)).toEqual(addons.data)

    // Null and text, nothing else: a number, or the field left out, is still not what the screens are promised.
    const [first] = products.data as Row[]
    const [firstAddon] = addons.data as Row[]
    for (const wrong of [20, undefined, true]) {
      expect(catalogProductsRouteOutputSchema.safeParse([{ ...first, base_price: wrong }]).success, String(wrong)).toBe(false)
      expect(catalogAddonsRouteOutputSchema.safeParse([{ ...firstAddon, base_price: wrong }]).success, String(wrong)).toBe(false)
    }

    // Once staff set its price the product reads as any other does (the price route, Manage pricing).
    expect((await press(productPriceRoute, { productId: bare }, { basePrice: 18 })).ok).toBe(true)
    expect((await read<Row[]>(productsRoute, {}, TIA)).data?.find((row) => row.id === bare)?.base_price).toBe('18.00')
  })

  it("W72b: the staff app's own types say the same: a product's and an add-on's base price is text or null", async () => {
    const { readFileSync } = await import('node:fs')
    const file = (name: string) => readFileSync(path.join(staffAppDir(), name), 'utf8')
    for (const name of ['backend/paddock/getProducts.ts', 'backend/paddock/getAddons.ts']) {
      expect(file(name), name).toContain('  base_price: string | null\n')
      expect(file(name), name).not.toContain('  base_price: string\n')
    }
    const types = file('frontend/types/paddock.ts')
    for (const row of ['ProductRow', 'AddonRow']) {
      const body = new RegExp(`export interface ${row} \\{[^}]+\\}`).exec(types)?.[0] ?? ''
      expect(body, row).toContain('  base_price: string | null\n')
    }
    const generated = file('backend/paddock/shared/workerContracts.ts')
    for (const type of ['CatalogProductsRouteOutput', 'CatalogAddonsRouteOutput']) {
      const line = generated.split('\n').find((one) => one.startsWith(`export type ${type} = `)) ?? ''
      expect(line, type).toContain('base_price: string | null;')
    }
    // The screens that work a price out from it fall back when there is none, as they did for an empty price.
    expect(file('frontend/components/checkout/ProductLineEditor.tsx')).toContain('return price ? Number.parseFloat(price) : 0')
    expect(file('frontend/components/checkout/AddonLineEditor.tsx')).toContain('return price ? Number.parseFloat(price) : 0')
  })

  // W74b (Wayne's WQ47, 24 Nov 2026): the read gave a product's variants by the text of their size (L, M, S, XL), so
  // the staff app listed them so and New Order started a product's line on L.
  it("WQ47: a product's sizes come in shop order (S, M, L, XL; 2XL with XXL; then numbers, then the rest as made), not in text order or the order made, on both channels", async () => {
    // The T-shirt has M already. Made after it, a minute apart, in this order:
    for (const [index, size] of ['XL', 'XXL', 'L', 'S', '2XL', '10', 'Tall', '8', 'Kids'].entries()) {
      await insert(db, 'product_variants', { product_id: product, size, sku: `TEE-${size}`, stock_quantity: 1, created_at: new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString() })
    }
    // A second product, so each product is seen to keep its own sizes: made L then S.
    const hoodie = await insert(db, 'products', { name: 'Hoodie', category: 'Merch', base_price: '40.00', stripe_product_id: 'prod_hoodie', stripe_price_id_base: 'price_hoodie_base' })
    for (const [index, size] of ['L', 'S'].entries()) {
      await insert(db, 'product_variants', { product_id: hoodie, size, sku: `HOOD-${size}`, stock_quantity: 1, created_at: new Date(Date.UTC(2030, 0, 2, 0, index)).toISOString() })
    }
    type Row = { id: string; variants: Array<{ id: string; size: string | null; stamp?: string }> }
    const sizesOf = (rows: Row[] | undefined, id: string) => rows?.find((row) => row.id === id)?.variants.map((one) => one.size)
    // XXL and 2XL share a place, and Tall and Kids have none of ours: each pair in the order made, not the text's
    // (2XL before XXL, Kids before Tall).
    const inShopOrder = ['S', 'M', 'L', 'XL', 'XXL', '2XL', '8', '10', 'Tall', 'Kids']

    const staff = await read<Row[]>(productsRoute, {}, TIA)
    expect(staff.ok).toBe(true)
    expect(sizesOf(staff.data, product)).toEqual(inShopOrder)
    expect(sizesOf(staff.data, hoodie)).toEqual(['S', 'L'])
    // The first is the smallest: it is the one New Order starts a line on.
    expect(staff.data?.find((row) => row.id === product)?.variants[0]?.size).toBe('S')
    // Each row is still the staff read's own (its stamp, its contract).
    expect(staff.data?.flatMap((row) => row.variants).every((one) => typeof one.stamp === 'string')).toBe(true)
    expect(catalogProductsRouteOutputSchema.parse(staff.data)).toEqual(staff.data)

    const shop = (await listProducts(db, { channel: 'customer' })) as unknown as Row[]
    expect(sizesOf(shop, product)).toEqual(inShopOrder)
    expect(sizesOf(shop, hoodie)).toEqual(['S', 'L'])
  })

  it("WQ47: New Order starts a product's line on the read's first variant, and no staff screen puts a product's sizes in an order of its own", async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const file = (name: string) => readFileSync(path.join(staffAppDir(), name), 'utf8')
    const editor = file('frontend/components/checkout/ProductLineEditor.tsx')
    // A new line: the first product that has a variant, and that product's first variant.
    expect(editor).toContain('  const sellableProducts = products.filter((p) => p.variants.length > 0)\n')
    expect(editor).toContain('    const firstProduct = sellableProducts[0]\n')
    expect(editor).toContain('    const firstVariant = firstProduct?.variants[0]\n')
    expect(editor).toContain('        productVariantId: firstVariant.id,\n')
    // The picker lists each product's variants as they were read.
    expect(editor).toContain('                      {p.variants.map((v) => (\n')
    // Catalog → Products: the variants as read, and New Order's catalogue as read.
    expect(file('frontend/components/ProductVariantsManager.tsx')).toContain('          {localVariants.map((v) => (\n')
    expect(file('frontend/components/CheckoutDialog.tsx')).toContain('                          products={productCatalog ?? []}\n')
    // The function hands the Worker's answer on as it came.
    expect(file('backend/paddock/getProducts.ts')).toContain("  return adminRead<CatalogProductsRouteOutput>(req.user, { path: '/api/v1/staff/catalog/products' })\n")
    // No screen sorts or turns round a list of variants, or compares sizes as text.
    const screens = ['frontend/components', 'frontend/components/checkout', 'frontend/pages', 'frontend/utils', 'frontend/hooks'].flatMap((folder) =>
      readdirSync(path.join(staffAppDir(), folder)).filter((name) => /\.tsx?$/.test(name)).map((name) => `${folder}/${name}`)
    )
    expect(screens.length).toBeGreaterThan(100)
    for (const name of screens) {
      const source = file(name)
      expect(source, name).not.toMatch(/[vV]ariants\b[^\n;]*\.(sort|toSorted|reverse|toReversed)\(/)
      expect(source, name).not.toMatch(/size\b[^\n]*localeCompare|localeCompare\([^)\n]*size\b/)
    }
  })
})

describe('GB12: a new variant and its starting stock are one transaction', () => {
  it('a variant with starting stock: the variant, its "Initial stock" ledger row naming the staff member, one audit row; no Stripe price', async () => {
    const answer = await press<{ success: boolean; variant: Record<string, unknown> }>(variantCreateRoute, { productId: product }, { size: ' L ', sku: ' TEE-L ', stockQuantity: 10 })
    expect(answer.data?.success).toBe(true)
    expect(answer.data?.variant).toMatchObject({ product_id: product, size: 'L', sku: 'TEE-L', stock_quantity: 10, stripe_price_id: null })
    expect(answer.data).not.toHaveProperty('stripePriceId')
    const ledger = await db.query<{ change_amount: number; reason: string; staff_id: string }>('SELECT change_amount, reason, staff_id FROM stock_adjustments WHERE variant_id = $1', [answer.data?.variant['id'] as string])
    expect(ledger).toEqual([{ change_amount: 10, reason: 'Initial stock', staff_id: jo }])
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.entity_type, row.details.before, (row.details as { startingStock?: unknown }).startingStock])).toEqual([['catalog.variant_created', 'product_variant', null, 10]])
  })

  it('with no starting stock there is no ledger row', async () => {
    const answer = await press<{ variant: { id: string } }>(variantCreateRoute, { productId: product }, { size: 'L', sku: 'TEE-L' })
    expect((await db.query('SELECT id FROM stock_adjustments WHERE variant_id = $1', [String(answer.data?.variant.id)])).length).toBe(0)
  })

  it('the ledger row failing leaves nothing: no variant, no audit row', async () => {
    await database.pg.exec(`RESET ROLE;
      CREATE FUNCTION w55_ledger_fails() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the ledger failed'; END $$;
      CREATE TRIGGER w55_ledger_fails BEFORE INSERT ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION w55_ledger_fails();
      SET ROLE paddock_worker;`)
    try {
      const answer = await press(variantCreateRoute, { productId: product }, { size: 'L', sku: 'TEE-L', stockQuantity: 10 })
      expect(answer.ok).toBe(false)
      expect(await db.query("SELECT id FROM product_variants WHERE sku = 'TEE-L'")).toEqual([])
      expect(await auditRowsOf(db)).toEqual([])
    } finally {
      await database.pg.exec('RESET ROLE; DROP TRIGGER w55_ledger_fails ON stock_adjustments; DROP FUNCTION w55_ledger_fails(); SET ROLE paddock_worker;')
    }
  })

  it('the old checks in their words; a product that isn\'t there in the legacy route\'s words', async () => {
    expect((await press(variantCreateRoute, { productId: product }, { size: ' ', sku: 'X' })).error?.message).toBe(OLD.createProductVariant.productidSizeAndSkuAreRequired)
    expect((await press(variantCreateRoute, { productId: product }, { size: 'L', sku: 'X', stockQuantity: 1.5 })).error?.message).toBe(OLD.createProductVariant.stockquantityMustNonNegativeWholeNumber)
    expect((await press(variantCreateRoute, { productId: product }, { size: 'L', sku: 'X', stockQuantity: -1 })).error?.message).toBe(OLD.createProductVariant.stockquantityMustNonNegativeWholeNumber)
    expect((await press(variantCreateRoute, { productId: UNKNOWN_ID }, { size: 'L', sku: 'X' })).error?.message).toBe(CATALOG_ADMIN_WORDS.createProductVariant.productNotFound)
  })
})

describe('GB23: an empty size, a duplicate SKU (any case), a duplicate size within a product', () => {
  const stampOf = async (id: string): Promise<string> => {
    const products = (await read<Array<{ variants: Array<{ id: string; stamp: string }> }>>(productsRoute)).data ?? []
    return products.flatMap((one) => one.variants).find((one) => one.id === id)?.stamp ?? ''
  }

  it('a new variant: a SKU another variant has in another case, and a size the product has in another case, refused in words; nothing written', async () => {
    expect((await press(variantCreateRoute, { productId: product }, { size: 'L', sku: 'tee-m' })).error?.message).toBe(NEW.variantSkuTaken('TEE-M'))
    expect((await press(variantCreateRoute, { productId: product }, { size: ' m ', sku: 'TEE-M2' })).error?.message).toBe(NEW.sizeTaken('M'))
    // The same size on ANOTHER product is fine.
    const other = await insert(db, 'products', { name: 'Hoodie', base_price: '40.00' })
    expect((await press(variantCreateRoute, { productId: other }, { size: 'M', sku: 'HOOD-M' })).ok).toBe(true)
    expect((await db.query('SELECT id FROM product_variants WHERE product_id = $1', [product])).length).toBe(1)
  })

  it('a variant edit: an empty size or SKU, a SKU taken in another case, a size taken; the variant keeps its own size and SKU in another case', async () => {
    await insert(db, 'product_variants', { product_id: product, size: 'L', sku: 'TEE-L', stock_quantity: 0 })
    const body = async (fields: Record<string, unknown>) => ({ ...fields, stamp: await stampOf(variant) })
    expect((await press(variantDetailsRoute, { variantId: variant }, await body({ size: ' ', sku: 'TEE-M' }))).error?.message).toBe(NEW.sizeRequired)
    expect((await press(variantDetailsRoute, { variantId: variant }, await body({ size: 'M', sku: '' }))).error?.message).toBe(NEW.skuRequired)
    expect((await press(variantDetailsRoute, { variantId: variant }, await body({ size: 'M', sku: 'tee-l' }))).error?.message).toBe(NEW.variantSkuTaken('TEE-L'))
    expect((await press(variantDetailsRoute, { variantId: variant }, await body({ size: 'l', sku: 'TEE-M' }))).error?.message).toBe(NEW.sizeTaken('L'))
    const own = await press<{ size: string; sku: string }>(variantDetailsRoute, { variantId: variant }, await body({ size: 'm', sku: 'tee-m' }))
    expect(own.data).toMatchObject({ size: 'm', sku: 'tee-m' })
  })

  it("an add-on's SKU: another add-on's in another case refused in words; blank saves none", async () => {
    await insert(db, 'addons', { name: 'Robe', sku: 'ROBE', base_price: '10.00' })
    expect((await press(addonSkuRoute, { addonId: addon }, { sku: 'robe' })).error?.message).toBe(NEW.addonSkuTaken('ROBE'))
    expect((await press<{ sku: string | null }>(addonSkuRoute, { addonId: addon }, { sku: '  ' })).data?.sku).toBeNull()
    expect((await press(addonSkuRoute, { addonId: UNKNOWN_ID }, { sku: 'X' })).reason).toBe('addon_not_found')
  })
})

describe('GB13: a stock adjustment', () => {
  it('stock can\'t go below zero: refused in the old words with the figures; nothing written', async () => {
    const answer = await press(stockRoute, { variantId: variant }, { changeAmount: -6, reasonCategory: 'damage' })
    expect(answer.error?.message).toBe(OLD.adjustVariantStock.adjustmentWouldBringStockBelowZero(5, -6))
    expect(await one('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant])).toEqual({ stock_quantity: 5 })
    expect(await db.query('SELECT id FROM stock_adjustments')).toEqual([])
    // Exactly to zero is fine.
    expect((await press<{ stock_quantity: number }>(stockRoute, { variantId: variant }, { changeAmount: -5, reasonCategory: 'recount' })).data?.stock_quantity).toBe(0)
  })

  it('a repeated press (same key) is answered from the first: the stock moves once, one ledger row, one audit row', async () => {
    const key = crypto.randomUUID()
    const first = await press<{ stock_quantity: number }>(stockRoute, { variantId: variant }, { changeAmount: 10, reasonCategory: 'delivery' }, JO, key)
    const again = await press<{ stock_quantity: number }>(stockRoute, { variantId: variant }, { changeAmount: 10, reasonCategory: 'delivery' }, JO, key)
    expect([first.data?.stock_quantity, again.data?.stock_quantity, again.replayed]).toEqual([15, 15, true])
    expect(await one('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant])).toEqual({ stock_quantity: 15 })
    expect((await db.query('SELECT id FROM stock_adjustments')).length).toBe(1)
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.details.before, row.details.after, row.details['changeAmount'], row.details['reason']])).toEqual([['stock.adjusted', { stock_quantity: 5 }, { stock_quantity: 15 }, 10, 'Delivery']])
  })

  it('each reason in the ledger as before, "Other: <note>"; the old checks in their words', async () => {
    await press(stockRoute, { variantId: variant }, { changeAmount: -1, reasonCategory: 'other', note: '  Raffle  ' })
    expect(await one('SELECT reason, staff_id FROM stock_adjustments')).toEqual({ reason: 'Other: Raffle', staff_id: jo })
    expect((await press(stockRoute, { variantId: variant }, { changeAmount: 0, reasonCategory: 'delivery' })).error?.message).toBe(OLD.adjustVariantStock.changeamountMustNonZeroWholeNumber)
    expect((await press(stockRoute, { variantId: variant }, { changeAmount: 1.5, reasonCategory: 'delivery' })).error?.message).toBe(OLD.adjustVariantStock.changeamountMustNonZeroWholeNumber)
    expect((await press(stockRoute, { variantId: variant }, { changeAmount: 1, reasonCategory: 'theft' })).error?.message).toBe(OLD.adjustVariantStock.invalidReasonCategory('theft'))
    expect((await press(stockRoute, { variantId: variant }, { changeAmount: 1, reasonCategory: 'other', note: ' ' })).error?.message).toBe(OLD.adjustVariantStock.noteRequiredWhenReasonOther)
    expect((await press(stockRoute, { variantId: UNKNOWN_ID }, { changeAmount: 1, reasonCategory: 'delivery' })).error?.message).toBe(OLD.adjustVariantStock.variantNotFound)
  })

  it('the history: newest first, with who; a limit; an unknown variant has none', async () => {
    await press(stockRoute, { variantId: variant }, { changeAmount: 1, reasonCategory: 'delivery' })
    await press(stockRoute, { variantId: variant }, { changeAmount: 2, reasonCategory: 'delivery' })
    const all = await pressRoute<Array<{ change_amount: number; staff_first_name: string }>>(historyRoute, 'GET', { email: JO, params: { variantId: variant } })
    expect(all.data?.map((row) => row.change_amount).sort()).toEqual([1, 2])
    expect(all.data?.every((row) => row.staff_first_name === 'Jo')).toBe(true)
    expect((await read<unknown[]>(historyRoute, { variantId: UNKNOWN_ID })).data).toEqual([])
    expect((await read<unknown[]>(historyRoute, { variantId: 'not-an-id' })).data).toEqual([])
  })
})

describe('Prices, on and off sale (L2: no Stripe)', () => {
  it('a product\'s three prices: written exactly, the old Stripe ids untouched, one audit row with the prices before and after', async () => {
    const answer = await press<{ item: Record<string, unknown>; pricesUpdated: Record<string, number> }>(productPriceRoute, { productId: product }, { basePrice: 22, memberPrice: 18.5, salePrice: 15.99 })
    expect(answer.data?.item).toMatchObject({ base_price: '22.00', member_price: '18.50', sale_price: '15.99', stripe_price_id_base: 'price_tee_base', stripe_price_id_member: null })
    expect(answer.data?.pricesUpdated).toEqual({ base_price: 22, member_price: 18.5, sale_price: 15.99 })
    const [row] = await auditRowsOf(db)
    expect([row?.action, row?.details.before, row?.details.after]).toEqual(['catalog.price_set', { base_price: '20.00', member_price: null, sale_price: null }, { base_price: '22.00', member_price: '18.50', sale_price: '15.99' }])
  })

  it('the old checks in their words; a field the kind hasn\'t; an unknown item', async () => {
    expect((await press(productPriceRoute, { productId: product }, {})).error?.message).toBe(OLD.updateCatalogItemPrice.atLeastOnePriceFieldMust)
    expect((await press(productPriceRoute, { productId: product }, { basePrice: -1 })).error?.message).toBe(OLD.updateCatalogItemPrice.mustNonNegativeNumber('basePrice'))
    expect((await press(productPriceRoute, { productId: product }, { salePrice: null })).error?.message).toBe(OLD.updateCatalogItemPrice.mustNonNegativeNumber('salePrice'))
    expect((await press(productPriceRoute, { productId: product }, { monthlyPrice: 30 })).error?.message).toBe(NEW.fieldNotOnThisItem('monthlyPrice', 'a product'))
    // W68a: the service type's own route is gone, so the other kind with one price holds the same three here.
    expect((await press(passPriceRoute, { passTypeId: passType }, { memberPrice: 22 })).error?.message).toBe(NEW.fieldNotOnThisItem('memberPrice', 'a session pass'))
    expect((await press(passPriceRoute, { passTypeId: passType }, { basePrice: 22.005 })).reason).toBe('not_pounds_and_pence')
    expect((await press(passPriceRoute, { passTypeId: UNKNOWN_ID }, { basePrice: 22 })).error?.message).toBe(CATALOG_ADMIN_WORDS.toggleItemActive.itemNotFound)
    expect((await press(productPriceRoute, { productId: UNKNOWN_ID }, { basePrice: 1 })).error?.message).toBe(CATALOG_ADMIN_WORDS.toggleItemActive.itemNotFound)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('on and off sale: the row only, an audit row each way; an unknown item in the legacy words', async () => {
    expect((await press(productActiveRoute, { productId: product }, { active: false })).data).toEqual({ id: product, active: false })
    expect((await press(productActiveRoute, { productId: product }, { active: true })).data).toEqual({ id: product, active: true })
    expect((await auditRowsOf(db)).map((row) => [row.action, row.details.before, row.details.after])).toEqual([
      ['catalog.active_set', { id: product, active: true }, { id: product, active: false }],
      ['catalog.active_set', { id: product, active: false }, { id: product, active: true }],
    ])
    expect((await press(presetActiveRoute, { presetId: UNKNOWN_ID }, { active: true })).error?.message).toBe(CATALOG_ADMIN_WORDS.toggleItemActive.itemNotFound)
  })

  // Wayne's Q61 (23 Nov; W66a): what a price is, per kind, as the checkout charges it (catalog-price.ts, the tiers, the presets).
  /** Everything off sale, as a new item from Sanity arrives, with `sql` run as staff's other pages would leave it. */
  const offSale = async (table: string, id: string, sql = '') => {
    await database.pg.exec(`RESET ROLE; UPDATE ${table} SET active = false WHERE id = '${id}'; ${sql}; SET ROLE paddock_worker;`)
  }
  const turnOn = (handler: AdminRouteHandler, params: Record<string, string>) => press<{ id: string; active: boolean }>(handler, params, { active: true })
  // eslint-disable-next-line no-restricted-syntax -- the table is a literal from KIND below
  const isOn = async (table: string, id: string) => (await database.db.query<{ active: boolean }>(`SELECT active FROM ${table} WHERE id = $1`, [id]))[0]?.active
  const KIND = {
    product: () => ({ handler: productActiveRoute, params: { productId: product }, table: 'products', id: product }),
    addon: () => ({ handler: addonActiveRoute, params: { addonId: addon }, table: 'addons', id: addon }),
    publicType: () => ({ handler: serviceTypeActiveRoute, params: { serviceTypeId: serviceType }, table: 'service_types', id: serviceType }),
    privateType: () => ({ handler: serviceTypeActiveRoute, params: { serviceTypeId: privateType }, table: 'service_types', id: privateType }),
    pass: () => ({ handler: passActiveRoute, params: { passTypeId: passType }, table: 'session_pass_types', id: passType }),
    giftType: () => ({ handler: giftTypeActiveRoute, params: { giftCardTypeId: giftType }, table: 'gift_card_types', id: giftType }),
    preset: () => ({ handler: presetActiveRoute, params: { presetId: preset }, table: 'gift_card_presets', id: preset }),
  } as const
  const tierSql = (price: string) => `INSERT INTO service_type_price_tiers (service_type_id, band_id, min_people, max_people, price) VALUES ('${privateType}', '${core}', 1, 4, ${price})`

  type PriceCase = readonly [label: string, kind: keyof typeof KIND, sql: () => string]
  it.each<PriceCase>([
    ['a product with no price of its own and a variant with none', 'product', () => 'UPDATE products SET base_price = NULL'],
    ['a product with no price and no variants', 'product', () => 'UPDATE products SET base_price = NULL; DELETE FROM product_variants'],
    ['a product with no price, one variant with an override and one without', 'product', () => `UPDATE products SET base_price = NULL; UPDATE product_variants SET price_override = 12; INSERT INTO product_variants (product_id, size, sku) VALUES ('${product}', 'L', 'TEE-L')`],
    ['an add-on with no price', 'addon', () => 'UPDATE addons SET base_price = NULL'],
    ['a private service type with no size group', 'privateType', () => ''],
    ['a private service type whose only size group has its price pending', 'privateType', () => tierSql('NULL')],
    ['a session pass with no price', 'pass', () => 'UPDATE session_pass_types SET price = NULL'],
    ['a gift card type with no preset and no custom amounts', 'giftType', () => 'DELETE FROM gift_card_presets'],
    ['a gift card type whose only preset is off sale', 'giftType', () => 'UPDATE gift_card_presets SET active = false'],
    ["a gift card type with custom amounts on and a limit not set", 'giftType', () => 'DELETE FROM gift_card_presets; UPDATE gift_card_types SET custom_amount_enabled = true, custom_amount_min = 10'],
  ])('Q61: %s is refused on sale, as data, in the lead\'s words; nothing written; off is never refused', async (_label, kind, sql) => {
    const { handler, params, table, id } = KIND[kind]()
    await offSale(table, id, sql())
    const refused = await turnOn(handler, params)
    expect([refused.status, refused.ok, refused.reason, refused.error?.message]).toEqual([409, false, 'price_not_set', 'Set its price first.'])
    expect(NEW.setItsPriceFirst).toBe('Set its price first.')
    expect(await isOn(table, id)).toBe(false)
    expect(await auditRowsOf(db)).toEqual([])
    // Off: for an item already off, and for one left on sale with no price (from before Q61).
    expect((await press(handler, params, { active: false })).data).toEqual({ id, active: false })
    await database.pg.exec(`RESET ROLE; UPDATE ${table} SET active = true WHERE id = '${id}'; SET ROLE paddock_worker;`)
    expect((await press(handler, params, { active: false })).data).toEqual({ id, active: false })
    expect(await isOn(table, id)).toBe(false)
  })

  it.each<PriceCase>([
    ['a product with a base price', 'product', () => ''],
    ['a product with only a sale price', 'product', () => 'UPDATE products SET base_price = NULL, sale_price = 9'],
    ['a product with only a member price (members can buy it)', 'product', () => 'UPDATE products SET base_price = NULL, member_price = 9'],
    ['a product at £0', 'product', () => 'UPDATE products SET base_price = 0'],
    ['a product whose every variant has an override', 'product', () => 'UPDATE products SET base_price = NULL; UPDATE product_variants SET price_override = 12'],
    ['an add-on with a base price', 'addon', () => ''],
    ['an add-on with only a member price', 'addon', () => 'UPDATE addons SET base_price = NULL, member_price = 3'],
    ['a public service type, priced by its bands', 'publicType', () => ''],
    ['a service type with no booking type yet', 'publicType', () => 'UPDATE service_types SET booking_type = NULL'],
    ['a private service type with one size group priced and one pending', 'privateType', () => `${tierSql('120')}; ${tierSql('NULL').replace(core, peak)}`],
    ['a session pass with a price', 'pass', () => ''],
    ['a gift card type with a preset on sale', 'giftType', () => ''],
    ['a gift card type with custom amounts and no preset', 'giftType', () => 'DELETE FROM gift_card_presets; UPDATE gift_card_types SET custom_amount_enabled = true, custom_amount_min = 10, custom_amount_max = 100'],
    ['a gift card preset (its amount is always set)', 'preset', () => ''],
  ])('Q61: %s goes on sale as before', async (_label, kind, sql) => {
    const { handler, params, table, id } = KIND[kind]()
    await offSale(table, id, sql())
    expect((await turnOn(handler, params)).data).toEqual({ id, active: true })
    expect(await isOn(table, id)).toBe(true)
    expect((await auditRowsOf(db)).map((row) => [row.action, row.details.before, row.details.after])).toEqual([['catalog.active_set', { id, active: false }, { id, active: true }]])
  })

  it('Q61: refused, then its price set, then on; and an unknown item and no permission are still refused as before', async () => {
    await offSale('addons', addon, 'UPDATE addons SET base_price = NULL')
    expect((await turnOn(addonActiveRoute, { addonId: addon })).error?.message).toBe('Set its price first.')
    expect((await press(addonPriceRoute, { addonId: addon }, { basePrice: 5 })).ok).toBe(true)
    expect((await turnOn(addonActiveRoute, { addonId: addon })).data).toEqual({ id: addon, active: true })
    expect((await turnOn(addonActiveRoute, { addonId: UNKNOWN_ID })).error?.message).toBe(CATALOG_ADMIN_WORDS.toggleItemActive.itemNotFound)
    await offSale('addons', addon, 'UPDATE addons SET base_price = NULL')
    expect((await press(addonActiveRoute, { addonId: addon }, { active: true }, TIA)).error?.message).toBe(NO_PRICING)
  })

  it('brief item 11: a preset\'s price change leaves a gift card already sold at its old amount', async () => {
    const customer = await fixtures.customer(db)
    const card = await insert(db, 'gift_cards', { code: 'GIFT-OLD-60', type: 'monetary', original_value: '60.00', remaining_balance: '60.00', purchaser_id: customer, origin: 'customer_purchase', expiry_date: '2099-01-01' })
    const answer = await press<{ preset: { amount: string } }>(presetPriceRoute, { presetId: preset }, { amount: 75 })
    expect(answer.data?.preset.amount).toBe('75.00')
    expect(await one('SELECT original_value::text AS original_value, remaining_balance::text AS remaining_balance FROM gift_cards WHERE id = $1', [card])).toEqual({ original_value: '60.00', remaining_balance: '60.00' })
  })
})

describe('GB21: a size group\'s range in every band at once', () => {
  let coreTier = ''
  let peakTier = ''
  const rangeStamp = async (tierId: string): Promise<string> => {
    const types = (await read<Array<{ price_tiers: Array<{ id: string; range_stamp: string }> }>>(serviceTypesRoute)).data ?? []
    return types.flatMap((type) => type.price_tiers).find((tier) => tier.id === tierId)?.range_stamp ?? ''
  }
  beforeEach(async () => {
    coreTier = await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: core, min_people: 1, max_people: 4, price: '100.00' })
    peakTier = await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: peak, min_people: 1, max_people: 4, price: '140.00' })
    await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: core, min_people: 5, max_people: 8, price: '150.00' })
    await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: peak, min_people: 5, max_people: 8, price: '190.00' })
  })

  it('one press moves the group in both bands, in one transaction; every tier of the group shares one stamp; one audit row', async () => {
    const stamp = await rangeStamp(coreTier)
    expect(stamp).toBe(await rangeStamp(peakTier))
    const answer = await press<{ min_people: number; max_people: number; range_stamp: string }>(tierRangeRoute, {}, { tierId: coreTier, minPeople: 1, maxPeople: 3, stamp })
    expect(answer.data).toMatchObject({ id: coreTier, min_people: 1, max_people: 3 })
    expect(answer.data?.range_stamp).toBe(await rangeStamp(peakTier))
    expect(await db.query('SELECT band_id, max_people FROM service_type_price_tiers WHERE min_people = 1 ORDER BY max_people, band_id')).toHaveLength(2)
    expect(await db.query('SELECT id FROM service_type_price_tiers WHERE min_people = 1 AND max_people = 3')).toHaveLength(2)
    const [row] = await auditRowsOf(db)
    expect([row?.action, (row?.details.before as unknown[]).length, (row?.details.after as unknown[]).length]).toEqual(['catalog.tier_range_set', 2, 2])
  })

  it('a range overlapping the next group is refused in words, naming it; nothing moves', async () => {
    const answer = await press(tierRangeRoute, {}, { tierId: coreTier, minPeople: 1, maxPeople: 5, stamp: await rangeStamp(coreTier) })
    expect(answer.reason).toBe('range_overlaps')
    expect(answer.error?.message).toBe(NEW.rangeOverlaps(5, 8))
    expect(await db.query('SELECT id FROM service_type_price_tiers WHERE max_people = 4')).toHaveLength(2)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('W54a: a stale range (a tier of the group changed since, or no stamp) is refused changed_since; a price change since is not', async () => {
    const stamp = await rangeStamp(coreTier)
    await press(tierPriceRoute, { tierId: peakTier }, { price: 145 })
    expect((await press(tierRangeRoute, {}, { tierId: coreTier, minPeople: 1, maxPeople: 3, stamp })).ok).toBe(true)
    const old = await rangeStamp(coreTier)
    await press(tierRangeRoute, {}, { tierId: peakTier, minPeople: 1, maxPeople: 2, stamp: old })
    const stale = await press(tierRangeRoute, {}, { tierId: coreTier, minPeople: 1, maxPeople: 4, stamp: old })
    expect([stale.reason, stale.error?.message]).toEqual(['changed_since', CHANGED_SINCE_WORDS])
    expect((await press(tierRangeRoute, {}, { tierId: coreTier, minPeople: 1, maxPeople: 4 })).reason).toBe('changed_since')
  })

  it('the old checks in their words; an unknown tier', async () => {
    const stamp = await rangeStamp(coreTier)
    expect((await press(tierRangeRoute, {}, { tierId: coreTier, minPeople: 0, maxPeople: 3, stamp })).error?.message).toBe(OLD.setServiceTypePriceTierRange.minPeopleMustPositiveWholeNumber)
    expect((await press(tierRangeRoute, {}, { tierId: coreTier, minPeople: 4, maxPeople: 3, stamp })).error?.message).toBe(OLD.setServiceTypePriceTierRange.minPeopleCannotGreaterThanMax)
    expect((await press(tierRangeRoute, {}, { tierId: UNKNOWN_ID, minPeople: 1, maxPeople: 3, stamp })).reason).toBe('tier_not_found')
  })

  it('a new size group: one tier per active band, no price; a service type that isn\'t there in words', async () => {
    const made = await press<Array<{ band_id: string; price: unknown }>>(tierCreateRoute, { serviceTypeId: privateType }, { minPeople: 9, maxPeople: 12 })
    expect(made.data?.map((tier) => tier.band_id).sort()).toEqual([core, peak].sort())
    expect(made.data?.every((tier) => tier.price === null)).toBe(true)
    expect((await press(tierCreateRoute, { serviceTypeId: UNKNOWN_ID }, { minPeople: 9, maxPeople: 12 })).error?.message).toBe(NEW.serviceTypeNotFound)
  })
})

describe('GB10: a pass type\'s and a gift card type\'s numbers', () => {
  it.each([0, -1, 1.5, '3', null])('sessions %s refused in words; nothing written', async (value) => {
    expect((await press(passDetailsRoute, { passTypeId: passType }, { field: 'sessions_included', value })).error?.message).toBe(NEW.sessionsWholeNumber)
    expect(await one('SELECT sessions_included FROM session_pass_types WHERE id = $1', [passType])).toEqual({ sessions_included: 5 })
  })
  it.each([0, -1, 1.5, 121])('expiry %s months refused in words, for a pass type and a gift card type', async (value) => {
    expect((await press(passDetailsRoute, { passTypeId: passType }, { field: 'expiry_months', value })).error?.message).toBe(NEW.expiryWholeMonths)
    expect((await press(giftTypeDetailsRoute, { giftCardTypeId: giftType }, { field: 'expiry_months', value })).error?.message).toBe(NEW.expiryWholeMonths)
  })
  it('1 session, and 1 and 120 months, are saved', async () => {
    expect((await press<{ sessions_included: number }>(passDetailsRoute, { passTypeId: passType }, { field: 'sessions_included', value: 1 })).data?.sessions_included).toBe(1)
    expect((await press<{ expiry_months: number }>(passDetailsRoute, { passTypeId: passType }, { field: 'expiry_months', value: 120 })).data?.expiry_months).toBe(120)
    expect((await press<{ expiry_months: number }>(giftTypeDetailsRoute, { giftCardTypeId: giftType }, { field: 'expiry_months', value: 1 })).data?.expiry_months).toBe(1)
  })
})

describe('GB9 kept (Q52) and the holder count words', () => {
  it('the words for 0, 1 and 3 holders', () => {
    expect(passLevelHolderWords(3)).toBe('3 customers have unused sessions on this pass. Changing the level changes what their remaining sessions cover.')
    expect(passLevelHolderWords(1)).toBe('1 customer has unused sessions on this pass. Changing the level changes what their remaining sessions cover.')
    expect(passLevelHolderWords(0)).toBe('No customer has unused sessions on this pass, so changing the level only changes what new sales cover.')
  })

  it('the quote counts customers with sessions left on an unexpired pass, once each; the press records the count and the change reaches passes already sold', async () => {
    const [a, b, c, d] = [await fixtures.customer(db), await fixtures.customer(db), await fixtures.customer(db), await fixtures.customer(db)]
    await fixtures.pass(db, { customer_id: a, pass_type_id: passType })
    await fixtures.pass(db, { customer_id: a, pass_type_id: passType })
    await fixtures.pass(db, { customer_id: b, pass_type_id: passType })
    await fixtures.pass(db, { customer_id: c, pass_type_id: passType, sessions_remaining: 0 })
    await fixtures.pass(db, { customer_id: d, pass_type_id: passType, expiry_date: '2001-01-01' })
    const quote = await read<{ holders: number; message: string }>(levelQuoteRoute, { passTypeId: passType }, TIA)
    expect(quote.data).toMatchObject({ holders: 2, message: passLevelHolderWords(2) })
    const answer = await press<{ level: string; holders: number }>(passDetailsRoute, { passTypeId: passType }, { field: 'level', value: 'core' })
    expect(answer.data).toMatchObject({ level: 'core', holders: 2 })
    const [row] = await auditRowsOf(db)
    expect([row?.action, row?.details.before, row?.details.after, row?.details['holders']]).toEqual(['catalog.details_set', { level: 'all_access' }, { level: 'core' }, 2])
    // GB9 kept by decision: the type's level is what every pass of it covers, sold or not.
    expect(await one('SELECT level FROM session_pass_types WHERE id = $1', [passType])).toEqual({ level: 'core' })
  })

  it('a level that isn\'t one, and a pass type that isn\'t there, keep their old reasons', async () => {
    expect((await press(passDetailsRoute, { passTypeId: passType }, { field: 'level', value: 'gold' })).reason).toBe('invalid_level')
    expect((await press(passDetailsRoute, { passTypeId: UNKNOWN_ID }, { field: 'level', value: 'core' })).reason).toBe('pass_type_not_found')
    expect((await read(levelQuoteRoute, { passTypeId: UNKNOWN_ID })).reason).toBe('pass_type_not_found')
  })
})

describe("W54a's stale-page rule on the edits that send a whole row back", () => {
  it('variant details: a page loaded before someone else changed the SKU is refused, nothing written', async () => {
    const products = (await read<Array<{ variants: Array<{ id: string; stamp: string }> }>>(productsRoute)).data ?? []
    const stamp = products[0]?.variants[0]?.stamp
    expect((await press(variantDetailsRoute, { variantId: variant }, { size: 'M', sku: 'TEE-MED', stamp })).ok).toBe(true)
    const stale = await press(variantDetailsRoute, { variantId: variant }, { size: 'Medium', sku: 'TEE-M', stamp })
    expect([stale.reason, stale.error?.message]).toEqual(['changed_since', CHANGED_SINCE_WORDS])
    expect(await one('SELECT size, sku FROM product_variants WHERE id = $1', [variant])).toEqual({ size: 'M', sku: 'TEE-MED' })
    // A stock change since doesn't touch the stamp: stock isn't sent back.
    const fresh = ((await read<Array<{ variants: Array<{ stamp: string }> }>>(productsRoute)).data ?? [])[0]?.variants[0]?.stamp
    await press(stockRoute, { variantId: variant }, { changeAmount: 1, reasonCategory: 'delivery' })
    expect((await press(variantDetailsRoute, { variantId: variant }, { size: 'Medium', sku: 'TEE-MED', stamp: fresh })).ok).toBe(true)
  })

  it('service type details and gift card custom amounts: a stale page refused; no stamp refused', async () => {
    const typeStamp = ((await read<Array<{ id: string; stamp: string }>>(serviceTypesRoute)).data ?? []).find((type) => type.id === serviceType)?.stamp
    expect((await press(serviceTypeDetailsRoute, { serviceTypeId: serviceType }, { duration: 60, capacity: 8, bookingType: 'public', stamp: typeStamp })).ok).toBe(true)
    expect((await press(serviceTypeDetailsRoute, { serviceTypeId: serviceType }, { duration: 90, capacity: 10, bookingType: 'public', stamp: typeStamp })).reason).toBe('changed_since')
    expect(await one('SELECT duration, capacity FROM service_types WHERE id = $1', [serviceType])).toEqual({ duration: 60, capacity: 8 })
    const giftStamp = ((await read<Array<{ stamp: string }>>(giftTypesRoute)).data ?? [])[0]?.stamp
    const custom = { field: 'custom_amounts', customAmountEnabled: true, customAmountMin: 5, customAmountMax: 250 }
    expect((await press(giftTypeDetailsRoute, { giftCardTypeId: giftType }, { ...custom, stamp: giftStamp })).ok).toBe(true)
    expect((await press(giftTypeDetailsRoute, { giftCardTypeId: giftType }, { ...custom, customAmountEnabled: false, stamp: giftStamp })).reason).toBe('changed_since')
    expect((await press(giftTypeDetailsRoute, { giftCardTypeId: giftType }, custom)).reason).toBe('changed_since')
  })
})

// Brief W64a item 2 (W64 review S2): GB4, held before W65 deletes the step G replay that recorded it
// (`w48-gb4-a-capacity-or-length-change-reaches-no-session-already-made`).
describe("GB4: a service type's length or capacity change reaches no session already made", () => {
  it('the type changes to 90 minutes and 8 places; its sessions already made keep their times and capacity', async () => {
    const made = await fixtures.session(db, { service_type_id: serviceType, band_id: core })
    const booked = await fixtures.session(db, { service_type_id: serviceType, band_id: peak, start_time: '2030-06-16 18:00:00+00', end_time: '2030-06-16 19:00:00+00', total_booked: 9 })
    const sessions = () => db.query<{ id: string }>('SELECT id, start_time::text AS start_time, end_time::text AS end_time, capacity, total_booked FROM sessions WHERE service_type_id = $1 ORDER BY start_time', [serviceType])
    const before = await sessions()
    expect(before.map((row) => row.id)).toEqual([made, booked])
    const stamp = ((await read<Array<{ id: string; stamp: string }>>(serviceTypesRoute)).data ?? []).find((type) => type.id === serviceType)?.stamp
    expect((await press(serviceTypeDetailsRoute, { serviceTypeId: serviceType }, { duration: 90, capacity: 8, bookingType: 'public', stamp })).ok).toBe(true)
    expect(await one('SELECT duration, capacity FROM service_types WHERE id = $1', [serviceType])).toEqual({ duration: 90, capacity: 8 })
    // The 9 booked of 10 stay 9 of 10 (never 9 of 8), and the hour stays an hour.
    expect(await sessions()).toEqual(before)
  })
})

describe("W55a: the W55 + W56 review's fixes", () => {
  it('B1: a variant for a product with no base price, or a base price of £0, is refused in words; nothing written', async () => {
    const unpriced = await insert(db, 'products', { name: 'Robe', category: 'Merch' })
    const salePriceOnly = await insert(db, 'products', { name: 'Cap', category: 'Merch', sale_price: '9.00' })
    const free = await insert(db, 'products', { name: 'Sticker', category: 'Merch', base_price: '0.00' })
    for (const [productId, sku] of [[unpriced, 'ROBE-M'], [salePriceOnly, 'CAP-M'], [free, 'STICK-M']] as const) {
      const answer = await press(variantCreateRoute, { productId }, { size: 'M', sku, stockQuantity: 10 })
      expect([answer.status, answer.reason, answer.error?.message], sku).toEqual([400, 'base_price_not_set', NEW.variantNeedsBasePrice])
    }
    expect(await db.query('SELECT id FROM product_variants WHERE product_id = ANY($1::uuid[])', [[unpriced, salePriceOnly, free]])).toEqual([])
    expect(await db.query('SELECT id FROM stock_adjustments')).toEqual([])
    expect(await auditRowsOf(db)).toEqual([])
    // Priced, the same press is saved.
    await db.query("UPDATE products SET base_price = 30 WHERE id = $1", [unpriced])
    expect((await press(variantCreateRoute, { productId: unpriced }, { size: 'M', sku: 'ROBE-M', stockQuantity: 10 })).ok).toBe(true)
  })

  it('B1: checked after the SKU, as the legacy route did: a taken SKU on an unpriced product is named first', async () => {
    const unpriced = await insert(db, 'products', { name: 'Robe', category: 'Merch' })
    expect((await press(variantCreateRoute, { productId: unpriced }, { size: 'M', sku: 'tee-m' })).error?.message).toBe(NEW.variantSkuTaken('TEE-M'))
  })

  it("S1: Ben's sale price survives Ann's base-only change from a dialog opened before it (the dialogs send only the prices changed, in pence)", async () => {
    const { samePrice } = (await import(/* @vite-ignore */ path.join(staffAppDir(), 'frontend/utils/priceEntry.ts'))) as { samePrice: (parsed: number, current: string | null | undefined) => boolean }
    for (const [typed, loaded] of [[20, '20.00'], [20.5, '20.50'], [0, '0.00'], [0.1 + 0.2, '0.30'], [99_999_999.99, '99999999.99']] as const) expect(samePrice(typed, loaded), `${typed} ${loaded}`).toBe(true)
    for (const [typed, loaded] of [[18, '20.00'], [5, null], [5, undefined], [5, ''], [0, null], [20.01, '20.00']] as const) expect(samePrice(typed, loaded), `${typed} ${String(loaded)}`).toBe(false)
    // What EditProductDialog sends: each price box with a number in it that isn't the price as loaded.
    type Field = 'basePrice' | 'salePrice' | 'memberPrice'
    const dialogSends = (loaded: Record<Field, string | null>, typed: Record<Field, number | null>) =>
      Object.fromEntries((Object.keys(typed) as Field[]).flatMap((field) => {
        const value = typed[field]
        return value !== null && !samePrice(value, loaded[field]) ? [[field, value]] : []
      }))
    await db.query("UPDATE products SET base_price = 25, sale_price = 20 WHERE id = $1", [product])
    const shirt = async () => ((await read<Array<Record<string, string | null>>>(productsRoute)).data ?? []).find((one) => one['id'] === product) ?? {}
    // Ann opens the T-shirt: base £25.00, sale £20.00.
    const ann = await shirt()
    const annLoaded = { basePrice: ann['base_price'] ?? null, salePrice: ann['sale_price'] ?? null, memberPrice: ann['member_price'] ?? null }
    expect(annLoaded).toEqual({ basePrice: '25.00', salePrice: '20.00', memberPrice: null })
    // Ben changes the sale price to £18.00.
    expect((await press(productPriceRoute, { productId: product }, dialogSends({ basePrice: '25.00', salePrice: '20.00', memberPrice: null }, { basePrice: 25, salePrice: 18, memberPrice: null }))).ok).toBe(true)
    // Ann changes only the base price; her sale box still shows 20 as loaded.
    const annSends = dialogSends(annLoaded, { basePrice: 26, salePrice: 20, memberPrice: null })
    expect(annSends).toEqual({ basePrice: 26 })
    expect((await press(productPriceRoute, { productId: product }, annSends)).ok).toBe(true)
    expect(await one('SELECT base_price::text AS base, sale_price::text AS sale FROM products WHERE id = $1', [product])).toEqual({ base: '26.00', sale: '18.00' })
    // Each press wrote one price_set row with only what it set.
    expect((await auditRowsOf(db)).map((row) => [row.action, row.details.before, row.details.after])).toEqual([
      ['catalog.price_set', { base_price: '25.00', member_price: null, sale_price: '20.00' }, { base_price: '25.00', member_price: null, sale_price: '18.00' }],
      ['catalog.price_set', { base_price: '25.00', member_price: null, sale_price: '18.00' }, { base_price: '26.00', member_price: null, sale_price: '18.00' }],
    ])
  })

  it('S1: a range-only tier edit writes no catalog.price_set row (the price as loaded is not sent)', async () => {
    const { samePrice } = (await import(/* @vite-ignore */ path.join(staffAppDir(), 'frontend/utils/priceEntry.ts'))) as { samePrice: (parsed: number, current: string | null | undefined) => boolean }
    const coreTier = await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: core, min_people: 1, max_people: 4, price: '100.00' })
    await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: peak, min_people: 1, max_people: 4, price: '140.00' })
    const tier = ((await read<Array<{ price_tiers: Array<{ id: string; price: string; range_stamp: string }> }>>(serviceTypesRoute)).data ?? []).flatMap((type) => type.price_tiers).find((one) => one.id === coreTier)
    // EditServiceTypeTierDialog: the price box shows the tier's price as loaded; only the range is changed.
    expect(samePrice(Number.parseFloat(tier?.price ?? ''), tier?.price)).toBe(true)
    expect((await press(tierRangeRoute, {}, { tierId: coreTier, minPeople: 1, maxPeople: 3, stamp: tier?.range_stamp })).ok).toBe(true)
    expect((await auditRowsOf(db)).map((row) => row.action)).toEqual(['catalog.tier_range_set'])
  })

  describe('S2: a new size group is checked for an overlap', () => {
    beforeEach(async () => {
      await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: core, min_people: 1, max_people: 4, price: '120.00' })
      await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: peak, min_people: 1, max_people: 4, price: '160.00' })
    })

    it.each([
      ['3 to 6 beside 1 to 4', 3, 6],
      ['4 to 8 touching 1 to 4 at its edge', 4, 8],
      ['1 to 6 swallowing 1 to 4', 1, 6],
      ['2 to 3 inside 1 to 4', 2, 3],
    ])('%s: refused in words, naming the group; nothing written', async (_label, minPeople, maxPeople) => {
      const answer = await press(tierCreateRoute, { serviceTypeId: privateType }, { minPeople, maxPeople })
      expect([answer.status, answer.reason, answer.error?.message]).toEqual([409, 'range_overlaps', NEW.rangeOverlaps(1, 4)])
      expect(await db.query('SELECT id FROM service_type_price_tiers')).toHaveLength(2)
      expect(await auditRowsOf(db)).toEqual([])
    })

    it('5 to 8 beside 1 to 4 is made, one tier per band', async () => {
      const made = await press<Array<{ band_id: string }>>(tierCreateRoute, { serviceTypeId: privateType }, { minPeople: 5, maxPeople: 8 })
      expect(made.data?.map((tier) => tier.band_id).sort()).toEqual([core, peak].sort())
    })

    it('the same range only fills a band that lacks it, as before (allowed)', async () => {
      const offPeak = await fixtures.band(db, { name: 'Off-Peak' })
      const made = await press<Array<{ band_id: string; min_people: number; max_people: number }>>(tierCreateRoute, { serviceTypeId: privateType }, { minPeople: 1, maxPeople: 4 })
      expect(made.data?.map((tier) => [tier.band_id, tier.min_people, tier.max_people])).toEqual([[offPeak, 1, 4]])
      expect(await db.query('SELECT id FROM service_type_price_tiers WHERE min_people = 1 AND max_people = 4')).toHaveLength(3)
    })

    it('a band holding a tier that starts at the new size with another max is refused, naming it (it was skipped without a word)', async () => {
      const offPeak = await fixtures.band(db, { name: 'Off-Peak' })
      await insert(db, 'service_type_price_tiers', { service_type_id: privateType, band_id: offPeak, min_people: 6, max_people: 7, price: '90.00' })
      const answer = await press(tierCreateRoute, { serviceTypeId: privateType }, { minPeople: 6, maxPeople: 10 })
      expect([answer.reason, answer.error?.message]).toEqual(['range_overlaps', NEW.rangeOverlaps(6, 7)])
    })

    it("another service type's groups don't count", async () => {
      const otherPrivate = await fixtures.serviceType(db, { booking_type: 'private', duration: 90, capacity: 12 })
      expect((await press(tierCreateRoute, { serviceTypeId: otherPrivate }, { minPeople: 3, maxPeople: 6 })).ok).toBe(true)
    })
  })

  it('N4: a stock change that would pass 2,147,483,647 is refused in words with the figures; nothing written; exactly to it is saved', async () => {
    const huge = await press(stockRoute, { variantId: variant }, { changeAmount: 3_000_000_000, reasonCategory: 'delivery' })
    expect([huge.status, huge.reason, huge.error?.message]).toEqual([400, 'stock_above_limit', NEW.stockAboveLimit(5, 3_000_000_000)])
    const over = await press(stockRoute, { variantId: variant }, { changeAmount: 2_147_483_643, reasonCategory: 'delivery' })
    expect([over.reason, over.error?.message]).toEqual(['stock_above_limit', NEW.stockAboveLimit(5, 2_147_483_643)])
    expect(await one('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant])).toEqual({ stock_quantity: 5 })
    expect(await db.query('SELECT id FROM stock_adjustments')).toEqual([])
    expect(await auditRowsOf(db)).toEqual([])
    expect((await press<{ stock_quantity: number }>(stockRoute, { variantId: variant }, { changeAmount: 2_147_483_642, reasonCategory: 'delivery' })).data?.stock_quantity).toBe(2_147_483_647)
  })
})

describe('G-plan 4.8: the reads on the customer channel (no route yet, L13)', () => {
  it('on-sale items only, no Stripe ids; a pass type answers its level (and, with a session, whether it covers it)', async () => {
    await insert(db, 'products', { name: 'Off sale', base_price: '1.00', active: false })
    await insert(db, 'session_pass_types', { name: 'Off sale pass', level: 'core', active: false })
    const products = await listProducts(db, { channel: 'customer' })
    expect(products.map((one) => one['name'])).toEqual(['T-shirt'])
    expect(JSON.stringify(products)).not.toMatch(/stripe/)
    expect(products[0]?.variants[0]).toEqual({ id: variant, product_id: product, size: 'M', stock_quantity: 5, price_override: null })
    expect(JSON.stringify(await listAddons(db, { channel: 'customer' }))).not.toMatch(/stripe|sku/)
    const passes = await listPassTypes(db, undefined, { channel: 'customer' })
    expect(passes).toEqual([expect.objectContaining({ id: passType, level: 'all_access', price: '50.00' })])
    expect(JSON.stringify(passes)).not.toMatch(/stripe/)
    const session = await fixtures.session(db, { service_type_id: serviceType, band_id: core })
    expect((await listPassTypes(db, session, { channel: 'customer' }))[0]).toHaveProperty('covers_session', true)
    const gifts = await listGiftCardTypes(db, { channel: 'customer' })
    expect(gifts[0]?.presets).toEqual([{ id: preset, gift_card_type_id: giftType, amount: '60.00' }])
    expect(JSON.stringify(gifts)).not.toMatch(/stripe/)
  })
})
