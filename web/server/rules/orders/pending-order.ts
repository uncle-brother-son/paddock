// New in W10: an order T1 leaves pending for Stripe (W03-plan 2.1 and 2.5). Its record is the order
// row itself, with this snapshot in orders.reader_payment, committed before any Stripe call.
import 'server-only'
import type { PlaceOrderInput } from '@/contracts'

/**
 * What a pending order carries in orders.reader_payment. A superset of the old reader snapshot
 * (backend/paddock/shared/readerOrderRollback.ts, ReaderPaymentSnapshot), so the old code can still
 * read a Worker order: `flow`, `expected_amount`, `save_card`, `save_address_to_customer`,
 * `gift_card_redemption` and `created_at` mean what they meant there. The rest is new (W03-plan 2.5).
 *
 * A saved-card order never has `payment_intent_id`: that field is the old reader's, and the old sweep,
 * the stuck list and the booking checks read an order that has one as an open reader payment. The
 * old sweep would then try to cancel the charge through the terminal route and roll the order back.
 * The charge's PaymentIntent goes in `charge_payment_intent_id` once T2 has seen it succeed.
 */
// A type, not an interface, so it can be bound to a query as jsonb.
export type PendingSnapshot = {
  flow: 'checkout'
  /** How the money is collected: the saved card (W10). The reader comes at W11. */
  method: 'card'
  /** Who placed it: staff, for every order the staff app sends. */
  channel: 'staff'
  /** The card's part, in pounds: what the charge takes and T2 checks. */
  expected_amount: number
  save_card: false
  /** Whether T2 saves the order's delivery address to the customer, as old finalise did. */
  save_address_to_customer: boolean
  /** The customer's Stripe customer and saved card, as T1 read them under the customer's lock. */
  stripe_customer_id: string
  payment_method_id: string
  /** What the charge says on Stripe, fixed here so a retry sends exactly the same request. */
  charge_description: string
  /** Set by T2 when the charge has been seen to succeed. */
  charge_payment_intent_id: string | null
  /** The request that placed it, to find its log. */
  request_id: string
  gift_card_redemption?: { gift_card_id: string; amount: number }
  /** When T1 wrote it (the transaction's time). */
  created_at?: string
}

/**
 * How long a pending order that isn't a Worker card order counts as still being processed
 * (W03-decisions Q10, Q14). A Worker card order counts until it is settled, however old.
 */
export const PROCESSING_MINUTES = 15

/**
 * What the charge says on Stripe, word for word as createOrder built it: the kinds of thing in the
 * basket, in its order. A membership (W13) isn't here: T1 doesn't take one with a card yet.
 */
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
