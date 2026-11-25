import { z } from 'zod'

// Brief W74a (Wayne's WQ40; the lead's design, 24 Nov 2026): what the website's shop is told about a product. Never a
// stock number and never a Stripe id: the answers are strict, so a field added by mistake fails every test and
// `next dev`. In its own file, exported last from index.ts, so the staff app's generated types keep the order of every
// earlier union. W75a added the events' reads, at the end.

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

/** A document's id, as Sanity writes one. */
const SANITY_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

/** `GET /api/v1/shop/availability?product=`: the product's Sanity document id. */
export const shopAvailabilityRouteInputSchema = z.object({
  product: z.string().regex(SANITY_ID, "That isn't a product's id."),
})
export type ShopAvailabilityRouteInput = z.infer<typeof shopAvailabilityRouteInputSchema>

/** The product's sizes now, in shop order, and whether none of them is left. */
export const shopAvailabilityRouteOutputSchema = z.strictObject({ product: z.string(), soldOut: z.boolean(), sizes: z.array(shopSizeSchema) })
export type ShopAvailabilityRouteOutput = z.infer<typeof shopAvailabilityRouteOutputSchema>

// W75a (Wayne's WQ58-WQ61): what the website is told about an event. Spaces left, and never who or what has taken the rest.

/**
 * What a visitor who isn't signed in finds. Only `open` can be booked by one. `sold_out` comes before the two members'
 * states (nobody can book it), and after `started` and `cancelled`, whose pages stay (WQ59).
 */
export const shopEventStateSchema = z.enum(['open', 'sold_out', 'not_released_yet', 'members_only', 'started', 'cancelled'])
export type ShopEventState = z.infer<typeof shopEventStateSchema>

/** `GET /api/v1/shop/event-availability?event=`: the event's Sanity document id. */
export const shopEventAvailabilityRouteInputSchema = z.object({
  event: z.string().regex(SANITY_ID, "That isn't an event's id."),
})
export type ShopEventAvailabilityRouteInput = z.infer<typeof shopEventAvailabilityRouteInputSchema>

/** The event's spaces, state and prices now. */
export const shopEventAvailabilityRouteOutputSchema = z.strictObject({
  event: z.string(),
  spacesLeft: z.number().int().min(0),
  state: shopEventStateSchema,
  /** When it opens to everyone, only when the state is `not_released_yet`: ISO with the UK's own offset, to be formatted in Europe/London. */
  publicReleaseAt: z.string().nullable(),
  /** What a visitor pays for a place; null for a members-only event. */
  price: money,
  /** The lowest member level's price ("Member from", WQ58). */
  memberPrice: money,
})
export type ShopEventAvailabilityRouteOutput = z.infer<typeof shopEventAvailabilityRouteOutputSchema>
