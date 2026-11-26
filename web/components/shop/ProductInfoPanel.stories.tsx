import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { OverlayTexture } from '@/components/ui/Overlay'
import { painted } from '@/components/ui/story-kit'
import { DURATION_SHORT, EASE_SMOOTH_CSS, linearEasingPoints } from '@/lib/motion/tokens'

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

/** How far the panel's right edge is from the window's: 12 once it is in its place, less than nothing while it is away. */
const fromRight = (dialog: HTMLElement) => Math.round(window.innerWidth - box(dialog).right)

/** Opens the panel by one of the page's own buttons, and waits until it has slid into its place. */
const open = async (context: Parameters<Play>[0], opener: string) => {
  const dialog = dialogIn(context.canvasElement)
  await expect(dialog).not.toBeVisible()
  await userEvent.click(context.canvas.getByRole('button', { name: opener }))
  await waitFor(() => expect(dialog).toBeVisible())
  await waitFor(() => expect(fromRight(dialog)).toBe(12), { timeout: 3000 })
  return { dialog, panel: within(dialog) }
}

/** The open panel, to look inside. */
type Panel = Awaited<ReturnType<typeof open>>['panel']

/** The tab on show is Text/Primary, every other Text/Muted Primary, all in Label 12: as each of Figma's variants draws its row. */
const expectTabColours = async (panel: Panel) => {
  const tabs = panel.getAllByRole('tab')
  const [primary, muted] = [painted(tabs[0]!, 'text-text-primary', 'color'), painted(tabs[0]!, 'text-text-muted-primary', 'color')]
  await expect(primary).not.toBe(muted)
  // A tab's colour changes over the short duration: wait until each has reached its own.
  await waitFor(() => expect(tabs.map((tab) => getComputedStyle(tab).color)).toEqual(tabs.map((tab) => (tab.getAttribute('aria-selected') === 'true' ? primary : muted))))
  await expect(tabs.map((tab) => [getComputedStyle(tab).fontSize, getComputedStyle(tab).textTransform, getComputedStyle(tab).fontWeight])).toEqual(tabs.map(() => ['12px', 'uppercase', '500']))
}

/** The site's fonts are in before a line of capitals is measured. */
const fontsIn = async (shown: HTMLElement) => {
  await document.fonts.ready
  await waitFor(() => expect([...shown.querySelectorAll('p, dt, span')].every((text) => document.fonts.check(getComputedStyle(text).font))).toBe(true))
}

/** A bullet as the panel draws one: the bullet icon, 9px, 4px, then its line in Copy 14. */
const expectBullet = async (item: HTMLElement) => {
  const icon = item.querySelector('svg') as SVGElement
  const line = item.querySelector('p') as HTMLElement
  await expect([Math.round(box(icon).width), Math.round(box(icon).height), Math.round(box(line).left - box(icon).right), getComputedStyle(line).fontSize]).toEqual([9, 9, 4, '14px'])
}

/**
 * Figma "Product Info Panel" (1684:41935; the panel 1402:53320): a Light panel 12px inside the window's top, right
 * and bottom, over Wayne's Overlay, with its tabs in Label 12, 24px apart (the one on show dark, the others muted)
 * 64px down, what the tab holds 64px beneath in Copy 14, and Close with its label at its top right (WQ50).
 * Description is the product's rich text: a paragraph, then its bullets.
 */
export const Description: Story = {
  name: 'Device=desktop, Tab=description',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { dialog, panel } = await open(context, 'Description')
    const { canvasElement } = context
    await expect([dialog.getAttribute('aria-modal'), dialog.dataset.theme]).toEqual(['true', 'light'])
    // 12px inside the window's top, right and bottom; 9 columns of the grid wide (Figma draws 519).
    await expect([Math.round(box(dialog).top), Math.round(window.innerWidth - box(dialog).right), Math.round(window.innerHeight - box(dialog).bottom), Math.round(box(dialog).width)]).toEqual([12, 12, 12, 523])
    await expect(getComputedStyle(dialog).borderRadius).toBe('4px')
    // The tabs, with Description on show; focus has moved to it.
    const tabs = panel.getAllByRole('tab')
    await expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['Description', 'true'], ['Materials & care', 'false'], ['Shipping & returns', 'false'], ['Size Guide', 'false']])
    await expect(tabs[0]).toHaveFocus()
    await expect([Math.round(box(tabs[0]!).left - box(dialog).left), Math.round(box(tabs[0]!).top - box(dialog).top), Math.round(box(tabs[1]!).left - box(tabs[0]!).right)]).toEqual([16, 64, 24])
    await expectTabColours(panel)
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
    await expectBullet(bullets[0]!)
    // Close, 12px inside the panel's top right. WQ50: Figma's MenuButton with its label shown, as drawn on the page
    // (1684:41949): the close icon, 8px, "Close" in Label 12, 8px all round. Its words are its name.
    const close = panel.getByRole('button', { name: 'Close' })
    await expect([Math.round(box(dialog).right - box(close).right), Math.round(box(close).top - box(dialog).top)]).toEqual([12, 12])
    await expect([close.hasAttribute('aria-label'), close.textContent]).toEqual([false, 'Close'])
    const closeIcon = close.querySelector('svg') as SVGElement
    const closeLabel = within(close).getByText('Close')
    await expect([getComputedStyle(closeLabel).fontSize, getComputedStyle(closeLabel).textTransform, getComputedStyle(closeLabel).fontWeight]).toEqual(['12px', 'uppercase', '500'])
    await expect([Math.round(box(closeIcon).width), Math.round(box(closeIcon).height)]).toEqual([9, 9])
    await expect([
      Math.round(box(closeIcon).left - box(close).left),
      Math.round(box(closeLabel).left - box(closeIcon).right),
      Math.round(box(close).right - box(closeLabel).right),
      Math.round(box(close).height),
    ]).toEqual([8, 8, 8, 25])
    // The page behind can't be reached or scrolled; the shade is over it.
    // (W78b: the details are inside their StickyColumn, which is the part made inert.)
    await expect([...canvasElement.querySelectorAll<HTMLElement>('[data-shop="details"], [data-shop="similar"]')].map((behind) => behind.closest('[inert]') !== null)).toEqual([true, true])
    await expect(document.documentElement.classList.contains('overflow-hidden')).toBe(true)
    // (The shade's fade ends with the panel's slide; the last of it is too slight to see, so it is waited for.)
    await waitFor(() => expect(getComputedStyle(canvasElement.querySelector('[data-overlay="shade"]') as HTMLElement).opacity).toBe('1'), { timeout: 3000 })
  },
}

/**
 * WQ49: it slides in from the right as the Bag does in Wayne's prototype (Figma 04 Animations, 1569:62058): from just
 * beyond the window's right edge to its place over the short duration with the smooth curve (W78a; Wayne, 25 Nov:
 * the panels take 320 ms), never fading, while the shade fades in behind it over the same time. Closing is the same
 * backwards, and only then is it hidden.
 */
export const SlidesIn: Story = {
  name: 'Slides in from the right',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const dialog = dialogIn(canvasElement)
    const shade = canvasElement.querySelector('[data-overlay="shade"]') as HTMLElement
    const smooth = linearEasingPoints(EASE_SMOOTH_CSS)
    // Shut: hidden, and wholly beyond the window's right edge, taking no room (the page is no wider for it).
    await expect(dialog).not.toBeVisible()
    await expect(Math.round(box(dialog).left)).toBe(window.innerWidth)
    await expect(document.documentElement.scrollWidth).toBe(window.innerWidth)
    await userEvent.click(canvas.getByRole('button', { name: 'Description' }))
    // On its way: there to be seen at once, as solid as it will be, still short of its place.
    await waitFor(() => expect(dialog).toBeVisible())
    const moving = dialog.getAnimations().map((animation) => {
      const timing = animation.effect!.getComputedTiming()
      return [(animation as CSSTransition).transitionProperty, timing.duration]
    })
    await expect(moving).toEqual([['translate', DURATION_SHORT * 1000]])
    await expect(linearEasingPoints(getComputedStyle(dialog).transitionTimingFunction)).toEqual(smooth)
    await expect(getComputedStyle(dialog).opacity).toBe('1')
    await expect(fromRight(dialog)).toBeLessThan(12)
    // The shade fades in behind it over the same time.
    await expect([getComputedStyle(shade).transitionDuration, getComputedStyle(shade).transitionProperty]).toEqual([`${DURATION_SHORT}s`, 'opacity'])
    await expect(Number(getComputedStyle(shade).opacity)).toBeLessThan(1)
    // In its place: 12px from the window's right edge, the shade whole, the window scrolled nowhere.
    await waitFor(() => expect(fromRight(dialog)).toBe(12), { timeout: 3000 })
    await waitFor(() => expect([getComputedStyle(dialog).opacity, getComputedStyle(shade).opacity]).toEqual(['1', '1']), { timeout: 3000 })
    await expect([window.scrollX, document.documentElement.scrollWidth]).toEqual([0, window.innerWidth])
    // Closing: back the way it came, still to be seen and solid while it goes, and hidden once it has gone.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(fromRight(dialog)).toBeLessThan(12))
    await expect([getComputedStyle(dialog).visibility, getComputedStyle(dialog).opacity]).toEqual(['visible', '1'])
    await expect(dialog.getAnimations().map((animation) => (animation as CSSTransition).transitionProperty).sort()).toEqual(['translate', 'visibility'])
    await waitFor(() => expect(dialog).not.toBeVisible(), { timeout: 3000 })
    await expect(Math.round(box(dialog).left)).toBe(window.innerWidth)
    await waitFor(() => expect(shade).not.toBeVisible(), { timeout: 3000 })
  },
}

/**
 * What Tab=material & care holds (W78b, WQ75): three headings in Label 12, Text/Primary, each with its words 12px
 * beneath in Copy 14, 24px between one and the next; the care lines are bullets, 12px apart, the first 12px under
 * its heading. The first heading is 64px under the tabs.
 */
const expectMaterialsAndCare = async (panel: Panel) => {
  const tab = panel.getByRole('tab', { name: 'Materials & care' })
  await expect(tab.getAttribute('aria-selected')).toBe('true')
  await expectTabColours(panel)
  const shownPanel = panel.getByRole('tabpanel')
  await fontsIn(shownPanel)
  const shown = within(shownPanel)
  const headings = [...shownPanel.querySelectorAll('dt')] as HTMLElement[]
  await expect(headings.map((heading) => heading.textContent)).toEqual(['Composition:', 'Made in:', 'Care Instructions:'])
  await expect(headings.map((heading) => [getComputedStyle(heading).fontSize, getComputedStyle(heading).textTransform, getComputedStyle(heading).fontWeight])).toEqual(headings.map(() => ['12px', 'uppercase', '500']))
  await expect(headings.map((heading) => getComputedStyle(heading).color)).toEqual(headings.map(() => painted(shownPanel, 'text-text-primary', 'color')))
  await expect(Math.round(box(headings[0]!).top - box(tab).bottom)).toBe(64)
  const composition = shown.getByText('100% heavyweight organic cotton, 280gsm')
  const madeIn = shown.getByText('Portugal')
  await expect([getComputedStyle(composition).fontSize, getComputedStyle(madeIn).fontSize]).toEqual(['14px', '14px'])
  // 12px from a heading to its words, 24px from them to the next heading.
  await expect([Math.round(box(composition).top - box(headings[0]!).bottom), Math.round(box(headings[1]!).top - box(composition).bottom)]).toEqual([12, 24])
  await expect([Math.round(box(madeIn).top - box(headings[1]!).bottom), Math.round(box(headings[2]!).top - box(madeIn).bottom)]).toEqual([12, 24])
  // The care lines, one bullet for each line an editor typed.
  const care = shown.getAllByRole('listitem')
  await expect(care.map((line) => line.textContent)).toEqual(['Wash at 30 degrees, inside out.', 'Do not tumble dry.'])
  await expect([Math.round(box(care[0]!).top - box(headings[2]!).bottom), Math.round(box(care[1]!).top - box(care[0]!).bottom)]).toEqual([12, 12])
  for (const line of care) await expectBullet(line)
  // Every heading and line starts at the panel's 16px.
  const dialog = shownPanel.closest('[role="dialog"]') as HTMLElement
  await expect([...headings, composition, madeIn, ...care].map((part) => Math.round(box(part).left - box(dialog).left))).toEqual([16, 16, 16, 16, 16, 16, 16])
}

/**
 * Figma ProductInfoPanel, Device=desktop, Tab=material & care (1802:39277): what it is made of, where, and how to
 * look after it, each under its own heading and only when an editor filled it.
 */
export const MaterialsAndCare: Story = {
  name: 'Device=desktop, Tab=material & care',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { panel } = await open(context, 'Materials & care')
    await expectMaterialsAndCare(panel)
  },
}

/** What Tab=shipping & returns holds: Shop settings' summary as the panel draws rich text: 32px between a paragraph and a list, bullets 12px apart. */
const expectShippingAndReturns = async (panel: Panel) => {
  const tab = panel.getByRole('tab', { name: 'Shipping & returns' })
  await expect(tab.getAttribute('aria-selected')).toBe('true')
  await expectTabColours(panel)
  const shownPanel = panel.getByRole('tabpanel')
  await fontsIn(shownPanel)
  const shown = within(shownPanel)
  const paragraph = shown.getByText(/^Orders are sent by Royal Mail/).closest('p') as HTMLElement
  await expect([Math.round(box(paragraph).top - box(tab).bottom), getComputedStyle(paragraph).fontSize]).toEqual([64, '14px'])
  const bullets = shown.getAllByRole('listitem')
  await expect(bullets.map((bullet) => bullet.textContent)).toEqual(['Standard delivery, free over £60', 'Returns within 30 days, unworn'])
  await expect([Math.round(box(bullets[0]!).top - box(paragraph).bottom), Math.round(box(bullets[1]!).top - box(bullets[0]!).bottom)]).toEqual([32, 12])
  for (const bullet of bullets) await expectBullet(bullet)
}

/** Device=desktop, Tab=shipping & returns (1802:39345): Shop settings' summary, the same on every product. */
export const ShippingAndReturns: Story = {
  name: 'Device=desktop, Tab=shipping & returns',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { panel } = await open(context, 'Shipping & returns')
    await expectShippingAndReturns(panel)
  },
}

/**
 * What Tab=size guide holds (W78b, WQ75): the guide's table, ruled in Text/Muted Primary, 1px: all round it, under
 * every row but the last and after every column but the last. Its columns are equal; a cell has 12px all round its
 * words, centred: headings in Label 12, the rest in Copy 14. 32px beneath it the guide's notes in Copy 14.
 */
const expectSizeGuide = async (panel: Panel) => {
  const tab = panel.getByRole('tab', { name: 'Size Guide' })
  await expect(tab.getAttribute('aria-selected')).toBe('true')
  await expectTabColours(panel)
  const shownPanel = panel.getByRole('tabpanel')
  await fontsIn(shownPanel)
  const shown = within(shownPanel)
  const dialog = shownPanel.closest('[role="dialog"]') as HTMLElement
  const table = shown.getByRole('table', { name: 'T-shirts' })
  // The panel's whole width but for its 16px each side, 64px under the tabs.
  await expect([Math.round(box(table).left - box(dialog).left), Math.round(box(dialog).right - box(table).right), Math.round(box(table).top - box(tab).bottom)]).toEqual([16, 16, 64])
  const headings = within(table).getAllByRole('columnheader')
  await expect(headings.map((heading) => heading.textContent)).toEqual(['Size', 'Chest (cm)', 'Length (cm)'])
  const rows = within(table).getAllByRole('row')
  await expect(rows).toHaveLength(5)
  const cells = rows.map((row) => [...row.children] as HTMLElement[])
  await expect(cells.slice(1).map((row) => row.map((cell) => cell.textContent))).toEqual([['S', '106', '70'], ['M', '112', '72'], ['L', '118', '74'], ['XL', '124', '76']])
  // Equal columns: each a third of what is inside the table's own line.
  const inside = box(table).width - 2
  await expect(cells.flat().filter((cell) => Math.abs(box(cell).width - inside / 3) > 0.75).map((cell) => cell.textContent)).toEqual([])
  // The lines: 1px all round the table; under each row but the last; after each column but the last.
  const muted = painted(table, 'text-text-muted-primary', 'color')
  const lines = (element: HTMLElement) => {
    const style = getComputedStyle(element)
    return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map((width) => parseFloat(width))
  }
  await expect([lines(table), getComputedStyle(table).borderTopColor, getComputedStyle(table).borderTopStyle]).toEqual([[1, 1, 1, 1], muted, 'solid'])
  await expect(cells.map((row, rowIndex) => row.map((cell) => lines(cell).join(' ')).join(' | ') + (rowIndex === 4 ? ' (last)' : ''))).toEqual([
    '0 1 1 0 | 0 1 1 0 | 0 0 1 0',
    '0 1 1 0 | 0 1 1 0 | 0 0 1 0',
    '0 1 1 0 | 0 1 1 0 | 0 0 1 0',
    '0 1 1 0 | 0 1 1 0 | 0 0 1 0',
    '0 1 0 0 | 0 1 0 0 | 0 0 0 0 (last)',
  ])
  await expect(cells.flat().filter((cell) => getComputedStyle(cell).borderBottomColor !== muted || getComputedStyle(cell).borderRightColor !== muted).length).toBe(0)
  // Each cell: 12px all round its words, which are centred; Label 12 in the headings, Copy 14 beneath.
  for (const [rowIndex, row] of cells.entries()) {
    for (const [index, cell] of row.entries()) {
      const words = cell.firstElementChild as HTMLElement
      const [right, bottom] = lines(cell).slice(1, 3) as [number, number]
      await expect([Math.round(box(words).top - box(cell).top), Math.round(box(cell).bottom - bottom - box(words).bottom), Math.round(box(words).left - box(cell).left), Math.round(box(cell).right - right - box(words).right)], `row ${rowIndex}, column ${index}`).toEqual([12, 12, 12, 12])
      await expect([getComputedStyle(cell).textAlign, getComputedStyle(words).fontSize, getComputedStyle(words).textTransform]).toEqual(rowIndex === 0 ? ['center', '12px', 'uppercase'] : ['center', '14px', 'none'])
    }
  }
  await expect(cells.flat().map((cell) => getComputedStyle(cell.firstElementChild as HTMLElement).color)).toEqual(cells.flat().map(() => painted(table, 'text-text-primary', 'color')))
  // The guide's notes, 32px beneath the table.
  const notes = shown.getByText(/^Measured flat/).closest('p') as HTMLElement
  await expect([Math.round(box(notes).top - box(table).bottom), getComputedStyle(notes).fontSize]).toEqual([32, '14px'])
}

/**
 * Device=desktop, Tab=size guide (1802:39413; WQ39): the fourth tab, only for a product with a guide, opened by
 * "Size guide" beside the sizes: the guide's table and its notes.
 */
export const SizeGuide: Story = {
  name: 'Device=desktop, Tab=size guide',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async (context) => {
    const { panel } = await open(context, 'Size guide')
    await expect(panel.getByRole('tab', { name: 'Size Guide' })).toHaveFocus()
    await expectSizeGuide(panel)
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
    await expect(canvasElement.textContent).toContain('Made in:Portugal')
    await expect(canvasElement.textContent).toContain('Measured flat')

    const { dialog, panel } = await open(context, 'Materials & care')
    const selected = () => panel.getByRole('tab', { selected: true })
    await userEvent.keyboard('{ArrowRight}')
    await expect(selected().textContent).toBe('Shipping & returns')
    await expect(selected()).toHaveFocus()
    await expect(within(panel.getByRole('tabpanel')).getByText(/^Orders are sent/)).toBeVisible()
    await userEvent.keyboard('{End}')
    await expect(selected().textContent).toBe('Size Guide')
    await userEvent.keyboard('{ArrowRight}')
    await expect(selected().textContent).toBe('Description')
    await userEvent.keyboard('{ArrowLeft}')
    await expect(selected().textContent).toBe('Size Guide')
    await userEvent.keyboard('{Home}')
    await expect(selected().textContent).toBe('Description')
    // Tab goes on into the panel: what the tab holds, then Close; never out to the page behind.
    await userEvent.tab()
    await expect(panel.getByRole('tabpanel')).toHaveFocus()
    await userEvent.tab()
    await expect(panel.getByRole('button', { name: 'Close' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(dialog).not.toBeVisible(), { timeout: 3000 })
    await expect(canvas.getByRole('button', { name: 'Materials & care' })).toHaveFocus()
    await expect((canvasElement.querySelector('[data-shop="details"]') as HTMLElement).inert).toBe(false)
    await expect(document.documentElement.classList.contains('overflow-hidden')).toBe(false)
    // A press on the shade closes it too.
    await open(context, 'Description')
    await userEvent.click(canvasElement.querySelector('[data-overlay="shade"]') as HTMLElement)
    await waitFor(() => expect(dialog).not.toBeVisible(), { timeout: 3000 })
    await expect(canvas.getByRole('button', { name: 'Description' })).toHaveFocus()
  },
}

/**
 * Where the row of tabs stands on a phone, as each of Figma's Device=mobile variants draws it for its tab: at its
 * start, in its middle or at its end. The chosen tab is whole inside the panel's 16px either side.
 */
const expectTabRow = async (panel: Panel, name: string, stands: 'start' | 'middle' | 'end') => {
  const row = panel.getByRole('tablist')
  const room = row.scrollWidth - row.clientWidth
  await expect(room).toBeGreaterThan(0)
  const at = { start: 0, middle: room / 2, end: room }[stands]
  await waitFor(() => expect(Math.abs(row.scrollLeft - at)).toBeLessThan(1))
  const tab = panel.getByRole('tab', { name })
  const dialog = row.closest('[role="dialog"]') as HTMLElement
  await expect(box(tab).left).toBeGreaterThanOrEqual(box(dialog).left + 15.5)
  await expect(box(tab).right).toBeLessThanOrEqual(box(dialog).right - 15.5)
  await expect(document.documentElement.scrollWidth).toBe(390)
}

/**
 * Figma ProductInfoPanel, Device=mobile, Tab=description (1402:53319; on the page 1684:42004): 12px inside every
 * edge of the window. The tabs don't all fit: they are a row to swipe, standing at its start.
 */
export const Mobile: Story = {
  name: 'Device=mobile, Tab=description',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    // Shut, it waits beyond the right edge and the page is no wider for it.
    await expect([Math.round(box(dialogIn(context.canvasElement)).left), document.documentElement.scrollWidth]).toEqual([390, 390])
    const { dialog, panel } = await open(context, 'Description')
    await expect([Math.round(box(dialog).left), Math.round(box(dialog).top), Math.round(box(dialog).width), Math.round(window.innerHeight - box(dialog).bottom)]).toEqual([12, 12, 366, 12])
    // Close with its label, as on the desktop (Figma 1684:42017).
    await expect(panel.getByRole('button', { name: 'Close' }).textContent).toBe('Close')
    await expectTabRow(panel, 'Description', 'start')
    await expectTabColours(panel)
    const shownPanel = panel.getByRole('tabpanel')
    const paragraph = within(shownPanel).getByText(/^Taking its namesake/).closest('p') as HTMLElement
    const bullets = within(shownPanel).getAllByRole('listitem')
    await expect([Math.round(box(paragraph).left - box(dialog).left), Math.round(box(dialog).right - box(paragraph).right)]).toEqual([16, 16])
    await expect([Math.round(box(bullets[0]!).top - box(paragraph).bottom), Math.round(box(bullets[1]!).top - box(bullets[0]!).bottom)]).toEqual([32, 12])
    await expectBullet(bullets[0]!)
    // Moving along the tabs with the keyboard takes the row with it: the middle for the third, the end for the last.
    await userEvent.keyboard('{ArrowRight}')
    await expectTabRow(panel, 'Materials & care', 'start')
    await userEvent.keyboard('{ArrowRight}')
    await expectTabRow(panel, 'Shipping & returns', 'middle')
    await userEvent.keyboard('{End}')
    await expectTabRow(panel, 'Size Guide', 'end')
    await userEvent.keyboard('{Home}')
    await expectTabRow(panel, 'Description', 'start')
  },
}

/** Device=mobile, Tab=material & care (1802:39253): the same headings and bullets, the panel's width; the row of tabs still at its start. */
export const MobileMaterialsAndCare: Story = {
  name: 'Device=mobile, Tab=material & care',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    const { panel } = await open(context, 'Materials & care')
    await expectTabRow(panel, 'Materials & care', 'start')
    await expectMaterialsAndCare(panel)
  },
}

/** Device=mobile, Tab=shipping & returns (1802:39321): the row of tabs stands in its middle, where this tab is whole. */
export const MobileShippingAndReturns: Story = {
  name: 'Device=mobile, Tab=shipping & returns',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    const { panel } = await open(context, 'Shipping & returns')
    await expectTabRow(panel, 'Shipping & returns', 'middle')
    await expectShippingAndReturns(panel)
  },
}

/**
 * A guide with more columns than a phone has room for (Figma draws three, which fit): each cell keeps its words on
 * one line with its 12px all round, and the table scrolls sideways by itself; the panel and the page are no wider.
 */
export const MobileWideSizeGuide: Story = {
  name: 'A size guide too wide for a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  args: {
    view: {
      ...SAMPLE_PRODUCT,
      sizeGuide: { title: 'Hoodies', columns: ['Size', 'Chest (cm)', 'Length (cm)', 'Sleeve (cm)', 'Shoulder (cm)'], rows: [['S', '106', '70', '62', '48'], ['M', '112', '72', '63', '50']], notes: [] },
    },
  },
  play: async (context) => {
    const { dialog, panel } = await open(context, 'Size guide')
    const table = panel.getByRole('table', { name: 'Hoodies' })
    const scroller = table.parentElement as HTMLElement
    await expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth)
    await expect([Math.round(box(scroller).left - box(dialog).left), Math.round(box(dialog).right - box(scroller).right)]).toEqual([16, 16])
    // While it scrolls the keyboard reaches it, and it has a name: the arrow keys move it.
    await waitFor(() => expect([scroller.tabIndex, scroller.getAttribute('role'), scroller.getAttribute('aria-label')]).toEqual([0, 'group', 'Size guide: Hoodies']))
    for (const cell of table.querySelectorAll<HTMLElement>('th, td')) {
      const words = cell.firstElementChild as HTMLElement
      await expect(Math.round(box(words).left - box(cell).left)).toBe(12)
      await expect(words.scrollWidth).toBeLessThanOrEqual(words.clientWidth)
    }
    await expect(document.documentElement.scrollWidth).toBe(390)
  },
}

/** Device=mobile, Tab=size guide (1802:39389): opened by "Size guide" beside the sizes, the row of tabs at its end; the table's three columns fit the panel. */
export const MobileSizeGuide: Story = {
  name: 'Device=mobile, Tab=size guide',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    const { dialog, panel } = await open(context, 'Size guide')
    await expectTabRow(panel, 'Size Guide', 'end')
    await expectSizeGuide(panel)
    const table = panel.getByRole('table', { name: 'T-shirts' })
    await expect(Math.round(box(table).width)).toBe(334)
    // It fits, so it scrolls nowhere and is no stop for the keyboard.
    await expect((table.parentElement as HTMLElement).scrollWidth).toBeLessThanOrEqual((table.parentElement as HTMLElement).clientWidth)
    await expect((table.parentElement as HTMLElement).hasAttribute('tabindex')).toBe(false)
    await expect(box(table).right).toBeLessThanOrEqual(box(dialog).right - 15.5)
  },
}
