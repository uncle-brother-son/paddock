import { defineField, defineType } from 'sanity'
import { CalendarIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'

/**
 * A page module: the Upcoming Events list (WQ16). Which events, and their dates and prices, come from the site itself.
 * W80 (WQ81, WQ83): the section settings every module has. With no Section ID of its own, a page's first list is
 * `events` (WQ60): an Event page's "All Events" goes there.
 */
export const upcomingEvents = defineType({
  name: 'upcomingEvents',
  title: 'Upcoming Events list',
  type: 'object',
  icon: CalendarIcon,
  fieldsets: [sectionFieldset],
  fields: [
    defineField({ name: 'heading', title: 'Heading', type: 'string', description: 'Optional' }),
    ...sectionFields({
      sectionId:
        'Optional. Leave empty and this list is "events", which is where an Event page\'s "All Events" link goes. Lowercase letters, numbers and hyphens',
    }),
  ],
  preview: {
    select: { heading: 'heading' },
    prepare({ heading }) {
      return { title: 'Upcoming Events list', subtitle: heading }
    },
  },
})
