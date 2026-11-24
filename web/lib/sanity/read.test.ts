import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkHref } from './links'
import { reads, readSanity } from './read'
import answers from './sample-answers.json'
import type { Link } from './schemas'

// Brief W72, item 11. sample-answers.json is what ./queries.ts answered, run by Sanity's own GROQ engine (groq-js, from
// the Studio's packages) over sample documents of every type: one published, one a draft, one link to a page that isn't
// published, a video, a decorative picture, an image with no file, a product with no address.

const fetched = vi.hoisted(() => vi.fn())
const created = vi.hoisted(() => vi.fn())
vi.mock('@sanity/client', () => ({
  createClient: (config: unknown) => {
    created(config)
    return { fetch: fetched }
  },
}))

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => {
  vi.unstubAllEnvs()
  fetched.mockReset()
  created.mockReset()
})

const names = Object.keys(reads) as (keyof typeof reads)[]

describe('each read', () => {
  it('has a sample answer, and no other', () => {
    expect(Object.keys(answers).sort()).toEqual([...names].sort())
  })

  it.each(names)('%s: its sample fits its type, with nothing left over', (name) => {
    expect(reads[name].schema.parse(answers[name])).toEqual(answers[name])
  })

  it.each(names)('%s: a document that is not there', (name) => {
    const isList = Array.isArray(answers[name])
    expect(reads[name].schema.safeParse(null).success).toBe(!isList)
    expect(reads[name].schema.safeParse([]).success).toBe(isList)
  })

  it('one whose answer does not fit is refused, not passed on', () => {
    expect(reads.siteSettings.schema.safeParse({ ...answers.siteSettings, siteName: null }).success).toBe(false)
    expect(reads.contentPage.schema.safeParse({ ...answers.contentPage, modules: [{ type: 'unknown', key: 'k' }] }).success).toBe(false)
  })
})

describe('readSanity', () => {
  it('asks for published documents and parses the answer', async () => {
    fetched.mockResolvedValue(answers.navigation)
    expect(await readSanity('navigation')).toEqual(answers.navigation)
    expect(created).toHaveBeenCalledWith({ projectId: 'project', dataset: 'production', apiVersion: '2025-02-19', useCdn: true, perspective: 'published' })
    expect(fetched).toHaveBeenCalledWith(reads.navigation.query, {})
  })

  it('a page by its slug: sent as a parameter, never in the query', async () => {
    fetched.mockResolvedValue(null)
    expect(await readSanity('contentPage', 'exclusive-hire')).toBeNull()
    expect(fetched).toHaveBeenCalledWith(reads.contentPage.query, { slug: 'exclusive-hire' })
  })

  it('an answer that does not fit throws', async () => {
    fetched.mockResolvedValue({ menuLinks: 'no' })
    await expect(readSanity('navigation')).rejects.toThrow()
  })
})

describe('linkHref', () => {
  const links = [...answers.navigation.menuLinks, ...answers.navigation.footerLinks].map(({ label, link }) => [label, linkHref(link as Link)])

  it('each kind of link, and a link to a page that is not published is hidden', () => {
    expect(links).toEqual([
      ['Home', '/'],
      ['Exclusive Hire', '/exclusive-hire'],
      ['Shop', '/shop'],
      ['Solstice', '/events/solstice-2026'],
      ['Not published', null],
      ['Terms', '/info/terms'],
      ['Outside', 'https://example.com'],
    ])
  })
})
