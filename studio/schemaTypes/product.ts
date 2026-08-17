import { defineType, defineField } from 'sanity'
import { TagIcon } from '@sanity/icons'

export const product = defineType({
  name: 'product',
  title: 'Product',
  type: 'document',
  icon: TagIcon,
  fields: [
    defineField({
      name: 'name',
      title: 'Product Name',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'category',
      title: 'Category',
      type: 'string',
      options: {
        list: [
          { title: 'Apparel', value: 'apparel' },
          { title: 'Accessories', value: 'accessories' },
          { title: 'Equipment', value: 'equipment' },
        ],
      },
      description: 'Mirrored to Supabase for Retool filtering',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'productGroup',
      title: 'Product Group',
      type: 'string',
      description: 'Shared slug linking color variants (e.g. "classic-tee"). Products with the same group value show as color options on frontend.',
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 4,
    }),
    defineField({
      name: 'productInfo',
      title: 'Product Info',
      type: 'object',
      fields: [
        defineField({
          name: 'composition',
          title: 'Composition',
          type: 'text',
          rows: 2,
          description: 'e.g. "100% Organic Cotton"',
        }),
        defineField({
          name: 'madeIn',
          title: 'Made In',
          type: 'string',
          description: 'e.g. "UK", "Portugal"',
        }),
        defineField({
          name: 'careInstructions',
          title: 'Care Instructions',
          type: 'text',
          rows: 3,
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
      validation: (rule) => rule.required().min(1),
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
