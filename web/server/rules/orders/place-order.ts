// Ported from backend/paddock/createOrder.ts: the order in one transaction, T1 (W03-plan 2.1). W06
// built what needs no Stripe step: bookings (public and private, with guests, on a membership or pass
// credit or paid), add-ons on a booking (paid or on an add-on credit) and on their own, paid in cash or
// with nothing owed. W07 adds products with their stock, the delivery address and postage, session
// passes (on their own, or bought to pay for the booking in the same basket) and gift cards bought.
// Still not built: card and reader payments, memberships, events, promo codes, store credit and gift
// card redemption.
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
import { addMonthsToIsoDate } from '@/server/rules/time/london-time'
import { cashDifferenceRefusal } from './amounts'
import { GIFT_CARD_SOURCE_REMOVED_MESSAGE } from './basket-booking'
import { generateGiftCardCode } from './gift-card-code'
import { loadBasketFacts, type BasketFacts } from './load-basket'
import { lockForOrder, type HeldLocks } from './locks'
import { bookingRefusal, orderRefusal, refusalDetails } from './order-refusal'
import { readOrderRows } from './order-rows'
import { priceFromFacts } from './price-basket'
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
 * What T1 can't sell yet, each built by a later slice: card (W10), reader (W11), memberships, bought
 * or buy-new or replacing an exhausted one (W13), events (W08), promo codes, store credit and gift
 * card redemption (W09). A pass bought with a buy-new membership is caught as the membership.
 */
const NOT_BUILT: ReadonlyArray<{ part: string; words: string; present: (input: PlaceOrderInput) => boolean }> = [
  { part: 'card', words: 'a card payment', present: (input) => input.payment?.method === 'card' },
  { part: 'reader', words: 'a card reader payment', present: (input) => input.payment?.method === 'reader' },
  {
    part: 'membership',
    words: 'a membership',
    present: (input) =>
      Boolean(input.membershipPlanId) || input.booking?.redemptionSource === 'buy_new_membership' || Boolean(input.booking?.cancelExhaustedMembershipId),
  },
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
    pricePaid: quoted.price,
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
      payBy: i === 0 ? seat1 : 'paid',
    })),
  }
}

/**
 * The order and everything in it that doesn't need the booking, in one statement: the gift card
 * bought, the order (with its delivery address), its lines, the stock claimed with a ledger row per
 * product line, the session pass bought, and the delivery address saved to the customer.
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
  INSERT INTO orders (customer_id, order_total, payment_status, order_source, shipping_address, promo_code, discount_amount, payment_method)
  SELECT $1::uuid, $3::numeric, 'paid', 'staff_created', $4::jsonb, NULL, 0, $5::text
  FROM go
  WHERE go.ok
  RETURNING id
),
lines AS (
  INSERT INTO order_line_items
    (order_id, item_type, quantity, unit_price, line_total, addon_id, product_variant_id, session_pass_type_id, gift_card_id,
     fulfillment_status, system_unit_price, price_override_reason, discount_amount, created_at)
  SELECT o.id, l.item_type, l.quantity, l.unit_price, l.line_total, l.addon_id, l.product_variant_id, l.session_pass_type_id,
         CASE WHEN l.item_type = 'gift_card' THEN (SELECT id FROM card) END,
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
saved_address AS (
  UPDATE customers c
  SET address_line1 = a.line1, address_line2 = a.line2, city = a.city, postcode = a.postcode, country = a.country, updated_at = now()
  FROM jsonb_to_recordset($10::jsonb) AS a(line1 text, line2 text, city text, postcode text, country text)
  WHERE c.id = $1::uuid AND (SELECT ok FROM go)
  RETURNING c.id
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
       (SELECT count(*)::int FROM saved_address) AS addresses_saved`

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
}

/** As createOrder: five codes, then gift_card_code_exhausted. */
export const GIFT_CARD_CODE_TRIES = 5

/** The line kinds the order statement writes. A booking's line is the booking statement's. */
const ORDER_LINE_KINDS = new Set(['addon', 'product', 'session_pass', 'gift_card', 'postage'])

interface OrderToWrite {
  orderId: string
  linesAt: string
  giftCardId: string | null
  giftCardCode: string | null
  sessionPassId: string | null
}

/** The order statement, run again with a new code while the gift card's code was taken. */
async function writeOrder(tx: Tx, input: PlaceOrderInput, facts: BasketFacts, quote: BasketQuoteOutput, options: PlaceOrderOptions): Promise<OrderToWrite> {
  const customerId = input.customerId as string
  const products = input.products ?? []
  const method = input.payment?.method
  const collected = quote.totals.toCollect.cash
  const paymentMethod = collected > 0 && method === 'cash' ? 'cash' : null

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
  const addresses = delivery?.saveToCustomer ? [delivery.address] : []

  for (let attempt = 1; ; attempt += 1) {
    const cards = giftCards()
    const written = (
      await tx.query<OrderWritten>(ORDER_SQL, [customerId, cards, quote.totals.orderTotal, delivery?.address ?? null, paymentMethod, lines, claims, ledger, passes, addresses])
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
    if (written.ledger_written !== ledger.length) throw new Error(`The stock ledger was not written whole: ${written.ledger_written} of ${ledger.length} rows.`)
    if (written.passes_written !== passes.length) throw new Error(`The session pass and its line were not written together: ${written.passes_written} of ${passes.length} passes.`)
    if (cards.length > 0 && !written.gift_card_id) throw new Error('The gift card was not written.')
    if (written.addresses_saved !== addresses.length) throw new Error("The delivery address was not saved to the customer.")
    return {
      orderId: written.order_id,
      linesAt: written.lines_at,
      giftCardId: written.gift_card_id,
      giftCardCode: written.gift_card_code,
      sessionPassId: written.session_pass_id,
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
    productVariantIds: (input.products ?? []).map((line) => line.productVariantId),
  })
  if (!locks) throw orderRefusal({ stage: 'validation', reason: 'customer_not_found' })

  // 2. Everything the price depends on, in one read, and the quote's own sums.
  const facts = await loadBasketFacts(tx, quoteInput)
  const quote = priceFromFacts(quoteInput, facts, { allowPriceOverrides: options.allowPriceOverrides === true })
  refuseIfNeeded(input, quote)

  // 3. The order, and everything in it that doesn't need the booking.
  const order = await writeOrder(tx, input, facts, quote, options)

  // 4. The booking, with its line, its add-ons and their credits.
  const bookingWrite = bookingToWrite(input, facts, quote, locks, order.sessionPassId)
  const bookingId = bookingWrite ? await writeBooking(tx, bookingWrite, bookingOrderPart(quote, order)) : null

  // 5. The audit rows, in the same transaction. Nothing is owed to Stripe, so the order is paid now.
  const { orderId } = order
  const method = input.payment?.method
  const collected = quote.totals.toCollect.cash
  const paymentMethod = collected > 0 && method === 'cash' ? 'cash' : null
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
        postage: quote.postage ? { method: quote.postage.method, amount: quote.postage.amount } : null,
        addressSaved: quote.delivery?.saveToCustomer === true,
        orderTotal: quote.totals.orderTotal,
        amountDue: quote.totals.amountDue,
        toCollect: collected,
        confirmed: confirmed ?? null,
        overrides,
      },
    },
    { ...actor, action: 'order.paid', details: { method: paymentMethod, collected } },
  ])

  return {
    orderId,
    output: {
      orderId,
      status: 'paid',
      bookingId,
      sessionPassId: order.sessionPassId,
      giftCardId: order.giftCardId,
      giftCardCode: order.giftCardCode,
      payment: { method: paymentMethod, collected, cardCharged: false },
    },
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
