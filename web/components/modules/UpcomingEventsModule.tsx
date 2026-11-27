import { UpcomingEvents } from '@/components/modules/content/UpcomingEvents'
import { readUpcomingEventCards } from '@/lib/events/pages'

/**
 * The Upcoming Events module (W72's `upcomingEvents`; W75, WQ16, WQ60): every upcoming event, soonest first, drawn
 * as the events list (components/modules/content/UpcomingEvents.tsx). Which events, and their dates and spaces, are the Worker's;
 * an editor gives the module only its heading, which is optional. With no upcoming event it draws nothing.
 */
export async function UpcomingEventsModule({ heading, id }: { heading: string | null; id?: string }) {
  const cards = await readUpcomingEventCards()
  return <UpcomingEvents cards={cards} heading={heading?.trim() || null} {...(id ? { id } : {})} />
}
