import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { expect, waitFor } from 'storybook/test'

import { Grid } from '@/components/layout/Grid'
import { useGridColumns } from '@/components/layout/useGridColumns'
import tokens from '@/lib/design/figma-tokens.json'

import { px, useMeasured, VariableValue } from './measured'

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

/**
 * Lets what is inside reach both edges of the window wherever it sits. On its own page a story already does; on a
 * docs page it sits in a centred column, and this pulls it out to the window's edges.
 */
function FullBleed({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const place = () => {
      if (!outer.current || !inner.current) return
      inner.current.style.marginLeft = `${-(outer.current.getBoundingClientRect().left + window.scrollX)}px`
      inner.current.style.width = `${document.documentElement.clientWidth}px`
    }
    const observer = new ResizeObserver(place)
    observer.observe(document.documentElement)
    if (outer.current) observer.observe(outer.current)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={outer}>
      <div ref={inner}>{children}</div>
    </div>
  )
}

function subscribeToResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

/** The window's width, without a scrollbar, followed as it is resized. */
const useWindowWidth = (): number =>
  useSyncExternalStore(
    subscribeToResize,
    () => document.documentElement.clientWidth,
    () => 0,
  )

/** The first drawn column's width, measured from the page and kept current as the column changes size. */
function useFirstColumnWidth(count: number): [RefObject<HTMLDivElement | null>, string] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState('')

  useEffect(() => {
    const column = ref.current?.querySelector('[data-column="1"]')
    if (!column) return
    const observer = new ResizeObserver(() => setWidth(px(column.getBoundingClientRect().width)))
    observer.observe(column)
    return () => observer.disconnect()
    // The columns are drawn again when their number changes, so the first one is looked up again.
  }, [count])

  return [ref, width]
}

/**
 * The grid as every page has it, drawn from one edge of the window to the other: the number of columns and the
 * margin and gutter come from the grid tokens at the window's present width, and the column width is measured.
 */
function WindowGrid() {
  const count = useGridColumns()
  const windowWidth = useWindowWidth()
  const [ref, column] = useFirstColumnWidth(count)

  return (
    <FullBleed>
      <figure className="bg-surface-primary">
        <figcaption className="p-16 text-copy-14">
          <span className="text-bold-14">
            <span data-live-columns="">{count}</span> columns
          </span>{' '}
          · column <span data-live-column="">{column}</span> · window <span data-live-window="">{windowWidth}px</span> · margin{' '}
          <VariableValue name="--grid-margin" /> · gutter <VariableValue name="--grid-gutter" />
        </figcaption>
        <div ref={ref}>
          <Grid className="h-240 bg-surface-card">
            <Columns count={count} />
          </Grid>
        </div>
      </figure>
    </FullBleed>
  )
}

/** Which of Figma's two grids a window this wide has: the Desktop one from 768px. */
const modeOfWindow = (): Measurements => (window.innerWidth >= 768 ? 'Desktop' : 'Mobile')

/**
 * The drawn grid is the window's: the right number of columns for its width, from the margin on the left to the
 * margin on the right, each as wide as the tokens make it, and the two figures printed above it say the same.
 */
const gridFillsTheWindow: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const mode = modeOfWindow()
  const count = gridValue('Columns', mode)
  const margin = gridValue('Margin', mode)
  const windowWidth = document.documentElement.clientWidth
  const expected = (windowWidth - 2 * margin - (count - 1) * gridValue('Gutter', mode)) / count

  await waitFor(() => expect(canvasElement.querySelectorAll('[data-column]')).toHaveLength(count))
  const columns = [...canvasElement.querySelectorAll('[data-column]')].map((column) => column.getBoundingClientRect())
  await expect(columns[0]?.left).toBeCloseTo(margin, 1)
  await expect(columns.at(-1)?.right).toBeCloseTo(windowWidth - margin, 1)
  for (const column of columns) await expect(column.width).toBeCloseTo(expected, 1)
  await expect(canvasElement.querySelector('[data-live-columns]')?.textContent).toBe(String(count))
  await waitFor(() => expect(canvasElement.querySelector('[data-live-column]')?.textContent).toBe(px(expected)))
  await expect(canvasElement.querySelector('[data-live-window]')?.textContent).toBe(`${windowWidth}px`)
  await expect(document.documentElement.scrollWidth, 'nothing scrolls sideways').toBe(windowWidth)
}

/** At one of Figma's two frame widths the measured column is Figma's own figure: 51px at 1440, 53px at 390. */
const columnIsFigmasAt = (mode: Measurements): NonNullable<Story['play']> =>
  async (context) => {
    await expect(document.documentElement.clientWidth).toBe(gridValue('Width', mode))
    await gridFillsTheWindow(context)
    await expect(context.canvasElement.querySelector('[data-column="1"]')?.getBoundingClientRect().width).toBe(gridValue('Column', mode))
    await expect(context.canvasElement.querySelectorAll('[data-column]')).toHaveLength(gridValue('Columns', mode))
  }

/**
 * The real grid, full width across the window: 6 columns below 768px and 24 from 768px, a 16px margin and an 8px
 * gutter, following the window as it is resized. The number of columns and the column's width are printed live.
 */
export const FullWidth: Story = {
  name: 'Full width',
  parameters: { layout: 'fullscreen' },
  render: () => <WindowGrid />,
  play: gridFillsTheWindow,
}

// The same story at fixed window widths, for the tests only (not listed in the sidebar): Figma's two frames, and
// the width where the Mobile grid gives way to the Desktop one. Each is written out in full: Storybook reads a
// story's tags from the source, and misses them on a story built by a function.
export const FullWidthAt390: Story = {
  name: 'Full width at 390',
  tags: ['!dev'],
  parameters: { layout: 'fullscreen' },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  render: () => <WindowGrid />,
  play: columnIsFigmasAt('Mobile'),
}

export const FullWidthAt768: Story = {
  name: 'Full width at 768',
  tags: ['!dev'],
  parameters: { layout: 'fullscreen' },
  globals: { viewport: { value: 'tablet', isRotated: false } },
  render: () => <WindowGrid />,
  play: async (context) => {
    await expect(modeOfWindow()).toBe('Desktop')
    await gridFillsTheWindow(context)
  },
}

export const FullWidthAt1440: Story = {
  name: 'Full width at 1440',
  tags: ['!dev'],
  parameters: { layout: 'fullscreen' },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  render: () => <WindowGrid />,
  play: columnIsFigmasAt('Desktop'),
}

/** Figma frame check: the Desktop frame, 24 columns over 1440px, drawn at its real width. */
export const DesktopFrame: Story = {
  name: 'Figma frame check (1440)',
  render: () => <Frame mode="Desktop" />,
  play: columnIsFigmas('Desktop'),
}

/** Figma frame check: the Mobile frame, 6 columns over 390px, drawn at its real width. */
export const MobileFrame: Story = {
  name: 'Figma frame check (390)',
  render: () => <Frame mode="Mobile" />,
  play: columnIsFigmas('Mobile'),
}

/**
 * The grid as a page has it: 6 columns below 768px and 24 from 768px, following the window. The blocks show how a
 * module places itself: `col-span-6 md:col-span-12`, `md:col-start-13`.
 */
export const Live: Story = {
  name: 'How a module places itself',
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
