import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { EVENTS_LIST_ID } from '@/lib/events/event'
import { SECTION_THEMES } from '@/lib/modules/section'

import {
  checkLinkPart,
  checkModuleButtonPart,
  checkSectionId,
  checkSectionIdUnique,
  checkSectionLink,
  EVENTS_SECTION_ID,
  sectionIdsOf,
  type PageModuleValue,
} from '../../../studio/lib/checks'
import { WEBHOOK_FIELDS } from '../../scripts/check-fast-level.mjs'

// Brief W80: the content modules in the Studio, the section settings every module has (WQ81, WQ83), and what the
// Studio refuses about them (studio/lib/checks.ts: plain functions, no Sanity import).

const STUDIO = path.resolve(__dirname, '../../../studio')
const studioFile = (file: string) => readFileSync(path.join(STUDIO, file), 'utf8')

/** The modules a page can hold, each with its file under schemaTypes/objects/. */
const MODULES = ['heroMedia', 'upcomingEvents', 'pageHeader', 'galleryCarousel', 'accordionList', 'textMediaSticky', 'textBlock', 'sectionSpacer']
const NEW_MODULES = MODULES.slice(2)

const PAGE: PageModuleValue[] = [
  { _key: 'a', _type: 'pageHeader', sectionId: 'top' },
  { _key: 'b', _type: 'textBlock', sectionId: 'memberships' },
  { _key: 'c', _type: 'upcomingEvents' },
  { _key: 'd', _type: 'upcomingEvents' },
  { _key: 'e', _type: 'textBlock' },
]

describe('section settings: a theme and a Section ID on every module', () => {
  it('every module of a page has both, in the one closed group, from the one place', () => {
    for (const name of MODULES) {
      const source = studioFile(`schemaTypes/objects/${name}.ts`)
      expect(source, name).toContain("import { sectionFields, sectionFieldset } from '../fields/sectionSettings'")
      expect(source, name).toContain('fieldsets: [sectionFieldset],')
      expect(source, name).toMatch(/\.\.\.sectionFields\(/)
    }
    const settings = studioFile('schemaTypes/fields/sectionSettings.ts')
    expect(settings).toContain("export const sectionFieldset = { name: SECTION_FIELDSET, title: 'Section settings', options: { collapsible: true, collapsed: true } }")
    expect(settings).toMatch(/name: 'theme',\s+title: 'Theme',\s+type: 'string',\s+fieldset: SECTION_FIELDSET,/)
    expect(settings).toMatch(/name: 'sectionId',\s+title: 'Section ID',\s+type: 'string',\s+fieldset: SECTION_FIELDSET,/)
    // Light, Dark, Fjord and Mud, as the site reads them; none chosen is Light.
    expect([...settings.matchAll(/\{ title: '[A-Z][a-z]+', value: '([a-z]+)' \}/g)].map((match) => match[1])).toEqual([...SECTION_THEMES])
    expect(settings).not.toContain('initialValue')
  })

  it('a page can hold each of them, and every module is registered', () => {
    const page = studioFile('schemaTypes/contentPage.ts')
    const index = studioFile('schemaTypes/index.ts')
    for (const name of MODULES) {
      expect(page, name).toContain(`defineArrayMember({ type: '${name}' })`)
      expect(index, name).toMatch(new RegExp(`\\n  ${name},\\n`))
    }
    for (const block of ['leadText', 'moduleButton', 'accordionItem']) expect(index, block).toMatch(new RegExp(`\\n  ${block},\\n`))
  })

  it('a Section ID is lowercase letters, numbers and hyphens, or none', () => {
    for (const id of [undefined, '', 'memberships', 'session-passes', 'a1']) expect(checkSectionId(id), String(id)).toBe(true)
    for (const id of ['Memberships', 'two words', '#passes', 'end-', 'two--hyphens']) expect(checkSectionId(id), id).toContain('lowercase letters, numbers and hyphens')
  })

  it("is the only one of its name on its page; the first events list is `events` unless it has an id of its own", () => {
    expect(EVENTS_SECTION_ID).toBe(EVENTS_LIST_ID)
    expect(sectionIdsOf(PAGE)).toEqual([
      { key: 'a', id: 'top' },
      { key: 'b', id: 'memberships' },
      { key: 'c', id: 'events' },
    ])
    expect(sectionIdsOf(undefined)).toEqual([])
    expect(checkSectionIdUnique('memberships', 'b', PAGE)).toBe(true)
    expect(checkSectionIdUnique('passes', 'e', PAGE)).toBe(true)
    expect(checkSectionIdUnique(undefined, 'e', PAGE)).toBe(true)
    expect(checkSectionIdUnique('memberships', 'e', PAGE)).toBe('Another section on this page has the ID "memberships".')
    // The events list's own `events` counts, though nobody typed it.
    expect(checkSectionIdUnique('events', 'e', PAGE)).toContain('the Upcoming Events list is')
    // An events list given another id is no longer `events`.
    const renamed = PAGE.map((module) => (module._key === 'c' ? { ...module, sectionId: 'whats-on' } : module))
    expect(checkSectionIdUnique('events', 'e', renamed)).toBe(true)
    expect(sectionIdsOf(renamed).map((section) => section.id)).toEqual(['top', 'memberships', 'whats-on'])
  })
})

describe('a link to a section on this page (WQ83)', () => {
  it('is one of the places a link can go, with the section\'s ID to type', () => {
    const link = studioFile('schemaTypes/objects/linkTo.ts')
    expect(link).toContain("{ title: 'A section on this page', value: 'section' },")
    expect(link).toMatch(/name: 'sectionId',\s+title: 'Section ID',\s+type: 'string',\s+description: '[^']+',\s+hidden: \(\{ parent \}\) => linkOf\(parent\)\?\.destination !== 'section',/)
    expect(checkLinkPart('section', undefined, { destination: 'section' })).toBe("Type the section's ID.")
    expect(checkLinkPart('section', 'passes', { destination: 'section' })).toBe(true)
    expect(checkLinkPart('section', undefined, { destination: 'shop' })).toBe(true)
  })

  it('goes to a section the page has; only a page built from modules has sections', () => {
    const to = (sectionId: string) => ({ destination: 'section', sectionId })
    expect(checkSectionLink(to('memberships'), 'contentPage', PAGE)).toBe(true)
    expect(checkSectionLink(to('events'), 'contentPage', PAGE)).toBe(true)
    expect(checkSectionLink(to('passes'), 'contentPage', PAGE)).toContain('No section on this page has the ID "passes"')
    expect(checkSectionLink(to('Not An Id'), 'contentPage', PAGE)).toContain('lowercase letters, numbers and hyphens')
    expect(checkSectionLink(to('memberships'), 'navigation', undefined)).toContain('Only a link on a page built from modules')
    expect(checkSectionLink(to('memberships'), 'infoPage', undefined)).toContain('Only a link on a page built from modules')
    // Any other link is not asked.
    expect(checkSectionLink({ destination: 'shop' }, 'navigation', undefined)).toBe(true)
    expect(checkSectionLink(undefined, 'contentPage', PAGE)).toBe(true)
  })
})

describe('the content modules', () => {
  it("a module's button has both its words and its link, or neither", () => {
    expect(checkModuleButtonPart('text', undefined)).toBe(true)
    expect(checkModuleButtonPart('link', {})).toBe(true)
    expect(checkModuleButtonPart('text', { link: { destination: 'shop' } })).toBe('Type the words on the button.')
    expect(checkModuleButtonPart('link', { text: 'Book' })).toBe('Choose where the button goes.')
    expect(checkModuleButtonPart('text', { text: 'Book', link: { destination: 'book' } })).toBe(true)
    expect(checkModuleButtonPart('link', { text: 'Book', link: { destination: 'book' } })).toBe(true)
    expect(checkModuleButtonPart('link', { text: '  ' })).toBe(true)
  })

  it('PageHeader has a title, an intro, a layout and up to two buttons', () => {
    const header = studioFile('schemaTypes/objects/pageHeader.ts')
    expect(header).toMatch(/name: 'title',[\s\S]*?validation: \(rule\) => rule\.required\(\),/)
    expect(header).toContain("defineField({ name: 'intro', title: 'Intro', type: 'leadText'")
    expect(header).toMatch(/name: 'buttons',[\s\S]*?of: \[defineArrayMember\(\{ type: 'moduleButton' \}\)\],\s+validation: \(rule\) => rule\.max\(2\),/)
    expect([...header.matchAll(/value: '(split|stacked)'/g)].map((match) => match[1])).toEqual(['split', 'stacked'])
  })

  it('WQ43: every picture or video of a module is the one media block, never a field of its own', () => {
    expect(studioFile('schemaTypes/objects/galleryCarousel.ts')).toMatch(/name: 'items',[\s\S]*?of: \[defineArrayMember\(\{ type: 'media' \}\)\],/)
    expect(studioFile('schemaTypes/objects/textMediaSticky.ts')).toContain("defineField({ name: 'media', title: 'Image or Video', type: 'media'")
    for (const name of NEW_MODULES) {
      const source = studioFile(`schemaTypes/objects/${name}.ts`)
      expect(source, name).not.toMatch(/type: '(image|file|picture)'/)
    }
  })

  it("the large text is paragraphs only (Figma draws no bold, bullet or link in H2); an accordion's answer is the one rich text", () => {
    const lead = studioFile('schemaTypes/objects/leadText.ts')
    expect(lead).toContain('lists: [],')
    expect(lead).toContain('marks: { decorators: [], annotations: [] },')
    expect(studioFile('schemaTypes/objects/accordionList.ts')).toContain("defineField({ name: 'answer', title: 'Answer', type: 'richText'")
  })

  it('each module names itself and shows its heading or its first picture in the list of modules', () => {
    for (const name of NEW_MODULES) {
      const source = studioFile(`schemaTypes/objects/${name}.ts`)
      expect(source, name).toMatch(/preview: \{\s+select: \{/)
      expect(source, name).toMatch(/title: '[A-Z][^']+',\s+type: 'object',\s+icon: [A-Za-z]+Icon,/)
    }
    for (const name of ['galleryCarousel', 'textMediaSticky']) expect(studioFile(`schemaTypes/objects/${name}.ts`), name).toMatch(/media: /)
  })

  it("webhook safety: the Worker's Sanity webhook reads none of them, nor a link, a page or the section settings", () => {
    const read = Object.keys(WEBHOOK_FIELDS)
    for (const name of [...MODULES, 'contentPage', 'linkTo', 'leadText', 'moduleButton', 'accordionItem']) expect(read, name).not.toContain(name)
    const webhook = readFileSync(path.resolve(__dirname, '../../app/api/sanity/webhook/route.ts'), 'utf8')
    for (const name of [...MODULES, 'contentPage', 'modules', 'sectionId']) expect(webhook, name).not.toContain(name)
  })
})
