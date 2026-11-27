'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'
import { Grid } from '@/components/layout/Grid'
import type { FrameMenuLink } from '@/lib/frame/content'
import { PAGE_THEME, PAGE_THEME_EVENT, PAGE_THEMED, THEME_FADE } from '@/lib/modules/section'
import { BOOK_ADDRESS } from '@/lib/sanity/links'

import { FrameButton, FrameButtonLabel, FrameLink } from './FrameButton'
import { Menu } from './Menu'
import { useFramePanels } from './useFramePanels'

/**
 * The mode of whatever lies under the header's middle: the nearest `data-theme` above the first thing there that is
 * not the header itself or a popup. The header is see-through, so its words take that mode's Text/Primary.
 *
 * W80 (WQ87): while a page's theme is watched (components/modules/PageTheme.tsx), a module's section follows the
 * page's theme in place of its own, so the mode beneath is the page's. `fromPage` says the mode is the page's own.
 */
function themeBeneath(header: HTMLElement): { theme: string; fromPage: boolean } {
  const height = header.offsetHeight / 2
  // W73b: while a page transition runs, the pages can't be found by where they are on screen (the browser shows
  // pictures of them, not the pages themselves). Then it is the section of the page at that height, by its place.
  const inTransition = Boolean((document as Document & { activeViewTransition?: object | null }).activeViewTransition)
  const under = inTransition ? [] : document.elementsFromPoint(window.innerWidth / 2, height)
  const page = [document.documentElement, document.body]
  const first = under.find((element) => !header.contains(element) && !element.closest('[data-frame-popup]') && !page.includes(element as HTMLElement))
  const beneath = first ?? [...document.querySelectorAll<HTMLElement>('#main > *, #main ~ footer')].find((section) => {
    const box = section.getBoundingClientRect()
    return box.top <= height && box.bottom > height
  })
  const holder = beneath?.closest<HTMLElement>('[data-theme]')
  const watched = holder?.hasAttribute(PAGE_THEMED) ? holder.closest<HTMLElement>(`[${PAGE_THEME}]`) : null
  const from = watched ?? holder
  return { theme: from?.dataset.theme ?? 'light', fromPage: Boolean(from?.hasAttribute(PAGE_THEME)) }
}

type HeaderProps = {
  /** `checkout`: the logo and Bag only, on the checkout's narrower columns. */
  variant?: 'global' | 'checkout'
  /** The logo with its link home, drawn on the server (components/frame/HeaderLogo.tsx). */
  logo: ReactNode
  menuLinks: FrameMenuLink[]
  /** For Storybook and tests: reduced motion on or off for the menu's thumbnails (W82), whatever the visitor's own setting. */
  menuReducedMotion?: boolean
}

/**
 * The site's header (W73; Figma "Header", 287:5420). It is see-through and lies over the top of the page. Scrolling
 * down takes it away and any scroll up, anywhere on the page, slides it back in (Wayne, 24 Nov), over the short
 * duration and the smooth curve; with reduced motion on it is just there or not. Its words take the mode of the
 * section beneath it. Book and Account are links, to /book and /account. A click on Book goes to useFramePanels
 * first, as every link to /book does (components/ui/SiteLink.tsx): inside the frame the booking panel opens over the
 * page (W77); with no panel to open the link is followed. Bag asks useFramePanels too, and opens nothing yet.
 */
export function Header({ variant = 'global', logo, menuLinks, menuReducedMotion }: HeaderProps) {
  const header = useRef<HTMLElement>(null)
  const burger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const pathname = usePathname()
  const panels = useFramePanels()

  const [away, setAway] = useState(false)
  // Until the first look at the page, the stylesheet gives the header the first section's mode (app/globals.css).
  const [theme, setTheme] = useState<string | null>(null)
  // W80 (WQ87): a change from one of the page's themes to another is the page's own fade, and the header fades with it.
  const [fading, setFading] = useState(false)
  const lastFromPage = useRef(false)
  // The menu is open on the page it was opened on: going to another page closes it.
  const [menuOpenOn, setMenuOpenOn] = useState<string | null>(null)
  const menuOpen = menuOpenOn === pathname

  useEffect(() => {
    let last = window.scrollY
    let frame = 0
    const look = () => {
      frame = 0
      const bar = header.current
      // While the menu is open the page is inert and can't be looked at: the header keeps what it had.
      if (!bar || bar.inert) return
      const now = window.scrollY
      // Down, and past the header's own height: away. Up at all, or back at the top: here.
      if (now > last && now > bar.offsetHeight) setAway(true)
      else if (now < last || now <= bar.offsetHeight) setAway(false)
      last = now
      const beneath = themeBeneath(bar)
      setTheme(beneath.theme)
      setFading(lastFromPage.current && beneath.fromPage)
      lastFromPage.current = beneath.fromPage
    }
    const lookSoon = () => {
      if (frame === 0) frame = requestAnimationFrame(look)
    }
    lookSoon()
    window.addEventListener('scroll', lookSoon, { passive: true })
    window.addEventListener('resize', lookSoon)
    window.addEventListener(PAGE_THEME_EVENT, lookSoon)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', lookSoon)
      window.removeEventListener('resize', lookSoon)
      window.removeEventListener(PAGE_THEME_EVENT, lookSoon)
    }
    // Looked at again on a new page, and when the menu closes.
  }, [pathname, menuOpen])

  const bag = (
    <FrameButton onClick={() => panels.open('bag')} {...(panels.bagCount > 0 ? { 'aria-label': `Bag, ${panels.bagCount} ${panels.bagCount === 1 ? 'item' : 'items'}` } : {})}>
      <span className="flex items-center gap-4">
        <FrameButtonLabel>Bag</FrameButtonLabel>
        {panels.bagCount > 0 ? <FrameButtonLabel>{panels.bagCount}</FrameButtonLabel> : null}
      </span>
    </FrameButton>
  )

  return (
    <>
      <header
        ref={header}
        inert={menuOpen}
        {...(theme ? { 'data-theme': theme } : { 'data-header-theme': 'page' })}
        {...(fading ? { [THEME_FADE]: '' } : {})}
        // Keyboard focus landing on it brings it back, so what has focus is never out of sight.
        onFocusCapture={() => setAway(false)}
        // W73b: it stays where it is while one page gives way to the next (`frame-fixed-header` in app/globals.css).
        className={`frame-fixed-header fixed inset-x-0 top-0 z-10 text-text-primary transition-transform duration-short ease-smooth ${away && !menuOpen ? '-translate-y-full' : ''}`}
      >
        <Grid className="items-center py-16 md:py-24">
          {/* The logo is taller than the row of buttons, which sets the header's height: it sits centred on the row and overlaps it above and below, as drawn. */}
          <div className={`relative col-span-2 self-stretch ${variant === 'checkout' ? 'md:col-span-10 md:col-start-3' : 'md:col-span-17'}`}>
            <div className="absolute top-1/2 left-0 -translate-y-1/2">{logo}</div>
          </div>
          {variant === 'checkout' ? (
            <div className="col-span-4 flex items-center justify-end md:col-span-10">{bag}</div>
          ) : (
            <div className="col-span-4 flex items-center justify-end gap-8 md:col-span-7 md:col-start-18 md:justify-between">
              <FrameButton ref={burger} aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpenOn(pathname)}>
                <Icon name="burger" />
                <FrameButtonLabel>Menu</FrameButtonLabel>
              </FrameButton>
              <div className="flex items-center gap-8">
                {/* The panel when there is one; the link when there isn't: every link to /book asks first (SiteLink). */}
                <FrameLink href={BOOK_ADDRESS}>
                  <FrameButtonLabel>Book</FrameButtonLabel>
                </FrameLink>
                {/* On a phone Account is in the menu. */}
                <FrameLink href="/account" className="hidden md:flex">
                  <FrameButtonLabel>Account</FrameButtonLabel>
                </FrameLink>
                {bag}
              </div>
            </div>
          )}
        </Grid>
      </header>
      {variant === 'global' ? (
        <Menu id={menuId} open={menuOpen} links={menuLinks} onClose={() => setMenuOpenOn(null)} returnFocusTo={burger} reducedMotion={menuReducedMotion} />
      ) : null}
    </>
  )
}
