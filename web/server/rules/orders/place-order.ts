// Ported from backend/paddock/createOrder.ts: the order in one transaction, T1 (W03-plan 2.1). W06
// built what needs no Stripe step: bookings (public and private, with guests, on a membership or pass
// credit or paid), add-ons on a booking (paid or on an add-on credit) and on their own, paid in cash or
// with nothing owed. W07 adds products with their stock, the delivery address and postage, session
// passes (on their own, or bought to pay for the booking in the same basket) and gift cards bought.
// W08 adds events: the places claimed, the event booking and its attendees, and the event's line
// (from shared/eventOrders.ts, writeEventBooking). W09 adds promo codes (the redemption, and the
// discount on everything it applies to), store credit and gift cards used to pay (shared/storeCredit.ts
// and createOrder's claimStoreCreditAndGiftCard), what orders.payment_method records (W03-decisions Q9)
// and the confirmed-amount rule for every method with no Stripe step (W03-plan 2.7). W10 adds the saved
// card (createOrder's stages 30 to 35, chargeSavedCard): T1 commits the order pending, collect charges
// the card (collect-saved-card.ts), then T2 (finalise-order.ts) marks it paid, or the one undo
// (undo-order.ts) removes it. W11 adds the reader (createOrder's stage 29): T1 commits the order pending
// with its pending record, then the reader's intent is made (reader-intent.ts) and the screen collects
// it; the finalise and cancel routes (reader-order.ts) finish it. Still not built: memberships (W13).
import 'server-only'
import type {
  BasketEventAttendee,
  BasketProblem,
  BasketQuoteInput,
  BasketQuoteOutput,
  OrderDryRunOutput,
  OrderNotBuiltDetails,
  OrderRows,
  PlaceOrderInput,
  PlaceOrderOutput,
} from '@/contracts'
import { audit } from '@/server/audit'
import { inOpenTransaction, isDeadlock, postgresRefusal, type Db, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { addMonthsToIsoDate } from '@/server/rules/time/london-time'
import type { StripeClient } from '@/server/stripe/client'
import { stripeTiming } from '@/server/stripe/deadline'
import { amountChangedRefusal, cashDifferenceRefusal, round2 } from './amounts'
import { GIFT_CARD_SOURCE_REMOVED_MESSAGE } from './basket-booking'
import { eventFullRefusal, inPlaceOrder } from './basket-event'
import { COLLECT_DEADLINE_MS, collectSavedCard, type ChargeAnswer, type PendingCharge } from './collect-saved-card'
import {
  CHARGED_WITHOUT_ORDER_MESSAGE,
  NO_SAVED_CARD_MESSAGE,
  ORDER_STILL_PROCESSING_MESSAGE,
  PAID_NOT_FINISHED_MESSAGE,
  PAYMENT_UNCONFIRMED_MESSAGE,
  READER_INTENT_UNCONFIRMED_MESSAGE,
} from './failure-messages'
import { finaliseOrder, type FinaliseOutcome } from './finalise-order'
import { generateGiftCardCode } from './gift-card-code'
import { loadBasketFacts, type BasketFacts } from './load-basket'
import { lockForOrder, type HeldLocks } from './locks'
import { bookingRefusal, orderRefusal, paymentUnconfirmed, refusalDetails } from './order-refusal'
import { readOrderRows } from './order-rows'
import { chargeDescription, heldBooking, type CardSnapshot, type PendingSnapshot, type ReaderSnapshot } from './pending-order'
import { priceFromFacts } from './price-basket'
import { createReaderIntent, recordReaderIntent, type PendingReader } from './reader-intent'
import { undoOrder } from './undo-order'
import { writeBooking, type BookingOrderPart, type BookingToWrite, type PayBy } from './write-booking'

/**
 * placeOrder runs T1: entry checks that need no database, then one transaction that locks, reads,
 * prices with priceFromFacts (the quote's own sums, so the quote and the order can't differ), checks
 * what staff confirmed, writes and records. With no Stripe step it finishes inside T1, so it is all
 * or nothing. Every refusal is thrown, so the transaction rolls back: a `return` inside it would
 * commit. A refusal Postgres itself raises (an overlapping booking, a second booking that day)
 * kills the transaction, so it is turned into its reason after the rollback.
 *
 * The order is written before the booking (W07): the booking may be paid with a pass bought in the
 * same basket, and that pass needs its order line, which needs the order. The booking's own line
 * then joins the order's other lines from the booking's statement.
 *
 * dryRunOrder is the same T1, read back and rolled back: nothing is kept (W03-plan 3.1 layer 4).
 */

export interface PlaceOrderOptions {
  /** Who is placing it, for the audit rows. */
  actor: { type: 'staff' | 'customer'; id: string }
  requestId: string
  /** Whether a line's sent price counts: only with Manage pricing (W03-plan 2.9). */
  allowPriceOverrides?: boolean
  /** Makes a gift card code. Tests pass one to force a collision; the routes use the real one. */
  giftCardCode?: () => string
  /** The Stripe client, made only when a card order needs it (W10). Tests pass FakeStripe. */
  stripe?: () => StripeClient
  /**
   * When the request started (ms since the epoch): the card's charge must be answered by
   * COLLECT_DEADLINE_MS after it (W10a). The route passes its own; without one, placeOrder's start.
   */
  startedAt?: number
  /** The clock for that deadline. Date.now unless a test passes another. */
  now?: () => number
}

/** T1 inside the dry run: what the dry run alone does differently (W03-decisions, "W10 setup calls"). */
interface PrepareMode {
  dryRun: boolean
  /**
   * W12: the mode of the Stripe key the order will be collected with (StripeClient.keyLivemode), written
   * on the pending record as `livemode`, so reconcile takes "Stripe has no payment for this order" as
   * "nothing was taken" only with a key of that same mode (W11 review L1). Null in the dry run (no client).
   */
  keyLivemode: boolean | null
}

// --- Before anything is touched

/** createOrder's first checks, which need no database. */
function refuseAtEntry(input: PlaceOrderInput): void {
  if (!input.customerId) throw orderRefusal({ stage: 'validation', reason: 'customer_id_required' })
  const empty =
    !input.booking &&
    (input.standaloneAddons ?? []).length === 0 &&
    (input.products ?? []).length === 0 &&
    !input.membershipPlanId &&
    !input.sessionPassTypeId &&
    !input.giftCard &&
    !input.event
  if (empty) throw orderRefusal({ stage: 'validation', reason: 'empty_order' })
  if (input.booking?.redemptionSource === 'gift_card') {
    throw orderRefusal({ stage: 'validation', reason: 'gift_card_source_removed', message: GIFT_CARD_SOURCE_REMOVED_MESSAGE })
  }
}

/**
 * What T1 can't sell yet, each built by a later slice: memberships, bought or buy-new or replacing an
 * exhausted one (W13), on any method, the saved card and the reader included. A pass bought with a
 * buy-new membership is caught as the membership, and so is an event beside a membership bought in the
 * same basket (its account holder would be priced as that member), and a promo code beside one (its
 * share of the first payment). W10 built the saved card, W11 the reader.
 */
const NOT_BUILT: ReadonlyArray<{ part: string; words: string; present: (input: PlaceOrderInput) => boolean }> = [
  {
    part: 'membership',
    words: 'a membership',
    present: (input) =>
      Boolean(input.membershipPlanId) || input.booking?.redemptionSource === 'buy_new_membership' || Boolean(input.booking?.cancelExhaustedMembershipId),
  },
]

function refuseWhatIsNotBuilt(input: PlaceOrderInput): void {
  const missing = NOT_BUILT.filter((item) => item.present(input))
  if (missing.length === 0) return
  const details: OrderNotBuiltDetails = { notBuilt: missing.map((item) => item.part) }
  throw new ApiError(
    'NOT_BUILT',
    `The new order system can't take this order yet: it has ${missing.map((item) => item.words).join(', ')}. Nothing was changed.`,
    { details }
  )
}

// --- T1

/** Refusals that come after the cash check: they mean nothing while something else is wrong. */
const AMOUNT_REASONS = new Set(['gift_card_amount_exceeds_total', 'store_credit_amount_exceeds_total', 'payment_method_required', 'reader_nothing_to_charge'])

/**
 * The first problem, as createOrder met them: everything else, then the cash figure, then the amount
 * checks (the gift card or store credit over the total, then payment_method_required), then anything
 * else staff confirmed that has changed (W03-plan 2.7). The gift card and store credit are taken for
 * exactly what was sent, never less: an amount over what is now due is refused, not cut down.
 *
 * The card's figure (W10) is checked like every other method's: `confirmed.toCollect` is what the
 * saved card is charged, and a missing figure counts as nothing confirmed. The dry run alone takes a
 * missing figure for a method that isn't cash as confirmed (W03-decisions, "W10 setup calls"): the old
 * createOrder's params, which the shadow sends it, never had one. The real route keeps the rule.
 */
function refuseIfNeeded(input: PlaceOrderInput, quote: BasketQuoteOutput, mode: PrepareMode): void {
  const [first] = quote.problems
  if (first && !AMOUNT_REASONS.has(first.reason)) throw orderRefusal(first)
  const method = input.payment?.method
  const { totals } = quote
  const cash = cashDifferenceRefusal(method, totals.toCollect.cash, input.confirmed?.toCollect)
  if (cash) {
    throw orderRefusal({ stage: 'payment', reason: cash.reason, message: cash.message, amountDueTotal: totals.amountDue })
  }
  if (first) throw orderRefusal(first)
  const toCollect = method === 'reader' ? totals.toCollect.reader : totals.toCollect.card
  const unconfirmed = mode.dryRun && method !== 'cash' && typeof input.confirmed?.toCollect !== 'number'
  const confirmed = unconfirmed ? { ...input.confirmed, toCollect } : input.confirmed
  const changed = amountChangedRefusal(method, confirmed, { amountDue: totals.amountDue, toCollect })
  if (changed) throw orderRefusal({ stage: 'payment', reason: changed.reason, message: changed.message, amountDueTotal: totals.amountDue })
}

/**
 * What orders.payment_method records for an order with no Stripe step (W03-decisions Q9): the method
 * that took a remainder, a gift card alone, store credit alone, or `split` when a gift card shares
 * the order with store credit or with a remainder. Nothing owed records none. createOrder recorded
 * none for store credit alone, and `gift_card` for a gift card with store credit: Q9 changed both.
 */
export function recordedPaymentMethod(method: string | null | undefined, collected: number, giftCard: number, storeCredit: number): string | null {
  if (giftCard > 0) return collected > 0 || storeCredit > 0 ? 'split' : 'gift_card'
  if (collected > 0) return method ?? null
  return storeCredit > 0 ? 'store_credit' : null
}

const unpriced = (problem: string) => new Error(`The order was priced without ${problem}. Nothing was kept.`)

/**
 * The booking as writeBooking takes it. `newPassId` is the pass this order has just written: on a
 * buy-new pass booking, seat 1 takes its session from it, through the same guarded claim as a pass
 * the customer already had.
 */
function bookingToWrite(input: PlaceOrderInput, facts: BasketFacts, quote: BasketQuoteOutput, locks: HeldLocks, newPassId: string | null): BookingToWrite | null {
  const booking = input.booking
  if (!booking) return null
  const quoted = quote.booking
  const session = facts.session
  if (!quoted || !session?.booking_type) throw unpriced('its booking')
  const seat1: PayBy = quoted.seats[0]?.payBy ?? 'paid'
  const isPublic = session.booking_type === 'public'
  const seatPrices = session.seats ?? []
  if (isPublic && seatPrices.length !== booking.guests.length) throw unpriced('a price for every seat')

  // The period T1 locked is the one this credit spends from. No period means no credit, which the
  // facts have already refused.
  const creditPeriodId = seat1 === 'membership_credit' ? locks.creditPeriodId : null
  if (seat1 === 'membership_credit' && !creditPeriodId) throw bookingRefusal('insufficient_membership_credit')

  const buysNewPass = booking.redemptionSource === 'buy_new_session_pass'
  if (buysNewPass && !newPassId) throw unpriced('the pass the booking is paid with')
  const passId = buysNewPass ? newPassId : booking.redemptionSource === 'session_pass_credit' ? booking.sessionPassId ?? null : null

  return {
    sessionId: booking.sessionId,
    customerId: input.customerId as string,
    bookingType: session.booking_type,
    // createOrder took the promo's share off price_paid once createBooking had written it (W09).
    pricePaid: round2(quoted.price - quoted.discount),
    redemptionSource: quoted.redemptionSource,
    redeemedMembershipId: quoted.redemptionSource === 'membership_credit' ? booking.membershipId ?? null : null,
    redeemedSessionPassId: passId,
    creditPeriodId,
    passToClaim: seat1 === 'session_pass_credit' ? passId : null,
    bandId: session.band_id,
    specialRequests: quoted.specialRequests,
    seats: booking.guests.map((guest, i) => ({
      guestType: i === 0 ? 'account_holder' : 'additional_guest',
      name: (guest.name ?? '').trim(),
      email: guest.email?.trim() || null,
      dateOfBirth: i === 0 ? guest.dateOfBirth ?? null : null,
      unitPrice: isPublic ? seatPrices[i]?.unit_price ?? null : null,
      // And each seat's share off its unit_price (W09). A private booking's share is on its price alone.
      discount: quoted.seats[i]?.discount ?? 0,
      payBy: i === 0 ? seat1 : 'paid',
    })),
  }
}

/**
 * The order and everything in it that doesn't need the booking, in one statement: the gift card
 * bought, the order (with its delivery address), the event's places claimed with its booking and an
 * attendee row per place (W08), its lines, the stock claimed with a ledger row per product line, the
 * session pass bought, and the delivery address saved to the customer.
 *
 * The gift card's code must be new. Its INSERT skips a code already taken (ON CONFLICT DO NOTHING:
 * a failed statement would poison the transaction, W03-plan 2.4 item 3), and every other write here
 * waits on `go`, so a collision writes nothing at all and the statement is simply run again with a
 * new code, as createOrder retried its INSERT.
 *
 * The variants are locked already (locks.ts), so each stock claim is one guarded UPDATE per variant,
 * for the whole quantity the basket takes of it. A pass row is only written joined to its own line,
 * and the line count is checked, so neither can be kept without the other (checklist B3). Lines and
 * ledger rows get created_at from the clock, a millisecond apart, in the order createOrder wrote
 * them; the clock is returned so the booking's line can take its place among them.
 *
 * The event is locked too, so its places are claimed with claim_event_places's own guarded UPDATE
 * (on sale, not cancelled, room for every place), as one statement here rather than the function: a
 * function called from a CTE only runs if the CTE is read. Its booking is written only from the
 * claim, its attendees only from its booking, and its line points at it, so a claim that finds no
 * room writes none of them and T1 refuses with event_full. Attendees get created_at from the clock,
 * in place order, as createOrder wrote them one statement each.
 *
 * W09 adds what pays and what discounts, each waiting on `go` like the rest:
 * - the promo code's redemption, written only with the order, for the discount the order records
 *   (the code is locked, and its uses counted afresh, before the facts were read);
 * - the store credit, claimed with store_credit_apply's own guard (the balance after, rounded to the
 *   penny, can't go below nothing) in the one UPDATE of the customer that also saves the delivery
 *   address: one statement can't update a row twice. Its ledger row is written only from the claim,
 *   with the old note;
 * - the gift card used to pay, claimed with createOrder's guarded UPDATE (enough left, not voided, not
 *   expired on today's London date) and marked redeemed when it is used up, as createOrder did, with
 *   its redemption row written only from the claim. The card bought in the same basket can't be the
 *   one claimed: it doesn't exist when the facts are read, and this statement can't see its own insert.
 *
 * W10: an order with a card to charge ($19 is its snapshot) is written `pending` with the snapshot in
 * reader_payment, stamped with the transaction's time, and its event booking `pending` (W8-5), as
 * createOrder's reader path did; T2 marks both paid and confirmed. Its claims are made here all the
 * same, so they are held while the card is charged. Its delivery address isn't saved to the customer
 * here: T2 saves it once the card is paid, as createOrder did after the charge (writeOrder).
 */
const ORDER_SQL = `
WITH clock AS (SELECT clock_timestamp() AS at),
card AS (
  INSERT INTO gift_cards
    (code, type, original_value, remaining_balance, purchaser_id, recipient_name, recipient_email, gift_message,
     origin, issue_date, expiry_date, fulfillment_method)
  SELECT g.code, 'monetary', g.amount, g.amount, $1::uuid, g.recipient_name, g.recipient_email, g.gift_message,
         'customer_purchase', g.issue_date, g.expiry_date, g.fulfillment_method
  FROM jsonb_to_recordset($2::jsonb)
    AS g(code text, amount numeric, recipient_name text, recipient_email text, gift_message text, issue_date date,
         expiry_date date, fulfillment_method text)
  ON CONFLICT (code) DO NOTHING
  RETURNING id, code
),
go AS (SELECT (SELECT count(*) FROM card) = jsonb_array_length($2::jsonb) AS ok),
o AS (
  INSERT INTO orders (customer_id, order_total, payment_status, order_source, shipping_address, promo_code, discount_amount, payment_method, reader_payment)
  SELECT $1::uuid, $3::numeric, CASE WHEN $19::jsonb IS NULL THEN 'paid' ELSE 'pending' END, 'staff_created', $4::jsonb, $13::text,
         $14::numeric, $5::text, $19::jsonb || jsonb_build_object('created_at', now())
  FROM go
  WHERE go.ok
  RETURNING id
),
promo_redemption AS (
  INSERT INTO promo_code_redemptions (promo_code_id, order_id, customer_id, discount_amount)
  SELECT $15::uuid, o.id, $1::uuid, $14::numeric
  FROM o
  WHERE $15::uuid IS NOT NULL
  RETURNING id
),
places AS (
  UPDATE events e
  SET places_booked = e.places_booked + x.places, updated_at = now()
  FROM jsonb_to_recordset($11::jsonb) AS x(event_id uuid, places int)
  WHERE e.id = x.event_id AND e.active AND e.cancelled_at IS NULL AND e.places_booked + x.places <= e.capacity AND (SELECT ok FROM go)
  RETURNING e.id
),
event_booking AS (
  INSERT INTO event_bookings
    (event_id, customer_id, places, status, account_holder_attending, price_paid, created_by_staff_id, guests_over_18_confirmed_at)
  SELECT x.event_id, $1::uuid, x.places, CASE WHEN $19::jsonb IS NULL THEN 'confirmed' ELSE 'pending' END,
         x.account_holder_attending, x.price_paid, x.created_by_staff_id,
         CASE WHEN x.has_guests THEN now() END
  FROM places
  JOIN jsonb_to_recordset($11::jsonb)
    AS x(event_id uuid, places int, account_holder_attending boolean, price_paid numeric, created_by_staff_id uuid, has_guests boolean)
    ON x.event_id = places.id
  RETURNING id
),
attendees AS (
  INSERT INTO event_attendees (event_booking_id, attendee_type, name, email, date_of_birth, unit_price, price_level, created_at)
  SELECT event_booking.id, a.attendee_type, a.name, a.email, a.date_of_birth, a.unit_price, a.price_level,
         clock.at + a.position * interval '1 millisecond'
  FROM event_booking
  CROSS JOIN clock
  CROSS JOIN jsonb_to_recordset($12::jsonb)
    AS a(position int, attendee_type text, name text, email text, date_of_birth date, unit_price numeric, price_level text)
  RETURNING id
),
lines AS (
  INSERT INTO order_line_items
    (order_id, item_type, quantity, unit_price, line_total, addon_id, product_variant_id, session_pass_type_id, gift_card_id,
     event_booking_id, fulfillment_status, system_unit_price, price_override_reason, discount_amount, created_at)
  SELECT o.id, l.item_type, l.quantity, l.unit_price, l.line_total, l.addon_id, l.product_variant_id, l.session_pass_type_id,
         CASE WHEN l.item_type = 'gift_card' THEN (SELECT id FROM card) END,
         CASE WHEN l.item_type = 'event' THEN (SELECT id FROM event_booking) END,
         l.fulfillment_status, l.system_unit_price, l.price_override_reason, l.discount_amount,
         clock.at + l.position * interval '1 millisecond'
  FROM o
  CROSS JOIN clock
  CROSS JOIN jsonb_to_recordset($6::jsonb)
    AS l(position int, item_type text, quantity int, unit_price numeric, line_total numeric, addon_id uuid, product_variant_id uuid,
         session_pass_type_id uuid, fulfillment_status text, system_unit_price numeric, price_override_reason text, discount_amount numeric)
  RETURNING id, item_type, session_pass_type_id
),
stock AS (
  UPDATE product_variants v
  SET stock_quantity = v.stock_quantity - x.quantity, updated_at = now()
  FROM jsonb_to_recordset($7::jsonb) AS x(variant_id uuid, quantity int)
  WHERE v.id = x.variant_id AND v.stock_quantity >= x.quantity AND (SELECT ok FROM go)
  RETURNING v.id
),
ledger AS (
  INSERT INTO stock_adjustments (variant_id, change_amount, reason, staff_id, created_at)
  SELECT a.variant_id, -a.quantity, 'Sale (Order #' || o.id || ')', NULL, clock.at + a.position * interval '1 millisecond'
  FROM o
  CROSS JOIN clock
  CROSS JOIN jsonb_to_recordset($8::jsonb) AS a(position int, variant_id uuid, quantity int)
  RETURNING id
),
passes AS (
  INSERT INTO customer_session_passes (customer_id, pass_type_id, purchase_date, sessions_remaining, expiry_date, order_line_item_id)
  SELECT $1::uuid, p.pass_type_id, p.purchase_date, p.sessions_remaining, p.expiry_date, lines.id
  FROM lines
  JOIN jsonb_to_recordset($9::jsonb) AS p(pass_type_id uuid, purchase_date date, sessions_remaining int, expiry_date date)
    ON lines.item_type = 'session_pass' AND lines.session_pass_type_id = p.pass_type_id
  RETURNING id
),
customer AS (
  UPDATE customers c
  SET address_line1 = CASE WHEN x.address IS NULL THEN c.address_line1 ELSE x.address->>'line1' END,
      address_line2 = CASE WHEN x.address IS NULL THEN c.address_line2 ELSE x.address->>'line2' END,
      city = CASE WHEN x.address IS NULL THEN c.city ELSE x.address->>'city' END,
      postcode = CASE WHEN x.address IS NULL THEN c.postcode ELSE x.address->>'postcode' END,
      country = CASE WHEN x.address IS NULL THEN c.country ELSE x.address->>'country' END,
      store_credit_balance = round(c.store_credit_balance - x.credit, 2),
      updated_at = now()
  FROM jsonb_to_recordset($10::jsonb) AS x(address jsonb, credit numeric)
  WHERE c.id = $1::uuid AND (SELECT ok FROM go) AND (x.credit = 0 OR round(c.store_credit_balance - x.credit, 2) >= 0)
  RETURNING c.store_credit_balance AS balance_after, x.address IS NOT NULL AS address_saved, x.credit
),
credit_row AS (
  INSERT INTO store_credit_transactions (customer_id, amount, balance_after, reason, order_id, staff_id, note)
  SELECT $1::uuid, round(-customer.credit, 2), customer.balance_after, 'redemption', o.id, $16::uuid, $17::text
  FROM customer
  CROSS JOIN o
  WHERE customer.credit > 0
  RETURNING id
),
gift_card_claim AS (
  UPDATE gift_cards g
  SET remaining_balance = g.remaining_balance - x.amount,
      redeemed_at = CASE WHEN g.redeemed_at IS NULL AND round(g.remaining_balance - x.amount, 2) <= 0 THEN now() ELSE g.redeemed_at END,
      updated_at = now()
  FROM jsonb_to_recordset($18::jsonb) AS x(gift_card_id uuid, amount numeric)
  WHERE g.id = x.gift_card_id AND g.remaining_balance >= x.amount AND g.voided IS NOT TRUE
    AND g.expiry_date >= (now() AT TIME ZONE 'Europe/London')::date AND (SELECT ok FROM go)
  RETURNING g.id, x.amount
),
gift_card_redemption AS (
  INSERT INTO gift_card_redemptions (gift_card_id, order_id, amount_used, redeemed_at)
  SELECT gift_card_claim.id, o.id, gift_card_claim.amount, now()
  FROM gift_card_claim
  CROSS JOIN o
  RETURNING id
)
SELECT (SELECT id FROM o) AS order_id,
       (SELECT at::text FROM clock) AS lines_at,
       (SELECT id FROM card) AS gift_card_id,
       (SELECT code FROM card) AS gift_card_code,
       (SELECT id FROM passes) AS session_pass_id,
       (SELECT count(*)::int FROM lines) AS lines_written,
       (SELECT COALESCE(array_agg(id), '{}') FROM stock) AS variants_claimed,
       (SELECT count(*)::int FROM ledger) AS ledger_written,
       (SELECT count(*)::int FROM passes) AS passes_written,
       (SELECT count(*)::int FROM customer WHERE address_saved) AS addresses_saved,
       (SELECT count(*)::int FROM places) AS events_claimed,
       (SELECT id FROM event_booking) AS event_booking_id,
       (SELECT count(*)::int FROM attendees) AS attendees_written,
       (SELECT count(*)::int FROM promo_redemption) AS promo_redemptions_written,
       (SELECT count(*)::int FROM customer WHERE credit > 0) AS store_credit_claimed,
       (SELECT count(*)::int FROM credit_row) AS store_credit_rows_written,
       (SELECT bool_or(round(c.store_credit_balance - x.credit, 2) < 0)
        FROM customers c CROSS JOIN jsonb_to_recordset($10::jsonb) AS x(address jsonb, credit numeric)
        WHERE c.id = $1::uuid) AS store_credit_short,
       (SELECT count(*)::int FROM gift_card_claim) AS gift_cards_claimed,
       (SELECT count(*)::int FROM gift_card_redemption) AS gift_card_redemptions_written`

interface OrderWritten {
  /** Null when the gift card's code was taken: nothing was written. */
  order_id: string | null
  lines_at: string
  gift_card_id: string | null
  gift_card_code: string | null
  session_pass_id: string | null
  lines_written: number
  variants_claimed: string[]
  ledger_written: number
  passes_written: number
  addresses_saved: number
  events_claimed: number
  event_booking_id: string | null
  attendees_written: number
  promo_redemptions_written: number
  store_credit_claimed: number
  store_credit_rows_written: number
  /** Whether the balance before this statement was short of the store credit claimed (W09). */
  store_credit_short: boolean | null
  gift_cards_claimed: number
  gift_card_redemptions_written: number
}

/** createOrder's note on the store credit it took at checkout (claimStoreCreditAndGiftCard). */
export const STORE_CREDIT_NOTE = 'Store credit redeemed at checkout.'

/** As createOrder: five codes, then gift_card_code_exhausted. */
export const GIFT_CARD_CODE_TRIES = 5

/** The line kinds the order statement writes. A booking's line is the booking statement's. */
const ORDER_LINE_KINDS = new Set(['event', 'addon', 'product', 'session_pass', 'gift_card', 'postage'])

interface OrderToWrite {
  orderId: string
  /** What orders.payment_method recorded (W03-decisions Q9). */
  paymentMethod: string | null
  linesAt: string
  giftCardId: string | null
  giftCardCode: string | null
  sessionPassId: string | null
  eventBookingId: string | null
}

/**
 * The event's booking and an attendee row per place, as writeEventBooking wrote them: at the quote's
 * prices less each place's promo share, the account holder (when attending) first, names and emails
 * trimmed, and a date of birth for the account holder only (guests are covered by the 18+ tick).
 */
function eventToWrite(input: PlaceOrderInput, quote: BasketQuoteOutput, options: PlaceOrderOptions): { events: Array<Record<string, unknown>>; attendees: Array<Record<string, unknown>> } {
  const event = input.event
  const quoted = quote.event
  if (!event) return { events: [], attendees: [] }
  if (!quoted) throw unpriced('its event')
  const inOrder = inPlaceOrder(event.attendees)
  if (inOrder.length !== quoted.places.length) throw unpriced('a place for every attendee')
  return {
    events: [
      {
        event_id: quoted.eventId,
        places: quoted.places.length,
        account_holder_attending: event.accountHolderAttending === true,
        price_paid: Math.max(0, round2(quoted.listTotal - quoted.discount)),
        created_by_staff_id: options.actor.type === 'staff' ? options.actor.id : null,
        has_guests: event.attendees.some((attendee) => attendee.isAccountHolder !== true),
      },
    ],
    attendees: quoted.places.map((place, i) => {
      const attendee = inOrder[i] as BasketEventAttendee
      return {
        position: i + 1,
        attendee_type: place.attendeeType,
        name: (attendee.name ?? '').trim(),
        email: attendee.email?.trim() || null,
        date_of_birth: place.attendeeType === 'account_holder' ? attendee.dateOfBirth ?? null : null,
        unit_price: Math.max(0, round2(place.unitPrice - place.discount)),
        price_level: place.priceLevel,
      }
    }),
  }
}

/**
 * The order statement, run again with a new code while the gift card's code was taken. `snapshot` is
 * the pending record of an order with a card still to charge (W10), null for one finished in T1.
 */
async function writeOrder(
  tx: Tx,
  input: PlaceOrderInput,
  facts: BasketFacts,
  quote: BasketQuoteOutput,
  locks: HeldLocks,
  options: PlaceOrderOptions,
  snapshot: PendingSnapshot | null
): Promise<OrderToWrite> {
  const customerId = input.customerId as string
  const products = input.products ?? []
  const { totals, promo } = quote
  // The amounts exactly as sent, as createOrder claimed them: the checks have passed, so each is over
  // nothing and within its balance and the total. store_credit_apply rounded the balance after, so
  // the claim below does too.
  const giftCardPaying = input.payment?.giftCard ?? null
  const storeCredit = input.payment?.storeCredit?.amount ?? 0
  // What the card or the cash takes is the same remainder (price-basket.ts); recorded now, also on a
  // pending card order, so T2 only marks it paid. createOrder recorded 'card' or 'split' the same way.
  // W11: a reader order records none until T2, as createOrder's reader branch left it pending
  // (finaliseReaderOrder wrote the method), so the pending order is the old one's, field for field.
  const paymentMethod =
    snapshot?.method === 'reader' ? null : recordedPaymentMethod(input.payment?.method, totals.toCollect.cash, giftCardPaying?.amount ?? 0, storeCredit)

  const lines = quote.lines.flatMap((line, i) => {
    if (line.kind === 'booking') return []
    if (!ORDER_LINE_KINDS.has(line.kind)) throw unpriced(`a ${line.kind} line, which T1 doesn't write yet`)
    return [
      {
        position: i + 1,
        item_type: line.kind,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        line_total: line.lineTotal,
        addon_id: line.kind === 'addon' ? line.itemId : null,
        product_variant_id: line.kind === 'product' ? line.itemId : null,
        session_pass_type_id: line.kind === 'session_pass' ? line.itemId : null,
        fulfillment_status: line.kind === 'product' ? 'pending' : null,
        system_unit_price: line.systemUnitPrice,
        price_override_reason: line.priceOverrideReason,
        discount_amount: line.discount,
      },
    ]
  })

  // One claim per variant, for all the basket takes of it; one ledger row per line, as createOrder wrote.
  const byVariant = new Map<string, number>()
  for (const line of products) byVariant.set(line.productVariantId, (byVariant.get(line.productVariantId) ?? 0) + line.quantity)
  const claims = [...byVariant].map(([variant_id, quantity]) => ({ variant_id, quantity }))
  const ledger = products.map((line, i) => ({ position: i + 1, variant_id: line.productVariantId, quantity: line.quantity }))

  // London dates: bought today in London, valid through the same date N months on.
  const today = facts.today
  const passLine = quote.lines.find((line) => line.kind === 'session_pass')
  const passType = facts.pass_type
  if (passLine && passType?.id !== passLine.itemId) throw unpriced('the pass type it sells')
  const passes = passLine && passType
    ? [{ pass_type_id: passType.id, purchase_date: today, sessions_remaining: passType.sessions_included ?? 0, expiry_date: addMonthsToIsoDate(today, passType.expiry_months ?? 12) }]
    : []

  const giftCardLine = quote.lines.find((line) => line.kind === 'gift_card')
  const giftCard = input.giftCard
  if (giftCardLine && !giftCard) throw unpriced('the gift card it sells')
  const giftCardMonths = (giftCard?.giftCardPresetId ? facts.gift_card_preset?.expiry_months : facts.gift_card_type?.expiry_months) ?? 12
  const newCode = options.giftCardCode ?? generateGiftCardCode
  const giftCards = (): Array<Record<string, unknown>> =>
    giftCardLine && giftCard
      ? [
          {
            code: newCode(),
            amount: giftCardLine.unitPrice,
            recipient_name: giftCard.recipientName ?? null,
            recipient_email: giftCard.recipientEmail ?? null,
            gift_message: giftCard.giftMessage ?? null,
            issue_date: today,
            expiry_date: addMonthsToIsoDate(today, giftCardMonths),
            fulfillment_method: giftCard.fulfillmentMethod,
          },
        ]
      : []

  const delivery = quote.delivery
  // With a card still to charge, T2 saves it (the snapshot says so): a refused card changes nothing about the customer.
  const savedAddress = delivery?.saveToCustomer && !snapshot ? delivery.address : null
  const { events, attendees } = eventToWrite(input, quote, options)

  // W09: the promo's use, the store credit (with the address, in the customer's one UPDATE) and the gift card used to pay.
  if (promo && !locks.promoCodeId) throw unpriced('the promo code it locked')
  const customerChange = savedAddress || storeCredit > 0 ? [{ address: savedAddress, credit: storeCredit }] : []
  const giftCardRedeemed = giftCardPaying ? [{ gift_card_id: giftCardPaying.giftCardId, amount: giftCardPaying.amount }] : []
  // Who took the store credit, on its ledger row, as createOrder's acting staff member. Only bound when some is taken.
  const staffId = storeCredit > 0 && options.actor.type === 'staff' ? options.actor.id : null

  for (let attempt = 1; ; attempt += 1) {
    const cards = giftCards()
    const written = (
      await tx.query<OrderWritten>(ORDER_SQL, [
        customerId,
        cards,
        totals.orderTotal,
        delivery?.address ?? null,
        paymentMethod,
        lines,
        claims,
        ledger,
        passes,
        customerChange,
        events,
        attendees,
        promo?.code ?? null,
        promo?.discountTotal ?? 0,
        promo ? locks.promoCodeId : null,
        staffId,
        STORE_CREDIT_NOTE,
        giftCardRedeemed,
        snapshot,
      ])
    )[0] as OrderWritten
    if (!written.order_id) {
      if (cards.length === 0) throw new Error('The order was not written.')
      if (attempt < GIFT_CARD_CODE_TRIES) continue
      throw orderRefusal({ stage: 'gift_card', reason: 'gift_card_code_exhausted' })
    }

    if (written.lines_written !== lines.length) throw new Error(`The order was not written whole: ${written.lines_written} of ${lines.length} lines.`)
    const claimed = new Set(written.variants_claimed)
    const short = products.find((line) => !claimed.has(line.productVariantId))
    if (short) throw orderRefusal({ stage: 'product', reason: 'insufficient_stock', productVariantId: short.productVariantId })
    // The places, after the stock, as createOrder claimed them (stage 21 after stage 19). Attendees
    // are only written from the event booking, and an event always has one, so their count checks the
    // booking as well.
    if (written.events_claimed !== events.length) throw orderRefusal(eventFullRefusal())
    if (written.attendees_written !== attendees.length) throw new Error(`The event's booking and attendees were not written whole: ${written.attendees_written} of ${attendees.length} attendees.`)
    // W09, after the places, as createOrder claimed them: the promo's use (stage 25a), then the store
    // credit, then the gift card (stage 30). Each is locked and was read after its lock, so a claim
    // that finds nothing means something the locks should have stopped; each refuses with
    // createOrder's reason, and the transaction rolls back.
    if (written.promo_redemptions_written !== (promo ? 1 : 0)) throw new Error("The promo code's use was not recorded.")
    if (written.store_credit_claimed !== (storeCredit > 0 ? 1 : 0)) {
      throw orderRefusal({ stage: 'payment', reason: written.store_credit_short ? 'store_credit_insufficient' : 'store_credit_failed' })
    }
    if (written.store_credit_rows_written !== written.store_credit_claimed) throw new Error('The store credit taken was not recorded.')
    if (written.gift_cards_claimed !== giftCardRedeemed.length) throw orderRefusal({ stage: 'payment', reason: 'gift_card_insufficient_or_invalid' })
    if (written.gift_card_redemptions_written !== giftCardRedeemed.length) throw new Error("The gift card's use was not recorded.")
    if (written.ledger_written !== ledger.length) throw new Error(`The stock ledger was not written whole: ${written.ledger_written} of ${ledger.length} rows.`)
    if (written.passes_written !== passes.length) throw new Error(`The session pass and its line were not written together: ${written.passes_written} of ${passes.length} passes.`)
    if (cards.length > 0 && !written.gift_card_id) throw new Error('The gift card was not written.')
    if (written.addresses_saved !== (savedAddress ? 1 : 0)) throw new Error("The delivery address was not saved to the customer.")
    return {
      orderId: written.order_id,
      paymentMethod,
      linesAt: written.lines_at,
      giftCardId: written.gift_card_id,
      giftCardCode: written.gift_card_code,
      sessionPassId: written.session_pass_id,
      eventBookingId: written.event_booking_id,
    }
  }
}

/** The booking's line and add-ons, for the booking statement. */
function bookingOrderPart(quote: BasketQuoteOutput, order: OrderToWrite): BookingOrderPart {
  const index = quote.lines.findIndex((line) => line.kind === 'booking')
  const line = quote.lines[index]
  if (!line) throw unpriced('its booking line')
  const addons = quote.booking?.addons ?? []
  const creditsByMembership = new Map<string, number>()
  for (const addon of addons) {
    if (addon.redemptionSource !== 'membership_credit') continue
    if (!addon.membershipId) throw unpriced('the membership an add-on credit comes from')
    creditsByMembership.set(addon.membershipId, (creditsByMembership.get(addon.membershipId) ?? 0) + addon.quantity)
  }
  return {
    orderId: order.orderId,
    linesAt: order.linesAt,
    linePosition: index + 1,
    linePrice: line.unitPrice,
    lineDiscount: line.discount,
    addons: addons.map((addon) => ({
      addonId: addon.addonId,
      quantity: addon.quantity,
      priceAtPurchase: addon.unitPrice,
      redemptionSource: addon.redemptionSource,
      redeemedMembershipId: addon.redemptionSource === 'membership_credit' ? addon.membershipId : null,
    })),
    credits: [...creditsByMembership].map(([membershipId, quantity]) => ({ membershipId, quantity })),
  }
}

interface Placed {
  /**
   * What the order answers: once it is paid (on a card order, once the card has been charged and T2 has
   * run), or on the reader (W11) that it waits for the tap, with the intent added once Stripe has made it.
   */
  output: PlaceOrderOutput
  orderId: string
  /** The card still to charge, after T1 has committed the order pending (W10). Null when T1 finished it. */
  charge: PendingCharge | null
  /** The reader's intent still to make, after T1 has committed the order pending (W11). */
  reader: PendingReader | null
}

/**
 * The pending record of an order with a card to charge (W03-plan 2.5). The customer's Stripe
 * customer and saved card are the ones read under the customer's lock; T1 refuses the order before it
 * commits if either is missing (prepare).
 */
function cardSnapshot(input: PlaceOrderInput, facts: BasketFacts, quote: BasketQuoteOutput, options: PlaceOrderOptions, mode: PrepareMode): CardSnapshot {
  const giftCard = input.payment?.giftCard
  return {
    flow: 'checkout',
    method: 'card',
    channel: 'staff',
    expected_amount: quote.totals.toCollect.card,
    save_card: false,
    save_address_to_customer: quote.delivery?.saveToCustomer === true,
    stripe_customer_id: facts.customer?.stripe_customer_id ?? '',
    payment_method_id: facts.customer?.saved_payment_method_id ?? '',
    charge_description: chargeDescription(input),
    charge_payment_intent_id: null,
    request_id: options.requestId,
    ...(giftCard ? { gift_card_redemption: { gift_card_id: giftCard.giftCardId, amount: giftCard.amount } } : {}),
    ...heldBooking(input),
    ...(typeof mode.keyLivemode === 'boolean' ? { livemode: mode.keyLivemode } : {}),
  }
}

/**
 * The pending record of a reader order (W11), what createOrder's reader branch wrote, committed by T1
 * before the intent exists (bug 14). The single tap is the server's figure (W03-plan 2.7). The Stripe
 * customer is the one read under the customer's lock, null when they have none yet: the intent finds
 * or makes one, and records it with the intent.
 */
function readerSnapshot(input: PlaceOrderInput, facts: BasketFacts, quote: BasketQuoteOutput, options: PlaceOrderOptions, mode: PrepareMode): ReaderSnapshot {
  const giftCard = input.payment?.giftCard
  return {
    flow: 'checkout',
    method: 'reader',
    channel: 'staff',
    expected_amount: quote.totals.toCollect.reader,
    save_card: input.payment?.readerSaveCard === true,
    save_address_to_customer: quote.delivery?.saveToCustomer === true,
    stripe_customer_id: facts.customer?.stripe_customer_id ?? null,
    request_id: options.requestId,
    ...(giftCard ? { gift_card_redemption: { gift_card_id: giftCard.giftCardId, amount: giftCard.amount } } : {}),
    ...heldBooking(input),
    ...(typeof mode.keyLivemode === 'boolean' ? { livemode: mode.keyLivemode } : {}),
  }
}

async function prepare(tx: Tx, input: PlaceOrderInput, options: PlaceOrderOptions, mode: PrepareMode): Promise<Placed> {
  const { confirmed, ...basket } = input
  const customerId = input.customerId as string
  const booking = input.booking
  // An order always has a payment: an empty one is nothing chosen, which the price checks need to see.
  const quoteInput: BasketQuoteInput = { ...basket, payment: input.payment ?? {} }

  // 1. Locks, in LOCK_ORDER, before anything is read: what is read next is then current until commit.
  const attached = booking?.addons ?? []
  const locks = await lockForOrder(tx, {
    customerId,
    sessionId: booking?.sessionId ?? null,
    creditMembershipId: booking?.redemptionSource === 'membership_credit' ? booking.membershipId ?? null : null,
    sessionPassId: booking?.redemptionSource === 'session_pass_credit' ? booking.sessionPassId ?? null : null,
    addonMembershipIds: attached.flatMap((line) => (line.redemptionSource === 'membership_credit' && line.membershipId ? [line.membershipId] : [])),
    productVariantIds: (input.products ?? []).map((line) => line.productVariantId),
    eventId: input.event?.eventId ?? null,
    promoCode: input.promoCode?.trim() || null,
    giftCardId: input.payment?.giftCard?.giftCardId ?? null,
  })
  if (!locks) throw orderRefusal({ stage: 'validation', reason: 'customer_not_found' })

  // 2. Everything the price depends on, in one read, and the quote's own sums.
  const facts = await loadBasketFacts(tx, quoteInput)
  const method = input.payment?.method
  const quote = priceFromFacts(quoteInput, facts, { allowPriceOverrides: options.allowPriceOverrides === true })
  // W03-decisions Q10 (as changed by "W10 review calls"): a card order while the customer has one
  // still being processed may be a second sale of what the first is still holding (a fresh basket
  // after a crash), so it is refused before anything else, whatever else the basket says. Only when
  // the card is to be charged something: with nothing on the card there is no second charge to stop.
  // priceFromFacts only adds up (its problems are refused below), so this is still the first refusal.
  // Read after the customer's lock, so of two card orders at once the second waits for the first's
  // T1, then sees it. Cash and store credit orders aren't affected. A held Worker card order counts
  // however old it is (load-basket.ts). W11: the reader likewise ("W10 review calls": Q10 covers
  // reader orders as it covers card orders), and a held Worker reader order counts however old too.
  const awaitsCard = method === 'card' && quote.totals.toCollect.card > 0
  const awaitsReader = method === 'reader' && quote.totals.toCollect.reader > 0
  if ((awaitsCard || awaitsReader) && facts.customer?.has_order_processing) {
    throw orderRefusal({ stage: 'payment', reason: 'order_still_processing', message: ORDER_STILL_PROCESSING_MESSAGE })
  }
  refuseIfNeeded(input, quote, mode)

  // A card with something to take: the order is committed pending, with its snapshot, and the card
  // is charged after the commit (W03-plan 2.1, B14). Nothing to take on the card finishes here, as createOrder did.
  // W11: the reader the same way, its intent made after the commit (bug 14). Nothing to take on the reader
  // was refused above (reader_nothing_to_charge), as createOrder refused it.
  const snapshot: PendingSnapshot | null = awaitsCard ? cardSnapshot(input, facts, quote, options, mode) : awaitsReader ? readerSnapshot(input, facts, quote, options, mode) : null

  // 3. The order, and everything in it that doesn't need the booking.
  const order = await writeOrder(tx, input, facts, quote, locks, options, snapshot)

  // 4. The booking, with its line, its add-ons and their credits.
  const bookingWrite = bookingToWrite(input, facts, quote, locks, order.sessionPassId)
  const bookingId = bookingWrite ? await writeBooking(tx, bookingWrite, bookingOrderPart(quote, order)) : null

  // The saved card, where createOrder met its absence: after every write, at the charge (stage 32),
  // which its route refused with these words. Here it rolls T1 back, so nothing is kept and Stripe is
  // never called. A card needs both: the card is attached to the Stripe customer.
  if (snapshot?.method === 'card' && (!snapshot.stripe_customer_id || !snapshot.payment_method_id)) {
    throw orderRefusal({ stage: 'payment', reason: 'charge_failed', message: NO_SAVED_CARD_MESSAGE })
  }

  // 5. The audit rows, in the same transaction. Nothing owed to Stripe: the order is paid now. A card
  //    to charge, or a reader tap to take (W11): only order.create; T2 records order.paid.
  const { orderId, paymentMethod } = order
  const collected = awaitsCard ? quote.totals.toCollect.card : awaitsReader ? quote.totals.toCollect.reader : quote.totals.toCollect.cash
  const giftCardApplied = quote.totals.giftCardApplied
  const storeCreditApplied = quote.totals.storeCreditApplied
  const actor = { actorType: options.actor.type, actorId: options.actor.id, entityType: 'order', entityId: orderId, requestId: options.requestId }
  const overrides = quote.lines.flatMap((line) =>
    line.priceOverrideReason ? [{ line: line.key, unitPrice: line.unitPrice, systemUnitPrice: line.systemUnitPrice, reason: line.priceOverrideReason }] : []
  )
  await audit.recordAll(tx, [
    {
      ...actor,
      action: 'order.create',
      details: {
        method: method ?? null,
        bookingId,
        sessionPassId: order.sessionPassId,
        giftCardId: order.giftCardId,
        eventBookingId: order.eventBookingId,
        postage: quote.postage ? { method: quote.postage.method, amount: quote.postage.amount } : null,
        addressSaved: quote.delivery?.saveToCustomer === true,
        orderTotal: quote.totals.orderTotal,
        promo: quote.promo ? { code: quote.promo.code, discount: quote.promo.discountTotal } : null,
        amountDue: quote.totals.amountDue,
        giftCard: input.payment?.giftCard ? { giftCardId: input.payment.giftCard.giftCardId, amount: giftCardApplied } : null,
        storeCredit: storeCreditApplied,
        toCollect: collected,
        confirmed: confirmed ?? null,
        overrides,
        ...(awaitsCard ? { awaitsCard: true } : {}),
        ...(awaitsReader ? { awaitsReader: true } : {}),
      },
    },
    ...(snapshot
      ? []
      : [{ ...actor, action: 'order.paid', details: { method: paymentMethod, collected, giftCard: giftCardApplied, storeCredit: storeCreditApplied } }]),
  ])

  return {
    orderId,
    output: {
      orderId,
      // W11: a reader order waits for the tap. Its method is the reader's, as createOrder answered
      // (paymentMethodUsed 'reader'); what orders.payment_method records is written by T2 (Q9).
      status: awaitsReader ? 'pending_reader' : 'paid',
      bookingId,
      sessionPassId: order.sessionPassId,
      giftCardId: order.giftCardId,
      giftCardCode: order.giftCardCode,
      eventBookingId: order.eventBookingId,
      payment: { method: awaitsReader ? 'reader' : paymentMethod, collected, cardCharged: awaitsCard, giftCardApplied, storeCreditApplied },
    },
    charge: snapshot?.method === 'card' ? { orderId, customerId, snapshot } : null,
    reader: snapshot?.method === 'reader' ? { orderId, customerId, snapshot } : null,
  }
}

// --- After a rollback

const DUPLICATE_DAY_TEXT = 'This customer already has a booking on'

/**
 * A refusal Postgres raised ends the transaction, so it is turned into createBooking's reason here,
 * after the rollback (W03-plan 2.4 items 4 and 6). The Herd gate's words name a setting, read once
 * the transaction has gone.
 */
async function afterRollback(db: Db, err: unknown): Promise<unknown> {
  const refused = postgresRefusal(err)
  if (refused?.constraint === 'bookings_no_cross_session_overlap') return bookingRefusal('time_conflict')
  if (refused?.code === 'P0001' && refused.message.startsWith(DUPLICATE_DAY_TEXT)) return bookingRefusal('duplicate_day_booking')
  // createBooking took any failure to quote the seats as an unpriced band.
  if (refused?.code === 'P0001' && refused.where?.includes('quote_booking')) return bookingRefusal('band_unpriced')

  const details = refusalDetails(err)
  if (details?.reason === 'addon_membership_too_new') {
    const months = await db
      .query<{ months: number }>('SELECT addon_credit_wait_months AS months FROM membership_settings LIMIT 1')
      .then((rows) => rows[0]?.months ?? null)
      .catch(() => null)
    return orderRefusal(details as BasketProblem, { addonCreditWaitMonths: months })
  }
  return err
}

/**
 * T1 in its own transaction. Two orders inserting overlapping bookings at the same moment each wait
 * on the other's row in the exclusion index, and Postgres aborts one (40P01, W06 review S1). T1
 * calls nothing outside the database and the abort rolled all of it back, so it runs once more, as
 * Postgres advises: the second attempt sees the other order committed and refuses with
 * time_conflict. Only when T1 opened the transaction: one it joined is its caller's, already failed.
 */
async function inTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const opensItsOwn = !inOpenTransaction(db)
  try {
    try {
      return await db.transaction(work)
    } catch (err) {
      if (!opensItsOwn || !isDeadlock(err)) throw err
      return await db.transaction(work)
    }
  } catch (err) {
    throw await afterRollback(db, err)
  }
}

const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

/**
 * After T1 has committed a card order pending (W03-plan 2.1 and 2.5):
 * - collect charges the saved card under the key `<orderId>:charge`;
 * - Stripe's answer: T2 checks it and marks the order paid, in one transaction;
 * - a definite refusal: nothing was taken, so the one undo gives everything back, and staff are told
 *   the old route's words (PAYMENT_FAILED, or PAYMENT_NEEDS_AUTHENTICATION);
 * - no clear answer (after the one retry with the same key, or after the first send when the deadline
 *   leaves no time for the retry, W10a): the order stays pending, holding its claims, never undone
 *   here, and staff are told PAYMENT_UNCONFIRMED;
 * - T2 failing after the card was charged: the order stays pending for reconcile (W12). A good sale is
 *   never refunded for a database fault (W6-3).
 * Every answer here is stored against the request's key, so a second press with it gets the same
 * answer and never charges again; a new key meets Q10's guard while the order is pending.
 */
async function collectAndFinish(
  db: Db,
  stripe: StripeClient,
  placed: Placed & { charge: PendingCharge },
  options: PlaceOrderOptions,
  startedAt: number
): Promise<PlaceOrderOutput> {
  const { orderId, charge } = placed
  const actor = { type: options.actor.type, id: options.actor.id }

  let answer: ChargeAnswer
  try {
    answer = await collectSavedCard(db, stripe, charge, { deadline: startedAt + COLLECT_DEADLINE_MS, now: options.now ?? Date.now })
  } catch (err) {
    // Not Stripe's answer to the charge (finding the Stripe customer failed): held, as if unclear.
    throw paymentUnconfirmed('payment_unconfirmed', PAYMENT_UNCONFIRMED_MESSAGE, orderId, explain(err))
  }

  if (answer.outcome === 'definite') {
    const refusal = orderRefusal(
      { stage: 'payment', reason: 'charge_failed', message: answer.message },
      {},
      answer.needsAuthentication ? 'PAYMENT_NEEDS_AUTHENTICATION' : 'PAYMENT_FAILED'
    )
    try {
      await undoOrder(db, orderId, { actor, requestId: options.requestId, why: `The card was refused: ${answer.stripeCode ?? 'no code'}. ${answer.message}` })
    } catch (err) {
      // Nothing was taken, so the card's refusal is still the answer. The order stays pending with its
      // claims until the undo runs again (reconcile, W12); the log says why.
      throw new ApiError(refusal.code, refusal.message, { details: refusal.details, logDetail: `The undo failed: ${explain(err)}` })
    }
    throw refusal
  }
  if (answer.outcome === 'unknown') {
    throw paymentUnconfirmed('payment_unconfirmed', PAYMENT_UNCONFIRMED_MESSAGE, orderId, `${answer.stripeCode ?? 'no code'}: ${answer.detail}`)
  }

  let finalised: FinaliseOutcome
  try {
    finalised = await finaliseOrder(db, orderId, answer.paymentIntent, { actor, requestId: options.requestId })
  } catch (err) {
    throw paymentUnconfirmed('paid_not_finished', PAID_NOT_FINISHED_MESSAGE, orderId, `T2 failed after ${answer.paymentIntent.id}: ${explain(err)}`)
  }
  if (!finalised.finalised) {
    if (finalised.reason === 'order_gone') {
      throw paymentUnconfirmed('charged_without_order', CHARGED_WITHOUT_ORDER_MESSAGE, orderId, `${answer.paymentIntent.id} succeeded for an order that is gone`)
    }
    throw paymentUnconfirmed('payment_unconfirmed', PAYMENT_UNCONFIRMED_MESSAGE, orderId, `T2 left ${answer.paymentIntent.id} pending: ${finalised.reason}`)
  }
  return placed.output
}

/**
 * After T1 has committed a reader order pending with its pending record (W11, createOrder's stage 29,
 * bug 14 fixed): the reader's intent, under `<orderId>:reader-intent` (reader-intent.ts).
 * - Stripe made it: it is written onto the pending record (with the Stripe customer it is for), and the
 *   order answers `pending_reader` with what the screen collects on the reader. Nothing is taken until
 *   the customer taps; the finalise route (reader-order.ts) then runs T2.
 * - A definite failure (no intent exists): nothing can be taken, so the one undo gives everything back,
 *   and staff are told the old words (reader_intent_failed).
 * - No clear answer (after one retry with the same key), or the intent couldn't be written onto the
 *   order: held pending with its claims, never undone here, PAYMENT_UNCONFIRMED. No secret reaches the
 *   screen, so no tap can take money for it; reconcile (W12) cancels any intent and undoes it.
 * Every answer is stored against the request's key; a new key meets Q10's guard while it is pending.
 */
async function startReaderPayment(
  db: Db,
  stripe: StripeClient,
  placed: Placed & { reader: PendingReader },
  options: PlaceOrderOptions,
  startedAt: number
): Promise<PlaceOrderOutput> {
  const { orderId, reader } = placed
  const actor = { type: options.actor.type, id: options.actor.id }
  const answer = await createReaderIntent(db, stripe, reader, stripeTiming(startedAt, options.now ?? Date.now))

  if (answer.outcome === 'definite') {
    const refusal = orderRefusal({ stage: 'payment', reason: 'reader_intent_failed', message: answer.message })
    try {
      await undoOrder(db, orderId, { actor, requestId: options.requestId, why: `The card reader payment couldn't be started. ${answer.detail}` })
    } catch (err) {
      // Nothing can be taken, so the refusal is still the answer. The order stays pending with its
      // claims until the undo runs again (reconcile, W12); the log says why.
      throw new ApiError(refusal.code, refusal.message, { details: refusal.details, logDetail: `The undo failed: ${explain(err)}` })
    }
    throw refusal
  }
  if (answer.outcome === 'unknown') {
    throw paymentUnconfirmed('payment_unconfirmed', READER_INTENT_UNCONFIRMED_MESSAGE, orderId, `The reader's intent got no clear answer: ${answer.detail}`)
  }

  const { paymentIntent, stripeCustomerId } = answer
  const clientSecret = paymentIntent.client_secret
  let recorded: boolean
  try {
    recorded = Boolean(clientSecret) && (await recordReaderIntent(db, orderId, paymentIntent, stripeCustomerId))
  } catch (err) {
    throw paymentUnconfirmed('payment_unconfirmed', READER_INTENT_UNCONFIRMED_MESSAGE, orderId, `${paymentIntent.id} could not be written onto the order: ${explain(err)}`)
  }
  if (!recorded || !clientSecret) {
    throw paymentUnconfirmed('payment_unconfirmed', READER_INTENT_UNCONFIRMED_MESSAGE, orderId, `${paymentIntent.id} was not written onto the order (no secret, or the order changed)`)
  }
  return {
    ...placed.output,
    pendingReaderPayment: { orderId, paymentIntentId: paymentIntent.id, clientSecret, amount: reader.snapshot.expected_amount },
  }
}

export async function placeOrder(db: Db, input: PlaceOrderInput, options: PlaceOrderOptions): Promise<PlaceOrderOutput> {
  const startedAt = options.startedAt ?? (options.now ?? Date.now)()
  refuseAtEntry(input)
  refuseWhatIsNotBuilt(input)
  // Made before T1, so a card or reader order is never left pending with no way to reach Stripe: a
  // missing key fails here, with nothing written.
  const method = input.payment?.method
  const needsStripe = method === 'card' || method === 'reader'
  const stripe = needsStripe ? options.stripe?.() : undefined
  if (needsStripe && !stripe) throw new Error(`A ${method} order needs a Stripe client.`)
  const placed = await inTransaction(db, (tx) => prepare(tx, input, options, { dryRun: false, keyLivemode: stripe?.keyLivemode ?? null }))
  if (placed.reader) {
    if (!stripe) throw new Error('A reader order needs a Stripe client.')
    return startReaderPayment(db, stripe, { ...placed, reader: placed.reader }, options, startedAt)
  }
  if (!placed.charge) return placed.output
  if (!stripe) throw new Error('A card order needs a Stripe client.')
  return collectAndFinish(db, stripe, { ...placed, charge: placed.charge }, options, startedAt)
}

/** Thrown to end the dry run's transaction with a rollback, carrying what it found. */
class DryRunFinished extends Error {
  constructor(readonly result: OrderDryRunOutput) {
    super('Dry run finished: rolled back.')
  }
}

/**
 * The real T1 on the real database, read back, then rolled back. Nothing is kept and nothing reaches
 * Stripe. A card order (W10) runs T1 only: its rows are read back as T1 leaves them (pending, with
 * its snapshot, its event booking pending, its address not yet saved), and `order` is what the order
 * answers once the card is charged. A reader order (W11) likewise: its rows as T1 leaves them, which is
 * how createOrder's reader branch left the old order, and `order` answers `pending_reader` with no
 * intent (none is made). A missing card or reader figure is taken as confirmed (refuseIfNeeded).
 */
export async function dryRunOrder(db: Db, input: PlaceOrderInput, options: PlaceOrderOptions): Promise<OrderDryRunOutput> {
  refuseAtEntry(input)
  refuseWhatIsNotBuilt(input)
  try {
    await inTransaction(db, async (tx) => {
      const placed = await prepare(tx, input, options, { dryRun: true, keyLivemode: null })
      const rows: OrderRows = await readOrderRows(tx, placed.orderId)
      throw new DryRunFinished({ order: placed.output, rows })
    })
  } catch (err) {
    if (err instanceof DryRunFinished) return err.result
    throw err
  }
  throw new Error('The dry run finished without rolling back.')
}
