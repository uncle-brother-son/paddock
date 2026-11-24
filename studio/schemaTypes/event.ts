import { defineType, defineField } from 'sanity'
import { CalendarIcon } from '@sanity/icons'
import { checkSlug } from '../lib/checks'

// Event content. Syncs name, first image, and whether there is an extra waiver (plus a version
// fingerprint of its text) to the booking system via the webhook. Date and time, capacity, who can
// book, prices and the refund cut-off are set in Retool (Catalog → Events), not here.
export const event = defineType({
  name: 'event',
  title: 'Event',
  type: 'document',
  icon: CalendarIcon,
  fields: [
    defineField({
      name: 'name',
      title: 'Event Name',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      description: "The event's address, after /events/. Each date is its own event, so each needs its own",
      options: { maxLength: 96 },
      validation: (rule) => rule.required().custom((slug) => checkSlug(slug?.current, 'page')),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'richText',
      description: 'What the event is, who it is for, what to bring',
    }),
    defineField({
      name: 'images',
      title: 'Images',
      type: 'array',
      of: [
        {
          type: 'image',
          options: { hotspot: true },
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
      description: 'First image will be used as thumbnail in the booking system',
    }),
    defineField({
      name: 'extraWaiver',
      title: 'Extra Waiver',
      type: 'text',
      rows: 8,
      description:
        'Optional. Extra terms every attendee must accept for this event, on top of the standard waiver. Leave empty if none. Changing it after people have booked creates a new waiver version.',
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
