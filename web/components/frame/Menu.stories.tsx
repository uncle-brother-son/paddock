import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { Header } from './Header'
import { HeaderLogo } from './HeaderLogo'
import { EMPTY_FRAME, SAMPLE_FRAME, SamplePage } from './sample-content'

const meta = {
  title: 'Frame/Menu',
  component: Header,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { variant: 'global', logo: <HeaderLogo animated />, menuLinks: SAMPLE_FRAME.menuLinks },
  render: (args) => (
    <>
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
 * Figma "Menu Open": press Menu and the Light panel opens down from the top over the shaded page, with Close at
 * the top right. The links are Navigation's menu links from Sanity.
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
    await expect(pictures).toHaveLength(SAMPLE_FRAME.menuLinks.filter((link) => link.thumbnail).length)
    const primary = getComputedStyle(links[0]!).color

    await userEvent.hover(links[0]!)
    await waitFor(() => expect(getComputedStyle(pictures[0]!).clipPath).toBe('inset(0px)'))
    await waitFor(() => expect(getComputedStyle(links[1]!).color).not.toBe(primary))
    await expect(getComputedStyle(links[0]!).color).toBe(primary)
    await expect(Math.round(pictures[0]!.getBoundingClientRect().width)).toBe(228)
    await expect(Math.round(pictures[0]!.getBoundingClientRect().height)).toBe(285)
    await expect(getComputedStyle(pictures[1]!).clipPath).toBe('inset(50% 0px)')
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
    await userEvent.pointer({ keys: '[MouseLeft]', target: canvasElement.querySelector('[data-frame-popup][aria-hidden]') as HTMLElement, coords: { clientX: 700, clientY: 700 } })
    await waitFor(() => expect(dialogIn(canvasElement)).not.toBeVisible())
  },
}

/**
 * Figma "Menu Open (mobile)": the links in the phone's Hero Caps size with Account beneath, and no picture. The
 * links stay dark: there is no hover on a phone (Wayne, 24 Nov).
 */
export const OpenOnAPhone: Story = {
  name: 'Open, on a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    await openMenu(context)
    const dialog = dialogIn(context.canvasElement)
    const menu = within(dialog)
    await expect(menu.getByRole('button', { name: 'Account' })).toBeVisible()
    const links = menu.getAllByRole('link')
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
