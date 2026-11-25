import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { isBuiltAddress, NOT_BUILT_ADDRESSES } from './not-built'
import { RESERVED_PRODUCT_SLUGS, RESERVED_SLUGS } from './reserved-slugs'

// Level 3, 25 Nov 2026: no background request to a page that isn't built. Loading /shop asked for /book, /account
// and /shop/gift-card ahead of any press, each more than once, and none of them exists yet.

const WEB = path.resolve(__dirname, '../..')
const hasFolder = (address: string) => existsSync(path.join(WEB, 'app', ...address.split('/').filter(Boolean)))

/** Every address the site keeps for itself: the reserved words, and under /shop the words no product can use. */
const OWN_ADDRESSES = [...RESERVED_SLUGS.map((slug) => `/${slug}`), ...RESERVED_PRODUCT_SLUGS.map((slug) => `/shop/${slug}`)]

describe('the list of pages not built yet', () => {
  it.each(OWN_ADDRESSES)('%s is on it exactly while app/ has no folder for it', (address) => {
    const listed = (NOT_BUILT_ADDRESSES as readonly string[]).includes(address)
    // Built since? Take it off the list in lib/routes/not-built.ts, so its links are fetched ahead again.
    expect({ address, listed }).toEqual({ address, listed: !hasFolder(address) })
  })

  it("holds only the site's own addresses", () => {
    expect(NOT_BUILT_ADDRESSES.filter((address) => !OWN_ADDRESSES.includes(address))).toEqual([])
  })
})

describe('whether an address has a page to open', () => {
  it.each(['/book', '/book?date=2026-12-01&type=public', '/account', '/account/orders/12', '/shop/gift-card', '/shop/gift-card#amount', '/events/winter-solstice', '/checkout'])(
    '%s: not yet',
    (href) => expect(isBuiltAddress(href)).toBe(false),
  )

  it.each(['/', '/shop', '/shop?sort=price-desc&page=2', '/shop/paddock-hoodie-black', '/shop/gift-card-holder', '/info/terms', '/about', '/booking-terms', '/accounts'])(
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
