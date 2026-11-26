import { defineField, defineType } from 'sanity'
import { InfoOutlineIcon } from '@sanity/icons'
import { checkSlug } from '../lib/checks'
import { isSlugFree } from '../lib/slugs'
import { previousSlugs } from './fields/previousSlugs'

// Terms, Privacy, Health & Safety and the like, at /info/[slug] (WQ26).
export const infoPage = defineType({
  name: 'infoPage',
  title: 'Info Page',
  type: 'document',
  icon: InfoOutlineIcon,
  fields: [
    defineField({
      name: 'title',
      title: 'Page Title',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      description: "The page's address, after /info/. Generate makes it from the title",
      options: { source: 'title', maxLength: 96, isUnique: isSlugFree },
      validation: (rule) => rule.required().custom((slug) => checkSlug(slug?.current, 'info')),
    }),
    previousSlugs,
    defineField({
      name: 'thumbnail',
      title: 'Thumbnail',
      type: 'picture',
      description: 'Shown in the menu when someone points at the link to this page',
    }),
    defineField({
      name: 'body',
      title: 'Text',
      type: 'richText',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'menuOrder',
      title: 'Order in the Left Menu',
      type: 'number',
      description: 'Lowest first',
      validation: (rule) => rule.required().integer(),
    }),
    defineField({ name: 'seo', title: 'SEO', type: 'seo' }),
  ],
  orderings: [{ title: 'Left menu', name: 'menuOrder', by: [{ field: 'menuOrder', direction: 'asc' }] }],
  preview: {
    select: {
      title: 'title',
      subtitle: 'slug.current',
      media: 'thumbnail',
    },
  },
})
