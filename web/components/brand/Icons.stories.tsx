import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { BothModes, Named } from './BothModes'
import { Icon, ICON_NAMES } from './Icon'

/** The Figma variant's name on the 02 Icons page: `burger-close` is "Type=burger close". */
const figmaName = (name: string) => `Type=${name.replace(/-/g, ' ')}`

const meta = {
  title: 'Brand/Icons',
  component: Icon,
  parameters: { padded: false },
} satisfies Meta<typeof Icon>

export default meta
type Story = StoryObj<typeof meta>

/** Every icon beside its Figma name, in Light and Dark. Each takes the text colour of where it sits. */
export const All: Story = {
  args: { name: 'burger' },
  render: () => (
    <BothModes>
      <ul className="grid grid-cols-2 gap-16 md:grid-cols-4">
        {ICON_NAMES.map((name) => (
          <Named key={name} name={figmaName(name)}>
            <Icon name={name} />
          </Named>
        ))}
      </ul>
    </BothModes>
  ),
  play: async ({ canvasElement }) => {
    const drawn = [...canvasElement.querySelectorAll('svg')]
    // The 16 Figma icons, twice (Light and Dark), each at its file's own size and hidden from a screen reader.
    await expect(drawn).toHaveLength(32)
    for (const svg of drawn) await expect(svg.getAttribute('aria-hidden')).toBe('true')
    const sizes = new Set(drawn.map((svg) => `${svg.getBoundingClientRect().width}x${svg.getBoundingClientRect().height}`))
    await expect([...sizes].sort()).toEqual(['10x9', '24x9', '9x13', '9x9'])
  },
}

/** An icon that stands alone is given a name for a screen reader. */
export const Labelled: Story = {
  args: { name: 'close', label: 'Close' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('img', { name: 'Close' })).toBeVisible()
  },
}
