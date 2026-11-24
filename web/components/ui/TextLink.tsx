import type { ReactNode } from 'react'

import { SiteLink } from './SiteLink'

type TextLinkProps = {
  href: string
  /** Figma "Link 14" or "Link 12". A link in a paragraph takes its paragraph's size: Copy 14 has Link 14, Copy 12 Link 12. */
  size?: 14 | 12
  /** Opens in a new tab. Left out, the link opens in the same one, an outside address too. */
  newTab?: boolean
  className?: string
  children: ReactNode
}

/**
 * A link in running text (WQ28): underlined always, Text/Muted Primary, turning Text/Primary on hover and on
 * keyboard focus (with the focus ring) over the short duration and the smooth curve. Cards, the menu, buttons and
 * the logo are links with designs of their own and do not use this.
 */
export function TextLink({ href, size = 14, newTab = false, className, children }: TextLinkProps) {
  const style = size === 12 ? 'text-link-12' : 'text-link-14'
  return (
    <SiteLink
      href={href}
      newTab={newTab}
      className={`${style} text-text-muted-primary transition-colors duration-short ease-smooth hover:text-text-primary focus-visible:text-text-primary ${className ?? ''}`}
    >
      {children}
    </SiteLink>
  )
}
