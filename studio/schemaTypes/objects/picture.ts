import { defineField, defineType } from 'sanity'
import { ImageIcon } from '@sanity/icons'
import { checkAlt } from '../../lib/checks'

/** An image with alt text, required unless it is marked decorative. */
export const picture = defineType({
  name: 'picture',
  title: 'Picture',
  type: 'image',
  icon: ImageIcon,
  options: { hotspot: true },
  fields: [
    defineField({
      name: 'alt',
      title: 'Alt Text',
      type: 'string',
      description: 'What the picture shows, for people who cannot see it',
      hidden: ({ parent }) => Boolean(parent?.decorative),
      validation: (rule) => rule.custom((alt, context) => checkAlt(alt, context.parent as Parameters<typeof checkAlt>[1])),
    }),
    defineField({
      name: 'decorative',
      title: 'Decorative',
      type: 'boolean',
      description: 'Only decoration: screen readers skip it and it needs no alt text',
      initialValue: false,
    }),
  ],
})
