import type { ShopCard, ShopCategoryOption, ShopItem } from './cards'

// W74: the Shop's category, sort and page (WQ37, WQ38). All three live in the address (?category=&sort=&page=), so a
// filtered, sorted page can be shared and crawled. A value the shop doesn't know falls back to the default: never an
// error. Nothing here reads anything.

export const SHOP_ADDRESS = '/shop'

/** Cards on a page of the Shop. */
export const SHOP_PAGE_SIZE = 12

/** WQ38: the sorts, as the list shows them. Featured is the default and is left out of the address. */
export const SHOP_SORTS = [
  { value: 'featured', label: 'Featured' },
  { value: 'new-in', label: 'New in' },
  { value: 'price-asc', label: 'Price low to high' },
  { value: 'price-desc', label: 'Price high to low' },
] as const

export type ShopSort = (typeof SHOP_SORTS)[number]['value']

export const DEFAULT_SORT: ShopSort = 'featured'

/** What the address asks for. `category` is a category's slug, or null for All. */
export type ShopQuery = { category: string | null; sort: ShopSort; page: number }

type AddressParams = Record<string, string | string[] | undefined>

const one = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)

/**
 * The address's query as the shop understands it. An unknown category is All, an unknown sort is Featured, and a
 * page that is not a whole number from 1 is page 1. Whether the page exists is `shopListing`'s to say.
 */
export function shopQuery(params: AddressParams, categories: ShopCategoryOption[]): ShopQuery {
  const category = one(params.category)
  const sort = one(params.sort)
  const page = one(params.page) ?? ''
  return {
    category: categories.some((option) => option.slug === category) ? (category ?? null) : null,
    sort: SHOP_SORTS.find((option) => option.value === sort)?.value ?? DEFAULT_SORT,
    page: /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1,
  }
}

/** The Shop's address for a category, sort and page, each left out when it is the default. */
export function shopAddress({ category = null, sort = DEFAULT_SORT, page = 1 }: Partial<ShopQuery>): string {
  const query = new URLSearchParams()
  if (category) query.set('category', category)
  if (sort !== DEFAULT_SORT) query.set('sort', sort)
  if (page > 1) query.set('page', String(page))
  const text = query.toString()
  return text ? `${SHOP_ADDRESS}?${text}` : SHOP_ADDRESS
}

/** Highest or lowest price first; an item with no price goes last either way. Equal prices keep their New in order. */
const byPrice = (direction: 1 | -1) => (a: ShopItem, b: ShopItem): number => {
  if (a.pence === null || b.pence === null) return (a.pence === null ? 1 : 0) - (b.pence === null ? 1 : 0)
  return (a.pence - b.pence) * direction
}

/**
 * The items in a sort's order (WQ38). `items` come newest first, which is New in. Featured: Shop settings' Featured
 * order (products and the gift card), then the rest by New in. Price: what a non-member pays.
 */
export function sortedItems(items: ShopItem[], sort: ShopSort, featuredIds: string[]): ShopItem[] {
  if (sort === 'new-in') return items
  if (sort === 'price-asc') return [...items].sort(byPrice(1))
  if (sort === 'price-desc') return [...items].sort(byPrice(-1))
  const place = (item: ShopItem): number => {
    const index = featuredIds.indexOf(item.card.id)
    return index === -1 ? featuredIds.length : index
  }
  return [...items].sort((a, b) => place(a) - place(b))
}

export type ShopListing = {
  /** The cards of this page. */
  cards: ShopCard[]
  /** How many items the category holds, on every page: "42 Items". */
  count: number
  page: number
  pages: number
  category: ShopCategoryOption | null
  sort: ShopSort
}

type ListingContent = { items: ShopItem[]; categories: ShopCategoryOption[]; featuredIds: string[]; query: ShopQuery }

/** One page of the Shop: the category's items, sorted, twelve to a page. A page past the last is page 1. */
export function shopListing({ items, categories, featuredIds, query }: ListingContent): ShopListing {
  const category = categories.find((option) => option.slug === query.category) ?? null
  const inCategory = category ? items.filter((item) => item.category === category.id) : items
  const sorted = sortedItems(inCategory, query.sort, featuredIds)
  const pages = Math.max(1, Math.ceil(sorted.length / SHOP_PAGE_SIZE))
  const page = query.page <= pages ? query.page : 1
  return {
    cards: sorted.slice((page - 1) * SHOP_PAGE_SIZE, page * SHOP_PAGE_SIZE).map((item) => item.card),
    count: sorted.length,
    page,
    pages,
    category,
    sort: query.sort,
  }
}

/** "42 Items", "1 Item". */
export const itemCount = (count: number): string => `${count} ${count === 1 ? 'Item' : 'Items'}`
