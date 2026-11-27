import { useId } from 'react'

import { Grid } from '@/components/layout/Grid'
import type { TextBlockContent } from '@/lib/modules/content'

import { LeadText, ModuleButtonLink } from './ModuleParts'
import { ModuleSection } from './ModuleSection'

/**
 * Where the words stand in the grid. From 768px they are 12 of its 24 columns: from the second (left), from the
 * twelfth (right), or the middle twelve (center). Below, 5 of its 6: the first five (left), the last five (right),
 * or all six (center).
 */
const PLACE = {
  left: 'col-span-5 col-start-1 items-start md:col-span-12 md:col-start-2',
  right: 'col-span-5 col-start-2 items-start md:col-span-12 md:col-start-12',
  center: 'col-span-full items-center text-center md:col-span-12 md:col-start-7',
} as const

/**
 * TextBlock (W80; Figma "TextBlock", 1627:11922): a heading in Label 12, text in H2 and a button (Button,
 * Type=secondary), 40px apart, with 120px above and below (80px below 768px). Orientation=left, right or center:
 * left and right are both set from the left, at the left or the right of the page; center is centred. Each of the
 * three parts can be left out (Figma's Show Header, Show Copy, Show Button).
 */
export function TextBlock({ heading, text, button, align, theme, sectionId }: TextBlockContent) {
  const headingId = useId()
  return (
    <ModuleSection module="text-block" theme={theme} sectionId={sectionId} data-orientation={align} {...(heading ? { 'aria-labelledby': headingId } : {})} className="py-80 md:py-120">
      <Grid>
        <div data-text-block="copy" className={`flex flex-col gap-40 ${PLACE[align]}`}>
          {heading ? (
            <h2 id={headingId} className="text-label-12 text-text-primary">
              {heading}
            </h2>
          ) : null}
          <LeadText paragraphs={text} />
          {button ? <ModuleButtonLink button={button} /> : null}
        </div>
      </Grid>
    </ModuleSection>
  )
}
