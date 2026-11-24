import type { Metadata } from 'next'

import { PageModules } from '@/components/modules/PageModules'
import { readSiteSettings } from '@/lib/frame/read'
import { readHomePage } from '@/lib/pages/read'
import { pageMetadata } from '@/lib/seo/metadata'
import { SITE_NAME } from '@/lib/site'

// The home page (W73b): the content page Site settings picks, with its modules. Its own slug (/home) answers with a
// permanent redirect to here (app/[slug]/page.tsx). The frame (app/layout.tsx) supplies the main element.

export async function generateMetadata(): Promise<Metadata> {
  const [page, settings] = await Promise.all([readHomePage(), readSiteSettings()])
  return pageMetadata({ path: '/', title: null, seo: page?.seo ?? null, settings })
}

export default async function Home() {
  const [page, settings] = await Promise.all([readHomePage(), readSiteSettings()])
  // With no home page picked or published yet the frame still stands, round a page with only its heading.
  return <PageModules modules={page?.modules ?? []} heading={settings?.siteName ?? SITE_NAME} />
}
