import { defineArrayMember, defineType } from 'sanity'

/**
 * W80: the large text of a content module (PageHeader's intro, TextMediaSticky's and TextBlock's text), which the
 * site sets in Figma's H2 (H1 for TextMediaSticky's big size). Paragraphs only: Figma draws no bold, no bullets and
 * no link in these styles, so none is offered here until one is designed.
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
      marks: { decorators: [], annotations: [] },
    }),
  ],
})
