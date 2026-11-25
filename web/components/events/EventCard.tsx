import { SiteLink } from '@/components/ui/SiteLink'
import { EVENT_CARD_SIZES, type EventCardView } from '@/lib/events/event'

type EventCardProps = {
  card: EventCardView
  /** The `sizes` of its picture: how wide the card is drawn. */
  sizes?: string
  /** One of the first cards on the page: its picture loads at once. Any other waits until it is near. */
  priority?: boolean
  className?: string
}

/**
 * Figma "EventCard" (04 Components, 329:7588), as the Event and Exclusive Hire frames use it at every width: the
 * picture, 4 by 5 with 4px corners on Object/Product BG; beneath it, 8px apart, the date and time (WQ69: the site's
 * one form, "16:00 - Tuesday 27 October") at the left and the spaces left at the right, both Copy 12, and the name in Copy 14. A sold-out event keeps
 * its card, with "Sold out" where the spaces were (WQ17).
 *
 * The whole card is one link to the event's page: it has no buttons of its own (WQ17).
 */
export function EventCard({ card, sizes = EVENT_CARD_SIZES, priority = false, className }: EventCardProps) {
  const { picture } = card
  return (
    <article data-event="card" className={className}>
      <SiteLink href={card.href} className="flex flex-col gap-8">
        <div className="relative aspect-4/5 w-full overflow-clip rounded-s bg-object-product-bg">
          {picture ? (
            // eslint-disable-next-line @next/next/no-img-element -- Next's image optimiser does not run on Workers: the address is Sanity's CDN, sized in lib/sanity/image.ts.
            <img
              src={picture.src}
              srcSet={picture.srcSet}
              sizes={sizes}
              width={picture.width}
              height={picture.height}
              alt={picture.alt}
              loading={priority ? 'eager' : 'lazy'}
              decoding="async"
              className="absolute inset-0 size-full object-cover"
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-8 pr-8">
          <p className="flex items-center justify-between gap-8">
            <time dateTime={card.startsAt} className="text-copy-12 whitespace-nowrap text-text-primary">
              {card.when}
            </time>
            <span className="text-copy-12 whitespace-nowrap text-text-primary">{card.spaces}</span>
          </p>
          <p className="text-copy-14 text-text-primary">{card.name}</p>
        </div>
      </SiteLink>
    </article>
  )
}
