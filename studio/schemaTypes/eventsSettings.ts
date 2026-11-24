import { defineField, defineType } from 'sanity'
import { CalendarIcon } from '@sanity/icons'

// One document (WQ17 item 5).
export const eventsSettings = defineType({
  name: 'eventsSettings',
  title: 'Events Settings',
  type: 'document',
  icon: CalendarIcon,
  fields: [
    defineField({
      name: 'termsSummary',
      title: 'Event Terms Summary',
      type: 'richText',
      description: "Shown on every event's Event Terms & Conditions tab, before the event's own extra waiver",
    }),
  ],
  preview: { prepare: () => ({ title: 'Events Settings' }) },
})
