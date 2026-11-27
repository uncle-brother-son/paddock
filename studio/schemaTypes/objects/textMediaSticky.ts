import { defineField, defineType } from 'sanity'
import { SplitHorizontalIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'

/**
 * A page module: TextMediaSticky (W80; Figma "TextMediaSticky"): a heading, text and an optional button that stay in
 * place while a tall picture or video scrolls past beside them. Small or big, and either way round (Flip).
 */
export const textMediaSticky = defineType({
  name: 'textMediaSticky',
  title: 'Text & Media (sticky)',
  type: 'object',
  icon: SplitHorizontalIcon,
  fieldsets: [sectionFieldset],
  fields: [
    defineField({ name: 'heading', title: 'Heading', type: 'string', description: 'In small capitals, above the text' }),
    defineField({ name: 'text', title: 'Text', type: 'leadText' }),
    defineField({ name: 'button', title: 'Button', type: 'moduleButton', description: 'Optional. Leave both empty for no button' }),
    defineField({ name: 'media', title: 'Image or Video', type: 'media', description: 'Shown upright, 4 by 5' }),
    defineField({
      name: 'size',
      title: 'Size',
      type: 'string',
      description: 'Small: a smaller picture and text. Big: a larger picture and larger text',
      options: {
        list: [
          { title: 'Small', value: 'small' },
          { title: 'Big', value: 'big' },
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'small',
    }),
    defineField({
      name: 'flip',
      title: 'Flip',
      type: 'boolean',
      description: 'Off: the text on the left, the picture on the right. On: the picture on the left, the text on the right',
      initialValue: false,
    }),
    ...sectionFields(),
  ],
  preview: {
    select: { heading: 'heading', kind: 'media.kind', image: 'media.image', poster: 'media.poster', size: 'size', flip: 'flip' },
    prepare({ heading, kind, image, poster, size, flip }) {
      return {
        title: heading || 'Text & Media (sticky)',
        subtitle: `Text & Media (sticky), ${size === 'big' ? 'big' : 'small'}${flip ? ', flipped' : ''}`,
        media: kind === 'video' ? poster : image,
      }
    },
  },
})
