import { SiteLink } from '@/components/ui/SiteLink'
import { EVENT_CARD_SIZES, type EventCardView } from '@/lib/events/event'
import { CARD_MEMBERS_ONLY } from '@/lib/events/format'

type EventCardProps = {
  card: EventCardView
  /** Figma's Device: where the spaces left stand. Left out, the desktop card, as every list Figma draws uses. */
  device?: 'desktop' | 'mobile'
  /** The `sizes` of its picture: how wide the card is drawn. */
  sizes?: string
  /** One of the first cards on the page: its picture loads at once. Any other waits until it is near. */
  priority?: boolean
  className?: string
}

/**
 * Figma "EventCard" (04 Components, 329:7587; W78b, WQ77: Wayne's updated card): the picture, 4 by 5 with 4px corners
 * on Object/Product BG; beneath it, 8px apart, three lines:
 * - the name in Copy 14 with the spaces left in Copy 12, Text/Muted Primary. A sold-out event keeps its card, with
 *   "Sold out" where the spaces were (WQ17);
 * - the date and time in Copy 12 (WQ69: the site's one form, "16:00 - Tuesday 27 October");
 * - the price in Copy 12, and on Type=members only (an event only a member can book now) "Members Only" 8px after it.
 *
 * Its two arrangements are Figma's Device, and differ in the first line only. Device=desktop (329:7588, 1802:11329):
 * the spaces are on the name's line, at the card's right; the name has the rest of the line and goes on to a second
 * when it is longer, so nothing runs past the card's edge at any width. Device=mobile (1051:24234, 1802:11338, drawn
 * 183 wide): the spaces are 8px under the name, at the left. Every list Figma draws, a phone's too, uses the desktop
 * card (464 wide, and 358 on the 390 frame: EventList 1634:12822, UpSellRow 1402:50615), so that is what a card is
 * unless it is told `device="mobile"`: no list is, yet.
 *
 * The whole card is one link to the event's page: it has no buttons of its own (WQ17).
 */
export function EventCard({ card, device = 'desktop', sizes = EVENT_CARD_SIZES, priority = false, className }: EventCardProps) {
  const { picture } = card
  const mobile = device === 'mobile'
  return (
    <article data-event="card" data-device={device} data-type={card.membersOnly ? 'members only' : 'default'} className={className}>
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
        <div className="flex flex-col gap-8">
          {/* Desktop: the name has the line but for the spaces, which keep their own width; a longer name goes on to
              another line beside them (a word longer than the line breaks). Mobile: one under the other. */}
          <p data-event="name-and-spaces" className={`flex items-start gap-8 ${mobile ? 'flex-col' : ''}`}>
            <span className={`text-copy-14 [overflow-wrap:anywhere] text-text-primary ${mobile ? '' : 'min-w-0 flex-1'}`}>{card.name}</span>
            <span className="shrink-0 text-copy-12 whitespace-nowrap text-text-muted-primary">{card.spaces}</span>
          </p>
          <p className="flex">
            <time dateTime={card.startsAt} className="text-copy-12 text-text-primary">
              {card.when}
            </time>
          </p>
          {card.price !== null || card.membersOnly ? (
            <p data-event="price" className="flex flex-wrap items-start gap-8">
              {card.price !== null ? <span className="text-copy-12 whitespace-nowrap text-text-primary">{card.price}</span> : null}
              {card.membersOnly ? <span className="text-copy-12 whitespace-nowrap text-text-primary">{CARD_MEMBERS_ONLY}</span> : null}
            </p>
          ) : null}
        </div>
      </SiteLink>
    </article>
  )
}
