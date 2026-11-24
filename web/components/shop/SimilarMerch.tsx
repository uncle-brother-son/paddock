import { FRAME_BUTTON, FrameButtonLabel } from '@/components/frame/FrameButton'
import { Grid } from '@/components/layout/Grid'
import { SiteLink } from '@/components/ui/SiteLink'
import { ROW_CARD_SIZES, type ShopCard } from '@/lib/shop/cards'
import { SHOP_ADDRESS } from '@/lib/shop/listing'

import { ProductCard } from './ProductCard'

/**
 * Similar Merch (Figma "UpSellRow", Type=products: desktop 1402:49922, mobile 1402:49921): its heading in Label 12
 * with "Shop all" at the right, and a row of ProductCards to swipe through, which runs off the window's right edge.
 * With no card to show it is not drawn.
 *
 * A card's width: Figma draws 400 on the desktop, which is no column of the grid; it is 7 columns (405 on Figma's
 * frame), the nearest (W73, Wayne). On a phone it is 3 of the 6 columns, as drawn (175).
 */
export function SimilarMerch({ cards }: { cards: ShopCard[] }) {
  if (cards.length === 0) return null
  return (
    <section data-shop="similar" aria-labelledby="similar-merch" className="flex flex-col gap-32 py-120 md:py-160">
      <Grid>
        <div className="col-span-full flex items-center justify-between gap-8 px-8">
          <h2 id="similar-merch" className="min-w-0 flex-1 text-label-12 text-text-primary">
            Similar Merch
          </h2>
          {/* As the header's buttons (Figma "MenuButton"): 8px round its label, so it reaches 8px above and below the heading's line. */}
          <SiteLink href={SHOP_ADDRESS} className={`-my-8 shrink-0 ${FRAME_BUTTON}`}>
            <FrameButtonLabel>Shop all</FrameButtonLabel>
          </SiteLink>
        </div>
      </Grid>
      <ul className="flex snap-x gap-8 overflow-x-auto px-16 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {cards.map((card) => (
          <li
            key={card.id}
            className="w-[calc((100%_-_var(--grid-gutter)_*_5)_/_6_*_3_+_var(--grid-gutter)_*_2)] shrink-0 snap-start scroll-ml-16 md:w-[calc((100%_-_var(--grid-gutter)_*_23)_/_24_*_7_+_var(--grid-gutter)_*_6)]"
          >
            <ProductCard card={card} sizes={ROW_CARD_SIZES} />
          </li>
        ))}
      </ul>
    </section>
  )
}
