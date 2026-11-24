import { defineField, defineType } from 'sanity'
import { FilterIcon } from '@sanity/icons'
import { checkSlug } from '../lib/checks'

// A product category (WQ7): the client adds, renames and orders them here. A product (and the gift card) picks one.
// The Worker's Sanity webhook keeps a row for each (its title and order), and the staff app's Products filter lists
// them by title. A category that a product still points to can't be deleted.
export const productCategory = defineType({
  name: 'productCategory',
  title: 'Product Category',
  type: 'document',
  icon: FilterIcon,
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      description: 'e.g. "Apparel". Shown in the shop\'s filter and in the staff app',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      description: "The category's name in the shop's address",
      options: { source: 'title', maxLength: 96 },
      validation: (rule) => rule.required().custom((slug) => checkSlug(slug?.current, 'category')),
    }),
    defineField({
      name: 'order',
      title: 'Order',
      type: 'number',
      description: 'Where it comes in the filter. Lowest first',
      validation: (rule) => rule.required().integer(),
    }),
  ],
  orderings: [{ title: 'Order', name: 'order', by: [{ field: 'order', direction: 'asc' }] }],
  preview: {
    select: { title: 'title', subtitle: 'slug.current' },
  },
})
