import { defineType, defineField } from 'sanity'
import { GiftIcon } from '@sanity/icons'

export const giftCardType = defineType({
  name: 'giftCardType',
  title: 'Gift Card',
  type: 'document',
  icon: GiftIcon,
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      description: 'e.g. "The Paddock Gift Card"',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 4,
      description: 'Marketing copy explaining what the gift card can be used for',
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
      media: 'images.0',
    },
  },
})
