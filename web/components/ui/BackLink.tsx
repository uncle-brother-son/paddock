import type { ReactNode } from 'react'

import { Icon } from '@/components/brand/Icon'
import { SiteLink } from '@/components/ui/SiteLink'

type BackLinkProps = {
  href: string
  /** Its words, in Label 12: "Back to Bookings". */
  children: ReactNode
  className?: string
}

/**
 * Figma "BackLink" (03 UI, 1138:11231): the way back to the page above this one. The arrow, turned to point left,
 * and 8px from it the words in Label 12, both in Text/Muted Primary. Figma draws it no hover.
 *
 * Label 12 is trimmed to its capitals, so the link itself is 9px tall: it has 8px above and below for a press and for
 * the keyboard's ring, taken back by its margin, so it moves nothing.
 */
export function BackLink({ href, children, className }: BackLinkProps) {
  return (
    <SiteLink href={href} data-back-link="" className={`-my-8 inline-flex items-center gap-8 py-8 text-text-muted-primary ${className ?? ''}`}>
      <Icon name="arrow" className="rotate-180" />
      <span className="text-label-12 whitespace-nowrap">{children}</span>
    </SiteLink>
  )
}
