import { defineField, defineType } from 'sanity'
import { CalendarIcon } from '@sanity/icons'

/** A page module: the Upcoming Events list (WQ16). Which events, and their dates and prices, come from the site itself. */
export const upcomingEvents = defineType({
  name: 'upcomingEvents',
  title: 'Upcoming Events list',
  type: 'object',
  icon: CalendarIcon,
  fields: [defineField({ name: 'heading', title: 'Heading', type: 'string', description: 'Optional' })],
  preview: {
    select: { heading: 'heading' },
    prepare({ heading }) {
      return { title: 'Upcoming Events list', subtitle: heading }
    },
  },
})
