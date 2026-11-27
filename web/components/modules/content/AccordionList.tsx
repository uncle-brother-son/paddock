import { useId } from 'react'

import { Grid } from '@/components/layout/Grid'
import { Accordion } from '@/components/ui/navigation/Accordion'
import { RichText } from '@/components/ui/RichText'
import type { AccordionListContent } from '@/lib/modules/content'

import { ModuleSection } from './ModuleSection'

/**
 * AccordionList (W80; Figma "AccordionList", 1634:13101): a heading in H2, centred, and 40px under it the questions,
 * each an Accordion (03 UI, 1492:11780; it opens and shuts with W79b's motion) 8px from the next, its answer Sanity's
 * rich text in Copy 14. From 768px the list is the middle 12 of the grid's 24 columns; below, the grid's whole width.
 * - Padding=yes: 120px above and below (80px below 768px).
 * - Padding=no: none, for a list straight under another module.
 * Every answer is in the page's HTML, open or shut.
 */
export function AccordionList({ heading, padding, items, theme, sectionId }: AccordionListContent) {
  const headingId = useId()
  return (
    <ModuleSection
      module="accordion-list"
      theme={theme}
      sectionId={sectionId}
      data-padding={padding ? 'yes' : 'no'}
      {...(heading ? { 'aria-labelledby': headingId } : {})}
      className={padding ? 'py-80 md:py-120' : ''}
    >
      <Grid>
        <div className="col-span-full flex flex-col gap-40 md:col-span-12 md:col-start-7">
          {heading ? (
            <h2 id={headingId} className="text-center text-h2 text-text-primary">
              {heading}
            </h2>
          ) : null}
          <ul data-accordion-list="items" className="flex flex-col gap-8">
            {items.map((item) => (
              <li key={item.key}>
                <Accordion label={item.question}>
                  <RichText blocks={item.answer} />
                </Accordion>
              </li>
            ))}
          </ul>
        </div>
      </Grid>
    </ModuleSection>
  )
}
