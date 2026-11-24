import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import tokens from './figma-tokens.json'
import { childNamed, readGlobalsCss, remToPx, resolveValue, ruleNamed, rulesNamed } from './read-stylesheet'
import {
  fontSizeVariable,
  paletteVariable,
  radiusVariable,
  spacingVariable,
  TEXT_STYLE_CLASSES,
  textStyleClass,
  THEME_MODES,
  themeVariable,
} from './token-names'

// Brief W71, items 2-4: app/globals.css holds the Figma variables and text styles exactly. figma-tokens.json is the
// lead's read of the Figma "Website" file (24 Nov 2026); this walks it and fails when the stylesheet has no such
// token, a different value, or a colour or text style that Figma doesn't have.

const WEB = path.resolve(__dirname, '../..')
const css = readGlobalsCss()
const theme = ruleNamed(css, '@theme static').declarations
const base = childNamed(css, '@layer base')
const root = childNamed(base, ':root').declarations
const DESKTOP = '@media (width >= 48rem)'
const desktopRoot = childNamed(childNamed(base, DESKTOP), ':root').declarations

const measurements = tokens.measurements as Record<string, unknown>
const themeNames = Object.keys(tokens.theme)
const palette = tokens.palette as Record<string, string>

describe('colours: the palette and the four theme modes are Figma\'s (W71, item 2)', () => {
  it('each palette colour is a token with Figma\'s value', () => {
    for (const [name, value] of Object.entries(palette)) expect(theme[paletteVariable(name)], name).toBe(value)
    expect(Object.keys(palette)).toHaveLength(28)
  })

  it('the palette names follow Figma: 100% colours by name, the others with their opacity', () => {
    expect(paletteVariable('100/Sand Light')).toBe('--color-sand-light')
    expect(paletteVariable('65/Black')).toBe('--color-black-65')
    expect(paletteVariable('100/Mustard dark')).toBe('--color-mustard-dark')
    expect(paletteVariable('2/Sand light')).toBe('--color-sand-light-2')
    expect(themeVariable('Surface/Card Selected')).toBe('--color-surface-card-selected')
    expect(themeVariable('Object/Dark Dark Shade')).toBe('--color-object-dark-dark-shade')
  })

  it('no colour exists that Figma doesn\'t have, and the starter colours are gone', () => {
    const colours = Object.keys(theme).filter((name) => name.startsWith('--color-') && name !== '--color-*')
    expect(colours.sort()).toEqual([...Object.keys(palette).map(paletteVariable), ...themeNames.map(themeVariable)].sort())
    expect(theme['--color-*']).toBe('initial')
    expect(readFileSync(path.join(WEB, 'app/globals.css'), 'utf8')).not.toMatch(/--color-(background|foreground)/)
  })

  // W73: every mode but Light is also what the see-through header takes while the page's first section has it
  // (before the page's script has run; components/frame/Header.tsx). Light needs none: it is <html>'s own.
  const themeSelector = (mode: string): string =>
    mode === 'light' ? '[data-theme="light"]' : `[data-theme="${mode}"], :root:has(#main > [data-theme="${mode}"]:first-child) [data-header-theme="page"]`

  it('the modes are Light, Dark, Fjord and Mud', () => {
    expect(tokens.themeModes.map((mode) => mode.toLowerCase())).toEqual([...THEME_MODES])
  })

  it.each(tokens.themeModes)('%s: every theme colour points at the palette colour Figma gives it', (mode) => {
    const declared = ruleNamed(css, themeSelector(mode.toLowerCase())).declarations
    for (const [name, byMode] of Object.entries(tokens.theme)) {
      expect(declared[themeVariable(name)], `${name} in ${mode}`).toBe(`var(${paletteVariable((byMode as Record<string, string>)[mode]!)})`)
    }
    expect(Object.keys(declared).sort()).toEqual(themeNames.map(themeVariable).sort())
  })

  it('W73 (WQ12): the focus ring is 2px of Text/Primary with a 2px gap, for the keyboard only', () => {
    const ring = ruleNamed(css, ':where(a, button, summary, [tabindex]:not([tabindex="-1"])):focus-visible').declarations
    expect(ring).toEqual({ outline: 'var(--spacing-2) solid var(--color-text-primary)', 'outline-offset': 'var(--spacing-2)' })
    expect(theme['--spacing-2']).toBe('2px')
    // No ring for a mouse or a finger: nothing styles plain `:focus`.
    expect(readFileSync(path.join(WEB, 'app/globals.css'), 'utf8')).not.toMatch(/:focus(?!-visible)/)
  })

  it('W73 (Wayne): every button, and everything with the role of one, shows the hand', () => {
    expect(ruleNamed(css, ':where(button, [role="button"])').declarations).toEqual({ cursor: 'pointer' })
  })

  it("W73: the Overlay is Object/Light Shade over a 12px blur (Figma's 24), with the texture filter where Chromium can run it", () => {
    const supports = '@supports (backdrop-filter: blur(12px) url(#overlay-texture)) and (-webkit-app-region: drag)'
    const shade = ruleNamed(css, '@utility overlay-shade')
    expect(shade.declarations).toEqual({
      'background-color': 'var(--color-object-light-shade)',
      '-webkit-backdrop-filter': 'blur(12px)',
      'backdrop-filter': 'blur(12px)',
    })
    expect(childNamed(shade, supports).declarations).toEqual({ 'backdrop-filter': 'blur(12px) url(#overlay-texture)' })
    // Everywhere else: fine grain, blended so it adds no colour, taking no clicks; never both at once.
    const grain = ruleNamed(css, '@utility overlay-grain')
    expect(grain.declarations['mix-blend-mode']).toBe('overlay')
    expect(grain.declarations['pointer-events']).toBe('none')
    expect(grain.declarations['background-image']).toMatch(/^url\("data:image\/svg\+xml,.*fractalNoise.*baseFrequency='0\.5'.* 0\.05'.*"\)$/)
    expect(childNamed(grain, supports).declarations).toEqual({ display: 'none' })
  })

  it('with no mode set, the theme colours are Light', () => {
    const light = ruleNamed(css, '[data-theme="light"]').declarations
    for (const name of themeNames) expect(theme[themeVariable(name)], name).toBe(light[themeVariable(name)])
  })

  it('the page takes Surface/Primary and Text/Primary, and a section that sets a mode takes that mode\'s text colour', () => {
    const body = ruleNamed(css, 'body').declarations
    expect(body['background-color']).toBe('var(--color-surface-primary)')
    expect(body.color).toBe('var(--color-text-primary)')
    expect(ruleNamed(css, '[data-theme]').declarations.color).toBe('var(--color-text-primary)')
    expect(readFileSync(path.join(WEB, 'app/layout.tsx'), 'utf8')).toMatch(/<html lang="en-GB" data-theme="light"/)
  })
})

describe('type: sizes, weights, letter spacing and the twelve text styles are Figma\'s (W71, item 3)', () => {
  const sizes = Object.entries(measurements).filter(([name]) => name.startsWith('Font/Size/'))

  it('each font size is a token; 28 and 24 have a Mobile and a Desktop value', () => {
    expect(sizes).toHaveLength(7)
    for (const [name, value] of sizes) {
      const variable = fontSizeVariable(name)
      if (typeof value === 'number') {
        expect(remToPx(theme[variable]!), name).toBe(value)
        expect(desktopRoot[variable], `${name} from 768px`).toBeUndefined()
        continue
      }
      const { Desktop, Mobile } = value as { Desktop: number; Mobile: number }
      const size = name.split('/').at(-1)
      expect(remToPx(root[`--font-size-${size}-mobile`]!), `${name} Mobile`).toBe(Mobile)
      expect(remToPx(root[`--font-size-${size}-desktop`]!), `${name} Desktop`).toBe(Desktop)
      expect(theme[variable], `${name} below 768px`).toBe(`var(--font-size-${size}-mobile)`)
      expect(desktopRoot[variable], `${name} from 768px`).toBe(`var(--font-size-${size}-desktop)`)
    }
  })

  it('the Desktop values start at 768px', () => {
    expect(rulesNamed(css, DESKTOP)).toHaveLength(1)
    expect(remToPx('48rem')).toBe(768)
    expect(tokens.breakpointsNote).toContain('below 768px = Mobile values; 768px and up = Desktop values')
  })

  it('no font size, weight or letter spacing exists that Figma doesn\'t have', () => {
    const named = (prefix: string): string[] => Object.keys(theme).filter((name) => name.startsWith(prefix) && !name.endsWith('*')).sort()
    expect(named('--text-')).toEqual(sizes.map(([name]) => fontSizeVariable(name)).sort())
    expect(named('--font-weight-')).toEqual(['--font-weight-medium', '--font-weight-regular'])
    expect(named('--tracking-')).toEqual(['--tracking-headers', '--tracking-label'])
    expect(theme['--font-weight-regular']).toBe(/\((\d+)\)/.exec(measurements['Font/Weight/Regular'] as string)![1])
    expect(theme['--font-weight-medium']).toBe(/\((\d+)\)/.exec(measurements['Font/Weight/Medium'] as string)![1])
    expect(`${theme['--tracking-headers']} letter spacing`).toBe(measurements['Font/Leading/Headers'])
    expect(`${theme['--tracking-label']} letter spacing`).toBe(measurements['Font/Leading/Label'])
  })

  it.each(tokens.textStyles)('$name has Figma\'s family, weight, size, line height, letter spacing, case, underline and vertical trim', (style) => {
    const figma = style as { name: string; family: string; weight: number; size: string; lineHeight: string; letterSpacing?: string; case?: string; decoration?: string; verticalTrim: string }
    const declared = ruleNamed(css, `@utility ${textStyleClass(figma.name)}`).declarations
    // W71a, item 1. Figma's "Vertical trim: Cap height to baseline" is `text-box: trim-both cap alphabetic`; a style
    // without it has no text-box at all.
    expect(['cap-height', 'none'], `${figma.name}'s verticalTrim in figma-tokens.json`).toContain(figma.verticalTrim)
    const trimmed = figma.verticalTrim === 'cap-height'
    expect(declared['text-box'], `${figma.name}: vertical trim ${figma.verticalTrim}`).toBe(trimmed ? 'trim-both cap alphabetic' : undefined)

    expect(declared['font-family']).toBe(figma.family === 'Primary' ? 'var(--font-primary)' : 'var(--font-secondary)')
    expect(Number(resolveValue(declared['font-weight']!, theme))).toBe(figma.weight)
    expect(declared['font-size']).toBe(`var(${fontSizeVariable(figma.size)})`)
    // Figma's "auto" is the font's own line height (the JSON's lineHeightNote); 140% is 1.4 times the font size.
    expect(declared['line-height']).toBe(figma.lineHeight === 'auto' ? 'normal' : String(Number.parseFloat(figma.lineHeight) / 100))
    expect(resolveValue(declared['letter-spacing']!, theme)).toBe(figma.letterSpacing && figma.letterSpacing !== '0' ? figma.letterSpacing : '0')
    expect(declared['text-transform']).toBe(figma.case ?? 'none')
    expect(declared['text-decoration-line']).toBe(figma.decoration)
    expect(Object.keys(declared).sort()).toEqual(
      [
        'font-family',
        'font-size',
        'font-weight',
        'letter-spacing',
        'line-height',
        'text-transform',
        ...(figma.decoration ? ['text-decoration-line'] : []),
        ...(trimmed ? ['text-box'] : []),
      ].sort(),
    )
  })

  it('every text style has the vertical trim but H3, and nothing else in the stylesheet trims a text box (W71a, item 1)', () => {
    // The lead's read of Figma, 24 Nov 2026: "Vertical trim: Cap height to baseline" on every text style except H3.
    const untrimmed = tokens.textStyles.filter((style) => style.verticalTrim !== 'cap-height').map((style) => style.name)
    expect(untrimmed).toEqual(['H3'])
    expect(tokens.textStyles.find((style) => style.name === 'H3')?.verticalTrim).toBe('none')
    // A rule outside the text styles (say `h3 { text-box-trim: ... }`) would trim a style the JSON says is untrimmed.
    const source = readFileSync(path.join(WEB, 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(source.match(/text-box[\w-]*\s*:/g)).toHaveLength(tokens.textStyles.length - untrimmed.length)
  })

  it('there is one utility per Figma text style and no other', () => {
    const names = tokens.textStyles.map((style) => style.name)
    expect(names).toHaveLength(12)
    expect(TEXT_STYLE_CLASSES).toEqual(Object.fromEntries(names.map((name) => [name, textStyleClass(name)])))
    const utilities = css.rules.map((rule) => rule.header).filter((header) => header.startsWith('@utility text-'))
    expect(utilities.sort()).toEqual(names.map((name) => `@utility ${textStyleClass(name)}`).sort())
  })
})

describe('spacing, corners and the grid are Figma\'s (W71, item 3)', () => {
  it('the spacing scale is Figma\'s, named by its pixel value, with nothing between the steps', () => {
    const scale = measurements['Spacing/General'] as number[]
    for (const value of scale) expect(theme[spacingVariable(value)], String(value)).toBe(`${value}px`)
    const declared = Object.keys(theme).filter((name) => /^--spacing-\d+$/.test(name))
    // Zero is not on Figma's scale; it is there so p-0 and inset-0 exist.
    expect(declared.sort()).toEqual([0, ...scale].map(spacingVariable).sort())
    expect(theme['--spacing-0']).toBe('0px')
    expect(theme['--spacing']).toBe('initial')
  })

  it('the two corners', () => {
    for (const name of ['Spacing/Corners/S', 'Spacing/Corners/M']) expect(theme[radiusVariable(name)], name).toBe(`${measurements[name] as number}px`)
    expect(Object.keys(theme).filter((name) => name.startsWith('--radius-') && !name.endsWith('*')).sort()).toEqual(['--radius-m', '--radius-s'])
  })

  it.each(['Mobile', 'Desktop'] as const)('%s grid: columns, margin and gutter', (mode) => {
    const of = (name: string): number => (measurements[`Spacing/Grid/${name}`] as Record<string, number>)[mode]!
    const suffix = mode.toLowerCase()
    expect(root[`--grid-columns-${suffix}`]).toBe(String(of('Columns')))
    expect(root[`--grid-margin-${suffix}`]).toBe(`${of('Margin')}px`)
    expect(root[`--grid-gutter-${suffix}`]).toBe(`${of('Gutter')}px`)
    // Figma's own column width follows from the frame, the margins and the gutters: 51px at 1440, 53px at 390.
    expect((of('Width') - 2 * of('Margin') - (of('Columns') - 1) * of('Gutter')) / of('Columns')).toBe(of('Column'))
  })

  it('the grid is the Mobile one below 768px and the Desktop one from 768px', () => {
    for (const part of ['columns', 'margin', 'gutter']) {
      expect(root[`--grid-${part}`]).toBe(`var(--grid-${part}-mobile)`)
      expect(desktopRoot[`--grid-${part}`]).toBe(`var(--grid-${part}-desktop)`)
    }
  })

  it('page-grid lays out equal columns with the gutter between them and the margin each side', () => {
    expect(ruleNamed(css, '@utility page-grid').declarations).toEqual({
      display: 'grid',
      'grid-template-columns': 'repeat(var(--grid-columns), minmax(0, 1fr))',
      'column-gap': 'var(--grid-gutter)',
      'padding-inline': 'var(--grid-margin)',
    })
    expect(readFileSync(path.join(WEB, 'components/layout/Grid.tsx'), 'utf8')).toContain("'page-grid'")
  })
})

describe('fonts: the three licensed woff2 files, swapped in over a size-matched fallback (W71, item 4)', () => {
  const source = readFileSync(path.join(WEB, 'app/fonts.ts'), 'utf8')
  const files = Object.values(tokens.fonts)
    .map((value) => /^web\/app\/(fonts\/\S+\.woff2) /.exec(value)?.[1])
    .filter((file): file is string => Boolean(file))

  it('each face Figma uses is loaded from app/fonts, and nothing else is there or in public/fonts', () => {
    expect(files).toHaveLength(3)
    for (const file of files) {
      expect(existsSync(path.join(WEB, 'app', file)), file).toBe(true)
      expect(source).toContain(`'./${file}'`)
    }
    // W72 (WQ27): beside the code that loads them, so no second copy is served from public/; the unused .woff are gone.
    expect(readdirSync(path.join(WEB, 'app/fonts')).filter((name) => !name.startsWith('.')).sort()).toEqual(files.map((file) => path.basename(file)).sort())
    expect(existsSync(path.join(WEB, 'public/fonts'))).toBe(false)
    expect(source.match(/path: '[^']+'/g)).toHaveLength(3)
    expect(source).not.toMatch(/\.woff'/)
  })

  it('swap, preload and a matched fallback on both families; Sectra is Primary and America is Secondary', () => {
    expect(source.match(/display: 'swap'/g)).toHaveLength(2)
    expect(source.match(/preload: true/g)).toHaveLength(2)
    expect(source).toMatch(/GT-Sectra-Fine-Regular\.woff2', weight: '400'[^]*?variable: '--font-primary'[^]*?adjustFontFallback: 'Times New Roman'/)
    expect(source).toMatch(/GT-America-Standard-Regular\.woff2', weight: '400'[^]*?GT-America-Standard-Medium\.woff2', weight: '500'[^]*?variable: '--font-secondary'[^]*?adjustFontFallback: 'Arial'/)
    expect(measurements['Font/Family/Primary']).toBe('GT Sectra Fine')
    expect(measurements['Font/Family/Secondary']).toBe('GT America')
  })

  it('body text is Secondary', () => {
    expect(ruleNamed(css, 'body').declarations['font-family']).toBe('var(--font-secondary)')
  })
})
