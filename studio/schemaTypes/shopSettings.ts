import { defineArrayMember, defineField, defineType } from 'sanity'
import { BasketIcon } from '@sanity/icons'
import { NO_THUMBNAIL_AT_FIRST, shopThumbnail } from './fields/thumbnail'
import { NO_SEO_AT_FIRST } from './objects/seo'

// One document (WQ6). W84 (WQ92): its Thumbnail is what the menu shows for a link to the shop.
export const shopSettings = defineType({
  name: 'shopSettings',
  title: 'Shop Settings',
  type: 'document',
  icon: BasketIcon,
  initialValue: { ...NO_THUMBNAIL_AT_FIRST, ...NO_SEO_AT_FIRST },
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({ name: 'intro', title: 'Intro', type: 'text', rows: 3 }),
    shopThumbnail,
    defineField({
      name: 'featuredOrder',
      title: 'Featured Order',
      type: 'array',
      // Weak: a product here can still be deleted, as any product can.
      of: [defineArrayMember({ type: 'reference', to: [{ type: 'product' }, { type: 'giftCardType' }], weak: true })],
      description: 'The order of the shop when it is sorted by Featured',
      validation: (rule) => rule.unique(),
    }),
    defineField({
      name: 'shippingReturnsSummary',
      title: 'Shipping & Returns Summary',
      type: 'richText',
      description: "Shown on every product's Shipping & Returns tab",
    }),
    defineField({ name: 'seo', title: 'SEO', type: 'seo' }),
  ],
  preview: { prepare: () => ({ title: 'Shop Settings' }) },
})
