// How a Figma name becomes the name used in app/globals.css. tokens.test.ts walks lib/design/figma-tokens.json with
// these and fails when the stylesheet has no such token or a different value; Storybook's foundation pages use the
// same functions, so a page shows each token under its Figma name.

/** The four theme modes, as `data-theme` values. Figma: Light, Dark, Fjord, Mud. */
export const THEME_MODES = ['light', 'dark', 'fjord', 'mud'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

const kebab = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '-')

/** Figma palette name to its variable: "100/Sand Light" is --color-sand-light, "65/Black" is --color-black-65. */
export function paletteVariable(figmaName: string): string {
  const [opacity, name] = figmaName.split('/')
  if (!opacity || !name) throw new Error(`Not a palette name: ${figmaName}`)
  return opacity === '100' ? `--color-${kebab(name)}` : `--color-${kebab(name)}-${opacity}`
}

/** Figma theme colour to its variable: "Surface/Card Selected" is --color-surface-card-selected. */
export function themeVariable(figmaName: string): string {
  return `--color-${figmaName.split('/').map(kebab).join('-')}`
}

/** Figma font size to its variable: "Font/Size/28" is --text-28. */
export function fontSizeVariable(figmaName: string): string {
  const size = figmaName.split('/').at(-1)
  if (!size || !figmaName.startsWith('Font/Size/')) throw new Error(`Not a font size: ${figmaName}`)
  return `--text-${size}`
}

/** A value on Figma's "Spacing/General" scale to its variable: 16 is --spacing-16. */
export const spacingVariable = (value: number): string => `--spacing-${value}`

/** Figma corner to its variable: "Spacing/Corners/S" is --radius-s. */
export function radiusVariable(figmaName: string): string {
  const size = figmaName.split('/').at(-1)
  if (!size || !figmaName.startsWith('Spacing/Corners/')) throw new Error(`Not a corner: ${figmaName}`)
  return `--radius-${kebab(size)}`
}

/** Figma text style name to its utility class: "Hero Caps" is text-hero-caps. */
export const textStyleClass = (figmaName: string): string => `text-${kebab(figmaName)}`

/**
 * The text style classes written out in full. Tailwind only makes a utility it finds as a whole word in a source
 * file, so a page that lists the styles reads the class from here; tokens.test.ts holds this list to the Figma
 * styles and to textStyleClass.
 */
export const TEXT_STYLE_CLASSES: Readonly<Record<string, string>> = {
  'Hero Caps': 'text-hero-caps',
  H1: 'text-h1',
  H2: 'text-h2',
  H3: 'text-h3',
  'Copy 16': 'text-copy-16',
  'Copy 14': 'text-copy-14',
  'Copy 12': 'text-copy-12',
  'Bold 14': 'text-bold-14',
  'Link 14': 'text-link-14',
  'Link 12': 'text-link-12',
  'Label 12': 'text-label-12',
  'Label 10': 'text-label-10',
}
