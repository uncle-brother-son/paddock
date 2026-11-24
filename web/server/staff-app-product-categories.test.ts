import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogProductCategoriesRouteOutputSchema } from '@/contracts'
import { staffAppDir } from './rules/testing/staff-app-dir'

// Brief W72a item 4 (Wayne's WQ7; the lead's design, 24 Nov 2026): the staff app's Products page lists the product
// categories by title, from the Worker's categories read, and shows "No category" for a product with none. A
// product's `category` is its category's Sanity id, so the page never shows that value itself. Held here: the thin
// getProductCategories against a stand-in for the Worker; the page's own code that puts a title to a product
// (frontend/utils/productCategories.ts, run as it is); and the page read as source (the staff app has no test
// runner). The read through the real route, on a database, with a category renamed by Sanity's webhook, is in
// app/api/sanity/webhook/route.test.ts.

const appDir = staffAppDir()
const backend = (name: string) => import(/* @vite-ignore */ path.join(appDir, 'backend/paddock', name))
const source = (file: string) => readFileSync(path.join(appDir, file), 'utf8')
const screen = () =>
  import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/productCategories.ts')) as Promise<{
    ALL_CATEGORIES: string
    NO_CATEGORY: string
    NO_CATEGORY_LABEL: string
    productCategoryTitles: (categories: ReadonlyArray<{ sanity_category_id: string; title: string; sort_order: number | null }>) => Map<string, string>
    categoryIdShown: (category: string | null, titles: ReadonlyMap<string, string>) => string | null
  }>

const user = { email: 'jo@example.com' }
const success = (data: unknown) => ({ data: { ok: true, data, requestId: 'worker-request' } })
const failure = (code: string, message: string) => ({ data: { ok: false, error: { code, message }, requestId: 'worker-request' } })
const INACTIVE = 'This staff account is inactive. Ask an admin to reactivate it.'
type Sent = { path: string; method: string; headers: Record<string, string>; body?: unknown; queryParams?: unknown }

const APPAREL = 'c1a2b3c4-0000-4000-8000-000000000001'
const ACCESSORIES = 'c1a2b3c4-0000-4000-8000-000000000002'
const LIST = [
  { sanity_category_id: APPAREL, title: 'Apparel', sort_order: 1 },
  { sanity_category_id: ACCESSORIES, title: 'Accessories', sort_order: 2 },
]

describe("the staff app's getProductCategories (brief W72a item 4)", () => {
  const rawRequest = vi.fn()
  const sent = (call = 0) => rawRequest.mock.calls[call]?.[0] as Sent

  beforeEach(() => {
    rawRequest.mockReset()
    vi.stubGlobal('paddockWorkerV1', { rawRequest })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("asks only the Worker, on the categories' own route, with who is signed in and no press key (a read), and answers its rows as they are", async () => {
    rawRequest.mockResolvedValue(success(LIST))
    expect(await (await backend('getProductCategories.ts')).default({ user })).toEqual(LIST)
    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(sent()).toMatchObject({ method: 'GET', path: '/api/v1/staff/catalog/product-categories', headers: { 'X-Staff-Email': 'jo@example.com' } })
    expect(sent().headers['Idempotency-Key']).toBeUndefined()
    expect(sent().body).toBeUndefined()
    // What it answers is what the Worker's contract says the route answers.
    expect(catalogProductCategoriesRouteOutputSchema.parse(LIST)).toEqual(LIST)
  })

  it("a refusal is thrown in the Worker's own words", async () => {
    rawRequest.mockResolvedValue(failure('FORBIDDEN', INACTIVE))
    await expect((await backend('getProductCategories.ts')).default({ user })).rejects.toThrow(new Error(INACTIVE))
  })

  it('it is a thin call: the one Worker resource through the shared helper, no database, no rule of its own; and it is in the type check', () => {
    const code = source('backend/paddock/getProductCategories.ts')
    expect(code).toContain("import { adminRead } from './shared/adminWorker'")
    expect(code).toContain("return adminRead<CatalogProductCategoriesRouteOutput>(req.user, { path: '/api/v1/staff/catalog/product-categories' })")
    expect(code).not.toMatch(/paddockData|paddockBackendApi2|paddockWorkerV1|\.sort\(|\.filter\(/)
    expect(source('backend/paddock/typecheckAll.ts')).toContain("import './getProductCategories'\n")
    expect(source('backend/paddock/shared/workerContracts.ts')).toContain('export type CatalogProductCategoriesRouteOutput = { sanity_category_id: string; title: string; sort_order: number | null; }[]')
  })
})

describe('the Products page puts a title to each product from the categories read (brief W72a item 4)', () => {
  it("a product is shown under its category's title; one with none, with a word from before W72a, or whose category has not arrived, under none", async () => {
    const { productCategoryTitles, categoryIdShown } = await screen()
    const titles = productCategoryTitles(LIST)
    expect(titles.get(APPAREL)).toBe('Apparel')
    expect(categoryIdShown(APPAREL, titles)).toBe(APPAREL)
    expect(categoryIdShown(ACCESSORIES, titles)).toBe(ACCESSORIES)
    expect(categoryIdShown(null, titles)).toBeNull()
    expect(categoryIdShown('apparel', titles)).toBeNull()
    expect(categoryIdShown('c1a2b3c4-0000-4000-8000-00000000dead', titles)).toBeNull()
    expect(categoryIdShown('Apparel', titles)).toBeNull()
  })

  it('a renamed category: the same product, holding the same id, reads the new title once the categories are read again', async () => {
    const { productCategoryTitles, categoryIdShown } = await screen()
    const product = { name: 'Paddock T-Shirt', category: APPAREL }
    const titleOf = (list: typeof LIST) => {
      const titles = productCategoryTitles(list)
      const id = categoryIdShown(product.category, titles)
      return id === null ? null : titles.get(id)
    }
    expect(titleOf(LIST)).toBe('Apparel')
    expect(titleOf(LIST.map((category) => (category.sanity_category_id === APPAREL ? { ...category, title: 'Clothing' } : category)))).toBe('Clothing')
  })

  it("the filter's own two choices can never be a category's id, and a product with none is named \"No category\"", async () => {
    const { ALL_CATEGORIES, NO_CATEGORY, NO_CATEGORY_LABEL } = await screen()
    // Sanity's document ids are letters, numbers, ".", "_" and "-": never a colon.
    for (const value of [ALL_CATEGORIES, NO_CATEGORY]) expect(value).toMatch(/:/)
    expect(ALL_CATEGORIES).not.toBe(NO_CATEGORY)
    expect(NO_CATEGORY_LABEL).toBe('No category')
  })

  const page = () => source('frontend/pages/ProductsPage.tsx')

  it('the page reads the categories with the products, and lists them in the filter by title, in the order the Worker gave them', () => {
    const code = page()
    expect(code).toContain('const { data: categoryList, error: categoriesError, trigger: loadCategories } = useGetProductCategories()')
    // Read when the page loads, beside the products.
    expect(code).toMatch(/useEffect\(\(\) => \{\n\s+trigger\(\)\n\s+loadCategories\(\)\n\s+\}, \[\]\)/)
    expect(code).toContain('const categories: ProductCategory[] = categoryList ?? []')
    expect(code).toMatch(/\{categories\.map\(\(c\) => \(\s+<SelectItem key=\{c\.sanity_category_id\} value=\{c\.sanity_category_id\}>\s+\{c\.title\}\s+<\/SelectItem>\s+\)\)\}/)
    // Not sorted or built again from the products: the list is the Worker's.
    expect(code).not.toMatch(/categories\.sort|\.sort\(\)|new Set<string>\(\)/)
    expect(code).toContain('<SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>')
  })

  it('"No category": in the filter when some product has none, and in the Category column for each of them; never before the categories are read', () => {
    const code = page()
    expect(code).toContain('{someHaveNone ? <SelectItem value={NO_CATEGORY}>{NO_CATEGORY_LABEL}</SelectItem> : null}')
    expect(code).toContain('() => categoryTitles !== null && rows.some((r) => categoryIdShown(r.category, categoryTitles) === null)')
    expect(code).toContain('if (categoryFilter === NO_CATEGORY) return rows.filter((r) => categoryIdShown(r.category, categoryTitles) === null)')
    expect(code).toContain('return rows.filter((r) => r.category === categoryFilter)')
    // The column: the title from the read; "—" until the read is in; "No category" for none.
    expect(code).toContain('<ProductCategoryCell category={p.category} titles={categoryTitles} />')
    const cell = /function ProductCategoryCell[\s\S]*?\n\}\n/.exec(code)?.[0] ?? ''
    expect(cell).toContain('if (titles === null) return <>—</>')
    expect(cell).toContain('if (id === null) return <span className="text-muted-foreground text-sm">{NO_CATEGORY_LABEL}</span>')
    expect(cell).toContain('return <Badge variant="outline">{titles.get(id)}</Badge>')
    expect(code).toContain('const categoryTitles = useMemo(() => (categoryList ? productCategoryTitles(categoryList) : null), [categoryList])')
  })

  it("the product's own `category` (an id) is never what is shown", () => {
    const code = page()
    // Passed to the cell that looks its title up; never put on the page as text.
    expect(code.match(/p\.category/g)).toHaveLength(1)
    expect(code).not.toMatch(/>\s*\{(p|r)\.category\}\s*<|>\{c\}</)
    expect(code).not.toMatch(/\{c\.sanity_category_id\}\s*<\/SelectItem>/)
  })

  it("the categories read failing is said on the page in the Worker's words, and the products still show", () => {
    const code = page()
    expect(code).toContain("{!error && categoriesError ? <div className=\"text-destructive text-sm mb-4\">The categories couldn't be read: {categoriesError}</div> : null}")
  })

  it('the add-ons page is as it was: its categories are still its three words (not in WQ7)', () => {
    const code = source('frontend/pages/AddonsPage.tsx')
    expect(code).toContain("if (r.category) set.add(r.category)")
    expect(code).not.toContain('useGetProductCategories')
  })
})
