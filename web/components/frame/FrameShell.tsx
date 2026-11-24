import type { ReactNode } from 'react'

import type { FrameContent } from '@/lib/frame/content'

import { Footer } from './Footer'
import { Header } from './Header'
import { HeaderLogo } from './HeaderLogo'
import { SkipLink } from './SkipLink'

export type FrameVariant = 'global' | 'checkout'

/**
 * What every page sits in (W73): "Skip to content", the header with its menu, <main id="main"> and the footer.
 * `main` takes focus from the skip link (tabindex -1: by script only, never in the Tab order). A page whose first
 * section sets a mode (`data-theme` on main's first child, as a dark hero does) gives the header that mode.
 */
export function FrameShell({ variant = 'global', content, children }: { variant?: FrameVariant; content: FrameContent; children: ReactNode }) {
  return (
    <>
      <SkipLink />
      <Header variant={variant} logo={<HeaderLogo animated={variant === 'global'} />} menuLinks={content.menuLinks} />
      <main id="main" tabIndex={-1} data-behind-popups="" className="flex flex-1 flex-col outline-none">
        {children}
      </main>
      <Footer variant={variant} content={content.footer} />
    </>
  )
}
