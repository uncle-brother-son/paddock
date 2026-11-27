import type { ReactNode } from 'react'

import type { BookAddOn } from '@/lib/book/book'
import type { FrameContent } from '@/lib/frame/content'

import { Footer } from './Footer'
import { FramePanelsHost } from './FramePanelsHost'
import { Header } from './Header'
import { HeaderLogo } from './HeaderLogo'
import { PageTransition } from './PageTransition'
import { SignInHost } from './SignInHost'
import { SkipLink } from './SkipLink'

export type FrameVariant = 'global' | 'checkout'

/**
 * What every page sits in (W73): "Skip to content", the header with its menu, <main id="main"> and the footer.
 * `main` takes focus from the skip link (tabindex -1: by script only, never in the Tab order). A page whose first
 * section sets a mode (`data-theme` on main's first child, as a dark hero does) gives the header that mode.
 *
 * W73b: main and the footer are what changes from page to page, so the two together are what the page transition
 * moves; the header stays where it is.
 *
 * W77: round them all is FramePanelsHost, which draws the booking panel over the page and gives every link to /book the
 * way to open it. `bookAddOns` are the panel's add-ons, read with the frame's own content (lib/book/read.ts).
 *
 * W85: round that, SignInHost: who is signed in, for the whole frame (`useAccount()`), and the sign-in popup, drawn
 * after the booking panel so it can open over it.
 */
export function FrameShell({ variant = 'global', content, bookAddOns = [], children }: { variant?: FrameVariant; content: FrameContent; bookAddOns?: readonly BookAddOn[]; children: ReactNode }) {
  return (
    <SignInHost legalPages={content.legalPages}>
      <FramePanelsHost bookAddOns={bookAddOns}>
        <SkipLink />
        <Header variant={variant} logo={<HeaderLogo animated={variant === 'global'} />} menuLinks={content.menuLinks} />
        <PageTransition>
          <main id="main" tabIndex={-1} data-behind-popups="" className="flex flex-1 flex-col outline-none">
            {children}
          </main>
          <Footer variant={variant} content={content.footer} />
        </PageTransition>
      </FramePanelsHost>
    </SignInHost>
  )
}
