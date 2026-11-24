import { defineArrayMember, defineField, defineType } from 'sanity'
import { CogIcon } from '@sanity/icons'
import { checkTime } from '../lib/checks'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** A picker for one of the info pages. Weak: a page that isn't published yet can be chosen. */
const infoPagePicker = (name: string, title: string) =>
  defineField({ name, title, type: 'reference', to: [{ type: 'infoPage' }], weak: true, group: 'pages' })

const socialLink = (name: string, title: string) =>
  defineField({ name, title, type: 'url', validation: (rule) => rule.uri({ scheme: ['https'] }) })

// One document (WQ24, WQ26).
export const siteSettings = defineType({
  name: 'siteSettings',
  title: 'Site Settings',
  type: 'document',
  icon: CogIcon,
  groups: [
    { name: 'site', title: 'Site', default: true },
    { name: 'pages', title: 'Pages' },
    { name: 'contact', title: 'Contact' },
    { name: 'footer', title: 'Footer' },
  ],
  fields: [
    defineField({
      name: 'siteName',
      title: 'Site Name',
      type: 'string',
      group: 'site',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'defaultSeo',
      title: 'Default SEO',
      type: 'seo',
      description: 'The home page, and any page with nothing of its own',
      group: 'site',
    }),
    defineField({
      name: 'homePage',
      title: 'Home Page',
      type: 'reference',
      to: [{ type: 'contentPage' }],
      group: 'pages',
      validation: (rule) => rule.required(),
    }),
    infoPagePicker('termsPage', 'Terms Page'),
    infoPagePicker('privacyPage', 'Privacy Page'),
    infoPagePicker('shippingReturnsPage', 'Shipping & Returns Page'),
    defineField({
      name: 'address',
      title: 'Address',
      type: 'object',
      group: 'contact',
      fields: [
        defineField({ name: 'line1', title: 'Address Line 1', type: 'string' }),
        defineField({ name: 'line2', title: 'Address Line 2', type: 'string' }),
        defineField({ name: 'town', title: 'Town', type: 'string' }),
        defineField({ name: 'county', title: 'County', type: 'string' }),
        defineField({ name: 'postcode', title: 'Postcode', type: 'string' }),
      ],
    }),
    defineField({ name: 'phone', title: 'Phone', type: 'string', group: 'contact' }),
    defineField({
      name: 'openingHours',
      title: 'Opening Hours',
      type: 'array',
      group: 'contact',
      of: [
        defineArrayMember({
          name: 'openingTimes',
          title: 'Opening Times',
          type: 'object',
          fields: [
            defineField({
              name: 'days',
              title: 'Days',
              type: 'array',
              of: [defineArrayMember({ type: 'string' })],
              options: { list: DAYS },
              validation: (rule) => rule.required().min(1),
            }),
            defineField({
              name: 'opens',
              title: 'Opens',
              type: 'string',
              placeholder: '09:00',
              validation: (rule) => rule.required().custom(checkTime),
            }),
            defineField({
              name: 'closes',
              title: 'Closes',
              type: 'string',
              placeholder: '21:00',
              validation: (rule) => rule.required().custom(checkTime),
            }),
          ],
          preview: {
            select: { days: 'days', opens: 'opens', closes: 'closes' },
            prepare({ days, opens, closes }) {
              return { title: Array.isArray(days) ? days.join(', ') : 'No days', subtitle: `${opens ?? '?'} to ${closes ?? '?'}` }
            },
          },
        }),
      ],
    }),
    defineField({
      name: 'socialLinks',
      title: 'Social Links',
      type: 'object',
      group: 'contact',
      fields: [socialLink('tiktok', 'TikTok'), socialLink('instagram', 'Instagram'), socialLink('facebook', 'Facebook')],
    }),
    defineField({ name: 'newsletterHeading', title: 'Newsletter Heading', type: 'string', group: 'footer' }),
    defineField({ name: 'newsletterText', title: 'Newsletter Text', type: 'text', rows: 3, group: 'footer' }),
    defineField({ name: 'copyrightName', title: 'Copyright Name', type: 'string', group: 'footer' }),
  ],
  preview: { prepare: () => ({ title: 'Site Settings' }) },
})
