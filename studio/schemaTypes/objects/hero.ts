import { defineField, defineType } from 'sanity'
import { ImageIcon } from '@sanity/icons'
import { checkButtonText } from '../../lib/checks'

const shown = (parent: unknown): boolean => Boolean((parent as { showButton?: boolean } | undefined)?.showButton)

/**
 * A page module: the Hero (WQ24; W73b, Wayne: a module any page can use, not a part of every page). An image or a
 * video across the whole window, and an optional button. A video's file for phones is the media block's own (WQ35).
 */
export const hero = defineType({
  name: 'hero',
  title: 'Hero',
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
      description: 'Leave empty for a button that opens the booking panel, as on the home page',
      hidden: ({ parent }) => !shown(parent),
    }),
  ],
  preview: {
    select: { kind: 'media.kind', image: 'media.image', poster: 'media.poster', showButton: 'showButton', buttonText: 'buttonText' },
    prepare({ kind, image, poster, showButton, buttonText }) {
      return { title: 'Hero', subtitle: showButton && buttonText ? `Button: ${buttonText}` : undefined, media: kind === 'video' ? poster : image }
    },
  },
})
