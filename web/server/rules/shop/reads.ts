// Brief W74a (Wayne's WQ37, WQ40, WQ41; lead call L13): what the website's shop reads, on the catalogue's customer
// channel (items on sale, no Stripe ids). Reads only. Names, descriptions and pictures are Sanity's: each row here is
// joined to its document by its Sanity id, so a row with none is left out (it has no page).
//
// Stock numbers stop here: a size answers whether any are left and never how many. Every row is built field by field,
// so a column added to the channel doesn't reach the site by itself.
import 'server-only'
import type { ShopAvailabilityRouteOutput, ShopSize } from '@/contracts'
import type { Queryable } from '@/server/db'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { ApiError } from '@/server/http/errors'
import { namedRead } from '@/server/rules/admin/read'
import { listProducts } from '@/server/rules/catalog/items'
import { listGiftCardTypes } from '@/server/rules/catalog/passes-gift-cards'
import type { CatalogPrices, VariantPrices } from '@/server/rules/orders/catalog-price'
import { lowest, productPrices, sizePrices, type ProductPrices } from './display-prices'
import { SHOP_WORDS } from './failure-messages'
import { inShopOrder } from './size-order'

/** The customer channel's columns used here (catalog/items.ts). */
type ProductRow = CatalogPrices & { sanity_product_id: string | null; category: string | null; fulfillment_method: 'shipping' | 'pickup' | 'both' | null; variants: VariantRow[] }
type VariantRow = { size: string | null; stock_quantity: number; price_override: string | null }

export interface ShopProduct extends ProductPrices {
  sanityId: string
  /** Its category document's Sanity id; null when it has none. */
  category: string | null
  fulfilmentMethod: 'shipping' | 'pickup' | 'both' | null
  /** No size is available (WQ40). A product with no sizes has none. */
  soldOut: boolean
  /** In shop order. */
  sizes: ShopSize[]
}

/** Every product on sale, in its category's order (W72a), then by name. */
export async function listShopProducts(db: Queryable): Promise<ShopProduct[]> {
  const rows = (await listProducts(db, { channel: 'customer' })) as unknown as ProductRow[]
  return rows.flatMap((row) => {
    if (row.sanity_product_id === null) return []
    const prices = { base_price: row.base_price, member_price: row.member_price, sale_price: row.sale_price }
    const variants = inShopOrder(row.variants).map((variant) => ({ size: variant.size, available: variant.stock_quantity > 0, prices: { ...prices, price_override: variant.price_override } satisfies VariantPrices }))
    const sizes = variants.map(({ size, available, prices: own }): ShopSize => ({ size, available, ...sizePrices(own) }))
    return [
      {
        sanityId: row.sanity_product_id,
        category: row.category,
        fulfilmentMethod: row.fulfillment_method,
        // With no sizes yet it is sold out, and its price is the product's own: the same rule, with no override.
        ...productPrices(variants.length > 0 ? variants.map((variant) => variant.prices) : [{ ...prices, price_override: null }]),
        soldOut: !sizes.some((size) => size.available),
        sizes,
      },
    ]
  })
}

export interface ShopCategory {
  sanityId: string
  title: string
}

const CATEGORIES_SQL = `SELECT c.sanity_category_id, c.title FROM product_categories c
  WHERE EXISTS (SELECT 1 FROM products p WHERE p.category = c.sanity_category_id AND p.active = true AND p.sanity_product_id IS NOT NULL)
  ORDER BY c.sort_order NULLS LAST, c.title, c.sanity_category_id`

/** The categories with at least one product on sale, in their Order, then by title (WQ7: an empty one is never shown). */
export async function listShopCategories(db: Queryable): Promise<ShopCategory[]> {
  const rows = await namedRead<{ sanity_category_id: string; title: string }>(db, { name: 'shop.categories', sql: CATEGORIES_SQL })
  return rows.map((row) => ({ sanityId: row.sanity_category_id, title: row.title }))
}

export interface ShopGiftCard {
  sanityId: string
  /** The lowest preset on sale, for "From £X" (WQ41); null when none is. Custom amounts don't count. */
  lowestAmount: string | null
}

/** Each gift card type on sale. */
export async function listShopGiftCards(db: Queryable): Promise<ShopGiftCard[]> {
  const rows = (await listGiftCardTypes(db, { channel: 'customer' })) as unknown as Array<{ sanity_gift_card_type_id: string | null; presets: Array<{ amount: string }> }>
  return rows.flatMap((row) => (row.sanity_gift_card_type_id === null ? [] : [{ sanityId: row.sanity_gift_card_type_id, lowestAmount: lowest(row.presets.map((preset) => preset.amount)) }]))
}

/** One product's sizes now (`GET /api/v1/shop/availability`). One that is unknown or off sale is refused, in the same words. */
export async function shopAvailability(db: Queryable, sanityProductId: string): Promise<ShopAvailabilityRouteOutput> {
  const product = (await listShopProducts(db)).find((one) => one.sanityId === sanityProductId)
  if (!product) throw new ApiError('NOT_FOUND', SHOP_WORDS.notOnSale, { field: 'product' })
  return { product: product.sanityId, soldOut: product.soldOut, sizes: product.sizes }
}

export interface Shop {
  products: ShopProduct[]
  categories: ShopCategory[]
  giftCards: ShopGiftCard[]
}

/** The whole shop on a connection of its own, for a page to call (no HTTP). One read after the other, on the one connection. */
export async function readShop(): Promise<Shop> {
  const db = openRequestDb()
  try {
    return { products: await listShopProducts(db), categories: await listShopCategories(db), giftCards: await listShopGiftCards(db) }
  } finally {
    await closeRequestDb(db)
  }
}
