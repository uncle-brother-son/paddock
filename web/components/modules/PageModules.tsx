import { EVENTS_LIST_ID } from '@/lib/events/event'
import { heroContent, type HeroContent } from '@/lib/modules/hero'
import type { PageModule } from '@/lib/sanity/schemas'

import { Hero } from './Hero'
import { UpcomingEvents } from './UpcomingEvents'

type Shown = { key: string; hero: HeroContent } | { key: string; events: { heading: string | null } }

/**
 * A page's modules, top to bottom, as an editor ordered them in Sanity (W73b). Each kind of module has its own
 * component here: the Hero, and the Upcoming Events list (W75). A Hero with no picture or video yet takes no room,
 * and neither does an events list with no upcoming event.
 *
 * The page's first events list carries the id `events`, which is where an Event page's "All Events" scrolls to
 * (WQ60: /exclusive-hire#events).
 *
 * `heading` is the page's one h1. No module draws the page's heading yet, so it is there for screen readers and
 * search engines only, and changes nothing on screen. It sits inside the first hero when the page starts with one, so
 * the hero stays the page's first section (the header takes its mode from it).
 */
export function PageModules({ modules, heading }: { modules: PageModule[]; heading: string }) {
  const shown: Shown[] = modules.flatMap((module): Shown[] => {
    if (module.type === 'upcomingEvents') return [{ key: module.key, events: { heading: module.heading } }]
    const hero = heroContent(module)
    return hero ? [{ key: module.key, hero }] : []
  })
  const firstEvents = shown.findIndex((one) => 'events' in one)
  const h1 = <h1 className="sr-only">{heading}</h1>
  const startsWithHero = shown[0] !== undefined && 'hero' in shown[0]
  return (
    <>
      {startsWithHero ? null : h1}
      {shown.map((one, index) =>
        'hero' in one ? (
          // Only the first thing on the page loads ahead of everything else: a hero further down waits until it is near.
          <Hero key={one.key} {...one.hero} priority={index === 0}>
            {index === 0 ? h1 : null}
          </Hero>
        ) : (
          <UpcomingEvents key={one.key} heading={one.events.heading} {...(index === firstEvents ? { id: EVENTS_LIST_ID } : {})} />
        ),
      )}
    </>
  )
}
