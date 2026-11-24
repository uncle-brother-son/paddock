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
    defineField({
      name: 'footerLinks',
      title: 'Footer Links',
      type: 'array',
      of: [defineArrayMember({ type: 'navLink' })],
    }),
  ],
  preview: { prepare: () => ({ title: 'Navigation' }) },
})
