import type { Meta, StoryObj } from '@storybook/nextjs-vite'

import tokens from '@/lib/design/figma-tokens.json'
import { paletteVariable, themeVariable } from '@/lib/design/token-names'

import { VariableValue } from './measured'

const meta = {
  title: 'Foundations/Colours',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** One colour: a block filled with the token, its Figma name, its CSS variable and the value the page has for it. */
function Swatch({ figmaName, variable, pointsTo }: { figmaName: string; variable: string; pointsTo?: string }) {
  return (
    <li className="flex items-center gap-12">
      <span aria-hidden="true" className="block size-40 shrink-0 rounded-s border border-object-dark-shade" style={{ backgroundColor: `var(${variable})` }} />
      {/* The text styles are trimmed to their capitals (W71a), so two lines stacked need a gap of their own. */}
      <span className="flex min-w-0 flex-col gap-6">
        <span className="block text-bold-14">{figmaName}</span>
        <span className="block text-copy-12">
          {variable}
          {pointsTo ? ` · ${pointsTo}` : ''} · <VariableValue name={variable} />
        </span>
      </span>
    </li>
  )
}

/** The palette's opacity steps, in Figma's order: 100, 65, 40, 20, 8, 4, 2. */
const opacities = [...new Set(Object.keys(tokens.palette).map((name) => name.split('/')[0]!))]

/** Every palette colour, grouped by opacity. A see-through colour is shown over the current mode's surface. */
export const Palette: Story = {
  render: () => (
    <div className="flex flex-col gap-32">
      {opacities.map((opacity) => (
        <section key={opacity} aria-labelledby={`palette-${opacity}`}>
          <h2 id={`palette-${opacity}`} className="mb-12 text-h3">
            {opacity}%
          </h2>
          <ul className="grid gap-12 md:grid-cols-3">
            {Object.keys(tokens.palette)
              .filter((name) => name.split('/')[0] === opacity)
              .map((name) => (
                <Swatch key={name} figmaName={name} variable={paletteVariable(name)} />
              ))}
          </ul>
        </section>
      ))}
    </div>
  ),
}

/** Every theme colour in each of the four modes, each mode on its own Surface/Primary. */
export const Theme: Story = {
  render: () => (
    <div className="grid gap-16 md:grid-cols-2">
      {tokens.themeModes.map((mode) => (
        <section key={mode} data-theme={mode.toLowerCase()} aria-labelledby={`theme-${mode}`} className="rounded-m border border-object-dark-shade bg-surface-primary p-16">
          <h2 id={`theme-${mode}`} className="mb-12 text-h3">
            {mode}
          </h2>
          <ul className="flex flex-col gap-12">
            {Object.entries(tokens.theme).map(([name, byMode]) => (
              <Swatch key={name} figmaName={name} variable={themeVariable(name)} pointsTo={(byMode as Record<string, string>)[mode]} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  ),
}
