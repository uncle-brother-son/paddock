import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useEffect, useState } from 'react'
import { expect, fireEvent, userEvent, waitFor } from 'storybook/test'

import type { HeroButton } from '@/lib/modules/hero'

import { Hero } from './Hero'
import { recordSampleVideo, SAMPLE_PICTURE } from './sample-media'

const BOOK: HeroButton = { text: 'Book Your Experience', href: '/book', opensBooking: true, outside: false }

type StoryArgs = { button: HeroButton | null; reducedMotion: boolean; video: boolean }

/** A hero with the sample video, once it has been made (a second or so). */
function HeroWithSampleVideo({ button, reducedMotion }: { button: HeroButton | null; reducedMotion: boolean }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let wanted = true
    void recordSampleVideo().then((made) => {
      if (wanted) setUrl(made)
    })
    return () => {
      wanted = false
    }
  }, [])
  if (!url) return <p className="p-16 text-copy-14">Making a sample video…</p>
  return <Hero media={{ kind: 'video', url, poster: SAMPLE_PICTURE, description: 'A sample video', captionsUrl: null }} button={button} reducedMotion={reducedMotion} priority />
}

const meta = {
  title: 'Modules/Hero',
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { button: null, reducedMotion: false, video: false },
  render: ({ button, reducedMotion, video }) =>
    video ? (
      <HeroWithSampleVideo button={button} reducedMotion={reducedMotion} />
    ) : (
      <Hero media={{ kind: 'image', picture: SAMPLE_PICTURE }} button={button} reducedMotion={reducedMotion} priority />
    ),
} satisfies Meta<StoryArgs>

export default meta
type Story = StoryObj<typeof meta>

const heroIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-module="hero"]') as HTMLElement
const buttonIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-hero-button]') as HTMLElement
const videoIn = (canvasElement: HTMLElement) => canvasElement.querySelector('video') as HTMLVideoElement

const middle = (element: HTMLElement) => {
  const box = element.getBoundingClientRect()
  return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)]
}

/** A mouse moving over the hero, to a place measured from the hero's top left corner. */
const pointAt = (hero: HTMLElement, x: number, y: number, pointerType = 'mouse') => {
  const box = hero.getBoundingClientRect()
  fireEvent.pointerMove(hero, { clientX: box.left + x, clientY: box.top + y, pointerType })
}

/**
 * Figma Hero, Device=desktop: the picture across the whole window, 16 by 9 (810px tall on the 1440 frame), in the
 * Dark mode so the header over it has light words. A picture alone has no buttons.
 */
export const Image: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const hero = heroIn(canvasElement)
    const box = hero.getBoundingClientRect()
    await expect([Math.round(box.width), Math.round(box.height)]).toEqual([1440, 810])
    await expect(hero.dataset.theme).toBe('dark')
    const picture = canvas.getByRole('img', { name: 'A sample picture' })
    await expect(Math.round(picture.getBoundingClientRect().height)).toBe(810)
    // The page's first picture loads at once, ahead of the rest.
    await expect([picture.getAttribute('loading'), picture.getAttribute('fetchpriority')]).toEqual(['eager', 'high'])
    await expect(canvas.queryByRole('button')).toBeNull()
    await expect(canvas.queryByRole('link')).toBeNull()
  },
}

/**
 * The button (WQ24): the small primary Button with 12px all round, resting towards the bottom, centred. Move the
 * mouse over the hero and it follows the pointer, eased over the short duration with the smooth curve; it never
 * leaves the hero, and goes back to its resting place when the pointer leaves. The keyboard finds it at rest.
 */
export const ButtonFollowingThePointer: Story = {
  name: 'Button following the pointer',
  args: { button: BOOK },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const hero = heroIn(canvasElement)
    const button = buttonIn(canvasElement)
    const link = canvas.getByRole('link', { name: 'Book Your Experience' })
    await expect(link.getAttribute('href')).toBe('/book')
    await expect(getComputedStyle(link).padding).toBe('12px')
    // Surface/Secondary and Text/Secondary in the Dark mode: Sand Light with Black words.
    await expect([getComputedStyle(link).backgroundColor, getComputedStyle(link).color]).toEqual(['rgb(241, 238, 227)', 'rgb(34, 34, 34)'])
    // At rest: centred, its bottom edge 120px above the hero's.
    const rest = middle(button)
    await expect(rest[0]).toBe(720)
    await expect(Math.round(hero.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom)).toBe(120)
    // It follows the pointer...
    pointAt(hero, 1000, 300)
    await waitFor(() => expect(middle(button)).toEqual([1000, 300]))
    // ...never past the hero's edges...
    pointAt(hero, 1438, 2)
    await waitFor(() => expect(Math.round(button.getBoundingClientRect().right)).toBe(1440))
    await expect(Math.round(button.getBoundingClientRect().top)).toBe(0)
    // ...and goes back when the pointer leaves (React hears a pointer leaving as its "out" event, to nowhere inside).
    fireEvent.pointerOut(hero)
    await waitFor(() => expect(middle(button)).toEqual(rest))
    // The keyboard finds it at its resting place, wherever the pointer is.
    pointAt(hero, 300, 300)
    await waitFor(() => expect(middle(button)).toEqual([300, 300]))
    await userEvent.tab()
    await expect(link).toHaveFocus()
    await waitFor(() => expect(middle(button)).toEqual(rest))
    pointAt(hero, 500, 500)
    await expect(button.style.translate).toBe('')
  },
}

/**
 * A video (WQ15, WQ18): muted, looped and inline, playing while it is on screen; its poster shows until it does.
 * Its two buttons sit 16px in from the bottom right, 8px apart, as Figma's IconButton on a picture: the speaker
 * turns the sound on, and Pause stops it. The button goes back to its resting place while the pointer is over them.
 */
export const Video: Story = {
  args: { video: true, button: BOOK },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const pause = await canvas.findByRole('button', { name: 'Pause video' }, { timeout: 10_000 })
    const video = videoIn(canvasElement)
    const hero = heroIn(canvasElement)
    await expect([video.muted, video.loop, video.playsInline, video.paused]).toEqual([true, true, true, false])
    await expect(video.getAttribute('aria-label')).toBe('A sample video')
    const sound = canvas.getByRole('button', { name: 'Unmute video' })
    // Figma: two 28px buttons, 8px apart, 16px from the right and the bottom.
    const [soundBox, pauseBox, heroBox] = [sound, pause, hero].map((element) => element.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect]
    await expect([pauseBox.width, pauseBox.height, soundBox.width, soundBox.height]).toEqual([28, 28, 28, 28])
    await expect([heroBox.right - pauseBox.right, heroBox.bottom - pauseBox.bottom, pauseBox.left - soundBox.right]).toEqual([16, 16, 8])
    await expect(getComputedStyle(pause).backgroundColor).toMatch(/^(rgba\(241, 238, 227, 0\.65\)|color\(srgb 0\.945\S* 0\.933\S* 0\.89\S* \/ 0\.65\S*\))$/)
    // Over the video's buttons the Book button is out of the way, at rest.
    const button = buttonIn(canvasElement)
    const rest = middle(button)
    pointAt(hero, 1000, 300)
    await waitFor(() => expect(middle(button)).toEqual([1000, 300]))
    fireEvent.pointerMove(pause, { clientX: pauseBox.left + 14, clientY: pauseBox.top + 14, pointerType: 'mouse' })
    await waitFor(() => expect(middle(button)).toEqual(rest))
    await userEvent.click(pause)
    await waitFor(() => expect(video.paused).toBe(true))
    await userEvent.click(await canvas.findByRole('button', { name: 'Play video' }))
    await waitFor(() => expect(video.paused).toBe(false))
    await userEvent.click(sound)
    await waitFor(() => expect(video.muted).toBe(false))
    await userEvent.click(await canvas.findByRole('button', { name: 'Mute video' }))
    await waitFor(() => expect(video.muted).toBe(true))
  },
}

/**
 * Figma Hero, Device=mobile: 9 by 16 (693px tall on the 390 frame), with the button at its resting place: a
 * finger moves nothing.
 */
export const OnAPhone: Story = {
  name: 'On a phone',
  args: { button: BOOK },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvasElement }) => {
    const hero = heroIn(canvasElement)
    const box = hero.getBoundingClientRect()
    await expect([Math.round(box.width), Math.round(box.height)]).toEqual([390, 693])
    const button = buttonIn(canvasElement)
    const rest = middle(button)
    await expect(rest[0]).toBe(195)
    await expect(Math.round(box.bottom - button.getBoundingClientRect().bottom)).toBe(120)
    pointAt(hero, 100, 100, 'touch')
    await expect(button.style.translate).toBe('')
    await expect(middle(button)).toEqual(rest)
  },
}

/**
 * Reduced motion: the video does not start by itself, so the poster shows with Play, and the button stays at its
 * resting place. Play still plays it: the visitor asked.
 */
export const ReducedMotion: Story = {
  name: 'Reduced motion',
  args: { video: true, button: BOOK, reducedMotion: true },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const play = await canvas.findByRole('button', { name: 'Play video' }, { timeout: 10_000 })
    const video = videoIn(canvasElement)
    await expect(video.paused).toBe(true)
    await expect(getComputedStyle(video).visibility).toBe('hidden')
    await expect(canvas.getByRole('img', { name: 'A sample picture' })).toBeVisible()
    const hero = heroIn(canvasElement)
    const button = buttonIn(canvasElement)
    const rest = middle(button)
    pointAt(hero, 1000, 300)
    await expect(button.style.translate).toBe('')
    await expect(middle(button)).toEqual(rest)
    await userEvent.click(play)
    await waitFor(() => expect(video.paused).toBe(false))
    // Its button turns to Pause once the video is really playing.
    await expect(await canvas.findByRole('button', { name: 'Pause video' })).toBeVisible()
  },
}
