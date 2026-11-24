import type { MetadataRoute } from 'next'

import { isLiveHost } from '@/lib/site'

// What robots.txt says, by host (docs/build-standards.md, sections 2 and 9). app/robots.ts answers with it.

/** Kept out of search on the live site: each also sends `noindex`. */
export const NOT_FOR_SEARCH: readonly string[] = ['/account', '/checkout', '/auth', '/waiver']

/** AI search and assistant crawlers, and the search engines behind AI answers: allowed, by name (section 9). */
export const AI_SEARCH_CRAWLERS: readonly string[] = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Googlebot',
  'Bingbot',
  'Applebot',
]

/** Crawlers that only collect pages to train AI models: blocked (WQ14). */
export const AI_TRAINING_CRAWLERS: readonly string[] = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot']

export function robotsFor(host: string | null | undefined): MetadataRoute.Robots {
  // A preview, a workers.dev address or any other test copy: nothing may be crawled.
  if (!isLiveHost(host)) return { rules: { userAgent: '*', disallow: '/' } }

  // The sitemap line is added with sitemap.xml, when there are pages to list.
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: [...NOT_FOR_SEARCH] },
      { userAgent: [...AI_SEARCH_CRAWLERS], allow: '/', disallow: [...NOT_FOR_SEARCH] },
      { userAgent: [...AI_TRAINING_CRAWLERS], disallow: '/' },
    ],
  }
}
