import { defineField, defineType } from 'sanity'
import { TagsIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'
import { FORM_SECTION_THEMES } from '../../../web/lib/modules/section'

/**
 * A page module: Session Passes (W81; Figma "SessionPasses", WQ84): the Session Pass cards, in their own order.
 * Which cards and their passes are the Session Pass documents; every price and "Valid for N months" come from the
 * site itself. An editor gives the module only its heading. With no Section ID of its own, a page's first Session
 * Passes module is `passes`.
 */
export const sessionPasses = defineType({
  name: 'sessionPasses',
  title: 'Session Passes',
  type: 'object',
  icon: TagsIcon,
  fieldsets: [sectionFieldset],
  fields: [
    defineField({
      name: 'heading',
      title: 'Heading',
      type: 'string',
      description: 'Optional. It is not shown on the page: it names this section for screen readers and search engines, for example "Session Passes"',
    }),
    ...sectionFields({
      // The cards are forms, and Fjord and Mud are never used for forms (docs/build-standards.md).
      themes: FORM_SECTION_THEMES,
      theme: 'The colours of this section: Light or Dark. Leave empty for Light. When a section in another theme reaches the middle of the screen, the whole page fades to it',
      sectionId:
        'Optional. Leave empty and this section is "passes" (the first Session Passes module on a page), which is where a link to that section goes. Lowercase letters, numbers and hyphens',
    }),
  ],
  preview: {
    select: { heading: 'heading' },
    prepare({ heading }) {
      return { title: 'Session Passes', subtitle: heading || 'The Session Pass cards' }
    },
  },
})
