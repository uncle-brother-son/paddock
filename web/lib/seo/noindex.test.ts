import { readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveRobots } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data'
import { modifyRouteRegex } from 'next/dist/lib/redirect-status'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'
import { matchHas } from 'next/dist/shared/lib/router/utils/prepare-destination'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import robots from '@/app/robots'
import { isLiveHost, LIVE_HOST } from '@/lib/site'
import nextConfig from '@/next.config'

import { AI_SEARCH_CRAWLERS, AI_TRAINING_CRAWLERS, NOT_FOR_SEARCH, robotsFor } from './robots'

// Brief W71, item 8 (docs/build-standards.md, section 2): a test copy of the site never shows in search. Every
// response on a host that isn't the live domain carries `X-Robots-Tag: noindex, nofollow`, and robots.txt there
// disallows everything. Two places answer a request, so two rules say it: next.config.ts for what the Worker
// answers, and public/_headers for the static files Cloudflare answers before the Worker is reached.

const WEB = path.resolve(__dirname, '../..')

const requestHost = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name.toLowerCase() === 'host' ? requestHost.value : null) }),
}))

const NOINDEX = 'noindex, nofollow'
const TEST_HOSTS = [
  'paddock.paddock-55d.workers.dev',
  'abc123-paddock.paddock-55d.workers.dev',
  'localhost:3000',
  'www.thepaddockwellness.co.uk',
  'preview.thepaddockwellness.co.uk',
  'thepaddockwellness.co.uk.example.com',
  'thepaddockwellnessxco.uk',
  'notthepaddockwellness.co.uk',
  'thepaddockwellness.com',
]
const LIVE_HOSTS = [LIVE_HOST, `${LIVE_HOST}:443`, 'THEPADDOCKWELLNESS.CO.UK']
const PATHS = ['/', '/shop', '/shop/herd-hoodie-moss', '/account/bookings/12', '/robots.txt', '/api/v1/staff/whoami', '/api/stripe/webhook', '/a/b/c/d']

/** The headers next.config.ts adds to a request, worked out with Next's own path and host matching. */
async function configHeaders(host: string | undefined, pathname: string): Promise<Record<string, string>> {
  const rules = await nextConfig.headers!()
  const added: Record<string, string> = {}
  for (const rule of rules) {
    // As Next's router builds a header rule's matcher (next/dist/server/lib/router-utils/filesystem.js).
    const pathMatches = getPathMatch(rule.source, { strict: true, sensitive: false, removeUnnamedParams: true, regexModifier: (regex: string) => modifyRouteRegex(regex) })(pathname)
    const request = { headers: host === undefined ? {} : { host } } as Parameters<typeof matchHas>[0]
    if (pathMatches && matchHas(request, {}, rule.has, rule.missing)) for (const header of rule.headers) added[header.key.toLowerCase()] = header.value
  }
  return added
}

describe('every response the Worker gives on a host that isn\'t the live domain is noindex (W71, item 8)', () => {
  it.each(TEST_HOSTS)('%s: every path carries X-Robots-Tag: noindex, nofollow', async (host) => {
    for (const pathname of PATHS) expect((await configHeaders(host, pathname))['x-robots-tag'], pathname).toBe(NOINDEX)
  })

  it('a request with no Host header is treated as a test copy', async () => {
    expect((await configHeaders(undefined, '/'))['x-robots-tag']).toBe(NOINDEX)
  })

  it.each(LIVE_HOSTS)('%s: no path carries the header', async (host) => {
    for (const pathname of PATHS) expect(await configHeaders(host, pathname), pathname).toEqual({})
  })

  it('one rule, on every path, for every host but the live one', async () => {
    expect(await nextConfig.headers!()).toEqual([
      { source: '/:path*', missing: [{ type: 'host', value: 'thepaddockwellness\\.co\\.uk' }], headers: [{ key: 'X-Robots-Tag', value: NOINDEX }] },
    ])
  })

  it('isLiveHost: the bare live domain only', () => {
    for (const host of LIVE_HOSTS) expect(isLiveHost(host), host).toBe(true)
    for (const host of [...TEST_HOSTS, '', null, undefined]) expect(isLiveHost(host), String(host)).toBe(false)
  })
})

describe('the static files Cloudflare answers itself are noindex too (public/_headers)', () => {
  // Cloudflare's rules: a block is a URL pattern, then indented `Name: value` lines; `! Name` takes a header off
  // again for a narrower pattern (developers.cloudflare.com/workers/static-assets/headers).
  const blocks = readFileSync(path.join(WEB, 'public/_headers'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .reduce<{ pattern: string; lines: string[] }[]>((all, line) => {
      if (/^\s/.test(line)) all.at(-1)!.lines.push(line.trim())
      else all.push({ pattern: line.trim(), lines: [] })
      return all
    }, [])

  it('every file on every host is noindex, and only the live domain takes the header off', () => {
    expect(blocks).toEqual([
      { pattern: '/*', lines: [`X-Robots-Tag: ${NOINDEX}`] },
      { pattern: `https://${LIVE_HOST}/*`, lines: ['! X-Robots-Tag'] },
    ])
  })
})

describe('robots.txt disallows everything unless the host is the live domain (W71, item 8)', () => {
  beforeEach(() => {
    requestHost.value = null
  })

  it.each(TEST_HOSTS)('%s: nothing may be crawled', async (host) => {
    requestHost.value = host
    expect(resolveRobots(await robots())).toBe('User-Agent: *\nDisallow: /\n\n')
  })

  it('no host at all: nothing may be crawled', async () => {
    expect(resolveRobots(await robots())).toBe('User-Agent: *\nDisallow: /\n\n')
    expect(robotsFor(undefined)).toEqual({ rules: { userAgent: '*', disallow: '/' } })
  })

  it.each(LIVE_HOSTS)('%s: the public site may be crawled', async (host) => {
    requestHost.value = host
    const text = resolveRobots(await robots())
    expect(text.startsWith('User-Agent: *\nAllow: /\nDisallow: /account\nDisallow: /checkout\nDisallow: /auth\nDisallow: /waiver\n\n')).toBe(true)
    expect(text).not.toMatch(/^User-Agent: \*\nDisallow: \/$/m)
  })

  it('live: AI search crawlers are allowed by name, AI training crawlers are blocked (WQ14)', () => {
    const groups = resolveRobots(robotsFor(LIVE_HOST)).trim().split('\n\n')
    expect(groups).toHaveLength(3)
    expect(groups[1]).toBe([...AI_SEARCH_CRAWLERS.map((agent) => `User-Agent: ${agent}`), 'Allow: /', ...NOT_FOR_SEARCH.map((prefix) => `Disallow: ${prefix}`)].join('\n'))
    expect(groups[2]).toBe([...AI_TRAINING_CRAWLERS.map((agent) => `User-Agent: ${agent}`), 'Disallow: /'].join('\n'))
    expect(AI_SEARCH_CRAWLERS).toEqual(['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Googlebot', 'Bingbot', 'Applebot'])
    expect(AI_TRAINING_CRAWLERS).toEqual(['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot'])
    expect(NOT_FOR_SEARCH).toEqual(['/account', '/checkout', '/auth', '/waiver'])
  })

  it('app/robots.ts reads the request\'s host, so the answer is never served from a cache', () => {
    const source = readFileSync(path.join(WEB, 'app/robots.ts'), 'utf8')
    expect(source).toContain("robotsFor((await headers()).get('host'))")
  })
})
