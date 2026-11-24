import Link from 'next/link'
import type { ComponentPropsWithoutRef } from 'react'

type SiteLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'target' | 'rel'> & {
  href: string
  /** Opens in a new tab. Left out, every link opens in the same one, an outside address too. */
  newTab?: boolean
}

/** An address off the site: another site, an email address, a phone number. */
export const isOutsideAddress = (href: string): boolean => /^(https?:|mailto:|tel:|\/\/)/i.test(href)

/**
 * A link with no look of its own: Next's <Link> for a page of the site (no full reload), a plain <a> for an outside
 * address. The components that draw links (TextLink, the menu, the footer) put their own classes on it.
 */
export function SiteLink({ href, newTab = false, children, ...rest }: SiteLinkProps) {
  const tab = newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}
  if (isOutsideAddress(href)) {
    return (
      <a href={href} {...tab} {...rest}>
        {children}
      </a>
    )
  }
  return (
    <Link href={href} {...tab} {...rest}>
      {children}
    </Link>
  )
}
