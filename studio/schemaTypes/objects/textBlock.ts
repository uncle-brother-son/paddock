import { defineField, defineType } from 'sanity'
import { TextIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'

/**
 * A page module: TextBlock (W80; Figma "TextBlock"): a heading, text and an optional button, at the left, the centre
 * or the right of the page. Each of the three is optional.
 */
export const textBlock = defineType({
  name: 'textBlock',
  title: 'Text Block',
  type: 'object',
  icon: TextIcon,
  fieldsets: [sectionFieldset],
  fields: [
    defineField({ name: 'heading', title: 'Heading', type: 'string', description: 'In small capitals, above the text' }),
    defineField({ name: 'text', title: 'Text', type: 'leadText' }),
    defineField({ name: 'button', title: 'Button', type: 'moduleButton', description: 'Optional. Leave both empty for no button' }),
    defineField({
      name: 'alignment',
      title: 'Position',
      type: 'string',
      options: {
        list: [
          { title: 'Left', value: 'left' },
          { title: 'Centre', value: 'center' },
          { title: 'Right', value: 'right' },
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'left',
    }),
    ...sectionFields(),
  ],
  preview: {
    select: { heading: 'heading', first: 'text.0.children.0.text', alignment: 'alignment' },
    prepare({ heading, first, alignment }) {
      const place = alignment === 'center' ? 'centre' : alignment === 'right' ? 'right' : 'left'
      return { title: heading || first || 'Text Block', subtitle: `Text Block, ${place}` }
    },
  },
})
