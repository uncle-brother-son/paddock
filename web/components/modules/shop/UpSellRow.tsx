import { EventCard } from '@/components/components/cards/EventCard'
import { ProductCard } from '@/components/components/cards/ProductCard'
import { FRAME_BUTTON, FrameButtonLabel } from '@/components/frame/FrameButton'
import { Grid } from '@/components/layout/Grid'
import { SiteLink } from '@/components/ui/SiteLink'
import type { EventCardView } from '@/lib/events/event'
import { ROW_CARD_SIZES, type ShopCard } from '@/lib/shop/cards'
import { SHOP_ADDRESS } from '@/lib/shop/listing'

type UpSellRowProps =
  /** Similar Merch, under a product. */
  | { type: 'products'; cards: ShopCard[] }
  | {
      /** Other Events, under an event. */
      type: 'events'
      /** The next upcoming events, never the page's own, up to three. */
      cards: EventCardView[]
      /** Where "All Events" goes: the events list (`/exclusive-hire#events`); null while no page holds it, and the link is not drawn. */
      allHref: string | null
    }

/**
 * Figma "UpSellRow" (05 Modules > Shop, 1402:49923): its heading in Label 12 with a link at the right, and 32px
 * beneath them a row of cards, with 120px above and below, and 160px from 768px. With no card to show it is not drawn.
 * - Type=products, Similar Merch (desktop 1402:49922, mobile 1402:49921): "Shop all", and a row of ProductCards to
 *   swipe through, which runs off the window's right edge. A card's width: Figma draws 400 on the desktop, which is
 *   no column of the grid; it is 7 columns (405 on Figma's frame), the nearest (W73, Wayne). On a phone it is 3 of
 *   the 6 columns, as drawn (175).
 * - Type=events, Other Events (desktop 1402:50607, mobile 1402:50615; on the Event page 1684:41961 and 1684:42029):
 *   "All Events" (WQ60), and the next upcoming events as EventCards: from 768px three across, 8 of the grid's
 *   columns each; below, one under the other, the whole width, 80px apart.
 */
export function UpSellRow(props: UpSellRowProps) {
  if (props.cards.length === 0) return null
  const products = props.type === 'products'
  const headingId = products ? 'similar-merch' : 'other-events'
  const link = products ? { href: SHOP_ADDRESS, label: 'Shop all' } : props.allHref ? { href: props.allHref, label: 'All Events' } : null
  return (
    <section {...(products ? { 'data-shop': 'similar' } : { 'data-event': 'others' })} aria-labelledby={headingId} className="flex flex-col gap-32 py-120 md:py-160">
      <Grid>
        <div className="col-span-full flex items-center justify-between gap-8 px-8">
          <h2 id={headingId} className="min-w-0 flex-1 text-label-12 text-text-primary">
            {products ? 'Similar Merch' : 'Other Events'}
          </h2>
          {link ? (
            // As the header's buttons (Figma "MenuButton"): 8px round its label, so it reaches 8px above and below the heading's line.
            <SiteLink href={link.href} className={`-my-8 shrink-0 ${FRAME_BUTTON}`}>
              <FrameButtonLabel>{link.label}</FrameButtonLabel>
            </SiteLink>
          ) : null}
        </div>
      </Grid>
      {props.type === 'products' ? (
        <ul className="flex snap-x gap-8 overflow-x-auto px-16 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {props.cards.map((card) => (
            <li
              key={card.id}
              className="w-[calc((100%_-_var(--grid-gutter)_*_5)_/_6_*_3_+_var(--grid-gutter)_*_2)] shrink-0 snap-start scroll-ml-16 md:w-[calc((100%_-_var(--grid-gutter)_*_23)_/_24_*_7_+_var(--grid-gutter)_*_6)]"
            >
              <ProductCard card={card} sizes={ROW_CARD_SIZES} />
            </li>
          ))}
        </ul>
      ) : (
        <Grid as="ul" className="gap-y-80">
          {props.cards.map((card) => (
            <li key={card.id} className="col-span-full md:col-span-8">
              <EventCard card={card} />
            </li>
          ))}
        </Grid>
      )}
    </section>
  )
}
