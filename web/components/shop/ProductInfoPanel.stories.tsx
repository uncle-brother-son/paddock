import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { OverlayTexture } from '@/components/ui/Overlay'
import { DURATION_SHORT } from '@/lib/motion/tokens'

import { ProductPageView } from './ProductPageView'
import { SAMPLE_PRODUCT, SAMPLE_SIMILAR } from './sample-shop'

// The panel on the page it belongs to, opened as a visitor opens it: by the links under the button, and by "Size
// guide" beside the sizes.
const meta = {
  title: 'Shop/Product Info Panel',
  component: ProductPageView,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { view: SAMPLE_PRODUCT, similar: SAMPLE_SIMILAR, readSizes: null, reducedMotion: true },
  render: (args) => (
    <>
      <OverlayTexture />
      <ProductPageView {...args} />
    </>
  ),
} satisfies Meta<typeof ProductPageView>

export default meta
type Story = StoryObj<typeof meta>
type Play = NonNullable<Story['play']>

const box = (element: Element) => element.getBoundingClientRect()
const dialogIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[role="dialog"]') as HTMLElement

/** Opens the panel by one of the page's own buttons, and waits until it has faded in. */
const open = async (context: Parameters<Play>[0], opener: string) => {
  const dialog = dialogIn(context.canvasElement)
  await expect(dialog).not.toBeVisible()
  await userEvent.click(context.canvas.getByRole('button', { name: opener }))
  await waitFor(() => expect(dialog).toBeVisible())
  await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe('1'))
  return { dialog, panel: within(dialog) }
}

/**
 * Figma "Product Info Panel" (1684:41935; the panel 1402:53320): a Light panel 12px inside the window's top, right
 * and bottom, over Wayne's Overlay, with its tabs in Label 12, 24px apart (the one on show dark, the others muted)
 * 64px down, what the tab holds 64px beneath in Copy 14, and Close at its top right. Description is the product's
 * rich text: a paragraph, then its bullets.
 */
export const Description: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { dialog, panel } = await open(context, 'Description')
    const { canvasElement } = context
    await expect([dialog.getAttribute('aria-modal'), dialog.dataset.theme, getComputedStyle(dialog).transitionDuration]).toEqual(['true', 'light', `${DURATION_SHORT}s`])
    // 12px inside the window's top, right and bottom; 9 columns of the grid wide (Figma draws 519).
    await expect([Math.round(box(dialog).top), Math.round(window.innerWidth - box(dialog).right), Math.round(window.innerHeight - box(dialog).bottom), Math.round(box(dialog).width)]).toEqual([12, 12, 12, 523])
    await expect(getComputedStyle(dialog).borderRadius).toBe('4px')
    // The tabs, with Description on show; focus has moved to it.
    const tabs = panel.getAllByRole('tab')
    await expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['Description', 'true'], ['Materials & care', 'false'], ['Shipping & returns', 'false'], ['Size guide', 'false']])
    await expect(tabs[0]).toHaveFocus()
    await expect([Math.round(box(tabs[0]!).left - box(dialog).left), Math.round(box(tabs[0]!).top - box(dialog).top), Math.round(box(tabs[1]!).left - box(tabs[0]!).right)]).toEqual([16, 64, 24])
    await expect(getComputedStyle(tabs[0]!).color).not.toBe(getComputedStyle(tabs[1]!).color)
    const shown = panel.getByRole('tabpanel')
    await expect(shown.getAttribute('aria-labelledby')).toBe(tabs[0]!.id)
    // The paragraph itself: the words are in a span of their own, whose box is the line's, not the trimmed text's.
    const paragraph = within(shown).getByText(/^Taking its namesake/).closest('p') as HTMLElement
    await expect(Math.round(box(paragraph).top - box(tabs[0]!).bottom)).toBe(64)
    await expect(getComputedStyle(paragraph).fontSize).toBe('14px')
    const bullets = within(shown).getAllByRole('listitem')
    await expect(bullets).toHaveLength(5)
    await expect(Math.round(box(bullets[0]!).top - box(paragraph).bottom)).toBe(32)
    await expect(Math.round(box(bullets[1]!).top - box(bullets[0]!).bottom)).toBe(12)
    // Close, 12px inside the panel's top right.
    const close = panel.getByRole('button', { name: 'Close' })
    await expect([Math.round(box(dialog).right - box(close).right), Math.round(box(close).top - box(dialog).top)]).toEqual([12, 12])
    // The page behind can't be reached or scrolled; the shade is over it.
    await expect([...canvasElement.querySelectorAll<HTMLElement>('[data-shop="details"], [data-shop="similar"]')].map((behind) => behind.inert)).toEqual([true, true])
    await expect(document.documentElement.classList.contains('overflow-hidden')).toBe(true)
    await expect(getComputedStyle(canvasElement.querySelector('[data-overlay="shade"]') as HTMLElement).opacity).toBe('1')
  },
}

/** Materials & Care: what it is made of, where, and how to look after it, each only when an editor filled it. */
export const MaterialsAndCare: Story = {
  name: 'Materials & Care',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { panel } = await open(context, 'Materials & care')
    await expect(panel.getByRole('tab', { name: 'Materials & care' }).getAttribute('aria-selected')).toBe('true')
    const shown = within(panel.getByRole('tabpanel'))
    await expect(shown.getByText('100% heavyweight organic cotton, 280gsm')).toBeVisible()
    await expect(shown.getByText('Made in Portugal')).toBeVisible()
    await expect(shown.getByText('Do not tumble dry.')).toBeVisible()
  },
}

/** Shipping & Returns: Shop settings' summary, the same on every product. */
export const ShippingAndReturns: Story = {
  name: 'Shipping & Returns',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { panel } = await open(context, 'Shipping & returns')
    await expect(panel.getByRole('tab', { name: 'Shipping & returns' }).getAttribute('aria-selected')).toBe('true')
    await expect(within(panel.getByRole('tabpanel')).getByText(/^Orders are sent by Royal Mail/)).toBeVisible()
  },
}

/**
 * Size Guide (WQ39): the fourth tab, only for a product with a guide, opened by "Size guide" beside the sizes: the
 * guide's table and its notes. Figma draws no size guide yet: this is the plainest table the text styles make.
 */
export const SizeGuide: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { panel } = await open(context, 'Size guide')
    await expect(panel.getByRole('tab', { name: 'Size guide' })).toHaveFocus()
    const shown = within(panel.getByRole('tabpanel'))
    const table = shown.getByRole('table', { name: 'T-shirts' })
    await expect(within(table).getAllByRole('columnheader').map((heading) => heading.textContent)).toEqual(['Size', 'Chest (cm)', 'Length (cm)'])
    await expect(within(table).getAllByRole('row')).toHaveLength(5)
    await expect(shown.getByText(/^Measured flat/)).toBeVisible()
  },
}

/**
 * The tabs follow the tabs pattern: Right and Left move between them (round the ends), Home and End go to the first
 * and last, and each shows its panel as it takes focus. Esc closes the panel, and focus goes back to the link that
 * opened it. Every tab's words are in the page whether or not the panel is open.
 */
export const KeyboardAndClosing: Story = {
  name: 'Keyboard, and closing',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { canvas, canvasElement } = context
    // Before it is opened: all four tabs' words are in the page's HTML, hidden.
    await expect(canvasElement.querySelectorAll('[role="tabpanel"]')).toHaveLength(4)
    await expect(canvasElement.textContent).toContain('Made in Portugal')
    await expect(canvasElement.textContent).toContain('Measured flat')

    const { dialog, panel } = await open(context, 'Materials & care')
    const selected = () => panel.getByRole('tab', { selected: true })
    await userEvent.keyboard('{ArrowRight}')
    await expect(selected().textContent).toBe('Shipping & returns')
    await expect(selected()).toHaveFocus()
    await expect(within(panel.getByRole('tabpanel')).getByText(/^Orders are sent/)).toBeVisible()
    await userEvent.keyboard('{End}')
    await expect(selected().textContent).toBe('Size guide')
    await userEvent.keyboard('{ArrowRight}')
    await expect(selected().textContent).toBe('Description')
    await userEvent.keyboard('{ArrowLeft}')
    await expect(selected().textContent).toBe('Size guide')
    await userEvent.keyboard('{Home}')
    await expect(selected().textContent).toBe('Description')
    // Tab goes on into the panel: what the tab holds, then Close; never out to the page behind.
    await userEvent.tab()
    await expect(panel.getByRole('tabpanel')).toHaveFocus()
    await userEvent.tab()
    await expect(panel.getByRole('button', { name: 'Close' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(dialog).not.toBeVisible())
    await expect(canvas.getByRole('button', { name: 'Materials & care' })).toHaveFocus()
    await expect((canvasElement.querySelector('[data-shop="details"]') as HTMLElement).inert).toBe(false)
    await expect(document.documentElement.classList.contains('overflow-hidden')).toBe(false)
    // A press on the shade closes it too.
    await open(context, 'Description')
    await userEvent.click(canvasElement.querySelector('[data-overlay="shade"]') as HTMLElement)
    await waitFor(() => expect(dialog).not.toBeVisible())
    await expect(canvas.getByRole('button', { name: 'Description' })).toHaveFocus()
  },
}

/**
 * Figma "Product Info Panel (mobile)" (1684:42004): 12px inside every edge of the window. The tabs don't all fit:
 * they are a row to swipe.
 */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    const { dialog, panel } = await open(context, 'Description')
    await expect([Math.round(box(dialog).left), Math.round(box(dialog).top), Math.round(box(dialog).width), Math.round(window.innerHeight - box(dialog).bottom)]).toEqual([12, 12, 366, 12])
    const tabs = panel.getByRole('tablist')
    await expect(tabs.scrollWidth).toBeGreaterThan(tabs.clientWidth)
    await expect(document.documentElement.scrollWidth).toBe(390)
    // Moving to the last tab brings it into view.
    await userEvent.keyboard('{End}')
    const last = panel.getByRole('tab', { name: 'Size guide' })
    await waitFor(() => expect(box(last).right).toBeLessThanOrEqual(box(dialog).right))
  },
}
