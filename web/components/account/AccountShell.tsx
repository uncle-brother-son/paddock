'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, type ReactNode } from 'react'

import { useAccount } from '@/components/frame/useAccount'
import { Grid } from '@/components/layout/Grid'
import { AccountNav } from '@/components/modules/account/AccountNav'
import { ACCOUNT_ADDRESS, SECTION_PAGES, sectionOf } from '@/lib/account/sections'
import { signIn } from '@/lib/frame/sign-in'
import { PAGE_TRANSITION_TYPES } from '@/lib/motion/page-transition'

/**
 * The account's layout (W85; Figma "Account — Dashboard (Sparse)", 1231:27378; on a phone 1231:28363): the
 * AccountNav in the grid's first 5 columns and the page from the 7th to the 21st, 160px under the top of the page
 * (the header's height and Figma's 80) and 120px above the footer; on a phone the menu's Select, then the page 32px
 * under it. Who is signed in is the frame's (`useAccount()`, W85a's who am I):
 * - signed out (or a login that hasn't finished Create your account): the sign-in popup opens over the page and, once
 *   signed in, the page asked for is shown (docs/url-map.md, Redirects); closing it without signing in goes home;
 * - a section this customer can't see, or an address that is no section: /account (url-map, Redirects);
 * - Log out: home, and the session on this device ends.
 * Until it is known who is signed in, only the empty page is drawn.
 */
export function AccountShell({ children }: { children: ReactNode }) {
  const { state, logOut } = useAccount()
  const pathname = usePathname()
  const router = useRouter()
  // Logging out goes home first: the account's page must not ask for a sign-in on its way out.
  const leaving = useRef(false)

  const section = sectionOf(pathname)
  const sections = state.status === 'signed_in' ? state.me.sections : null
  const seen = section !== null && sections !== null && sections.includes(section)

  useEffect(() => {
    if (leaving.current) return
    if (state.status === 'signed_out' || state.status === 'needs_details') {
      signIn({ next: pathname, onGiveUp: () => router.replace('/', { transitionTypes: PAGE_TRANSITION_TYPES }) })
    } else if (sections !== null && !seen && pathname !== ACCOUNT_ADDRESS) {
      router.replace(ACCOUNT_ADDRESS, { transitionTypes: PAGE_TRANSITION_TYPES })
    }
  }, [state.status, sections, seen, pathname, router])

  const onLogOut = async () => {
    leaving.current = true
    router.push('/', { transitionTypes: PAGE_TRANSITION_TYPES })
    await logOut()
  }

  return (
    <Grid as="section" data-account="shell" className="flex-1 content-start items-start gap-y-32 pt-80 pb-120 md:pt-160">
      {sections !== null && seen && section !== null ? (
        <>
          <div className="col-span-full md:col-span-5">
            <AccountNav sections={sections} active={section} onLogOut={() => void onLogOut()} />
          </div>
          <div data-account="page" data-section={section} className="col-span-full md:col-span-15 md:col-start-7">
            {children}
          </div>
        </>
      ) : (
        // The page's name for a screen reader while it waits (signing in, or being sent to /account).
        <h1 className="sr-only">{section ? SECTION_PAGES[section].label : SECTION_PAGES.dashboard.label}</h1>
      )}
    </Grid>
  )
}
