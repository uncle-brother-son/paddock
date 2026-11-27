import { defineArrayMember, defineField, defineType } from 'sanity'
import { BlockElementIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'

/**
 * A page module: PageHeader (W80; Figma 05 Modules > Content, "PageHeader"). The page's title and its intro, side by
 * side (split) or one above the other (stacked), with up to two buttons. Its title is the page's heading (its h1).
 */
export const pageHeader = defineType({
  name: 'pageHeader',
  title: 'Page Header',
  type: 'object',
  icon: BlockElementIcon,
  fieldsets: [sectionFieldset],
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      description: "The page's heading, in small capitals",
      validation: (rule) => rule.required(),
    }),
    defineField({ name: 'intro', title: 'Intro', type: 'leadText', description: 'The large text beside (or under) the title' }),
    defineField({
      name: 'layout',
      title: 'Layout',
      type: 'string',
      description: 'Split: the title on the left and the intro on the right. Stacked: the title above the intro. A phone shows both the same way',
      options: {
        list: [
          { title: 'Split', value: 'split' },
          { title: 'Stacked', value: 'stacked' },
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'split',
    }),
    defineField({
      name: 'buttons',
      title: 'Buttons',
      type: 'array',
      description: 'Up to two, under the intro',
      of: [defineArrayMember({ type: 'moduleButton' })],
      validation: (rule) => rule.max(2),
    }),
    ...sectionFields(),
  ],
  preview: {
    select: { title: 'title', layout: 'layout' },
    prepare({ title, layout }) {
      return { title: title || 'Page Header', subtitle: `Page Header, ${layout === 'stacked' ? 'stacked' : 'split'}` }
    },
  },
})
