import { defineArrayMember, defineType } from 'sanity'
import { checkLinkSet, type LinkTo } from '../../lib/checks'

/**
 * W80: the large text of a content module (PageHeader's intro, TextMediaSticky's and TextBlock's text), which the
 * site sets in Figma's H2 (H1 for TextMediaSticky's big size). WQ89 (Wayne, 27 Nov): paragraphs and links only, no
 * bold and no bullets. A link is the one rich text's link (WQ6), drawn in the site's TextLink style.
 */
export const leadText = defineType({
  name: 'leadText',
  title: 'Large Text',
  type: 'array',
  of: [
    defineArrayMember({
      type: 'block',
      styles: [{ title: 'Paragraph', value: 'normal' }],
      lists: [],
      marks: {
        decorators: [],
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
