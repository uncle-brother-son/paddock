import { defineField, defineType } from 'sanity'
import { TagsIcon } from '@sanity/icons'

// The colours of one product: every product with the same family is a colour of the others (WQ6).
export const productFamily = defineType({
  name: 'productFamily',
  title: 'Product Family',
  type: 'document',
  icon: TagsIcon,
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      description: 'e.g. "Herd Hoodie". Not shown on the site',
      validation: (rule) => rule.required(),
    }),
  ],
  preview: { select: { title: 'name' } },
})
