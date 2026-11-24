import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'

import { Grid } from '@/components/layout/Grid'
import { RichText } from '@/components/ui/RichText'
import { readSiteSettings } from '@/lib/frame/read'
import { findInfoPage } from '@/lib/pages/read'
import { pageMetadata } from '@/lib/seo/metadata'

// An info page at /info/[slug] (W73b; WQ26): Terms, Privacy and the like. Its title and text only for now: the info
// template, with its left menu, comes later and is not designed here. An unknown slug is a 404, an old one a
// permanent redirect (308) to the page's address now (W72a).

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const [{ page }, settings] = await Promise.all([findInfoPage(slug), readSiteSettings()])
  return page ? pageMetadata({ path: `/info/${page.slug}`, title: page.title, seo: page.seo, settings }) : {}
}

export default async function InfoPage({ params }: Props) {
  const { slug } = await params
  const { page, movedTo } = await findInfoPage(slug)
  if (movedTo) permanentRedirect(movedTo)
  if (!page) notFound()
  return (
    // The header lies over the top of every page: the room above the title keeps the two apart.
    <Grid as="article" className="pt-120 pb-120">
      <div className="col-span-6 flex flex-col gap-40 md:col-span-12 md:col-start-7">
        <h1 className="text-h1">{page.title}</h1>
        <RichText blocks={page.body} />
      </div>
    </Grid>
  )
}
