import { z } from 'zod'

// Brief W74a (Wayne's WQ40; the lead's design, 24 Nov 2026): what the website's shop is told about a product. Never a
// stock number and never a Stripe id: the answers are strict, so a field added by mistake fails every test and
// `next dev`. In its own file, exported last from index.ts, so the staff app's generated types keep the order of every
// earlier union. W75a added the events' reads, and W77a the booking panel's, at the end.

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

// W77a (Wayne's WQ64-WQ66): what the booking panel is told about sessions, for a visitor who isn't signed in. Spaces left,
// and never who has booked, why a session is blocked or a Stripe id.

/** A day, YYYY-MM-DD, as London has it. */
const day = z.string()
/** Money as above, where there always is some. */
const pounds = z.string()

/** `GET /api/v1/shop/booking-days?month=`: a month, YYYY-MM. */
export const shopBookingDaysRouteInputSchema = z.object({
  month: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, "That isn't a month."),
})
export type ShopBookingDaysRouteInput = z.infer<typeof shopBookingDaysRouteInputSchema>

export const shopBookingDaysRouteOutputSchema = z.strictObject({
  month: z.string(),
  /** The month's days with a public session bookable online, in order. */
  publicDays: z.array(day),
  privateDays: z.array(day),
  /** The first day from now with a session of either kind (today if it still has one), in any month; null when none has. */
  firstDay: day.nullable(),
  /** The last day sessions are made for: nothing after it can be booked. */
  lastDay: day.nullable(),
})
export type ShopBookingDaysRouteOutput = z.infer<typeof shopBookingDaysRouteOutputSchema>

const isRealDate = (text: string): boolean => {
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text)
}

/** `GET /api/v1/shop/sessions?date=`: a London date, YYYY-MM-DD. */
export const shopSessionsRouteInputSchema = z.object({
  date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/, "That isn't a date.").refine(isRealDate, "That isn't a date."),
})
export type ShopSessionsRouteInput = z.infer<typeof shopSessionsRouteInputSchema>

const sessionShown = {
  /** What booking-quote and the bag are given. */
  id: z.string(),
  /** The moment it starts: ISO with the UK's own offset, to be formatted in Europe/London (as an event's). */
  startsAt: z.string(),
  minutes: z.number().int(),
  service: z.string(),
  /** The time band's name (Off-Peak). */
  band: z.string(),
  /** `full`: no space left, or (private) taken. One that can't be had for any other reason is left out. */
  state: z.enum(['bookable', 'full']),
  /** The most people one booking may hold now; 0 when it is full. */
  mostPeople: z.number().int().min(0),
}

export const shopPublicSessionSchema = z.strictObject({
  ...sessionShown,
  spotsLeft: z.number().int().min(0),
  /** What one person pays. */
  price: pounds,
})
export type ShopPublicSession = z.infer<typeof shopPublicSessionSchema>

export const shopPrivateSessionSchema = z.strictObject({
  ...sessionShown,
  /** The whole group's price, by how many people it has; smallest group first. */
  prices: z.array(z.strictObject({ from: z.number().int(), to: z.number().int(), price: pounds })),
})
export type ShopPrivateSession = z.infer<typeof shopPrivateSessionSchema>

export const shopSessionsRouteOutputSchema = z.strictObject({
  date: day,
  /** The most people any booking of each kind may hold, whatever the day has. */
  mostPeople: z.strictObject({ public: z.number().int(), private: z.number().int() }),
  /** In time order. */
  public: z.array(shopPublicSessionSchema),
  /** By length, shortest first; each in time order. */
  private: z.array(z.strictObject({ minutes: z.number().int(), sessions: z.array(shopPrivateSessionSchema) })),
})
export type ShopSessionsRouteOutput = z.infer<typeof shopSessionsRouteOutputSchema>

/** `GET /api/v1/shop/booking-quote?session=&people=`: how many people as written in the address. */
export const shopBookingQuoteRouteInputSchema = z.object({
  session: z.guid("That isn't a session's id."),
  people: z.string().regex(/^[1-9]\d{0,2}$/, "That isn't a number of people."),
})
export type ShopBookingQuoteRouteInput = z.infer<typeof shopBookingQuoteRouteInputSchema>

/** `closed`: under 30 minutes to its start, or started (WQ66). `unavailable`: it can't be had at all, or has no price for that group. */
export const shopBookingRefusalSchema = z.enum(['unavailable', 'closed', 'full', 'too_many'])
export type ShopBookingRefusal = z.infer<typeof shopBookingRefusalSchema>

export const shopBookingQuoteRouteOutputSchema = z.strictObject({
  session: z.string(),
  people: z.number().int(),
  /** Why this many people can't book it; null when they can. */
  reason: shopBookingRefusalSchema.nullable(),
  mostPeople: z.number().int().min(0),
  /** What they pay altogether; null with a reason. */
  total: pounds.nullable(),
  /** Public: the booker, then the guests. Private: one line, the group's, with no price each. Empty with a reason. */
  lines: z.array(z.strictObject({ who: z.enum(['you', 'guests', 'group']), people: z.number().int(), each: pounds.nullable(), total: pounds })),
})
export type ShopBookingQuoteRouteOutput = z.infer<typeof shopBookingQuoteRouteOutputSchema>
