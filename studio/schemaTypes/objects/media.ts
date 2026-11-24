import { defineField, defineType } from 'sanity'
import { ImagesIcon } from '@sanity/icons'
import { MediaInput, PHONES_GROUP } from '../../components/MediaInput'
import { checkMediaPicture, checkMediaVideo, checkPhoneVideo, checkPoster, checkVideoDescription } from '../../lib/checks'

type Picture = Parameters<typeof checkPoster>[0]

const kindOf = (parent: unknown): string | undefined => (parent as { kind?: string } | undefined)?.kind
const isVideo = ({ parent }: { parent?: unknown }) => kindOf(parent) === 'video'
const isNotVideo = ({ parent }: { parent?: unknown }) => kindOf(parent) !== 'video'
/** For a fieldset: Sanity hands its rule the block itself as `value` (a field's rule gets the block as `parent`). */
const blockIsNotVideo = ({ value }: { value?: unknown }) => kindOf(value) !== 'video'

/**
 * An image or an MP4 file, for every gallery and hero (WQ15, WQ18). The video's other fields: docs/build-standards.md,
 * Video. WQ35 (Wayne, 24 Nov): a video is one film in a desktop file and, when an editor adds it, a file for phones,
 * each with its poster; its description, captions and "Has Sound" are said once and shared by both. An image stays
 * one file, cropped for each screen round its hotspot.
 *
 * WQ42: a video's fields are in three groups (fieldsets: the field names are as they were): Video, For phones
 * (closed until it holds something: components/MediaInput.ts) and Description & sound. A poster is a plain image
 * with a hotspot and no alt text of its own: the Video Description describes the film and both its posters. An
 * image keeps its Alt Text and Decorative switch (the picture block).
 */
export const media = defineType({
  name: 'media',
  title: 'Image or Video',
  type: 'object',
  icon: ImagesIcon,
  components: { input: MediaInput },
  fieldsets: [
    { name: 'video', title: 'Video', hidden: blockIsNotVideo },
    { name: PHONES_GROUP, title: 'For phones (optional)', options: { collapsible: true, collapsed: true }, hidden: blockIsNotVideo },
    { name: 'details', title: 'Description & sound', hidden: blockIsNotVideo },
  ],
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
      fieldset: 'video',
      options: { accept: 'video/mp4' },
      description: 'Short and compressed: under 10 MB, 1080 px wide, H.264',
      hidden: isNotVideo,
      validation: (rule) => rule.custom((value, context) => checkMediaVideo(value, kindOf(context.parent))),
    }),
    defineField({
      name: 'poster',
      title: 'Poster',
      type: 'image',
      fieldset: 'video',
      options: { hotspot: true },
      description: 'Shown until the video plays, and instead of it when motion is turned off',
      hidden: isNotVideo,
      validation: (rule) => rule.custom((value, context) => checkPoster(value as Picture, kindOf(context.parent))),
    }),
    defineField({
      name: 'mobileVideo',
      title: 'Video for Phones (MP4)',
      type: 'file',
      fieldset: PHONES_GROUP,
      options: { accept: 'video/mp4' },
      description: 'The same film cut tall, for screens narrower than 768 px',
      hidden: isNotVideo,
      validation: (rule) => rule.custom((value) => checkPhoneVideo(value)),
    }),
    defineField({
      name: 'mobilePoster',
      title: 'Poster for Phones',
      type: 'image',
      fieldset: PHONES_GROUP,
      options: { hotspot: true },
      description: 'Without one, the poster above is cropped round its hotspot',
      hidden: isNotVideo,
    }),
    defineField({
      name: 'videoDescription',
      title: 'Video Description',
      type: 'string',
      fieldset: 'details',
      description: "What the video shows, for people who can't see it. Also used for the posters",
      hidden: isNotVideo,
      validation: (rule) => rule.custom((value, context) => checkVideoDescription(value, kindOf(context.parent))),
    }),
    defineField({
      name: 'captions',
      title: 'Captions (WebVTT)',
      type: 'file',
      fieldset: 'details',
      options: { accept: '.vtt,text/vtt' },
      description: 'Needed only when someone speaks in the video',
      hidden: isNotVideo,
    }),
    defineField({
      name: 'hasSound',
      title: 'Has Sound',
      type: 'boolean',
      fieldset: 'details',
      description: 'Gives visitors a sound button. A video always starts silent',
      initialValue: false,
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
