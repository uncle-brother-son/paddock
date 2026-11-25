import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BOOK_ADDRESS, isBookAddress, linkHref } from '@/lib/sanity/links'

import { keepFocusOnArrival, PAGE_IN, PAGE_OUT, PAGE_TRANSITION, PAGE_TRANSITION_TYPES, takeFocusOnArrival } from './page-transition'

// Brief W73b, item 5 (WQ20, WQ22): the page transition is on every link from page to page inside the site, takes the
// long duration with the smooth curve, and is an instant swap for reduced motion, Back and Forward. The movement
// itself is watched in a browser (components/frame/PageTransition.stories.tsx, and the built site for each report).

const WEB = path.resolve(__dirname, '../..')
const read = (file: string) => readFileSync(path.join(WEB, file), 'utf8')

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(path.join(WEB, dir)).flatMap((name) => {
    const file = `${dir}/${name}`
    if (statSync(path.join(WEB, file)).isDirectory()) return name === 'api' ? [] : sourceFilesUnder(file)
    return /\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name) ? [file] : []
  })
}

describe('every link inside the site carries the page transition', () => {
  const files = ['app', 'components', 'features'].flatMap((folder) => {
    try {
      return sourceFilesUnder(folder)
    } catch {
      return []
    }
  })

  it("SiteLink is the one place that uses Next's <Link>, and it passes the transition's type", () => {
    expect(files.length).toBeGreaterThan(20)
    expect(files.filter((file) => /from ['"]next\/link['"]/.test(read(file)))).toEqual(['components/ui/SiteLink.tsx'])
    expect(read('components/ui/SiteLink.tsx')).toContain("<Link href={href} prefetch={isBuiltAddress(href) ? 'auto' : false} {...(transition ? { transitionTypes: PAGE_TRANSITION_TYPES } : {})} onClick={click} {...tab} {...rest}>")
    expect(read('components/ui/SiteLink.tsx')).toContain('export function SiteLink({ href, newTab = false, transition = true, onClick, children, ...rest }: SiteLinkProps) {')
    expect(PAGE_TRANSITION_TYPES).toEqual([PAGE_TRANSITION])
  })

  // W74c (WQ52): a product's colour swatch goes to that colour's page where this one stands. It is the one link that
  // asks for no transition; the new page comes from its top at once (WQ52 as amended), with focus on the swatch chosen.
  it('only a colour swatch goes without it, and keeps focus on the swatch chosen', () => {
    const without = files.filter((file) => /transition=\{false\}/.test(read(file)))
    expect(without).toEqual(['components/shop/ProductBuy.tsx'])
    const buy = read('components/shop/ProductBuy.tsx')
    expect(buy.match(/transition=\{false\}/g)).toHaveLength(1)
    expect(buy).toMatch(/<SiteLink\s+href=\{colour\.href\}\s+transition=\{false\}\s+onClick=\{\(event\) => \{\s+if \(isPlainClick\(event\)\) keepFocusOnArrival\(colour\.href, CHOSEN_SWATCH\)\s+\}\}\s+data-shop="swatch"/)
    expect(buy).toContain(`const CHOSEN_SWATCH = '[data-shop="swatch"][aria-current="page"]'`)
  })

  it('what a link asks to have focus on arrival is kept for its own page only, and once', () => {
    keepFocusOnArrival('/shop/t-shirt-black', '[data-x]')
    expect(takeFocusOnArrival('/shop/t-shirt-black')).toBe('[data-x]')
    expect(takeFocusOnArrival('/shop/t-shirt-black')).toBeNull()
    // Pressed, but another page arrived (the link was opened elsewhere, or another link was pressed since): dropped.
    keepFocusOnArrival('/shop/t-shirt-black', '[data-x]')
    expect(takeFocusOnArrival('/shop')).toBeNull()
    expect(takeFocusOnArrival('/shop/t-shirt-black')).toBeNull()
  })

  // W73b Level 3 (Wayne, 24 Nov): a link can go to the booking panel. The panel opens over the page the visitor is
  // on, so every link to it asks useFramePanels first, in the one place links are made; the link is followed only
  // while there is no panel to open.
  it('SiteLink is also the one place a link to the booking panel (/book) asks for the panel first', () => {
    expect(BOOK_ADDRESS).toBe('/book')
    expect([isBookAddress('/book'), isBookAddress('/book?date=2026-12-01&type=public'), isBookAddress('/booking'), isBookAddress('/shop'), isBookAddress('/')]).toEqual([true, true, false, false, false])
    const link = read('components/ui/SiteLink.tsx')
    // The caller's own click first (the menu shuts), then the panel; a click meant for a new tab is the browser's.
    expect(link).toMatch(/onClick\?\.\(event\)\s+if \(event\.defaultPrevented \|\| newTab \|\| !isBookAddress\(href\) \|\| !isPlainClick\(event\)\) return\s+if \(panels\.open\('book'\)\) event\.preventDefault\(\)/)
    // Nothing else asks for the booking panel by itself: the header's Book and a hero's button are plain links to it.
    const asking = files.filter((file) => /open\('book'\)/.test(read(file)))
    expect(asking).toEqual(['components/ui/SiteLink.tsx'])
    expect(read('components/frame/Header.tsx')).toContain('<FrameLink href={BOOK_ADDRESS}>')
    expect(linkHref({ destination: 'book', document: null, url: null })).toBe(BOOK_ADDRESS)
  })

  it('nothing moves a visitor to another page by script without it', () => {
    // A router.push or router.replace has to pass { transitionTypes: PAGE_TRANSITION_TYPES }: none exists yet.
    const pushes = files.flatMap((file) => read(file).split('\n').filter((line) => /\brouter\.(push|replace)\(/.test(line) && !line.includes('transitionTypes')))
    expect(pushes).toEqual([])
  })
})

describe('what is animated, and when', () => {
  const component = read('components/frame/PageTransition.tsx')

  it('main and the footer together are the page; the header is outside it and stays', () => {
    const shell = read('components/frame/FrameShell.tsx')
    expect(shell).toMatch(/<Header [\s\S]*?\/>\s*<PageTransition>\s*<main id="main"[\s\S]*<\/main>\s*<Footer [^>]*\/>\s*<\/PageTransition>/)
  })

  it('the page is keyed by the address\'s path, so a new path is one page leaving and another coming', () => {
    expect(component).toContain('<PageTransitionView page={usePathname()}>')
    expect(component).toContain('<ViewTransition key={page} enter={ENTER} exit={EXIT} default="none">')
  })

  it('only a navigation with the type is animated: Back, Forward and anything else swap at once', () => {
    expect(component).toContain("const ENTER = { [PAGE_TRANSITION]: PAGE_IN, default: 'none' }")
    expect(component).toContain("const EXIT = { [PAGE_TRANSITION]: PAGE_OUT, default: 'none' }")
  })

  it('on arriving: the top of the new page (Lenis told), and focus on its h1, or main', () => {
    expect(component).toContain('const top = byHistory.current ? window.scrollY : 0')
    expect(component).toContain('lenis.scrollTo(top, { immediate: true, force: true })')
    expect(component).toContain(";(heading ?? main)?.focus({ preventScroll: true })")
  })

  it('WQ52: a page arrived at by a link that asked to keep focus puts it there instead, still from the top and without scrolling', () => {
    expect(component).toMatch(/lenis\.scrollTo\(top, \{ immediate: true, force: true \}\)[\s\S]*const kept = takeFocusOnArrival\(page\)[\s\S]*keeper\.focus\(\{ preventScroll: true \}\)\s+return\s+\}\s+const heading/)
  })
})

describe('the movement, in the stylesheet', () => {
  const css = read('app/globals.css')

  it('the page going and the page coming each take the long duration with the smooth curve', () => {
    expect(css).toContain(`::view-transition-old(.${PAGE_OUT}) {\n  animation: page-out var(--duration-long) var(--ease-smooth) both;\n}`)
    expect(css).toContain(`::view-transition-new(.${PAGE_IN}) {\n  animation: page-in var(--duration-long) var(--ease-smooth) both;\n}`)
  })

  it('WQ54: the page going drifts down a fifth of the window and does not fade; the page coming is masked in from the top', () => {
    expect(css).toMatch(/@keyframes page-out \{\s*to \{\s*translate: 0 20vh;\s*\}\s*\}/)
    const pageIn = /@keyframes page-in \{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''
    expect(pageIn).toContain('clip-path: polygon(0 0, 100% 0, 100% 0vh, 0 0vh);')
    expect(pageIn).toContain('clip-path: polygon(0 0, 100% 0, 100% 100vh, 0 100vh);')
    // Neither page changes its opacity, and nothing else in a view transition does.
    const transitionRules = css.slice(css.indexOf('::view-transition-old(.page-out)'), css.indexOf('@utility duration-short')).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(transitionRules).toContain('@keyframes page-out')
    expect(transitionRules).toContain('::view-transition-new(frame-menu)')
    expect(transitionRules).not.toMatch(/opacity/)
  })

  it('the header and the menu are layers of their own above the two pages, shown live', () => {
    expect(css).toMatch(/@utility frame-fixed-header \{\s*view-transition-name: frame-header;\s*\}/)
    expect(css).toMatch(/::view-transition-group\(frame-header\),\s*::view-transition-group\(frame-menu\) \{\s*animation: none;\s*z-index: 1;\s*\}/)
    expect(read('components/frame/Header.tsx')).toContain('frame-fixed-header fixed inset-x-0 top-0 z-10')
    expect(read('components/frame/Menu.tsx')).toContain('frame-fixed-menu fixed inset-x-0 top-0 z-30')
  })

  // W74c, found on the real pages: with the window itself (the root) left in, the browser kept a picture of the whole
  // old page on every navigation and faded it out over the new one in a quarter of a second of its own, even on a
  // navigation that carries no page transition. Watched in a browser: briefs/W74c-logs/tools/real-site.cjs.
  it('the window itself is never a picture: a navigation with no page transition (Back, Forward, a colour swatch) swaps at once', () => {
    expect(css).toMatch(/\n:root \{\s*view-transition-name: none;\s*\}/)
    // Only the two pages, the header and the menu have a place in a view transition.
    const named = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/view-transition-name: ([a-z-]+);/g)].map(([, name]) => name).sort()
    expect(named).toEqual(['frame-header', 'frame-menu', 'none'])
  })

  it('reduced motion: nothing of a view transition is animated, so the page is swapped at once', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*::view-transition-group\(\*\),\s*::view-transition-old\(\*\),\s*::view-transition-new\(\*\) \{\s*animation: none !important;\s*\}\s*\}/
    expect(css).toMatch(reduced)
  })
})
