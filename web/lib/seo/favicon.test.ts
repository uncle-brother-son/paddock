import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Brief W78a, item 4 (WQ70): the favicon is the Fence logo, Moss on a transparent background and Sand in dark mode,
// with the fallbacks browsers need. Next serves the three files in app/ by their names (icon.svg, favicon.ico,
// apple-icon.png) and writes their <link>s itself. They are made from the Fence's own drawing by
// briefs/W78a-logs/tools/make-favicon.cjs in the staff app's repo: run it again if the Fence is redrawn.

const WEB = path.resolve(__dirname, '../..')
const text = (file: string) => readFileSync(path.join(WEB, file), 'utf8')
const bytes = (file: string) => readFileSync(path.join(WEB, file))

const css = text('app/globals.css')
const colour = (name: string) => new RegExp(`--color-${name}: (#[0-9a-f]{6});`).exec(css)?.[1] ?? ''

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A PNG's size and colour type (2: RGB, no transparency; 6: RGBA), from its first chunk. */
function png(data: Buffer): { width: number; height: number; colourType: number } | null {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colourType: data.readUInt8(25) }
}

describe('the SVG favicon (app/icon.svg)', () => {
  const icon = text('app/icon.svg')
  const fence = text('components/brand/svg/logos/fence.svg')

  it("is the Fence logo's own drawing, whole, in the middle of a square", () => {
    const drawn = (svg: string) => [...svg.matchAll(/<path d="([^"]+)"/g)].map(([, d]) => d)
    expect(drawn(fence)).toHaveLength(6)
    expect(drawn(icon)).toEqual(drawn(fence))
    // The Fence is 46 by 24: the square is 46 each way, with 11 above the Fence and 11 beneath.
    expect(fence).toContain('viewBox="0 0 46 24"')
    expect(icon).toContain('viewBox="0 -11 46 46"')
  })

  it('is Moss, and Sand in dark mode, by a prefers-color-scheme rule inside the SVG', () => {
    expect([colour('moss'), colour('sand')]).toEqual(['#193028', '#d6d2c2'])
    expect(icon).toContain(`<style>path { fill: ${colour('moss')}; } @media (prefers-color-scheme: dark) { path { fill: ${colour('sand')}; } }</style>`)
    // Nothing else colours it: no fill on a path, no currentColor (a favicon has no text colour to take).
    expect(icon).not.toMatch(/currentColor|fill="/)
  })

  it('has a transparent background: nothing is drawn but the Fence', () => {
    expect(icon.match(/<(?!\/)[a-z]+/g)).toEqual(['<svg', '<style', '<path', '<path', '<path', '<path', '<path', '<path'])
    expect(icon).not.toMatch(/background/)
  })
})

describe('the fallbacks', () => {
  it('app/favicon.ico holds 16, 32 and 48px PNGs with transparency (it is not Next\'s default icon)', () => {
    const ico = bytes('app/favicon.ico')
    // An icon file: reserved 0, type 1, then how many pictures.
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3])
    const pictures = [0, 1, 2].map((index) => {
      const entry = 6 + 16 * index
      const [length, offset] = [ico.readUInt32LE(entry + 8), ico.readUInt32LE(entry + 12)]
      return { said: ico.readUInt8(entry), ...png(ico.subarray(offset, offset + length)) }
    })
    expect(pictures).toEqual([16, 32, 48].map((size) => ({ said: size, width: size, height: size, colourType: 6 })))
  })

  it("app/apple-icon.png is 180px with no transparency (an iPhone's home screen would fill it with black): Moss on Sand Light", () => {
    expect(png(bytes('app/apple-icon.png'))).toEqual({ width: 180, height: 180, colourType: 2 })
    expect(colour('sand-light')).toBe('#f1eee3')
  })

  it('these three are the only icons in app/', () => {
    const icons = readdirSync(path.join(WEB, 'app')).filter((name) => /^(favicon|icon|apple-icon)\d*\./.test(name)).sort()
    expect(icons).toEqual(['apple-icon.png', 'favicon.ico', 'icon.svg'])
  })
})
