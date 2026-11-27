import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, waitFor } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'

import { samplePicture } from './sample-media'
import { box, DESKTOP, fontsIn, inDark, MOBILE, near, SAMPLE_BUTTON, SAMPLE_PARAGRAPHS, SAMPLE_TEXT } from './story-parts'
import { TextMediaSticky } from './TextMediaSticky'

// Figma "TextMediaSticky" (05 Modules > Content, 1340:41787): a story for each of Figma's eight variants, under
// Figma's name for it, in Light and in Dark.

const MEDIA = { picture: samplePicture(400, 500), video: null }

const meta = {
  title: 'Modules/Content/TextMediaSticky',
  component: TextMediaSticky,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { heading: 'Header', text: SAMPLE_TEXT, button: SAMPLE_BUTTON, media: MEDIA, size: 'small', flip: false, theme: null, sectionId: null, reducedMotion: true },
} satisfies Meta<typeof TextMediaSticky>

export default meta
type Story = StoryObj<typeof meta>

const parts = (canvasElement: HTMLElement) => {
  const section = canvasElement.querySelector('[data-module="text-media-sticky"]') as HTMLElement
  return {
    section,
    copy: section.querySelector('[data-text-media="copy"]') as HTMLElement,
    heading: section.querySelector('h2') as HTMLElement,
    text: section.querySelector('[data-module-text]') as HTMLElement,
    button: section.querySelector('a') as HTMLElement,
    media: section.querySelector('[data-module-media]') as HTMLElement,
  }
}

type Place = { left: number; width: number }

/**
 * One variant, by Figma's own places: the words' column and the picture (always 4 by 5, on Object/Product Bg with
 * 4px corners), with `padding` above and below.
 * - From 768px they share a row, each starting at the section's padding.
 * - Below, the words come first and the picture 80px under them; with Size=big and Flip=yes the picture comes first.
 * - Size=small: the heading in Label 12, 40px under it the text in H2, 40px under that the button.
 * - Size=big: the text in H1 and, 80px under it, the button; the heading is for screen readers only (see the component).
 */
const variant = (globals: typeof DESKTOP, size: 'small' | 'big', flip: boolean, copyAt: Place, mediaAt: Place): Story => ({
  globals,
  args: { size, flip },
  play: async ({ canvas, canvasElement }) => {
    const { section, copy, heading, text, button, media } = parts(canvasElement)
    await fontsIn(heading, text)
    const desktop = globals === DESKTOP
    const padding = desktop ? 120 : 80
    await expect([section.dataset.size, section.dataset.flip]).toEqual([size, flip ? 'yes' : 'no'])
    await expect(canvas.getByRole('region', { name: 'Header' })).toBe(section)
    await expect([near(box(copy).left), near(box(copy).width)]).toEqual([copyAt.left, copyAt.width])
    await expect([near(box(media).left), near(box(media).width), near(box(media).height)]).toEqual([mediaAt.left, mediaAt.width, near(mediaAt.width * 1.25)])
    await expect([getComputedStyle(media).borderRadius, getComputedStyle(media).backgroundColor]).toEqual(['4px', painted(section, 'bg-object-product-bg')])
    await expect([getComputedStyle(text).color, getComputedStyle(button).backgroundColor]).toEqual([painted(section, 'text-text-primary', 'color'), painted(section, 'bg-surface-card')])
    if (size === 'small') {
      await expect([getComputedStyle(heading).fontSize, getComputedStyle(text).fontSize]).toEqual(['12px', desktop ? '24px' : '22px'])
      await expect([near(box(text).top - box(heading).bottom), near(box(button).top - box(text).bottom)]).toEqual([40, 40])
    } else {
      // Figma's Font/Size/28 with the headers' letter spacing: the H1 style (24px below 768px).
      await expect([getComputedStyle(text).fontSize, getComputedStyle(text).letterSpacing]).toEqual([desktop ? '28px' : '24px', '0.6px'])
      await expect(near(box(button).top - box(text).bottom)).toBe(80)
      await expect(box(heading).width).toBeLessThanOrEqual(1)
    }
    const first = size === 'small' ? heading : text
    if (desktop) {
      // One row: the words and the picture both start at the section's padding.
      await expect([near(box(first).top - box(section).top), near(box(media).top - box(section).top), near(box(section).bottom - box(media).bottom)]).toEqual([padding, padding, padding])
    } else if (size === 'big' && flip) {
      await expect([near(box(media).top - box(section).top), near(box(first).top - box(media).bottom), near(box(section).bottom - box(button).bottom)]).toEqual([padding, 80, padding])
    } else {
      await expect([near(box(first).top - box(section).top), near(box(media).top - box(button).bottom), near(box(section).bottom - box(media).bottom)]).toEqual([padding, 80, padding])
    }
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
  },
})

/** Device=desktop, Flip=no, Size=small (1678:6494): the words on 9 columns from the second (75), the picture on 8 from the sixteenth (901; 464 by 580). Figma's own copy is 524 wide, a pixel more than 9 columns. */
export const DesktopSmall: Story = { ...variant(DESKTOP, 'small', false, { left: 75, width: 523 }, { left: 901, width: 464 }), name: 'Device=desktop, Flip=no, Size=small' }
export const DesktopSmallDark: Story = { ...inDark(DesktopSmall), name: 'Device=desktop, Flip=no, Size=small (Dark)' }

/** Device=mobile, Flip=no, Size=small (1678:6508): the words on the first five columns (16, 297 wide), the picture on the last four (138; 236 by 295). */
export const MobileSmall: Story = { ...variant(MOBILE, 'small', false, { left: 16, width: 297 }, { left: 138, width: 236 }), name: 'Device=mobile, Flip=no, Size=small' }
export const MobileSmallDark: Story = { ...inDark(MobileSmall), name: 'Device=mobile, Flip=no, Size=small (Dark)' }

/** Device=desktop, Flip=yes, Size=small (1678:6516): the picture from the second column (75), the words from the fifteenth (842). */
export const DesktopSmallFlip: Story = { ...variant(DESKTOP, 'small', true, { left: 842, width: 523 }, { left: 75, width: 464 }), name: 'Device=desktop, Flip=yes, Size=small' }
export const DesktopSmallFlipDark: Story = { ...inDark(DesktopSmallFlip), name: 'Device=desktop, Flip=yes, Size=small (Dark)' }

/** Device=mobile, Flip=yes, Size=small (1678:6530): the words on the last five columns (77), the picture on the first four (16). */
export const MobileSmallFlip: Story = { ...variant(MOBILE, 'small', true, { left: 77, width: 297 }, { left: 16, width: 236 }), name: 'Device=mobile, Flip=yes, Size=small' }
export const MobileSmallFlipDark: Story = { ...inDark(MobileSmallFlip), name: 'Device=mobile, Flip=yes, Size=small (Dark)' }

/** Device=desktop, Flip=no, Size=big (1340:41786): the words on the first 10 columns (16, 582 wide), the picture on the last 9 (901; 523 by 653.75). */
export const DesktopBig: Story = { ...variant(DESKTOP, 'big', false, { left: 16, width: 582 }, { left: 901, width: 523 }), name: 'Device=desktop, Flip=no, Size=big' }
export const DesktopBigDark: Story = { ...inDark(DesktopBig), name: 'Device=desktop, Flip=no, Size=big (Dark)' }

/** Device=mobile, Flip=no, Size=big (1340:41785): the words, then the picture, each the grid's whole width (358; the picture 447.5 tall). */
export const MobileBig: Story = { ...variant(MOBILE, 'big', false, { left: 16, width: 358 }, { left: 16, width: 358 }), name: 'Device=mobile, Flip=no, Size=big' }
export const MobileBigDark: Story = { ...inDark(MobileBig), name: 'Device=mobile, Flip=no, Size=big (Dark)' }

/** Device=desktop, Flip=yes, Size=big (1627:12118): the picture on the first 9 columns (16), the words on the last 10 (842). */
export const DesktopBigFlip: Story = { ...variant(DESKTOP, 'big', true, { left: 842, width: 582 }, { left: 16, width: 523 }), name: 'Device=desktop, Flip=yes, Size=big' }
export const DesktopBigFlipDark: Story = { ...inDark(DesktopBigFlip), name: 'Device=desktop, Flip=yes, Size=big (Dark)' }

/** Device=mobile, Flip=yes, Size=big (1627:12126): the picture first, then the words. */
export const MobileBigFlip: Story = { ...variant(MOBILE, 'big', true, { left: 16, width: 358 }, { left: 16, width: 358 }), name: 'Device=mobile, Flip=yes, Size=big' }
export const MobileBigFlipDark: Story = { ...inDark(MobileBigFlip), name: 'Device=mobile, Flip=yes, Size=big (Dark)' }

/**
 * The words stick (Figma's StickyColumn): they start level with the picture's top and, once the page has scrolled
 * them to 80px under the window's top, stay there while the picture passes; when the picture's end reaches them
 * they leave with it. Drawn between two tall stand-in sections so there is a page to scroll.
 */
export const TheWordsStick: Story = {
  name: 'The words stick while the picture passes',
  globals: DESKTOP,
  render: (args) => (
    <>
      <div className="h-320" />
      <TextMediaSticky {...args} />
      <div className="h-[1200px]" />
    </>
  ),
  play: async ({ canvasElement }) => {
    const { copy, media } = parts(canvasElement)
    await document.fonts.ready
    const top = () => near(box(copy).top)
    const scrollBy = async (mediaTop: number) => {
      window.scrollTo(0, window.scrollY + box(media).top - mediaTop)
      await waitFor(() => expect(Math.abs(box(media).top - mediaTop)).toBeLessThan(1))
    }
    try {
      // At rest, and until they reach 80px from the window's top, the words are level with the picture.
      await expect(near(box(copy).top - box(media).top)).toBe(0)
      await scrollBy(200)
      await expect(top()).toBe(200)
      // The picture goes on up; the words stay 80px under the window's top.
      await scrollBy(0)
      await expect(top()).toBe(80)
      await scrollBy(-150)
      await expect(top()).toBe(80)
      // The picture's end reaches the words: they leave with it, never below its bottom.
      await scrollBy(-500)
      await expect(near(box(copy).bottom)).toBe(near(box(media).bottom))
    } finally {
      window.scrollTo(0, 0)
    }
  },
}

/** Below 768px nothing sticks: the words scroll with the page. */
export const NothingSticksOnAPhone: Story = {
  name: 'Nothing sticks on a phone',
  globals: MOBILE,
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(parts(canvasElement).copy).position).toBe('static')
  },
}

/** WQ79: the button is optional ("The Herd" on Memberships & Passes has none, 1849:50214), and the text can be several paragraphs. */
export const NoButton: Story = {
  name: 'No button, two paragraphs',
  globals: DESKTOP,
  args: { heading: 'The Herd', text: SAMPLE_PARAGRAPHS, button: null, flip: true },
  play: async ({ canvas, canvasElement }) => {
    const { text } = parts(canvasElement)
    await expect(canvas.queryByRole('link')).toBeNull()
    await expect(canvas.getByRole('heading', { level: 2, name: 'The Herd' })).toBeVisible()
    const [first, second] = [...text.querySelectorAll('p')]
    await expect(box(second!).top - box(first!).bottom).toBe(8)
  },
}

/** A video is drawn as HeroMedia draws one (WQ35, WQ43): Pause always, the sound button when it has sound, 16px inside the picture's bottom right corner. */
export const Video: Story = {
  name: 'Media=video',
  globals: DESKTOP,
  args: { media: { picture: samplePicture(400, 500, 'A sample video'), video: { url: 'https://example.invalid/w80-sticky.mp4', phoneUrl: null, description: 'A sample video', captionsUrl: null, hasSound: true } } },
  play: async ({ canvas, canvasElement }) => {
    const { media } = parts(canvasElement)
    await expect(media.dataset.moduleMedia).toBe('video')
    const [sound, play] = [canvas.getByRole('button', { name: 'Unmute video' }), canvas.getByRole('button', { name: 'Play video' })]
    await expect([near(box(media).right - box(play).right), near(box(media).bottom - box(play).bottom), near(box(play).left - box(sound).right)]).toEqual([16, 16, 8])
    // Nothing is fetched until it plays, and with reduced motion on it never starts by itself.
    await expect(media.querySelector('video')!.getAttribute('preload')).toBe('none')
  },
}

/** With no picture or video yet, the words stand alone in their column. */
export const NoMedia: Story = {
  name: 'No media',
  globals: DESKTOP,
  args: { media: null },
  play: async ({ canvasElement }) => {
    const { copy, media } = parts(canvasElement)
    await expect(media).toBeNull()
    await expect(near(box(copy).left)).toBe(75)
  },
}
