import { heroContent, type HeroContent } from '@/lib/modules/hero'
import type { PageModule } from '@/lib/sanity/schemas'

import { Hero } from './Hero'

type Shown = { key: string; hero: HeroContent }

/**
 * A page's modules, top to bottom, as an editor ordered them in Sanity (W73b). Each kind of module has its own
 * component here. The Upcoming Events list is in Sanity's schema but not built yet: it takes no room until it is.
 * A Hero with no picture or video yet takes none either.
 *
 * `heading` is the page's one h1. No module draws a heading yet, so it is there for screen readers and search
 * engines only, and changes nothing on screen. It sits inside the first hero when the page starts with one, so the
 * hero stays the page's first section (the header takes its mode from it).
 */
export function PageModules({ modules, heading }: { modules: PageModule[]; heading: string }) {
  const shown: Shown[] = modules.flatMap((module) => {
    const hero = module.type === 'hero' ? heroContent(module) : null
    return hero ? [{ key: module.key, hero }] : []
  })
  const h1 = <h1 className="sr-only">{heading}</h1>
  return (
    <>
      {shown.length === 0 ? h1 : null}
      {shown.map(({ key, hero }, index) => (
        // Only the first thing on the page loads ahead of everything else: a hero further down waits until it is near.
        <Hero key={key} {...hero} priority={index === 0}>
          {index === 0 ? h1 : null}
        </Hero>
      ))}
    </>
  )
}
