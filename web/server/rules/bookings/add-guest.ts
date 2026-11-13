// New in W20 (D-plan 1.3, 4.2, 4.7, 4.8): addBookingGuest on the Worker. A guest, add-ons, or both, added to a booking
// and paid for in one go.
//
// The prices, in the old function's order: add-ons as New Order prices them (member, else sale, else base; a sent price
// counts only with Manage pricing, and then a different price needs a reason); the guest's seat: on a private booking
// the tier for the new headcount less what the group has already covered (price paid less money owed, plus the booking
// line's promo share and the part refunds: Q25, Q27), never below £0; on a public booking the band's seat price, always
// paid, never a credit. The dialog's first call sends no payment: when anything is due the answer is those figures
// (`priceImpact`) and nothing is added; the second call sends the payment and the figures staff saw (Q18).
//
// C1 is one transaction with no Stripe call: the booking locked in LOCK_ORDER with its customer, its session, the
// memberships whose add-on credits are drawn and the gift card; the checks; the place (+1, public only), the add-on
// credits, the store credit and the gift card claimed (bug 9: every claim before any Stripe call; the gift card with
// New Order's guarded UPDATE, which stamps redeemed_at when it is used up: W09 review O1); the guest, the booking and
// the add-on lines written. Then either:
// - no card money: the change's own paid order (as today, Q36 kept: the guest's seat on its booking line, the add-on
//   lines and the gift card and store credit parts pointing at it), `booking.guest_add`, commit;
// - card money: the flow record (W17's writeFlowRecord), `booking.guest_add`, commit. The saved card is then charged
//   once under `<pendingId>:charge` (W19's settleCardFlow, with its one-hour bound) and W12's C2 writes the card's order,
//   the seat on its booking line and the add-ons on their own lines of the same order (W05c N5); or the reader's intent
//   is made under `<pendingId>:reader-intent` and the screen collects it (W12-7). A definite refusal undoes the flow in
//   one transaction; no clear answer holds it (Q35), and reconcile finishes or undoes it.
// The party size is part of the locked booking, so two guests added at once queue, and the second is priced at the new
// headcount (the old statement's party-size guard).
import 'server-only'
import type { AddBookingGuestInput, AddBookingGuestOutput, AddedGuest, AddGuestPriceImpact, ApiErrorCode, BookingAddonLine } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import type { StripeClient } from '@/server/stripe/client'
import { stripeTiming } from '@/server/stripe/deadline'
import { amountChangedRefusal, cashDifferenceRefusal, exceedsAmount } from '@/server/rules/orders/amounts'
import { COLLECT_DEADLINE_MS } from '@/server/rules/orders/collect-saved-card'
import { FAILURE_MESSAGES as ORDER_WORDS, NO_SAVED_CARD_MESSAGE } from '@/server/rules/orders/failure-messages'
import { GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE, MAX_GUESTS_PER_PRIVATE_BOOKING, MAX_GUESTS_PER_PUBLIC_BOOKING } from '@/server/rules/orders/guest-validation'
import { FLOW_INTENT_UNCONFIRMED_MESSAGE, readFlow, undoFlowInTransaction } from '@/server/rules/orders/reader-flow'
import { bookingPathOff } from './booking-switch'
import {
  ADD_GUEST_NOT_SAVED_MESSAGE,
  ADD_GUEST_NOT_UNDONE_MESSAGE,
  ADD_GUEST_WORDS,
  addGuestReaderNotStartedMessage,
  addGuestReaderNotStartedNotUndoneMessage,
  AMOUNT_CHANGED_MESSAGE,
  MOVE_WORDS,
  staffSees,
} from './failure-messages'
import { createFlowReaderIntent, recordFlowIntent, settleCardFlow, writeFlowRecord, type CardFlowSnapshot, type ReaderFlowSnapshot } from './flow'
import { loadBooking, lockAndLoadBooking, paymentOpen, type LoadedBooking } from './load-booking'
import { claimGiftCard, claimStoreCredit, inC1, partAmount, paymentOpenRefusal } from './money-in'

export interface AddGuestOptions {
  actor: { type: 'staff'; id: string }
  requestId: string
  /** The signed-in staff member's Manage pricing switch: a sent add-on price counts only with it (as New Order). */
  canManagePricing: boolean
  /** ORDER_SWITCH as the route read it. A call that adds with no payment (nothing due) is gated after the quote. */
  switchValue: string | undefined
  /** The request's start: the press's Stripe calls end by a deadline from it (as an order's). */
  startedAt?: number
  now?: () => number
  /** The Stripe client, made before C1 for a card or reader payment, so a missing key fails with nothing written. */
  stripe?: () => StripeClient
}

type Extras = { priceImpact?: AddGuestPriceImpact; pendingId?: string; field?: string; logDetail?: string; guestIndex?: number }

/**
 * A refusal: the old reason and the words staff see (the old function's, else the dialog's for a guest or for add-ons
 * alone), as details, with the figures when the old function sent them, so the dialog moves to them.
 */
export function addGuestRefusal(addingGuest: boolean) {
  return (code: ApiErrorCode, reason: string, message: string | undefined, extras: Extras = {}): ApiError => {
    const words = staffSees(addingGuest ? 'add_guest' : 'add_addons', reason, message)
    return new ApiError(code, words, {
      ...(extras.field ? { field: extras.field } : {}),
      ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
      details: {
        reason,
        message: words,
        action: 'add_guest',
        ...(extras.priceImpact ? { priceImpact: extras.priceImpact } : {}),
        ...(extras.pendingId !== undefined ? { pendingId: extras.pendingId } : {}),
        ...(extras.guestIndex !== undefined ? { guestIndex: extras.guestIndex } : {}),
        ...(message ? {} : { screenWords: true }),
      },
    })
  }
}

/** The old function's description of the change: the order's and the flow's, and (lower case) the store credit note's. */
export function addGuestDescription(bookingId: string, addingGuest: boolean, withAddons: boolean): string {
  if (!addingGuest) return `Add-ons added to booking ${bookingId}`
  return withAddons ? `Guest and add-ons added to booking ${bookingId}` : `Additional guest added to booking ${bookingId}`
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))
/** Pennies are the smallest amount, so anything above half a penny is a real difference (shared/cashConfirmation). */
const NOTHING_LEFT = 0.005

interface PricedAddon {
  addonId: string
  quantity: number
  unitPrice: number
  sku: string
  redemptionSource: 'paid' | 'membership_credit'
  membershipId: string | null
}

/** A flow C1 committed: its record, and the answer the press gives once the card or reader has been dealt with. */
interface FlowStarted {
  pendingId: string
  remainder: number
  addingGuest: boolean
  guest: AddedGuest | null
  addonLineIds: string[]
}

type Started = { kind: 'answer'; output: AddBookingGuestOutput } | ({ kind: 'card' | 'reader' } & FlowStarted)

/**
 * The add-ons, priced and checked as the old function did, in its order (each line: the quantity, the add-on, on
 * sale, a sent price with Manage pricing, a credit's membership), then every credit's membership the customer's and
 * active. As New Order: the member price for a customer with an active membership, else the sale price, else the base.
 */
async function priceAddons(
  tx: Queryable,
  customerId: string,
  inputs: readonly BookingAddonLine[],
  canManagePricing: boolean,
  refuse: ReturnType<typeof addGuestRefusal>
): Promise<PricedAddon[]> {
  if (inputs.length === 0) return []
  const catalog = new Map(
    (
      await tx.query<{ id: string; sku: string | null; active: boolean | null; member_price: string | null; sale_price: string | null; base_price: string | null }>(
        'SELECT id, sku, active, member_price::text AS member_price, sale_price::text AS sale_price, base_price::text AS base_price FROM addons WHERE id = ANY($1::uuid[])',
        [[...new Set(inputs.map((line) => line.addonId))]]
      )
    ).map((row) => [row.id, row])
  )
  const member =
    (
      await tx.query<{ member: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM customer_memberships
           WHERE customer_id = $1::uuid AND subscription_status = 'active'
             AND (cancel_effective_date IS NULL OR cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
         ) AS member`,
        [customerId]
      )
    )[0]?.member === true
  const priced: PricedAddon[] = []
  for (const input of inputs) {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) throw refuse('VALIDATION', 'invalid_addon_quantity', undefined)
    const addon = catalog.get(input.addonId)
    if (!addon) throw refuse('VALIDATION', 'addon_not_found', undefined)
    if (addon.active === false) throw refuse('VALIDATION', 'addon_inactive', undefined)
    const candidates = [member ? addon.member_price : null, addon.sale_price, addon.base_price]
    const set = candidates.find((price) => price !== null && price !== undefined)
    const system = set === undefined || set === null ? 0 : Number.parseFloat(set)
    let unitPrice = system
    if (canManagePricing && typeof input.unitPrice === 'number' && Number.isFinite(input.unitPrice)) {
      if (input.unitPrice < 0) throw refuse('VALIDATION', 'invalid_addon_price', undefined)
      if (Math.round(input.unitPrice * 100) !== Math.round(system * 100) && !(input.priceOverrideReason ?? '').trim()) {
        throw refuse('VALIDATION', 'price_override_reason_required', ADD_GUEST_WORDS.overrideReasonRequired)
      }
      unitPrice = input.unitPrice
    }
    const redemptionSource = input.redemptionSource === 'membership_credit' ? 'membership_credit' : 'paid'
    if (redemptionSource === 'membership_credit' && !input.membershipId) throw refuse('VALIDATION', 'addon_membership_id_required', undefined)
    priced.push({
      addonId: addon.id,
      quantity: input.quantity,
      unitPrice,
      sku: addon.sku ?? addon.id,
      redemptionSource,
      membershipId: redemptionSource === 'membership_credit' ? (input.membershipId ?? null) : null,
    })
  }
  const creditMemberships = [...new Set(priced.flatMap((line) => (line.membershipId ? [line.membershipId] : [])))]
  if (creditMemberships.length > 0) {
    const owned = await tx.query<{ id: string }>(
      `SELECT id FROM customer_memberships
       WHERE id = ANY($1::uuid[]) AND customer_id = $2::uuid AND subscription_status = 'active'
         AND (cancel_effective_date IS NULL OR cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)`,
      [creditMemberships, customerId]
    )
    if (owned.length !== creditMemberships.length) throw refuse('CONFLICT', 'addon_membership_not_found', undefined)
  }
  return priced
}

/** The new seat's price facts, read under the booking's lock, with the headcount the guest makes. */
interface SeatFacts {
  session_started: boolean
  booking_type: string
  /** Public: the last seat of quote_booking at the new headcount. */
  seat_quote: { unit_price: string | number | null } | null
  /** Private: the tier for the new headcount at the booking's band (null when none; its price null when unset). */
  tier_row: { price: string | number | null } | null
  /** Private: the promo taken off the booking, over its booking lines (0 for public). */
  promo_share: string
}

const SEAT_FACTS_SQL = `
SELECT (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS session_started,
       st.booking_type,
       -- Only for a session still to start: quote_booking can raise for one in the past, which is refused just after.
       CASE WHEN st.booking_type = 'public' AND (s.start_time AT TIME ZONE 'UTC') > (now() AT TIME ZONE 'Europe/London') THEN (
         SELECT to_jsonb(q) FROM quote_booking(b.session_id, b.customer_id, $2::int) q ORDER BY q.seat_no DESC LIMIT 1
       ) ELSE NULL END AS seat_quote,
       CASE WHEN st.booking_type = 'private' THEN (
         SELECT to_jsonb(t) FROM service_type_price_tiers t
         WHERE t.service_type_id = st.id AND t.band_id = b.band_id AND t.min_people <= $2::int AND t.max_people >= $2::int
         LIMIT 1
       ) ELSE NULL END AS tier_row,
       (CASE WHEN st.booking_type = 'private' THEN (
         SELECT COALESCE(SUM(oli.discount_amount), 0) FROM order_line_items oli WHERE oli.booking_id = b.id AND oli.item_type = 'booking'
       ) ELSE 0 END)::text AS promo_share
FROM bookings b
JOIN sessions s ON s.id = b.session_id
JOIN service_types st ON st.id = s.service_type_id
WHERE b.id = $1::uuid`

const money = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The order the payment is recorded on when no card money is due, as the old function chose its method: gift card
 * with something else 'split', gift card alone 'gift_card', cash 'cash', otherwise (store credit alone) none.
 */
function ownOrderMethod(giftCard: number, rest: number, method: string | undefined): string | null {
  if (giftCard > 0 && rest > NOTHING_LEFT) return 'split'
  if (giftCard > 0) return 'gift_card'
  if (rest > NOTHING_LEFT && method === 'cash') return 'cash'
  return null
}

/** What the change costs, worked out from the booking as C1 has it locked (or as the replay reads it). */
type Priced =
  | { kind: 'limit' }
  | {
      kind: 'priced'
      addons: PricedAddon[]
      isPublic: boolean
      guestAmount: number
      addonsAmount: number
      amountDue: number
      priceImpact: AddGuestPriceImpact
    }

/**
 * The checks and prices, in the old function's order: the booking's state (cancelled, a payment open on it, the
 * session started, the guest limit), then the add-ons, then the guest's seat. Reads only; every refusal throws.
 */
async function priceTheChange(
  db: Queryable,
  booking: LoadedBooking,
  input: AddBookingGuestInput,
  canManagePricing: boolean,
  refuse: ReturnType<typeof addGuestRefusal>
): Promise<Priced> {
  const addingGuest = typeof input.guestName === 'string' && input.guestName.trim() !== ''
  if (booking.status === 'cancelled') throw refuse('CONFLICT', 'booking_cancelled', undefined)
  // Any payment open on it: a first guest's price is already in price_paid, so a second would be priced on money
  // not collected (the old function's reason), and an undo would take the wrong guest's figures back.
  if (paymentOpen(booking)) throw paymentOpenRefusal(booking, refuse)
  const currentCount = booking.seats.length
  const seat = (await db.query<SeatFacts>(SEAT_FACTS_SQL, [booking.id, currentCount + 1]))[0]
  if (!seat) throw refuse('NOT_FOUND', 'booking_not_found', undefined)
  if (seat.session_started) throw refuse('CONFLICT', 'session_already_started', undefined)
  const isPublic = seat.booking_type === 'public'
  const maxGuests = isPublic ? MAX_GUESTS_PER_PUBLIC_BOOKING : MAX_GUESTS_PER_PRIVATE_BOOKING
  if (addingGuest && currentCount >= maxGuests) return { kind: 'limit' }

  const addons = await priceAddons(db, booking.customerId, input.addons ?? [], canManagePricing, refuse)
  const addonsAmount = round2(addons.reduce((sum, line) => (line.redemptionSource === 'paid' ? sum + line.unitPrice * line.quantity : sum), 0))

  // The guest's seat.
  let guestAmount = 0
  if (!addingGuest) {
    // Add-ons on their own: no seat to price.
  } else if (!isPublic) {
    if (!seat.tier_row) throw refuse('CONFLICT', 'private_price_not_set', MOVE_WORDS.privatePriceNotSet)
    const tierPrice = money(seat.tier_row.price)
    if (tierPrice === null) throw refuse('CONFLICT', 'price_pending', undefined)
    // price_paid is net of any promo (Q24) and of any part refund, so both go back on before comparing, or they would
    // be asked for again as a tier difference (Q25, Q27). Money owed is still the customer's, so it covers nothing.
    const covered = booking.pricePaid - booking.refundOwed + Number.parseFloat(seat.promo_share) + booking.partRefunded
    guestAmount = Math.max(0, round2(tierPrice - covered))
  } else {
    // Guests are always paid on a public booking: the band's seat price, never a credit.
    if (input.useExistingCredit) throw refuse('CONFLICT', 'credit_not_available_for_guests', undefined)
    const seatPrice = money(seat.seat_quote?.unit_price)
    if (seatPrice === null) throw refuse('CONFLICT', 'price_pending', undefined)
    guestAmount = seatPrice
  }
  if (input.useExistingCredit) throw refuse('CONFLICT', 'credit_not_available_for_guests', undefined)

  // The guest's seat goes on price_paid; the paid add-ons are charged with it but kept on their own lines.
  const amountDue = round2(guestAmount + addonsAmount)
  return { kind: 'priced', addons, isPublic, guestAmount, addonsAmount, amountDue, priceImpact: { amountDue, guestAmount, addonsAmount, creditAvailable: false } }
}

/**
 * The figures the dialog's first call shows (its quote), read without locking or writing anything: null when the
 * change would be refused or the guest limit is reached. The replay sends them back as the confirmed figures, as the
 * dialog does (Q18).
 */
export async function quoteAddGuest(db: Queryable, bookingId: string, input: AddBookingGuestInput, canManagePricing: boolean): Promise<AddGuestPriceImpact | null> {
  const booking = await loadBooking(db, bookingId)
  if (!booking) return null
  try {
    const priced = await priceTheChange(db, booking, input, canManagePricing, addGuestRefusal(typeof input.guestName === 'string' && input.guestName.trim() !== ''))
    return priced.kind === 'priced' ? priced.priceImpact : null
  } catch (err) {
    if (err instanceof ApiError) return null
    throw err
  }
}

/**
 * C1, inside its transaction. Every refusal throws, so nothing it did is kept. A quote, the guest limit and a change
 * with no card money answer from here; a card or reader one commits its flow record and goes on outside.
 */
async function c1(tx: Tx, bookingId: string, input: AddBookingGuestInput, options: AddGuestOptions, keyLivemode: boolean | null): Promise<Started> {
  const guestName = typeof input.guestName === 'string' ? input.guestName.trim() : ''
  const addonInputs = input.addons ?? []
  const addingGuest = guestName !== ''
  const refuse = addGuestRefusal(addingGuest)
  const payment = input.payment
  const giftCardId = payment?.giftCard?.giftCardId ?? null
  const creditMembershipIds = addonInputs.flatMap((line) => (line.redemptionSource === 'membership_credit' && line.membershipId ? [line.membershipId] : []))

  const loaded = await lockAndLoadBooking(tx, { bookingId, ownSession: true, membershipIds: creditMembershipIds, giftCardId })
  if (!loaded) throw refuse('NOT_FOUND', 'booking_not_found', undefined)
  const { booking } = loaded
  const priced = await priceTheChange(tx, booking, input, options.canManagePricing, refuse)
  if (priced.kind === 'limit') return { kind: 'answer', output: { added: false, limitReached: true, guest: null } }
  const { addons, isPublic, guestAmount, addonsAmount, amountDue, priceImpact } = priced
  // The quote: money is due and no payment was sent. Nothing is added.
  if (amountDue > 0 && payment === undefined) return { kind: 'answer', output: { added: false, priceImpact } }
  // A change with nothing due still changes the booking: the switch's money gate applies (cash, gift card, store credit
  // and nothing to pay all need `booking_changes`). The route gated card and reader payments before C1.
  if (payment === undefined) {
    const off = bookingPathOff('cash', options.switchValue)
    if (off) throw off
  }

  // The money, in the old function's order: the cash figure first, the parts over the amount, a method, the reader
  // with nothing to take; then what the old function didn't check: an unknown method, and the figures staff saw (Q18).
  const withFigures = { priceImpact }
  const giftCardAmount = partAmount(payment?.giftCard?.amount, 'gift_card_amount_invalid', refuse, withFigures)
  const storeCreditAmount = partAmount(payment?.storeCredit?.amount, 'store_credit_amount_invalid', refuse, withFigures)
  const method = payment?.method
  const remainder = Math.max(0, round2(amountDue - giftCardAmount - storeCreditAmount))
  if (payment) {
    const confirmed = { ...input.figures, toCollect: input.figures?.toCollect ?? payment.confirmedCashAmount }
    const cash = cashDifferenceRefusal(method, remainder, confirmed.toCollect)
    if (cash) throw refuse('CONFLICT', cash.reason, cash.message, withFigures)
    if (exceedsAmount(giftCardAmount, amountDue)) throw refuse('CONFLICT', 'gift_card_amount_exceeds_total', undefined, withFigures)
    if (exceedsAmount(giftCardAmount + storeCreditAmount, amountDue)) throw refuse('CONFLICT', 'store_credit_amount_exceeds_total', undefined, withFigures)
    if (remainder > NOTHING_LEFT && !method) throw refuse('CONFLICT', 'payment_method_required', undefined, withFigures)
    // The screen sends the reader only with something left to take, so the amount has changed.
    if (method === 'reader' && remainder <= NOTHING_LEFT) throw refuse('CONFLICT', 'payment_method_required', AMOUNT_CHANGED_MESSAGE, withFigures)
    if (remainder > NOTHING_LEFT && method !== 'card' && method !== 'reader' && method !== 'cash') {
      throw refuse('VALIDATION', 'invalid_payment_method', ORDER_WORDS['invalid_payment_method'], { ...withFigures, field: 'payment.method' })
    }
    const changed = amountChangedRefusal(method, confirmed, { amountDue, toCollect: remainder })
    if (changed) throw refuse('CONFLICT', changed.reason, changed.message, withFigures)
  }

  const cardMoney = remainder > NOTHING_LEFT && (method === 'card' || method === 'reader') ? method : null
  let savedCard: { stripe_customer_id: string | null; saved_payment_method_id: string | null } | undefined
  if (cardMoney) {
    savedCard = (
      await tx.query<{ stripe_customer_id: string | null; saved_payment_method_id: string | null }>(
        'SELECT stripe_customer_id, saved_payment_method_id FROM customers WHERE id = $1::uuid',
        [booking.customerId]
      )
    )[0]
    // The legacy charge route's words for a card with nothing saved: nothing is claimed or charged.
    if (cardMoney === 'card' && (!savedCard?.stripe_customer_id || !savedCard.saved_payment_method_id)) {
      throw refuse('CONFLICT', 'no_saved_card', NO_SAVED_CARD_MESSAGE)
    }
  }

  // The claims, in the old function's order: the place (public only: a private session's places were all claimed when
  // it was booked), the add-on credits, the store credit, the gift card. All before any Stripe call (bug 9).
  const claimsPlace = addingGuest && isPublic
  if (claimsPlace) {
    const claimed = await tx.query(
      `UPDATE sessions SET total_booked = total_booked + 1, updated_at = now()
       WHERE id = $1::uuid AND status = 'open' AND (capacity - total_booked) >= 1
       RETURNING id`,
      [booking.sessionId]
    )
    if (claimed.length === 0) throw refuse('CONFLICT', 'insufficient_capacity', undefined)
  }
  const addonCredits: Array<{ membership_id: string; quantity: number }> = []
  for (const line of addons) {
    if (line.redemptionSource !== 'membership_credit' || !line.membershipId) continue
    const taken = await tx.query(
      `UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining - $1::int, updated_at = now()
       WHERE id = $2::uuid AND addon_credits_remaining >= $1::int AND is_herd = true
       RETURNING id`,
      [line.quantity, line.membershipId]
    )
    if (taken.length === 0) {
      const why = (await tx.query<{ is_herd: boolean | null }>('SELECT is_herd FROM customer_memberships WHERE id = $1::uuid', [line.membershipId]))[0]
      throw refuse('CONFLICT', why && why.is_herd !== true ? 'addon_membership_too_new' : 'insufficient_addon_membership_credit', undefined)
    }
    addonCredits.push({ membership_id: line.membershipId, quantity: line.quantity })
  }
  const description = addGuestDescription(bookingId, addingGuest, addons.length > 0)
  const storeCreditTransactionId =
    storeCreditAmount > 0
      ? await claimStoreCredit(
          tx,
          { customerId: booking.customerId, amount: storeCreditAmount, bookingId, staffId: options.actor.id, note: `Store credit redeemed: ${description.toLowerCase()}.` },
          refuse
        )
      : null
  // As the old function: a gift card is only taken when something is due.
  const giftCardPart = giftCardAmount > 0 && giftCardId && amountDue > 0 ? giftCardAmount : 0
  const stampedRedeemedAt = giftCardPart > 0 && giftCardId ? await claimGiftCard(tx, giftCardId, giftCardPart, refuse) : false

  // The guest (a private seat has no unit price: the group is priced by tier) and the booking.
  const guest = addingGuest
    ? ((
        await tx.query<{ guest: AddedGuest }>(
          `WITH g AS (
             INSERT INTO booking_guests (guest_type, guest_name, guest_email, waiver_accepted, unit_price, pay_by, booking_id, created_at)
             VALUES ('additional_guest', $1::text, $2::text, false, $3::numeric, $4::text, $5::uuid, clock_timestamp())
             RETURNING id, guest_name, guest_email, guest_type, unit_price, pay_by
           )
           SELECT to_jsonb(g) AS guest FROM g`,
          [guestName, input.guestEmail?.trim() || null, isPublic ? guestAmount : null, isPublic ? 'paid' : null, bookingId]
        )
      )[0]?.guest ?? null)
    : null
  if (addingGuest && !guest) throw new Error(`The guest on booking ${bookingId} was not written.`)
  const priceIncrement = payment ? guestAmount : 0
  // W25 (W20 review 5): whether this guest's tick is the one that stamps the booking, so a flow's undo clears it again.
  const over18ConfirmedHere =
    (
      await tx.query<{ here: boolean }>(
        `WITH was AS (SELECT guests_over_18_confirmed_at IS NULL AS unconfirmed FROM bookings WHERE id = $3::uuid)
         UPDATE bookings b
         SET price_paid = b.price_paid + $1::numeric,
             party_size = b.party_size + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
             guests_over_18_confirmed_at = CASE WHEN $2::boolean THEN COALESCE(b.guests_over_18_confirmed_at, now()) ELSE b.guests_over_18_confirmed_at END,
             updated_at = now()
         FROM was
         WHERE b.id = $3::uuid
         RETURNING ($2::boolean AND was.unconfirmed) AS here`,
        [priceIncrement, addingGuest, bookingId]
      )
    )[0]?.here === true

  // No card money: the change's own order, when anything was due, carries every part (Q36 as today).
  const ownOrder = !cardMoney && amountDue > 0
  const orderId = ownOrder
    ? ((
        await tx.query<{ id: string }>(
          `INSERT INTO orders (customer_id, order_total, payment_status, order_source, payment_method, created_at)
           VALUES ($1::uuid, $2::numeric, 'paid', 'staff_created', $3::text, clock_timestamp())
           RETURNING id`,
          [booking.customerId, amountDue, ownOrderMethod(giftCardPart, remainder, method)]
        )
      )[0]?.id ?? null)
    : null
  if (ownOrder && !orderId) throw new Error(`The order for booking ${bookingId} was not written.`)
  if (orderId && addingGuest) {
    // The guest's seat is the order's booking line; add-on money lives on the add-on lines (W05c N5).
    await tx.query(
      `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, booking_id, created_at)
       VALUES ($1::uuid, 'booking', 1, $2::numeric, $2::numeric, $3::uuid, clock_timestamp())`,
      [orderId, priceIncrement, bookingId]
    )
  }
  // The add-on lines, in the order sent, on the order that paid for them (a card or reader flow's C2 links them).
  const addonLineIds: string[] = []
  for (const line of addons) {
    const row = (
      await tx.query<{ id: string }>(
        `INSERT INTO addon_order_lines (booking_id, addon_id, quantity, price_at_purchase, sku_at_purchase, redemption_source, redeemed_membership_id, order_id)
         VALUES ($1::uuid, $2::uuid, $3::int, $4::numeric, $5::text, $6::text, $7::uuid, $8::uuid)
         RETURNING id`,
        [bookingId, line.addonId, line.quantity, line.unitPrice, line.sku, line.redemptionSource, line.membershipId, orderId]
      )
    )[0]
    if (!row) throw new Error(`An add-on line on booking ${bookingId} was not written.`)
    addonLineIds.push(row.id)
  }

  let pendingId: string | null = null
  if (cardMoney) {
    // What the flow's undo puts back (W12's undoFlowInTransaction, 'add_guest'), as the old reader snapshot held it.
    const old = {
      customer_id: booking.customerId,
      description,
      booking_id: bookingId,
      session_id: booking.sessionId,
      ...(addonCredits.length > 0 ? { addon_credits: addonCredits } : {}),
      price_increment: priceIncrement,
      claimed_extra_capacity: claimsPlace,
      ...(storeCreditAmount > 0 ? { store_credit_amount: storeCreditAmount } : {}),
      ...(giftCardPart > 0 && giftCardId ? { gift_card: { gift_card_id: giftCardId, amount: giftCardPart, stamped_redeemed_at: stampedRedeemedAt } } : {}),
      ...(guest ? { guest_row_id: guest.id } : {}),
      ...(addonLineIds.length > 0 ? { addon_line_ids: addonLineIds } : {}),
      ...(over18ConfirmedHere ? { over_18_confirmed_here: true } : {}),
    }
    const marks = { channel: 'staff' as const, request_id: options.requestId, livemode: keyLivemode === true }
    const snapshot: CardFlowSnapshot | ReaderFlowSnapshot =
      cardMoney === 'card'
        ? {
            ...old,
            ...marks,
            method: 'card',
            stripe_customer_id: savedCard?.stripe_customer_id as string,
            payment_method_id: savedCard?.saved_payment_method_id as string,
          }
        : { ...old, ...marks, method: 'reader', stripe_customer_id: savedCard?.stripe_customer_id ?? null }
    // The record last, before anything is asked of Stripe (bug 14's rule): its id is every key of the flow.
    pendingId = await writeFlowRecord(tx, { flow: 'add_guest', recordId: bookingId, expectedAmount: remainder, snapshot })
  } else {
    if (orderId && giftCardPart > 0 && giftCardId) {
      await tx.query(
        'INSERT INTO gift_card_redemptions (gift_card_id, order_id, booking_id, amount_used, redeemed_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, now())',
        [giftCardId, orderId, bookingId, giftCardPart]
      )
    }
    if (orderId && storeCreditTransactionId) {
      await tx.query('UPDATE store_credit_transactions SET order_id = $1::uuid WHERE id = $2::uuid', [orderId, storeCreditTransactionId])
    }
  }

  await audit.record(tx, {
    actorType: options.actor.type,
    actorId: options.actor.id,
    action: 'booking.guest_add',
    entityType: 'booking',
    entityId: bookingId,
    requestId: options.requestId,
    details: {
      guestId: guest?.id ?? null,
      addonLineIds,
      guestAmount,
      addonsAmount,
      amountDue,
      storeCredit: storeCreditAmount,
      giftCard: giftCardPart,
      method: remainder > NOTHING_LEFT ? (method ?? null) : null,
      toCollect: remainder,
      orderId,
      pendingId,
    },
  })

  if (cardMoney && pendingId) return { kind: cardMoney, pendingId, remainder, addingGuest, guest, addonLineIds }
  return { kind: 'answer', output: { added: true, limitReached: false, guest, addonLineIds } }
}

/** The saved card: charged once, then C2 or the undo; anything unclear held (flow.ts, settleCardFlow). */
async function chargeAndFinish(db: Db, stripe: StripeClient, started: FlowStarted, options: AddGuestOptions, startedAt: number): Promise<AddBookingGuestOutput> {
  const refuse = addGuestRefusal(started.addingGuest)
  const outcome = await settleCardFlow(db, stripe, started.pendingId, {
    actor: options.actor,
    requestId: options.requestId,
    timing: { deadline: startedAt + COLLECT_DEADLINE_MS, now: options.now ?? Date.now },
  })
  if (outcome.outcome === 'finished') return { added: true, limitReached: false, guest: started.guest, addonLineIds: started.addonLineIds }
  if (outcome.outcome === 'declined') {
    // Nothing was taken. The old function answered the charge's words as its reason; the wrapper does too.
    const reason = outcome.needsAuthentication ? 'card_needs_authentication' : 'card_declined'
    const message = outcome.undone ? outcome.message : `${outcome.message} ${ADD_GUEST_NOT_UNDONE_MESSAGE}`
    throw refuse(outcome.needsAuthentication ? 'PAYMENT_NEEDS_AUTHENTICATION' : 'PAYMENT_FAILED', reason, message, {
      pendingId: started.pendingId,
      logDetail: `${outcome.stripeCode ?? 'no code'}; undone: ${String(outcome.undone)}`,
    })
  }
  if (outcome.outcome === 'held') {
    throw refuse('PAYMENT_UNCONFIRMED', outcome.reason, outcome.message, { pendingId: started.pendingId, logDetail: outcome.detail })
  }
  throw new Error(`The card flow ${started.pendingId} wasn't open straight after C1 (${outcome.state}).`)
}

/** The reader, pending-first (W12-7): the intent under the record's key, written onto the record; the screen collects. */
async function startOnTheReader(db: Db, stripe: StripeClient, bookingId: string, started: FlowStarted, options: AddGuestOptions, startedAt: number): Promise<AddBookingGuestOutput> {
  const refuse = addGuestRefusal(started.addingGuest)
  const timing = stripeTiming(startedAt, options.now ?? Date.now)
  const row = await readFlow(db, started.pendingId)
  if (!row) throw new Error(`The reader flow ${started.pendingId} is gone straight after C1.`)
  const answer = await createFlowReaderIntent(db, stripe, row, timing)
  const held = (detail: string) => refuse('PAYMENT_UNCONFIRMED', 'payment_unconfirmed', FLOW_INTENT_UNCONFIRMED_MESSAGE, { pendingId: started.pendingId, logDetail: detail })

  if (answer.outcome === 'definite') {
    // No intent exists, so nothing can be taken: the flow's undo puts everything back, in one transaction.
    let undone = false
    try {
      const result = await undoFlowInTransaction(db, started.pendingId, { actor: options.actor, requestId: options.requestId, why: `The card reader payment couldn't be started. ${answer.detail}` })
      undone = result.undone || result.reason !== 'already_finalised'
    } catch {
      undone = false
    }
    const message = undone ? addGuestReaderNotStartedMessage(started.addingGuest, answer.message) : addGuestReaderNotStartedNotUndoneMessage(answer.message)
    throw refuse('PAYMENT_FAILED', 'guest_add_failed', message, { pendingId: started.pendingId, logDetail: answer.detail })
  }
  if (answer.outcome === 'unknown') throw held(`The reader's intent got no clear answer: ${answer.detail}`)

  const { paymentIntent, stripeCustomerId } = answer
  const clientSecret = paymentIntent.client_secret
  let recorded: boolean
  try {
    recorded = Boolean(clientSecret) && (await recordFlowIntent(db, started.pendingId, paymentIntent, stripeCustomerId))
  } catch (err) {
    throw held(`${paymentIntent.id} could not be written onto the record: ${explain(err)}`)
  }
  if (!recorded || !clientSecret) throw held(`${paymentIntent.id} was not written onto the record (no secret, or the record changed)`)
  return {
    added: true,
    guest: started.guest,
    addonLineIds: started.addonLineIds,
    pendingReaderPayment: { flow: 'add_guest', recordId: bookingId, pendingId: started.pendingId, paymentIntentId: paymentIntent.id, clientSecret, amount: started.remainder },
  }
}

/**
 * addBookingGuest: the name and age checks first (as the old function, before anything is read), then C1, then the
 * card or the reader when card money is due.
 */
export async function addGuestToBooking(db: Db, bookingId: string, input: AddBookingGuestInput, options: AddGuestOptions): Promise<AddBookingGuestOutput> {
  const startedAt = options.startedAt ?? (options.now ?? Date.now)()
  const addingGuest = typeof input.guestName === 'string' && input.guestName.trim() !== ''
  const refuse = addGuestRefusal(addingGuest)
  if (!addingGuest && (input.addons ?? []).length === 0) {
    throw refuse('VALIDATION', 'guest_name_required', ADD_GUEST_WORDS.guestNameRequired, { guestIndex: 0, field: 'guestName' })
  }
  if (addingGuest && input.guestsOver18Confirmed !== true) {
    throw refuse('VALIDATION', 'guests_over_18_not_confirmed', GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE, { guestIndex: 0 })
  }
  const method = input.payment?.method
  // Made before C1, so a card or reader payment is never left held with no way to reach Stripe.
  const stripe = method === 'card' || method === 'reader' ? options.stripe?.() : undefined
  if ((method === 'card' || method === 'reader') && !stripe) throw new Error(`A ${method} add needs a Stripe client.`)
  const started = await inC1(
    db,
    (tx) => c1(tx, bookingId, input, options, stripe?.keyLivemode ?? null),
    (logDetail) => refuse('INTERNAL', 'add_guest_not_saved', ADD_GUEST_NOT_SAVED_MESSAGE, { logDetail })
  )
  if (started.kind === 'answer') return started.output
  if (!stripe) throw new Error('A card or reader add needs a Stripe client.')
  if (started.kind === 'card') return chargeAndFinish(db, stripe, started, options, startedAt)
  return startOnTheReader(db, stripe, bookingId, started, options, startedAt)
}
