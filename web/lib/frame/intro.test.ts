import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { transformSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InlineScript } from '@/components/ui/InlineScript'
import { DURATION_LONG, INTRO_PAUSE } from '@/lib/motion/tokens'

import { INTRO_SCRIPT, INTRO_SEEN_KEY, startIntro } from './intro'

// Brief W73b, item 4: the intro plays once in a browser session, never with reduced motion on, and a key or a click
// ends it at once. The page is only ever stood in for here; the intro itself is watched in a browser
// (components/frame/Intro.stories.tsx).

type Listener = (event: { target: unknown }) => void

/** A stand-in for the page: the intro's element, the window's listeners, and a session's storage. */
function page() {
  const attributes = new Map<string, string>()
  const onIntro = new Map<string, Listener>()
  const onWindow = new Map<string, Listener>()
  const intro = {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    addEventListener: (type: string, listener: Listener) => void onIntro.set(type, listener),
    removeEventListener: (type: string) => void onIntro.delete(type),
  }
  const stored = new Map<string, string>()
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) }
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: Listener) => void onWindow.set(type, listener),
    removeEventListener: (type: string) => void onWindow.delete(type),
  })
  return { intro, element: intro as unknown as HTMLElement, attributes, onIntro, onWindow, stored, storage }
}

afterEach(() => vi.unstubAllGlobals())

describe('the intro starts', () => {
  it('on a first visit, and the session remembers it', () => {
    const { element, attributes, stored, storage, onWindow, onIntro } = page()
    expect(startIntro(element, false, storage)).toBe(true)
    expect(attributes.get('data-intro')).toBe('play')
    expect(stored.get(INTRO_SEEN_KEY)).toBe('shown')
    expect([...onWindow.keys()].sort()).toEqual(['keydown', 'pointerdown'])
    expect([...onIntro.keys()]).toEqual(['animationend'])
  })

  it('never twice in a session, on whichever page comes next', () => {
    const { element, attributes, storage } = page()
    expect(startIntro(element, false, storage)).toBe(true)
    attributes.clear()
    expect(startIntro(element, false, storage)).toBe(false)
    expect(attributes.has('data-intro')).toBe(false)
  })

  it('never with reduced motion on, and then the session is not told it was seen', () => {
    const { element, attributes, stored, storage, onWindow } = page()
    expect(startIntro(element, true, storage)).toBe(false)
    expect(attributes.size).toBe(0)
    expect(stored.size).toBe(0)
    expect(onWindow.size).toBe(0)
  })

  it('once for each page load when storage is refused, or there is none', () => {
    const { element, attributes } = page()
    const refusing = {
      getItem: (): string | null => {
        throw new Error('SecurityError')
      },
      setItem: () => undefined,
    }
    expect(startIntro(element, false, refusing)).toBe(true)
    expect(startIntro(element, false, refusing)).toBe(true)
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    attributes.clear()
    expect(startIntro(element, false, full)).toBe(true)
    expect(attributes.get('data-intro')).toBe('play')
    expect(startIntro(element, false, null)).toBe(true)
  })
})

describe('the intro ends', () => {
  it.each(['keydown', 'pointerdown'])('at once on a %s, and stops listening', (type) => {
    const { element, attributes, onWindow, onIntro } = page()
    startIntro(element, false, null)
    onWindow.get(type)!({ target: null })
    expect(attributes.get('data-intro')).toBe('done')
    expect(onWindow.size).toBe(0)
    expect(onIntro.size).toBe(0)
  })

  it("when the panel's own transition (the mask) has run, not when the logo's or the location's has", () => {
    const { intro, element, attributes, onIntro } = page()
    startIntro(element, false, null)
    onIntro.get('animationend')!({ target: { the: 'logo' } })
    expect(attributes.get('data-intro')).toBe('play')
    onIntro.get('animationend')!({ target: intro })
    expect(attributes.get('data-intro')).toBe('done')
  })
})

describe('the script in the page', () => {
  /** Runs INTRO_SCRIPT as a page would, with stand-ins for what it reaches for. */
  const run = (reducedMotion: boolean, sessionStorage: () => unknown) => {
    const { intro, attributes, stored, storage } = page()
    const fakeWindow = {
      ...(globalThis as unknown as { window: object }).window,
      matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion }),
      get sessionStorage() {
        return sessionStorage() ?? storage
      },
    }
    new Function('window', 'document', INTRO_SCRIPT)(fakeWindow, { currentScript: { previousElementSibling: intro } })
    return { attributes, stored }
  }

  it('is startIntro, whole, on the element just before it, with the visitor\'s setting and the session\'s storage', () => {
    const { attributes, stored } = run(false, () => null)
    expect(attributes.get('data-intro')).toBe('play')
    expect(stored.get(INTRO_SEEN_KEY)).toBe('shown')
    expect(run(true, () => null).attributes.size).toBe(0)
  })

  it('plays when even asking for the storage is refused', () => {
    const refused = () => {
      throw new Error('SecurityError')
    }
    expect(run(false, refused).attributes.get('data-intro')).toBe('play')
  })

  it('uses nothing from outside itself: no import, no name of this module', () => {
    expect(INTRO_SCRIPT).not.toMatch(/\bimport\b|\brequire\b|INTRO_SEEN_KEY|__vite/)
    expect(INTRO_SCRIPT).toContain(INTRO_SEEN_KEY)
  })
})

// Found on the deployed site, 25 Nov 2026: the intro never played and every page logged "__name is not defined".
// Cloudflare's build (OpenNext) bundles the Worker with esbuild's keepNames, which wraps every inner function in
// `__name(fn, "name")`, a helper the Worker's bundle has and the page does not. The script was then made from
// `startIntro.toString()`, so it carried those calls into the page. `next build` alone does not do this, and neither
// does this test run, so the build's step is done here by hand.
describe("the script after Cloudflare's build", () => {
  /** lib/frame/intro.ts as a build that keeps function names leaves it: what the module then says the script is. */
  const afterBuild = (minify: boolean): string => {
    const source = readFileSync(path.resolve(__dirname, 'intro.ts'), 'utf8')
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs', keepNames: true, minify })
    const built = { exports: {} as { INTRO_SCRIPT?: string } }
    new Function('module', 'exports', code)(built, built.exports)
    return built.exports.INTRO_SCRIPT ?? ''
  }

  it.each([
    ['as written', false],
    ['made small', true],
  ])('is the same text, letter for letter, when the build keeps function names (%s)', (_, minify) => {
    expect(afterBuild(minify)).toBe(INTRO_SCRIPT)
  })

  it('names no helper of a build: no __name, nor any other', () => {
    expect(INTRO_SCRIPT).not.toContain('__name')
    expect(INTRO_SCRIPT).not.toMatch(/__\w/)
    expect(afterBuild(false)).not.toContain('__name')
    expect(afterBuild(true)).not.toMatch(/__\w/)
  })

  it("is written as text: never made from a function's toString()", () => {
    const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    for (const file of ['lib/frame/intro.ts', 'components/frame/Intro.tsx']) expect(read(file)).not.toMatch(/\.toString\(/)
  })

  it('runs in a page that has nothing but the browser: it starts the intro there', () => {
    for (const minify of [false, true]) {
      const { intro, attributes } = page()
      const fakeWindow = { ...(globalThis as unknown as { window: object }).window, matchMedia: () => ({ matches: false }), sessionStorage: null }
      new Function('window', 'document', afterBuild(minify))(fakeWindow, { currentScript: { previousElementSibling: intro } })
      expect(attributes.get('data-intro')).toBe('play')
    }
  })
})

// Level 3, 25 Nov 2026: with `npm run dev`, React said "Encountered a script tag while rendering React component" at
// the intro's <script>. It says so whenever it makes a script that would run in the browser itself: on a 404, on a
// page that failed, after a failed hydration. InlineScript is Next 16's own answer (its guide "How to prevent flash
// before hydration"): JavaScript from the server, plain text from the browser.
describe('the script tag itself (InlineScript)', () => {
  const drawn = () => renderToStaticMarkup(createElement(InlineScript, { html: INTRO_SCRIPT }))

  it('from the server it is JavaScript, with the script whole and unescaped, so the browser runs it as it reads the page', () => {
    expect(typeof window).toBe('undefined')
    expect(drawn()).toBe(`<script type="text/javascript">${INTRO_SCRIPT}</script>`)
  })

  it('drawn in the browser it is plain text, which no browser runs and React does not warn about', () => {
    vi.stubGlobal('window', {})
    expect(drawn()).toBe(`<script type="text/plain">${INTRO_SCRIPT}</script>`)
  })

  it("is the browser's to decide too (a client component), and React leaves the server's type alone when it takes over", () => {
    const source = readFileSync(path.resolve(__dirname, '../../components/ui/InlineScript.tsx'), 'utf8')
    expect(source.startsWith("'use client'\n")).toBe(true)
    expect(source).toContain("<script type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: html }} />")
  })

  it('is the one place the site writes a <script>: no component draws one of its own, and none uses next/script', () => {
    const web = path.resolve(__dirname, '../..')
    const files = ['app', 'components', 'features'].flatMap((folder) =>
      existsSync(path.join(web, folder)) ? readdirSync(path.join(web, folder), { recursive: true, encoding: 'utf8' }).map((file) => path.join(folder, file)) : [],
    )
    const sources = files.filter((file) => /\.tsx?$/.test(file) && !/\.test\.ts$/.test(file))
    expect(sources.length).toBeGreaterThan(40)
    const text = (file: string) => readFileSync(path.join(web, file), 'utf8')
    expect(sources.filter((file) => /<script[\s>]/.test(text(file)))).toEqual(['components/ui/InlineScript.tsx'])
    expect(sources.filter((file) => /from ['"]next\/script['"]/.test(text(file)))).toEqual([])
  })
})

describe('the intro in the page and the stylesheet', () => {
  const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8')

  it('the layout draws it first in the page, the panel straight before its script', () => {
    const layout = read('app/layout.tsx')
    expect(layout).toMatch(/<body className="flex min-h-dvh flex-col">\s*\{\/\*[^*]*\*\/\}\s*<Intro \/>/)
    expect(read('components/frame/Intro.tsx')).toMatch(/<IntroPanel \/>\s*<InlineScript html=\{INTRO_SCRIPT\} \/>/)
  })

  it('it is decoration: hidden from screen readers, and not there at all until it is started', () => {
    const panel = read('components/frame/Intro.tsx')
    expect(panel).toMatch(/aria-hidden="true"\s+data-frame-intro=""/)
    const css = read('app/globals.css')
    expect(css).toMatch(/@utility intro \{\s*display: none;\s*&\[data-intro="play"\] \{\s*display: flex;/)
  })

  it('three transitions, each the long duration with the smooth curve, with its two pauses (WQ53): a pause, the logo, the rise and the location, a pause, the mask', () => {
    const css = read('app/globals.css')
    const long = 'var(--duration-long)'
    const pause = 'var(--intro-pause)'
    // The logo waits out the first pause; the rise and the location follow the logo at once.
    expect(css).toContain(`animation: intro-fade ${long} var(--ease-smooth) ${pause} both;`)
    expect(css).toContain(`animation: intro-rise ${long} var(--ease-smooth) calc(${pause} + ${long}) both;`)
    expect(css).toContain(`animation: intro-fade ${long} var(--ease-smooth) calc(${pause} + ${long}) both;`)
    // The mask waits out both pauses and the two transitions before it.
    expect(css).toContain(`animation: intro-mask ${long} var(--ease-smooth) calc(${pause} * 2 + ${long} * 2) both;`)
    // 480 + 640 + 640 + 480 + 640: 2,880 ms in all.
    expect([INTRO_PAUSE, DURATION_LONG]).toEqual([0.48, 0.64])
    expect(INTRO_PAUSE * 2 + DURATION_LONG * 3).toBeCloseTo(2.88)
  })

  it('the pauses hold nothing up: the page is whole beneath the panel, and a key or a click still ends it at once', () => {
    // The panel is its own fixed layer over the page (never a wrapper round it), started by attribute alone.
    expect(read('components/frame/Intro.tsx')).toContain('className="intro fixed inset-0 z-30 ')
    expect(INTRO_SCRIPT).toContain("window.addEventListener('keydown',end,true)")
    expect(INTRO_SCRIPT).toContain("window.addEventListener('pointerdown',end,true)")
    // No timer anywhere in the start: the pauses are the animations' own delays, so nothing waits on script.
    expect(INTRO_SCRIPT).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/)
  })
})
