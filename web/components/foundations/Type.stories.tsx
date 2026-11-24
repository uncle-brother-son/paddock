import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import type { CSSProperties } from 'react'

import tokens from '@/lib/design/figma-tokens.json'
import { fontSizeVariable, TEXT_STYLE_CLASSES } from '@/lib/design/token-names'

import { px, useMeasured } from './measured'

const meta = {
  title: 'Foundations/Type',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

type Measurements = 'Desktop' | 'Mobile'
type TextStyle = (typeof tokens.textStyles)[number]

const families: Record<string, string> = {
  Primary: tokens.measurements['Font/Family/Primary'],
  Secondary: tokens.measurements['Font/Family/Secondary'],
}

/**
 * Sets the font sizes that differ between Figma's two Measurements modes to one mode's values, whatever the
 * window's width, so both sets can be seen side by side.
 */
function sizesFor(mode: Measurements): CSSProperties {
  const sizes: Record<string, string> = {}
  for (const [name, value] of Object.entries(tokens.measurements)) {
    if (name.startsWith('Font/Size/') && typeof value === 'object') {
      sizes[fontSizeVariable(name)] = `var(--font-size-${name.split('/').at(-1)}-${mode.toLowerCase()})`
    }
  }
  return sizes as CSSProperties
}

/** One text style: a line set in it, and under it what the browser makes of it. */
function Specimen({ style }: { style: TextStyle }) {
  const className = TEXT_STYLE_CLASSES[style.name] ?? ''
  const [ref, rendered] = useMeasured<HTMLParagraphElement>((element) => {
    const computed = getComputedStyle(element)
    // A hidden one-line copy gives the height of a line: what Figma's "auto" comes to in this browser.
    const line = element.nextElementSibling instanceof HTMLElement ? element.nextElementSibling.getBoundingClientRect().height : 0
    const size = Number.parseFloat(computed.fontSize)
    return [
      `weight ${computed.fontWeight}`,
      `size ${px(size)}`,
      `line height ${computed.lineHeight === 'normal' ? `auto, ${px(line)} here` : `${px(line)} (${Math.round((line / size) * 100)}%)`}`,
      `letter spacing ${computed.letterSpacing === 'normal' ? '0' : computed.letterSpacing}`,
      ...(computed.textTransform === 'none' ? [] : [computed.textTransform]),
      ...(computed.textDecorationLine === 'none' ? [] : [computed.textDecorationLine]),
    ].join(' · ')
  })

  return (
    <li className="relative border-b border-object-dark-shade pb-16">
      <p ref={ref} className={className}>
        The Paddock Wellness Club
      </p>
      <span aria-hidden="true" className={`invisible absolute block whitespace-nowrap ${className}`}>
        Hg
      </span>
      <p className="mt-8 text-copy-12">
        <span className="text-bold-14">{style.name}</span> · {className} · {families[style.family]} · {rendered}
      </p>
    </li>
  )
}

function Specimens({ mode }: { mode: Measurements }) {
  return (
    <ul className="flex flex-col gap-16" style={sizesFor(mode)}>
      {tokens.textStyles.map((style) => (
        <Specimen key={style.name} style={style} />
      ))}
    </ul>
  )
}

/** Every text style at the Desktop sizes (768px and up). */
export const Desktop: Story = {
  render: () => <Specimens mode="Desktop" />,
}

/** Every text style at the Mobile sizes (below 768px): H1 and H2 / Hero Caps are smaller. */
export const Mobile: Story = {
  render: () => <Specimens mode="Mobile" />,
}
