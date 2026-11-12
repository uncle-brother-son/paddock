// New in W19 (D-plan 1.4, 4.2, 4.7): settleLapsedBooking on the Worker. A payment-needed booking (a membership credit
// booking whose membership lapsed) is paid at seat 1's stored price, never recalculated, and goes back to confirmed.
//
// C1 is one transaction with no Stripe call: the booking locked and read (lockAndLoadBooking), the checks in the old
// function's order, the confirmed figures (Q18), the store credit and gift card claimed, the booking confirmed with
// seat 1 paid and its credit released, and `booking.settle` recorded. Then either:
// - no card money (cash, or gift card and store credit covering it all): the gift card's redemption row, and commit.
//   Settled. As today, no order is written for cash, gift card or store credit (Wayne's Q36: keep today's way);
// - card money: the flow's record (W17's writeFlowRecord, `method` card or reader) written last, and commit. Then the
//   saved card is charged once under `<pendingId>:charge` and W12's C2 records the card's order and line, or the
//   reader's intent is made under `<pendingId>:reader-intent` and the screen collects it (W12-7). A definite refusal
//   undoes the flow (one transaction); no clear answer holds it (Q35), and reconcile finishes or undoes it.
// One transaction replaces the old money-first steps and their best-effort put-backs, so nothing is taken without the
// change and no change stands without its money (W02 findings 2 and 7; W05 review 3's R1a, R2c and R4-style faults).
import 'server-only'
import type { ApiErrorCode, SettleBookingInput, SettleBookingOutput } from '@/contracts'
import { audit } from '@/server/audit'
import { DbCommitUnknownError, DbError, inOpenTransaction, isDeadlock, postgresRefusal, type Db, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import type { StripeClient } from '@/server/stripe/client'
import { stripeTiming } from '@/server/stripe/deadline'
import { amountChangedRefusal, cashDifferenceRefusal, exceedsAmount } from '@/server/rules/orders/amounts'
import { COLLECT_DEADLINE_MS } from '@/server/rules/orders/collect-saved-card'
import { FAILURE_MESSAGES as ORDER_WORDS, NO_SAVED_CARD_MESSAGE } from '@/server/rules/orders/failure-messages'
import { FLOW_INTENT_UNCONFIRMED_MESSAGE, readFlow, undoFlowInTransaction } from '@/server/rules/orders/reader-flow'
import {
  AMOUNT_CHANGED_MESSAGE,
  CARD_PAYMENT_OPEN_MESSAGE,
  DECLINED_NOT_UNDONE_MESSAGE,
  READER_PAYMENT_OPEN_MESSAGE,
  SETTLE_NOT_SAVED_MESSAGE,
  settleReaderNotStartedMessage,
  settleReaderNotStartedNotUndoneMessage,
  staffSees,
} from './failure-messages'
import { createFlowReaderIntent, recordFlowIntent, settleCardFlow, writeFlowRecord, type CardFlowSnapshot, type ReaderFlowSnapshot } from './flow'
import { lockAndLoadBooking, paymentOpen, type LoadedBooking } from './load-booking'

export interface SettleOptions {
  actor: { type: 'staff'; id: string }
  requestId: string
  /** The request's start: the press's Stripe calls end by a deadline from it (as an order's). */
  startedAt?: number
  now?: () => number
  /** The Stripe client, made before C1 for a card or reader payment, so a missing key fails with nothing written. */
  stripe?: () => StripeClient
}

/** The old function's note on the store credit it took (shared/storeCredit's row). */
export const SETTLE_STORE_CREDIT_NOTE = 'Store credit redeemed to settle a lapsed-membership booking.'
export const settleDescription = (bookingId: string): string => `Payment to settle lapsed-membership booking (${bookingId})`

/** Pennies are the smallest amount, so anything above half a penny is a real difference (shared/cashConfirmation). */
const NOTHING_LEFT = 0.001

type SettleRefusalExtras = { amountDue?: number; pendingId?: string; field?: string; logDetail?: string }

/** A refusal: the old reason and the words staff see (the old function's, else the Settle dialog's), as details. */
export function settleRefusal(code: ApiErrorCode, reason: string, message: string | undefined, extras: SettleRefusalExtras = {}): ApiError {
  const words = staffSees('settle', reason, message)
  return new ApiError(code, words, {
    ...(extras.field ? { field: extras.field } : {}),
    ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
    details: {
      reason,
      message: words,
      action: 'settle',
      ...(extras.amountDue !== undefined ? { amountDue: extras.amountDue } : {}),
      ...(extras.pendingId !== undefined ? { pendingId: extras.pendingId } : {}),
    },
  })
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const wholePennies = (n: number): boolean => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

/** A flow C1 committed: its record, seat 1's price and what the card or reader takes. */
interface FlowStarted {
  pendingId: string
  amount: number
  remainder: number
}

type Started = { kind: 'settled'; output: SettleBookingOutput } | ({ kind: 'card' | 'reader' } & FlowStarted)

/** A part's amount: missing or £0 is no part (as the old function); anything else must be whole pennies above £0. */
function partAmount(sent: number | undefined, reason: 'gift_card_amount_invalid' | 'store_credit_amount_invalid'): number {
  if (sent === undefined || sent === 0) return 0
  if (!Number.isFinite(sent) || sent < 0 || !wholePennies(sent)) throw settleRefusal('VALIDATION', reason, ORDER_WORDS[reason])
  return sent
}

/** The held-payment refusal, with the card words when every open flow on it is a saved-card one (W18a). */
function paymentOpenRefusal(booking: LoadedBooking): ApiError {
  const cardOnly = booking.openFlows.length > 0 && booking.openFlows.every((flow) => flow.method === 'card')
  return cardOnly
    ? settleRefusal('CONFLICT', 'card_payment_open', CARD_PAYMENT_OPEN_MESSAGE)
    : settleRefusal('CONFLICT', 'reader_payment_open', READER_PAYMENT_OPEN_MESSAGE)
}

/** The gift card's checks with New Order's words (D-plan 2.2), under its lock, then the claim. Answers whether this stamped redeemed_at. */
async function claimGiftCard(tx: Tx, giftCardId: string, amount: number): Promise<boolean> {
  const card = (
    await tx.query<{ remaining_balance: string; voided: boolean | null; expired: boolean; redeemed: boolean }>(
      `SELECT remaining_balance::text AS remaining_balance, voided,
              expiry_date < (now() AT TIME ZONE 'Europe/London')::date AS expired, redeemed_at IS NOT NULL AS redeemed
       FROM gift_cards WHERE id = $1::uuid`,
      [giftCardId]
    )
  )[0]
  // The old reason for all four, so the screen's handling is unchanged; New Order's words say which.
  const refuse = (words: string | undefined) => settleRefusal('CONFLICT', 'gift_card_insufficient_or_invalid', words)
  if (!card) throw refuse(ORDER_WORDS['gift_card_not_found'])
  if (card.voided === true) throw refuse(ORDER_WORDS['gift_card_voided'])
  if (card.expired) throw refuse(ORDER_WORDS['gift_card_expired'])
  const balance = Number.parseFloat(card.remaining_balance)
  if (balance <= 0 || round2(balance - amount) < 0) throw refuse(ORDER_WORDS['gift_card_insufficient_or_invalid'])
  const claimed = (
    await tx.query<{ redeemed: boolean }>(
      `UPDATE gift_cards
       SET remaining_balance = remaining_balance - $1::numeric,
           redeemed_at = CASE WHEN redeemed_at IS NULL AND round(remaining_balance - $1::numeric, 2) <= 0 THEN now() ELSE redeemed_at END,
           updated_at = now()
       WHERE id = $2::uuid AND remaining_balance >= $1::numeric AND voided IS NOT TRUE
         AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
       RETURNING redeemed_at IS NOT NULL AS redeemed`,
      [amount, giftCardId]
    )
  )[0]
  if (!claimed) throw refuse(ORDER_WORDS['gift_card_insufficient_or_invalid'])
  return !card.redeemed && claimed.redeemed
}

/**
 * C1, inside its transaction. The checks run in the old function's order: the booking, its status, seat 1's price, a
 * payment open on it, then the money (the cash figure first, the parts over the amount, a method, the reader with
 * nothing to take), then the confirmed figures (Q18). Every refusal throws, so nothing it did is kept.
 */
async function c1(tx: Tx, bookingId: string, input: SettleBookingInput, options: SettleOptions, keyLivemode: boolean | null): Promise<Started> {
  const payment = input.payment
  const giftCardId = payment?.giftCard?.giftCardId ?? null
  const loaded = await lockAndLoadBooking(tx, { bookingId, ownSession: false, giftCardId })
  if (!loaded) throw settleRefusal('NOT_FOUND', 'booking_not_found', undefined)
  const { booking } = loaded
  if (booking.status !== 'payment_needed') throw settleRefusal('CONFLICT', 'booking_not_payment_needed', undefined)
  const seat1 = booking.seats[0]
  if (!seat1 || seat1.unitPrice === null || !Number.isFinite(seat1.unitPrice) || seat1.unitPrice < 0) {
    throw settleRefusal('CONFLICT', 'seat_price_missing', undefined)
  }
  const amount = seat1.unitPrice
  if (paymentOpen(booking)) throw paymentOpenRefusal(booking)

  const giftCardAmount = partAmount(payment?.giftCard?.amount, 'gift_card_amount_invalid')
  const storeCreditAmount = partAmount(payment?.storeCredit?.amount, 'store_credit_amount_invalid')
  const method = payment?.method
  const remainder = Math.max(0, round2(amount - giftCardAmount - storeCreditAmount))

  // Q18 (D-plan 4.7): the old cash tick's figure still counts when the dialog sends no `figures.toCollect`.
  const confirmed = { ...input.figures, toCollect: input.figures?.toCollect ?? payment?.confirmedCashAmount }
  const cash = cashDifferenceRefusal(method, remainder, confirmed.toCollect)
  if (cash) throw settleRefusal('CONFLICT', cash.reason, cash.message, { amountDue: amount })
  if (exceedsAmount(giftCardAmount, amount)) throw settleRefusal('CONFLICT', 'gift_card_amount_exceeds_total', undefined, { amountDue: amount })
  if (exceedsAmount(giftCardAmount + storeCreditAmount, amount)) throw settleRefusal('CONFLICT', 'store_credit_amount_exceeds_total', undefined, { amountDue: amount })
  if (remainder > NOTHING_LEFT && !method) throw settleRefusal('CONFLICT', 'payment_method_required', undefined, { amountDue: amount })
  // The screen sends the reader only with something left to take, so the amount has changed.
  if (method === 'reader' && remainder <= 0.005) throw settleRefusal('CONFLICT', 'payment_method_required', AMOUNT_CHANGED_MESSAGE, { amountDue: amount })
  // The old function took any other method as cash with nothing recorded; New Order's words instead.
  if (remainder > NOTHING_LEFT && method !== 'card' && method !== 'reader' && method !== 'cash') {
    throw settleRefusal('VALIDATION', 'invalid_payment_method', ORDER_WORDS['invalid_payment_method'], { amountDue: amount, field: 'payment.method' })
  }
  const changed = amountChangedRefusal(method, confirmed, { amountDue: amount, toCollect: remainder })
  if (changed) throw settleRefusal('CONFLICT', changed.reason, changed.message, { amountDue: amount })

  const cardMoney = remainder > NOTHING_LEFT && (method === 'card' || method === 'reader') ? method : null
  let savedCard: { stripe_customer_id: string | null; saved_payment_method_id: string | null } | undefined
  let stripeCustomerId: string | null = null
  if (cardMoney) {
    savedCard = (
      await tx.query<{ stripe_customer_id: string | null; saved_payment_method_id: string | null }>(
        'SELECT stripe_customer_id, saved_payment_method_id FROM customers WHERE id = $1::uuid',
        [booking.customerId]
      )
    )[0]
    stripeCustomerId = savedCard?.stripe_customer_id ?? null
    // The legacy charge route's words for a card with nothing saved: nothing is claimed or charged.
    if (cardMoney === 'card' && (!savedCard?.stripe_customer_id || !savedCard.saved_payment_method_id)) {
      throw settleRefusal('CONFLICT', 'no_saved_card', NO_SAVED_CARD_MESSAGE)
    }
  }

  // What the flow's undo puts back (W12's undoFlowInTransaction, 'settle'), as the old reader snapshot held it.
  const before = (
    await tx.query<{ price_paid: string | null; payment_due_by: string | null }>(
      'SELECT price_paid::text AS price_paid, payment_due_by::text AS payment_due_by FROM bookings WHERE id = $1::uuid',
      [bookingId]
    )
  )[0]

  // The money parts, in the payment order: store credit, then the gift card.
  if (storeCreditAmount > 0) {
    const applied = (
      await tx.query<{ result: { ok?: boolean; reason?: string } | null }>(
        'SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, NULL::uuid, $4::uuid, $5::uuid, $6::text, NULL::uuid) AS result',
        [booking.customerId, -storeCreditAmount, 'redemption', bookingId, options.actor.id, SETTLE_STORE_CREDIT_NOTE]
      )
    )[0]?.result
    if (applied?.ok !== true) {
      throw settleRefusal('CONFLICT', applied?.reason === 'insufficient_store_credit' ? 'store_credit_insufficient_or_invalid' : 'store_credit_failed', undefined)
    }
  }
  const stampedRedeemedAt = giftCardAmount > 0 && giftCardId ? await claimGiftCard(tx, giftCardId, giftCardAmount) : false

  // The booking confirmed and paid for seat 1, its membership credit released; seat 1 a paid seat. Places untouched.
  const updated = (
    await tx.query<{ id: string; status: string; redemption_source: string; price_paid: string; payment_due_by: string | null }>(
      `UPDATE bookings
       SET status = 'confirmed', redemption_source = 'paid', redeemed_membership_id = NULL, credit_period_id = NULL,
           price_paid = COALESCE(price_paid, 0) + $1::numeric, payment_due_by = NULL, updated_at = now()
       WHERE id = $2::uuid AND status = 'payment_needed'
       RETURNING id, status, redemption_source, price_paid::text AS price_paid, payment_due_by::text AS payment_due_by`,
      [amount, bookingId]
    )
  )[0]
  if (!updated) throw new Error(`Booking ${bookingId} was locked as payment needed but not updated.`)
  await tx.query("UPDATE booking_guests SET pay_by = 'paid' WHERE booking_id = $1::uuid AND guest_type = 'account_holder' AND pay_by IS DISTINCT FROM 'paid'", [bookingId])

  const description = settleDescription(bookingId)
  let pendingId: string | null = null
  if (cardMoney) {
    const old = {
      customer_id: booking.customerId,
      description,
      booking_id: bookingId,
      old_status: 'payment_needed',
      old_price_paid: before?.price_paid ?? null,
      old_payment_due_by: before?.payment_due_by ?? null,
      old_redemption_source: booking.redemptionSource ?? 'paid',
      old_redeemed_membership_id: booking.redeemedMembershipId,
      old_credit_period_id: booking.creditPeriodId,
      old_seat1_pay_by: seat1.payBy,
      amount,
      ...(storeCreditAmount > 0 ? { store_credit_amount: storeCreditAmount } : {}),
      ...(giftCardAmount > 0 && giftCardId ? { gift_card: { gift_card_id: giftCardId, amount: giftCardAmount, stamped_redeemed_at: stampedRedeemedAt } } : {}),
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
        : { ...old, ...marks, method: 'reader', stripe_customer_id: stripeCustomerId }
    // The record last, before anything is asked of Stripe (bug 14's rule): its id is every key of the flow.
    pendingId = await writeFlowRecord(tx, { flow: 'settle', recordId: bookingId, expectedAmount: remainder, snapshot })
  } else if (giftCardAmount > 0 && giftCardId) {
    // The gift card part in the card's history, as today: this booking, no order (Q36). On a flow, C2 writes it.
    await tx.query(
      'INSERT INTO gift_card_redemptions (gift_card_id, order_id, booking_id, amount_used, redeemed_at) VALUES ($1::uuid, NULL, $2::uuid, $3::numeric, now())',
      [giftCardId, bookingId, giftCardAmount]
    )
  }

  await audit.record(tx, {
    actorType: options.actor.type,
    actorId: options.actor.id,
    action: 'booking.settle',
    entityType: 'booking',
    entityId: bookingId,
    requestId: options.requestId,
    details: {
      amount,
      storeCredit: storeCreditAmount,
      giftCard: giftCardAmount,
      method: remainder > NOTHING_LEFT ? (method ?? null) : null,
      toCollect: remainder,
      pendingId,
    },
  })

  if (cardMoney && pendingId) return { kind: cardMoney, pendingId, amount, remainder }
  return {
    kind: 'settled',
    output: {
      settled: true,
      booking: { id: updated.id, status: updated.status, redemption_source: updated.redemption_source, price_paid: updated.price_paid, payment_due_by: updated.payment_due_by },
      amountCharged: amount,
    },
  }
}

/**
 * C1 in a transaction of its own, run once more after a deadlock (W17 review S2, as T1 does: it calls nothing outside
 * the database). A database fault rolled all of it back, so it is a definite answer with plain words; only a COMMIT
 * with no answer may have saved it, and stays INTERNAL.
 */
async function inC1<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const opensItsOwn = !inOpenTransaction(db)
  try {
    try {
      return await db.transaction(work)
    } catch (err) {
      if (!opensItsOwn || !isDeadlock(err)) throw err
      return await db.transaction(work)
    }
  } catch (err) {
    if (!opensItsOwn || err instanceof ApiError || err instanceof DbCommitUnknownError) throw err
    if (!(err instanceof DbError) && !postgresRefusal(err)) throw err
    throw settleRefusal('INTERNAL', 'settle_not_saved', SETTLE_NOT_SAVED_MESSAGE, { logDetail: `C1 rolled back: ${explain(err)}` })
  }
}

/** The booking as the old answer gave it, read after C2. */
async function settledBooking(db: Db, bookingId: string): Promise<NonNullable<SettleBookingOutput['booking']>> {
  const row = (
    await db.query<{ id: string; status: string; redemption_source: string; price_paid: string; payment_due_by: string | null }>(
      'SELECT id, status, redemption_source, price_paid::text AS price_paid, payment_due_by::text AS payment_due_by FROM bookings WHERE id = $1::uuid',
      [bookingId]
    )
  )[0]
  if (!row) throw new Error(`Booking ${bookingId} is gone after its settle.`)
  return row
}

/** The saved card: charged once, then C2 or the undo; anything unclear held (flow.ts, settleCardFlow). */
async function chargeAndFinish(db: Db, stripe: StripeClient, bookingId: string, started: FlowStarted, options: SettleOptions, startedAt: number): Promise<SettleBookingOutput> {
  const now = options.now ?? Date.now
  const outcome = await settleCardFlow(db, stripe, started.pendingId, {
    actor: options.actor,
    requestId: options.requestId,
    timing: { deadline: startedAt + COLLECT_DEADLINE_MS, now },
  })
  if (outcome.outcome === 'finished') return { settled: true, booking: await settledBooking(db, bookingId), amountCharged: started.amount }
  if (outcome.outcome === 'declined') {
    // Nothing was taken. The old function threw the charge's words; the wrapper does too.
    const reason = outcome.needsAuthentication ? 'card_needs_authentication' : 'card_declined'
    const message = outcome.undone ? outcome.message : `${outcome.message} ${DECLINED_NOT_UNDONE_MESSAGE}`
    throw settleRefusal(outcome.needsAuthentication ? 'PAYMENT_NEEDS_AUTHENTICATION' : 'PAYMENT_FAILED', reason, message, {
      pendingId: started.pendingId,
      logDetail: `${outcome.stripeCode ?? 'no code'}; undone: ${String(outcome.undone)}`,
    })
  }
  if (outcome.outcome === 'held') {
    throw settleRefusal('PAYMENT_UNCONFIRMED', outcome.reason, outcome.message, { pendingId: started.pendingId, logDetail: outcome.detail })
  }
  throw new Error(`The card flow ${started.pendingId} wasn't open straight after C1 (${outcome.state}).`)
}

/** The reader, pending-first (W12-7): the intent under the record's key, written onto the record; the screen collects. */
async function startOnTheReader(db: Db, stripe: StripeClient, bookingId: string, started: FlowStarted, options: SettleOptions, startedAt: number): Promise<SettleBookingOutput> {
  const timing = stripeTiming(startedAt, options.now ?? Date.now)
  const row = await readFlow(db, started.pendingId)
  if (!row) throw new Error(`The reader flow ${started.pendingId} is gone straight after C1.`)
  const answer = await createFlowReaderIntent(db, stripe, row, timing)
  const held = (detail: string) =>
    settleRefusal('PAYMENT_UNCONFIRMED', 'payment_unconfirmed', FLOW_INTENT_UNCONFIRMED_MESSAGE, { pendingId: started.pendingId, logDetail: detail })

  if (answer.outcome === 'definite') {
    // No intent exists, so nothing can be taken: the flow's undo puts everything back, in one transaction.
    let undone = false
    try {
      const result = await undoFlowInTransaction(db, started.pendingId, { actor: options.actor, requestId: options.requestId, why: `The card reader payment couldn't be started. ${answer.detail}` })
      undone = result.undone || result.reason !== 'already_finalised'
    } catch {
      undone = false
    }
    const message = undone ? settleReaderNotStartedMessage(answer.message) : settleReaderNotStartedNotUndoneMessage(answer.message)
    throw settleRefusal('PAYMENT_FAILED', 'settle_undo_failed', message, { pendingId: started.pendingId, logDetail: answer.detail })
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
    settled: false,
    pendingReaderPayment: { flow: 'settle', recordId: bookingId, pendingId: started.pendingId, paymentIntentId: paymentIntent.id, clientSecret, amount: started.remainder },
  }
}

/** settleLapsedBooking: C1, then the card or the reader when card money is due. */
export async function settleBooking(db: Db, bookingId: string, input: SettleBookingInput, options: SettleOptions): Promise<SettleBookingOutput> {
  const startedAt = options.startedAt ?? (options.now ?? Date.now)()
  const method = input.payment?.method
  // Made before C1, so a card or reader payment is never left held with no way to reach Stripe.
  const stripe = method === 'card' || method === 'reader' ? options.stripe?.() : undefined
  if ((method === 'card' || method === 'reader') && !stripe) throw new Error(`A ${method} settle needs a Stripe client.`)
  const started = await inC1(db, (tx) => c1(tx, bookingId, input, options, stripe?.keyLivemode ?? null))
  if (started.kind === 'settled') return started.output
  if (!stripe) throw new Error('A card or reader settle needs a Stripe client.')
  if (started.kind === 'card') return chargeAndFinish(db, stripe, bookingId, started, options, startedAt)
  return startOnTheReader(db, stripe, bookingId, started, options, startedAt)
}
