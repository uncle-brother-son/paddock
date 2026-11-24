import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { isLiveHost, LIVE_HOST } from '../site'
import tokens from './figma-tokens.json'
import {
  GRID_OVERLAY_PARAM,
  GRID_OVERLAY_STORAGE_KEY,
  gridOverlayFromAddress,
  gridOverlayFromStorage,
  gridOverlayToStorage,
  isGridOverlayShortcut,
  isTypingTarget,
} from './grid-overlay'
import { paletteVariable } from './token-names'

// Brief W71a, item 3: the grid overlay for test copies. This holds its decisions (the address, the tab's memory,
// the shortcut, a field being typed in) and, by reading the source, that nothing of it can reach the live domain's
// page. The overlay itself is pressed in a real browser by components/layout/GridOverlay.stories.tsx (both hosts,
// both frame widths), and on the built Worker for each brief's report.

const WEB = path.resolve(__dirname, '../..')
const read = (file: string): string => readFileSync(path.join(WEB, file), 'utf8')
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const GATE = 'components/layout/GridOverlay.tsx'
const COLUMNS = 'components/layout/GridOverlayColumns.tsx'
const DECISIONS = 'lib/design/grid-overlay.ts'

describe('the grid overlay: on or off (W71a, item 3)', () => {
  it('?grid=1 in the address switches it on, ?grid=0 off, and anything else leaves the tab\'s setting alone', () => {
    expect(GRID_OVERLAY_PARAM).toBe('grid')
    expect(gridOverlayFromAddress('?grid=1')).toBe(true)
    expect(gridOverlayFromAddress('?ref=email&grid=1')).toBe(true)
    expect(gridOverlayFromAddress('?grid=0')).toBe(false)
    // The overlay starts from the address, and from the tab's memory when the address says nothing.
    expect(withoutComments(read(COLUMNS))).toMatch(/useState\(\(\) => gridOverlayFromAddress\(window\.location\.search\) \?\? remembered\(\)\)/)
    for (const search of ['', '?', '?grid', '?grid=', '?grid=true', '?grid=2', '?grid=11', '?grids=1', '?Grid=1', '?page=1']) {
      expect(gridOverlayFromAddress(search), search).toBeNull()
    }
  })

  it('the tab remembers "1" as on; nothing stored, or anything else, is off', () => {
    expect(gridOverlayToStorage(true)).toBe('1')
    expect(gridOverlayToStorage(false)).toBe('0')
    expect(gridOverlayFromStorage('1')).toBe(true)
    for (const stored of ['0', '', 'true', 'on', null, undefined]) expect(gridOverlayFromStorage(stored), String(stored)).toBe(false)
    expect(GRID_OVERLAY_STORAGE_KEY).toBe('paddock-grid-overlay')
  })

  const press = (over: Partial<Parameters<typeof isGridOverlayShortcut>[0]> = {}) => ({ key: 'g', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...over })

  it('the shortcut is Ctrl + G and nothing else', () => {
    expect(isGridOverlayShortcut(press())).toBe(true)
    expect(isGridOverlayShortcut(press({ key: 'G' }))).toBe(true)
    expect(isGridOverlayShortcut(press({ ctrlKey: false })), 'a plain g').toBe(false)
    expect(isGridOverlayShortcut(press({ ctrlKey: false, metaKey: true })), 'Cmd + G').toBe(false)
    expect(isGridOverlayShortcut(press({ metaKey: true })), 'Ctrl + Cmd + G').toBe(false)
    expect(isGridOverlayShortcut(press({ altKey: true })), 'Ctrl + Alt + G').toBe(false)
    expect(isGridOverlayShortcut(press({ shiftKey: true })), 'Ctrl + Shift + G').toBe(false)
    expect(isGridOverlayShortcut(press({ key: 'h' })), 'Ctrl + H').toBe(false)
    expect(isGridOverlayShortcut(press({ repeat: true })), 'the key held down').toBe(false)
  })

  it('the shortcut does nothing while typing in a field', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) expect(isTypingTarget({ tagName }), tagName).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    for (const tagName of ['BODY', 'BUTTON', 'A', 'DIV']) expect(isTypingTarget({ tagName, isContentEditable: false }), tagName).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget({})).toBe(false)
    expect(withoutComments(read(COLUMNS))).toMatch(/if \(!isGridOverlayShortcut\(event\) \|\| isTypingTarget\(event\.target as HTMLElement \| null\)\) return/)
  })
})

describe('the grid overlay never exists on the live domain (W71a, item 3)', () => {
  const gate = withoutComments(read(GATE))

  it('the gate\'s check is the live-host check: the live domain has no overlay, every test copy has', () => {
    expect(gate).toMatch(/\(\) => !isLiveHost\(host \?\? window\.location\.host\),/)
    expect(gate).toMatch(/if \(!testCopy\) return null\s+return \(\s+<Suspense fallback=\{null\}>\s+<GridOverlayColumns \/>\s+<\/Suspense>\s+\)/)
    for (const host of [LIVE_HOST, `${LIVE_HOST}:443`, 'THEPADDOCKWELLNESS.CO.UK']) expect(isLiveHost(host), host).toBe(true)
    for (const host of ['paddock.paddock-55d.workers.dev', 'abc123-paddock.paddock-55d.workers.dev', `www.${LIVE_HOST}`, 'localhost:3000', '127.0.0.1:8787']) {
      expect(isLiveHost(host), host).toBe(false)
    }
  })

  it('the server renders nothing of it, so the HTML is the same on every host', () => {
    expect(gate).toMatch(/useSyncExternalStore\(\s*subscribeToNothing,\s*\(\) => !isLiveHost\(host \?\? window\.location\.host\),\s*\(\) => false,\s*\)/)
    expect(gate).toMatch(/const GridOverlayColumns = lazy\(\(\) => import\('\.\/GridOverlayColumns'\)\)/)
  })

  it('the gate holds nothing of the overlay: it reaches it only through a file fetched when it is rendered', () => {
    const imports = [...gate.matchAll(/^import .* from '([^']+)'$/gm)].map((match) => match[1])
    expect(imports.sort()).toEqual(['@/lib/site', 'react'])
    expect(gate.match(/GridOverlayColumns'/g)).toHaveLength(1)
    expect(gate).not.toMatch(/grid-overlay'|sessionStorage|keydown|data-grid-overlay/)
  })

  it('the root layout renders the gate, never the overlay itself', () => {
    const layout = read('app/layout.tsx')
    expect(layout).toMatch(/import \{ GridOverlay \} from "@\/components\/layout\/GridOverlay";/)
    expect(layout.match(/<GridOverlay \/>/g)).toHaveLength(1)
    expect(layout).not.toMatch(/GridOverlayColumns|lib\/design\/grid-overlay/)
  })

  it('no other file the site ships reaches the overlay or its decisions', () => {
    const shipped = (dir: string): string[] =>
      readdirSync(path.join(WEB, dir)).flatMap((name) => {
        const file = `${dir}/${name}`
        if (statSync(path.join(WEB, file)).isDirectory()) return shipped(file)
        return /\.(ts|tsx)$/.test(name) && !/\.(stories|test)\.tsx?$/.test(name) ? [file] : []
      })
    const reaching = ['app', 'components', 'features', 'lib']
      .flatMap(shipped)
      .filter((file) => /GridOverlayColumns|design\/grid-overlay|\.\/grid-overlay/.test(withoutComments(read(file))))
    expect(reaching.sort()).toEqual([GATE, COLUMNS].sort())
  })
})

describe('the grid overlay is drawn from the tokens, out of everyone\'s way (W71a, item 3)', () => {
  const columns = withoutComments(read(COLUMNS))

  it('fixed over the whole window, taking no clicks, hidden from screen readers', () => {
    expect(columns).toMatch(/<Grid aria-hidden="true" data-grid-overlay="" className="pointer-events-none fixed inset-0 z-40">/)
  })

  it('it is the page grid itself, with as many columns as the grid tokens give the window', () => {
    expect(columns).toMatch(/const columns = useGridColumns\(\)/)
    expect(columns).toMatch(/Array\.from\(\{ length: columns \}/)
    expect(read('components/layout/useGridColumns.ts')).toMatch(/getComputedStyle\(document\.documentElement\)\.getPropertyValue\('--grid-columns'\)/)
  })

  it('its two colours are Figma palette colours, see-through ones, and no colour is typed in', () => {
    const colours = [...columns.matchAll(/\b(?:bg|border)-([a-z]+(?:-[a-z]+)*-\d+)\b/g)].map((match) => `--color-${match[1]}`)
    expect(colours.sort()).toEqual(['--color-mustard-65', '--color-mustard-8'])
    const palette = Object.keys(tokens.palette).map(paletteVariable)
    for (const colour of colours) expect(palette, colour).toContain(colour)
    expect(columns).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl|oklch|opacity/i)
  })

  it('remembering is wrapped: a browser that refuses sessionStorage still gets the overlay', () => {
    expect(columns.match(/try \{\s*(return gridOverlayFromStorage\(window\.sessionStorage\.getItem|window\.sessionStorage\.setItem)\(GRID_OVERLAY_STORAGE_KEY/g)).toHaveLength(2)
    expect(columns.match(/sessionStorage/g)).toHaveLength(2)
    // Whatever the overlay is switched to is written down, so the next page in the tab starts the same way.
    expect(columns).toMatch(/useEffect\(\(\) => \{\s+remember\(on\)\s+\}, \[on\]\)/)
    expect(read(DECISIONS)).not.toMatch(/window|document/)
  })
})
