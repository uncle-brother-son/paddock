import { useId } from 'react'

import { Grid } from '@/components/layout/Grid'
import type { TextMediaStickyContent } from '@/lib/modules/content'

import { ModuleMedia } from './ModuleMedia'
import { LeadText, ModuleButtonLink } from './ModuleParts'
import { ModuleSection } from './ModuleSection'

/**
 * Where the words and the picture stand in the grid, by Size and Flip (Figma's own columns).
 * From 768px, of 24 columns: Size=small has the words on 9 and the picture on 8, a column in from each edge;
 * Size=big has the words on 10 and the picture on 9, at the grid's edges. Flip=yes swaps their sides.
 * Below 768px, of 6 columns: Size=small has the words on 5 and the picture on 4, at opposite sides (the words at
 * the left with Flip=no); Size=big has each the grid's whole width, the picture first with Flip=yes.
 */
const PLACE = {
  small: {
    no: { copy: 'col-span-5 col-start-1 md:col-span-9 md:col-start-2', media: 'col-span-4 col-start-3 md:col-span-8 md:col-start-16' },
    yes: { copy: 'col-span-5 col-start-2 md:col-span-9 md:col-start-15', media: 'col-span-4 col-start-1 md:col-span-8 md:col-start-2' },
  },
  big: {
    no: { copy: 'col-span-full md:col-span-10 md:col-start-1', media: 'col-span-full md:col-span-9 md:col-start-16' },
    yes: { copy: 'col-span-full md:col-span-10 md:col-start-15', media: 'order-first col-span-full md:order-none md:col-span-9 md:col-start-1' },
  },
} as const

/** How wide the picture is drawn from 768px: 8 of the grid's 24 columns (small), or 9 (big). */
const MEDIA_SIZES = { small: '33vw', big: '38vw' } as const

type TextMediaStickyProps = TextMediaStickyContent & {
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
}

/**
 * TextMediaSticky (W80; Figma "TextMediaSticky", 1340:41787): words that stay in place while a taller picture or
 * video (4 by 5; Figma "Media") scrolls past beside them, with 120px above and below (80px below 768px).
 * - Size=small: a heading in Label 12, text in H2 and a button (Button, Type=secondary), 40px apart.
 * - Size=big: the text in H1 and, 80px under it, the button. Figma draws its heading over the first words of the
 *   text (1340:41786), which can't be meant: until it is drawn somewhere the heading is there for screen readers
 *   only (reported in W80).
 * The button is optional (WQ79), and so is each other part.
 *
 * From 768px the words and the picture share a row, and the words stick: they start level with the picture's top
 * and, once the page has scrolled them to 80px under the window's top, stay there until the picture has passed
 * (Figma's StickyColumn: the copy 80px above its place with 80px of padding). It is the browser's own sticking.
 * Below 768px nothing sticks: the words, then 80px under them the picture.
 */
export function TextMediaSticky({ heading, text, button, media, size, flip, theme, sectionId, reducedMotion }: TextMediaStickyProps) {
  const headingId = useId()
  const place = PLACE[size][flip ? 'yes' : 'no']
  const big = size === 'big'
  return (
    <ModuleSection
      module="text-media-sticky"
      theme={theme}
      sectionId={sectionId}
      data-size={size}
      data-flip={flip ? 'yes' : 'no'}
      {...(heading ? { 'aria-labelledby': headingId } : {})}
      className="py-80 md:py-120"
    >
      <Grid className="gap-y-80">
        <div className={`md:row-start-1 ${place.copy}`}>
          <div data-text-media="copy" className={`flex flex-col items-start md:sticky md:top-80 ${big ? 'gap-80' : 'gap-40'}`}>
            {heading ? (
              <h2 id={headingId} className={big ? 'sr-only' : 'text-label-12 text-text-primary'}>
                {heading}
              </h2>
            ) : null}
            <LeadText paragraphs={text} size={big ? 'h1' : 'h2'} />
            {button ? <ModuleButtonLink button={button} /> : null}
          </div>
        </div>
        {media ? (
          <div className={`md:row-start-1 ${place.media}`}>
            <ModuleMedia picture={media.picture} video={media.video} desktopSizes={MEDIA_SIZES[size]} className="aspect-4/5 w-full" {...(reducedMotion === undefined ? {} : { reducedMotion })} />
          </div>
        ) : null}
      </Grid>
    </ModuleSection>
  )
}
