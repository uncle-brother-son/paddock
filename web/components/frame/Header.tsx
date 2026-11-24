'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'
import { Grid } from '@/components/layout/Grid'
import type { FrameMenuLink } from '@/lib/frame/content'

import { FrameButton, FrameButtonLabel, FrameLink } from './FrameButton'
import { Menu } from './Menu'
import { useFramePanels } from './useFramePanels'

/**
 * The mode of whatever lies under the header's middle: the nearest `data-theme` above the first thing there that is
 * not the header itself or a popup. The header is see-through, so its words take that mode's Text/Primary.
 */
function themeBeneath(header: HTMLElement): string {
  const under = document.elementsFromPoint(window.innerWidth / 2, header.offsetHeight / 2)
  const first = under.find((element) => !header.contains(element) && !element.closest('[data-frame-popup]'))
  return first?.closest<HTMLElement>('[data-theme]')?.dataset.theme ?? 'light'
}

type HeaderProps = {
  /** `checkout`: the logo and Bag only, on the checkout's narrower columns. */
  variant?: 'global' | 'checkout'
  /** The logo with its link home, drawn on the server (components/frame/HeaderLogo.tsx). */
  logo: ReactNode
  menuLinks: FrameMenuLink[]
}

/**
 * The site's header (W73; Figma "Header", 287:5420). It is see-through and lies over the top of the page. Scrolling
 * down takes it away and any scroll up, anywhere on the page, slides it back in (Wayne, 24 Nov), over the short
 * duration and the smooth curve; with reduced motion on it is just there or not. Its words take the mode of the
 * section beneath it. Book and Account are links, to /book and /account. A click on Book (and on Bag) goes to
 * useFramePanels first: when the booking panel exists it opens over the page; until then the link is followed.
 */
export function Header({ variant = 'global', logo, menuLinks }: HeaderProps) {
  const header = useRef<HTMLElement>(null)
  const burger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const pathname = usePathname()
  const panels = useFramePanels()

  const [away, setAway] = useState(false)
  // Until the first look at the page, the stylesheet gives the header the first section's mode (app/globals.css).
  const [theme, setTheme] = useState<string | null>(null)
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
      setTheme(themeBeneath(bar))
    }
    const lookSoon = () => {
      if (frame === 0) frame = requestAnimationFrame(look)
    }
    lookSoon()
    window.addEventListener('scroll', lookSoon, { passive: true })
    window.addEventListener('resize', lookSoon)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', lookSoon)
      window.removeEventListener('resize', lookSoon)
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
        // Keyboard focus landing on it brings it back, so what has focus is never out of sight.
        onFocusCapture={() => setAway(false)}
        className={`fixed inset-x-0 top-0 z-10 text-text-primary transition-transform duration-short ease-smooth ${away && !menuOpen ? '-translate-y-full' : ''}`}
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
                <FrameLink
                  href="/book"
                  onClick={(event) => {
                    // The panel when there is one; the link when there isn't.
                    if (panels.open('book')) event.preventDefault()
                  }}
                >
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
        <Menu id={menuId} open={menuOpen} links={menuLinks} onClose={() => setMenuOpenOn(null)} returnFocusTo={burger} />
      ) : null}
    </>
  )
}
