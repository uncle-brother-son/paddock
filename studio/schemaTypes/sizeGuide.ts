import { defineArrayMember, defineField, defineType } from 'sanity'
import { ThListIcon } from '@sanity/icons'
import { checkRowCells } from '../lib/checks'

// A table and notes, shared by every product that picks it (WQ6 item 5).
export const sizeGuide = defineType({
  name: 'sizeGuide',
  title: 'Size Guide',
  type: 'document',
  icon: ThListIcon,
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'columns',
      title: 'Columns',
      type: 'array',
      of: [defineArrayMember({ type: 'string' })],
      description: 'The headings along the top, e.g. Size, Chest (cm), Length (cm)',
      validation: (rule) => rule.required().min(1),
    }),
    defineField({
      name: 'rows',
      title: 'Rows',
      type: 'array',
      of: [
        defineArrayMember({
          name: 'sizeGuideRow',
          title: 'Row',
          type: 'object',
          fields: [
            defineField({
              name: 'cells',
              title: 'Cells',
              type: 'array',
              of: [defineArrayMember({ type: 'string' })],
              description: 'One for each column, in the same order',
              validation: (rule) =>
                rule.custom((cells, context) => checkRowCells(cells as unknown[] | undefined, context.document?.columns as unknown[] | undefined)),
            }),
          ],
          preview: {
            select: { cells: 'cells' },
            prepare({ cells }) {
              return { title: Array.isArray(cells) ? cells.join(' / ') : 'Empty row' }
            },
          },
        }),
      ],
      validation: (rule) => rule.required().min(1),
    }),
    defineField({ name: 'notes', title: 'Notes', type: 'richText' }),
  ],
  preview: { select: { title: 'title' } },
})
