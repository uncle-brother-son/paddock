import { defineField, defineType } from 'sanity'
import { LinkIcon } from '@sanity/icons'
import { checkLinkPart, type LinkTo } from '../../lib/checks'

const linkOf = (parent: unknown): LinkTo | undefined => parent as LinkTo | undefined

/**
 * Where a link goes: a page, an event, the shop or an outside address. The references are weak, so a page that isn't
 * published yet can be linked (the site hides the link until it is) and a linked page can still be unpublished.
 */
export const linkTo = defineType({
  name: 'linkTo',
  title: 'Link',
  type: 'object',
  icon: LinkIcon,
  fields: [
    defineField({
      name: 'destination',
      title: 'Goes to',
      type: 'string',
      options: {
        list: [
          { title: 'A page', value: 'page' },
          { title: 'An event', value: 'event' },
          { title: 'The shop', value: 'shop' },
          { title: 'An outside address', value: 'external' },
        ],
        layout: 'radio',
      },
    }),
    defineField({
      name: 'page',
      title: 'Page',
      type: 'reference',
      to: [{ type: 'contentPage' }, { type: 'infoPage' }],
      weak: true,
      description: 'Hidden on the site until the page is published',
      hidden: ({ parent }) => linkOf(parent)?.destination !== 'page',
      validation: (rule) => rule.custom((value, context) => checkLinkPart('page', value, linkOf(context.parent))),
    }),
    defineField({
      name: 'event',
      title: 'Event',
      type: 'reference',
      to: [{ type: 'event' }],
      weak: true,
      description: 'Hidden on the site until the event is published',
      hidden: ({ parent }) => linkOf(parent)?.destination !== 'event',
      validation: (rule) => rule.custom((value, context) => checkLinkPart('event', value, linkOf(context.parent))),
    }),
    defineField({
      name: 'url',
      title: 'Address',
      type: 'url',
      description: 'For example https://... , mailto:... or tel:...',
      hidden: ({ parent }) => linkOf(parent)?.destination !== 'external',
      validation: (rule) => [
        rule.uri({ scheme: ['https', 'http', 'mailto', 'tel'] }),
        rule.custom((value, context) => checkLinkPart('external', value, linkOf(context.parent))),
      ],
    }),
  ],
})
