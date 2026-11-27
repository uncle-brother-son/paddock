import { Grid } from '@/components/layout/Grid'
import type { PageHeaderContent } from '@/lib/modules/content'

import { LeadText, ModuleButtonLink } from './ModuleParts'
import { ModuleSection } from './ModuleSection'

type PageHeaderProps = PageHeaderContent & {
  /** The title is the page's heading (its h1) on the page's first PageHeader; on any other it is an h2. */
  headingLevel?: 1 | 2
}

/** Type=split: the title in the grid's left half and the intro in its right, each 8px in from the grid's edge. */
const SPLIT = { title: 'md:col-span-12 md:col-start-1 md:pr-0', intro: 'md:col-span-12 md:col-start-13 md:pl-0' }

/**
 * Type=stacked: one column from the grid's second column. Figma fixes it at 732px, which is no number of columns
 * (12 are 700): it is that wide wherever the grid has the room.
 */
const STACKED = 'md:col-span-22 md:col-start-2 md:max-w-[732px] md:px-0'

/**
 * PageHeader (W80; Figma "PageHeader", 1460:12636): the page's title in Label 12, its intro in H2 and up to two
 * buttons (Button, Type=secondary), with 240px above and below (160px below 768px).
 * - Type=split, from 768px (1460:12634): the title on the left, the intro on the right with the buttons 80px under it.
 * - Type=stacked, from 768px (1648:14887): the title, 40px under it the intro, 40px under that the buttons.
 * - Below 768px both are the same (1460:12635, 1648:14894): the title, 40px under it the intro, 80px under that the
 *   buttons, each 8px in from the grid's edge.
 * Any of the three can be left out.
 */
export function PageHeader({ title, intro, layout, buttons, theme, sectionId, headingLevel = 1 }: PageHeaderProps) {
  const split = layout === 'split'
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  const hasIntro = intro.length > 0 || buttons.length > 0
  return (
    <ModuleSection module="page-header" theme={theme} sectionId={sectionId} data-type={layout} className="py-160 md:py-240">
      <Grid className="gap-y-40">
        {title ? (
          <div className={`col-span-full px-8 ${split ? SPLIT.title : STACKED}`}>
            <Heading className="text-label-12 text-text-primary">{title}</Heading>
          </div>
        ) : null}
        {hasIntro ? (
          <div data-page-header="intro" className={`col-span-full flex flex-col gap-80 px-8 ${split ? SPLIT.intro : `${STACKED} md:gap-40`}`}>
            <LeadText paragraphs={intro} />
            {buttons.length > 0 ? (
              <div data-page-header="buttons" className="flex flex-wrap gap-8">
                {buttons.map((button) => (
                  <ModuleButtonLink key={button.key} button={button} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Grid>
    </ModuleSection>
  )
}
