import { defineArrayMember, defineType } from 'sanity'
import { checkLinkSet, type LinkTo } from '../../lib/checks'

/** The one rich text: paragraphs, bullets, bold and links (WQ6). */
export const richText = defineType({
  name: 'richText',
  title: 'Text',
  type: 'array',
  of: [
    defineArrayMember({
      type: 'block',
      styles: [{ title: 'Paragraph', value: 'normal' }],
      lists: [{ title: 'Bullets', value: 'bullet' }],
      marks: {
        decorators: [{ title: 'Bold', value: 'strong' }],
        annotations: [
          {
            name: 'link',
            title: 'Link',
            type: 'linkTo',
            validation: (rule) => rule.custom((value) => checkLinkSet(value as LinkTo | undefined)),
          },
        ],
      },
    }),
  ],
})
