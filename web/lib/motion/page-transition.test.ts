import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BOOK_ADDRESS, isBookAddress, linkHref } from '@/lib/sanity/links'

import { animatesHistoryStep, arriveInPlace, hashId, PAGE_AT_ONCE, PAGE_AT_ONCE_TYPES, PAGE_IN, PAGE_IN_ABOVE, PAGE_LEAVING, PAGE_OUT, PAGE_OUT_SURFACES, PAGE_SURFACE, PAGE_TRANSITION, PAGE_TRANSITION_TYPES, pageOf, takeArrivalInPlace } from './page-transition'

// Brief W73b, item 5 (WQ20), and W78a (WQ67, WQ68): the page transition is on every link from page to page inside
// the site and on the browser's Back and Forward, takes the long duration with the smooth curve, and is an instant
// swap for reduced motion and a colour swatch. The movement itself is watched in a browser
// (components/frame/PageTransition.stories.tsx, and the built site for each report).

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
    // W78a (WQ68): every navigation a link makes says which it is. One with no type at all is Back or Forward.
    // W78b (WQ52): Next puts the window at the new page's top itself, but for the link that asks for no transition.
    expect(read('components/ui/SiteLink.tsx')).toContain("<Link href={href} prefetch={isBuiltAddress(href) ? 'auto' : false} scroll={transition} transitionTypes={transition ? PAGE_TRANSITION_TYPES : PAGE_AT_ONCE_TYPES} onClick={click} {...tab} {...rest}>")
    expect(read('components/ui/SiteLink.tsx')).toContain('export function SiteLink({ href, newTab = false, transition = true, onClick, children, ...rest }: SiteLinkProps) {')
    expect(PAGE_TRANSITION_TYPES).toEqual([PAGE_TRANSITION])
    expect(PAGE_AT_ONCE_TYPES).toEqual([PAGE_AT_ONCE])
    expect(PAGE_AT_ONCE).not.toBe(PAGE_TRANSITION)
  })

  // W74c, W78b (WQ52, as amended again): a product's colour swatch goes to that colour's page where this one stands.
  // It is the one link that asks for no transition; a plain press of it says its page arrives in place.
  it('only a colour swatch goes without it, and its page arrives in place', () => {
    const without = files.filter((file) => /transition=\{false\}/.test(read(file)))
    expect(without).toEqual(['components/shop/ProductBuy.tsx'])
    const buy = read('components/shop/ProductBuy.tsx')
    expect(buy.match(/transition=\{false\}/g)).toHaveLength(1)
    expect(buy).toMatch(/<SiteLink\s+href=\{colour\.href\}\s+transition=\{false\}\s+data-shop="swatch"/)
    // The link itself says so, after the caller's own click, and never for a press meant for a new tab or window.
    const link = read('components/ui/SiteLink.tsx')
    expect(link).toMatch(/onClick\?\.\(event\)\s+if \(event\.defaultPrevented \|\| newTab \|\| !isPlainClick\(event\)\) return\s+\/\/[^\n]*\n\s+if \(!transition\) arriveInPlace\(pathOf\(href\)\)/)
    expect(link).toContain('const pathOf = (href: string): string => href.split(/[?#]/)[0] ?? href')
  })

  it('what a link says of the page it leads to is kept for that page only, and once', () => {
    expect(takeArrivalInPlace('/shop/t-shirt-black')).toBe(false)
    arriveInPlace('/shop/t-shirt-black')
    expect(takeArrivalInPlace('/shop/t-shirt-black')).toBe(true)
    expect(takeArrivalInPlace('/shop/t-shirt-black')).toBe(false)
    // Pressed, but another page arrived (the link was opened elsewhere, or another link was pressed since): dropped.
    arriveInPlace('/shop/t-shirt-black')
    expect(takeArrivalInPlace('/shop')).toBe(false)
    expect(takeArrivalInPlace('/shop/t-shirt-black')).toBe(false)
  })

  // W73b Level 3 (Wayne, 24 Nov): a link can go to the booking panel. The panel opens over the page the visitor is
  // on, so every link to it asks useFramePanels first, in the one place links are made; the link is followed only
  // while there is no panel to open (W77: outside the frame, as in a story of one component).
  it('SiteLink is also the one place a link to the booking panel (/book) asks for the panel first', () => {
    expect(BOOK_ADDRESS).toBe('/book')
    expect([isBookAddress('/book'), isBookAddress('/book?date=2026-12-01&type=public'), isBookAddress('/booking'), isBookAddress('/shop'), isBookAddress('/')]).toEqual([true, true, false, false, false])
    const link = read('components/ui/SiteLink.tsx')
    // The caller's own click first (the menu shuts), then the panel; a click meant for a new tab is the browser's.
    expect(link).toMatch(/onClick\?\.\(event\)\s+if \(event\.defaultPrevented \|\| newTab \|\| !isPlainClick\(event\)\) return\s+[\s\S]*?\n\s+if \(isBookAddress\(href\) && panels\.open\('book'\)\) event\.preventDefault\(\)\n  \}/)
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
    expect(component).toContain('<PageTransitionView page={pageOf(usePathname())}>')
    expect(component).toContain('<ViewTransition key={page} enter={ENTER} exit={EXIT} default="none">')
  })

  // W77 (WQ64): /book is the home page with the Book panel open over it. Closing the panel there changes the address
  // to / where the page stands: the same page, so nothing leaves, nothing comes and the page is not drawn again.
  it('/book counts as the home page\'s own path; every other path is its own page', () => {
    expect([pageOf('/book'), pageOf('/'), pageOf('/shop'), pageOf('/booking'), pageOf('/book/x')]).toEqual(['/', '/', '/shop', '/booking', '/book/x'])
    // Back from the panel's own history step stays on the page: it is not noted as an arrival by history.
    expect(component).toContain('byHistory.current = pageOf(window.location.pathname) !== arrived.current')
  })

  // W78a (WQ68, amends WQ22): Back and Forward carry no type, and are animated as a link is. Only the navigation
  // that says "at once" (WQ52: a colour swatch) swaps the page with no animation.
  it('a link and a navigation with no type (Back, Forward) are animated; only one that says "at once" is not', () => {
    expect(component).toContain("const ENTER = { [PAGE_TRANSITION]: PAGE_IN, [PAGE_AT_ONCE]: 'none', default: PAGE_IN }")
    expect(component).toContain("const EXIT = { [PAGE_TRANSITION]: PAGE_OUT, [PAGE_AT_ONCE]: 'none', default: PAGE_OUT }")
  })

  // React draws a history step at once, inside the browser's popstate event, and starts no view transition there
  // (seen on the site: briefs/W78a-logs/back-forward-dev-chromium-1.log in the staff app's repo). So a step to
  // another page is intercepted with the Navigation API, its popstate given to Next a task later, and the browser
  // asked to restore the scroll once the new page is in. Watched in a browser: briefs/W78a-logs/tools/back-forward.cjs.
  describe('WQ68: which steps through history the site animates itself', () => {
    const step = (over: Partial<Parameters<typeof animatesHistoryStep>[0]> = {}) => ({ navigationType: 'traverse', canIntercept: true, hasUAVisualTransition: false, destination: { url: 'https://thepaddockwellness.co.uk/shop' }, ...over })

    it('Back or Forward to another page of this document', () => {
      expect(animatesHistoryStep(step(), '/', false)).toBe(true)
      expect(animatesHistoryStep(step({ destination: { url: 'https://thepaddockwellness.co.uk/shop/t-shirt?x=1#top' } }), '/shop', false)).toBe(true)
    })

    it('never a link, a step that stays on the page, one the browser can\'t hand over, one it animated itself, or with reduced motion', () => {
      expect(animatesHistoryStep(step({ navigationType: 'push' }), '/', false)).toBe(false)
      expect(animatesHistoryStep(step({ navigationType: 'replace' }), '/', false)).toBe(false)
      // The same page: a list's category or sort, and the Book panel's own step (W77: /book is the home page's).
      expect(animatesHistoryStep(step({ destination: { url: 'https://thepaddockwellness.co.uk/shop?category=tops' } }), '/shop', false)).toBe(false)
      expect(animatesHistoryStep(step({ destination: { url: 'https://thepaddockwellness.co.uk/book' } }), '/', false)).toBe(false)
      // Another document (the entry is from before a reload, or another site): the browser loads it.
      expect(animatesHistoryStep(step({ canIntercept: false }), '/', false)).toBe(false)
      // A phone's swipe that the browser drew itself is not followed by a second animation.
      expect(animatesHistoryStep(step({ hasUAVisualTransition: true }), '/', false)).toBe(false)
      expect(animatesHistoryStep(step(), '/', true)).toBe(false)
      expect(animatesHistoryStep(step({ destination: { url: 'not an address' } }), '/', false)).toBe(false)
    })

    it('the step is intercepted with its scrolling and focus kept back, and only where the browser has the Navigation API', () => {
      expect(component).toContain("stepEvent.intercept({ scroll: 'manual', focusReset: 'manual', handler: () => arrival })")
      expect(component).toMatch(/const navigation = \(window as Window & \{ navigation\?: EventTarget \}\)\.navigation\s+navigation\?\.addEventListener\('navigate', holdStep\)\s+if \(navigation\) window\.addEventListener\('popstate', holdPopstate, true\)/)
      // Next's own note on the entry it arrived at is not a new step.
      expect(component).toMatch(/if \(stepEvent\.navigationType === 'replace'\) return\s+step\.current\?\.release\(\)/)
    })

    it('its popstate is kept from Next and given to it again in a task of its own, with the same state', () => {
      expect(component).toMatch(/if \(!step\.current \|\| again\.has\(event\)\) return\s+event\.stopImmediatePropagation\(\)\s+const \{ state \} = event\s+setTimeout\(\(\) => \{\s+const replay = new PopStateEvent\('popstate', \{ state \}\)\s+again\.add\(replay\)\s+window\.dispatchEvent\(replay\)\s+\}\)/)
    })

    it('the browser restores the scroll itself once the new page is in, before the place is read, and the step is over', () => {
      expect(component).toMatch(/const held = step\.current\s+step\.current = null\s+if \(held && byHistory\.current\) \{\s+try \{\s+held\.scroll\(\)\s+\} catch \{[\s\S]*?\}\s+\}\s+held\?\.release\(\)\s+[\s\S]*?const top = byHistory\.current \|\| inPlace \? window\.scrollY : 0/)
    })
  })

  it('on arriving: the top of the new page (Lenis told), and focus on its h1, or main', () => {
    expect(component).toContain('const top = byHistory.current || inPlace ? window.scrollY : 0')
    expect(component).toContain('lenis.scrollTo(top, { immediate: true, force: true })')
    expect(component).toContain('const toHeading = () => (heading ?? main)?.focus({ preventScroll: true })')
    expect(component).toMatch(/if \(!inPlace\) toHeading\(\)\n  \}, \[page, lenis\]\)/)
  })

  // W78b (WQ52, as amended again; it was "from the top at once, focus on the swatch" in W74c). Watched in a browser:
  // components/frame/PageTransition.stories.tsx (In Place), and the site for the report
  // (briefs/W78b-logs/tools/swatch-scroll.cjs in the staff app's repo).
  it('WQ52: a page that arrives in place stays where the window is, scrolls to its top by itself, and only then gives its heading focus', () => {
    // Asked for every arrival, so it is never left for a later page; Back and Forward never arrive in place.
    expect(component).toMatch(/const saidInPlace = takeArrivalInPlace\(page\)\s+const inPlace = saidInPlace && !byHistory\.current\s+const top = byHistory\.current \|\| inPlace \? window\.scrollY : 0/)
    expect(component).toMatch(/forgetScroll\.current\(\)\s+\/\/[^\n]*\n\s+forgetScroll\.current = inPlace \? scrollToTop\(lenis, toHeading\) : NOTHING_TO_FORGET/)
    // Lenis takes the long duration and the smooth curve from the tokens, and says when it has arrived; a wheel or a
    // touch that takes the scroll over ends it too. With reduced motion (no Lenis) it jumps, and focus goes at once.
    expect(component).toContain('lenis.scrollTo(0, { duration: DURATION_LONG, easing: EASE_SMOOTH, force: true, onComplete: end })')
    expect(component).toMatch(/if \(!lenis\) \{\s+window\.scrollTo\(0, 0\)\s+then\(\)\s+return NOTHING_TO_FORGET\s+\}/)
    expect(component).toMatch(/window\.addEventListener\('wheel', end, \{ capture: true, passive: true \}\)\s+window\.addEventListener\('touchmove', end, \{ capture: true, passive: true \}\)/)
  })

  // W75 (WQ60): "All Events" goes to /exclusive-hire#events. The page arrives at its top as every page does, and
  // scrolls to the list once the page transition has ended. Watched in a browser on the built site for the report.
  it('WQ60: a link that names a place on the new page scrolls there after the page transition, smoothly with Lenis; Back and Forward never', () => {
    expect([hashId('#events'), hashId('events'), hashId('#caf%C3%A9'), hashId(''), hashId('#'), hashId('#%E0%A4%A')]).toEqual(['events', 'events', 'café', null, null, null])
    // The place is read before the page is put at its top, and never for Back or Forward.
    expect(component).toMatch(/const placeId = byHistory\.current \? null : hashId\(window\.location\.hash\)\s+byHistory\.current = false\s+if \(lenis\) lenis\.scrollTo\(top, \{ immediate: true, force: true \}\)\s+else if \(top === 0\) window\.scrollTo\(0, 0\)\s+const place = placeId \? document\.getElementById\(placeId\) : null\s+if \(place\) scrollToPlace\(place, lenis\)/)
    // After the transition, whether it ended by itself or was cut short; with no transition, at once.
    expect(component).toMatch(/const running = runningTransition\(\)\s+if \(running\) running\.finished\.then\(go, go\)\s+else go\(\)/)
    // Lenis takes the long duration and the smooth curve from the tokens; with reduced motion (no Lenis) it jumps.
    expect(component).toMatch(/if \(lenis\) lenis\.scrollTo\(place, \{ duration: DURATION_LONG, easing: EASE_SMOOTH \}\)\s+else place\.scrollIntoView\(\)/)
  })
})

describe('the movement, in the stylesheet', () => {
  const css = read('app/globals.css')

  it('the page going and the page coming each take the long duration with the smooth curve', () => {
    expect(css).toContain(`::view-transition-old(.${PAGE_OUT}) {\n  animation: page-out var(--duration-long) var(--ease-smooth) both;\n}`)
    expect(css).toContain(`::view-transition-new(.${PAGE_IN}) {\n  animation: page-in var(--duration-long) var(--ease-smooth) both;\n  clip-path: inset(var(--page-in-above, 0px) 0 0 0);\n}`)
  })

  const transitionRules = css.slice(css.indexOf('::view-transition-old(.page-out)'), css.indexOf('@utility duration-short')).replace(/\/\*[\s\S]*?\*\//g, '')

  it('WQ67: the content of the page going drifts up a fifth of the window and fades to 40%; the page coming slides up from below the window, with no mask, and never fades', () => {
    expect(css).toMatch(/@keyframes page-out \{\s*to \{\s*opacity: 0\.4;\s*translate: 0 -20vh;\s*\}\s*\}/)
    const pageIn = /@keyframes page-in \{[\s\S]*?\n\}/.exec(css)?.[0] ?? ''
    expect(pageIn).toMatch(/@keyframes page-in \{\s*from \{\s*translate: 0 100vh;\s*\}\s*to \{\s*translate: 0 0;\s*\}\s*\}/)
    expect(pageIn).not.toMatch(/opacity|clip-path|mask/)
    // Nothing in a view transition animates a clip or a mask: the one clip there is stands still (next test).
    expect(transitionRules.replace(/\s+/g, ' ').match(/clip-path: [^;]+;/g)).toEqual(['clip-path: inset(var(--page-in-above, 0px) 0 0 0);'])
    expect(transitionRules).not.toMatch(/mask/)
    // The one opacity in a view transition is the page going's: nothing else there fades.
    expect(transitionRules).toContain('@keyframes page-out')
    expect(transitionRules).toContain('::view-transition-new(frame-menu)')
    expect(transitionRules.match(/opacity/g)).toHaveLength(1)
  })

  // After Back or Forward the new page arrives where it was left, so part of it lies above the window. The browser's
  // picture is the whole page, a window's height down: that part would pass through the window on the way up.
  it('WQ68: what of the page coming lies above the window is not drawn while it moves; a link arrives with none', () => {
    expect(PAGE_IN_ABOVE).toBe('--page-in-above')
    // Written once the browser has put the window where the entry was left, and before the new page is pictured.
    expect(read('components/frame/PageTransition.tsx')).toMatch(/held\?\.release\(\)\s+[\s\S]*?const top = byHistory\.current \|\| inPlace \? window\.scrollY : 0\s+document\.documentElement\.style\.setProperty\(PAGE_IN_ABOVE, `\$\{top\}px`\)/)
  })

  // W74d (WQ57): each page's background stays solid and still. Watched in a browser: the Frame / Page transition
  // stories, and the built site's pixels (briefs/W74d-logs/tools/page-transition.cjs in the staff app's repo).
  it('WQ57: the page coming has a solid background of its own, so it covers the page going where it has come in', () => {
    const component = read('components/frame/PageTransition.tsx')
    expect(component).toContain('<div key={page} data-page-transition="" className="flex flex-1 flex-col bg-surface-primary">')
    // The same colour as the window behind it, so a page at rest looks as it did.
    expect(css).toMatch(/\nbody \{\s*background-color: var\(--color-surface-primary\);/)
  })

  it('WQ57: the backgrounds of the page going are out of its picture and drawn behind it, still', () => {
    // Behind the picture: the page's own surface, and each section's where it stood. No animation is given to it.
    expect(transitionRules).toMatch(/::view-transition-group\(\.page-out\) \{\s*background: var\(--page-out-surfaces, none\);\s*background-color: var\(--color-surface-primary\);\s*\}/)
    expect(PAGE_OUT_SURFACES).toBe('--page-out-surfaces')
    // Out of the page from the moment it is about to be left, and on the element it stands in until it has gone.
    expect([PAGE_LEAVING, PAGE_SURFACE]).toEqual(['data-page-leaving', 'data-page-surface'])
    expect(transitionRules).toMatch(/\[data-page-leaving\],\s*\[data-page-leaving\] \[data-page-surface\] \{\s*background-color: transparent;\s*transition: none;\s*\}/)
    expect(transitionRules).toMatch(/\[data-page-stage\]:has\(> \[data-page-leaving\]\) \{\s*background: var\(--page-out-surfaces, none\);\s*\}/)
  })

  it('WQ57: the page about to be left is told so before React changes the document, which is before the browser pictures it', () => {
    const component = read('components/frame/PageTransition.tsx')
    expect(component).toMatch(/override getSnapshotBeforeUpdate\(before: \{ page: string \}\): null \{\s*const leaving = before\.page === this\.props\.page \? null : this\.stage\.current\?\.querySelector<HTMLElement>\(':scope > \[data-page-transition\]'\)\s*if \(leaving\) leavePage\(leaving\)\s*return null\s*\}/)
    expect(component).toContain('<div ref={this.stage} data-page-stage="" className="flex flex-1 flex-col">')
    // The stage is round the page whether or not this React has <ViewTransition>.
    expect(component).toContain('if (!ViewTransition) return <PageStage page={page}>{content}</PageStage>')
    expect(component).toMatch(/<PageStage page=\{page\}>\s*<ViewTransition key=\{page\} enter=\{ENTER\} exit=\{EXIT\} default="none">\s*\{content\}\s*<\/ViewTransition>\s*<\/PageStage>/)
    // leavePage reads the page once: a second call would read it with its backgrounds already out.
    expect(read('lib/motion/page-transition.ts')).toMatch(/export function leavePage\(page: HTMLElement\): void \{\s*if \(page\.hasAttribute\(PAGE_LEAVING\)\) return/)
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
  it('the window itself is never a picture: a navigation with no page transition (a colour swatch) swaps at once', () => {
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
