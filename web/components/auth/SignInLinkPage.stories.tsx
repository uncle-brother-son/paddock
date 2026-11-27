import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { LINK_COPY as COPY } from '@/lib/sign-in/words'

import { SignInLinkPage } from './SignInLinkPage'

// Brief W85: the email link page (/auth/confirm; backend log 27), its two drawn states and the one before the button is
// pressed (the expired page's layout, Wayne 30 Nov). Nothing is used up until Sign in is pressed.

const meta = {
  title: 'Auth/Sign-in link page',
  component: SignInLinkPage,
  parameters: { layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { tokenHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', next: 'https://paddock.example/shop/hoodie', confirm: fn(async () => 'expired' as const) },
} satisfies Meta<typeof SignInLinkPage>

export default meta
type Story = StoryObj<typeof meta>

const DESKTOP = { viewport: { value: 'desktop', isRotated: false } }
const MOBILE = { viewport: { value: 'mobile', isRotated: false } }

/** Not drawn: SIGN IN, the heading, a line and the Sign in button. Opening the page uses nothing up. */
export const Ready: Story = {
  name: 'Before Sign in is pressed',
  globals: DESKTOP,
  play: async ({ canvas, args }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: COPY.readyTitle })).toBeVisible()
    await expect(args.confirm).not.toHaveBeenCalled()
    // Pressed: the link is used up on the server; this one is used already, so the page says so.
    await userEvent.click(canvas.getByRole('button', { name: COPY.signIn }))
    await expect(args.confirm).toHaveBeenCalledWith('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    await waitFor(() => expect(canvas.getByRole('heading', { level: 1, name: COPY.expiredTitle })).toBeVisible())
  },
}

export const ReadyMobile: Story = { ...Ready, name: 'Before Sign in is pressed, on a phone', globals: MOBILE, play: undefined }

/** Figma "Sign in link — Signing in" (1180:24731): the generic loading screen, the Fence in the middle. */
export const SigningIn: Story = {
  name: 'Signing in',
  globals: DESKTOP,
  args: { initialState: 'signing_in' },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('status')).toHaveTextContent(COPY.signingIn)
    const fence = canvasElement.querySelector('[data-sign-in-link="signing-in"] svg') as SVGElement
    const placed = fence.getBoundingClientRect()
    await expect(Math.abs(Math.round(placed.left + placed.width / 2 - window.innerWidth / 2))).toBeLessThanOrEqual(1)
  },
}

export const SigningInMobile: Story = { ...SigningIn, name: 'Signing in, on a phone', globals: MOBILE, play: undefined }

/** Figma "Sign in link — Link expired or used" (1180:24831): with "Send a new link", which opens the sign-in popup. */
export const Expired: Story = {
  name: 'Link expired or used',
  globals: DESKTOP,
  args: { initialState: 'expired' },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(COPY.eyebrow)).toBeVisible()
    await expect(canvas.getByRole('heading', { level: 1, name: COPY.expiredTitle })).toBeVisible()
    await expect(canvas.getByText(COPY.expiredText)).toBeVisible()
    await expect(canvas.getByRole('button', { name: COPY.sendNewLink })).toBeVisible()
  },
}

export const ExpiredMobile: Story = { ...Expired, name: 'Link expired or used, on a phone', globals: MOBILE, play: undefined }

/** An address with no token at all is a link that can't be used. */
export const NoToken: Story = {
  name: 'No token in the address',
  globals: MOBILE,
  args: { tokenHash: null },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { level: 1, name: COPY.expiredTitle })).toBeVisible()
  },
}
