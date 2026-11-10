// New in W10: an order T1 leaves pending for Stripe (W03-plan 2.1 and 2.5). Its record is the order
// row itself, with this snapshot in orders.reader_payment, committed before any Stripe call. W11 adds
// the reader's.
import 'server-only'
import type { PlaceOrderInput } from '@/contracts'

/**
 * What a pending order carries in orders.reader_payment. A superset of the old reader snapshot
 * (backend/paddock/shared/readerOrderRollback.ts, ReaderPaymentSnapshot), so the old code can still
 * read a Worker order: `flow`, `expected_amount`, `save_card`, `save_address_to_customer`,
 * `gift_card_redemption`, `payment_intent_id` (the reader's) and `created_at` mean what they meant
 * there. The rest is new (W03-plan 2.5).
 */
// Types, not interfaces, so they can be bound to a query as jsonb.
type PendingCommon = {
  flow: 'checkout'
  /** Who placed it: staff, for every order the staff app sends. */
  channel: 'staff'
  /** The card's or the reader's part, in pounds: what Stripe takes and T2 checks, to the penny. */
  expected_amount: number
  /** Whether T2 saves the order's delivery address to the customer, as old finalise did. */
  save_address_to_customer: boolean
  /** The request that placed it, to find its log. */
  request_id: string
  gift_card_redemption?: { gift_card_id: string; amount: number }
  /** When T1 wrote it (the transaction's time). */
  created_at?: string
  /**
   * Written by the old rollback (readerOrderRollback.ts) when it starts on an order. The Worker never
   * writes it, and T2 and the undo leave an order carrying it to the old code (W11).
   */
  rollback?: unknown
  /**
   * W12 (W10 review L1): the booking as T1 wrote it (it was written `confirmed`), so the undo can see
   * whether old code has changed it since (cancelled, moved, a guest added or removed) and refuse
   * (`changed_since`) rather than give its places and pass session back a second time. Absent on an
   * order with no booking, and on a record written before W12.
   */
  held_booking?: HeldBooking
}

/** The booking a pending order holds, as T1 wrote it. */
export type HeldBooking = { session_id: string; party_size: number }

/**
 * A saved-card order (W10). It never has `payment_intent_id`: that field is the old reader's, and the
 * old sweep, the stuck list and the booking checks read an order that has one as an open reader
 * payment. The old sweep would then try to cancel the charge through the terminal route and roll the
 * order back. The charge's PaymentIntent goes in `charge_payment_intent_id` once T2 has seen it succeed.
 */
export type CardSnapshot = PendingCommon & {
  method: 'card'
  save_card: false
  /** The customer's Stripe customer and saved card, as T1 read them under the customer's lock. */
  stripe_customer_id: string
  payment_method_id: string
  /** What the charge says on Stripe, fixed here so a retry sends exactly the same request. */
  charge_description: string
  /** Set by T2 when the charge has been seen to succeed. */
  charge_payment_intent_id: string | null
  /**
   * W12: the mode of the Stripe key the charge is sent with (true for live), written by T1, so reconcile
   * takes "no payment for this order in Stripe" as "nothing was taken" only from a key of this mode.
   */
  livemode?: boolean
}

/**
 * A reader order (W11), as createOrder's reader branch left it, but committed by T1 before the intent
 * exists (bug 14). Once Stripe has made the intent, `payment_intent_id` and the Stripe customer it is
 * for are written onto it (reader-intent.ts): the old reader's own field, on purpose, so the old
 * finalise, cancel, sweep and stuck list can still read a Worker reader order (W03-plan 3.2, switching
 * back), and the old booking checks keep the booking safe while the payment is open.
 */
export type ReaderSnapshot = PendingCommon & {
  method: 'reader'
  /** The customer agreed to save the card: the intent asks Stripe for a reusable one, and T2 saves it. */
  save_card: boolean
  /** The customer's Stripe customer: as T1 read it (null when they have none yet), then the one the intent is for. */
  stripe_customer_id: string | null
  /** The reader's intent, once Stripe has made it. */
  payment_intent_id?: string
  /**
   * The Stripe mode the intent was made in (true for live), written with it (W11a, review L1). Stripe
   * answers 404 for an intent made with a key of the other mode, so cancel and reconcile take a 404 as
   * "never existed" only from a key of this mode. W12: T1 writes the key's mode first, so an order held
   * before its intent was written carries it too (reconcile's listing).
   */
  livemode?: boolean
}

export type PendingSnapshot = CardSnapshot | ReaderSnapshot

/**
 * How long a pending order that isn't a Worker card or reader order counts as still being processed
 * (W03-decisions Q10, Q14). A Worker card or reader order counts until it is settled, however old.
 */
export const PROCESSING_MINUTES = 15

/**
 * What the charge says on Stripe, word for word as createOrder built it: the kinds of thing in the
 * basket, in its order. A membership (W13) isn't here: T1 doesn't take one with a card yet.
 */
/** T1's booking, for the pending record (W12): its session and party size, as written (status `confirmed`). */
export function heldBooking(input: PlaceOrderInput): { held_booking: HeldBooking } | Record<string, never> {
  const booking = input.booking
  if (!booking) return {}
  return { held_booking: { session_id: booking.sessionId, party_size: booking.guests.length } }
}

export function chargeDescription(input: PlaceOrderInput): string {
  const addons = [...(input.booking?.addons ?? []), ...(input.standaloneAddons ?? [])]
  const parts = [
    input.booking ? 'booking' : null,
    addons.length > 0 ? 'add-ons' : null,
    (input.products ?? []).length > 0 ? 'merchandise' : null,
    input.sessionPassTypeId ? 'session pass' : null,
    input.giftCard ? 'gift card' : null,
    input.event ? 'event' : null,
  ]
  return `Staff-created order for ${parts.filter(Boolean).join(', ')}`
}
