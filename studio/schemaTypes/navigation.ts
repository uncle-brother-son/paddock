import { defineArrayMember, defineField, defineType } from 'sanity'
import { MenuIcon } from '@sanity/icons'

// One document (WQ24). The site hides a link whose page isn't published.
export const navigation = defineType({
  name: 'navigation',
  title: 'Navigation',
  type: 'document',
  icon: MenuIcon,
  fields: [
    defineField({
      name: 'menuLinks',
      title: 'Menu Links',
      type: 'array',
      of: [defineArrayMember({ type: 'navLink' })],
    }),
    // W73 (Wayne, 24 Nov): the footer's columns are groups an editor fills, never fixed in the code. The design
    // draws four.
    defineField({
      name: 'footerGroups',
      title: 'Footer Groups',
      description: 'The columns of links in the footer, left to right (up to four). Each holds page links or outside addresses, such as Instagram.',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'footerGroup',
          title: 'Group',
          type: 'object',
          icon: MenuIcon,
          fields: [
            defineField({
              name: 'links',
              title: 'Links',
              type: 'array',
              of: [defineArrayMember({ type: 'navLink' })],
              validation: (rule) => rule.required().min(1),
            }),
          ],
          preview: {
            select: { first: 'links.0.label', second: 'links.1.label', third: 'links.2.label', fourth: 'links.3.label' },
            prepare({ first, second, third, fourth }) {
              const labels = [first, second, third, fourth].filter(Boolean)
              return { title: labels.length > 0 ? labels.join(', ') : 'No links yet' }
            },
          },
        }),
      ],
      validation: (rule) => rule.max(4),
    }),
  ],
  preview: { prepare: () => ({ title: 'Navigation' }) },
})
