import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useEffect, useState, type ComponentProps } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { recordSampleVideo } from '@/components/modules/content/sample-media'
import { OverlayTexture } from '@/components/ui/media/Overlay'

import { Header } from './Header'
import { HeaderLogo } from './HeaderLogo'
import { EMPTY_FRAME, SAMPLE_FRAME, SamplePage, withVideoThumbnail } from './sample-content'

/** W82: the header with the first menu link's thumbnail a video, once the sample video has been made (a second or so). */
function HeaderWithAVideo(args: ComponentProps<typeof Header>) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  useEffect(() => {
    let wanted = true
    void recordSampleVideo().then((url) => {
      if (wanted) setVideoUrl(url)
    })
    return () => {
      wanted = false
    }
  }, [])
  if (!videoUrl) return <p className="p-16 text-copy-14">Making a sample video…</p>
  return <Header {...args} menuLinks={withVideoThumbnail(args.menuLinks, videoUrl)} />
}

const meta = {
  title: 'Frame/Menu',
  component: Header,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { variant: 'global', logo: <HeaderLogo animated />, menuLinks: SAMPLE_FRAME.menuLinks },
  render: (args) => (
    <>
      <OverlayTexture />
      <Header {...args} />
      <main id="main" data-behind-popups="">
        <SamplePage />
      </main>
    </>
  ),
} satisfies Meta<typeof Header>

export default meta
type Story = StoryObj<typeof meta>
type Play = NonNullable<Story['play']>

const dialogIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[role="dialog"]') as HTMLElement

/** Opens the menu as a visitor does, and waits until it is fully open. */
const openMenu: Play = async ({ canvas, canvasElement }) => {
  await expect(dialogIn(canvasElement)).not.toBeVisible()
  await userEvent.click(canvas.getByRole('button', { name: 'Menu' }))
  const dialog = dialogIn(canvasElement)
  await waitFor(() => expect(dialog).toBeVisible())
  await waitFor(() => expect(getComputedStyle(dialog).clipPath).toBe('inset(0px)'))
}

/**
 * Figma "Menu Open": press Menu and the Light panel opens down from the top, with Close at the top right, over
 * Wayne's Overlay: the page behind blurred and textured (UI / Overlay). The links are Navigation's menu links from
 * Sanity.
 */
export const Open: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    await openMenu(context)
    const { canvasElement } = context
    const dialog = dialogIn(canvasElement)
    const menu = within(dialog)
    await expect(dialog.getAttribute('aria-modal')).toBe('true')
    await expect(dialog.dataset.theme).toBe('light')
    await expect(dialog.hasAttribute('data-lenis-prevent')).toBe(true)
    // Focus has moved in, and the page behind can't be reached or scrolled.
    await expect(menu.getByRole('button', { name: 'Close' })).toHaveFocus()
    await expect((canvasElement.querySelector('#main') as HTMLElement).inert).toBe(true)
    await expect((canvasElement.querySelector('header') as HTMLElement).inert).toBe(true)
    await expect(document.documentElement.classList.contains('overflow-hidden')).toBe(true)
    // The shade is the shared Overlay, the whole window, faded in.
    const shade = canvasElement.querySelector('[data-overlay="shade"]') as HTMLElement
    await waitFor(() => expect(getComputedStyle(shade).opacity).toBe('1'))
    await expect(getComputedStyle(shade).backdropFilter).toContain('blur(12px)')
    await expect(Math.round(shade.getBoundingClientRect().height)).toBe(window.innerHeight)
    await expect(menu.getAllByRole('link').map((link) => link.textContent)).toEqual(SAMPLE_FRAME.menuLinks.map((link) => link.label))
    // Figma: the panel is 565px tall on a desktop (120 above, the picture's 285, 160 below) and the links start at column 10.
    await expect(Math.round(dialog.getBoundingClientRect().height)).toBe(565)
    await expect(Math.round(menu.getAllByRole('link')[0]!.getBoundingClientRect().left)).toBe(547)
  },
}

/**
 * Figma "Menu Hover": while a link is hovered (or has keyboard focus) the others fade to Text/Muted Primary and its
 * page's thumbnail opens out from its middle, four columns wide. A link whose page has no thumbnail shows none.
 */
export const Hover: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    await openMenu(context)
    const dialog = dialogIn(context.canvasElement)
    const links = within(dialog).getAllByRole('link')
    const pictures = [...dialog.querySelectorAll('img')]
    const thumbnails = [...dialog.querySelectorAll('[data-menu-thumbnail]')]
    await expect(pictures).toHaveLength(SAMPLE_FRAME.menuLinks.filter((link) => link.thumbnail).length)
    await expect(thumbnails).toHaveLength(pictures.length)
    const primary = getComputedStyle(links[0]!).color

    await userEvent.hover(links[0]!)
    await waitFor(() => expect(getComputedStyle(thumbnails[0]!).clipPath).toBe('inset(0px)'))
    await waitFor(() => expect(getComputedStyle(links[1]!).color).not.toBe(primary))
    await expect(getComputedStyle(links[0]!).color).toBe(primary)
    await expect(Math.round(pictures[0]!.getBoundingClientRect().width)).toBe(228)
    await expect(Math.round(pictures[0]!.getBoundingClientRect().height)).toBe(285)
    await expect(getComputedStyle(thumbnails[1]!).clipPath).toBe('inset(50% 0px)')
  },
}

/** The first menu link's thumbnail, and its video. */
const videoThumbnailIn = (dialog: HTMLElement) => {
  const thumbnail = dialog.querySelector('[data-menu-thumbnail]') as HTMLElement
  return { thumbnail, video: thumbnail.querySelector('video') }
}

/** Opens the menu once the sample video has been made. */
const openMenuWithAVideo: Play = async (context) => {
  await context.canvas.findByRole('button', { name: 'Menu' }, { timeout: 10_000 })
  await openMenu(context)
}

/**
 * W82 (WQ90): a page's thumbnail can be a video. It opens out as its poster and plays, muted, looped and inline,
 * while its link is pointed at; nothing of it is fetched until then. Leaving the link pauses it.
 */
export const HoverWithAVideo: Story = {
  name: 'Hover, with a video',
  render: (args) => (
    <>
      <OverlayTexture />
      <HeaderWithAVideo {...args} />
      <main id="main" data-behind-popups="">
        <SamplePage />
      </main>
    </>
  ),
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    await openMenuWithAVideo(context)
    const dialog = dialogIn(context.canvasElement)
    const links = within(dialog).getAllByRole('link')
    const { thumbnail, video } = videoThumbnailIn(dialog)
    await expect(thumbnail.dataset.menuThumbnail).toBe('video')
    // Open, and no link pointed at: the video has no address yet, so nothing of it is fetched.
    await expect(video).not.toBeNull()
    await expect([video!.getAttribute('src'), video!.preload, video!.loop, video!.playsInline, video!.paused]).toEqual([null, 'none', true, true, true])
    await expect(getComputedStyle(video!).visibility).toBe('hidden')
    // The other thumbnails are pictures.
    await expect([...dialog.querySelectorAll('[data-menu-thumbnail]')].slice(1).map((other) => (other as HTMLElement).dataset.menuThumbnail)).toEqual(['image', 'image', 'image'])

    await userEvent.hover(links[0]!)
    await waitFor(() => expect(getComputedStyle(thumbnail).clipPath).toBe('inset(0px)'))
    await waitFor(() => expect(video!.paused).toBe(false), { timeout: 5000 })
    await expect([video!.muted, video!.getAttribute('src')?.startsWith('blob:')]).toEqual([true, true])
    await waitFor(() => expect(getComputedStyle(video!).visibility).toBe('visible'))
    await expect(Math.round(video!.getBoundingClientRect().width)).toBe(228)
    await expect(Math.round(video!.getBoundingClientRect().height)).toBe(285)

    // Another link pointed at: this one closes and its video pauses.
    await userEvent.hover(links[1]!)
    await waitFor(() => expect(video!.paused).toBe(true))
    await waitFor(() => expect(getComputedStyle(thumbnail).clipPath).toBe('inset(50% 0px)'))
  },
}

/** W82: with reduced motion a video thumbnail is its poster only: there is no video, and nothing of it is fetched. */
export const HoverWithAVideoReducedMotion: Story = {
  name: 'Hover, with a video, reduced motion',
  args: { menuReducedMotion: true },
  render: HoverWithAVideo.render,
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    await openMenuWithAVideo(context)
    const dialog = dialogIn(context.canvasElement)
    const { thumbnail, video } = videoThumbnailIn(dialog)
    await expect([thumbnail.dataset.menuThumbnail, video]).toEqual(['video', null])
    await expect(dialog.querySelectorAll('video')).toHaveLength(0)
    await userEvent.hover(within(dialog).getAllByRole('link')[0]!)
    await waitFor(() => expect(getComputedStyle(thumbnail).clipPath).toBe('inset(0px)'))
    await expect(thumbnail.querySelector('img')).toBeVisible()
  },
}

/** W82: on a phone the menu has no picture, so a video thumbnail is never fetched, even when its link takes focus. */
export const VideoOnAPhone: Story = {
  name: 'Video, on a phone',
  tags: ['!dev'],
  render: HoverWithAVideo.render,
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    await openMenuWithAVideo(context)
    const dialog = dialogIn(context.canvasElement)
    const { video } = videoThumbnailIn(dialog)
    const link = within(dialog).getAllByRole('link')[0]!
    link.focus()
    await expect(link).toHaveFocus()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect([video!.getAttribute('src'), video!.paused]).toEqual([null, true])
  },
}

/** Esc closes it, and focus goes back to the Menu button; the page behind is itself again. */
export const ClosedWithEsc: Story = {
  name: 'Closed with Esc',
  tags: ['!dev'],
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    await openMenu(context)
    const { canvas, canvasElement } = context
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(dialogIn(canvasElement)).not.toBeVisible())
    await expect(canvas.getByRole('button', { name: 'Menu' })).toHaveFocus()
    await expect((canvasElement.querySelector('#main') as HTMLElement).inert).toBe(false)
    await expect(document.documentElement.classList.contains('overflow-hidden')).toBe(false)
  },
}

/** The Close button and a click on the shade close it too. */
export const ClosedWithCloseAndShade: Story = {
  name: 'Closed with Close, and with the shade',
  tags: ['!dev'],
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { canvas, canvasElement } = context
    await openMenu(context)
    await userEvent.click(within(dialogIn(canvasElement)).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(dialogIn(canvasElement)).not.toBeVisible())
    await expect(canvas.getByRole('button', { name: 'Menu' })).toHaveFocus()

    await openMenu(context)
    // Below the panel, where only the shade is.
    await userEvent.pointer({ keys: '[MouseLeft]', target: canvasElement.querySelector('[data-overlay="shade"]') as HTMLElement, coords: { clientX: 700, clientY: 700 } })
    await waitFor(() => expect(dialogIn(canvasElement)).not.toBeVisible())
  },
}

/**
 * Figma "Menu Open (mobile)": the links in the phone's Hero Caps size with Account (a link to /account) beneath,
 * and no picture. The links stay dark: there is no hover on a phone (Wayne, 24 Nov).
 */
export const OpenOnAPhone: Story = {
  name: 'Open, on a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    await openMenu(context)
    const dialog = dialogIn(context.canvasElement)
    const menu = within(dialog)
    await expect(menu.getByRole('link', { name: 'Account' }).getAttribute('href')).toBe('/account')
    const links = menu.getAllByRole('link').filter((link) => link.textContent !== 'Account')
    links[0]!.focus()
    await expect(links[0]).toHaveFocus()
    await expect(new Set(links.map((link) => getComputedStyle(link).color)).size).toBe(1)
    await expect(dialog.querySelectorAll('img')).toHaveLength(SAMPLE_FRAME.menuLinks.filter((link) => link.thumbnail).length)
    for (const picture of dialog.querySelectorAll('img')) await expect(picture).not.toBeVisible()
  },
}

/** With no Navigation document in Sanity yet the menu still opens and closes: it is empty. */
export const NoLinksYet: Story = {
  name: 'No links yet',
  tags: ['!dev'],
  args: { menuLinks: EMPTY_FRAME.menuLinks },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    await openMenu(context)
    await expect(within(dialogIn(context.canvasElement)).queryAllByRole('link')).toHaveLength(0)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(dialogIn(context.canvasElement)).not.toBeVisible())
  },
}
