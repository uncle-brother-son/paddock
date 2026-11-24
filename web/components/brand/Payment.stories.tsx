import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { BothModes, Named } from './BothModes'
import { PAYMENT_BRANDS, PaymentMark } from './PaymentMark'

const meta = {
  title: 'Brand/Payment',
  component: PaymentMark,
  parameters: { padded: false },
} satisfies Meta<typeof PaymentMark>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The five marks the site shows (WQ31), beside their Figma names (02 Icons, PaymentMethodIcon), in Light and Dark.
 * They keep their own brand colours in every mode. Any other card is the word "Card".
 */
export const All: Story = {
  args: { brand: 'visa' },
  render: () => (
    <BothModes>
      <ul className="grid grid-cols-1 gap-16 md:grid-cols-3">
        {PAYMENT_BRANDS.map((brand) => (
          <Named key={brand} name={`Type=${brand.replace(/-/g, ' ')}`}>
            <PaymentMark brand={brand} />
          </Named>
        ))}
        {['discover', 'diners', 'unionpay'].map((brand) => (
          <Named key={brand} name={`${brand} (no logo)`}>
            <PaymentMark brand={brand} className="text-copy-14" />
          </Named>
        ))}
      </ul>
    </BothModes>
  ),
  play: async ({ canvas }) => {
    for (const name of ['Visa', 'Mastercard', 'American Express', 'Apple Pay', 'Google Pay']) {
      await expect(canvas.getAllByRole('img', { name })).toHaveLength(2)
    }
    // Three other brands, in each mode: the word, and no drawing.
    await expect(canvas.getAllByText('Card')).toHaveLength(6)
    await expect(canvas.getAllByRole('img')).toHaveLength(10)
  },
}

/** Stripe's own spelling of a brand ("apple_pay", "Visa") finds its mark. */
export const StripeSpelling: Story = {
  name: "Stripe's spelling",
  args: { brand: 'apple_pay' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('img', { name: 'Apple Pay' })).toBeVisible()
  },
}
