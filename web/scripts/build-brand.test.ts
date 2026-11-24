import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildBrand, GROUPS, ID_TOKEN, readArt } from './build-brand.mjs'

// Brief W73, item 1: the logos, icons and payment marks are made into data files by scripts/build-brand.mjs from
// the SVG files in components/brand/svg/.

const WEB = path.resolve(__dirname, '..')
const namesIn = (folder: string) =>
  readdirSync(path.join(WEB, 'components/brand/svg', folder))
    .filter((file) => file.endsWith('.svg'))
    .map((file) => file.slice(0, -4))
    .sort()

describe('the brand data files', () => {
  it('are what the script makes from the SVG files today (npm run brand:build)', () => {
    const made = buildBrand(WEB) as Record<string, string>
    expect(Object.keys(made).sort()).toEqual(['components/brand/art/icons.ts', 'components/brand/art/logos.ts', 'components/brand/art/payment.ts'])
    for (const [file, text] of Object.entries(made)) expect(readFileSync(path.join(WEB, file), 'utf8'), file).toBe(text)
  })

  it("the icons are Figma's 16", () => {
    expect(namesIn('icons')).toEqual(
      ['arrow', 'audio-off', 'audio-on', 'bullet', 'burger', 'burger-close', 'chevron', 'close', 'info', 'minus', 'pause', 'play', 'plus', 'quantity', 'search', 'tick'].sort(),
    )
  })

  it('the logos are the Logo page\'s seven', () => {
    expect(namesIn('logos')).toEqual(['fence', 'house-illustration', 'logo-hover-extended', 'logo-hover-logo', 'logo-hover-static', 'logo-original', 'wordmark'])
  })

  it('the payment marks are the five of WQ31: no PayPal, Discover or Diners', () => {
    expect(namesIn('payment')).toEqual(['amex', 'apple-pay', 'google-pay', 'mastercard', 'visa'])
  })

  it('an icon or a logo has no colour of its own; a payment mark keeps its brand\'s', () => {
    const made = buildBrand(WEB) as Record<string, string>
    for (const file of ['components/brand/art/icons.ts', 'components/brand/art/logos.ts']) {
      const outsideMasks = made[file]!.replace(/<mask\b[\s\S]*?<\/mask>/g, '')
      const colours = new Set([...outsideMasks.matchAll(/(?:fill|stroke)=\\"([^"\\]*)\\"/g)].map(([, colour]) => colour))
      expect([...colours].sort(), file).toEqual(['currentColor'])
    }
    expect(made['components/brand/art/payment.ts']).toMatch(/fill=\\"#[0-9A-Fa-f]{6}\\"/)
    expect(GROUPS.map((group: { folder: string; ownColours: boolean }) => [group.folder, group.ownColours])).toEqual([
      ['icons', false],
      ['logos', false],
      ['payment', true],
    ])
  })

  it("Figma's export note is left out of every drawing", () => {
    const made = Object.values(buildBrand(WEB) as Record<string, string>).join('\n')
    expect(made).not.toMatch(/metadata|c2pa|xlink/)
  })
})

describe('one drawing', () => {
  const group = { ownColours: false }
  const svg = (inside: string, root = 'width="9" height="9" viewBox="0 0 9 9"') => `<svg xmlns="http://www.w3.org/2000/svg" ${root} fill="none">${inside}</svg>`

  it('keeps its own box and what is inside it', () => {
    expect(readArt('x.svg', svg('<path d="M0 0H9" fill="currentColor"/>'), group)).toEqual({ width: 9, height: 9, ids: false, body: '<path d="M0 0H9" fill="currentColor"/>' })
  })

  it('every id, and everything that points at one, gets the token in front', () => {
    const art = readArt(
      'logo.svg',
      svg('<use xlink:href="#a_1" fill="currentColor"/>\n<mask id="m_1" fill="black"><rect fill="white"/><use xlink:href="#a_1"/></mask><path d="M0 0" stroke="currentColor" mask="url(#m_1)"/><defs><path id="a_1" d="M0 0"/></defs>'),
      group,
    )
    expect(art.ids).toBe(true)
    expect(art.body).toBe(
      `<use href="#${ID_TOKEN}a_1" fill="currentColor"/><mask id="${ID_TOKEN}m_1" fill="black"><rect fill="white"/><use href="#${ID_TOKEN}a_1"/></mask><path d="M0 0" stroke="currentColor" mask="url(#${ID_TOKEN}m_1)"/><defs><path id="${ID_TOKEN}a_1" d="M0 0"/></defs>`,
    )
  })

  it.each([
    ['a colour of its own', svg('<path d="M0 0" fill="#222222"/>'), /a colour of its own \(#222222\)/],
    ['black outside a mask', svg('<path d="M0 0" fill="black"/>'), /a colour of its own \(black\)/],
    ['a script', svg('<script>alert(1)</script>'), /holds a script/],
    ['an event handler', svg('<path d="M0 0" fill="currentColor" onload="x()"/>'), /holds an event handler/],
    ['an outside address', svg('<use href="https://example.com/x.svg#a"/>'), /holds an outside address/],
    ['a picture', svg('<image href="#a"/>'), /holds a picture or outside content/],
    ['a viewBox that is not its box', svg('<path d="M0 0" fill="currentColor"/>', 'width="9" height="9" viewBox="0 0 24 24"'), /viewBox is not its own box/],
    ['no size', svg('<path d="M0 0" fill="currentColor"/>', 'viewBox="0 0 9 9"'), /no width and height/],
  ])('refuses %s', (_what, text, why) => {
    expect(() => readArt('x.svg', text, group)).toThrow(why)
  })

  it('a payment mark may hold its brand\'s colours', () => {
    expect(readArt('visa.svg', svg('<rect width="9" height="9" fill="#1434CB"/>'), { ownColours: true }).body).toContain('#1434CB')
  })
})
