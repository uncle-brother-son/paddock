import type { ReactNode } from 'react'

import { EVENTS_LIST_ID } from '@/lib/events/event'
import {
  accordionListContent,
  galleryCarouselContent,
  pageHeaderContent,
  sectionSettings,
  textBlockContent,
  textMediaStickyContent,
  type AccordionListContent,
  type GalleryCarouselContent,
  type PageHeaderContent,
  type TextBlockContent,
  type TextMediaStickyContent,
} from '@/lib/modules/content'
import { heroMediaContent, type HeroMediaContent } from '@/lib/modules/hero-media'
import { DEFAULT_SECTION_IDS, themeOf, type SectionSettings } from '@/lib/modules/section'
import type { PageModule, RichText } from '@/lib/sanity/schemas'

import { AccordionList } from './content/AccordionList'
import { GalleryCarousel } from './content/GalleryCarousel'
import { HeroMedia } from './content/HeroMedia'
import { PageHeader } from './content/PageHeader'
import { SectionSpacer } from './content/SectionSpacer'
import { TextBlock } from './content/TextBlock'
import { TextMediaSticky } from './content/TextMediaSticky'
import { MembershipsModule, SessionPassesModule } from './MembershipsModule'
import { PageTheme } from './PageTheme'
import { UpcomingEventsModule } from './UpcomingEventsModule'

/** A module as it is drawn, or left out: each kind with what its component takes. */
type Shown = { key: string } & (
  | { kind: 'hero'; hero: HeroMediaContent; section: SectionSettings }
  | { kind: 'events'; events: { heading: string | null }; section: SectionSettings }
  | { kind: 'pageHeader'; content: PageHeaderContent }
  | { kind: 'gallery'; content: GalleryCarouselContent }
  | { kind: 'accordions'; content: AccordionListContent }
  | { kind: 'sticky'; content: TextMediaStickyContent }
  | { kind: 'text'; content: TextBlockContent }
  | { kind: 'spacer'; section: SectionSettings }
  | { kind: 'memberships'; heading: string | null; note: RichText; section: SectionSettings }
  | { kind: 'passes'; heading: string | null; section: SectionSettings }
)

/** What a module is on the page, or nothing: a module with nothing to show yet takes no room. */
function shownOf(module: PageModule): Shown[] {
  const { key } = module
  switch (module.type) {
    case 'heroMedia': {
      const hero = heroMediaContent(module)
      return hero ? [{ key, kind: 'hero', hero, section: sectionSettings(module) }] : []
    }
    case 'upcomingEvents':
      return [{ key, kind: 'events', events: { heading: module.heading }, section: sectionSettings(module) }]
    case 'pageHeader': {
      const content = pageHeaderContent(module)
      return content ? [{ key, kind: 'pageHeader', content }] : []
    }
    case 'galleryCarousel': {
      const content = galleryCarouselContent(module)
      return content ? [{ key, kind: 'gallery', content }] : []
    }
    case 'accordionList': {
      const content = accordionListContent(module)
      return content ? [{ key, kind: 'accordions', content }] : []
    }
    case 'textMediaSticky': {
      const content = textMediaStickyContent(module)
      return content ? [{ key, kind: 'sticky', content }] : []
    }
    case 'textBlock': {
      const content = textBlockContent(module)
      return content ? [{ key, kind: 'text', content }] : []
    }
    case 'sectionSpacer':
      return [{ key, kind: 'spacer', section: sectionSettings(module) }]
    case 'memberships':
      // Every theme, as drawn (WQ91: Wayne accepts the muted words on Mud at 3.55:1).
      return [{ key, kind: 'memberships', heading: module.heading, note: module.note, section: sectionSettings(module) }]
    case 'sessionPasses':
      return [{ key, kind: 'passes', heading: module.heading, section: sectionSettings(module) }]
  }
}

/** The theme a module's section carries for the page's fade (WQ87): a HeroMedia's is its own and takes no part. */
const pageThemeOf = (one: Shown) => (one.kind === 'hero' ? null : themeOf('content' in one ? one.content.theme : one.section.theme))

/**
 * A page's modules, top to bottom, as an editor ordered them in Sanity (W73b). Each kind of module has its own
 * component here: HeroMedia, the Upcoming Events list (W75), W80's content modules (PageHeader, GalleryCarousel,
 * AccordionList, TextMediaSticky, TextBlock, SectionSpacer) and W81's Memberships and SessionPasses. A module with
 * nothing to show yet takes no room: a HeroMedia with no picture or video, an events list with no upcoming event, a
 * text module with no words, a Memberships or SessionPasses module with no card on sale.
 *
 * Every module's section has its Section ID as its id, when an editor gave it one (WQ83). The page's first events
 * list with none of its own carries the id `events`, which is where an Event page's "All Events" scrolls to (WQ60:
 * /exclusive-hire#events). W81: in the same way the page's first Memberships module is `memberships` and its first
 * SessionPasses module `passes` (`DEFAULT_SECTION_IDS`), which is where PageHeader's two buttons go.
 *
 * `heading` is the page's one h1. The page's first PageHeader with a title draws it: that title is the h1 (a later
 * PageHeader's is an h2). On a page with none it is there for screen readers and search engines only, and changes
 * nothing on screen: inside the first hero when the page starts with one, so the hero stays the page's first section
 * (the header takes its mode from it).
 *
 * WQ87: when a module has a theme, `PageTheme` watches the page, and the whole page fades to the theme of the
 * section at the middle of the window.
 */
export function PageModules({ modules, heading }: { modules: PageModule[]; heading: string }) {
  const shown = modules.flatMap(shownOf)
  const firstEvents = shown.findIndex((one) => one.kind === 'events')
  const firstMemberships = shown.findIndex((one) => one.kind === 'memberships')
  const firstPasses = shown.findIndex((one) => one.kind === 'passes')
  const titled = shown.findIndex((one) => one.kind === 'pageHeader' && one.content.title !== null)
  const h1 = titled < 0 ? <h1 className="sr-only">{heading}</h1> : null
  const startsWithHero = shown[0]?.kind === 'hero'
  const draw = (one: Shown, index: number): ReactNode => {
    switch (one.kind) {
      case 'hero':
        return (
          // Only the first thing on the page loads ahead of everything else: a hero further down waits until it is near.
          <HeroMedia key={one.key} {...one.hero} {...one.section} priority={index === 0}>
            {index === 0 ? h1 : null}
          </HeroMedia>
        )
      case 'events':
        return <UpcomingEventsModule key={one.key} heading={one.events.heading} theme={one.section.theme} id={one.section.sectionId ?? (index === firstEvents ? EVENTS_LIST_ID : null)} />
      case 'pageHeader':
        return <PageHeader key={one.key} {...one.content} headingLevel={index === titled ? 1 : 2} />
      case 'gallery':
        return <GalleryCarousel key={one.key} {...one.content} />
      case 'accordions':
        return <AccordionList key={one.key} {...one.content} />
      case 'sticky':
        return <TextMediaSticky key={one.key} {...one.content} />
      case 'text':
        return <TextBlock key={one.key} {...one.content} />
      case 'spacer':
        return <SectionSpacer key={one.key} {...one.section} />
      case 'memberships':
        return (
          <MembershipsModule
            key={one.key}
            heading={one.heading}
            note={one.note}
            theme={one.section.theme}
            sectionId={one.section.sectionId ?? (index === firstMemberships ? DEFAULT_SECTION_IDS.memberships : null)}
          />
        )
      case 'passes':
        return <SessionPassesModule key={one.key} heading={one.heading} theme={one.section.theme} sectionId={one.section.sectionId ?? (index === firstPasses ? DEFAULT_SECTION_IDS.sessionPasses : null)} />
    }
  }
  return (
    <>
      {startsWithHero ? null : h1}
      {shown.map(draw)}
      {shown.some((one) => pageThemeOf(one) !== null) ? <PageTheme /> : null}
    </>
  )
}
