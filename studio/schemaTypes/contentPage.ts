import { defineArrayMember, defineField, defineType } from 'sanity'
import { DocumentIcon } from '@sanity/icons'
import { checkSlug } from '../lib/checks'
import { isSlugFree } from '../lib/slugs'
import { previousSlugs } from './fields/previousSlugs'
import { NO_THUMBNAIL_AT_FIRST, thumbnail, THUMBNAIL_PREVIEW, thumbnailMedia } from './fields/thumbnail'
import { NO_SEO_AT_FIRST } from './objects/seo'

// A page built from modules, at /[slug] (WQ26). The home page is the one chosen in Site settings.
export const contentPage = defineType({
  name: 'contentPage',
  title: 'Page',
  type: 'document',
  icon: DocumentIcon,
  initialValue: { ...NO_THUMBNAIL_AT_FIRST, ...NO_SEO_AT_FIRST },
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
    thumbnail,
    defineField({
      name: 'modules',
      title: 'Modules',
      type: 'array',
      description: 'What the page shows, top to bottom. Every module has Section settings at its foot: a theme for its section, and an ID a link can scroll to',
      of: [
        defineArrayMember({ type: 'heroMedia' }),
        defineArrayMember({ type: 'pageHeader' }),
        defineArrayMember({ type: 'galleryCarousel' }),
        defineArrayMember({ type: 'textBlock' }),
        defineArrayMember({ type: 'textMediaSticky' }),
        defineArrayMember({ type: 'accordionList' }),
        defineArrayMember({ type: 'memberships' }),
        defineArrayMember({ type: 'sessionPasses' }),
        defineArrayMember({ type: 'upcomingEvents' }),
        defineArrayMember({ type: 'sectionSpacer' }),
      ],
    }),
    defineField({ name: 'seo', title: 'SEO', type: 'seo' }),
  ],
  preview: {
    select: { title: 'title', subtitle: 'slug.current', ...THUMBNAIL_PREVIEW },
    prepare: (selected) => ({ title: selected.title, subtitle: selected.subtitle, media: thumbnailMedia(selected) }),
  },
})
