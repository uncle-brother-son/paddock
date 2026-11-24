import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DURATION_LONG } from '@/lib/motion/tokens'

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

describe('the intro in the page and the stylesheet', () => {
  const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8')

  it('the layout draws it first in the page, the panel straight before its script', () => {
    const layout = read('app/layout.tsx')
    expect(layout).toMatch(/<body className="flex min-h-dvh flex-col">\s*\{\/\*[^*]*\*\/\}\s*<Intro \/>/)
    expect(read('components/frame/Intro.tsx')).toMatch(/<IntroPanel \/>\s*<script dangerouslySetInnerHTML=\{\{ __html: INTRO_SCRIPT \}\} \/>/)
  })

  it('it is decoration: hidden from screen readers, and not there at all until it is started', () => {
    const panel = read('components/frame/Intro.tsx')
    expect(panel).toMatch(/aria-hidden="true"\s+data-frame-intro=""/)
    const css = read('app/globals.css')
    expect(css).toMatch(/@utility intro \{\s*display: none;\s*&\[data-intro="play"\] \{\s*display: flex;/)
  })

  it('three transitions, each the long duration with the smooth curve, back to back: the logo, the rise and the location, the mask', () => {
    const css = read('app/globals.css')
    const long = 'var(--duration-long)'
    expect(css).toContain(`animation: intro-fade ${long} var(--ease-smooth) both;`)
    expect(css).toContain(`animation: intro-rise ${long} var(--ease-smooth) ${long} both;`)
    expect(css).toContain(`animation: intro-fade ${long} var(--ease-smooth) ${long} both;`)
    expect(css).toContain(`animation: intro-mask ${long} var(--ease-smooth) calc(${long} * 2) both;`)
    // 640 ms each: 1,920 ms in all.
    expect(DURATION_LONG * 3).toBeCloseTo(1.92)
  })
})
