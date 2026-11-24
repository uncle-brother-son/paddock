import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'

import { robotsFor } from '@/lib/seo/robots'

// robots.txt (docs/build-standards.md, sections 2 and 9): everything is disallowed unless the host is the live
// domain. Reading the request's host makes this answer per request, never from a cache, so a test copy and the
// live domain can't be served each other's file.
export default async function robots(): Promise<MetadataRoute.Robots> {
  return robotsFor((await headers()).get('host'))
}
