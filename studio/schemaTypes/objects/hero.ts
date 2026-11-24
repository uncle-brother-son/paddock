import { defineField, defineType } from 'sanity'
import { checkButtonText } from '../../lib/checks'

const shown = (parent: unknown): boolean => Boolean((parent as { showButton?: boolean } | undefined)?.showButton)

/** The home page's hero (WQ24): an image or video, and an optional button. */
export const hero = defineType({
  name: 'hero',
  title: 'Hero',
  type: 'object',
  options: { collapsible: true, collapsed: false },
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
      description: 'Leave empty on the home page, where the button opens the booking panel',
      hidden: ({ parent }) => !shown(parent),
    }),
  ],
})
