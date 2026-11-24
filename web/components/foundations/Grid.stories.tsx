import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import type { CSSProperties } from 'react'
import { expect, waitFor } from 'storybook/test'

import { Grid } from '@/components/layout/Grid'
import tokens from '@/lib/design/figma-tokens.json'

import { px, useMeasured } from './measured'

const meta = {
  title: 'Foundations/Grid',
  component: Grid,
  // The frames are drawn at their real widths, edge to edge.
  parameters: { padded: false },
} satisfies Meta<typeof Grid>

export default meta
type Story = StoryObj<typeof meta>

type Measurements = 'Desktop' | 'Mobile'

const gridValue = (name: 'Width' | 'Columns' | 'Margin' | 'Gutter' | 'Column', mode: Measurements): number =>
  tokens.measurements[`Spacing/Grid/${name}`][mode]

/** The grid's columns, drawn and numbered. */
function Columns({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <div key={index} data-column={index + 1} className="col-span-1 bg-surface-card-selected pt-8 text-center text-label-10">
      {index + 1}
    </div>
  ))
}

/**
 * One of Figma's two frames at its real width, with that mode's grid drawn over it whatever the window's width.
 * The column width in the caption is measured from the page.
 */
function Frame({ mode }: { mode: Measurements }) {
  const suffix = mode.toLowerCase()
  const [ref, column] = useMeasured<HTMLDivElement>((element) => px(element.querySelector('[data-column="1"]')?.getBoundingClientRect().width ?? 0))
  const frame = {
    width: gridValue('Width', mode),
    '--grid-columns': `var(--grid-columns-${suffix})`,
    '--grid-margin': `var(--grid-margin-${suffix})`,
    '--grid-gutter': `var(--grid-gutter-${suffix})`,
  } as CSSProperties

  return (
    <figure>
      <figcaption className="p-16 text-copy-14">
        <span className="text-bold-14">{mode}</span> · frame {gridValue('Width', mode)}px · {gridValue('Columns', mode)} columns · margin{' '}
        {gridValue('Margin', mode)}px · gutter {gridValue('Gutter', mode)}px · column <span data-measured-column="">{column}</span> (Figma:{' '}
        {gridValue('Column', mode)}px)
      </figcaption>
      <div ref={ref} role="region" aria-label={`${mode} frame, ${gridValue('Width', mode)} pixels wide`} tabIndex={0} className="overflow-x-auto">
        <Grid className="h-160 bg-surface-card" style={frame}>
          <Columns count={gridValue('Columns', mode)} />
        </Grid>
      </div>
    </figure>
  )
}

/** The measured column is Figma's: 51px in the 1440 frame, 53px in the 390 frame. */
const columnIsFigmas = (mode: Measurements): Story['play'] =>
  async ({ canvasElement }) => {
    const column = canvasElement.querySelector('[data-column="1"]')
    await expect(column?.getBoundingClientRect().width).toBe(gridValue('Column', mode))
    await expect(canvasElement.querySelectorAll('[data-column]')).toHaveLength(gridValue('Columns', mode))
    await waitFor(() => expect(canvasElement.querySelector('[data-measured-column]')?.textContent).toBe(`${gridValue('Column', mode)}px`))
  }

/** The Desktop frame: 24 columns over 1440px. */
export const DesktopFrame: Story = {
  render: () => <Frame mode="Desktop" />,
  play: columnIsFigmas('Desktop'),
}

/** The Mobile frame: 6 columns over 390px. */
export const MobileFrame: Story = {
  render: () => <Frame mode="Mobile" />,
  play: columnIsFigmas('Mobile'),
}

/**
 * The grid as a page has it: 6 columns below 768px and 24 from 768px, following the window. The blocks show how a
 * module places itself: `col-span-6 md:col-span-12`, `md:col-start-13`.
 */
export const Live: Story = {
  render: () => (
    <div className="flex flex-col gap-8 py-16">
      <Grid>
        <p className="col-span-6 bg-surface-card-selected p-8 text-copy-12 md:col-span-24">col-span-6 md:col-span-24</p>
      </Grid>
      <Grid>
        <p className="col-span-6 bg-surface-card-selected p-8 text-copy-12 md:col-span-12">col-span-6 md:col-span-12</p>
        <p className="col-span-6 bg-surface-card-selected p-8 text-copy-12 md:col-span-12">col-span-6 md:col-span-12</p>
      </Grid>
      <Grid>
        <p className="col-span-3 bg-surface-card-selected p-8 text-copy-12 md:col-span-8">col-span-3 md:col-span-8</p>
        <p className="col-span-3 bg-surface-card-selected p-8 text-copy-12 md:col-span-8">col-span-3 md:col-span-8</p>
        <p className="col-span-6 bg-surface-card-selected p-8 text-copy-12 md:col-span-8">col-span-6 md:col-span-8</p>
      </Grid>
      <Grid>
        <p className="col-span-4 col-start-2 bg-surface-card-selected p-8 text-copy-12 md:col-span-10 md:col-start-13">
          col-span-4 col-start-2 md:col-span-10 md:col-start-13
        </p>
      </Grid>
    </div>
  ),
}
