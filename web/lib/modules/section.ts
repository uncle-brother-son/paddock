// W80 (WQ81, WQ83): what every module of a page can be given: a theme for its section, and an id a link can go to.
// Nothing is imported here: the Studio's checks read this file too (studio/lib/checks.ts), so the Studio and the site
// have one rule for what a Section ID is.

/** The four modes a section can have (W73's `data-theme`). Light is the page's own. */
export const SECTION_THEMES = ['light', 'dark', 'fjord', 'mud'] as const
export type SectionTheme = (typeof SECTION_THEMES)[number]

/** A Section ID: lowercase letters, numbers and hyphens, with no hyphen at either end and no two together. */
export const SECTION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A module's Section ID as the site uses it, or null: none given, or one that is not an id (it is then left out). */
export function sectionIdOf(raw: string | null | undefined): string | null {
  const id = raw?.trim() ?? ''
  return SECTION_ID_PATTERN.test(id) ? id : null
}

/** The address of a section on the page a link is on ("#memberships"), or null when its id is not one. */
export function sectionAddress(raw: string | null | undefined): string | null {
  const id = sectionIdOf(raw)
  return id ? `#${id}` : null
}

/**
 * W81: the id a page's first module of these kinds has when an editor gives it none, as the events list is `events`
 * (WQ60): PageHeader's buttons on Memberships & Passes go to #memberships and #passes (WQ83). By the module's Sanity
 * type; the Studio's checks read this too, so a second section can't be given either id.
 */
export const DEFAULT_SECTION_IDS = { memberships: 'memberships', sessionPasses: 'passes' } as const

/** Whether an address names a place on the page it is on. */
export const isSectionAddress = (href: string): boolean => href.startsWith('#') && href.length > 1

/**
 * What each module's section is given (components/modules/content/ModuleSection.tsx). `theme`: null is Light, the
 * page's own. `sectionId`: the section's id, when an editor gave it one.
 */
export type SectionSettings = { theme: SectionTheme | null; sectionId: string | null }

// WQ87: the page's theme. When a section in another theme reaches the middle of the window, the whole page (its
// background, its words, the header) fades to that theme. components/modules/PageTheme.tsx watches, and writes the
// theme on the page's element; app/globals.css draws the fade; the header follows through `PAGE_THEME_EVENT`.

/** On a module's section that takes part in the page's fade (and follows the page's theme while it is watched). */
export const PAGE_THEMED = 'data-page-themed'

/** On the page's element while its theme is watched: `first` for the first look (no fade), then `live`. */
export const PAGE_THEME = 'data-page-theme'

/** Sent to the window when the page's theme has changed, so the header looks again at what lies beneath it. */
export const PAGE_THEME_EVENT = 'paddock:page-theme'

/** On the header while its change of theme is the page's own fade, so it fades with the page (app/globals.css). */
export const THEME_FADE = 'data-theme-fade'

/**
 * A section's theme as its section carries it, or null when it carries none: a module with no theme, or with Light,
 * is in the page's own mode and needs no mode of its own.
 */
export const themeOf = (theme: SectionTheme | null | undefined): Exclude<SectionTheme, 'light'> | null => (theme && theme !== 'light' ? theme : null)
