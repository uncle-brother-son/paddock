import { defineField, defineType } from 'sanity'
import { LinkIcon } from '@sanity/icons'
import { checkLinkSet, type LinkTo } from '../../lib/checks'

/** One link in the menu or the footer. */
export const navLink = defineType({
  name: 'navLink',
  title: 'Link',
  type: 'object',
  icon: LinkIcon,
  fields: [
    defineField({
      name: 'label',
      title: 'Label',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'link',
      title: 'Link',
      type: 'linkTo',
      validation: (rule) => rule.custom((value) => checkLinkSet(value as LinkTo | undefined)),
    }),
  ],
  preview: {
    select: { title: 'label', destination: 'link.destination', page: 'link.page.title', event: 'link.event.name', url: 'link.url' },
    prepare({ title, destination, page, event, url }) {
      const goesTo: Record<string, string | undefined> = { page, event, shop: 'Shop', giftCard: 'The gift card', book: 'The booking panel', external: url }
      return { title, subtitle: goesTo[destination ?? ''] }
    },
  },
})
