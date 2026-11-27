import { defineArrayMember, defineField, defineType } from 'sanity'
import { DocumentIcon } from '@sanity/icons'
import { checkSlug } from '../lib/checks'
import { isSlugFree } from '../lib/slugs'
import { previousSlugs } from './fields/previousSlugs'

// A page built from modules, at /[slug] (WQ26). The home page is the one chosen in Site settings.
export const contentPage = defineType({
  name: 'contentPage',
  title: 'Page',
  type: 'document',
  icon: DocumentIcon,
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
      description: "The page's address. The home page's is not used: it is always the site's first page",
      options: { source: 'title', maxLength: 96, isUnique: isSlugFree },
      validation: (rule) => rule.required().custom((slug) => checkSlug(slug?.current, 'page')),
    }),
    previousSlugs,
    defineField({
      name: 'thumbnail',
      title: 'Thumbnail',
      type: 'picture',
      description: 'Shown in the menu when someone points at the link to this page',
    }),
    defineField({
      name: 'modules',
      title: 'Modules',
      type: 'array',
      description: 'What the page shows, top to bottom',
      of: [defineArrayMember({ type: 'heroMedia' }), defineArrayMember({ type: 'upcomingEvents' })],
    }),
    defineField({ name: 'seo', title: 'SEO', type: 'seo' }),
  ],
  preview: {
    select: {
      title: 'title',
      subtitle: 'slug.current',
      media: 'thumbnail',
    },
  },
})
