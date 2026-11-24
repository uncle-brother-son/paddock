import { defineType, defineField } from 'sanity'
import { TagIcon } from '@sanity/icons'
import { checkSlug } from '../lib/checks'

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
      name: 'colourName',
      title: 'Colour',
      type: 'string',
      description: 'One product per colour, e.g. "Moss". Leave empty when it comes in one colour only',
    }),
    defineField({
      name: 'family',
      title: 'Product Family',
      type: 'reference',
      to: [{ type: 'productFamily' }],
      description: 'Products of the same family are shown as colours of each other',
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      description: "The product's address, after /shop/. Generate makes it from the name and colour",
      options: {
        source: (document) => [document.name, document.colourName].filter(Boolean).join(' '),
        maxLength: 96,
      },
      validation: (rule) => rule.required().custom((slug) => checkSlug(slug?.current, 'product')),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'richText',
    }),
    defineField({
      name: 'newInUntil',
      title: 'New In Until',
      type: 'date',
      description: 'Shows the New In tag up to and including this day. Leave empty for no tag',
    }),
    defineField({
      name: 'sizeGuide',
      title: 'Size Guide',
      type: 'reference',
      to: [{ type: 'sizeGuide' }],
      description: 'Leave empty for no size guide link',
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
    defineField({
      name: 'similarProducts',
      title: 'Similar Merch',
      type: 'array',
      of: [
        {
          type: 'reference',
          to: [{ type: 'product' }],
          // Weak: a product picked here can still be deleted, as any product can.
          weak: true,
          options: {
            filter: ({ document }) => {
              const id = document._id.replace(/^drafts\./, '')
              return { filter: '!(_id in [$id, $draftId])', params: { id, draftId: `drafts.${id}` } }
            },
          },
        },
      ],
      description: 'Optional. Left empty, the site shows others of the same category',
      validation: (rule) => rule.unique(),
    }),
    defineField({ name: 'seo', title: 'SEO', type: 'seo' }),
  ],
  preview: {
    select: {
      title: 'name',
      subtitle: 'colourName',
      media: 'images.0',
    },
  },
})
