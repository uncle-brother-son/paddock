import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import answers from '@/lib/sanity/sample-answers.json'
import { siteSettingsSchema, type Seo } from '@/lib/sanity/schemas'

import { pageMetadata, titleWithSite } from './metadata'

// Brief W73b, item 3: each page's title, description, canonical address and link preview, from its own SEO section
// with Site settings' defaults (docs/build-standards.md, sections 2 and 3).

const settings = siteSettingsSchema.parse(answers.siteSettings)
const noSeo: Seo = { title: null, description: null, shareImage: null }

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => vi.unstubAllEnvs())

describe('a page\'s title', () => {
  it('"{Title} | The Paddock", as the root layout\'s template says', () => {
    expect(titleWithSite('The Experience')).toBe('The Experience | The Paddock')
    const layout = readFileSync(path.resolve(__dirname, '../../app/layout.tsx'), 'utf8')
    expect(layout).toContain(`template: "${titleWithSite('%s')}"`)
    expect(pageMetadata({ path: '/experience', title: 'The Experience', seo: null, settings }).title).toEqual({ absolute: 'The Experience | The Paddock' })
  })

  it("an editor's SEO title is the whole title", () => {
    const seo = { ...noSeo, title: 'Hire the sauna' }
    expect(pageMetadata({ path: '/exclusive-hire', title: 'Exclusive Hire', seo, settings }).title).toEqual({ absolute: 'Hire the sauna' })
    // Spaces alone are not a title.
    expect(pageMetadata({ path: '/exclusive-hire', title: 'Exclusive Hire', seo: { ...noSeo, title: '  ' }, settings }).title).toEqual({ absolute: 'Exclusive Hire | The Paddock' })
  })

  it("the home page's is Site settings' title, then the site's name; its own SEO title first", () => {
    expect(pageMetadata({ path: '/', title: null, seo: null, settings }).title).toEqual({ absolute: 'T' })
    expect(pageMetadata({ path: '/', title: null, seo: null, settings: { ...settings, defaultSeo: null } }).title).toEqual({ absolute: 'The Paddock Wellness Club' })
    expect(pageMetadata({ path: '/', title: null, seo: null, settings: null }).title).toEqual({ absolute: 'The Paddock Wellness Club' })
    expect(pageMetadata({ path: '/', title: null, seo: { ...noSeo, title: 'Sauna in Hebden Bridge' }, settings }).title).toEqual({ absolute: 'Sauna in Hebden Bridge' })
  })
})

describe('the rest of a page\'s metadata', () => {
  it("the description is the page's own, or Site settings'; with neither it is left to the layout's", () => {
    expect(pageMetadata({ path: '/a', title: 'A', seo: { ...noSeo, description: 'Mine' }, settings }).description).toBe('Mine')
    expect(pageMetadata({ path: '/a', title: 'A', seo: noSeo, settings }).description).toBe('D')
    expect(pageMetadata({ path: '/a', title: 'A', seo: noSeo, settings: null })).not.toHaveProperty('description')
  })

  it('the canonical address is the page\'s own path, made whole by the layout\'s metadataBase', () => {
    for (const address of ['/', '/experience', '/info/terms']) expect(pageMetadata({ path: address, title: 'A', seo: null, settings }).alternates).toEqual({ canonical: address })
  })

  it("the link preview: title, description, address, the site's name, en_GB, a 1200 by 630 picture with its alt", () => {
    const metadata = pageMetadata({ path: '/experience', title: 'The Experience', seo: null, settings })
    expect(metadata.openGraph).toEqual({
      title: 'The Experience | The Paddock',
      description: 'D',
      url: '/experience',
      siteName: 'The Paddock Wellness Club',
      locale: 'en_GB',
      type: 'website',
      images: [{ url: expect.stringContaining('https://cdn.sanity.io/images/project/production/share-1200x630.jpg'), width: 1200, height: 630, alt: 'Picture share' }],
    })
    const [image] = (metadata.openGraph as { images: Array<{ url: string }> }).images
    expect(image!.url).toContain('w=1200&h=630')
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image', title: 'The Experience | The Paddock', description: 'D' })
  })

  it("a page's own share picture comes before Site settings'; with neither there is none", () => {
    const own = { ref: 'image-own-2000x1000-jpg', width: 2000, height: 1000, alt: 'Mine', crop: null, hotspot: null }
    const metadata = pageMetadata({ path: '/a', title: 'A', seo: { ...noSeo, shareImage: own }, settings })
    expect((metadata.openGraph as { images: Array<{ url: string; alt: string }> }).images[0]).toMatchObject({ url: expect.stringContaining('own-2000x1000.jpg'), alt: 'Mine' })
    expect(pageMetadata({ path: '/a', title: 'A', seo: noSeo, settings: null }).openGraph).not.toHaveProperty('images')
  })

  it("W74: what is made from the page (a product's first words and first picture, the Shop's intro) comes after its SEO section and before Site settings'", () => {
    const first = { ref: 'image-first-800x1000-jpg', width: 800, height: 1000, alt: 'The front', crop: null, hotspot: null }
    const own = { ref: 'image-own-2000x1000-jpg', width: 2000, height: 1000, alt: 'Mine', crop: null, hotspot: null }
    const made = pageMetadata({ path: '/shop/tee', title: 'Tee - Brown', seo: noSeo, settings, description: 'Soft and warm.', picture: first })
    expect(made.description).toBe('Soft and warm.')
    expect((made.openGraph as { images: Array<{ url: string; alt: string }> }).images[0]).toMatchObject({ url: expect.stringContaining('first-800x1000.jpg'), alt: 'The front' })
    const edited = pageMetadata({ path: '/shop/tee', title: 'Tee - Brown', seo: { title: null, description: 'Mine', shareImage: own }, settings, description: 'Soft and warm.', picture: first })
    expect(edited.description).toBe('Mine')
    expect((edited.openGraph as { images: Array<{ url: string }> }).images[0]!.url).toContain('own-2000x1000.jpg')
    // With nothing made, as before: Site settings'.
    expect(pageMetadata({ path: '/shop', title: 'Shop', seo: null, settings, description: ' ', picture: null }).description).toBe('D')
    // The Shop's address is /shop whatever its query says.
    expect(pageMetadata({ path: '/shop', title: 'Shop', seo: null, settings }).alternates).toEqual({ canonical: '/shop' })
  })
})
