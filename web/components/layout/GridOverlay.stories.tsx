import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor } from 'storybook/test'

import tokens from '@/lib/design/figma-tokens.json'
import { GRID_OVERLAY_STORAGE_KEY } from '@/lib/design/grid-overlay'
import { LIVE_HOST } from '@/lib/site'

import { Grid } from './Grid'
import { GridOverlay } from './GridOverlay'

type Measurements = 'Desktop' | 'Mobile'

const gridValue = (name: 'Width' | 'Columns' | 'Margin' | 'Column', mode: Measurements): number => tokens.measurements[`Spacing/Grid/${name}`][mode]

/** A stand-in page laid out on the grid, for the overlay to sit over. */
function SamplePage() {
  return (
    <div className="flex flex-col gap-40 py-40">
      <Grid>
        <p className="col-span-4 text-label-12 md:col-span-8">The Paddock Wellness Club</p>
        <p className="col-span-2 text-right text-label-12 md:col-span-4 md:col-start-21">Menu</p>
      </Grid>
      <Grid>
        <div data-theme="dark" className="col-span-6 flex h-240 items-end bg-surface-primary p-16 md:col-span-16">
          <p className="text-h1">Sauna and contrast therapy</p>
        </div>
        <div className="col-span-6 mt-8 flex flex-col gap-16 bg-surface-card p-16 md:col-span-8 md:mt-0">
          <p className="text-h3">Eight columns</p>
          <p className="text-copy-14">A module names how many columns it takes; the gutters between them come from the grid.</p>
        </div>
      </Grid>
      <Grid className="gap-y-8">
        {['One', 'Two', 'Three'].map((name) => (
          <div key={name} className="col-span-6 flex flex-col gap-16 bg-surface-card p-16 md:col-span-8">
            <p className="text-h3">{name}</p>
            <p className="text-copy-14">A third of the width on a desktop, the whole width on a phone.</p>
          </div>
        ))}
      </Grid>
      <Grid>
        <label htmlFor="sample-field" className="col-span-6 text-label-12 md:col-span-8">
          A field to type in
        </label>
        <input id="sample-field" type="text" className="col-span-6 mt-12 border border-object-dark-dark-shade bg-surface-card p-12 text-copy-14 md:col-span-8 md:col-start-1" />
      </Grid>
    </div>
  )
}

const meta = {
  title: 'Foundations/Grid overlay',
  component: GridOverlay,
  // The sample page runs edge to edge, as a real page does.
  parameters: { padded: false, layout: 'fullscreen' },
  // Each story starts with nothing remembered in the tab, and leaves nothing behind.
  beforeEach: () => {
    window.sessionStorage.removeItem(GRID_OVERLAY_STORAGE_KEY)
    return () => window.sessionStorage.removeItem(GRID_OVERLAY_STORAGE_KEY)
  },
  render: (args) => (
    <>
      <SamplePage />
      <GridOverlay {...args} />
    </>
  ),
} satisfies Meta<typeof GridOverlay>

export default meta
type Story = StoryObj<typeof meta>
type Play = NonNullable<Story['play']>

/** The tab remembers the overlay as on, as after a press of Ctrl + G on an earlier page. */
const rememberedOn = () => {
  window.sessionStorage.setItem(GRID_OVERLAY_STORAGE_KEY, '1')
}

const pressCtrlG = () => userEvent.keyboard('{Control>}g{/Control}')

const overlayIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-grid-overlay]')

/** Long enough for the overlay's file to arrive and be drawn, for a check that it has NOT been. */
const aMoment = () => new Promise((resolve) => setTimeout(resolve, 400))

/** Which of Figma's two grids a window this wide has: the Desktop one from 768px. */
const modeOfWindow = (): Measurements => (window.innerWidth >= 768 ? 'Desktop' : 'Mobile')

/** The overlay is on the page and is the window's own grid: the right number of columns, over the whole window. */
async function overlayIsTheGrid(canvasElement: HTMLElement, mode: Measurements = modeOfWindow()) {
  await waitFor(() => expect(overlayIn(canvasElement)).not.toBeNull())
  const overlay = overlayIn(canvasElement) as HTMLElement
  await waitFor(() => expect(overlay.querySelectorAll('[data-grid-overlay-column]')).toHaveLength(gridValue('Columns', mode)))

  const style = getComputedStyle(overlay)
  await expect(overlay.getAttribute('aria-hidden')).toBe('true')
  await expect(style.pointerEvents).toBe('none')
  await expect(style.position).toBe('fixed')
  const box = overlay.getBoundingClientRect()
  await expect([box.left, box.top, box.width, box.height]).toEqual([0, 0, document.documentElement.clientWidth, window.innerHeight])

  const columns = [...overlay.querySelectorAll('[data-grid-overlay-column]')].map((column) => column.getBoundingClientRect())
  await expect(columns[0]?.left).toBe(gridValue('Margin', mode))
  await expect(columns.at(-1)?.right).toBe(document.documentElement.clientWidth - gridValue('Margin', mode))
  for (const column of columns) await expect(column.height).toBe(window.innerHeight)
  return columns
}

/** Ctrl + G switches it on and off, the tab remembers each, and at Figma's frame width the column is Figma's. */
const toggledAtFrame = (mode: Measurements): Play =>
  async ({ canvasElement }) => {
    await expect(document.documentElement.clientWidth).toBe(gridValue('Width', mode))
    await aMoment()
    await expect(overlayIn(canvasElement), 'off until asked for').toBeNull()

    await pressCtrlG()
    const columns = await overlayIsTheGrid(canvasElement, mode)
    await expect(columns).toHaveLength(gridValue('Columns', mode))
    for (const column of columns) await expect(column.width).toBe(gridValue('Column', mode))
    await waitFor(() => expect(window.sessionStorage.getItem(GRID_OVERLAY_STORAGE_KEY)).toBe('1'))

    await pressCtrlG()
    await waitFor(() => expect(overlayIn(canvasElement)).toBeNull())
    await waitFor(() => expect(window.sessionStorage.getItem(GRID_OVERLAY_STORAGE_KEY)).toBe('0'))
  }

/**
 * The overlay over a sample page, as Ctrl + G (or `?grid=1`) shows it on a test copy. Here it starts on because
 * the tab remembers it; press Ctrl + G to take it away and bring it back.
 */
export const OverSamplePage: Story = {
  name: 'Over a sample page',
  beforeEach: rememberedOn,
  play: async ({ canvasElement }) => {
    await overlayIsTheGrid(canvasElement)
  },
}

/** Tests only (not in the sidebar): at Figma's Desktop frame, 24 columns of 51px. */
export const ToggledAt1440: Story = {
  name: 'Toggled at 1440',
  tags: ['!dev'],
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: toggledAtFrame('Desktop'),
}

/** Tests only: at Figma's Mobile frame, 6 columns of 53px. */
export const ToggledAt390: Story = {
  name: 'Toggled at 390',
  tags: ['!dev'],
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: toggledAtFrame('Mobile'),
}

/** Tests only: Ctrl + G does nothing while typing in a field, and the letter still goes into the field. */
export const NothingWhileTyping: Story = {
  name: 'Nothing while typing in a field',
  tags: ['!dev'],
  play: async ({ canvasElement }) => {
    const field = canvasElement.querySelector('input') as HTMLInputElement
    await userEvent.click(field)
    await pressCtrlG()
    await aMoment()
    await expect(overlayIn(canvasElement)).toBeNull()
    await userEvent.keyboard('g')
    await expect(field.value).toBe('g')

    // Out of the field, the same press works.
    field.blur()
    await pressCtrlG()
    await overlayIsTheGrid(canvasElement)
  },
}

/** Tests only: a browser that refuses sessionStorage (a private window can) still gets the overlay; it is just not remembered. */
export const StorageRefused: Story = {
  name: 'When the browser refuses sessionStorage',
  tags: ['!dev'],
  beforeEach: () => {
    const { getItem, setItem } = Storage.prototype
    const refuse = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    Storage.prototype.getItem = refuse
    Storage.prototype.setItem = refuse
    return () => {
      Storage.prototype.getItem = getItem
      Storage.prototype.setItem = setItem
    }
  },
  play: async ({ canvasElement }) => {
    await aMoment()
    await expect(overlayIn(canvasElement)).toBeNull()
    await pressCtrlG()
    await overlayIsTheGrid(canvasElement)
    await pressCtrlG()
    await waitFor(() => expect(overlayIn(canvasElement)).toBeNull())
  },
}

/** Tests only: a test copy's host has the overlay. The other side of "never on the live domain". */
export const OnATestCopy: Story = {
  name: 'On a test copy',
  tags: ['!dev'],
  args: { host: 'paddock.paddock-55d.workers.dev' },
  beforeEach: rememberedOn,
  play: async ({ canvasElement }) => {
    await overlayIsTheGrid(canvasElement)
  },
}

/**
 * Tests only: on the live domain there is no overlay, even with the tab remembering it as on and Ctrl + G pressed.
 * Nothing of it is on the page.
 */
export const OnTheLiveHost: Story = {
  name: 'On the live domain',
  tags: ['!dev'],
  args: { host: LIVE_HOST },
  beforeEach: rememberedOn,
  play: async ({ canvasElement }) => {
    await aMoment()
    await expect(overlayIn(canvasElement)).toBeNull()
    await pressCtrlG()
    await aMoment()
    await expect(overlayIn(canvasElement)).toBeNull()
    await expect(canvasElement.querySelector('[aria-hidden]')).toBeNull()
    // Still as it was remembered: the overlay's code never ran, so nothing rewrote it.
    await expect(window.sessionStorage.getItem(GRID_OVERLAY_STORAGE_KEY)).toBe('1')
  },
}
