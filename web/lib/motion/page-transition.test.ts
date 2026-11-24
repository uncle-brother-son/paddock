import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { PAGE_IN, PAGE_OUT, PAGE_TRANSITION, PAGE_TRANSITION_TYPES } from './page-transition'

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
    expect(read('components/ui/SiteLink.tsx')).toContain('<Link href={href} transitionTypes={PAGE_TRANSITION_TYPES} {...tab} {...rest}>')
    expect(PAGE_TRANSITION_TYPES).toEqual([PAGE_TRANSITION])
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
})

describe('the movement, in the stylesheet', () => {
  const css = read('app/globals.css')

  it('the page going and the page coming each take the long duration with the smooth curve', () => {
    expect(css).toContain(`::view-transition-old(.${PAGE_OUT}) {\n  animation: page-out var(--duration-long) var(--ease-smooth) both;\n}`)
    expect(css).toContain(`::view-transition-new(.${PAGE_IN}) {\n  animation: page-in var(--duration-long) var(--ease-smooth) both;\n}`)
  })

  it('the header and the menu are layers of their own above the two pages, shown live', () => {
    expect(css).toMatch(/@utility frame-fixed-header \{\s*view-transition-name: frame-header;\s*\}/)
    expect(css).toMatch(/::view-transition-group\(frame-header\),\s*::view-transition-group\(frame-menu\) \{\s*animation: none;\s*z-index: 1;\s*\}/)
    expect(read('components/frame/Header.tsx')).toContain('frame-fixed-header fixed inset-x-0 top-0 z-10')
    expect(read('components/frame/Menu.tsx')).toContain('frame-fixed-menu fixed inset-x-0 top-0 z-30')
  })

  it('reduced motion: nothing of a view transition is animated, so the page is swapped at once', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*::view-transition-group\(\*\),\s*::view-transition-old\(\*\),\s*::view-transition-new\(\*\) \{\s*animation: none !important;\s*\}\s*\}/
    expect(css).toMatch(reduced)
  })
})
