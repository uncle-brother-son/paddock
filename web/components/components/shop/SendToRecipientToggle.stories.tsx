import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'

import { NO_RECIPIENT, recipientWrong, type Recipient } from '@/lib/shop/gift-card'

import { SendToRecipientToggle } from './SendToRecipientToggle'

const NOTHING_WRONG = { name: null, email: null }

/** The piece with its answers kept, as the Gift Card page keeps them. `asked`: Add to bag was pressed, so each field says what it needs. */
function Kept({ ticked = false, start = NO_RECIPIENT, asked = false }: { ticked?: boolean; start?: Recipient; asked?: boolean }) {
  const [sending, setSending] = useState(ticked)
  const [recipient, setRecipient] = useState<Recipient>(start)
  return (
    // The details' width on a desktop: 7 columns of the grid.
    <div className="max-w-[405px]">
      <SendToRecipientToggle sending={sending} onSending={setSending} recipient={recipient} onRecipient={setRecipient} wrong={asked ? recipientWrong(recipient) : NOTHING_WRONG} />
    </div>
  )
}

const meta = {
  title: 'Components/Shop/SendToRecipientToggle',
  component: Kept,
} satisfies Meta<typeof Kept>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()

/**
 * Figma "SendToRecipientToggle", Selected=no (1389:39583): the tick box alone, "Sending to someone else?" in Copy 12, 8px
 * from a 20px box in Surface/Card Selected. Space ticks it, as any checkbox.
 */
export const Unticked: Story = {
  play: async ({ canvas, canvasElement }) => {
    const gift = canvas.getByRole('checkbox', { name: 'Sending to someone else?' })
    await expect(gift).not.toBeChecked()
    const control = gift.parentElement!
    const words = canvas.getByText('Sending to someone else?')
    await expect([Math.round(box(control).width), Math.round(box(control).height), getComputedStyle(words).fontSize]).toEqual([20, 20, '12px'])
    await expect(Math.round(box(words).left - box(control).right)).toBe(8)
    // The words sit level with the middle of the box.
    await expect(Math.abs(box(words).top + box(words).height / 2 - (box(control).top + 10))).toBeLessThan(1)
    // The piece is as tall as the box alone (Figma: 20px), though a press reaches 2px above and below it.
    const piece = canvasElement.querySelector('[data-shop="recipient"]') as HTMLElement
    await expect([Math.round(box(piece).height), Math.round(box(canvasElement.querySelector('[data-checkbox]')!).height)]).toEqual([20, 24])
    await expect(canvas.queryByRole('textbox')).toBeNull()
    gift.focus()
    await userEvent.keyboard(' ')
    await expect(gift).toBeChecked()
    await expect(canvas.getAllByRole('textbox')).toHaveLength(3)
  },
}

/**
 * Selected=yes (1389:39584): the box in Surface/Secondary with its tick, and 32px beneath it Recipient's Name,
 * Recipient's Email and Gift message, 8px apart, each an Input on Surface/Card with its prompt in Text/Muted
 * Primary; under the message its counter, 8px beneath and 16px in.
 */
export const Ticked: Story = {
  args: { ticked: true },
  play: async ({ canvas }) => {
    const gift = canvas.getByRole('checkbox', { name: 'Sending to someone else?' })
    await expect(gift).toBeChecked()
    const tick = gift.parentElement!.querySelector('svg')!
    await expect([Math.round(box(tick).width), Math.round(box(tick).height)]).toEqual([12, 12])
    const fields = canvas.getAllByRole('textbox')
    await expect(fields.map((field) => field.getAttribute('placeholder'))).toEqual(['Recipient’s Name', 'Recipient’s Email', 'Gift message'])
    const [name, email, message] = fields as [HTMLElement, HTMLElement, HTMLElement]
    await expect(canvas.getByRole('group', { name: 'Recipient' })).toContainElement(name)
    await expect([Math.round(box(name).top - box(gift.parentElement!).bottom), Math.round(box(email).top - box(name).bottom), Math.round(box(message).top - box(email).bottom)]).toEqual([32, 8, 8])
    await expect([Math.round(box(name).width), getComputedStyle(name).paddingLeft, getComputedStyle(name).fontSize]).toEqual([405, '16px', '14px'])
    await expect(Math.abs(box(name).height - box(email).height)).toBeLessThan(0.5)
    // The message: an Input's height and one more line with 4px between (Figma: 66px beside 42). It grows as it is
    // typed in (W83): see Message grows.
    await expect(Math.round(box(message).height - box(name).height)).toBe(24)
    await expect([message.tagName, getComputedStyle(message).resize]).toEqual(['TEXTAREA', 'none'])
    const counter = canvas.getByText('150 characters left')
    await expect([Math.round(box(counter).top - box(message).bottom), getComputedStyle(counter).paddingLeft]).toEqual([8, '16px'])
    // A field's focus state is its own: Surface/Card Selected in place of the ring.
    const resting = getComputedStyle(email).backgroundColor
    name.focus()
    await expect(getComputedStyle(name).outlineStyle).toBe('none')
    await expect(getComputedStyle(email).backgroundColor).toBe(resting)
    await userEvent.type(name, 'Sam')
    await expect(name).toHaveValue('Sam')
  },
}

/**
 * Add to bag pressed with the name and the email missing: each field in its error state (Figma "Input", Error=yes),
 * with what it needs beneath. An email that isn't one says so. The message is never needed.
 */
export const Missing: Story = {
  name: 'Name and email missing',
  args: { ticked: true, asked: true },
  play: async ({ canvas, canvasElement }) => {
    const errors = () => [...canvasElement.querySelectorAll('[data-field-error]')].map((one) => one.textContent)
    await expect(errors()).toEqual(['Enter the recipient’s name', 'Enter the recipient’s email'])
    const name = canvas.getByRole('textbox', { name: 'Recipient’s Name' })
    const email = canvas.getByRole('textbox', { name: 'Recipient’s Email' })
    await expect([name.getAttribute('aria-invalid'), email.getAttribute('aria-invalid'), canvas.getByRole('textbox', { name: 'Gift message' }).getAttribute('aria-invalid')]).toEqual(['true', 'true', 'false'])
    await userEvent.type(name, 'Sam')
    await userEvent.type(email, 'sam@')
    await expect(errors()).toEqual(['Enter a valid email address'])
    await userEvent.type(email, 'example.com')
    await expect(errors()).toEqual([])
  },
}

/** The counter near 0: "1 character left", then "0 characters left", and the message takes no more. */
export const CounterNearZero: Story = {
  name: 'Message counter near 0',
  args: { ticked: true, start: { name: 'Sam', email: 'sam@example.com', message: 'x'.repeat(148) } },
  play: async ({ canvas }) => {
    const message = canvas.getByRole('textbox', { name: 'Gift message' }) as HTMLTextAreaElement
    await expect(canvas.getByText('2 characters left')).toBeVisible()
    await userEvent.type(message, 'y')
    await expect(canvas.getByText('1 character left')).toBeVisible()
    await userEvent.type(message, 'yyy')
    await expect(message.value).toHaveLength(150)
    await expect(canvas.getByText('0 characters left')).toBeVisible()
    await expect(message.getAttribute('aria-describedby')).toBe(canvas.getByText('0 characters left').id)
  },
}

/** A gift message as long as one can be, in words: the box must show all of it. */
const LONGEST_MESSAGE = 'Happy birthday, Sam! A long sauna and a cold plunge on us, whenever you like. With all our love, and see you at the Paddock very soon. Jo, Ally and Kit'.slice(0, 150)

/** The box shows every line of its words: nothing is left to scroll to inside it. */
const allShown = (message: HTMLElement) => message.scrollHeight <= message.clientHeight

/**
 * W83 (Wayne, 27 Nov): the gift message box starts at two lines, as drawn (66px), and grows a line at a time as the
 * words need, so a whole message always shows and nothing scrolls inside it; the counter stays 8px beneath it.
 */
const messageGrows = async ({ canvas }: { canvas: Parameters<NonNullable<Story['play']>>[0]['canvas'] }) => {
  await document.fonts.ready
  const message = canvas.getByRole('textbox', { name: 'Gift message' }) as HTMLTextAreaElement
  const rest = box(message).height
  await expect(Math.round(rest)).toBe(66)
  // Two lines keep the box as drawn.
  await userEvent.type(message, 'Happy birthday{Enter}Love, Jo')
  await expect([Math.round(box(message).height), allShown(message)]).toEqual([66, true])
  // A third line adds one line's height, and the counter moves down with the box.
  await userEvent.type(message, '{Enter}x')
  const three = box(message).height
  await expect(three).toBeGreaterThan(rest + 10)
  await expect(allShown(message)).toBe(true)
  const counter = canvas.getByText(`${150 - message.value.length} characters left`)
  await expect(Math.round(box(counter).top - box(message).bottom)).toBe(8)
  // The longest message there can be shows whole.
  await userEvent.clear(message)
  await userEvent.type(message, LONGEST_MESSAGE)
  await expect(message.value).toBe(LONGEST_MESSAGE)
  await waitFor(() => expect(canvas.getByText('0 characters left')).toBeVisible())
  await expect(allShown(message)).toBe(true)
  await expect(getComputedStyle(message).overflowY).toBe('hidden')
  await expect(Math.round(box(canvas.getByText('0 characters left')).top - box(message).bottom)).toBe(8)
  // Emptied, it is two lines again.
  await userEvent.clear(message)
  await expect(Math.round(box(message).height)).toBe(66)
}

export const MessageGrows: Story = {
  name: 'Message grows',
  args: { ticked: true },
  play: messageGrows,
}

/** The same on a phone, where the details are 358 wide: the longest message takes more lines, and still all show. */
export const MessageGrowsOnAPhone: Story = {
  name: 'Message grows, on a phone',
  args: { ticked: true },
  render: (args) => (
    <div style={{ width: 358 }}>
      <Kept {...args} />
    </div>
  ),
  play: messageGrows,
}
