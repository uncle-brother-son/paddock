import { defineType } from 'sanity'
import { InsertBelowIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'

/**
 * A page module: SectionSpacer (W80; Figma "SectionSpacer"): empty space between two sections, 120px on a desktop
 * and 80px on a phone. It has nothing to fill in but the section settings every module has.
 */
export const sectionSpacer = defineType({
  name: 'sectionSpacer',
  title: 'Section Spacer',
  type: 'object',
  icon: InsertBelowIcon,
  fieldsets: [sectionFieldset],
  fields: [
    ...sectionFields({
      theme: 'The colour of this space. Leave empty for Light; give it the theme of the modules next to it when they sit on one colour',
    }),
  ],
  preview: {
    select: { theme: 'theme' },
    prepare({ theme }) {
      return { title: 'Section Spacer', subtitle: theme && theme !== 'light' ? `Empty space, ${theme}` : 'Empty space' }
    },
  },
})
