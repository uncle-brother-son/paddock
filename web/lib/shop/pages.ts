import { connection } from 'next/server'
import { cache } from 'react'

import type { Found } from '@/lib/pages/read'
import { readSanity } from '@/lib/sanity/read'
import { movedAddress } from '@/lib/sanity/redirects'
import type { Product, ShopSettings } from '@/lib/sanity/schemas'

import { londonToday, shopCategories, shopItems, type ShopCard, type ShopCategoryOption, type ShopItem } from './cards'
import { productView, similarCards, type ProductView } from './product'
import { readShopKept } from './read'

// W74: what the Shop at /shop and a product at /shop/[slug] are made of. Names, words and pictures are Sanity's;
// prices, sizes and whether any is left are the Worker's (lib/shop/read.ts, at most a minute old). A product shows
// only when it is published in Sanity and on sale in the database. Each is read once for a request, though a route
// asks twice: for its title and for the page itself.

export type ShopCatalogue = {
  settings: ShopSettings | null
  /** Everything the Shop lists, newest first (lib/shop/cards.ts). */
  items: ShopItem[]
  categories: ShopCategoryOption[]
}

/** Shop settings (its title, intro, Featured order, Shipping & Returns summary and SEO), or null when it isn't published. */
export const readShopSettings = cache(async (): Promise<ShopSettings | null> => {
  await connection()
  return readSanity('shopSettings')
})

/** The whole shop: Shop settings, every item on sale as its card, and the categories that hold one. */
export const readShopCatalogue = cache(async (): Promise<ShopCatalogue> => {
  await connection()
  const [products, giftCard, settings, shop] = await Promise.all([readSanity('productCards'), readSanity('giftCard'), readShopSettings(), readShopKept()])
  const content = { products, giftCard, shop, today: londonToday() }
  return { settings, items: shopItems(content), categories: shopCategories(content) }
})

export type ProductPage = {
  /** Sanity's product: its address, and its SEO section. */
  product: Product
  view: ProductView
  /** The Similar Merch row; empty hides it. */
  similar: ShopCard[]
  settings: ShopSettings | null
}

/**
 * The product at /shop/[slug]: the page, the address it moved to (an old slug, answered with a permanent redirect:
 * W72a), or nothing (a 404). Published in Sanity but off sale in the database is nothing too.
 */
export const findProductPage = cache(async (slug: string): Promise<Found<ProductPage>> => {
  await connection()
  const product = await readSanity('product', slug)
  if (!product) {
    const movedTo = await movedAddress('product', slug)
    return movedTo ? { page: null, movedTo } : { page: null, movedTo: null }
  }
  const [products, giftCard, settings, shop] = await Promise.all([readSanity('productCards'), readSanity('giftCard'), readShopSettings(), readShopKept()])
  const onSale =shop.products.find((one) => one.sanityId === product.id)
  if (!onSale) return { page: null, movedTo: null }
  const items = shopItems({ products, giftCard, shop, today: londonToday() })
  const view = productView({ product, onSale, settings, onSaleIds: new Set(shop.products.map((one) => one.sanityId)) })
  return { page: { product, view, similar: similarCards({ product, products, items }), settings }, movedTo: null }
})
