import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BUILT_BENEATH, isBuiltAddress, NOT_BUILT_ADDRESSES } from './not-built'
import { RESERVED_PRODUCT_SLUGS, RESERVED_SLUGS } from './reserved-slugs'

// Level 3, 25 Nov 2026: no background request to a page that isn't built. Loading /shop asked for /book, /account
// and /shop/gift-card ahead of any press, each more than once, and none of them existed yet. W76: /shop/gift-card
// is built, and off the list.

const WEB = path.resolve(__dirname, '../..')
const inApp = (address: string, ...more: string[]) => path.join(WEB, 'app', ...address.split('/').filter(Boolean), ...more)
const hasFolder = (address: string) => existsSync(inApp(address))
/** W75: an address whose pages beneath it are built has a folder for them, and is built itself only once it has a page of its own. */
const isBuilt = (address: string) => (BUILT_BENEATH.includes(address) ? existsSync(inApp(address, 'page.tsx')) : hasFolder(address))

/** Every address the site keeps for itself: the reserved words, and under /shop the words no product can use. */
const OWN_ADDRESSES = [...RESERVED_SLUGS.map((slug) => `/${slug}`), ...RESERVED_PRODUCT_SLUGS.map((slug) => `/shop/${slug}`)]

describe('the list of pages not built yet', () => {
  it.each(OWN_ADDRESSES)('%s is on it exactly while app/ has no folder for it', (address) => {
    const listed = (NOT_BUILT_ADDRESSES as readonly string[]).includes(address)
    // Built since? Take it off the list in lib/routes/not-built.ts, so its links are fetched ahead again.
    expect({ address, listed }).toEqual({ address, listed: !isBuilt(address) })
  })

  // W75: /events/[slug] is built and /events is not (the events list is on Exclusive Hire: WQ60).
  it('an address that is built only beneath itself is on the list, has its folder, and has no page of its own', () => {
    expect(BUILT_BENEATH).toEqual(['/events'])
    for (const address of BUILT_BENEATH) {
      expect((NOT_BUILT_ADDRESSES as readonly string[]).includes(address), address).toBe(true)
      expect([hasFolder(address), existsSync(inApp(address, 'page.tsx')), existsSync(inApp(address, '[slug]', 'page.tsx'))], address).toEqual([true, false, true])
    }
  })

  it("holds only the site's own addresses", () => {
    expect(NOT_BUILT_ADDRESSES.filter((address) => !OWN_ADDRESSES.includes(address))).toEqual([])
  })

  // W76: the gift card's page is a folder of its own beside the products' [slug], which a product can never be given.
  it('the gift card has its page, and is not on the list', () => {
    expect(existsSync(inApp('/shop/gift-card', 'page.tsx'))).toBe(true)
    expect((NOT_BUILT_ADDRESSES as readonly string[]).includes('/shop/gift-card')).toBe(false)
  })
})

describe('whether an address has a page to open', () => {
  it.each(['/book', '/book?date=2026-12-01&type=public', '/account', '/account/orders/12', '/events', '/events?month=12', '/events#list', '/checkout'])(
    '%s: not yet',
    (href) => expect(isBuiltAddress(href)).toBe(false),
  )

  it.each([
    '/',
    '/shop',
    '/shop?sort=price-desc&page=2',
    '/shop/paddock-hoodie-black',
    '/shop/gift-card-holder',
    '/info/terms',
    '/about',
    '/booking-terms',
    '/accounts',
    // W75: an event's page, and the events list on the page that holds it.
    '/events/winter-solstice',
    '/events/winter-solstice?from=email',
    '/exclusive-hire#events',
    // W76: the gift card's page, in either format.
    '/shop/gift-card',
    '/shop/gift-card?format=physical',
  ])(
    '%s: yes (or a page of Sanity, which only Sanity knows)',
    (href) => expect(isBuiltAddress(href)).toBe(true),
  )
})

describe('SiteLink', () => {
  const link = readFileSync(path.join(WEB, 'components/ui/SiteLink.tsx'), 'utf8')

  it('never fetches a page that is not built ahead of a press, and fetches every other as Next does by itself', () => {
    expect(link).toContain("prefetch={isBuiltAddress(href) ? 'auto' : false}")
    expect(link.match(/prefetch=/g)).toHaveLength(1)
  })
})
