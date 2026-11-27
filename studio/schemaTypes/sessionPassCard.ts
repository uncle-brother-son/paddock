import { defineField, defineType } from 'sanity'
import { TagIcon } from '@sanity/icons'
import { cardPlansLine, checkCardPlans, type Reference } from '../lib/checks'

/**
 * A Session Pass card (W81; WQ84): website only. It groups a size's two passes (5 Session - Core and 5 Session -
 * All-Access) under one name. Prices, how long a pass lasts ("Valid for 3 months") and whether it is on sale are
 * never here: the site reads them from the database by each pass. The Worker's Sanity webhook does not read this type.
 */
export const sessionPassCard = defineType({
  name: 'sessionPassCard',
  title: 'Session Pass',
  type: 'document',
  icon: TagIcon,
  fields: [
    defineField({ name: 'name', title: 'Name', type: 'string', description: 'The name on the card, for example "5 Session"', validation: (rule) => rule.required() }),
    defineField({ name: 'line', title: 'Line above the name', type: 'string', description: 'For example "Session Pass"', initialValue: 'Session Pass' }),
    defineField({
      name: 'corePass',
      title: 'Core pass',
      type: 'reference',
      to: [{ type: 'sessionPassType' }],
      description: 'The pass sold as "Core" on this card. Leave empty and the card does not offer Core',
    }),
    defineField({
      name: 'allAccessPass',
      title: 'All-Access pass',
      type: 'reference',
      to: [{ type: 'sessionPassType' }],
      description: 'The pass sold as "All-Access" on this card. Leave empty and the card does not offer All-Access',
      validation: (rule) =>
        rule.custom((value, context) => checkCardPlans((context.document as { corePass?: Reference } | undefined)?.corePass, value as Reference | undefined, 'pass')),
    }),
    defineField({
      name: 'order',
      title: 'Order',
      type: 'number',
      description: 'Where the card comes in the row: the lowest number first',
      validation: (rule) => rule.integer(),
    }),
  ],
  orderings: [{ title: 'Order', name: 'order', by: [{ field: 'order', direction: 'asc' }] }],
  preview: {
    select: { name: 'name', core: 'corePass.name', allAccess: 'allAccessPass.name' },
    prepare({ name, core, allAccess }) {
      return { title: name || 'Session Pass', subtitle: cardPlansLine(core, allAccess, 'pass') }
    },
  },
})
