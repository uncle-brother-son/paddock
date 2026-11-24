import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { getRouter } from '@storybook/nextjs-vite/navigation.mock'
import { expect, userEvent, within } from 'storybook/test'

import { shopListing, type ShopQuery } from '@/lib/shop/listing'

import { SAMPLE_CATEGORIES, SAMPLE_FEATURED, SAMPLE_ITEMS } from './sample-shop'
import { ShopListing } from './ShopListing'

/** One page of the sample shop, made as the site makes it (lib/shop/listing.ts) from what the address asks for. */
const listingFor = (query: Partial<ShopQuery>, items = SAMPLE_ITEMS) =>
  shopListing({ items, categories: SAMPLE_CATEGORIES, featuredIds: SAMPLE_FEATURED, query: { category: null, sort: 'featured', page: 1, ...query } })

const meta = {
  title: 'Shop/Listing',
  component: ShopListing,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { title: 'Our Merch', categories: SAMPLE_CATEGORIES, listing: listingFor({}) },
} satisfies Meta<typeof ShopListing>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const cardsIn = (canvasElement: HTMLElement) => [...canvasElement.querySelectorAll('article')]
const namesOf = (canvasElement: HTMLElement) => cardsIn(canvasElement).map((card) => card.querySelector('a')?.getAttribute('href')?.replace('/shop/', ''))

/**
 * Figma "Shop" (1684:41835): the title in H1 240px down, the count and ALL and SORT, then twelve cards four to a
 * row, 8px between them and 80px between rows, and the pages. Sorted by Featured, the default: Shop settings'
 * Featured order (here the gift card, then two picked T-shirts), then the rest newest first.
 */
export const Desktop: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const title = canvas.getByRole('heading', { level: 1, name: 'Our Merch' })
    // Its words start a gutter inside the grid's margin: 16 + 8.
    await expect([Math.round(box(title).left) + parseFloat(getComputedStyle(title).paddingLeft), Math.round(box(title).top)]).toEqual([24, 240])
    const count = canvas.getByText('30 Items')
    await expect(Math.round(box(count).left)).toBe(24)
    // 80px from the title to the toolbar, 24px from the toolbar to the cards.
    // The toolbar is as tall as its label's capitals (9), with ALL and SORT (25) reaching 8px above and below it.
    const toolbar = count.parentElement!
    await expect([Math.round(box(toolbar).top - box(title).bottom), box(toolbar).height, box(count.nextElementSibling!).height]).toEqual([80, 9, 25])
    const cards = cardsIn(canvasElement)
    await expect(cards).toHaveLength(12)
    await expect(Math.round(box(cards[0]!).top - box(toolbar).bottom)).toBe(24)
    await expect(cards.slice(0, 5).map((card) => Math.round(box(card).left))).toEqual([16, 370, 724, 1078, 16])
    await expect(Math.round(box(cards[0]!).width)).toBe(346)
    await expect(Math.round(box(cards[4]!).top - box(cards[0]!).bottom)).toBe(80)
    await expect(namesOf(canvasElement).slice(0, 4)).toEqual(['gift-card', 'item-10', 'item-4', 'item-1'])
    // ALL and SORT end at the grid's right edge; each is the browser's own list under the designed button (WQ37).
    const sort = canvas.getByRole('combobox', { name: 'Sort by' })
    await expect(Math.round(box(sort.parentElement!).right)).toBe(1424)
    await expect(within(sort).getAllByRole('option').map((option) => option.textContent)).toEqual(['Featured', 'New in', 'Price low to high', 'Price high to low'])
    const category = canvas.getByRole('combobox', { name: 'Category' })
    await expect(within(category).getAllByRole('option').map((option) => option.textContent)).toEqual(['All', 'Apparel', 'Hoodies', 'Gift Card'])
    await expect(category.parentElement!.textContent).toContain('All')
    // The pages: an arrow each side of "1 / 3", 32px apart. On the first page only the next one is a link.
    const pages = canvas.getByRole('navigation', { name: 'Pages' })
    // Drawn "1 / 3"; read out "Page 1 of 3".
    await expect(pages.textContent?.replace(/\s+/g, ' ').trim()).toBe('Page 1 /of 3')
    await expect(within(pages).getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe('/shop?page=2')
    await expect(within(pages).queryByRole('link', { name: 'Previous page' })).toBeNull()
    await expect(Math.round(box(pages).top - box(cards[11]!.closest('ul')!).bottom)).toBe(80)
  },
}

/** Figma "Shop (mobile)" (1684:41876): 160px down, two cards to a row, 64px between rows. */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(Math.round(box(canvas.getByRole('heading', { level: 1 })).top)).toBe(160)
    const cards = cardsIn(canvasElement)
    await expect(cards.slice(0, 3).map((card) => Math.round(box(card).left))).toEqual([16, 199, 16])
    await expect(Math.round(box(cards[0]!).width)).toBe(175)
    await expect(Math.round(box(cards[2]!).top - box(cards[0]!).bottom)).toBe(64)
    await expect(document.documentElement.scrollWidth).toBe(390)
  },
}

/**
 * Choosing a sort or a category goes to the Shop's address for it, back at its first page, without moving the page.
 * Here: SORT, Price high to low, then ALL, Hoodies.
 */
export const Choosing: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { listing: listingFor({ page: 2 }) },
  play: async ({ canvas }) => {
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Sort by' }), 'price-desc')
    await expect(getRouter().push).toHaveBeenLastCalledWith('/shop?sort=price-desc', { scroll: false, transitionTypes: ['page'] })
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Category' }), 'hoodies')
    await expect(getRouter().push).toHaveBeenLastCalledWith('/shop?category=hoodies', { scroll: false, transitionTypes: ['page'] })
  },
}

/** /shop?category=hoodies: only the Hoodies, counted, with the category's name on the control; one page, so no pages are drawn. */
export const Filtered: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { listing: listingFor({ category: 'hoodies' }) },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('5 Items')).toBeVisible()
    await expect(cardsIn(canvasElement)).toHaveLength(5)
    const category = canvas.getByRole('combobox', { name: 'Category' }) as HTMLSelectElement
    await expect(category.value).toBe('hoodies')
    await expect(category.parentElement!.textContent).toContain('Hoodies')
    await expect(canvas.queryByRole('navigation', { name: 'Pages' })).toBeNull()
  },
}

/** /shop?sort=price-desc: dearest first, by what a non-member pays; the gift card (From £15) comes last, on page 3. */
export const Sorted: Story = {
  name: 'Sorted, price high to low',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { listing: listingFor({ sort: 'price-desc' }) },
  play: async ({ canvas, canvasElement }) => {
    await expect(namesOf(canvasElement).slice(0, 3)).toEqual(['item-29', 'item-28', 'item-27'])
    await expect((canvas.getByRole('combobox', { name: 'Sort by' }) as HTMLSelectElement).value).toBe('price-desc')
    // The pages keep the sort.
    await expect(canvas.getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe('/shop?sort=price-desc&page=2')
  },
}

/** /shop?page=2: the next twelve, with a way back and a way on. */
export const PageTwo: Story = {
  name: 'Page 2',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { listing: listingFor({ page: 2 }) },
  play: async ({ canvas, canvasElement }) => {
    await expect(cardsIn(canvasElement)).toHaveLength(12)
    const pages = within(canvas.getByRole('navigation', { name: 'Pages' }))
    await expect(pages.getByRole('link', { name: 'Previous page' }).getAttribute('href')).toBe('/shop')
    await expect(pages.getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe('/shop?page=3')
  },
}

/** A shop with one product: "1 Item", one card in the first of the four places, and no pages. */
export const OneProduct: Story = {
  name: 'One product',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { listing: listingFor({}, SAMPLE_ITEMS.slice(0, 1)), categories: SAMPLE_CATEGORIES.slice(0, 1) },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('1 Item')).toBeVisible()
    const cards = cardsIn(canvasElement)
    await expect(cards).toHaveLength(1)
    await expect([Math.round(box(cards[0]!).left), Math.round(box(cards[0]!).width)]).toEqual([16, 346])
    await expect(canvas.queryByRole('navigation', { name: 'Pages' })).toBeNull()
  },
}
