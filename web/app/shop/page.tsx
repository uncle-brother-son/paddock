import type { Metadata } from 'next'

import { ShopListing } from '@/components/shop/ShopListing'
import { readSiteSettings } from '@/lib/frame/read'
import { pageMetadata } from '@/lib/seo/metadata'
import { SHOP_ADDRESS, shopListing, shopQuery } from '@/lib/shop/listing'
import { readShopCatalogue, readShopSettings } from '@/lib/shop/pages'

// The Shop at /shop (W74; WQ37, WQ38): every product that is published in Sanity and on sale in the database, and the
// gift card, twelve to a page. The category, the sort and the page are in the address (?category=&sort=&page=); a
// value the shop doesn't know is the default, never an error. Its title, description and link preview are Shop
// settings', then Site settings'; its canonical address is /shop whatever the query (docs/build-standards.md, section 2).

/** Shop settings' title, until an editor has published one. */
const SHOP_TITLE = 'Shop'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata(): Promise<Metadata> {
  const [shop, settings] = await Promise.all([readShopSettings(), readSiteSettings()])
  return pageMetadata({ path: SHOP_ADDRESS, title: shop?.title ?? SHOP_TITLE, seo: shop?.seo ?? null, settings, description: shop?.intro ?? null })
}

export default async function ShopPage({ searchParams }: Props) {
  const [params, { settings, items, categories }] = await Promise.all([searchParams, readShopCatalogue()])
  const listing = shopListing({ items, categories, featuredIds: settings?.featuredIds ?? [], query: shopQuery(params, categories) })
  return <ShopListing title={settings?.title ?? SHOP_TITLE} listing={listing} categories={categories} />
}
