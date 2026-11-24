import type { CSSProperties } from 'react'

import { HOUSE_BOX, HouseIllustration } from '@/components/brand/Logo'
import { Grid } from '@/components/layout/Grid'
import { SiteLink } from '@/components/ui/SiteLink'
import type { FrameContent, FrameLink } from '@/lib/frame/content'

import { NewsletterForm } from './NewsletterForm'

type FooterProps = {
  /** `checkout`: the copyright line and the Terms and Privacy links only, on the checkout's narrower columns. */
  variant?: 'global' | 'checkout'
  content: FrameContent['footer']
}

/**
 * A footer link in Label 12. The style is trimmed to its capitals, so the link is 9px tall: its tap area reaches
 * 8px above and below (unseen), half the 16px gap to the next link.
 */
function FooterLink({ link }: { link: FrameLink }) {
  return (
    <SiteLink href={link.href} className="relative block text-label-12 text-text-primary after:absolute after:inset-x-0 after:-inset-y-8">
      {link.label}
    </SiteLink>
  )
}

/**
 * The site's footer (W73; Figma "Footer", 987:8891), in Light as drawn.
 *
 * Global: the newsletter card (eight columns, centred) over a card holding the house, then the groups of links an
 * editor fills in Sanity's Navigation document (Wayne, 24 Nov: up to four, each six columns wide on a desktop and
 * stacked on a phone; nothing about them is fixed in the code), then the copyright line. The card sits on the page
 * grid's own columns (a subgrid), so its 16px of padding comes off the first and last column, as Figma draws it.
 *
 * Checkout: the copyright line and the Terms and Privacy links, in Copy 12 and Text/Muted Primary, on grid columns
 * 3 to 22 with the links from column 15 (Wayne, 24 Nov: the nearest columns to Figma's 141px inset and 458px column).
 */
export function Footer({ variant = 'global', content }: FooterProps) {
  if (variant === 'checkout') {
    return (
      <footer data-behind-popups="" className="bg-surface-primary pt-80 pb-16 md:pt-120">
        <Grid className="gap-y-24 md:items-end">
          <p className="col-span-full text-copy-12 text-text-muted-primary md:col-span-12 md:col-start-3">{content.copyright}</p>
          {content.legalLinks.length > 0 ? (
            <ul className="col-span-full flex items-center gap-16 md:col-span-8 md:col-start-15">
              {content.legalLinks.map((link) => (
                <li key={link.key}>
                  <SiteLink href={link.href} className="relative block text-copy-12 text-text-muted-primary after:absolute after:-inset-8">
                    {link.label}
                  </SiteLink>
                </li>
              ))}
            </ul>
          ) : null}
        </Grid>
      </footer>
    )
  }

  const { heading, text } = content.newsletter
  return (
    <footer data-behind-popups="" className="bg-surface-primary pt-120 pb-16">
      <Grid className="gap-y-80">
        <section aria-label="Newsletter" className="col-span-full flex flex-col gap-24 rounded-s bg-surface-card p-16 md:col-span-8 md:col-start-9">
          {heading ? <h2 className="text-h2">{heading}</h2> : null}
          {text ? <p className="text-copy-12">{text}</p> : null}
          <NewsletterForm />
        </section>
        <div className="col-span-full grid grid-cols-subgrid gap-y-120 rounded-s bg-surface-card px-16 pt-64 pb-16">
          {/* A phone: the whole drawing, edge to edge. A desktop: Figma's eight-column box, with the porch hanging out of it to the left. */}
          <div className="relative col-span-full md:col-span-8 md:col-start-9 md:aspect-(--house-box)" style={{ '--house-box': HOUSE_BOX } as CSSProperties}>
            <HouseIllustration decorative className="block h-auto w-full md:absolute md:top-0 md:right-0 md:h-full md:w-auto md:max-w-none" />
          </div>
          {content.groups.length > 0 ? (
            <nav aria-label="Footer" className="col-span-full grid grid-cols-subgrid gap-y-40">
              {content.groups.map((group) => (
                <ul key={group.key} className="col-span-full flex flex-col items-start gap-16 md:col-span-6">
                  {group.links.map((link) => (
                    <li key={link.key}>
                      <FooterLink link={link} />
                    </li>
                  ))}
                </ul>
              ))}
            </nav>
          ) : null}
          <p className="col-span-full text-label-10 text-text-muted-primary">{content.copyright}</p>
        </div>
      </Grid>
    </footer>
  )
}
