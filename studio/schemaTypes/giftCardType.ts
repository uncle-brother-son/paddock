import { defineType, defineField } from 'sanity'
import { Gift } from 'lucide-react'
import { checkValidityPlaceholder } from '../lib/checks'

export const giftCardType = defineType({
  name: 'giftCardType',
  title: 'Gift Card',
  type: 'document',
  icon: Gift,
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
      type: 'richText',
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
    defineField({
      name: 'terms',
      title: 'Gift Card Terms',
      type: 'richText',
      description: 'Write {validity} where the validity goes: the site fills it in from the staff app',
      validation: (rule) => rule.custom((blocks) => checkValidityPlaceholder(blocks as Parameters<typeof checkValidityPlaceholder>[0])).warning(),
    }),
    defineField({ name: 'seo', title: 'SEO', type: 'seo' }),
  ],
  preview: {
    select: {
      title: 'name',
      media: 'images.0',
    },
  },
})
