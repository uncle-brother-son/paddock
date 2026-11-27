'use client'

import { useLenis } from 'lenis/react'
import { useEffect, useRef, useState, type RefObject } from 'react'

import { Icon } from '@/components/brand/Icon'
import { Grid } from '@/components/layout/Grid'
import { Overlay } from '@/components/ui/media/Overlay'
import { SiteLink } from '@/components/ui/SiteLink'
import type { FrameMenuLink } from '@/lib/frame/content'

import { FRAME_BUTTON, FrameButtonLabel } from './FrameButton'

type MenuProps = {
  id: string
  open: boolean
  links: FrameMenuLink[]
  onClose: () => void
  /** The button that opened it: focus goes back there when it closes. */
  returnFocusTo: RefObject<HTMLButtonElement | null>
}

/**
 * The menu (W73; Figma "Menu Open" 833:13153 and 1213:32139, "Menu Hover" 833:13176). A Light panel that opens down
 * from the top of the window over a shade, in the short duration with the smooth curve, as the prototype's wrapper
 * grows over it; with reduced motion on it is just shown or hidden (the stylesheet's reduced-motion rule).
 *
 * A popup by the build standards: focus moves in (to Close), the page behind is inert and does not scroll (Lenis
 * stopped, `data-lenis-prevent` here), Esc, Close and the shade close it, and focus goes back to the Menu button.
 * It is always in the page's HTML (hidden while shut), so its links are there for a reader that runs no script.
 *
 * Desktop: while a link is hovered or has keyboard focus the other links fade to Text/Muted Primary and that link's
 * page thumbnail opens out from its middle on the left. A phone has neither: its links stay dark (Wayne, 24 Nov).
 */
export function Menu({ id, open, links, onClose, returnFocusTo }: MenuProps) {
  const close = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const lenis = useLenis()
  const [active, setActive] = useState<string | null>(null)
  // The thumbnails are fetched the first time the menu opens, not with every page.
  const [everOpen, setEverOpen] = useState(false)
  if (open && !everOpen) setEverOpen(true)

  useEffect(() => {
    if (open) close.current?.focus()
    else if (wasOpen.current) returnFocusTo.current?.focus()
    wasOpen.current = open
  }, [open, returnFocusTo])

  useEffect(() => {
    if (!open) return
    const behind = [...document.querySelectorAll<HTMLElement>('[data-behind-popups]')]
    for (const element of behind) element.inert = true
    document.documentElement.classList.add('overflow-hidden')
    lenis?.stop()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      for (const element of behind) element.inert = false
      document.documentElement.classList.remove('overflow-hidden')
      lenis?.start()
      document.removeEventListener('keydown', onKey)
    }
  }, [open, lenis, onClose])

  const shutAndForget = () => {
    setActive(null)
    onClose()
  }

  return (
    <>
      {/* The shade over the page (Wayne's Overlay: blurred, textured). A click on it closes the menu. */}
      <Overlay open={open} onClick={shutAndForget} />
      <div
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        data-theme="light"
        data-frame-popup=""
        data-lenis-prevent=""
        // Shown at once on opening, so Close can take focus straight away; hidden only when the closing has finished.
        // W73b: a link pressed here shuts the menu as the page changes: it goes on shutting over the page transition (`frame-fixed-menu`).
        className={`frame-fixed-menu fixed inset-x-0 top-0 z-30 max-h-dvh overflow-y-auto bg-surface-primary duration-short ease-smooth ${open ? 'visible transition-[clip-path] [clip-path:inset(0)]' : 'invisible transition-[clip-path,visibility] [clip-path:inset(0_0_100%_0)]'}`}
      >
        <button ref={close} type="button" onClick={shutAndForget} className={`absolute top-16 right-16 md:top-24 ${FRAME_BUTTON}`}>
          <Icon name="close" />
          <FrameButtonLabel>Close</FrameButtonLabel>
        </button>
        <Grid className="pt-120 pb-160">
          {/* The picture's place is kept whether or not one is showing, so the panel is the same height throughout. */}
          <div aria-hidden="true" className="relative hidden aspect-4/5 md:col-span-4 md:block">
            {everOpen
              ? links.map((link) =>
                  link.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Next's image optimiser does not run on Workers: the address is Sanity's CDN, sized in lib/sanity/image.ts.
                    <img
                      key={link.key}
                      src={link.thumbnail.src}
                      srcSet={link.thumbnail.srcSet}
                      sizes="(min-width: 768px) 17vw, 1px"
                      width={link.thumbnail.width}
                      height={link.thumbnail.height}
                      alt=""
                      decoding="async"
                      className={`absolute inset-0 size-full rounded-s object-cover transition-[clip-path] duration-short ease-smooth ${active === link.key ? '[clip-path:inset(0)]' : '[clip-path:inset(50%_0)]'}`}
                    />
                  ) : null,
                )
              : null}
          </div>
          <nav aria-label="Main" className="col-span-6 flex flex-col gap-80 md:col-span-15 md:col-start-10">
            <ul className="flex flex-col items-start gap-24" onMouseLeave={() => setActive(null)}>
              {links.map((link) => (
                <li key={link.key}>
                  <SiteLink
                    href={link.href}
                    onClick={shutAndForget}
                    onMouseEnter={() => setActive(link.key)}
                    onFocus={() => setActive(link.key)}
                    onBlur={() => setActive(null)}
                    className={`block text-hero-caps text-text-primary transition-colors duration-short ease-smooth ${active !== null && active !== link.key ? 'md:text-text-muted-primary' : ''}`}
                  >
                    {link.label}
                  </SiteLink>
                </li>
              ))}
            </ul>
            <ul className="flex flex-col items-start gap-12 md:hidden">
              <li>
                {/* A phone has no Account in its header: the menu holds the link. */}
                <SiteLink href="/account" onClick={shutAndForget} className="relative block text-label-12 text-text-primary after:absolute after:-inset-8">
                  Account
                </SiteLink>
              </li>
            </ul>
          </nav>
        </Grid>
      </div>
    </>
  )
}
