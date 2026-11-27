import { defineField, defineType } from 'sanity'
import { UsersIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'

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
      // Every theme, as W80's modules (WQ91).
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
