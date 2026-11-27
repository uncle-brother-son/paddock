import { defineField, defineType } from 'sanity'
import { LinkIcon } from '@sanity/icons'
import { checkLinkPart, checkSectionLink, type LinkTo, type PageModuleValue } from '../../lib/checks'

const linkOf = (parent: unknown): LinkTo | undefined => parent as LinkTo | undefined

/**
 * Where a link goes: a page, an event, the shop, the gift card, the booking panel or an outside address. The
 * references are weak, so a page that isn't published yet can be linked (the site hides the link until it is) and a
 * linked page can still be unpublished. The gift card's address is the site's own (/shop/gift-card, WQ19), and the
 * booking panel opens over whatever page the visitor is on (its link is /book), so neither has anything to pick (W73b).
 * W80 (WQ83): "A section on this page" goes to the module of the same page that has that Section ID, and the page
 * scrolls there. It is checked against the page's own modules, so it only works for a link on a page built from them.
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
          { title: 'The gift card', value: 'giftCard' },
          { title: 'The booking panel', value: 'book' },
          { title: 'A section on this page', value: 'section' },
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
      name: 'sectionId',
      title: 'Section ID',
      type: 'string',
      description: 'The Section ID of a module on this page (in its Section settings), for example memberships. The page scrolls to it',
      hidden: ({ parent }) => linkOf(parent)?.destination !== 'section',
      validation: (rule) =>
        rule.custom((value, context) => {
          const link = linkOf(context.parent)
          const filled = checkLinkPart('section', value, link)
          if (filled !== true) return filled
          const page = context.document as { _type?: string; modules?: PageModuleValue[] } | undefined
          return checkSectionLink(link, page?._type, page?.modules)
        }),
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
