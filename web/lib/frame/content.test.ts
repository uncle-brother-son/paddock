import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import answers from '@/lib/sanity/sample-answers.json'
import { navigationSchema, siteSettingsSchema } from '@/lib/sanity/schemas'

import { frameContent, londonYear } from './content'
import { looksLikeEmail, NEWSLETTER_INVALID_EMAIL, NEWSLETTER_NOT_SET_UP, subscribeToNewsletter } from './newsletter'

// Brief W73, items 4, 5 and 7: what the header, the menu and the footer show, from Sanity's Site settings and
// Navigation documents (the samples lib/sanity/read.test.ts holds, made by Sanity's own query engine).

const settings = siteSettingsSchema.parse(answers.siteSettings)
const navigation = navigationSchema.parse(answers.navigation)

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => vi.unstubAllEnvs())

describe('the menu', () => {
  // Made inside each test: a thumbnail's address needs the project's settings, which are only there while one runs.
  let menuLinks: ReturnType<typeof frameContent>['menuLinks']
  beforeEach(() => {
    menuLinks = frameContent(settings, navigation, '2026').menuLinks
  })

  it('each link with its address, in order; a link to a page that is not published is hidden', () => {
    expect(menuLinks.map((link) => [link.label, link.href, link.outside])).toEqual([
      ['Home', '/', false],
      ['Exclusive Hire', '/exclusive-hire', false],
      ['Shop', '/shop', false],
      ['Solstice', '/events/solstice-2026', false],
    ])
  })

  it("the hover picture is the linked page's thumbnail, cropped 4 by 5 from Sanity's CDN; a page with none, the shop and an event have none", () => {
    expect(menuLinks.map((link) => link.thumbnail !== null)).toEqual([false, true, false, false])
    const thumbnail = menuLinks[1]!.thumbnail!
    expect([thumbnail.width, thumbnail.height]).toEqual([240, 300])
    expect(thumbnail.src).toMatch(/^https:\/\/cdn\.sanity\.io\/images\/project\/production\/thumb-600x400\.jpg\?/)
    for (const part of ['w=240', 'h=300', 'fit=crop', 'auto=format']) expect(thumbnail.src).toContain(part)
    // The editor's crop is kept: a tenth off the left of a 600px picture.
    expect(thumbnail.src).toMatch(/rect=\d+,\d+,\d+,\d+/)
    expect(thumbnail.srcSet.split(', ').map((entry) => entry.split(' ')[1])).toEqual(['240w', '480w', '720w'])
  })
})

describe('the footer', () => {
  let footer: ReturnType<typeof frameContent>['footer']
  beforeEach(() => {
    footer = frameContent(settings, navigation, '2026').footer
  })

  it('its groups are the editor\'s, left to right; a group with nothing to show takes no column', () => {
    // The sample: a group with Terms, a group with an outside address, and a group made and not filled.
    expect(footer.groups.map((group) => [group.key, group.links.map((link) => [link.label, link.href, link.outside])])).toEqual([
      ['g1', [['Terms', '/info/terms', false]]],
      ['g2', [['Outside', 'https://example.com', true]]],
    ])
  })

  it('a group whose every page is unpublished is left out too', () => {
    const hidden = { key: 'x', label: 'Not published', link: { destination: 'page' as const, document: null, url: null } }
    const { footer: withHidden } = frameContent(settings, { menuLinks: [], footerGroups: [{ key: 'g0', links: [hidden] }, ...navigation.footerGroups] }, '2026')
    expect(withHidden.groups.map((group) => group.key)).toEqual(['g1', 'g2'])
  })

  it('the newsletter words and the copyright line come from Site settings', () => {
    expect(footer.newsletter).toEqual({ heading: 'News', text: 'Join' })
    expect(footer.copyright).toBe('©2026 The Paddock')
    expect(frameContent({ ...settings, copyrightName: null }, navigation, '2027').footer.copyright).toBe('©2027 The Paddock Wellness Club')
  })

  it("the checkout's two links are the Terms and Privacy pages Site settings picks, each only once it is published", () => {
    const terms = { title: 'Terms & Conditions', slug: 'terms' }
    const privacy = { title: 'Privacy Policy', slug: 'privacy' }
    const links = (termsPage: typeof terms | null, privacyPage: typeof privacy | null) =>
      frameContent({ ...settings, termsPage, privacyPage }, navigation, '2026').footer.legalLinks.map((link) => [link.label, link.href])
    expect(links(terms, privacy)).toEqual([
      ['Terms & Conditions', '/info/terms'],
      ['Privacy Policy', '/info/privacy'],
    ])
    expect(links(null, privacy)).toEqual([['Privacy Policy', '/info/privacy']])
    expect(links(null, null)).toEqual([])
  })
})

describe('with nothing in Sanity yet', () => {
  it('the frame still stands: no menu links, no footer links, the site\'s own name in the copyright line', () => {
    expect(frameContent(null, null, '2026')).toEqual({
      menuLinks: [],
      footer: { groups: [], newsletter: { heading: null, text: null }, legalLinks: [], copyright: '©2026 The Paddock Wellness Club' },
    })
  })

  it('one document without the other is fine', () => {
    expect(frameContent(settings, null, '2026').menuLinks).toEqual([])
    expect(frameContent(null, navigation, '2026').menuLinks).toHaveLength(4)
  })
})

describe('the year in the copyright line', () => {
  it("is London's: New Year arrives there at midnight, London time", () => {
    expect(londonYear(new Date('2026-12-31T23:59:59Z'))).toBe('2026')
    expect(londonYear(new Date('2027-01-01T00:00:00Z'))).toBe('2027')
    // British Summer Time: 23:30 UTC on 30 June is already 1 July in London, the same year either way.
    expect(londonYear(new Date('2027-06-30T23:30:00Z'))).toBe('2027')
  })
})

describe('the newsletter sign-up (not set up yet)', () => {
  it('signs nobody up: a real address is answered "not set up"', async () => {
    expect(await subscribeToNewsletter('bob@example.com')).toEqual({ ok: false, message: NEWSLETTER_NOT_SET_UP })
  })

  it.each(['', 'bob', 'bob@', 'bob@example', '@example.com', 'bob @example.com'])('%j is not an email address', async (value) => {
    expect(looksLikeEmail(value)).toBe(false)
    expect(await subscribeToNewsletter(value)).toEqual({ ok: false, message: NEWSLETTER_INVALID_EMAIL })
  })

  it('spaces round an address are let through', () => {
    expect(looksLikeEmail('  bob@example.co.uk ')).toBe(true)
  })
})
