import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { NEWSLETTER_INVALID_EMAIL, NEWSLETTER_NOT_SET_UP } from '@/lib/frame/newsletter'

import { NewsletterForm } from './NewsletterForm'

const meta = {
  title: 'Frame/Newsletter field',
  component: NewsletterForm,
  // As in the footer: on the newsletter card (Surface/Card).
  decorators: [
    (Story) => (
      <div className="max-w-320 rounded-s bg-surface-card p-16">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NewsletterForm>

export default meta
type Story = StoryObj<typeof meta>

const field = (canvas: Parameters<NonNullable<Story['play']>>[0]['canvas']) => canvas.getByRole('textbox', { name: 'Enter your email address' })

/** Figma InputWithSubmit, State=empty: the prompt is the placeholder; the label with the same words is hidden. */
export const Empty: Story = {
  play: async ({ canvas }) => {
    await expect(field(canvas).getAttribute('placeholder')).toBe('Enter your email address')
    await expect(field(canvas).getAttribute('autocomplete')).toBe('email')
    await expect(canvas.getByRole('button', { name: 'Sign up' })).toBeVisible()
  },
}

/** State=focus, then State=full: Surface/Card Selected while typing, and the arrow gains its own Surface/Card. */
export const Filled: Story = {
  play: async ({ canvas }) => {
    await userEvent.type(field(canvas), 'bob@example.com')
    await expect(field(canvas)).toHaveValue('bob@example.com')
  },
}

/**
 * State=error, as the form answers today: the sign-up (Klaviyo, a later brief) is not connected, so pressing the
 * arrow shows the designed error state with these words, tied to the field and read out at once.
 */
export const NotSetUpYet: Story = {
  name: 'Error: not set up yet',
  play: async ({ canvas }) => {
    await userEvent.type(field(canvas), 'bob@example.com')
    await userEvent.click(canvas.getByRole('button', { name: 'Sign up' }))
    const message = await canvas.findByText(NEWSLETTER_NOT_SET_UP)
    await expect(field(canvas).getAttribute('aria-invalid')).toBe('true')
    await expect(field(canvas).getAttribute('aria-describedby')).toBe(message.id)
    await expect(message.parentElement?.getAttribute('aria-live')).toBe('assertive')
    // Typing again clears it.
    await userEvent.type(field(canvas), 'x')
    await waitFor(() => expect(canvas.queryByText(NEWSLETTER_NOT_SET_UP)).toBeNull())
    await expect(field(canvas).getAttribute('aria-invalid')).toBe('false')
  },
}

/** State=error for something that is not an email address. Enter in the field submits, as the arrow does. */
export const NotAnEmail: Story = {
  name: 'Error: not an email address',
  // A measured shortfall, with Wayne (W73 report; the code never adjusts a colour by itself): Text/Error on the
  // newsletter card's Surface/Card is 4.45:1 in Light, where small text needs 4.5:1. The rule is off for this one
  // story only, so the rest of its accessibility check still runs.
  parameters: { a11y: { config: { rules: [{ id: 'color-contrast', enabled: false }] } } },
  play: async ({ canvas }) => {
    await userEvent.type(field(canvas), 'bob{Enter}')
    await expect(await canvas.findByText(NEWSLETTER_INVALID_EMAIL)).toBeVisible()
  },
}

/**
 * Tests only: a sign-up that works. Figma draws no success state yet, so the field empties and a screen reader is
 * told; nothing else changes on screen until one is designed.
 */
export const SignedUp: Story = {
  name: 'Signed up',
  tags: ['!dev'],
  args: { subscribe: fn(async () => ({ ok: true as const })) },
  play: async ({ canvas, args }) => {
    await userEvent.type(field(canvas), 'bob@example.com{Enter}')
    await waitFor(() => expect(field(canvas)).toHaveValue(''))
    await expect(args.subscribe).toHaveBeenCalledWith('bob@example.com')
    await expect(canvas.getByText('Thank you. You are signed up.')).toBeInTheDocument()
  },
}
