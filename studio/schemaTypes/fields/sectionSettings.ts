import { defineField } from 'sanity'
import { checkSectionId, checkSectionIdUnique, type PageModuleValue } from '../../lib/checks'

/**
 * W80 (WQ81, WQ83): what every module of a page can be given, in one closed group at the foot of the module:
 * - a Theme for its section (Light, Dark, Fjord or Mud; none is Light), so a run of modules can sit on one colour.
 *   WQ87: when a section in another theme reaches the middle of the screen, the whole page fades to that theme;
 * - a Section ID, which is the section's anchor on the site: a link's "A section on this page" goes to it.
 * A module's type lists `sectionFieldset` in its `fieldsets` and ends its fields with `...sectionFields()`.
 */
export const SECTION_FIELDSET = 'section'

export const sectionFieldset = { name: SECTION_FIELDSET, title: 'Section settings', options: { collapsible: true, collapsed: true } }

const THEMES = [
  { title: 'Light', value: 'light' },
  { title: 'Dark', value: 'dark' },
  { title: 'Fjord', value: 'fjord' },
  { title: 'Mud', value: 'mud' },
]

type SectionWords = {
  /** The help under Theme, where a module's own differs (HeroMedia is Dark unless told). */
  theme?: string
  /** The help under Section ID, where a module's own differs (the events list is `events` unless told). */
  sectionId?: string
}

export const sectionFields = (words: SectionWords = {}) => [
  defineField({
    name: 'theme',
    title: 'Theme',
    type: 'string',
    fieldset: SECTION_FIELDSET,
    description:
      words.theme ??
      'The colours of this section. Leave empty for Light. Give the same theme to the modules next to it and they sit on one colour; when a section in another theme reaches the middle of the screen, the whole page fades to it',
    options: { list: THEMES, layout: 'radio', direction: 'horizontal' },
  }),
  defineField({
    name: 'sectionId',
    title: 'Section ID',
    type: 'string',
    fieldset: SECTION_FIELDSET,
    description:
      words.sectionId ??
      'Optional. A short name for this section, in lowercase letters, numbers and hyphens (for example memberships). A link that goes to "A section on this page" scrolls here',
    validation: (rule) =>
      rule.custom((value, context) => {
        const shape = checkSectionId(value)
        if (shape !== true) return shape
        const key = (context.parent as PageModuleValue | undefined)?._key
        return checkSectionIdUnique(value, key, (context.document as { modules?: PageModuleValue[] } | undefined)?.modules)
      }),
  }),
]
