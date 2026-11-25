import { FRAME_BUTTON, FrameButtonLabel } from '@/components/frame/FrameButton'
import { Grid } from '@/components/layout/Grid'
import { SiteLink } from '@/components/ui/SiteLink'
import type { EventCardView } from '@/lib/events/event'

import { EventCard } from './EventCard'

type OtherEventsProps = {
  /** The next upcoming events, never the page's own, up to three. */
  cards: EventCardView[]
  /** Where "All Events" goes: the events list (`/exclusive-hire#events`); null while no page holds it, and the link is not drawn. */
  allHref: string | null
}

/**
 * Other events (Figma "UpSellRow", Type=events: desktop 1402:50607, mobile 1402:50615; on the Event page 1684:41961
 * and 1684:42029): its heading in Label 12 with "All Events" at the right (WQ60), and 32px beneath them the next
 * upcoming events as EventCards.
 * - From 768px: three across, 8 of the grid's columns each, with 160px above and below.
 * - Below: one under the other, the whole width, 80px apart, with 120px above and below.
 * With no other event to show it is not drawn.
 */
export function OtherEvents({ cards, allHref }: OtherEventsProps) {
  if (cards.length === 0) return null
  return (
    <section data-event="others" aria-labelledby="other-events" className="flex flex-col gap-32 py-120 md:py-160">
      <Grid>
        <div className="col-span-full flex items-center justify-between gap-8 px-8">
          <h2 id="other-events" className="min-w-0 flex-1 text-label-12 text-text-primary">
            Other Events
          </h2>
          {allHref ? (
            // As the header's buttons (Figma "MenuButton"): 8px round its label, so it reaches 8px above and below the heading's line.
            <SiteLink href={allHref} className={`-my-8 shrink-0 ${FRAME_BUTTON}`}>
              <FrameButtonLabel>All Events</FrameButtonLabel>
            </SiteLink>
          ) : null}
        </div>
      </Grid>
      <Grid as="ul" className="gap-y-80">
        {cards.map((card) => (
          <li key={card.id} className="col-span-full md:col-span-8">
            <EventCard card={card} />
          </li>
        ))}
      </Grid>
    </section>
  )
}
