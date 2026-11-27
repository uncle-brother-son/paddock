import { defineField, defineType } from 'sanity'
import { UsersIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'
import { FORM_SECTION_THEMES } from '../../../web/lib/modules/section'

/**
 * A page module: Memberships (W81; Figma "Memberships", WQ84-WQ86): the Monthly / Yearly switch and the Membership
 * cards, in their own order. Which cards, their plans and their words are the Membership documents; every price and
 * "Save up to N% yearly" come from the site itself. An editor gives the module only its heading and the note under
 * the cards. With no Section ID of its own, a page's first Memberships module is `memberships`.
 */
export const memberships = defineType({
  name: 'memberships',
  title: 'Memberships',
  type: 'object',
  icon: UsersIcon,
  fieldsets: [sectionFieldset],
  fields: [
    defineField({
      name: 'heading',
      title: 'Heading',
      type: 'string',
      description: 'Optional. It is not shown on the page: it names this section for screen readers and search engines, for example "Memberships"',
    }),
    defineField({
      name: 'note',
      title: 'Note under the cards',
      type: 'richText',
      description: 'Optional. For example "Monthly memberships have a 2 month minimum…"',
    }),
    ...sectionFields({
      // The cards are forms, and Fjord and Mud are never used for forms (docs/build-standards.md).
      themes: FORM_SECTION_THEMES,
      theme: 'The colours of this section: Light or Dark. Leave empty for Light. When a section in another theme reaches the middle of the screen, the whole page fades to it',
      sectionId:
        'Optional. Leave empty and this section is "memberships" (the first Memberships module on a page), which is where a link to that section goes. Lowercase letters, numbers and hyphens',
    }),
  ],
  preview: {
    select: { heading: 'heading' },
    prepare({ heading }) {
      return { title: 'Memberships', subtitle: heading || 'The Membership cards, monthly and yearly' }
    },
  },
})
