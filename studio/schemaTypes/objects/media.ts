import { defineField, defineType } from 'sanity'
import { ImagesIcon } from '@sanity/icons'
import { checkMediaPicture, checkMediaVideo, checkPhoneVideo, checkPoster, checkVideoDescription } from '../../lib/checks'

type Picture = Parameters<typeof checkPoster>[0]

const kindOf = (parent: unknown): string | undefined => (parent as { kind?: string } | undefined)?.kind
const isVideo = ({ parent }: { parent?: unknown }) => kindOf(parent) === 'video'
const isNotVideo = ({ parent }: { parent?: unknown }) => kindOf(parent) !== 'video'

/**
 * An image or an MP4 file, for every gallery and hero (WQ15, WQ18). The video's other fields: docs/build-standards.md,
 * Video. WQ35 (Wayne, 24 Nov): a video is one film in a desktop file and, when an editor adds it, a file for phones,
 * each with its poster; its description, captions and "Has Sound" are said once and shared by both. An image stays
 * one file, cropped for each screen round its hotspot.
 */
export const media = defineType({
  name: 'media',
  title: 'Image or Video',
  type: 'object',
  icon: ImagesIcon,
  fields: [
    defineField({
      name: 'kind',
      title: 'Kind',
      type: 'string',
      options: {
        list: [
          { title: 'Image', value: 'image' },
          { title: 'Video', value: 'video' },
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'image',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'image',
      title: 'Image',
      type: 'picture',
      hidden: isVideo,
      validation: (rule) => rule.custom((value, context) => checkMediaPicture(value as Picture, kindOf(context.parent))),
    }),
    defineField({
      name: 'video',
      title: 'Video (MP4)',
      type: 'file',
      options: { accept: 'video/mp4' },
      description: 'Short and compressed: under 10 MB, 1080 px wide, H.264',
      hidden: isNotVideo,
      validation: (rule) => rule.custom((value, context) => checkMediaVideo(value, kindOf(context.parent))),
    }),
    defineField({
      name: 'mobileVideo',
      title: 'Video for Phones (MP4)',
      type: 'file',
      options: { accept: 'video/mp4' },
      description: 'Optional: the same film cut for a tall screen, shown on screens narrower than 768 px. Leave empty to show the video above on phones too',
      hidden: isNotVideo,
      validation: (rule) => rule.custom((value) => checkPhoneVideo(value)),
    }),
    defineField({
      name: 'poster',
      title: 'Poster Image',
      type: 'picture',
      description: 'Shown before the video plays, and instead of it for people who have motion turned off',
      hidden: isNotVideo,
      validation: (rule) => rule.custom((value, context) => checkPoster(value as Picture, kindOf(context.parent))),
    }),
    defineField({
      name: 'mobilePoster',
      title: 'Poster for Phones',
      type: 'image',
      options: { hotspot: true },
      description: 'Optional. Leave empty to use the poster above on phones, cropped round its hotspot. It is described by the alt text of the poster above',
      hidden: isNotVideo,
    }),
    defineField({
      name: 'videoDescription',
      title: 'Video Description',
      type: 'string',
      description: 'What the video shows, for people who cannot see it',
      hidden: isNotVideo,
      validation: (rule) => rule.custom((value, context) => checkVideoDescription(value, kindOf(context.parent))),
    }),
    defineField({
      name: 'hasSound',
      title: 'Has Sound',
      type: 'boolean',
      description: 'Switch on when the video has sound (the one for phones too): visitors then get a button to turn it on. A video always starts silent',
      initialValue: false,
      hidden: isNotVideo,
    }),
    defineField({
      name: 'captions',
      title: 'Captions (WebVTT)',
      type: 'file',
      options: { accept: '.vtt,text/vtt' },
      description: 'Needed only when someone speaks in the video',
      hidden: isNotVideo,
    }),
  ],
  preview: {
    select: { kind: 'kind', alt: 'image.alt', description: 'videoDescription', image: 'image', poster: 'poster' },
    prepare({ kind, alt, description, image, poster }) {
      return kind === 'video'
        ? { title: description || 'Video', subtitle: 'Video', media: poster }
        : { title: alt || 'Image', subtitle: 'Image', media: image }
    },
  },
})
