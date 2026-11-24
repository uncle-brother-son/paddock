import { z } from 'zod'

// Brief W72a (Wayne's WQ7; the lead's design, 24 Nov 2026): product categories are documents in Sanity, mirrored into
// `product_categories` by the Sanity webhook. A product's `category` (getProducts' rows) is its category's
// `sanity_category_id`; this read gives each category's title. In its own file, exported last from index.ts, so the
// staff app's generated types keep the order of every earlier union.

/**
 * `GET catalog/product-categories`: every category, in its Order then by title. `sort_order` is the Sanity document's
 * Order (null when it has none: those come last).
 */
export const catalogProductCategoriesRouteOutputSchema = z.array(z.object({ sanity_category_id: z.string(), title: z.string(), sort_order: z.number().nullable() }))
export type CatalogProductCategoriesRouteOutput = z.infer<typeof catalogProductCategoriesRouteOutputSchema>
