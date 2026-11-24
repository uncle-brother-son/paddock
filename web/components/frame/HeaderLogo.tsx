import Link from 'next/link'

import { Logo, LogoHover } from '@/components/brand/Logo'

/**
 * The header's logo and its link home, drawn on the server so the logos' paths are in the page and not in its
 * script. As Figma's Header: the desktop global header has LogoHover, which opens out to the full name on hover and
 * on keyboard focus; a phone and the checkout have the still wordmark (hover=static).
 */
export function HeaderLogo({ animated }: { animated: boolean }) {
  return (
    <Link href="/" className="group block">
      {animated ? (
        <>
          <Logo variant="hover-static" className="block md:hidden" />
          <LogoHover className="hidden md:block" />
        </>
      ) : (
        <Logo variant="hover-static" className="block" />
      )}
    </Link>
  )
}
