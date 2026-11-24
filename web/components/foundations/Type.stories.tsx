import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import type { CSSProperties } from 'react'
import { expect, waitFor } from 'storybook/test'

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

/** The outline round a specimen's text box: the box Figma draws round the same text. It takes no room itself. */
const TEXT_BOX_OUTLINE = 'w-fit outline outline-1 outline-text-muted-primary'

/**
 * One text style: one line set in it and then two lines, each with its text box outlined, and under them what the
 * browser makes of it. The words have a capital to start and tails (p, y, g) to hang below the box. With Figma's vertical trim (every style but H3) the one-line box is as tall as
 * a capital letter and descenders hang below it; the two-line box is one line height taller.
 */
function Specimen({ style }: { style: TextStyle }) {
  const className = TEXT_STYLE_CLASSES[style.name] ?? ''
  const trimmed = style.verticalTrim === 'cap-height'
  const [ref, rendered] = useMeasured<HTMLParagraphElement>((element) => {
    const computed = getComputedStyle(element)
    const box = element.getBoundingClientRect().height
    // The two-line box is one line taller than the one-line box, trimmed or not: that is the height of a line, and
    // what Figma's "auto" comes to in this browser.
    const twoLines = element.nextElementSibling instanceof HTMLElement ? element.nextElementSibling.getBoundingClientRect().height : box
    const line = twoLines - box
    const size = Number.parseFloat(computed.fontSize)
    return [
      `weight ${computed.fontWeight}`,
      `size ${px(size)}`,
      `box ${px(box)} (${trimmed ? 'trimmed to the capitals' : 'not trimmed'})`,
      `line height ${computed.lineHeight === 'normal' ? `auto, ${px(line)} here` : `${px(line)} (${Math.round((line / size) * 100)}%)`}`,
      `letter spacing ${computed.letterSpacing === 'normal' ? '0' : computed.letterSpacing}`,
      ...(computed.textTransform === 'none' ? [] : [computed.textTransform]),
      ...(computed.textDecorationLine === 'none' ? [] : [computed.textDecorationLine]),
    ].join(' · ')
  })

  return (
    <li data-text-style={style.name} data-vertical-trim={style.verticalTrim} className="flex flex-col gap-16 border-b border-object-dark-shade pb-16">
      {/* Short enough to stay on one line in the narrowest docs column, and never wrapped: the box measured is one line's. */}
      <p ref={ref} data-lines="1" className={`whitespace-nowrap ${TEXT_BOX_OUTLINE} ${className}`}>
        Contrast therapy
      </p>
      <p data-lines="2" className={`whitespace-nowrap ${TEXT_BOX_OUTLINE} ${className}`}>
        Sauna, plunge
        <br />
        Contrast therapy
      </p>
      <p className="text-copy-12">
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

/** The height of a capital H in an element's font, as the browser draws it: the font's cap height at that size. */
function capitalHeight(element: Element): number {
  const computed = getComputedStyle(element)
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return Number.NaN
  context.font = `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`
  return context.measureText('H').actualBoundingBoxAscent
}

/**
 * W71a, item 1, in a real browser: a style Figma trims has a one-line box as tall as a capital letter; H3, which
 * Figma leaves alone, has a box as tall as its line. Either way a second line adds one whole line height.
 */
const boxesAreFigmas: NonNullable<Story['play']> = async ({ canvasElement }) => {
  await document.fonts.ready
  for (const style of tokens.textStyles) {
    const specimen = canvasElement.querySelector(`[data-text-style="${style.name}"]`)
    const oneLine = specimen?.querySelector('[data-lines="1"]')
    const twoLines = specimen?.querySelector('[data-lines="2"]')
    if (!oneLine || !twoLines) throw new Error(`${style.name}: no specimen on the page`)
    await waitFor(() => expect(document.fonts.check(getComputedStyle(oneLine).font), `${style.name}: its font has arrived`).toBe(true))

    const box = oneLine.getBoundingClientRect().height
    const line = twoLines.getBoundingClientRect().height - box
    const capitals = capitalHeight(oneLine)
    const size = Number.parseFloat(getComputedStyle(oneLine).fontSize)
    // A line is never shorter than the font size here (the font's own height, or 140%), and capitals are well under it.
    await expect(line, `${style.name}: the height of a line`).toBeGreaterThanOrEqual(size)
    await expect(capitals, `${style.name}: the height of a capital`).toBeLessThan(size * 0.8)
    if (style.verticalTrim === 'cap-height') {
      await expect(Math.abs(box - capitals), `${style.name}: box ${box}px against capitals ${capitals}px`).toBeLessThanOrEqual(0.5)
    } else {
      await expect(Math.abs(box - line), `${style.name}: box ${box}px against a line of ${line}px`).toBeLessThanOrEqual(0.5)
    }
  }
}

/** Every text style at the Desktop sizes (768px and up). */
export const Desktop: Story = {
  render: () => <Specimens mode="Desktop" />,
  play: boxesAreFigmas,
}

/** Every text style at the Mobile sizes (below 768px): H1 and H2 / Hero Caps are smaller. */
export const Mobile: Story = {
  render: () => <Specimens mode="Mobile" />,
  play: boxesAreFigmas,
}
