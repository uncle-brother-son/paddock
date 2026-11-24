import { z } from 'zod'

// Brief W74a (Wayne's WQ40; the lead's design, 24 Nov 2026): what the website's shop is told about a product. Never a
// stock number and never a Stripe id: the answers are strict, so a field added by mistake fails every test and
// `next dev`. In its own file, exported last from index.ts, so the staff app's generated types keep the order of every
// earlier union.

/** Money as the database gives it: a string of pounds and pence ("28.00"). Null: no price for that visitor. */
const money = z.string().nullable()

/** A size's prices for display, all from the checkout's own rule (server/rules/orders/catalog-price.ts). */
const displayPrices = {
  /** What a non-member pays (the sale price included). */
  price: money,
  /** What a member pays, when the product has a member price; null when it has none. */
  memberPrice: money,
  /** What a non-member paid before the sale; null when it isn't reduced by one. */
  priceBeforeSale: money,
  /** The sale's reduction, as a whole percent rounded to the nearest; null with no `priceBeforeSale`. */
  percentOff: z.number().int().nullable(),
}

/** One size of a product: whether any are left (never how many), and its own prices. */
export const shopSizeSchema = z.strictObject({ size: z.string().nullable(), available: z.boolean(), ...displayPrices })
export type ShopSize = z.infer<typeof shopSizeSchema>

/** `GET /api/v1/shop/availability?product=`: the product's Sanity document id, as Sanity writes one. */
export const shopAvailabilityRouteInputSchema = z.object({
  product: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/, "That isn't a product's id."),
})
export type ShopAvailabilityRouteInput = z.infer<typeof shopAvailabilityRouteInputSchema>

/** The product's sizes now, in shop order, and whether none of them is left. */
export const shopAvailabilityRouteOutputSchema = z.strictObject({ product: z.string(), soldOut: z.boolean(), sizes: z.array(shopSizeSchema) })
export type ShopAvailabilityRouteOutput = z.infer<typeof shopAvailabilityRouteOutputSchema>
