import { defineArrayMember, defineField, defineType } from 'sanity'
import { ImagesIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'

type Item = { kind?: string; image?: unknown; poster?: unknown }

/**
 * A page module: GalleryCarousel (W80, WQ82; Figma "GalleryCarousel", which was GalleryThreeUp). A row of pictures
 * and videos to drag or swipe sideways. Each is the one media block (WQ43) and keeps its own shape on the site.
 */
export const galleryCarousel = defineType({
  name: 'galleryCarousel',
  title: 'Gallery Carousel',
  type: 'object',
  icon: ImagesIcon,
  fieldsets: [sectionFieldset],
  fields: [
    defineField({
      name: 'items',
      title: 'Images and Videos',
      type: 'array',
      description: 'In the order they are shown, left to right, as many as you like. All are the same height and each keeps its own whole shape, never cut: an upright picture is narrower, a wide one or a panorama wider. Crop a picture to change its shape',
      of: [defineArrayMember({ type: 'media' })],
      validation: (rule) => rule.min(1),
    }),
    ...sectionFields(),
  ],
  preview: {
    select: { items: 'items' },
    prepare({ items }) {
      const list = (items ?? []) as Item[]
      const first = list[0]
      return {
        title: 'Gallery Carousel',
        subtitle: list.length === 1 ? '1 image or video' : `${list.length} images and videos`,
        media: (first?.kind === 'video' ? first.poster : first?.image) as never,
      }
    },
  },
})
