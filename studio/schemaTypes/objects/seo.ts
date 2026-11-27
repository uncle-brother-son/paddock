import { defineField, defineType } from 'sanity'

/**
 * A new document's SEO starts empty (W83). Sanity fills a new document's fields from their types' defaults, and the
 * Share Image's (a picture, Decorative off) would give every new document an empty share picture. A document's own
 * initial value is laid over those defaults, so this one takes the SEO away again (as fields/thumbnail.ts does).
 */
export const NO_SEO_AT_FIRST = { seo: undefined }

/** Search and link previews. All optional: the site makes each from the page's own content when it is empty (WQ6 item 9). */
export const seo = defineType({
  name: 'seo',
  title: 'SEO',
  type: 'object',
  options: { collapsible: true, collapsed: true },
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      description: 'Leave empty to use the title made for this page',
      validation: (rule) => rule.max(60).warning('Over 60 characters: search results may cut it short.'),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 3,
      description: 'Leave empty to use the description made for this page',
      validation: (rule) => rule.max(155).warning('Over 155 characters: search results may cut it short.'),
    }),
    defineField({
      name: 'shareImage',
      title: 'Share Image',
      type: 'picture',
      description: 'Shown when the page is shared. Cropped to 1200 by 630',
    }),
  ],
})
