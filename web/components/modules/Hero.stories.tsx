import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useEffect, useState } from 'react'
import { expect, fireEvent, userEvent, waitFor } from 'storybook/test'

import type { HeroButton, HeroSide, HeroVideo } from '@/lib/modules/hero'

import { Hero } from './Hero'
import { recordSampleVideo, SAMPLE_PHONE_PICTURE, SAMPLE_PICTURE } from './sample-media'

const BOOK: HeroButton = { text: 'Book Your Experience', href: '/book' }

type StoryArgs = {
  button: HeroButton | null
  reducedMotion: boolean
  /** As on a touch screen: the button always at its resting place. */
  touch: boolean
  /** The hero's media is a video (made here), not a picture. */
  video: boolean
  /** The editor's "Has Sound" switch on that video. */
  hasSound: boolean
  /** What phones show: the same media, a picture of their own, or a video of their own. */
  phone: 'same' | 'picture' | 'video'
}

const videoOf = (url: string, description: string, hasSound: boolean): HeroVideo => ({ url, description, captionsUrl: null, hasSound })

/** The hero the story asks for, once any sample video it needs has been made (a second or so each). */
function SampleHero({ button, reducedMotion, touch, video, hasSound, phone }: StoryArgs) {
  const [made, setMade] = useState<{ main: string | null; phone: string | null } | null>(null)
  useEffect(() => {
    let wanted = true
    void Promise.all([video ? recordSampleVideo() : null, phone === 'video' ? recordSampleVideo('#a7bbc8') : null]).then(([main, forPhones]) => {
      if (wanted) setMade({ main, phone: forPhones })
    })
    return () => {
      wanted = false
    }
  }, [video, phone])
  if (!made) return <p className="p-16 text-copy-14">Making a sample video…</p>

  const mainVideo = made.main ? videoOf(made.main, 'A sample video', hasSound) : null
  const desktop: HeroSide = { ...SAMPLE_PICTURE.desktop, video: mainVideo }
  const mobile: HeroSide =
    phone === 'same' ? { ...SAMPLE_PICTURE.mobile, video: mainVideo } : { ...SAMPLE_PHONE_PICTURE, video: made.phone ? videoOf(made.phone, 'A sample video for phones', hasSound) : null }
  return <Hero desktop={desktop} mobile={mobile} shared={phone === 'same'} button={button} reducedMotion={reducedMotion} touch={touch} priority />
}

const meta = {
  title: 'Modules/Hero',
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { button: null, reducedMotion: false, touch: false, video: false, hasSound: false, phone: 'same' },
  render: (args) => <SampleHero {...args} />,
} satisfies Meta<StoryArgs>

export default meta
type Story = StoryObj<typeof meta>

const heroIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-module="hero"]') as HTMLElement
const buttonIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-hero-button]') as HTMLElement
const layerIn = (canvasElement: HTMLElement, shown: 'both' | 'mobile' | 'desktop') => canvasElement.querySelector(`[data-hero-media="${shown}"]`) as HTMLElement

const middle = (element: HTMLElement) => {
  const box = element.getBoundingClientRect()
  return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)]
}

/** Where the button rests: the middle of its holder, which is towards the bottom of the hero, centred. */
const restOf = (button: HTMLElement) => middle(button.parentElement as HTMLElement)

/** A pointer over the hero, at a place measured from the hero's top left corner. */
const pointAt = (hero: HTMLElement, x: number, y: number, pointerType = 'mouse') => {
  const box = hero.getBoundingClientRect()
  fireEvent.pointerMove(hero, { clientX: box.left + x, clientY: box.top + y, pointerType })
}

/** The pointer leaving the hero (React hears a pointer leaving as its "out" event, to nowhere inside). */
const pointAway = (hero: HTMLElement) => fireEvent.pointerOut(hero, { pointerType: 'mouse' })

const isSeen = (button: HTMLElement) => getComputedStyle(button).opacity === '1'
const isUnseen = (button: HTMLElement) => getComputedStyle(button).opacity === '0'

/** These stories are run on a device whose pointer is a mouse: there the button hides until it is wanted. */
const hasAMouse = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches

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
 * The button with a mouse (WQ24; Wayne, 24 Nov): the small primary Button with 12px all round. It is hidden until
 * the pointer is over the hero. Move the mouse over the hero: it fades in where the pointer is and follows it,
 * eased over the short duration with the smooth curve, never past the hero's edges. Move the mouse off the hero and
 * it fades out where it is. Press Tab: it fades in at its resting place, towards the bottom, centred, and stays
 * there while it has focus.
 */
export const ButtonFollowingThePointer: Story = {
  name: 'Button following the pointer',
  args: { button: BOOK },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(hasAMouse()).toBe(true)
    const hero = heroIn(canvasElement)
    const button = buttonIn(canvasElement)
    const link = canvas.getByRole('link', { name: 'Book Your Experience' })
    await expect(link.getAttribute('href')).toBe('/book')
    await expect(getComputedStyle(link).padding).toBe('12px')
    // Surface/Secondary and Text/Secondary in the Dark mode: Sand Light with Black words.
    await expect([getComputedStyle(link).backgroundColor, getComputedStyle(link).color]).toEqual(['rgb(241, 238, 227)', 'rgb(34, 34, 34)'])

    // Hidden until the pointer is over the hero, and not to be pressed while it is.
    await expect([isUnseen(button), getComputedStyle(button).pointerEvents, button.hasAttribute('data-shown')]).toEqual([true, 'none', false])
    // It fades in where the pointer is: there at once, with no glide from its resting place.
    pointAt(hero, 1000, 300)
    await expect(middle(button)).toEqual([1000, 300])
    await expect(button.hasAttribute('data-shown')).toBe(true)
    await waitFor(() => expect(isSeen(button)).toBe(true))
    // It follows the pointer...
    pointAt(hero, 600, 400)
    await waitFor(() => expect(middle(button)).toEqual([600, 400]))
    // ...never past the hero's edges.
    pointAt(hero, 1438, 2)
    await waitFor(() => expect(Math.round(button.getBoundingClientRect().right)).toBe(1440))
    await expect(Math.round(button.getBoundingClientRect().top)).toBe(0)
    // The pointer leaves: it fades out where it is.
    const left = middle(button)
    pointAway(hero)
    await expect(button.hasAttribute('data-shown')).toBe(false)
    await waitFor(() => expect(isUnseen(button)).toBe(true))
    await expect(middle(button)).toEqual(left)
    // Back over the hero somewhere else: it is put there at once, then fades in.
    pointAt(hero, 300, 500)
    await expect(middle(button)).toEqual([300, 500])
    await waitFor(() => expect(isSeen(button)).toBe(true))
    pointAway(hero)
    await waitFor(() => expect(isUnseen(button)).toBe(true))

    // The keyboard: it fades in at its resting place, centred and 120px above the hero's bottom, and stays while focused.
    const rest = restOf(button)
    await expect(rest[0]).toBe(720)
    await userEvent.tab()
    await expect(link).toHaveFocus()
    await expect(middle(button)).toEqual(rest)
    await expect(Math.round(hero.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom)).toBe(120)
    await waitFor(() => expect(isSeen(button)).toBe(true))
    pointAt(hero, 500, 500)
    pointAway(hero)
    await expect([button.style.translate, button.hasAttribute('data-shown')]).toEqual(['', true])
    // Focus moves on: it fades out.
    await userEvent.tab()
    await waitFor(() => expect(isUnseen(button)).toBe(true))
    // A finger, on a device that has a mouse too: the button is wanted at its resting place, and stays when the finger lifts.
    pointAt(hero, 200, 200, 'touch')
    await expect(middle(button)).toEqual(rest)
    fireEvent.pointerOut(hero, { pointerType: 'touch' })
    await waitFor(() => expect(isSeen(button)).toBe(true))
  },
}

/**
 * A video with sound (WQ15, WQ18): muted, looped and inline, playing while it is on screen; its poster shows until
 * it does. Its two buttons sit 16px in from the bottom right, 8px apart, as Figma's IconButton on a picture: the
 * speaker turns the sound on, and Pause stops it. The hero's button fades out while the pointer is over them.
 */
export const Video: Story = {
  name: 'Video with sound',
  args: { video: true, hasSound: true, button: BOOK },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const pause = await canvas.findByRole('button', { name: 'Pause video' }, { timeout: 10_000 })
    const video = canvasElement.querySelector('video') as HTMLVideoElement
    const hero = heroIn(canvasElement)
    await expect([video.muted, video.loop, video.playsInline, video.paused]).toEqual([true, true, true, false])
    await expect(video.getAttribute('aria-label')).toBe('A sample video')
    const sound = canvas.getByRole('button', { name: 'Unmute video' })
    // Figma: two 28px buttons, 8px apart, 16px from the right and the bottom.
    const [soundBox, pauseBox, heroBox] = [sound, pause, hero].map((element) => element.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect]
    await expect([pauseBox.width, pauseBox.height, soundBox.width, soundBox.height]).toEqual([28, 28, 28, 28])
    await expect([heroBox.right - pauseBox.right, heroBox.bottom - pauseBox.bottom, pauseBox.left - soundBox.right]).toEqual([16, 16, 8])
    await expect(getComputedStyle(pause).backgroundColor).toMatch(/^(rgba\(241, 238, 227, 0\.65\)|color\(srgb 0\.945\S* 0\.933\S* 0\.89\S* \/ 0\.65\S*\))$/)
    // Over the video's buttons the hero's button is out of the way: it fades out where it was.
    const button = buttonIn(canvasElement)
    pointAt(hero, 1000, 300)
    await waitFor(() => expect(isSeen(button)).toBe(true))
    fireEvent.pointerMove(pause, { clientX: pauseBox.left + 14, clientY: pauseBox.top + 14, pointerType: 'mouse' })
    await waitFor(() => expect(isUnseen(button)).toBe(true))
    await expect(middle(button)).toEqual([1000, 300])
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
 * A video whose "Has Sound" switch is off in Sanity (as it is unless an editor turns it on): there is no sound
 * button, only Pause, in the same place.
 */
export const VideoWithNoSound: Story = {
  name: 'Video with no sound',
  args: { video: true },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const pause = await canvas.findByRole('button', { name: 'Pause video' }, { timeout: 10_000 })
    await expect(canvas.getAllByRole('button')).toHaveLength(1)
    await expect(canvas.queryByRole('button', { name: /mute/i })).toBeNull()
    const [pauseBox, heroBox] = [pause, heroIn(canvasElement)].map((element) => element.getBoundingClientRect()) as [DOMRect, DOMRect]
    await expect([heroBox.right - pauseBox.right, heroBox.bottom - pauseBox.bottom]).toEqual([16, 16])
    const video = canvasElement.querySelector('video') as HTMLVideoElement
    await expect(video.muted).toBe(true)
    await userEvent.click(pause)
    await waitFor(() => expect(video.paused).toBe(true))
  },
}

/**
 * Figma Hero, Device=mobile: 9 by 16 (693px tall on the 390 frame). On a touch screen the button is always there,
 * at its resting place: a finger moves nothing.
 */
export const OnAPhone: Story = {
  name: 'On a phone',
  args: { button: BOOK, touch: true },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvasElement }) => {
    const hero = heroIn(canvasElement)
    const box = hero.getBoundingClientRect()
    await expect([Math.round(box.width), Math.round(box.height)]).toEqual([390, 693])
    const button = buttonIn(canvasElement)
    await expect(isSeen(button)).toBe(true)
    await expect(middle(button)).toEqual(restOf(button))
    await expect(middle(button)[0]).toBe(195)
    await expect(Math.round(box.bottom - button.getBoundingClientRect().bottom)).toBe(120)
    pointAt(hero, 100, 100, 'touch')
    pointAt(hero, 100, 100)
    pointAway(hero)
    await expect([button.style.translate, isSeen(button)]).toEqual(['', true])
  },
}

/**
 * Reduced motion: the video does not start by itself, so the poster shows with Play, and the button follows
 * nothing: it fades in at its resting place while the pointer is over the hero or it has focus. Play still plays
 * the video: the visitor asked.
 */
export const ReducedMotion: Story = {
  name: 'Reduced motion',
  args: { video: true, button: BOOK, reducedMotion: true },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(hasAMouse()).toBe(true)
    const play = await canvas.findByRole('button', { name: 'Play video' }, { timeout: 10_000 })
    const video = canvasElement.querySelector('video') as HTMLVideoElement
    await expect(video.paused).toBe(true)
    await expect(getComputedStyle(video).visibility).toBe('hidden')
    await expect(canvas.getByRole('img', { name: 'A sample picture' })).toBeVisible()
    const hero = heroIn(canvasElement)
    const button = buttonIn(canvasElement)
    const link = canvas.getByRole('link', { name: 'Book Your Experience' })
    const rest = restOf(button)
    // Hidden; over the hero it fades in at its resting place, wherever the pointer goes; off the hero it fades out.
    await expect(isUnseen(button)).toBe(true)
    pointAt(hero, 1000, 300)
    await waitFor(() => expect(isSeen(button)).toBe(true))
    pointAt(hero, 400, 200)
    await expect([button.style.translate, middle(button)]).toEqual(['', rest])
    pointAway(hero)
    await waitFor(() => expect(isUnseen(button)).toBe(true))
    // The keyboard brings it in too: Tab reaches the video's Play, then the button.
    await userEvent.tab()
    await expect(play).toHaveFocus()
    await userEvent.tab()
    await expect(link).toHaveFocus()
    await waitFor(() => expect(isSeen(button)).toBe(true))
    await expect(middle(button)).toEqual(rest)
    await userEvent.click(play)
    await waitFor(() => expect(video.paused).toBe(false))
    // Its button turns to Pause once the video is really playing.
    await expect(await canvas.findByRole('button', { name: 'Pause video' })).toBeVisible()
  },
}

/** Which file a hero picture took for this width of screen: its own, or the one-pixel nothing. */
const fileOf = (layer: HTMLElement) => ((layer.querySelector('img') as HTMLImageElement).currentSrc.startsWith('data:image/gif') ? 'nothing' : 'its picture')

/**
 * A video for the other width of screen: in the page, told to load nothing until it is played, and never played.
 * (That nothing of it is fetched is shown by "Fetched only for its own screen" below: these samples are made in the
 * browser's memory, where there is nothing to fetch.)
 */
const neverPlayed = (video: HTMLVideoElement) => video.getAttribute('preload') === 'none' && video.paused && video.played.length === 0

/** The addresses the browser has asked for that end in one of these names. */
const askedFor = (...names: string[]) =>
  performance
    .getEntriesByType('resource')
    .map((entry) => new URL(entry.name).pathname)
    .filter((path) => names.some((name) => path.endsWith(name)))

/**
 * A hero with media of its own for phones (Wayne, 24 Nov), on a phone: a video made for the tall shape. The
 * desktop's video is in the page but never on screen, so it is never played and nothing of it is fetched, and its
 * poster's file is a one-pixel nothing.
 */
export const OwnMediaOnAPhone: Story = {
  name: 'Its own media, on a phone',
  args: { video: true, phone: 'video', button: BOOK, touch: true },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByRole('button', { name: 'Pause video' }, { timeout: 10_000 })
    const [phone, desktop] = [layerIn(canvasElement, 'mobile'), layerIn(canvasElement, 'desktop')]
    await expect([getComputedStyle(phone).display, getComputedStyle(desktop).display]).toEqual(['block', 'none'])
    const phoneVideo = phone.querySelector('video') as HTMLVideoElement
    const desktopVideo = desktop.querySelector('video') as HTMLVideoElement
    await expect(phoneVideo.paused).toBe(false)
    await expect(phoneVideo.getAttribute('aria-label')).toBe('A sample video for phones')
    await expect(neverPlayed(desktopVideo)).toBe(true)
    await expect([fileOf(phone), fileOf(desktop)]).toEqual(['its picture', 'nothing'])
    // One Pause button to press: the desktop's is not shown.
    await expect(canvas.getAllByRole('button')).toHaveLength(1)
  },
}

/** The same hero on a desktop: the main video plays, and nothing of the phones' video or its poster is fetched. */
export const OwnMediaOnADesktop: Story = {
  name: 'Its own media for phones, on a desktop',
  args: { video: true, phone: 'video', button: BOOK },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByRole('button', { name: 'Pause video' }, { timeout: 10_000 })
    const [phone, desktop] = [layerIn(canvasElement, 'mobile'), layerIn(canvasElement, 'desktop')]
    await expect([getComputedStyle(phone).display, getComputedStyle(desktop).display]).toEqual(['none', 'block'])
    await expect((desktop.querySelector('video') as HTMLVideoElement).paused).toBe(false)
    await expect((desktop.querySelector('video') as HTMLVideoElement).getAttribute('aria-label')).toBe('A sample video')
    await expect(neverPlayed(phone.querySelector('video') as HTMLVideoElement)).toBe(true)
    await expect([fileOf(phone), fileOf(desktop)]).toEqual(['nothing', 'its picture'])
    await expect(canvas.getAllByRole('button')).toHaveLength(1)
  },
}

/** Tests only: a picture of its own for phones under a main video. A phone shows the picture and has no video buttons. */
export const OwnPictureOnAPhone: Story = {
  name: 'Its own picture, on a phone',
  tags: ['!dev'],
  args: { video: true, phone: 'picture', touch: true },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await waitFor(() => expect(layerIn(canvasElement, 'mobile')).not.toBeNull(), { timeout: 10_000 })
    const [phone, desktop] = [layerIn(canvasElement, 'mobile'), layerIn(canvasElement, 'desktop')]
    await expect(canvas.getByRole('img', { name: 'A sample picture for phones' })).toBeVisible()
    await expect(phone.querySelector('video')).toBeNull()
    await expect(canvas.queryByRole('button')).toBeNull()
    await expect(neverPlayed(desktop.querySelector('video') as HTMLVideoElement)).toBe(true)
    await expect([fileOf(phone), fileOf(desktop)]).toEqual(['its picture', 'nothing'])
  },
}

/** A hero whose two videos are at addresses (which lead nowhere), so that what the browser asks for can be counted. */
function HeroAtAddresses({ named }: { named: string }) {
  const video = (screen: string): HeroVideo => videoOf(`/sample-hero-${named}-for-${screen}.mp4`, `A sample video for a ${screen}`, false)
  return <Hero desktop={{ ...SAMPLE_PICTURE.desktop, video: video('desktop') }} mobile={{ ...SAMPLE_PHONE_PICTURE, video: video('phone') }} shared={false} button={null} reducedMotion={false} priority />
}

/** Tests only: a phone asks for the phones' video and never for the desktop's ("a phone never downloads the desktop video"). */
export const FetchedOnlyForItsOwnScreenPhone: Story = {
  name: 'Fetched only for its own screen: a phone',
  tags: ['!dev'],
  globals: { viewport: { value: 'mobile', isRotated: false } },
  render: () => <HeroAtAddresses named="on-a-phone" />,
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(layerIn(canvasElement, 'desktop')).display).toBe('none')
    await waitFor(() => expect(askedFor('on-a-phone-for-phone.mp4')).toHaveLength(1), { timeout: 5000 })
    // Long enough for the other to have been asked for, had anything wanted it.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(askedFor('on-a-phone-for-desktop.mp4')).toEqual([])
  },
}

/** Tests only: and the reverse on a desktop. */
export const FetchedOnlyForItsOwnScreenDesktop: Story = {
  name: 'Fetched only for its own screen: a desktop',
  tags: ['!dev'],
  globals: { viewport: { value: 'desktop', isRotated: false } },
  render: () => <HeroAtAddresses named="on-a-desktop" />,
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(layerIn(canvasElement, 'mobile')).display).toBe('none')
    await waitFor(() => expect(askedFor('on-a-desktop-for-desktop.mp4')).toHaveLength(1), { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(askedFor('on-a-desktop-for-phone.mp4')).toEqual([])
  },
}

/** Tests only: with no media of its own for phones, the one picture serves both, cut tall on a phone. */
export const SameMediaOnAPhone: Story = {
  name: 'The same media, on a phone',
  tags: ['!dev'],
  args: { touch: true },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvasElement }) => {
    const layer = layerIn(canvasElement, 'both')
    await expect(canvasElement.querySelectorAll('[data-hero-media]')).toHaveLength(1)
    const picture = layer.querySelector('img') as HTMLImageElement
    // The tall cut (90 by 160 in the sample), not the wide one.
    await expect(decodeURIComponent(picture.currentSrc)).toContain('viewBox="0 0 90 160"')
  },
}
