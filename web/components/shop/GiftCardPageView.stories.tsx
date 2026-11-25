import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'

import { OverlayTexture } from '@/components/ui/Overlay'

import { GiftCardPageView } from './GiftCardPageView'
import { SAMPLE_GIFT_CARD } from './sample-shop'

const meta = {
  title: 'Shop/Gift card',
  component: GiftCardPageView,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  // A story leaves the address bar alone: it says where the switch's address would go.
  args: { view: SAMPLE_GIFT_CARD, format: 'digital', showAddress: fn(), reducedMotion: true },
  render: (args) => (
    <>
      <OverlayTexture />
      <GiftCardPageView {...args} />
    </>
  ),
} satisfies Meta<typeof GiftCardPageView>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const part = (canvasElement: HTMLElement, name: string) => canvasElement.querySelector(`[data-shop="${name}"]`) as HTMLElement
const gap = (above: Element, below: Element) => Math.round(box(below).top - box(above).bottom)
/** The chip drawn for a radio button: the label round it. */
const chipOf = (radio: HTMLElement) => radio.parentElement as HTMLElement
const fieldError = (field: HTMLElement) => field.closest('[data-field]')?.querySelector('[data-field-error]') as HTMLElement | null

/**
 * Figma "Gift card digital" (1684:41964). The gallery fills the window's left half to the end of the grid's 12th
 * column, the Digital card's pictures stacked, each 4 by 5; the details (Figma "PIC", Type=gift card digital) are
 * columns 15 to 21, 240px down, and stick to the window's top. In them: the name in H2, the price line (the amount
 * chosen), the Digital / Physical switch, the amounts with the lowest chosen, "Sending to someone else?", the
 * button with "Your gift card will be sent by email" under it, and the three links that open the info panel.
 */
export const Digital: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const gallery = part(canvasElement, 'gallery')
    await expect([Math.round(box(gallery).left), Math.round(box(gallery).width)]).toEqual([0, 716])
    const pictures = [...gallery.querySelectorAll('[data-gallery-item]')]
    await expect(pictures.map((picture) => [Math.round(box(picture).width), Math.round(box(picture).height)])).toEqual([[716, 895], [716, 895]])
    await expect(canvas.getByRole('img', { name: 'The Paddock gift card on a phone' })).toBeVisible()
    const details = part(canvasElement, 'details')
    await expect([Math.round(box(details).left), Math.round(box(details).width)]).toEqual([842, 405])
    await expect(getComputedStyle(details).position).toBe('sticky')
    const name = canvas.getByRole('heading', { level: 1, name: 'Gift Card' })
    await expect(Math.round(box(name).top)).toBe(240)
    await expect(getComputedStyle(name).fontSize).toBe('24px')
    // The price line: the lowest amount, chosen as the page opens, 24px under the name.
    const price = part(canvasElement, 'price')
    await expect(price.textContent).toBe('£15')
    await expect(gap(name, price)).toBe(24)
    // The switch: Digital chosen (Surface/Secondary), as wide as its words, 32px under the price.
    const formats = canvas.getByRole('radiogroup', { name: 'How it is sent' })
    const [digital, physical] = within(formats).getAllByRole('radio')
    await expect([digital!.parentElement!.textContent, digital, physical!.parentElement!.textContent]).toEqual(['Digital', digital, 'Physical'])
    await expect(digital).toBeChecked()
    // 12px above and below its label (Figma: 33 tall; Label 12's capitals measure 8px here, 9 in Figma).
    await expect([Math.round(box(formats).left), gap(price, formats), Math.round(box(formats).height)]).toEqual([842, 32, 32])
    await expect(Math.round(box(formats).width)).toBeLessThan(405)
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    await expect(getComputedStyle(chipOf(digital!)).backgroundColor).toBe(getComputedStyle(button).backgroundColor)
    // Amount: a chip for each preset and Other, three to a row, 4px apart, across the details' width; £15 chosen.
    const amount = part(canvasElement, 'amount')
    await expect(gap(formats, amount)).toBe(32)
    const chips = within(canvas.getByRole('radiogroup', { name: 'Amount' })).getAllByRole('radio')
    await expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual(['£15', '£30', '£60', '£90', '£150', 'Other'])
    await expect(chips[0]).toBeChecked()
    const chipBoxes = chips.map((chip) => box(chipOf(chip)))
    await expect([Math.round(chipBoxes[0]!.left), Math.round(chipBoxes[2]!.right), Math.round(chipBoxes[1]!.left - chipBoxes[0]!.right)]).toEqual([842, 1247, 4])
    await expect([Math.round(chipBoxes[3]!.left), Math.round(chipBoxes[3]!.top - chipBoxes[0]!.bottom), Math.round(chipBoxes[5]!.right)]).toEqual([842, 4, 1247])
    await expect(canvas.queryByRole('textbox')).toBeNull()
    // "Sending to someone else?": a 20px box, unticked, 32px under the amounts, and no fields yet.
    const gift = canvas.getByRole('checkbox', { name: 'Sending to someone else?' })
    await expect(gift).not.toBeChecked()
    const recipient = part(canvasElement, 'recipient')
    await expect(gap(amount, recipient)).toBe(32)
    await expect([Math.round(box(gift.parentElement!).width), Math.round(box(gift.parentElement!).height)]).toEqual([20, 20])
    // The button, the whole width, 32px under, with its line 24px beneath.
    await expect([Math.round(box(button).width), Math.round(box(button).height), gap(recipient, button)]).toEqual([405, 40, 32])
    const line = part(canvasElement, 'fulfilment')
    await expect([line.textContent, gap(button, line)]).toEqual(['Your gift card will be sent by email', 24])
    // The links that open the info panel, in Label 12, 64px under the rest.
    const links = ['Description', 'Gift Card Terms & Conditions', 'Shipping & returns'].map((label) => canvas.getByRole('button', { name: label }))
    await expect(links.map((link) => link.getAttribute('aria-haspopup'))).toEqual(['dialog', 'dialog', 'dialog'])
    await expect(gap(line, links[0]!)).toBe(64)
    // No row follows the details: the frames draw none.
    await expect(part(canvasElement, 'similar')).toBeNull()
  },
}

/**
 * Figma "Gift card physical" (1684:41977), which the address asks for with ?format=physical: the Physical card's
 * own pictures, Physical chosen on the switch, no "Sending to someone else?", and "Delivery or collection from the
 * Paddock." under the button.
 */
export const Physical: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { format: 'physical' },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('img', { name: 'The Paddock gift card' })).toBeVisible()
    await expect(canvas.queryByRole('img', { name: 'The Paddock gift card on a phone' })).toBeNull()
    await expect(canvas.getByRole('radio', { name: 'Physical' })).toBeChecked()
    await expect(part(canvasElement, 'price').textContent).toBe('£15')
    await expect(canvas.getByRole('radio', { name: '£15' })).toBeChecked()
    await expect(canvas.queryByRole('checkbox')).toBeNull()
    await expect(part(canvasElement, 'recipient')).toBeNull()
    // The button follows the amounts directly, 32px under.
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    await expect(gap(part(canvasElement, 'amount'), button)).toBe(32)
    await expect(part(canvasElement, 'fulfilment').textContent).toBe('Delivery or collection from the Paddock.')
    await expect(['Description', 'Gift Card Terms & Conditions', 'Shipping & returns'].map((label) => canvas.getByRole('button', { name: label }).textContent)).toHaveLength(3)
  },
}

/**
 * The switch (item 1): choosing Physical swaps the gallery and the details where they stand, keeps the amount that
 * was chosen, and writes the address of the choice (?format=physical), so it can be shared; Digital writes the
 * page's own address again. What was typed for a recipient is still there on coming back.
 */
export const Switching: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ args, canvas, canvasElement }) => {
    await userEvent.click(canvas.getByRole('radio', { name: '£60' }))
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Sending to someone else?' }))
    await userEvent.type(canvas.getByRole('textbox', { name: 'Recipient’s Name' }), 'Sam')
    await userEvent.click(canvas.getByRole('radio', { name: 'Physical' }))
    await expect(args.showAddress).toHaveBeenLastCalledWith('/shop/gift-card?format=physical')
    await expect(part(canvasElement, 'gift-card').dataset.format).toBe('physical')
    await expect(canvas.getByRole('img', { name: 'The Paddock gift card' })).toBeVisible()
    await expect(canvas.getByRole('radio', { name: '£60' })).toBeChecked()
    await expect(part(canvasElement, 'price').textContent).toBe('£60')
    await expect(canvas.queryByRole('checkbox')).toBeNull()
    // The arrow keys move between the two, as on any pair of radio buttons.
    await userEvent.keyboard('{ArrowLeft}')
    await expect(canvas.getByRole('radio', { name: 'Digital' })).toBeChecked()
    await expect(args.showAddress).toHaveBeenLastCalledWith('/shop/gift-card')
    await expect(args.showAddress).toHaveBeenCalledTimes(2)
    await expect(canvas.getByRole('img', { name: 'The Paddock gift card on a phone' })).toBeVisible()
    await expect(canvas.getByRole('radio', { name: '£60' })).toBeChecked()
    await expect(canvas.getByRole('checkbox', { name: 'Sending to someone else?' })).toBeChecked()
    await expect(canvas.getByRole('textbox', { name: 'Recipient’s Name' })).toHaveValue('Sam')
  },
}

/**
 * Figma "Gift card digital (mobile)" (1684:42032): the gallery is the window's whole width, a row to swipe, with the
 * slider beneath it; the details follow, 24px under, 16px in from each edge.
 */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const gallery = part(canvasElement, 'gallery')
    const pictures = [...gallery.querySelectorAll('[data-gallery-item]')]
    await expect(pictures.map((picture) => [Math.round(box(picture).left), Math.round(box(picture).width), Math.round(box(picture).height)])).toEqual([[0, 390, 488], [390, 390, 488]])
    await expect([...(gallery.querySelector('[data-gallery-slider]') as HTMLElement).children]).toHaveLength(2)
    await expect(canvas.getByRole('group', { name: 'Gift card pictures' })).toBeVisible()
    await expect(document.documentElement.scrollWidth).toBe(390)
    const name = canvas.getByRole('heading', { level: 1 })
    await expect([Math.round(box(name).left), Math.round(box(name).top - box(gallery).bottom)]).toEqual([16, 24])
    const chips = within(canvas.getByRole('radiogroup', { name: 'Amount' })).getAllByRole('radio').map((chip) => box(chipOf(chip)))
    await expect([Math.round(chips[0]!.left), Math.round(chips[2]!.right), Math.round(chips[5]!.right)]).toEqual([16, 374, 374])
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    await expect([Math.round(box(button).left), Math.round(box(button).width)]).toEqual([16, 358])
  },
}

/** Figma "Gift card physical (mobile)" (1684:42044). */
export const MobilePhysical: Story = {
  name: 'Mobile, physical',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  args: { format: 'physical' },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('radio', { name: 'Physical' })).toBeChecked()
    await expect(part(canvasElement, 'fulfilment').textContent).toBe('Delivery or collection from the Paddock.')
    await expect(document.documentElement.scrollWidth).toBe(390)
  },
}

/**
 * OptionsAmount, State=other and other full (1389:39343, 1389:39685): choosing Other opens the amount field under
 * the chips, 4px beneath and as tall as a chip, with its prompt "Enter an amount". Until an amount is typed the price
 * line stays on the lowest. What is typed shows with its pound sign, and the price line follows it.
 */
export const OtherChosen: Story = {
  name: 'Other chosen',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const other = canvas.getByRole('radio', { name: 'Other' })
    await userEvent.click(other)
    await expect(other).toBeChecked()
    await expect(canvas.getByRole('radio', { name: '£15' })).not.toBeChecked()
    const field = canvas.getByRole('textbox', { name: 'Enter an amount' })
    await expect([field.getAttribute('placeholder'), field.getAttribute('inputmode'), field.getAttribute('aria-invalid')]).toEqual(['Enter an amount', 'numeric', 'false'])
    const chip = box(chipOf(other))
    await expect([Math.round(box(field).left), Math.round(box(field).width), Math.round(box(field).top - chip.bottom)]).toEqual([842, 405, 4])
    await expect(Math.abs(box(field).height - chip.height)).toBeLessThan(0.5)
    await expect(getComputedStyle(field).fontSize).toBe('14px')
    await expect(part(canvasElement, 'price').textContent).toBe('£15')
    // WQ51: while there is no amount, a mouse over the button says what to do; its name stays "Add to bag".
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    await expect(button.querySelector('[data-label="hover"]')?.textContent).toBe('Enter amount')
    await userEvent.type(field, '200')
    await expect(field).toHaveValue('£200')
    await expect(part(canvasElement, 'price').textContent).toBe('£200')
    await expect(fieldError(field)).toBeNull()
    await waitFor(() => expect(button.querySelector('[data-label]')).toBeNull())
    // "1,000" is the most it takes, and reads as it is written in the words.
    await userEvent.clear(field)
    await userEvent.type(field, '1,000')
    await expect(part(canvasElement, 'price').textContent).toBe('£1000')
    await userEvent.click(button)
    await expect(fieldError(field)).toBeNull()
    // A preset chosen again closes the field; Other again remembers what was typed.
    await userEvent.click(canvas.getByRole('radio', { name: '£90' }))
    await expect(canvas.queryByRole('textbox')).toBeNull()
    await expect(part(canvasElement, 'price').textContent).toBe('£90')
  },
}

const otherWith = (typed: string, words: string): Story['play'] => async ({ canvas, canvasElement }) => {
  await userEvent.click(canvas.getByRole('radio', { name: 'Other' }))
  const field = canvas.getByRole('textbox', { name: 'Enter an amount' })
  await userEvent.type(field, typed)
  // Said as it is typed, under the field: the Input's error state (Surface/Card Error, the words in Copy 12 and Text/Error).
  const wrong = fieldError(field)!
  await expect(wrong.textContent).toBe(words)
  await expect([getComputedStyle(wrong).fontSize, field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')]).toEqual(['12px', 'true', wrong.id])
  await expect(Math.round(box(wrong).top - box(field).bottom)).toBe(8)
  await expect(getComputedStyle(wrong).color).not.toBe(getComputedStyle(field).color)
  // No amount, so the price line stays on the lowest, and Add to bag adds nothing and goes to the field.
  await expect(part(canvasElement, 'price').textContent).toBe('£15')
  canvas.getByRole('radio', { name: 'Other' }).focus()
  await userEvent.click(canvas.getByRole('button', { name: 'Add to bag' }))
  await expect(field).toHaveFocus()
  await expect(fieldError(field)!.textContent).toBe(words)
}

/** Other, below the least it takes (WQ63, W76a's words): "0". */
export const OtherBelowTheLeast: Story = {
  name: 'Other, below the least',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: otherWith('0', 'Enter an amount between £1 and £1,000'),
}

/** Other, above the most it takes: "1001". */
export const OtherAboveTheMost: Story = {
  name: 'Other, above the most',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: otherWith('1001', 'Enter an amount between £1 and £1,000'),
}

/** Other, not whole pounds: "25.50". */
export const OtherNotWholePounds: Story = {
  name: 'Other, not whole pounds',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: otherWith('25.50', 'Enter an amount in whole pounds'),
}

/**
 * Other with nothing typed is not wrong until Add to bag is pressed: then the field says "Enter an amount" and takes
 * focus, and typing an amount it can take clears it.
 */
export const OtherLeftEmpty: Story = {
  name: 'Other, left empty',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('radio', { name: 'Other' }))
    const field = canvas.getByRole('textbox', { name: 'Enter an amount' })
    await expect(fieldError(field)).toBeNull()
    await userEvent.click(canvas.getByRole('button', { name: 'Add to bag' }))
    await expect(fieldError(field)!.textContent).toBe('Enter an amount')
    await expect(field).toHaveFocus()
    await userEvent.type(field, '25')
    await expect(fieldError(field)).toBeNull()
    await expect(field.getAttribute('aria-invalid')).toBe('false')
  },
}

/**
 * RecipientInfo, Selected=yes (1389:39584): ticking "Sending to someone else?" shows Recipient's Name, Recipient's
 * Email and Gift message, 32px under the tick box and 8px apart, the message with "150 characters left" beneath.
 * Add to bag with the name or the email missing adds nothing: each says what it needs, and the first takes focus.
 */
export const GiftTicked: Story = {
  name: 'Gift ticked',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const gift = canvas.getByRole('checkbox', { name: 'Sending to someone else?' })
    await userEvent.click(gift)
    await expect(gift).toBeChecked()
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    await waitFor(() => expect(getComputedStyle(gift.parentElement!).backgroundColor).toBe(getComputedStyle(button).backgroundColor))
    const name = canvas.getByRole('textbox', { name: 'Recipient’s Name' })
    const email = canvas.getByRole('textbox', { name: 'Recipient’s Email' })
    const message = canvas.getByRole('textbox', { name: 'Gift message' })
    await expect([name.getAttribute('placeholder'), email.getAttribute('placeholder'), message.getAttribute('placeholder')]).toEqual(['Recipient’s Name', 'Recipient’s Email', 'Gift message'])
    await expect([email.getAttribute('type'), name.getAttribute('autocomplete'), email.getAttribute('autocomplete'), message.getAttribute('maxlength')]).toEqual(['email', 'off', 'off', '150'])
    await expect([Math.round(box(name).left), Math.round(box(name).width), Math.round(box(name).top - box(gift.parentElement!).bottom)]).toEqual([842, 405, 32])
    await expect([Math.round(box(email).top - box(name).bottom), Math.round(box(message).top - box(email).bottom)]).toEqual([8, 8])
    // The message has room for two lines (Figma: 66px, an Input's 42 and a line more).
    await expect(Math.round(box(message).height - box(name).height)).toBe(24)
    const counter = canvas.getByText('150 characters left')
    await expect([getComputedStyle(counter).fontSize, message.getAttribute('aria-describedby'), Math.round(box(counter).top - box(message).bottom)]).toEqual(['12px', counter.id, 8])
    await expect(gap(part(canvasElement, 'recipient'), button)).toBe(32)
    // Nothing is wrong until Add to bag is pressed.
    await expect(canvasElement.querySelectorAll('[data-field-error]')).toHaveLength(0)
    await expect(button.querySelector('[data-label="hover"]')?.textContent).toBe('Add recipient')
    await userEvent.click(button)
    await expect([fieldError(name)!.textContent, fieldError(email)!.textContent, fieldError(message)]).toEqual(['Enter the recipient’s name', 'Enter the recipient’s email', null])
    await expect(name).toHaveFocus()
    await expect([name.getAttribute('aria-invalid'), name.getAttribute('aria-describedby')]).toEqual(['true', fieldError(name)!.id])
    // Each clears as it is put right; an email that isn't one says so.
    await userEvent.type(name, 'Sam')
    await expect(fieldError(name)).toBeNull()
    await userEvent.type(email, 'sam@example')
    await expect(fieldError(email)!.textContent).toBe('Enter a valid email address')
    await userEvent.click(button)
    await expect(email).toHaveFocus()
    await userEvent.type(email, '.com')
    await expect(fieldError(email)).toBeNull()
    await waitFor(() => expect(button.querySelector('[data-label]')).toBeNull())
    await userEvent.click(button)
    await expect(canvasElement.querySelectorAll('[data-field-error]')).toHaveLength(0)
    // Unticking takes the fields away, and nothing of them is asked for.
    await userEvent.click(gift)
    await expect(canvas.queryByRole('textbox')).toBeNull()
  },
}

/** The gift message's counter near 0: it counts down as the message is typed, and the message stops at 150 characters. */
export const MessageCounterNearZero: Story = {
  name: 'Message counter near 0',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Sending to someone else?' }))
    const message = canvas.getByRole('textbox', { name: 'Gift message' })
    await userEvent.click(message)
    const words = 'Happy birthday, Sam. A morning at the Paddock is on us: sauna, plunge and a smoothie after. Pick any day you like and bring a towel. With love from all of us at home.'
    await userEvent.paste(words.slice(0, 147))
    await expect((message as HTMLTextAreaElement).value).toHaveLength(147)
    await expect(canvas.getByText('3 characters left')).toBeVisible()
    await userEvent.type(message, 'ab')
    await expect(canvas.getByText('1 character left')).toBeVisible()
    await userEvent.type(message, 'cde')
    await expect((message as HTMLTextAreaElement).value).toHaveLength(150)
    await expect(canvas.getByText('0 characters left')).toBeVisible()
  },
}

/** A type with Other switched off in the staff app has no Other chip: the presets alone. */
export const NoOther: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: { ...SAMPLE_GIFT_CARD, other: null } },
  play: async ({ canvas }) => {
    await expect(within(canvas.getByRole('radiogroup', { name: 'Amount' })).getAllByRole('radio').map((chip) => chip.getAttribute('aria-label'))).toEqual(['£15', '£30', '£60', '£90', '£150'])
  },
}

/**
 * The info panel, on Gift Card Terms & Conditions: Sanity's terms with {validity} filled from the staff app's
 * setting ("6 months"). The panel is the Product page's, sliding in from the right with its Close label.
 */
export const Terms: Story = {
  name: 'Gift Card Terms & Conditions',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Gift Card Terms & Conditions' }))
    const panel = await canvas.findByRole('dialog', { name: 'Gift card information' })
    await expect(within(panel).getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([
      ['Description', 'false'],
      ['Gift Card Terms & Conditions', 'true'],
      ['Shipping & returns', 'false'],
    ])
    await expect(within(panel).getByText('Valid for 6 months from the day it is bought.')).toBeVisible()
    await expect(within(panel).getByRole('button', { name: 'Close' })).toBeVisible()
  },
}

/** With no Shipping & Returns summary in Shop settings that link and tab are not drawn, as on the Product page. */
export const NoShippingSummary: Story = {
  name: 'No Shipping & Returns summary',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: { ...SAMPLE_GIFT_CARD, shipping: [] } },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole('button', { name: 'Shipping & returns' })).toBeNull()
    await expect(canvas.getAllByRole('tab', { hidden: true })).toHaveLength(2)
  },
}
