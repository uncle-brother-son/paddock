import { defineArrayMember, defineField, defineType } from 'sanity'
import { HelpCircleIcon, ThListIcon } from '@sanity/icons'
import { sectionFields, sectionFieldset } from '../fields/sectionSettings'

/** One question of an AccordionList: the words of its row, and what opens beneath them. */
export const accordionItem = defineType({
  name: 'accordionItem',
  title: 'Question',
  type: 'object',
  icon: HelpCircleIcon,
  fields: [
    defineField({ name: 'question', title: 'Question', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'answer', title: 'Answer', type: 'richText', validation: (rule) => rule.required() }),
  ],
  preview: { select: { title: 'question' } },
})

/**
 * A page module: AccordionList (W80; Figma "AccordionList"): a heading and a list of questions, each opening its
 * answer. "Space above and below" is Figma's Padding: off, the list sits straight under the module before it.
 */
export const accordionList = defineType({
  name: 'accordionList',
  title: 'Accordion List',
  type: 'object',
  icon: ThListIcon,
  fieldsets: [sectionFieldset],
  fields: [
    defineField({ name: 'heading', title: 'Heading', type: 'string', description: 'For example "Membership FAQs"' }),
    defineField({
      name: 'items',
      title: 'Questions',
      type: 'array',
      of: [defineArrayMember({ type: 'accordionItem' })],
      validation: (rule) => rule.min(1),
    }),
    defineField({
      name: 'padding',
      title: 'Space above and below',
      type: 'boolean',
      description: 'On: the section has its own space above and below. Off: none, for a list straight under another module (add a Section Spacer after it for space beneath)',
      initialValue: true,
    }),
    ...sectionFields(),
  ],
  preview: {
    select: { heading: 'heading', items: 'items' },
    prepare({ heading, items }) {
      const count = ((items ?? []) as unknown[]).length
      return { title: heading || 'Accordion List', subtitle: `Accordion List, ${count} ${count === 1 ? 'question' : 'questions'}` }
    },
  },
})
