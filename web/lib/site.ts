// Facts about the site that never come from Sanity. next.config.ts reads this file too, so it imports nothing.

/** Placeholder until the Site settings document (W72) supplies it. */
export const SITE_NAME = 'The Paddock Wellness Club'

/** The live domain: the bare domain, no www (WQ2). Every other host is a test copy. */
export const LIVE_HOST = 'thepaddockwellness.co.uk'

export const SITE_URL = `https://${LIVE_HOST}`

/** True only for the live domain itself. A port is ignored, as Next ignores it when it matches a host rule. */
export function isLiveHost(host: string | null | undefined): boolean {
  if (!host) return false
  return host.split(':', 1)[0]?.trim().toLowerCase() === LIVE_HOST
}

/**
 * Test copies stay out of search (docs/build-standards.md, section 2): every response on a host that isn't the live
 * domain carries this header. Next reads a host rule's `value` as a regular expression over the whole host name, so
 * the dots are escaped.
 */
export const NOINDEX_HEADER = { key: 'X-Robots-Tag', value: 'noindex, nofollow' } as const

export const LIVE_HOST_RULE = { type: 'host', value: LIVE_HOST.replace(/\./g, '\\.') } as const
