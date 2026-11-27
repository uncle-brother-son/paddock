import type { ModuleButton, Paragraph } from '@/lib/modules/content'

// For the stories of W80's content modules (Modules/Content): Figma's own sample words, the two frames, and each
// variant in Dark. Each module has one story for each of Figma's variants, under Figma's own name for it
// ("Device=desktop, Type=split"), in Light, and the same again in Dark.

/** Figma's sample text in every content module. */
export const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Etiam urna magna, condimentum et erat nec, sagittis mollis sapien. Fusce ornare sed elit sit amet pharetra. Phasellus commodo nec turpis id faucibus.'

export const SAMPLE_TEXT: Paragraph[] = [{ key: 'p1', text: LOREM }]

/** Two paragraphs, as "The Herd" has on Memberships & Passes. */
export const SAMPLE_PARAGRAPHS: Paragraph[] = [
  { key: 'p1', text: 'More than a membership. A community.' },
  { key: 'p2', text: 'The Herd is our way of celebrating those who make The Paddock part of their routine.' },
]

export const SAMPLE_BUTTON: ModuleButton = { text: 'Label', href: '/shop' }

/** Figma's two frames: 1440 and 390 wide. */
export const DESKTOP = { viewport: { value: 'desktop', isRotated: false } }
export const MOBILE = { viewport: { value: 'mobile', isRotated: false } }

/** The same story in Dark: the toolbar's Theme, set for it. */
export const inDark = <Story extends { globals?: Record<string, unknown> }>(story: Story): Story => ({ ...story, globals: { ...story.globals, theme: 'dark' } })

export const box = (element: Element): DOMRect => element.getBoundingClientRect()

/** To a hundredth of a pixel: Figma's halves and quarters (506.25) are kept, a browser's long tails are not. */
export const near = (value: number): number => Math.round(value * 100) / 100

/** The site's fonts are in before anything is measured: a line of capitals is a pixel shorter in a fallback font. */
export async function fontsIn(...texts: Element[]): Promise<void> {
  await document.fonts.ready
  await Promise.all(texts.map((text) => document.fonts.load(getComputedStyle(text).font)))
}
