import { defineType, defineField } from 'sanity'
import { AddIcon } from '@sanity/icons'

export const addon = defineType({
  name: 'addon',
  title: 'Add-on',
  type: 'document',
  icon: AddIcon,
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'category',
      title: 'Category',
      type: 'string',
      options: {
        list: [
          { title: 'Food & Drink', value: 'food_drink' },
          { title: 'Amenities', value: 'amenities' },
          { title: 'Services', value: 'services' },
        ],
      },
      description: 'Mirrored to Supabase for Retool filtering',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 3,
    }),
    defineField({
      name: 'productInfo',
      title: 'Product Info',
      type: 'object',
      fields: [
        defineField({
          name: 'ingredients',
          title: 'Ingredients',
          type: 'text',
          rows: 3,
          description: 'For food/drink items',
        }),
        defineField({
          name: 'allergens',
          title: 'Allergens',
          type: 'text',
          rows: 2,
        }),
      ],
    }),
    defineField({
      name: 'images',
      title: 'Images',
      type: 'array',
      of: [
        {
          type: 'image',
          options: {
            hotspot: true,
          },
          fields: [
            defineField({
              name: 'alt',
              type: 'string',
              title: 'Alt Text',
              validation: (rule) => rule.required(),
            }),
          ],
        },
      ],
      description: 'First image will be used as thumbnail in Supabase',
    }),
  ],
  preview: {
    select: {
      title: 'name',
      subtitle: 'category',
      media: 'images.0',
    },
  },
})
