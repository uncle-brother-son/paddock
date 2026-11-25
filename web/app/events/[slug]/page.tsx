import type { Metadata } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'

import { EventPageView } from '@/components/events/EventPageView'
import { findEventPage } from '@/lib/events/pages'
import { readSiteSettings } from '@/lib/frame/read'
import { pageMetadata } from '@/lib/seo/metadata'
import { firstPicture, metaDescription, plainText } from '@/lib/shop/product'

// An event at /events/[slug] (W75; WQ17): one page for each date. It shows when it is published in Sanity and in the
// Worker's read (on sale), a started one and a cancelled one included (WQ59: booking is closed, the page stays):
// anything else is a 404. A slug the event had before answers with a permanent redirect (308) to where it is now
// (W72a). Its title is "{Name} | The Paddock", its description its first words and its link preview its first
// picture, each unless its SEO section says otherwise; then Site settings' defaults. Never `dynamicParams = false`
// here (docs/build-standards.md, section 6).

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const [{ page }, settings] = await Promise.all([findEventPage(slug), readSiteSettings()])
  // Nothing here: the page below answers with the redirect or the 404.
  if (!page) return {}
  const { event } = page
  return pageMetadata({
    path: `/events/${event.slug}`,
    title: event.name,
    seo: event.seo,
    settings,
    description: metaDescription(plainText(event.description)),
    picture: firstPicture(event.gallery),
  })
}

export default async function EventPage({ params }: Props) {
  const { slug } = await params
  const { page, movedTo } = await findEventPage(slug)
  if (movedTo) permanentRedirect(movedTo)
  if (!page) notFound()
  return <EventPageView view={page.view} others={page.others} listAddress={page.listAddress} />
}
