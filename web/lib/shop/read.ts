import 'server-only'

import { unstable_cache } from 'next/cache'
import { connection } from 'next/server'
import { cache } from 'react'

import { readShop, type Shop } from '@/server/rules/shop/reads'

// W74: the one file of the website that reads the shop from the Worker's rules (W74a: `readShop()`, no HTTP). Every
// price, size and "is any left" on the Shop and Product pages comes from here; nothing on the site reads a table or
// works a price out. The pages and components take these types from here, so this is the only import of server code.

export type { Shop, ShopCategory, ShopGiftCard, ShopProduct } from '@/server/rules/shop/reads'

/** How long the shop's read may be kept: a page's prices and sizes are at most this old (the brief's "at most 60 seconds"). */
export const SHOP_KEPT_SECONDS = 60

/**
 * The shop as the Worker last read it, kept for at most a minute between requests (Next's data cache, which is KV on
 * Cloudflare). The Product page asks the availability route for its sizes again once it has loaded, so a size that
 * sold out inside that minute is still shown as gone.
 */
const keptShop = unstable_cache(async (): Promise<Shop> => readShop(), ['shop'], { revalidate: SHOP_KEPT_SECONDS })

/**
 * The shop, once for a request however many parts of the page ask (its title and the page itself). `connection()`
 * makes it a read at request time, as every page's reads are (lib/frame/read.ts): never baked in at build. A read
 * that fails throws: a shop that could not be read is an error, never an empty shop.
 */
export const readShopKept = cache(async (): Promise<Shop> => {
  await connection()
  return keptShop()
})
