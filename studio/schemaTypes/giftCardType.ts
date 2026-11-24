import { defineArrayMember, defineType, defineField } from 'sanity'
import { Gift } from 'lucide-react'
import { checkValidityPlaceholder } from '../lib/checks'

// The one gift card, at /shop/gift-card (WQ19): its address is the site's own, so it has no slug. The Worker's Sanity
// webhook keeps its name and one picture: the first image of the Physical gallery, or of the Digital one when the
// Physical gallery has none. Amounts, limits and expiry are set in the staff app.
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
      name: 'category',
      title: 'Category',
      type: 'reference',
      to: [{ type: 'productCategory' }],
      description: "Where the gift card shows in the shop's filter. Add or rename categories under Shop, Categories",
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'richText',
      description: 'Marketing copy explaining what the gift card can be used for',
    }),
    defineField({
      name: 'physicalGallery',
      title: 'Physical Gallery',
      type: 'array',
      of: [defineArrayMember({ type: 'media' })],
      description: 'Images and videos shown for the Physical gift card. Its first image is the picture on the shop page and in the staff app',
    }),
    defineField({
      name: 'digitalGallery',
      title: 'Digital Gallery',
      type: 'array',
      of: [defineArrayMember({ type: 'media' })],
      description: 'Images and videos shown for the Digital gift card',
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
      kind: 'physicalGallery.0.kind',
      image: 'physicalGallery.0.image',
      poster: 'physicalGallery.0.poster',
    },
    prepare: ({ title, kind, image, poster }) => ({ title, media: kind === 'video' ? poster : image }),
  },
})
