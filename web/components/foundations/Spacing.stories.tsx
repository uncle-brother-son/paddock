import type { Meta, StoryObj } from '@storybook/nextjs-vite'

import tokens from '@/lib/design/figma-tokens.json'
import { radiusVariable, spacingVariable } from '@/lib/design/token-names'

import { VariableValue } from './measured'

const meta = {
  title: 'Foundations/Spacing and corners',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const corners = ['Spacing/Corners/S', 'Spacing/Corners/M'] as const

/** Figma's "Spacing/General" scale: each step drawn at its own width. */
export const Scale: Story = {
  render: () => (
    // The longest steps are wider than a phone, so the list scrolls sideways there rather than the page.
    <div role="region" aria-label="Spacing scale" tabIndex={0} className="overflow-x-auto">
      <ul className="flex flex-col gap-8">
        {tokens.measurements['Spacing/General'].map((value) => (
          <li key={value} className="flex items-center gap-12">
            <span className="w-80 shrink-0 text-copy-12">
              <span className="text-bold-14">{value}</span> · <VariableValue name={spacingVariable(value)} />
            </span>
            <span aria-hidden="true" className="block h-16 shrink-0 bg-surface-secondary" style={{ width: `var(${spacingVariable(value)})` }} />
          </li>
        ))}
      </ul>
    </div>
  ),
}

/** The two corner radii. */
export const Corners: Story = {
  render: () => (
    <ul className="flex gap-32">
      {corners.map((name) => (
        <li key={name} className="flex flex-col gap-8">
          <span aria-hidden="true" className="block size-80 bg-surface-secondary" style={{ borderRadius: `var(${radiusVariable(name)})` }} />
          {/* The text styles are trimmed to their capitals (W71a), so two lines stacked need a gap of their own. */}
          <span className="flex flex-col gap-6">
            <span className="block text-bold-14">{name}</span>
            <span className="block text-copy-12">
              {radiusVariable(name)} · <VariableValue name={radiusVariable(name)} />
            </span>
          </span>
        </li>
      ))}
    </ul>
  ),
}
