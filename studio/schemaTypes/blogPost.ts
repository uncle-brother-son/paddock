import { defineType, defineField, defineArrayMember } from 'sanity'
import { DocumentTextIcon, ImagesIcon } from '@sanity/icons'

export const blogPost = defineType({
  name: 'blogPost',
  title: 'Blog Post',
  type: 'document',
  icon: DocumentTextIcon,
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: {
        source: 'title',
        maxLength: 96,
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'publishedAt',
      title: 'Published At',
      type: 'datetime',
      initialValue: () => new Date().toISOString(),
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'excerpt',
      title: 'Excerpt',
      type: 'text',
      rows: 3,
      description: 'Short summary shown in blog listing',
      validation: (rule) => rule.required().max(200),
    }),
    // W82 (WQ90): the featured picture and the pictures in the text are the one media block (WQ43): a picture, or a
    // video with its poster. A picture keeps its Alt Text (or Decorative); a video's Description describes it.
    defineField({
      name: 'featuredImage',
      title: 'Featured Image or Video',
      type: 'media',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'content',
      title: 'Content',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'block',
        }),
        defineArrayMember({
          name: 'blogMedia',
          title: 'Image or Video',
          type: 'object',
          icon: ImagesIcon,
          fields: [
            defineField({
              name: 'media',
              title: 'Image or Video',
              type: 'media',
              validation: (rule) => rule.required(),
            }),
            defineField({
              name: 'caption',
              type: 'string',
              title: 'Caption',
            }),
          ],
          preview: {
            select: { kind: 'media.kind', alt: 'media.image.alt', description: 'media.videoDescription', image: 'media.image', poster: 'media.poster', caption: 'caption' },
            prepare({ kind, alt, description, image, poster, caption }) {
              return kind === 'video'
                ? { title: caption || description || 'Video', subtitle: 'Video', media: poster }
                : { title: caption || alt || 'Image', subtitle: 'Image', media: image }
            },
          },
        }),
      ],
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'seo',
      title: 'SEO',
      type: 'object',
      fields: [
        defineField({
          name: 'metaTitle',
          title: 'Meta Title',
          type: 'string',
          validation: (rule) => rule.max(60),
        }),
        defineField({
          name: 'metaDescription',
          title: 'Meta Description',
          type: 'text',
          rows: 3,
          validation: (rule) => rule.max(160),
        }),
      ],
    }),
  ],
  preview: {
    select: {
      title: 'title',
      subtitle: 'publishedAt',
      kind: 'featuredImage.kind',
      image: 'featuredImage.image',
      poster: 'featuredImage.poster',
    },
    prepare({ title, subtitle, kind, image, poster }) {
      return {
        title,
        subtitle: subtitle ? new Date(subtitle).toLocaleDateString() : 'No date',
        media: kind === 'video' ? poster : image,
      }
    },
  },
})
