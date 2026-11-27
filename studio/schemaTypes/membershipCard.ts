import { defineArrayMember, defineField, defineType } from 'sanity'
import { CheckmarkIcon, UserIcon } from '@sanity/icons'
import { cardPlansLine, checkCardPlans, type Reference } from '../lib/checks'

const SHOW_FOR = [
  { title: 'Both', value: 'both' },
  { title: 'Monthly only', value: 'monthly' },
  { title: 'Yearly only', value: 'yearly' },
]

/**
 * One line of a Membership card's benefits (W81; WQ86). "Show for" says under which billing the site lists it: both,
 * or only while Monthly or Yearly is chosen ("Herd benefits after 6 months" monthly, "Immediate Herd benefits" yearly).
 */
export const planBenefit = defineType({
  name: 'planBenefit',
  title: 'Benefit',
  type: 'object',
  icon: CheckmarkIcon,
  fields: [
    defineField({ name: 'text', title: 'Benefit', type: 'string', validation: (rule) => rule.required() }),
    defineField({
      name: 'showFor',
      title: 'Show for',
      type: 'string',
      description: 'Both: always listed. Monthly only or Yearly only: listed while that billing is chosen on the site',
      options: { list: SHOW_FOR, layout: 'radio', direction: 'horizontal' },
      initialValue: 'both',
    }),
  ],
  preview: {
    select: { text: 'text', showFor: 'showFor' },
    prepare({ text, showFor }) {
      return { title: text, subtitle: SHOW_FOR.find((choice) => choice.value === showFor && choice.value !== 'both')?.title }
    },
  },
})

/**
 * A Membership card (W81; WQ84): website only. It groups a level's two plans (Foal - Core and Foal - All-Access)
 * under one name with the words the site shows on its card. Prices, and whether a plan is on sale, are never here:
 * the site reads them from the database by each plan. The Worker's Sanity webhook does not read this type.
 */
export const membershipCard = defineType({
  name: 'membershipCard',
  title: 'Membership',
  type: 'document',
  icon: UserIcon,
  fields: [
    defineField({ name: 'name', title: 'Name', type: 'string', description: 'The name on the card, for example "Foal"', validation: (rule) => rule.required() }),
    defineField({ name: 'line', title: 'Line above the name', type: 'string', description: 'For example "4 Sessions a month"' }),
    defineField({
      name: 'corePlan',
      title: 'Core plan',
      type: 'reference',
      to: [{ type: 'membershipPlan' }],
      description: 'The plan sold as "Core" on this card. Leave empty and the card does not offer Core',
    }),
    defineField({
      name: 'allAccessPlan',
      title: 'All-Access plan',
      type: 'reference',
      to: [{ type: 'membershipPlan' }],
      description: 'The plan sold as "All-Access" on this card. Leave empty and the card does not offer All-Access',
      validation: (rule) =>
        rule.custom((value, context) => checkCardPlans((context.document as { corePlan?: Reference } | undefined)?.corePlan, value as Reference | undefined, 'plan')),
    }),
    defineField({
      name: 'benefits',
      title: 'Benefits',
      type: 'array',
      description: 'The ticked list under the button',
      of: [defineArrayMember({ type: 'planBenefit' })],
    }),
    defineField({
      name: 'herdBenefits',
      title: 'Herd benefits',
      type: 'array',
      description: 'The ticked list under "Herd benefits". Leave empty and that heading is not shown',
      of: [defineArrayMember({ type: 'planBenefit' })],
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
    select: { name: 'name', core: 'corePlan.name', allAccess: 'allAccessPlan.name' },
    prepare({ name, core, allAccess }) {
      return { title: name || 'Membership', subtitle: cardPlansLine(core, allAccess, 'plan') }
    },
  },
})
