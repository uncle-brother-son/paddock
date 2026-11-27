import { defineField, defineType } from 'sanity'
import { LinkIcon } from '@sanity/icons'
import { checkModuleButtonPart, type ModuleButtonValue } from '../../lib/checks'

const buttonOf = (parent: unknown): ModuleButtonValue | undefined => parent as ModuleButtonValue | undefined

/**
 * W80: a module's button (PageHeader's two, TextMediaSticky's and TextBlock's one): its words and where it goes
 * (W72's link, which can also go to a section on the same page: WQ83). Left empty there is no button; with one of
 * the two filled in, the other is asked for.
 */
export const moduleButton = defineType({
  name: 'moduleButton',
  title: 'Button',
  type: 'object',
  icon: LinkIcon,
  fields: [
    defineField({
      name: 'text',
      title: 'Button Text',
      type: 'string',
      validation: (rule) => rule.custom((_value, context) => checkModuleButtonPart('text', buttonOf(context.parent))),
    }),
    defineField({
      name: 'link',
      title: 'Button Link',
      type: 'linkTo',
      description: 'Where the button goes. "A section on this page" scrolls to a module that has that Section ID',
      validation: (rule) => rule.custom((_value, context) => checkModuleButtonPart('link', buttonOf(context.parent))),
    }),
  ],
  preview: {
    select: { text: 'text', destination: 'link.destination', sectionId: 'link.sectionId' },
    prepare({ text, destination, sectionId }) {
      return { title: text || 'Button', subtitle: destination === 'section' && sectionId ? `#${sectionId}` : undefined }
    },
  },
})
