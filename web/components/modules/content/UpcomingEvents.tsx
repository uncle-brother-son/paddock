import { useId } from 'react'

import { Grid } from '@/components/layout/Grid'
import type { EventCardView } from '@/lib/events/event'
import type { SectionTheme } from '@/lib/modules/section'

import { EventCard } from '@/components/components/cards/EventCard'

import { ModuleSection } from './ModuleSection'

type UpcomingEventsProps = {
  /** Every upcoming event, soonest first. */
  cards: EventCardView[]
  /** The module's heading, when an editor gave it one ("Upcoming Events", as drawn). */
  heading: string | null
  /** The section's id, for a link to scroll to (`events`: WQ60; or the Section ID an editor gave it: WQ83). */
  id?: string | null
  /** W80 (WQ81): the section's theme, when an editor gave it one. */
  theme?: SectionTheme | null
}

/**
 * The events list (Figma "UpcomingEvents", 1634:12823: desktop 1634:12821, mobile 1634:12822; on Exclusive Hire
 * 1684:41872 and 1684:41916): the heading in Label 12, 8px in from the grid's edge, and 24px beneath it the
 * EventCards.
 * - From 768px: three to a row, 8 of the grid's columns each, 80px between rows, with 120px above and below the list.
 * - Below: one to a row, the whole width, 64px apart, with 80px above and below.
 * With no event to show it is not drawn at all: no heading on its own.
 */
export function UpcomingEvents({ cards, heading, id, theme }: UpcomingEventsProps) {
  const headingId = useId()
  if (cards.length === 0) return null
  return (
    <ModuleSection
      module="upcoming-events"
      theme={theme ?? null}
      sectionId={id ?? null}
      {...(heading ? { 'aria-labelledby': headingId } : { 'aria-label': 'Upcoming events' })}
      className="flex flex-col gap-24 py-80 md:py-120"
    >
      {heading ? (
        <Grid>
          <div className="col-span-full pl-8">
            <h2 id={headingId} className="text-label-12 text-text-primary">
              {heading}
            </h2>
          </div>
        </Grid>
      ) : null}
      <Grid as="ul" className="gap-y-64 md:gap-y-80">
        {cards.map((card, index) => (
          <li key={card.id} className="col-span-full md:col-span-8">
            {/* The first row is the first thing a visitor sees of the list. */}
            <EventCard card={card} priority={index < 3} />
          </li>
        ))}
      </Grid>
    </ModuleSection>
  )
}
