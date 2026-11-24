import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'

import { ProductPageView } from '@/components/shop/ProductPageView'
import { readSiteSettings } from '@/lib/frame/read'
import { pageMetadata } from '@/lib/seo/metadata'
import { findProductPage } from '@/lib/shop/pages'
import { firstPicture, metaDescription, plainText, productTitle } from '@/lib/shop/product'

// A product at /shop/[slug] (W74; WQ6): one page for each colour. It shows only when it is published in Sanity and on
// sale in the database: anything else is a 404. A slug the product had before answers with a permanent redirect (308)
// to where it is now (W72a). Its title is "{Name} - {Colour} | The Paddock", its description its first words and its
// link preview its first picture, each unless its SEO section says otherwise. Never `dynamicParams = false` here
// (docs/build-standards.md, section 6).

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const [{ page }, settings] = await Promise.all([findProductPage(slug), readSiteSettings()])
  // Nothing here: the page below answers with the redirect or the 404.
  if (!page) return {}
  const { product } = page
  return pageMetadata({
    path: `/shop/${product.slug}`,
    title: productTitle(product),
    seo: product.seo,
    settings,
    description: metaDescription(plainText(product.description)),
    picture: firstPicture(product.gallery),
  })
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params
  const { page, movedTo } = await findProductPage(slug)
  if (movedTo) permanentRedirect(movedTo)
  if (!page) notFound()
  return <ProductPageView view={page.view} similar={page.similar} />
}
