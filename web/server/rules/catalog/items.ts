// Briefs W55 + W56 (G-plan 1.1 to 1.3, 4.1, 4.3, 4.6, 4.8; bugs GB12, GB14, GB15, GB23; lead calls L2, L11, L12;
// W53 review L7; W54a's stale-page rule): the catalogue's items on the Worker: products, their variants and add-ons
// (W55), and what every item kind shares: on and off sale, and its price (W55 for products and add-ons, W56 for
// public service types and session passes). Ported from the staff app's old functions as frozen at W48
// (testing/legacy-admin), with their words (failure-messages.ts) and the legacy routes' own (toggle-active,
// update-price, create-variant).
//
// The reads (GB14): an active staff member, through the admin read helper, with named columns. Each read takes the
// channel (G-plan 4.8): on the customer channel only items on sale, with no Stripe ids, for the website's shop (lead
// call L13: no customer route yet). Each row an edit sends back whole carries its stamp (W54a).
//
// The writes (level B): one transaction under the item's own row lock, holding the change and an audit row with the
// row before and after (GB15: the legacy routes took the shared key and recorded nobody), the permission from the
// signed-in staff member in the old words, and the press's key.
//
// Lead call L2 (21 Nov: checked against the website backend log): nothing reads a Stripe price for anything except
// membership plans; the Worker charges its own quote. So no write here makes, archives or switches a Stripe product
// or price: on and off sale is the row's switch, a price is the row's column, and a new variant has no Stripe price.
// The old Stripe ids stay in their columns, untouched. (The legacy routes refused an item never synced to Stripe:
// "Item has no Stripe product. Sync from Sanity first."; that refusal is gone with them.)
//
// W53 review L7: every price entered here must be pounds and pence (at most two decimals, 0 or more, below the
// column's limit), refused in words before anything is written, so the stored price and anything worked out from
// what was typed can't differ. The amount is written as its pence's text, never a float.
import 'server-only'
import type { AdminAction } from '@/contracts'
import type { Db, Queryable, Tx } from '@/server/db'
import { adminRead, namedColumns, namedRead } from '@/server/rules/admin/read'
import { adminRefusal, requireAdminPermission, type AdminActor } from '@/server/rules/admin/refusal'
import { fieldsStampSql, NO_ROW_STAMP } from '@/server/rules/admin/stamp'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWriteOptions } from '@/server/rules/admin/write'
import type { AdminLockTable } from '@/server/rules/admin/locks'
import { isUuid } from '@/server/rules/admin/locks'
import { CATALOG_ADMIN_WORDS, LEGACY_CATALOG_ROUTE_WORDS } from './failure-messages'
import { CATALOG_ITEM_NEW_WORDS, PRICE_LIMIT_POUNDS } from './item-failure-messages'

const WORDS = CATALOG_ADMIN_WORDS
const NEW_WORDS = CATALOG_ITEM_NEW_WORDS

/** Who is reading a catalogue read (G-plan 4.8): staff, or the website's shop. */
export type CatalogReader = { channel: 'staff'; actor: AdminActor } | { channel: 'customer' }

const iso = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value)
/** A row with its moments as ISO text, as the old functions' answers reached the screens. */
export function withIsoTimes<Row extends Record<string, unknown>>(row: Row, times: readonly string[] = ['created_at', 'updated_at']): Row {
  const out: Record<string, unknown> = { ...row }
  for (const name of times) if (name in out) out[name] = iso(out[name])
  return out as Row
}

// --- Prices (W53 review L7)

/**
 * Whether a price typed is pounds and pence: a finite number, at most two decimal places, below the column's limit.
 * (Whether it may be 0 or must be positive is the old check's, made before this.) 39.995 is refused: the database
 * would round it to 40.00 while anything worked out from what was typed (a Stripe amount, a total) used 39.995.
 */
export function isPoundsAndPence(value: number): boolean {
  if (!Number.isFinite(value) || value >= PRICE_LIMIT_POUNDS || value <= -PRICE_LIMIT_POUNDS) return false
  const pence = Math.round(value * 100)
  return Math.abs(value * 100 - pence) < 1e-6
}

/** A price checked by isPoundsAndPence, as the text the numeric(10,2) column stores: never a float. */
export const priceText = (value: number): string => (Math.round(value * 100) / 100).toFixed(2)

// --- What every item kind shares

/** The item kinds the Worker now writes (membership plans stay on the legacy route until W57). */
export type ItemKind = 'product' | 'addon' | 'service_type' | 'session_pass_type' | 'gift_card_type' | 'gift_card_preset'

interface KindInfo {
  table: AdminLockTable & string
  /** Every column of the item's row, by name, as the old functions' answers (and the legacy routes' `item`) had them. */
  columns: readonly string[]
  /** The money columns, answered as the database's text, as the old reads had them. */
  money: readonly string[]
}

export const PRODUCT_COLUMNS = ['id', 'sanity_product_id', 'name', 'thumbnail_url', 'category', 'base_price', 'member_price', 'sale_price', 'fulfillment_method', 'stripe_product_id', 'stripe_price_id_base', 'stripe_price_id_member', 'stripe_price_id_sale', 'active', 'created_at', 'updated_at'] as const
export const ADDON_COLUMNS = ['id', 'sanity_addon_id', 'name', 'thumbnail_url', 'category', 'sku', 'base_price', 'member_price', 'sale_price', 'stripe_product_id', 'stripe_price_id_base', 'stripe_price_id_member', 'stripe_price_id_sale', 'active', 'created_at', 'updated_at'] as const
export const SERVICE_TYPE_COLUMNS = ['id', 'sanity_service_type_id', 'name', 'thumbnail_url', 'duration', 'capacity', 'booking_type', 'price', 'active', 'stripe_product_id', 'stripe_price_id', 'created_at', 'updated_at'] as const
export const PASS_TYPE_COLUMNS = ['id', 'sanity_pass_type_id', 'name', 'thumbnail_url', 'price', 'sessions_included', 'expiry_months', 'stripe_product_id', 'stripe_price_id', 'active', 'created_at', 'updated_at', 'level'] as const
export const GIFT_CARD_TYPE_COLUMNS = ['id', 'sanity_gift_card_type_id', 'name', 'thumbnail_url', 'active', 'stripe_product_id', 'custom_amount_enabled', 'custom_amount_min', 'custom_amount_max', 'created_at', 'updated_at', 'expiry_months'] as const
export const PRESET_COLUMNS = ['id', 'gift_card_type_id', 'amount', 'active', 'stripe_price_id', 'created_at', 'updated_at'] as const

export const KINDS: Readonly<Record<ItemKind, KindInfo>> = {
  product: { table: 'products', columns: PRODUCT_COLUMNS, money: ['base_price', 'member_price', 'sale_price'] },
  addon: { table: 'addons', columns: ADDON_COLUMNS, money: ['base_price', 'member_price', 'sale_price'] },
  service_type: { table: 'service_types', columns: SERVICE_TYPE_COLUMNS, money: ['price'] },
  session_pass_type: { table: 'session_pass_types', columns: PASS_TYPE_COLUMNS, money: ['price'] },
  gift_card_type: { table: 'gift_card_types', columns: GIFT_CARD_TYPE_COLUMNS, money: ['custom_amount_min', 'custom_amount_max'] },
  gift_card_preset: { table: 'gift_card_presets', columns: PRESET_COLUMNS, money: ['amount'] },
}

/** An item's whole row, every column by name: `alias.col`, money as text. */
export const itemColumnsSql = (kind: ItemKind, alias: string): string => namedColumns(alias, KINDS[kind].columns, KINDS[kind].money)

/** "Item not found", the legacy routes' words for an item that isn't there. */
const itemNotFound = (action: AdminAction) => adminRefusal('NOT_FOUND', action, 'item_not_found', LEGACY_CATALOG_ROUTE_WORDS['toggle-active'].itemNotFound)

/**
 * On and off sale (`POST catalog/<kind>/:id/active`): setProductActive, setAddonActive, setServiceTypeActive,
 * setSessionPassActive, setGiftCardTypeActive and setGiftCardPresetActive (lead call L11: one function each, one rule).
 * Manage pricing. One transaction under the item's lock: the switch, and a `catalog.active_set` audit row with the
 * switch before and after. L2: no Stripe product or price is switched (the legacy route switched Stripe's first, and
 * could be refused there or fail between the two). A switch writes only what was pressed, so it carries no stamp.
 */
export async function setItemActive(db: Db, kind: ItemKind, itemId: string, active: boolean, options: AdminWriteOptions): Promise<{ id: string; active: boolean }> {
  const action: AdminAction = 'catalog.active_set'
  const { table } = KINDS[kind]
  type Switch = { id: string; active: boolean }
  return adminWrite<Switch, Switch, Switch>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: kind, id: itemId },
      locks: [{ table, ids: [itemId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held[table]?.length) throw itemNotFound(action)
        // The table is a literal from KINDS, never a value from a request.
        // eslint-disable-next-line no-restricted-syntax -- the table is a literal from KINDS
        const [row] = await tx.query<Switch>(`SELECT id, active FROM ${table} WHERE id = $1::uuid`, [itemId])
        if (!row) throw itemNotFound(action)
        return { id: row.id, active: row.active === true }
      },
      async change(tx) {
        // eslint-disable-next-line no-restricted-syntax -- the table is a literal from KINDS
        const [row] = await tx.query<Switch>(`UPDATE ${table} SET active = $1::boolean, updated_at = now() WHERE id = $2::uuid RETURNING id, active`, [active, itemId])
        if (!row) throw new Error('The item was held but not updated.')
        const after = { id: row.id, active: row.active === true }
        return { after, answer: after }
      },
    },
    options
  )
}

/** The price fields a press can send (updateCatalogItemPrice's params), in the old check's order. */
export const PRICE_FIELDS = ['basePrice', 'memberPrice', 'salePrice', 'monthlyPrice', 'yearlyPrice'] as const
export type PriceField = (typeof PRICE_FIELDS)[number]
export type PriceInput = Partial<Record<PriceField, unknown>>

/** Which column each price field sets, for each kind the Worker prices (the legacy update-price route's mapping). */
const PRICE_COLUMNS: Readonly<Record<'product' | 'addon' | 'service_type' | 'session_pass_type', Partial<Record<PriceField, string>>>> = {
  product: { basePrice: 'base_price', memberPrice: 'member_price', salePrice: 'sale_price' },
  addon: { basePrice: 'base_price', memberPrice: 'member_price', salePrice: 'sale_price' },
  service_type: { basePrice: 'price' },
  session_pass_type: { basePrice: 'price' },
}
export type PricedKind = keyof typeof PRICE_COLUMNS
/** How a kind is named in the "can't be set on" words. */
const KIND_WORDS: Readonly<Record<PricedKind, string>> = { product: 'a product', addon: 'an add-on', service_type: 'a service type', session_pass_type: 'a session pass' }

/**
 * The old checks of a price press, in their order and words, then L7's: at least one field; each one sent a
 * non-negative number; each pounds and pence; each one the kind has. Answers the columns to set, as text.
 */
function checkedPrices(action: AdminAction, kind: PricedKind, input: PriceInput): Array<{ field: PriceField; column: string; sent: number; text: string }> {
  const invalid = (message: string, field?: string) => adminRefusal('VALIDATION', action, 'invalid_params', message, field ? { field } : {})
  // A field sent as null is a field sent: a number that isn't one (Infinity, NaN) reaches the Worker as JSON null,
  // and is refused in the old words, as the old function refused it before anything was sent.
  const sent = PRICE_FIELDS.filter((field) => input[field] !== undefined)
  if (sent.length === 0) throw invalid(WORDS.updateCatalogItemPrice.atLeastOnePriceFieldMust)
  for (const field of sent) {
    const value = input[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid(WORDS.updateCatalogItemPrice.mustNonNegativeNumber(field), field)
  }
  for (const field of sent) {
    if (!isPoundsAndPence(input[field] as number)) throw adminRefusal('VALIDATION', action, 'not_pounds_and_pence', NEW_WORDS.notPoundsAndPence(field), { field })
  }
  const columns = PRICE_COLUMNS[kind]
  return sent.map((field) => {
    const column = columns[field]
    if (!column) throw adminRefusal('VALIDATION', action, 'field_not_on_item', NEW_WORDS.fieldNotOnThisItem(field, KIND_WORDS[kind]), { field })
    const value = input[field] as number
    return { field, column, sent: value, text: priceText(value) }
  })
}

export interface ItemPriceAnswer {
  success: true
  item: Record<string, unknown>
  /** Each column set, with the number as it was sent (as the legacy route answered). */
  pricesUpdated: Record<string, number>
}

/**
 * A catalogue item's price (`POST catalog/<kind>/:id/price`): updateCatalogItemPrice for a product, an add-on, a
 * public service type or a session pass (a membership plan's stays on the legacy route until W57). Manage pricing;
 * the old checks and L7's, before anything is read; then one transaction under the item's lock: the item must be
 * there ("Item not found"), a service type must be public (its old words: a private one is priced by its tiers), the
 * columns set, and a `catalog.price_set` audit row with the prices before and after. L2: no Stripe price is made or
 * archived, so GB2 (a row left on an archived price, a second price for one press) can't happen. Each press writes
 * only the prices it sends, so it carries no stamp: that is safe only because the dialogs send just the prices staff
 * changed, compared in pence (W55a, review S1: before that "20" ≠ "20.00" re-sent every price, and a stale dialog
 * put back a price someone else had changed). A price both staff changed follows W54a's single-value rule.
 */
export async function setItemPrice(db: Db, kind: PricedKind, itemId: string, input: PriceInput, options: AdminWriteOptions): Promise<ItemPriceAnswer> {
  const action: AdminAction = 'catalog.price_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const prices = checkedPrices(action, kind, input)
  const { table } = KINDS[kind]
  const columns = [...new Set(prices.map((price) => price.column))]
  // The audit row keeps the item's prices before and after (a service type's booking type beside them, read to check it).
  return adminWrite<Record<string, unknown>, Record<string, unknown>, ItemPriceAnswer>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: kind, id: itemId },
      locks: [{ table, ids: [itemId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held[table]?.length) throw itemNotFound(action)
        const extra = kind === 'service_type' ? ', booking_type' : ''
        // eslint-disable-next-line no-restricted-syntax -- the table and columns are literals from KINDS and PRICE_COLUMNS
        const [row] = await tx.query<Record<string, unknown>>(`SELECT ${KINDS[kind].money.map((column) => `${column}::text AS ${column}`).join(', ')}${extra} FROM ${table} WHERE id = $1::uuid`, [itemId])
        if (!row) throw itemNotFound(action)
        return row
      },
      async change(tx, before) {
        if (kind === 'service_type' && before['booking_type'] !== 'public') {
          throw adminRefusal('CONFLICT', action, 'private_service_type', LEGACY_CATALOG_ROUTE_WORDS['update-price'].privateServiceTypesUsePriceTiers)
        }
        const sets = columns.map((column, i) => `${column} = $${i + 1}::numeric`)
        const values = columns.map((column) => prices.filter((price) => price.column === column).at(-1)?.text ?? null)
        // eslint-disable-next-line no-restricted-syntax -- the table and columns are literals from KINDS and PRICE_COLUMNS
        const [updated] = await tx.query<Record<string, unknown>>(`UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${columns.length + 1}::uuid RETURNING ${itemColumnsSql(kind, table)}`, [...values, itemId])
        if (!updated) throw new Error('The item was held but its price not updated.')
        const pricesUpdated: Record<string, number> = {}
        for (const price of prices) pricesUpdated[price.column] = price.sent
        const after = Object.fromEntries(KINDS[kind].money.map((column) => [column, updated[column] ?? null]))
        return { after, answer: { success: true, item: withIsoTimes(updated), pricesUpdated } }
      },
    },
    options
  )
}

// --- Products (W55)

/** A variant's row, every column by name (price_override as text). */
const VARIANT_COLUMNS = ['id', 'product_id', 'sku', 'size', 'stock_quantity', 'price_override', 'stripe_price_id', 'created_at', 'updated_at'] as const
const variantColumnsSql = (alias: string): string => namedColumns(alias, VARIANT_COLUMNS, ['price_override'])
/** W54a: what the variant row's edit writes back (VariantRow sends the size and SKU as the page loaded them). */
export const VARIANT_DETAILS_COLUMNS = ['size', 'sku'] as const
const variantStampSql = (alias: string): string => fieldsStampSql(alias, VARIANT_DETAILS_COLUMNS)

const PRODUCTS_SQL = `SELECT ${itemColumnsSql('product', 'p')} FROM products p ORDER BY p.category, p.name`
const VARIANTS_SQL = `SELECT ${variantColumnsSql('v')}, ${variantStampSql('v')} AS stamp FROM product_variants v ORDER BY v.size`
/** The shop's columns (G-plan 4.8): what a customer may see, on-sale products only, no Stripe ids. */
const CUSTOMER_PRODUCTS_SQL = `SELECT p.id, p.sanity_product_id, p.name, p.thumbnail_url, p.category, p.base_price::text AS base_price, p.member_price::text AS member_price,
       p.sale_price::text AS sale_price, p.fulfillment_method
  FROM products p WHERE p.active = true ORDER BY p.category, p.name`
const CUSTOMER_VARIANTS_SQL = `SELECT v.id, v.product_id, v.size, v.stock_quantity FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active = true ORDER BY v.size`

/**
 * getProducts (`GET catalog/products`): every product with its variants, for Catalog → Products and New Order's
 * product picker: products by category then name, each product's variants by size, as before. Each variant carries
 * its stamp (the variant row's edit sends it back). On the customer channel: products on sale, the shop's columns.
 */
export async function listProducts(db: Queryable, reader: CatalogReader): Promise<Array<Record<string, unknown> & { variants: Array<Record<string, unknown>> }>> {
  const read = reader.channel === 'staff'
  const run = (name: string, sql: string) => (read ? adminRead<Record<string, unknown>>(db, { name, needs: 'staff', sql, times: ['created_at', 'updated_at'] }, { actor: reader.actor }) : namedRead<Record<string, unknown>>(db, { name, sql }))
  // One after the other, on the request's one connection (the old read ran the two at once on two).
  const products = await run('catalog.products', read ? PRODUCTS_SQL : CUSTOMER_PRODUCTS_SQL)
  const variants = await run('catalog.variants', read ? VARIANTS_SQL : CUSTOMER_VARIANTS_SQL)
  return products.map((product) => ({ ...product, variants: variants.filter((variant) => variant['product_id'] === product['id']) }))
}

/** The add-ons' rows; on the customer channel, on sale only with the shop's columns. */
const ADDONS_SQL = `SELECT ${itemColumnsSql('addon', 'a')} FROM addons a ORDER BY a.category, a.name`
const CUSTOMER_ADDONS_SQL = `SELECT a.id, a.sanity_addon_id, a.name, a.thumbnail_url, a.category, a.base_price::text AS base_price, a.member_price::text AS member_price, a.sale_price::text AS sale_price
  FROM addons a WHERE a.active = true ORDER BY a.category, a.name`

/** getAddons (`GET catalog/addons`): every add-on by category then name, as before. Any active staff member. */
export function listAddons(db: Queryable, reader: CatalogReader): Promise<Array<Record<string, unknown>>> {
  if (reader.channel === 'customer') return namedRead(db, { name: 'catalog.addons', sql: CUSTOMER_ADDONS_SQL })
  return adminRead(db, { name: 'catalog.addons', needs: 'staff', sql: ADDONS_SQL, times: ['created_at', 'updated_at'] }, { actor: reader.actor })
}

const FULFILMENT_METHODS: readonly string[] = ['shipping', 'pickup', 'both']

/**
 * setProductFulfillmentMethod (`POST catalog/products/:productId/fulfilment`). Manage pricing; a method that isn't
 * one of the three in the old words; then the row under its lock, and a `catalog.details_set` row. A product that
 * isn't there is refused `product_not_found` (the old function answered null, and its wrapper still does). One value,
 * so no stamp.
 */
export async function setProductFulfilment(db: Db, productId: string, method: unknown, options: AdminWriteOptions): Promise<{ id: string; fulfillment_method: string }> {
  const action: AdminAction = 'catalog.details_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  if (typeof method !== 'string' || !FULFILMENT_METHODS.includes(method)) throw adminRefusal('VALIDATION', action, 'invalid_params', WORDS.setProductFulfillmentMethod.invalidFulfillmentMethod(method), { field: 'fulfillmentMethod' })
  const gone = () => adminRefusal('NOT_FOUND', action, 'product_not_found', LEGACY_CATALOG_ROUTE_WORDS['create-variant'].productNotFound)
  type Row = { id: string; fulfillment_method: string }
  return adminWrite<Row, Row, Row>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'product', id: productId },
      locks: [{ table: 'products', ids: [productId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held.products?.length) throw gone()
        const [row] = await tx.query<Row>('SELECT id, fulfillment_method FROM products WHERE id = $1::uuid', [productId])
        if (!row) throw gone()
        return row
      },
      async change(tx) {
        const [row] = await tx.query<Row>('UPDATE products SET fulfillment_method = $1::text, updated_at = now() WHERE id = $2::uuid RETURNING id, fulfillment_method', [method, productId])
        if (!row) throw new Error('The product was held but not updated.')
        return { after: row, answer: row }
      },
    },
    options
  )
}

/**
 * GB23: a SKU or size is looked for in any letter case, and two presses that could clash (two variants given "abc"
 * and "ABC" at once, on two products) must take turns. Each takes a transaction lock on the SKU's lower-case text
 * before it looks; nothing else takes these locks, and they come after the press's row locks, so they add no cycle.
 */
const SKU_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || lower($2::text), 0))"
export async function holdSkuText(tx: Tx, table: 'product_variants' | 'addons', sku: string): Promise<void> {
  await tx.query(SKU_LOCK_SQL, [table, sku])
}

/** Another variant with this SKU, in any letter case: its SKU, or null. */
async function variantSkuTaken(tx: Tx, sku: string, notId: string | null): Promise<string | null> {
  const [row] = await tx.query<{ sku: string }>('SELECT sku FROM product_variants WHERE lower(sku) = lower($1::text) AND ($2::uuid IS NULL OR id <> $2::uuid) ORDER BY id LIMIT 1', [sku, notId])
  return row?.sku ?? null
}

/** Another variant of the product with this size, in any letter case (spaces at either end ignored): its size, or null. */
async function sizeTaken(tx: Tx, productId: string, size: string, notId: string | null): Promise<string | null> {
  const [row] = await tx.query<{ size: string }>(
    'SELECT size FROM product_variants WHERE product_id = $1::uuid AND lower(btrim(size)) = lower($2::text) AND ($3::uuid IS NULL OR id <> $3::uuid) ORDER BY id LIMIT 1',
    [productId, size, notId]
  )
  return row?.size ?? null
}

const VARIANT_STAMP_SQL = `SELECT ${variantStampSql('v')} AS stamp FROM product_variants v WHERE v.id = $1::uuid`
const VARIANT_DETAILS_UPDATE_SQL = `UPDATE product_variants SET size = $1::text, sku = $2::text, updated_at = now() WHERE id = $3::uuid RETURNING id, size, sku, ${variantStampSql('product_variants')} AS stamp`
const PRODUCT_BASE_PRICE_SQL = 'SELECT base_price::text AS base_price FROM products WHERE id = $1::uuid'
const VARIANT_INSERT_SQL = `INSERT INTO product_variants (product_id, size, sku, stock_quantity) VALUES ($1::uuid, $2::text, $3::text, $4::int) RETURNING ${variantColumnsSql('product_variants')}`

export interface VariantDetailsInput {
  variantId: string
  size?: unknown
  sku?: unknown
  stamp?: unknown
}

/**
 * setProductVariantDetails (`POST catalog/variants/:variantId/details`): a variant's size and SKU. Manage pricing;
 * GB23's checks in words (an empty size or SKU; a SKU another variant has, or a size the product already has, in any
 * letter case; never the database's error); then one transaction under the product's and the variant's locks, and a
 * `catalog.details_set` row. W54a: the row sends both fields back as the page loaded them, so it carries their stamp
 * and is refused `changed_since` when either has changed since. A variant that isn't there is refused
 * `variant_not_found` (the old function answered null, and its wrapper still does). Answers the row's id, size and
 * SKU, and its new stamp.
 */
export async function setVariantDetails(db: Db, input: VariantDetailsInput, options: AdminWriteOptions): Promise<{ id: string; size: string | null; sku: string; stamp: string }> {
  const action: AdminAction = 'catalog.details_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const size = typeof input.size === 'string' ? input.size.trim() : ''
  const sku = typeof input.sku === 'string' ? input.sku.trim() : ''
  if (!size) throw adminRefusal('VALIDATION', action, 'size_required', NEW_WORDS.sizeRequired, { field: 'size' })
  if (!sku) throw adminRefusal('VALIDATION', action, 'sku_required', NEW_WORDS.skuRequired, { field: 'sku' })
  const { variantId } = input
  const gone = () => adminRefusal('NOT_FOUND', action, 'variant_not_found', WORDS.adjustVariantStock.variantNotFound)
  // A variant's product never changes, so it can be read before the locks: the product's comes first (LOCK_ORDER).
  const [owner] = isUuid(variantId) ? await db.query<{ product_id: string }>('SELECT product_id FROM product_variants WHERE id = $1::uuid', [variantId]) : []
  if (!owner) throw gone()
  type Row = { id: string; size: string | null; sku: string }
  return adminWrite<Row, Row, Row & { stamp: string }>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'product_variant', id: variantId },
      locks: [
        { table: 'products', ids: [owner.product_id] },
        { table: 'product_variants', ids: [variantId] },
      ],
      unchangedSince: {
        seen: input.stamp,
        now: async (tx) => (await tx.query<{ stamp: string }>(VARIANT_STAMP_SQL, [variantId]))[0]?.stamp ?? NO_ROW_STAMP,
      },
      async before(tx, held) {
        if (!held.product_variants?.length) throw gone()
        const [row] = await tx.query<Row>('SELECT id, size, sku FROM product_variants WHERE id = $1::uuid', [variantId])
        if (!row) throw gone()
        return row
      },
      async change(tx) {
        await holdSkuText(tx, 'product_variants', sku)
        const takenSku = await variantSkuTaken(tx, sku, variantId)
        if (takenSku !== null) throw adminRefusal('CONFLICT', action, 'sku_taken', NEW_WORDS.variantSkuTaken(takenSku), { field: 'sku' })
        const takenSize = await sizeTaken(tx, owner.product_id, size, variantId)
        if (takenSize !== null) throw adminRefusal('CONFLICT', action, 'size_taken', NEW_WORDS.sizeTaken(takenSize), { field: 'size' })
        const [row] = await tx.query<Row & { stamp: string }>(VARIANT_DETAILS_UPDATE_SQL, [size, sku, variantId])
        if (!row) throw new Error('The variant was held but not updated.')
        const { stamp, ...after } = row
        return { after, answer: { ...after, stamp } }
      },
    },
    options
  )
}

export interface CreateVariantInput {
  productId: string
  size?: unknown
  sku?: unknown
  stockQuantity?: unknown
}

/**
 * createProductVariant (`POST catalog/products/:productId/variants`). GB12: Manage pricing (the old function let any
 * staff member make one), and the variant and its "Initial stock" ledger row are one transaction: either both are
 * kept or neither (the old ledger row was a second step that could fail on its own, leaving stock nothing explains).
 * The old checks in their words; GB23's (a SKU another variant has, or a size the product already has, in any letter
 * case); the product under its lock ("Product not found"); W55a (review B1): the product's base price, read under
 * its lock, set and above £0, as the legacy route refused a variant it had no price for (L2 took its Stripe price
 * away, not that check: a variant sells at its product's price, and New Order would sell an unpriced one at £0);
 * the variant, with no Stripe price (L2); the ledger row naming the staff member when there is starting stock; and
 * a `catalog.variant_created` audit row.
 *
 * W48 review L3: a sign-in with no staff row can no longer make a variant (with starting stock and no ledger row):
 * the route's own staff check refuses it before this runs. Answers `{ success: true, variant }`: the legacy route's
 * answer without its `stripePriceId`.
 */
export async function createVariant(db: Db, input: CreateVariantInput, options: AdminWriteOptions): Promise<{ success: true; variant: Record<string, unknown> }> {
  const action: AdminAction = 'catalog.variant_created'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const words = WORDS.createProductVariant
  const size = typeof input.size === 'string' ? input.size.trim() : ''
  const sku = typeof input.sku === 'string' ? input.sku.trim() : ''
  if (!input.productId || !size || !sku) throw adminRefusal('VALIDATION', action, 'invalid_params', words.productidSizeAndSkuAreRequired)
  const stock = input.stockQuantity === undefined || input.stockQuantity === null ? 0 : input.stockQuantity
  if (typeof stock !== 'number' || !Number.isInteger(stock) || stock < 0) throw adminRefusal('VALIDATION', action, 'invalid_params', words.stockquantityMustNonNegativeWholeNumber, { field: 'stockQuantity' })
  const { productId } = input
  const gone = () => adminRefusal('NOT_FOUND', action, 'product_not_found', LEGACY_CATALOG_ROUTE_WORDS['create-variant'].productNotFound)
  const staffId = options.actor.id
  return adminWrite<null, Record<string, unknown>, { success: true; variant: Record<string, unknown> }>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'product_variant', id: productId },
      locks: [{ table: 'products', ids: [productId] }],
      // A new row: nothing the page read is written back.
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(_tx, held) {
        if (!held.products?.length) throw gone()
        return null
      },
      async change(tx) {
        await holdSkuText(tx, 'product_variants', sku)
        const takenSku = await variantSkuTaken(tx, sku, null)
        if (takenSku !== null) throw adminRefusal('CONFLICT', action, 'sku_taken', NEW_WORDS.variantSkuTaken(takenSku), { field: 'sku' })
        const takenSize = await sizeTaken(tx, productId, size, null)
        if (takenSize !== null) throw adminRefusal('CONFLICT', action, 'size_taken', NEW_WORDS.sizeTaken(takenSize), { field: 'size' })
        // W55a (review B1): read under the product's lock, so a price change can't pass between this and the insert.
        // No base price, or £0, is refused, as the legacy route's `!variantPrice` refused both (after its SKU check,
        // as here): a variant sells at its product's price, so without one it would sell at £0.
        const [product] = await tx.query<{ base_price: string | null }>(PRODUCT_BASE_PRICE_SQL, [productId])
        if (!product) throw gone()
        if (product.base_price === null || Number(product.base_price) === 0) {
          throw adminRefusal('VALIDATION', action, 'base_price_not_set', NEW_WORDS.variantNeedsBasePrice, { field: 'basePrice' })
        }
        const [variant] = await tx.query<Record<string, unknown>>(VARIANT_INSERT_SQL, [productId, size, sku, stock])
        if (!variant) throw new Error('The variant was not written.')
        if (stock > 0) {
          await tx.query("INSERT INTO stock_adjustments (variant_id, change_amount, reason, staff_id) VALUES ($1::uuid, $2::int, 'Initial stock', $3::uuid)", [String(variant['id']), stock, staffId])
        }
        const row = withIsoTimes(variant)
        return { after: row, entityId: String(variant['id']), details: { startingStock: stock }, answer: { success: true, variant: row } }
      },
    },
    options
  )
}

/**
 * setAddonSku (`POST catalog/addons/:addonId/sku`). Manage pricing; the SKU trimmed, a blank one saved as none, as
 * before; GB23: a SKU another add-on has, in any letter case, refused in words (the old function showed the
 * database's unique-key error, and let one through in another case); one transaction under the add-on's lock, and a
 * `catalog.details_set` row. An add-on that isn't there is refused `addon_not_found` (the old function answered null,
 * and its wrapper still does). One value, so no stamp.
 */
export async function setAddonSku(db: Db, addonId: string, sku: unknown, options: AdminWriteOptions): Promise<{ id: string; sku: string | null }> {
  const action: AdminAction = 'catalog.details_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const value = typeof sku === 'string' && sku.trim() !== '' ? sku.trim() : null
  const gone = () => adminRefusal('NOT_FOUND', action, 'addon_not_found', LEGACY_CATALOG_ROUTE_WORDS['toggle-active'].itemNotFound)
  type Row = { id: string; sku: string | null }
  return adminWrite<Row, Row, Row>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'addon', id: addonId },
      locks: [{ table: 'addons', ids: [addonId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held.addons?.length) throw gone()
        const [row] = await tx.query<Row>('SELECT id, sku FROM addons WHERE id = $1::uuid', [addonId])
        if (!row) throw gone()
        return row
      },
      async change(tx) {
        if (value !== null) {
          await holdSkuText(tx, 'addons', value)
          const [taken] = await tx.query<{ sku: string }>('SELECT sku FROM addons WHERE lower(sku) = lower($1::text) AND id <> $2::uuid ORDER BY id LIMIT 1', [value, addonId])
          if (taken) throw adminRefusal('CONFLICT', action, 'sku_taken', NEW_WORDS.addonSkuTaken(taken.sku), { field: 'sku' })
        }
        const [row] = await tx.query<Row>('UPDATE addons SET sku = $1::text, updated_at = now() WHERE id = $2::uuid RETURNING id, sku', [value, addonId])
        if (!row) throw new Error('The add-on was held but not updated.')
        return { after: row, answer: row }
      },
    },
    options
  )
}
