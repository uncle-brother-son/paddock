import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useEffect, useState } from 'react'
import { expect, fireEvent, userEvent, waitFor } from 'storybook/test'

import type { HeroMediaButton } from '@/lib/modules/hero-media'
import type { ScreenVideo } from '@/lib/sanity/media'

import { HeroMedia } from './HeroMedia'
import { recordSampleVideo, SAMPLE_PICTURE, SAMPLE_PICTURE_WITH_PHONE_POSTER } from './sample-media'

const BOOK: HeroMediaButton = { text: 'Book Your Experience', href: '/book' }

type StoryArgs = {
  button: HeroMediaButton | null
  reducedMotion: boolean
  /** As on a touch screen: the button always at its resting place. */
  touch: boolean
  /** The hero's media is a video (made here), not a picture. */
  video: boolean
  /** The editor's "Has Sound" switch on that video. */
  hasSound: boolean
  /** What the film has for phones (WQ35): nothing of its own, a poster, or a file and a poster. */
  phone: 'same' | 'poster' | 'video'
}

/** The hero the story asks for, once any sample video it needs has been made (a second or so each). */
function SampleHero({ button, reducedMotion, touch, video, hasSound, phone }: StoryArgs) {
  const [made, setMade] = useState<{ main: string | null; phone: string | null } | null>(null)
  useEffect(() => {
    let wanted = true
    void Promise.all([video ? recordSampleVideo() : null, video && phone === 'video' ? recordSampleVideo('#a7bbc8') : null]).then(([main, forPhones]) => {
      if (wanted) setMade({ main, phone: forPhones })
    })
    return () => {
      wanted = false
    }
  }, [video, phone])
  if (!made) return <p className="p-16 text-copy-14">Making a sample video…</p>

  // One film: its two files share the description and the sound switch.
  const film: ScreenVideo | null = made.main ? { url: made.main, phoneUrl: made.phone, description: 'A sample video', captionsUrl: null, hasSound } : null
  // A film's posters have no alt text of their own (WQ42): the film's description describes them.
  const picture = film ? { ...(phone === 'same' ? SAMPLE_PICTURE : SAMPLE_PICTURE_WITH_PHONE_POSTER), alt: film.description } : SAMPLE_PICTURE
  return <HeroMedia picture={picture} video={film} button={button} reducedMotion={reducedMotion} touch={touch} priority />
}

const meta = {
  title: 'Modules/Content/HeroMedia',
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { button: null, reducedMotion: false, touch: false, video: false, hasSound: false, phone: 'same' },
  render: (args) => <SampleHero {...args} />,
} satisfies Meta<StoryArgs>

export default meta
type Story = StoryObj<typeof meta>

const heroIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-module="hero"]') as HTMLElement
const buttonIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-hero-button]') as HTMLElement
const pictureIn = (canvasElement: HTMLElement) => heroIn(canvasElement).querySelector('img') as HTMLImageElement

/** The player of one of a film's files, by the widths of screen it is for. */
const playerIn = (canvasElement: HTMLElement, screens: 'both' | 'mobile' | 'desktop') => canvasElement.querySelector(`[data-hero-video="${screens}"]`) as HTMLElement
const videoOf = (player: HTMLElement) => player.querySelector('video') as HTMLVideoElement

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

/** Which of the sample pictures the browser took: the wide cut or the tall one, the film's own or its poster for phones. */
const pictureTaken = (picture: HTMLImageElement) => {
  const file = decodeURIComponent(picture.currentSrc)
  return `${file.includes('viewBox="0 0 90 160"') ? 'tall' : 'wide'}, ${file.includes('#a7bbc8') ? 'the poster for phones' : 'the main picture'}`
}

/**
 * Figma HeroMedia, Device=desktop: the picture across the whole window, 16 by 9 (810px tall on the 1440 frame), in the
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
    await expect(pictureTaken(pictureIn(canvasElement))).toBe('wide, the main picture')
    // The page's first picture loads at once, ahead of the rest.
    await expect([picture.getAttribute('loading'), picture.getAttribute('fetchpriority')]).toEqual(['eager', 'high'])
    await expect(canvas.queryByRole('button')).toBeNull()
    await expect(canvas.queryByRole('link')).toBeNull()
    await expect(canvasElement.querySelector('video')).toBeNull()
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
    // One file for every screen: one player.
    const video = videoOf(playerIn(canvasElement, 'both'))
    await expect(canvasElement.querySelectorAll('video')).toHaveLength(1)
    const hero = heroIn(canvasElement)
    await expect([video.muted, video.loop, video.playsInline, video.paused]).toEqual([true, true, true, false])
    // Once it plays, the video carries the description, and the poster beneath it is no longer read out as well.
    await expect(video.getAttribute('aria-label')).toBe('A sample video')
    await expect(pictureIn(canvasElement).alt).toBe('')
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
 * Figma HeroMedia, Device=mobile: 9 by 16 (693px tall on the 390 frame), the one picture cut tall round its hotspot. On
 * a touch screen the button is always there, at its resting place: a finger moves nothing.
 */
export const OnAPhone: Story = {
  name: 'On a phone',
  args: { button: BOOK, touch: true },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvasElement }) => {
    const hero = heroIn(canvasElement)
    const box = hero.getBoundingClientRect()
    await expect([Math.round(box.width), Math.round(box.height)]).toEqual([390, 693])
    await expect(pictureTaken(pictureIn(canvasElement))).toBe('tall, the main picture')
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
    // WQ42: the poster has no alt text of its own. Its alt is the video's description, and the video is not read out too.
    await expect(canvas.getByRole('img', { name: 'A sample video' })).toBeVisible()
    await expect(pictureIn(canvasElement).alt).toBe('A sample video')
    await expect([video.getAttribute('aria-hidden'), video.hasAttribute('aria-label')]).toEqual(['true', false])
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

/**
 * A file for the other width of screen: in the page, told to load nothing until it is played, and never played.
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
 * A film with a file and a poster for phones (WQ35; Wayne, 24 Nov), on a phone: the phones' file plays over the
 * phones' poster. The desktop's file is in the page but never on screen, so it is never played and nothing of it is
 * fetched. The film's description and its sound switch are said once, for both.
 */
export const FilmForPhonesOnAPhone: Story = {
  name: 'A film with a file for phones, on a phone',
  args: { video: true, phone: 'video', hasSound: true, button: BOOK, touch: true },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByRole('button', { name: 'Pause video' }, { timeout: 10_000 })
    const [phone, desktop] = [playerIn(canvasElement, 'mobile'), playerIn(canvasElement, 'desktop')]
    await expect([getComputedStyle(phone).display, getComputedStyle(desktop).display]).toEqual(['block', 'none'])
    await expect(playerIn(canvasElement, 'both')).toBeNull()
    await expect(videoOf(phone).paused).toBe(false)
    await expect(neverPlayed(videoOf(desktop))).toBe(true)
    await expect(videoOf(phone).src).not.toBe(videoOf(desktop).src)
    // One description for the film, whichever file shows.
    await expect(videoOf(phone).getAttribute('aria-label')).toBe('A sample video')
    // One picture in the page, and the browser took the phones' poster.
    await expect(canvasElement.querySelectorAll('img')).toHaveLength(1)
    await expect(pictureTaken(pictureIn(canvasElement))).toBe('tall, the poster for phones')
    // The sound switch is the film's: this screen's player has both buttons, and only its own are there to press.
    await expect(canvas.getAllByRole('button').map((one) => one.getAttribute('aria-label'))).toEqual(['Unmute video', 'Pause video'])
  },
}

/** The same film on a desktop: the main file plays over the main poster, and nothing of the phones' is fetched. */
export const FilmForPhonesOnADesktop: Story = {
  name: 'A film with a file for phones, on a desktop',
  args: { video: true, phone: 'video', hasSound: true, button: BOOK },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByRole('button', { name: 'Pause video' }, { timeout: 10_000 })
    const [phone, desktop] = [playerIn(canvasElement, 'mobile'), playerIn(canvasElement, 'desktop')]
    await expect([getComputedStyle(phone).display, getComputedStyle(desktop).display]).toEqual(['none', 'block'])
    await expect(videoOf(desktop).paused).toBe(false)
    await expect(videoOf(desktop).getAttribute('aria-label')).toBe('A sample video')
    await expect(neverPlayed(videoOf(phone))).toBe(true)
    await expect(pictureTaken(pictureIn(canvasElement))).toBe('wide, the main picture')
    await expect(canvas.getAllByRole('button').map((one) => one.getAttribute('aria-label'))).toEqual(['Unmute video', 'Pause video'])
  },
}

/** Tests only: a poster for phones and no file for them. One player for every screen; a phone has the phones' poster under it. */
export const PosterForPhonesOnly: Story = {
  name: 'A poster for phones only, on a phone',
  tags: ['!dev'],
  args: { video: true, phone: 'poster', touch: true },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByRole('button', { name: 'Pause video' }, { timeout: 10_000 })
    await expect(canvasElement.querySelectorAll('video')).toHaveLength(1)
    await expect(playerIn(canvasElement, 'both')).not.toBeNull()
    await expect(pictureTaken(pictureIn(canvasElement))).toBe('tall, the poster for phones')
  },
}

/** A hero whose film is at two addresses (which lead nowhere), so that what the browser asks for can be counted. */
function HeroMediaAtAddresses({ named }: { named: string }) {
  const film: ScreenVideo = { url: `/sample-hero-${named}-for-desktop.mp4`, phoneUrl: `/sample-hero-${named}-for-phone.mp4`, description: 'A sample video', captionsUrl: null, hasSound: false }
  return <HeroMedia picture={{ ...SAMPLE_PICTURE_WITH_PHONE_POSTER, alt: film.description }} video={film} button={null} reducedMotion={false} priority />
}

/** Tests only: a phone asks for the phones' file and never for the desktop's ("only the one the screen needs is ever fetched"). */
export const FetchedOnlyForItsOwnScreenPhone: Story = {
  name: 'Fetched only for its own screen: a phone',
  tags: ['!dev'],
  globals: { viewport: { value: 'mobile', isRotated: false } },
  render: () => <HeroMediaAtAddresses named="on-a-phone" />,
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(playerIn(canvasElement, 'desktop')).display).toBe('none')
    await waitFor(() => expect(askedFor('on-a-phone-for-phone.mp4')).toHaveLength(1), { timeout: 5000 })
    // Long enough for the other to have been asked for, had anything wanted it.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(askedFor('on-a-phone-for-desktop.mp4')).toEqual([])
    await expect(pictureTaken(pictureIn(canvasElement))).toBe('tall, the poster for phones')
  },
}

/** Tests only: and the reverse on a desktop. */
export const FetchedOnlyForItsOwnScreenDesktop: Story = {
  name: 'Fetched only for its own screen: a desktop',
  tags: ['!dev'],
  globals: { viewport: { value: 'desktop', isRotated: false } },
  render: () => <HeroMediaAtAddresses named="on-a-desktop" />,
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(playerIn(canvasElement, 'mobile')).display).toBe('none')
    await waitFor(() => expect(askedFor('on-a-desktop-for-desktop.mp4')).toHaveLength(1), { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(askedFor('on-a-desktop-for-phone.mp4')).toEqual([])
    await expect(pictureTaken(pictureIn(canvasElement))).toBe('wide, the main picture')
  },
}
