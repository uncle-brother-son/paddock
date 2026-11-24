import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isReservedSlug, RESERVED_SLUGS, slugProblem } from './reserved-slugs'
import { checkSlug } from '../../../studio/lib/checks'

// Brief W72, item 3 (WQ26): one list, read by the site and by the Studio.

const STUDIO = path.resolve(__dirname, '../../../studio')
const schema = (file: string) => readFileSync(path.join(STUDIO, 'schemaTypes', file), 'utf8')

describe('the reserved words', () => {
  it('are the ten of WQ26', () => {
    expect([...RESERVED_SLUGS]).toEqual(['shop', 'events', 'blog', 'info', 'checkout', 'account', 'auth', 'waiver', 'book', 'api'])
  })

  it.each([...RESERVED_SLUGS])("%s is refused as a page's slug, by the site and by the Studio", (word) => {
    for (const typed of [word, word.toUpperCase(), ` ${word} `]) {
      expect(isReservedSlug(typed), typed).toBe(true)
      expect(slugProblem(typed, 'page')).toBe(`"${typed.trim()}" is used by the site itself. Choose another address.`)
      expect(checkSlug(typed, 'page')).toBe(`"${typed.trim()}" is used by the site itself. Choose another address.`)
    }
  })

  it.each(['exclusive-hire', 'booking', 'our-events', 'shop-2', 'about'])('%s is allowed', (slug) => {
    expect(slugProblem(slug, 'page')).toBeNull()
    expect(checkSlug(slug, 'page')).toBe(true)
  })

  it('an info page or a product has its own folder, so the words are free there', () => {
    expect(checkSlug('events', 'info')).toBe(true)
    expect(checkSlug('events', 'product')).toBe(true)
  })

  it.each(['gift-card', 'Gift-Card', ' gift-card '])("%s is refused as a product's slug: it is the gift card's page (/shop/gift-card)", (slug) => {
    expect(checkSlug(slug, 'product')).toBe(`"${slug.trim()}" is used by the site itself. Choose another address.`)
    expect(slugProblem(slug, 'product')).not.toBeNull()
  })

  it('gift-card is free anywhere else, and so is a longer product slug', () => {
    expect(checkSlug('gift-card', 'page')).toBe(true)
    expect(checkSlug('gift-card', 'info')).toBe(true)
    expect(checkSlug('gift-card-holder', 'product')).toBe(true)
  })

  it.each(['Our Story', 'our_story', '-our', 'our-', 'our--story', 'our/story', 'café', ' about'])('"%s" is not an address', (slug) => {
    expect(checkSlug(slug, 'info')).toContain('Use lowercase letters and numbers')
  })

  it('an empty slug is left to the field being required', () => {
    expect(checkSlug(undefined, 'page')).toBe(true)
    expect(checkSlug('', 'page')).toBe(true)
  })
})

describe('the Studio reads this list and holds no copy', () => {
  it('content pages and events refuse the words; every slug is required', () => {
    for (const file of ['contentPage.ts', 'event.ts']) expect(schema(file), file).toContain("rule.required().custom((slug) => checkSlug(slug?.current, 'page'))")
    expect(schema('infoPage.ts')).toContain("rule.required().custom((slug) => checkSlug(slug?.current, 'info'))")
    expect(schema('product.ts')).toContain("rule.required().custom((slug) => checkSlug(slug?.current, 'product'))")
  })

  it('imports it, and types none of the words out together', () => {
    expect(readFileSync(path.join(STUDIO, 'lib/checks.ts'), 'utf8')).toContain("from '../../web/lib/routes/reserved-slugs'")
    const files = ['lib', 'schemaTypes', 'schemaTypes/objects'].flatMap((folder) => readdirSync(path.join(STUDIO, folder)).filter((name) => name.endsWith('.ts')).map((name) => `${folder}/${name}`))
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) expect(readFileSync(path.join(STUDIO, file), 'utf8'), file).not.toMatch(/['"](checkout|waiver|account)['"]/)
  })
})
