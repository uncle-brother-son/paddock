import { defineField, defineType } from 'sanity'
import { ImageIcon } from '@sanity/icons'
import { checkButtonLink, checkButtonText, type LinkTo } from '../../lib/checks'

const shown = (parent: unknown): boolean => Boolean((parent as { showButton?: boolean } | undefined)?.showButton)

/**
 * A page module: HeroMedia (WQ24; W73b, Wayne: a module any page can use, not a part of every page; named `hero`
 * until W79, WQ79). An image or a
 * video across the whole window, and an optional button. A video's file for phones is the media block's own (WQ35).
 * WQ42: the button's words and link show only while "Show a Button" is on, and both are then required.
 */
export const heroMedia = defineType({
  name: 'heroMedia',
  title: 'Hero Media',
  type: 'object',
  icon: ImageIcon,
  fields: [
    defineField({ name: 'media', title: 'Image or Video', type: 'media' }),
    defineField({ name: 'showButton', title: 'Show a Button', type: 'boolean', initialValue: false }),
    defineField({
      name: 'buttonText',
      title: 'Button Text',
      type: 'string',
      hidden: ({ parent }) => !shown(parent),
      validation: (rule) => rule.custom((value, context) => checkButtonText(value, shown(context.parent))),
    }),
    defineField({
      name: 'buttonLink',
      title: 'Button Link',
      type: 'linkTo',
      description: 'Where the button goes. Choose "The booking panel" for a button that opens booking',
      hidden: ({ parent }) => !shown(parent),
      // WQ42: a button that shows has a link. A hero saved before this with none still works: the site sends it to
      // the booking panel.
      validation: (rule) => rule.custom((value, context) => checkButtonLink(value as LinkTo | undefined, shown(context.parent))),
    }),
  ],
  preview: {
    select: { kind: 'media.kind', image: 'media.image', poster: 'media.poster', showButton: 'showButton', buttonText: 'buttonText' },
    prepare({ kind, image, poster, showButton, buttonText }) {
      return { title: 'Hero Media', subtitle: showButton && buttonText ? `Button: ${buttonText}` : undefined, media: kind === 'video' ? poster : image }
    },
  },
})
