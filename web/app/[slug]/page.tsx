import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'

import { PageModules } from '@/components/modules/PageModules'
import { readSiteSettings } from '@/lib/frame/read'
import { findContentPage } from '@/lib/pages/read'
import { pageMetadata } from '@/lib/seo/metadata'

// A content page at /[slug] (W73b; WQ26): a Sanity page with its modules. A slug no published page has is a 404; one a
// page had before answers with a permanent redirect (308) to where the page is now (W72a), and the home page's own
// slug to /. Never `dynamicParams = false` here (docs/build-standards.md, section 6).

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const [{ page }, settings] = await Promise.all([findContentPage(slug), readSiteSettings()])
  // Nothing here: the page below answers with the redirect or the 404.
  return page ? pageMetadata({ path: `/${page.slug}`, title: page.title, seo: page.seo, settings }) : {}
}

export default async function ContentPage({ params }: Props) {
  const { slug } = await params
  const { page, movedTo } = await findContentPage(slug)
  if (movedTo) permanentRedirect(movedTo)
  if (!page) notFound()
  return <PageModules modules={page.modules} heading={page.title} />
}
