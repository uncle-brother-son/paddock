import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { GiftCardPageView } from '@/components/shop/GiftCardPageView'
import { readSiteSettings } from '@/lib/frame/read'
import { GIFT_CARD_ADDRESS } from '@/lib/sanity/links'
import { pageMetadata } from '@/lib/seo/metadata'
import { giftCardFormat } from '@/lib/shop/gift-card'
import { findGiftCardPage } from '@/lib/shop/pages'
import { firstPicture, metaDescription, plainText } from '@/lib/shop/product'

// The gift card at /shop/gift-card (W76; WQ19: one gift card type, with a page of its own). It shows when the type is
// published in Sanity and on sale in the database (W76a): anything else is a 404. How it is sent is in the address
// (?format=physical; anything else is Digital, never an error), so either can be shared; its canonical address is
// /shop/gift-card whichever is shown (docs/build-standards.md, section 2). Its title is "{Name} | The Paddock", its
// description and link preview its own SEO section's, then its first words and first picture, then Shop settings'
// SEO, then Site settings' defaults.

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata(): Promise<Metadata> {
  const [page, settings] = await Promise.all([findGiftCardPage(), readSiteSettings()])
  // Nothing here: the page below answers with the 404.
  if (!page) return {}
  const { giftCard, settings: shop } = page
  // The page opens on the Digital card: its first picture, else the Physical one's.
  const gallery = giftCard.digitalGallery.length > 0 ? giftCard.digitalGallery : giftCard.physicalGallery
  return pageMetadata({
    path: GIFT_CARD_ADDRESS,
    title: giftCard.name,
    seo: giftCard.seo,
    settings,
    description: metaDescription(plainText(giftCard.description)) ?? shop?.seo?.description ?? null,
    picture: firstPicture(gallery) ?? shop?.seo?.shareImage ?? null,
  })
}

export default async function GiftCardPage({ searchParams }: Props) {
  const [params, page] = await Promise.all([searchParams, findGiftCardPage()])
  if (!page) notFound()
  return <GiftCardPageView view={page.view} format={giftCardFormat(params.format)} />
}
