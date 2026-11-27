'use client'

import { useState } from 'react'

import { SiteLink } from '@/components/ui/SiteLink'
import { addToBag } from '@/lib/shop/bag'
import { LISTING_CARD_SIZES, type ShopCard } from '@/lib/shop/cards'

import { SizeButton, sizeName } from '@/components/ui/form-controls/SizeSelect'

type ProductCardProps = {
  card: ShopCard
  /** The `sizes` of its picture: how wide the card is drawn. */
  sizes?: string
  /** One of the first cards on the page: its picture loads at once. Any other waits until it is near. */
  priority?: boolean
  className?: string
}

/**
 * Figma "ProductCard" (04 Components, 258:5520): the picture, 4 by 5 on Object/Product BG, the name in Copy 14 and
 * the price in Copy 12, with its tag in Label 12 over the picture's top left. Its states, as drawn:
 * - default: the tag is "New In" while the product is new in;
 * - sale: the tag is the percent off, and the price before the sale is struck through beside the price;
 * - sold out (WQ40): no tag, the price struck through, and "Sold Out" beneath it;
 * - hover, on a device with a mouse: the gallery's second picture, and a strip of the sizes over the picture's foot
 *   (SizeSelect, a size that is gone in its OOS state). A size in the strip adds that size to the bag (the one
 *   `addToBag()` seam, which does nothing until the bag is built).
 *
 * The card is one link. The strip's buttons come after it, so the keyboard and a screen reader meet the link first
 * and then the sizes; with keyboard focus anywhere in the card the strip shows. A touch screen never hovers: there
 * the strip is never seen and can't be pressed by accident, and the second picture is never fetched.
 */
export function ProductCard({ card, sizes = LISTING_CARD_SIZES, priority = false, className }: ProductCardProps) {
  // The second picture is fetched the first time the card is hovered or takes focus, not with every card.
  const [met, setMet] = useState(false)
  const meet = () => setMet(true)
  const { picture, hoverPicture, price } = card
  const shown = 'group-hover:opacity-100 group-has-[:focus-visible]:opacity-100'

  return (
    <article className={`group relative flex flex-col gap-8 ${className ?? ''}`} onPointerEnter={meet} onFocus={meet}>
      <SiteLink href={card.href} className="flex flex-col gap-8">
        <div className="relative aspect-4/5 w-full overflow-clip rounded-s bg-object-product-bg">
          {picture ? (
            // In a <picture> so React writes no preload link for it (W83): a first-row picture still loads at once, and
            // first (eager, high priority), but a preload picked for one window size is never left unused at another.
            <picture>
              {/* A plain <img>: Next's image optimiser does not run on Workers. The address is Sanity's CDN, sized in lib/sanity/image.ts. */}
              <img
                src={picture.src}
                srcSet={picture.srcSet}
                sizes={sizes}
                width={picture.width}
                height={picture.height}
                alt={picture.alt}
                loading={priority ? 'eager' : 'lazy'}
                fetchPriority={priority ? 'high' : 'auto'}
                decoding="async"
                className="absolute inset-0 size-full object-cover"
              />
            </picture>
          ) : null}
          {hoverPicture && met ? (
            // eslint-disable-next-line @next/next/no-img-element -- as above.
            <img
              data-card-hover=""
              src={hoverPicture.src}
              srcSet={hoverPicture.srcSet}
              sizes={sizes}
              width={hoverPicture.width}
              height={hoverPicture.height}
              alt=""
              decoding="async"
              className={`absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-short ease-smooth starting:opacity-0 ${shown}`}
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-8 pr-8">
          <p className="text-copy-14 text-text-primary">{card.name}</p>
          {price.now !== null ? (
            <p className="flex items-center gap-8">
              {card.soldOut ? (
                <s className="text-copy-12 text-text-muted-primary">{price.now}</s>
              ) : (
                <>
                  {price.before !== null ? (
                    <s className="text-copy-12 text-text-muted-primary">
                      <span className="sr-only">Was </span>
                      {price.before}
                    </s>
                  ) : null}
                  <span className="text-copy-12 text-text-primary">{price.from ? `From ${price.now}` : price.now}</span>
                </>
              )}
            </p>
          ) : null}
          {card.soldOut ? <p className="text-label-12 text-text-primary">Sold Out</p> : null}
        </div>
        {card.tag ? <p className="pointer-events-none absolute top-12 left-12 text-label-12 text-text-primary">{card.tag}</p> : null}
      </SiteLink>
      {card.sizes.length > 0 ? (
        // The picture's own box again, over it: the strip sits 4px inside its foot, and slides up into place as it fades in.
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-4/5 overflow-clip rounded-s">
          <div
            role="group"
            aria-label={`${card.name}: add a size to your bag`}
            className={`absolute inset-x-4 bottom-4 flex translate-y-8 rounded-s bg-surface-primary p-2 opacity-0 transition-[opacity,translate] duration-short ease-smooth group-hover:pointer-events-auto group-hover:translate-y-0 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:translate-y-0 ${shown}`}
          >
            {card.sizes.map(({ size, available }) => (
              <SizeButton key={size} size={size} available={available} aria-label={sizeName(size, available)} onClick={() => addToBag({ product: card.id, size })} />
            ))}
          </div>
        </div>
      ) : null}
    </article>
  )
}
