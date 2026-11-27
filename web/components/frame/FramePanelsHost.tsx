'use client'

import { usePathname } from 'next/navigation'
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'

import { BookingPanel } from '@/components/modules/booking/BookingPanel'
import { ACCOUNT_ADDRESS } from '@/lib/account/sections'
import type { BookAddOn } from '@/lib/book/book'
import { signIn } from '@/lib/frame/sign-in'
import { BOOK_ADDRESS } from '@/lib/sanity/links'

import { useAccount } from './useAccount'
import { FramePanelsContext, type FramePanel, type FramePanels } from './useFramePanels'

/**
 * The mark on the history step that opening the booking panel adds (WQ64). The step has the address of the page the
 * visitor is on: only this mark tells it from the step before.
 */
export const BOOK_STEP = 'paddockBookingPanel'

const isBookStep = (state: unknown): boolean => typeof state === 'object' && state !== null && (state as Record<string, unknown>)[BOOK_STEP] === true

// The history step the visitor is on says whether the panel is open. Back and Forward tell of a change themselves
// (`popstate`); adding the step does not, so whoever adds it tells these.
const watching = new Set<() => void>()
const watchStep = (changed: () => void): (() => void) => {
  watching.add(changed)
  window.addEventListener('popstate', changed)
  return () => {
    watching.delete(changed)
    window.removeEventListener('popstate', changed)
  }
}
const onBookStep = (): boolean => isBookStep(window.history.state)
/** While the page is drawn on the server there is no history: the panel is shut unless the address is /book. */
const noStep = (): boolean => false

/**
 * The frame's panels (W77): gives everything inside the frame `useFramePanels()`, and draws the booking panel over the
 * page. W85: Account, while no one is signed in, opens the sign-in popup (components/frame/SignInHost.tsx, round this),
 * going on to /account once signed in. Bag still opens nothing (the buying stage).
 *
 * The booking panel opens over the page the visitor is on, and closing it leaves them there (WQ64):
 * - opening it (every link to /book asks, in SiteLink) adds a history step for the same address and opens the panel.
 *   Back takes that step away, which closes the panel and leaves the page; Forward opens it again. Close, Esc and
 *   the shade go back that one step themselves, so the history is as it was before the panel opened;
 * - /book itself (a link from an email, a new tab) is the home page with the panel open, because that is its
 *   address: closing it there changes the address to / where the page stands, with no navigation, so the home page
 *   is not drawn again (components/frame/PageTransition.tsx counts /book as the home page's own address).
 */
export function FramePanelsHost({ bookAddOns, children }: { bookAddOns: readonly BookAddOn[]; children: ReactNode }) {
  const atBook = usePathname() === BOOK_ADDRESS
  const stepOpen = useSyncExternalStore(watchStep, onBookStep, noStep)
  const bookOpen = stepOpen || atBook

  // W85: Account, signed out, is the sign-in popup over the page, going on to /account once signed in. Signed in, or
  // not known yet (the account's pages then ask for themselves), the link to /account is followed.
  const accountStatus = useAccount().state.status
  const signInFirst = accountStatus === 'signed_out' || accountStatus === 'needs_details'

  const open = useCallback(
    (panel: FramePanel): boolean => {
      if (panel === 'account') return signInFirst && signIn({ next: ACCOUNT_ADDRESS })
      if (panel !== 'book') return false
      if (!bookOpen) {
        // No address given: the step is this page's own, and Next's router has nothing to follow.
        window.history.pushState({ [BOOK_STEP]: true }, '')
        for (const changed of watching) changed()
      }
      return true
    },
    [bookOpen, signInFirst],
  )

  const closeBook = useCallback(() => {
    // The step opening added: going back from it closes the panel.
    if (onBookStep()) window.history.back()
    // At /book the address is what holds it open: it becomes the home page's, where the visitor already is.
    else if (window.location.pathname === BOOK_ADDRESS) window.history.replaceState(null, '', '/')
  }, [])

  const panels = useMemo<FramePanels>(() => ({ bagCount: 0, open }), [open])

  return (
    <FramePanelsContext value={panels}>
      {children}
      <BookingPanel open={bookOpen} onClose={closeBook} addOns={bookAddOns} />
    </FramePanelsContext>
  )
}
