import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import answers from '@/lib/sanity/sample-answers.json'
import { reads } from '@/lib/sanity/read'

// Brief W73b, item 3: what each address answers. The home page is at /, a content page at /[slug], an info page at
// /info/[slug]; an unknown or unpublished slug is a 404, an old slug a permanent redirect (W72a), and the home
// page's own slug goes to /. Sanity is stood in for by the samples its own engine made.

const fetched = vi.hoisted(() => vi.fn())
vi.mock('@sanity/client', () => ({ createClient: () => ({ fetch: fetched }) }))
// Outside a request there is nothing to wait for.
vi.mock('next/server', () => ({ connection: async () => undefined }))
// React's `cache` shares a read inside one request; here every call is its own.
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), cache: <T>(read: T) => read }))

const { findContentPage, findInfoPage, readHomePage } = await import('./read')

type Asked = { query: string; slug?: string; type?: string }
const asked = (): Asked[] => fetched.mock.calls.map(([query, params]) => ({ query, ...(params as object) }))

/** Sanity, answering by the query it is sent: a page by its slug, or where an old slug went. */
const sanity = (pages: Record<string, unknown>, moved: Record<string, { slug: string; isHome: boolean }> = {}) => {
  fetched.mockImplementation(async (query: string, params: { slug?: string; type?: string }) => {
    if (query === reads.movedSlug.query) return moved[`${params.type} ${params.slug}`] ?? null
    if (query === reads.homePage.query) return pages['/'] ?? null
    return pages[params.slug ?? ''] ?? null
  })
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => {
  vi.unstubAllEnvs()
  fetched.mockReset()
})

describe('the home page, at /', () => {
  it('is the page Site settings picks, with its modules', async () => {
    sanity({ '/': answers.homePage })
    const page = await readHomePage()
    expect(page?.id).toBe('page-home')
    expect(page?.modules.map((module) => module.type)).toEqual(['hero'])
    expect(asked()).toEqual([{ query: reads.homePage.query }])
  })

  it('none picked or published: nothing, and the page still stands (app/page.tsx)', async () => {
    sanity({})
    expect(await readHomePage()).toBeNull()
    expect(readFileSync(path.resolve(__dirname, '../../app/page.tsx'), 'utf8')).toContain('page?.modules ?? []')
  })
})

describe('a content page, at /[slug]', () => {
  it('a published page is the page', async () => {
    sanity({ 'exclusive-hire': answers.contentPage })
    const found = await findContentPage('exclusive-hire')
    expect(found.page?.title).toBe('Exclusive Hire')
    expect(found.movedTo).toBeNull()
    expect(asked()).toEqual([{ query: reads.contentPage.query, slug: 'exclusive-hire' }])
  })

  it("the home page's own slug has moved to /", async () => {
    sanity({ home: answers.homePage })
    expect(await findContentPage('home')).toEqual({ page: null, movedTo: '/' })
  })

  it('a slug no published page has is nothing: a 404', async () => {
    sanity({})
    expect(await findContentPage('never-was')).toEqual({ page: null, movedTo: null })
    // Asked for the page, then for where it might have gone.
    expect(asked().map((one) => one.query)).toEqual([reads.contentPage.query, reads.movedSlug.query])
  })

  it('an old slug has moved to where its page is now; an old slug of the home page, to /', async () => {
    sanity({}, { 'contentPage private-hire': { slug: 'exclusive-hire', isHome: false }, 'contentPage welcome': { slug: 'home', isHome: true } })
    expect(await findContentPage('private-hire')).toEqual({ page: null, movedTo: '/exclusive-hire' })
    expect(await findContentPage('welcome')).toEqual({ page: null, movedTo: '/' })
  })

  it.each(['shop', 'book', 'account', 'checkout', 'Shop'])("one of the site's own words (/%s) is no page's slug: nothing, and Sanity is not asked", async (slug) => {
    sanity({ [slug]: answers.contentPage })
    expect(await findContentPage(slug)).toEqual({ page: null, movedTo: null })
    expect(fetched).not.toHaveBeenCalled()
  })

  it('a read that fails throws: a page that could not be read is an error, never a "not found"', async () => {
    fetched.mockRejectedValue(new Error('Sanity is not reachable'))
    await expect(findContentPage('experience')).rejects.toThrow('Sanity is not reachable')
    await expect(readHomePage()).rejects.toThrow('Sanity is not reachable')
  })
})

describe('an info page, at /info/[slug]', () => {
  it('a published page is the page, with its text', async () => {
    sanity({ terms: answers.infoPage })
    const found = await findInfoPage('terms')
    expect(found.page?.title).toBe('Terms')
    expect(found.page?.body).toHaveLength(2)
    expect(asked()).toEqual([{ query: reads.infoPage.query, slug: 'terms' }])
  })

  it("an old slug has moved, under /info; a content page's old slug is not an info page's", async () => {
    sanity({}, { 'infoPage terms-and-conditions': { slug: 'terms', isHome: false }, 'contentPage private-hire': { slug: 'exclusive-hire', isHome: false } })
    expect(await findInfoPage('terms-and-conditions')).toEqual({ page: null, movedTo: '/info/terms' })
    expect(await findInfoPage('private-hire')).toEqual({ page: null, movedTo: null })
  })
})

describe('the three routes', () => {
  const route = (file: string) => readFileSync(path.resolve(__dirname, '../../app', file), 'utf8')

  it.each(['[slug]/page.tsx', 'info/[slug]/page.tsx'])('%s: an old address is a permanent redirect (308), nothing is a 404, and params are never fixed at build', (file) => {
    const source = route(file)
    expect(source).toContain('if (movedTo) permanentRedirect(movedTo)')
    expect(source).toContain('if (!page) notFound()')
    expect(source.indexOf('permanentRedirect(movedTo)')).toBeLessThan(source.indexOf('notFound()'))
    expect(source).not.toMatch(/export const dynamicParams|generateStaticParams/)
  })

  it.each(['page.tsx', '[slug]/page.tsx', 'info/[slug]/page.tsx'])("%s: its metadata is the page's SEO with Site settings' defaults, and it draws no <main> of its own", (file) => {
    const source = route(file)
    expect(source).toContain('export async function generateMetadata(')
    expect(source).toContain('pageMetadata({ path: ')
    expect(source).toContain('readSiteSettings()')
    expect(source).not.toMatch(/<main/)
  })
})
