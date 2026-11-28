import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test'

import { BigButton } from '@/components/ui/buttons/Button'
import { OverlayTexture } from '@/components/ui/media/Overlay'
import { signIn } from '@/lib/frame/sign-in'
import { DURATION_SHORT, EASE_SMOOTH_CSS } from '@/lib/motion/tokens'
import { SIGN_IN_COPY as COPY } from '@/lib/sign-in/words'

import { FrameShell } from './FrameShell'
import { SAMPLE_FRAME, SamplePage } from './sample-content'
import { useFramePanels } from './useFramePanels'

// Brief W85: the sign-in popup over a page, as the frame draws it (components/frame/SignInHost.tsx), opened by the
// one signIn() seam, as an Event page's "Sign in" and the booking panel's "Log in" open it. Storybook has no Supabase
// project, so no one is signed in here and nothing is sent. (The header's Account opens it through SiteLink, which
// Storybook's link stand-in can't show: a press there arrives already handled. It is checked on the running site.)

function PageWithSignIn() {
  const panels = useFramePanels()
  return (
    <>
      <div data-theme="light" className="flex flex-col gap-16 px-16 pt-160">
        <BigButton className="max-w-[320px]" onClick={() => signIn()}>
          Sign in
        </BigButton>
        {/* As the booking panel's Log in: the panel opens, then sign-in over it (the panel's own steps need its reads). */}
        <BigButton
          className="max-w-[320px]"
          onClick={() => {
            panels.open('book')
            window.setTimeout(() => signIn(), DURATION_SHORT * 1000 + 100)
          }}
        >
          Book, then Log in
        </BigButton>
      </div>
      <SamplePage />
    </>
  )
}

const meta = {
  title: 'Frame/Sign-in popup',
  component: FrameShell,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { variant: 'global', content: SAMPLE_FRAME, children: <PageWithSignIn /> },
  decorators: [
    (Story) => (
      <>
        <OverlayTexture />
        <Story />
      </>
    ),
  ],
} satisfies Meta<typeof FrameShell>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()

/** Presses the page's Sign in once it is known no one is signed in, and waits until the popup has slid into its place. */
async function open(canvasElement: HTMLElement, press: () => Promise<void>) {
  const document = canvasElement.ownerDocument
  const popup = document.querySelector('[data-sign-in="popup"]') as HTMLElement
  await expect(popup).not.toBeVisible()
  const layer = document.querySelector('[data-sign-in="layer"]') as HTMLElement
  await waitFor(() => expect(layer.dataset.account).toBe('signed_out'))
  await press()
  await waitFor(() => expect(popup).toBeVisible())
  // In its place: no translate left (Chromium reports none, or 0px).
  await waitFor(() => expect(['none', '0px', '0px 0px']).toContain(getComputedStyle(popup).translate), { timeout: 3000 })
  await expectOnTop(popup)
  return popup
}

/**
 * The popup is what is seen and pressed at its middle: nothing (its own shade, the booking panel) is drawn over it.
 * Live bug, 28 Nov: the shade painted over the popup inside the sign-in layer, and every check above still passed.
 */
async function expectOnTop(popup: HTMLElement) {
  const document = popup.ownerDocument
  const placed = box(popup)
  // elementFromPoint looks through anything with pointer-events: none, as the sign-in layer's shade is (it takes that
  // from its layer): so for the moment of looking every shade takes part, and what is found is what is painted on top.
  const shades = [...document.querySelectorAll<HTMLElement>('[data-overlay]')]
  for (const shade of shades) shade.style.pointerEvents = 'auto'
  const atMiddle = document.elementFromPoint(placed.left + placed.width / 2, placed.top + placed.height / 2)
  for (const shade of shades) shade.style.pointerEvents = ''
  await expect(atMiddle !== null && popup.contains(atMiddle)).toBe(true)
}

/**
 * Figma "Log in Create account — Page mock up" (917:2996): the popup over the page, 462px wide in the middle of the
 * window, on Wayne's Overlay, focus in the email field, the page behind out of reach. It slides as the other popups,
 * over the short duration with the smooth curve. Esc closes it, and focus goes back to what opened it.
 */
export const OverThePage: Story = {
  name: 'Over the page, on a desktop',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const opener = canvas.getByRole('button', { name: 'Sign in' })
    const popup = await open(canvasElement, () => userEvent.click(opener))
    await expect(canvas.getByRole('dialog', { name: COPY.emailTitle })).toBe(popup)
    // The Terms and Privacy pages Site settings picks, by their own slugs (W85 Level 3).
    await expect(within(popup).getByRole('link', { name: COPY.terms })).toHaveAttribute('href', '/info/booking-terms')
    await expect(within(popup).getByRole('link', { name: COPY.privacy })).toHaveAttribute('href', '/info/privacy-notice')
    await waitFor(() => expect(canvasElement.ownerDocument.activeElement).toBe(canvas.getByRole('textbox', { name: COPY.email })))
    await expect(getComputedStyle(popup).transitionDuration).toBe(`${DURATION_SHORT}s`)
    await expect(getComputedStyle(popup).transitionTimingFunction).toBe(EASE_SMOOTH_CSS)
    const placed = box(popup)
    await expect(Math.round(placed.width)).toBe(462)
    await expect(Math.abs(Math.round(placed.left + placed.width / 2 - window.innerWidth / 2))).toBeLessThanOrEqual(1)
    await expect(Math.abs(Math.round(placed.top + placed.height / 2 - window.innerHeight / 2))).toBeLessThanOrEqual(1)
    await expect((canvasElement.ownerDocument.querySelector('#main') as HTMLElement).closest('[inert]')).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(popup).not.toBeVisible(), { timeout: 3000 })
    await expect(canvasElement.ownerDocument.activeElement).toBe(opener)
    await expect((canvasElement.ownerDocument.querySelector('#main') as HTMLElement).closest('[inert]')).toBeNull()
  },
}

/** On a phone (1176:19632): 16px in from the window's sides and 80px down (Figma's 96, to the scale). Close closes it. */
export const OnAPhone: Story = {
  name: 'Over the page, on a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const popup = await open(canvasElement, () => userEvent.click(canvas.getByRole('button', { name: 'Sign in' })))
    const placed = box(popup)
    // Figma's 96 down is no step of the spacing scale: the nearest, 80 (W73's rule).
    await expect([Math.round(placed.left), Math.round(window.innerWidth - placed.right), Math.round(placed.top)]).toEqual([16, 16, 80])
    await userEvent.click(canvas.getByRole('button', { name: COPY.close }))
    await waitFor(() => expect(popup).not.toBeVisible(), { timeout: 3000 })
  },
}

/** A press on the shade closes it, as on every popup. */
export const ShadeCloses: Story = {
  name: 'A press on the shade closes it',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const popup = await open(canvasElement, () => userEvent.click(canvas.getByRole('button', { name: 'Sign in' })))
    // The shade's place round the popup is the layer itself (the popup sits on it).
    fireEvent.click(canvasElement.ownerDocument.querySelector('[data-sign-in="layer"]') as HTMLElement)
    await waitFor(() => expect(popup).not.toBeVisible(), { timeout: 3000 })
  },
}

/** A wrong address is caught before anything is sent, in the newsletter's words, under the field. */
export const NotAnEmail: Story = {
  name: 'Not an email address',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await open(canvasElement, () => userEvent.click(canvas.getByRole('button', { name: 'Sign in' })))
    await userEvent.type(canvas.getByRole('textbox', { name: COPY.email }), 'bob@')
    await userEvent.keyboard('{Enter}')
    await expect(await canvas.findByText(COPY.invalidEmail)).toBeVisible()
    await expect(canvas.getByRole('textbox', { name: COPY.email })).toHaveAttribute('aria-invalid', 'true')
  },
}

/**
 * Over the booking panel (its AccountBar's Log in): the popup is on top of the panel and of its own shade, the panel is
 * out of reach while it is open, and Esc closes only the popup: the panel is still there, as it was.
 */
export const OverTheBookingPanel: Story = {
  name: 'Over the booking panel',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const panel = canvasElement.ownerDocument.querySelector('[data-book="panel"]') as HTMLElement
    const popup = await open(canvasElement, () => userEvent.click(canvas.getByRole('button', { name: 'Book, then Log in' })))
    await expect(panel).toBeVisible()
    await expect(panel.inert).toBe(true)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(popup).not.toBeVisible(), { timeout: 3000 })
    await expect(panel).toBeVisible()
    await expect(panel.inert).toBe(false)
  },
}

/** On a phone, over the booking panel: on top too. */
export const OverTheBookingPanelOnAPhone: Story = {
  name: 'Over the booking panel, on a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await open(canvasElement, () => userEvent.click(canvas.getByRole('button', { name: 'Book, then Log in' })))
  },
}
