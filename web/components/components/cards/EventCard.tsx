import { SiteLink } from '@/components/ui/SiteLink'
import { EVENT_CARD_SIZES, type EventCardView } from '@/lib/events/event'
import { CARD_MEMBERS_ONLY } from '@/lib/events/format'

type EventCardProps = {
  card: EventCardView
  /**
   * Figma's Device, to hold the card to one arrangement whatever its width (the stories of Figma's variants). Left
   * out, as in every list, the card takes the one that fits (see below).
   */
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
 * - the name in Copy 14 with the spaces left in Copy 12, Text/Muted Primary;
 * - the date and time in Copy 12 (WQ69: the site's one form, "16:00 - Tuesday 27 October");
 * - the price in Copy 12, and on Type=members only (an event only a member can book now) "Members Only" 8px after it.
 *
 * A sold-out event keeps its card (WQ17) as Figma's Type=sold out (W83, Wayne 27 Nov; 1896:8636, 1896:8646): "Sold
 * Out" where the spaces were, in Label 12, Text/Primary, and the price struck through in Text/Muted Primary.
 *
 * Its two arrangements are Figma's Device, and differ in the first line only. Device=desktop (329:7588, 1802:11329):
 * the spaces are on the name's line, at the card's right; the name has the rest of the line and goes on to a second
 * when it is longer, so nothing runs past the card's edge at any width. Device=mobile (1051:24234, 1802:11338, drawn
 * 183 wide): the spaces are 8px under the name, at the left.
 *
 * Which one a card in a list is (Wayne, 26 Nov):
 * - below 768px, the desktop card, as Figma's phone lists draw it (358 wide on the 390 frame: UpcomingEvents 1634:12822,
 *   UpSellRow 1402:50615): a long name goes on to another line beside the spaces;
 * - from 768px, the desktop card while the name and the spaces fit on one line with 8px between them (as they do on
 *   Figma's 464 card), and the mobile card when the card is too narrow for that (three to a row at a tablet's width,
 *   240px): the spaces drop to their own line under the name. It is the line's own wrapping, so it answers to the
 *   card's width and its words, with no script.
 *
 * The whole card is one link to the event's page: it has no buttons of its own (WQ17).
 */
export function EventCard({ card, device, sizes = EVENT_CARD_SIZES, priority = false, className }: EventCardProps) {
  const { picture } = card
  // The first line: held to one of Figma's two arrangements, or, from 768px, wrapping to the mobile one when it must.
  const line = device === 'mobile' ? 'flex-col' : device === 'desktop' ? '' : 'md:flex-wrap'
  // The name has what the spaces leave of the line. Where the line may wrap it asks for its own whole width first:
  // that is what sends the spaces to a line of their own when the two don't fit.
  const name = device === 'mobile' ? '' : device === 'desktop' ? 'min-w-0 flex-1' : 'min-w-0 flex-1 md:flex-auto'
  return (
    <article data-event="card" data-device={device ?? 'by fit'} data-type={card.soldOut ? 'sold out' : card.membersOnly ? 'members only' : 'default'} className={className}>
      <SiteLink href={card.href} className="flex flex-col gap-8">
        <div className="relative aspect-4/5 w-full overflow-clip rounded-s bg-object-product-bg">
          {picture ? (
            // In a <picture> so React writes no preload link for it (W83), as a ProductCard's.
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
        </div>
        <div className="flex flex-col gap-8">
          {/* Desktop: the name has the line but for the spaces, which keep their own width; a longer name goes on to
              another line beside them (a word longer than the line breaks). Mobile: one under the other, 8px apart. */}
          <p data-event="name-and-spaces" className={`flex items-start gap-8 ${line}`}>
            <span className={`text-copy-14 [overflow-wrap:anywhere] text-text-primary ${name}`}>{card.name}</span>
            <span data-event="spaces" className={`shrink-0 whitespace-nowrap ${card.soldOut ? 'text-label-12 text-text-primary' : 'text-copy-12 text-text-muted-primary'}`}>
              {card.spaces}
            </span>
          </p>
          <p className="flex">
            <time dateTime={card.startsAt} className="text-copy-12 text-text-primary">
              {card.when}
            </time>
          </p>
          {card.price !== null || card.membersOnly ? (
            <p data-event="price" className="flex flex-wrap items-start gap-8">
              {card.price === null ? null : card.soldOut ? (
                <s className="text-copy-12 whitespace-nowrap text-text-muted-primary">{card.price}</s>
              ) : (
                <span className="text-copy-12 whitespace-nowrap text-text-primary">{card.price}</span>
              )}
              {card.membersOnly ? <span className="text-copy-12 whitespace-nowrap text-text-primary">{CARD_MEMBERS_ONLY}</span> : null}
            </p>
          ) : null}
        </div>
      </SiteLink>
    </article>
  )
}
