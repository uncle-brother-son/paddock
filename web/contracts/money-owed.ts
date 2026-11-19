import { z } from 'zod'

// --- W47 (G-plan 4.7; W35 audit F1 and row 5, W45 audit row 54): GET /api/v1/staff/money-owed, the "Money still to
// refund" list on the Orders page and the count on Overview. A read: nothing is written.
//
// In a file of its own, exported last from index.ts, so the types printed for the staff app (workerContracts.ts) only
// gain these.

/** An event booking the order paid for: shown beside the order, because its money owed is the order's (E-plan 4.4). */
export const moneyOwedEventBookingSchema = z.object({
  eventBookingId: z.string(),
  eventId: z.string(),
  eventName: z.string(),
  /** London wall clock, as stored. */
  startsAt: z.string(),
  status: z.string(),
})
export type MoneyOwedEventBooking = z.infer<typeof moneyOwedEventBookingSchema>

/** One order or one booking with card refund money that never reached the customer (`refund_owed_amount` above £0). */
export const moneyOwedItemSchema = z.object({
  /** `order`: owed on an order (an event booking's money is its order's). `booking`: owed on a session booking. */
  on: z.enum(['order', 'booking']),
  /** The order, for `order`; null for a booking. */
  orderId: z.string().nullable(),
  /** The booking, for `booking`; null for an order. */
  bookingId: z.string().nullable(),
  customerId: z.string(),
  customerName: z.string(),
  /** Pounds still to refund. */
  amount: z.number(),
  /** When it last became owed (ISO), or null when no record says (money left owed by the old screens). */
  owedSince: z.string().nullable(),
  /** Whole days since then; null with no `owedSince`. */
  daysOwed: z.number().nullable(),
  /** A booking: its status now (`cancelled` for a cancelled or lapsed one), and its session's start (London wall clock). */
  bookingStatus: z.string().optional(),
  lapsed: z.boolean().optional(),
  sessionStart: z.string().optional(),
  /** An order: the event bookings it paid for (none for most orders). */
  eventBookings: z.array(moneyOwedEventBookingSchema).optional(),
  /** Where Refund the rest runs for it, in plain words. */
  where: z.string(),
})
export type MoneyOwedItem = z.infer<typeof moneyOwedItemSchema>

/** Money a lapse kept (Q48: inside 24 hours, or after the session started), from its `booking.lapsed` row. For information. */
export const lapsedKeptItemSchema = z.object({
  bookingId: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  /** When it lapsed (ISO). */
  lapsedAt: z.string(),
  /** The session's start (London wall clock). */
  sessionStart: z.string(),
  /** Pounds kept. */
  kept: z.number(),
  keptBecause: z.enum(['inside_24_hours', 'session_started']).nullable(),
  words: z.string(),
})
export type LapsedKeptItem = z.infer<typeof lapsedKeptItemSchema>

export const moneyOwedInputSchema = z.object({})
export type MoneyOwedInput = z.infer<typeof moneyOwedInputSchema>

export const moneyOwedOutputSchema = z.object({
  /** Every order and booking with money owed, the one owed longest first. */
  owed: z.array(moneyOwedItemSchema),
  /** Their total, in pounds. */
  total: z.number(),
  /** Money kept on lapsed bookings in the last `keptDays` days, newest first. */
  lapsedKept: z.array(lapsedKeptItemSchema),
  keptDays: z.number(),
  /** What to do about kept money, if anything: names Adjust store credit (Wayne, 18 Nov). */
  keptNote: z.string(),
})
export type MoneyOwedOutput = z.infer<typeof moneyOwedOutputSchema>
