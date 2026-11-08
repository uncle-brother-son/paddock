// Ported from backend/paddock/createOrder.ts: the order in one transaction, T1 (W03-plan 2.1). W06
// builds what needs no Stripe step and no promo, store credit, gift card, product, postage, pass, event
// or membership: bookings (public and private, with guests, on a membership or pass credit or paid),
// add-ons on a booking (paid or on an add-on credit) and on their own, paid in cash or with nothing owed.
import 'server-only'
import type {
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
import { cashDifferenceRefusal } from './amounts'
import { GIFT_CARD_SOURCE_REMOVED_MESSAGE } from './basket-booking'
import { loadBasketFacts, type BasketFacts } from './load-basket'
import { lockForOrder, type HeldLocks } from './locks'
import { bookingRefusal, orderRefusal, refusalDetails } from './order-refusal'
import { readOrderRows } from './order-rows'
import { priceFromFacts } from './price-basket'
import { writeBooking, type BookingToWrite, type PayBy } from './write-booking'

/**
 * placeOrder runs T1: entry checks that need no database, then one transaction that locks, reads,
 * prices with priceFromFacts (the quote's own sums, so the quote and the order can't differ), checks
 * what staff confirmed, writes and records. With no Stripe step it finishes inside T1, so it is all
 * or nothing. Every refusal is thrown, so the transaction rolls back: a `return` inside it would
 * commit. A refusal Postgres itself raises (an overlapping booking, a second booking that day)
 * kills the transaction, so it is turned into its reason after the rollback.
 *
 * dryRunOrder is the same T1, read back and rolled back: nothing is kept (W03-plan 3.1 layer 4).
 */

export interface PlaceOrderOptions {
  /** Who is placing it, for the audit rows. */
  actor: { type: 'staff' | 'customer'; id: string }
  requestId: string
  /** Whether a line's sent price counts: only with Manage pricing (W03-plan 2.9). */
  allowPriceOverrides?: boolean
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

/** What W06 can't sell yet, each with the slice that builds it. Postage only comes with a product or a shipped gift card. */
const NOT_BUILT: ReadonlyArray<{ part: string; words: string; present: (input: PlaceOrderInput) => boolean }> = [
  { part: 'card', words: 'a card payment', present: (input) => input.payment?.method === 'card' },
  { part: 'reader', words: 'a card reader payment', present: (input) => input.payment?.method === 'reader' },
  {
    part: 'membership',
    words: 'a membership',
    present: (input) =>
      Boolean(input.membershipPlanId) || input.booking?.redemptionSource === 'buy_new_membership' || Boolean(input.booking?.cancelExhaustedMembershipId),
  },
  {
    part: 'session_pass',
    words: 'a session pass bought',
    present: (input) => Boolean(input.sessionPassTypeId) || input.booking?.redemptionSource === 'buy_new_session_pass',
  },
  { part: 'products', words: 'products', present: (input) => (input.products ?? []).length > 0 },
  { part: 'gift_card_purchase', words: 'a gift card bought', present: (input) => Boolean(input.giftCard) },
  { part: 'event', words: 'an event', present: (input) => Boolean(input.event) },
  { part: 'promo_code', words: 'a promo code', present: (input) => Boolean(input.promoCode?.trim()) },
  { part: 'store_credit', words: 'store credit', present: (input) => Boolean(input.payment?.storeCredit) },
  { part: 'gift_card_redemption', words: 'a gift card used to pay', present: (input) => Boolean(input.payment?.giftCard) },
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

/** The first problem, as createOrder met them: everything else, then the cash figure, then the amount checks. */
function refuseIfNeeded(input: PlaceOrderInput, quote: BasketQuoteOutput): void {
  const [first] = quote.problems
  if (first && !AMOUNT_REASONS.has(first.reason)) throw orderRefusal(first)
  const cash = cashDifferenceRefusal(input.payment?.method, quote.totals.toCollect.cash, input.confirmed?.toCollect)
  if (cash) {
    throw orderRefusal({ stage: 'payment', reason: cash.reason, message: cash.message, amountDueTotal: quote.totals.amountDue })
  }
  if (first) throw orderRefusal(first)
}

const unpriced = (problem: string) => new Error(`The order was priced without ${problem}. Nothing was kept.`)

function bookingToWrite(input: PlaceOrderInput, facts: BasketFacts, quote: BasketQuoteOutput, locks: HeldLocks): BookingToWrite | null {
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

  return {
    sessionId: booking.sessionId,
    customerId: input.customerId as string,
    bookingType: session.booking_type,
    pricePaid: quoted.price,
    redemptionSource: quoted.redemptionSource,
    redeemedMembershipId: quoted.redemptionSource === 'membership_credit' ? booking.membershipId ?? null : null,
    redeemedSessionPassId: booking.redemptionSource === 'session_pass_credit' ? booking.sessionPassId ?? null : null,
    creditPeriodId,
    passToClaim: seat1 === 'session_pass_credit' ? booking.sessionPassId ?? null : null,
    bandId: session.band_id,
    specialRequests: quoted.specialRequests,
    seats: booking.guests.map((guest, i) => ({
      guestType: i === 0 ? 'account_holder' : 'additional_guest',
      name: (guest.name ?? '').trim(),
      email: guest.email?.trim() || null,
      dateOfBirth: i === 0 ? guest.dateOfBirth ?? null : null,
      unitPrice: isPublic ? seatPrices[i]?.unit_price ?? null : null,
      payBy: i === 0 ? seat1 : 'paid',
    })),
  }
}

/**
 * The order, its lines, the booking's add-ons and their credits, in one statement. The memberships
 * are locked already, so the credit claims can go in any order inside it. Lines and add-ons get
 * created_at from the clock, a millisecond apart, in the order createOrder wrote them.
 */
const ORDER_SQL = `
WITH clock AS (SELECT clock_timestamp() AS at),
credits AS (
  UPDATE customer_memberships m
  SET addon_credits_remaining = m.addon_credits_remaining - x.quantity, updated_at = now()
  FROM jsonb_to_recordset($1::jsonb) AS x(membership_id uuid, quantity int)
  WHERE m.id = x.membership_id AND m.addon_credits_remaining >= x.quantity AND m.is_herd = true
  RETURNING m.id
),
o AS (
  INSERT INTO orders (customer_id, order_total, payment_status, order_source, shipping_address, promo_code, discount_amount, payment_method)
  VALUES ($2::uuid, $3::numeric, 'paid', 'staff_created', NULL, NULL, 0, $4::text)
  RETURNING id
),
lines AS (
  INSERT INTO order_line_items
    (order_id, item_type, quantity, unit_price, line_total, booking_id, addon_id, system_unit_price, price_override_reason, discount_amount, created_at)
  SELECT o.id, l.item_type, l.quantity, l.unit_price, l.line_total, l.booking_id, l.addon_id, l.system_unit_price,
         l.price_override_reason, l.discount_amount, clock.at + l.position * interval '1 millisecond'
  FROM o
  CROSS JOIN clock
  CROSS JOIN jsonb_to_recordset($5::jsonb)
    AS l(position int, item_type text, quantity int, unit_price numeric, line_total numeric, booking_id uuid, addon_id uuid,
         system_unit_price numeric, price_override_reason text, discount_amount numeric)
  RETURNING id
),
booking_addons AS (
  INSERT INTO addon_order_lines
    (booking_id, addon_id, quantity, price_at_purchase, sku_at_purchase, redemption_source, redeemed_membership_id, order_id, created_at)
  SELECT a.booking_id, a.addon_id, a.quantity, a.price_at_purchase, COALESCE(ad.sku, ad.id::text), a.redemption_source,
         a.redeemed_membership_id, o.id, clock.at + a.position * interval '1 millisecond'
  FROM o
  CROSS JOIN clock
  CROSS JOIN jsonb_to_recordset($6::jsonb)
    AS a(position int, booking_id uuid, addon_id uuid, quantity int, price_at_purchase numeric, redemption_source text, redeemed_membership_id uuid)
  JOIN addons ad ON ad.id = a.addon_id
  RETURNING id
)
SELECT (SELECT id FROM o) AS order_id,
       (SELECT count(*)::int FROM credits) AS credits_claimed,
       (SELECT count(*)::int FROM lines) AS lines_written,
       (SELECT count(*)::int FROM booking_addons) AS addons_written`

interface OrderWritten {
  order_id: string
  credits_claimed: number
  lines_written: number
  addons_written: number
}

interface Placed {
  output: PlaceOrderOutput
  orderId: string
}

async function prepare(tx: Tx, input: PlaceOrderInput, options: PlaceOrderOptions): Promise<Placed> {
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
  })
  if (!locks) throw orderRefusal({ stage: 'validation', reason: 'customer_not_found' })

  // 2. Everything the price depends on, in one read, and the quote's own sums.
  const facts = await loadBasketFacts(tx, quoteInput)
  const quote = priceFromFacts(quoteInput, facts, { allowPriceOverrides: options.allowPriceOverrides === true })
  refuseIfNeeded(input, quote)

  // 3. The booking.
  const bookingWrite = bookingToWrite(input, facts, quote, locks)
  const bookingId = bookingWrite ? await writeBooking(tx, bookingWrite) : null

  // 4. The order, its lines, the booking's add-ons and their credits.
  const method = input.payment?.method
  const collected = quote.totals.toCollect.cash
  const paymentMethod = collected > 0 && method === 'cash' ? 'cash' : null
  const lines = quote.lines.map((line, i) => {
    if (line.kind !== 'booking' && line.kind !== 'addon') throw unpriced(`a ${line.kind} line, which W06 doesn't write`)
    return {
      position: i + 1,
      item_type: line.kind,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      line_total: line.lineTotal,
      booking_id: line.kind === 'booking' ? bookingId : null,
      addon_id: line.kind === 'addon' ? line.itemId : null,
      system_unit_price: line.systemUnitPrice,
      price_override_reason: line.priceOverrideReason,
      discount_amount: line.discount,
    }
  })
  const bookingAddons = (quote.booking?.addons ?? []).map((addon, i) => ({
    position: i + 1,
    booking_id: bookingId,
    addon_id: addon.addonId,
    quantity: addon.quantity,
    price_at_purchase: addon.unitPrice,
    redemption_source: addon.redemptionSource,
    redeemed_membership_id: addon.redemptionSource === 'membership_credit' ? addon.membershipId : null,
  }))
  const creditsByMembership = new Map<string, number>()
  for (const addon of quote.booking?.addons ?? []) {
    if (addon.redemptionSource !== 'membership_credit') continue
    if (!addon.membershipId) throw unpriced('the membership an add-on credit comes from')
    creditsByMembership.set(addon.membershipId, (creditsByMembership.get(addon.membershipId) ?? 0) + addon.quantity)
  }
  const credits = [...creditsByMembership].map(([membership_id, quantity]) => ({ membership_id, quantity }))

  const written = (
    await tx.query<OrderWritten>(ORDER_SQL, [credits, customerId, quote.totals.orderTotal, paymentMethod, lines, bookingAddons])
  )[0] as OrderWritten
  if (written.credits_claimed !== credits.length) throw bookingRefusal('insufficient_addon_membership_credit')
  if (written.lines_written !== lines.length || written.addons_written !== bookingAddons.length) {
    throw new Error(`The order was not written whole: ${written.lines_written} of ${lines.length} lines, ${written.addons_written} of ${bookingAddons.length} add-ons.`)
  }
  const orderId = written.order_id

  // 5. The audit rows, in the same transaction. Nothing is owed to Stripe, so the order is paid now.
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
        orderTotal: quote.totals.orderTotal,
        amountDue: quote.totals.amountDue,
        toCollect: collected,
        confirmed: confirmed ?? null,
        overrides,
      },
    },
    { ...actor, action: 'order.paid', details: { method: paymentMethod, collected } },
  ])

  return { orderId, output: { orderId, status: 'paid', bookingId, payment: { method: paymentMethod, collected, cardCharged: false } } }
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

export async function placeOrder(db: Db, input: PlaceOrderInput, options: PlaceOrderOptions): Promise<PlaceOrderOutput> {
  refuseAtEntry(input)
  refuseWhatIsNotBuilt(input)
  const placed = await inTransaction(db, (tx) => prepare(tx, input, options))
  return placed.output
}

/** Thrown to end the dry run's transaction with a rollback, carrying what it found. */
class DryRunFinished extends Error {
  constructor(readonly result: OrderDryRunOutput) {
    super('Dry run finished: rolled back.')
  }
}

/** The real T1 on the real database, read back, then rolled back. Nothing is kept and nothing reaches Stripe. */
export async function dryRunOrder(db: Db, input: PlaceOrderInput, options: PlaceOrderOptions): Promise<OrderDryRunOutput> {
  refuseAtEntry(input)
  refuseWhatIsNotBuilt(input)
  try {
    await inTransaction(db, async (tx) => {
      const placed = await prepare(tx, input, options)
      const rows: OrderRows = await readOrderRows(tx, placed.orderId)
      throw new DryRunFinished({ order: placed.output, rows })
    })
  } catch (err) {
    if (err instanceof DryRunFinished) return err.result
    throw err
  }
  throw new Error('The dry run finished without rolling back.')
}
