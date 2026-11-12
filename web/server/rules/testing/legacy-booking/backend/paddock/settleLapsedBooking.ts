import {
  CARD_CHARGE_IN_PROGRESS_MESSAGE,
  CHARGE_FINISHED_AUDIT,
  CHARGE_KEY_STILL_STANDS,
  cardChargeUnsure,
  cardChargeWinner,
  chargeBookingCard,
  chargeFinishedDetails,
  earlierCardCharge,
  markCardChargePartsReturned,
  retireCardCharge,
} from './shared/bookingCardCharge'
import { reverseSavedCardCharge } from './shared/bookingRefund'
import { PRESS_FINISHED_AUDIT, detailId, findPressFinished, newPressId } from './shared/pressFinished'
import { storeCreditMoved } from './shared/storeCreditRefund'
import { NO_READER_PAYMENT_OPEN, READER_PAYMENT_OPEN_MESSAGE, anyReaderPaymentOpenOnBooking } from './shared/readerPaymentOpen'
import { requireStaffId } from './shared/resolveStaffId'
import { applyStoreCredit } from './shared/storeCredit'
import { createTerminalPaymentIntentUnguarded as createTerminalPaymentIntent } from './createTerminalPaymentIntent'
import { reversePendingMoneyParts, type PendingReaderSnapshot } from './shared/pendingReaderFlows'
import { AMOUNT_CHANGED_MESSAGE, cashDifferenceRefusal, exceedsAmount } from './shared/cashConfirmation'

/** Saving the settle gave no answer, and looking for its finished row failed too. */
const SETTLE_SAVE_UNCLEAR_MESSAGE =
  'Saving the settle gave no answer, and checking whether it was saved failed too, so nothing was put back. Reload the booking: if it is confirmed, it is settled. If it is still awaiting payment, give back by hand any gift card, store credit or cash taken for it.'

/**
 * Payment input — exactly the same shape and handling moveBooking.ts uses when it collects an
 * additional amount for a paid difference: an optional store credit part, an optional gift card
 * part, and one money method (card on file, Terminal reader charge already taken, or cash
 * confirmed in the UI).
 */
export interface SettleLapsedPaymentInput {
  storeCredit?: { amount: number }
  giftCard?: { giftCardId: string; amount: number }
  method?: 'card' | 'reader' | 'cash'
  /** Cash only: the figure on the tick staff confirmed. Refused if the amount works out different
   *  (shared/cashConfirmation). */
  confirmedCashAmount?: number
}

export interface SettleLapsedBookingParams {
  bookingId: string
  payment?: SettleLapsedPaymentInput
}

export type SettleLapsedBookingFailureReason =
  | 'booking_not_found'
  | 'booking_not_payment_needed'
  | 'seat_price_missing'
  | 'payment_method_required'
  /** The cash due differs from what staff confirmed — nothing was taken; `amountDue` has the new figure. */
  | 'cash_amount_changed'
  | 'gift_card_amount_exceeds_total'
  | 'store_credit_amount_exceeds_total'
  | 'store_credit_insufficient_or_invalid'
  | 'store_credit_failed'
  | 'gift_card_insufficient_or_invalid'
  | 'settle_undo_failed'
  | 'reader_payment_open'
  /** Another press on this booking is taking the same payment: nothing was taken. */
  | 'card_charge_in_progress'
  /** Money was taken, and the booking couldn't be written: `message` says what went back. */
  | 'settle_failed'

export interface SettleLapsedBookingResult {
  settled: boolean
  reason?: SettleLapsedBookingFailureReason
  message?: string
  /** With any refusal over the amount: seat 1's stored price, before any gift card or store credit. */
  amountDue?: number
  /** The updated booking row on success. */
  booking?: {
    id: string
    status: string
    redemption_source: string
    price_paid: string
    payment_due_by: string | null
  }
  /** The amount collected for seat 1 on success. */
  amountCharged?: number
  /** Present (with `settled: false`) when method is 'reader' (new flow): the booking is already
   *  flipped to confirmed and PENDING the reader charge — the frontend collects on the reader
   *  then calls finaliseReaderPayment({ pendingId }); a reader failure calls
   *  cancelReaderPayment, which restores the payment_needed state. */
  pendingReaderPayment?: {
    flow: 'settle'
    recordId: string
    pendingId: string
    paymentIntentId: string
    clientSecret: string
    amount: number
  }
}

interface LapsedBookingInfo {
  id: string
  customer_id: string
  session_id: string
  party_size: number
  status: string
  price_paid: string | null
  /** As text: part of the card charge's key, so it must come back exactly as it went in. */
  updated_at: string
  redemption_source: string
  redeemed_membership_id: string | null
  credit_period_id: string | null
  payment_due_by: string | null
  /** Seat 1's stored unit price (first booking_guests row, the same seat-1 convention
   *  cancelCreditBooking.ts uses) — what that seat pays as a paying customer for this session's
   *  band, recorded when the booking was created. Never recalculated here. */
  seat1_unit_price: string | null
  /** Seat 1's coverage before the settle (restored by cancelReaderPayment's undo). */
  seat1_pay_by: string | null
}

/**
 * Staff takes payment for a payment_needed booking (a former membership-credit booking flagged
 * after the membership's payment failed). Uses the same money-handling conventions as
 * moveBooking.ts's additional-payment path (same gift card claim, same chargeSavedCard booking
 * order line so reports and refunds work, same reader/cash semantics), but with MONEY-FIRST
 * ordering so a declined card or an invalid gift card can never leave a confirmed, 'paid'
 * booking behind with nothing collected:
 *  1. validate the booking and the payment split;
 *  2. collect the money — claim the store credit part (a negative 'redemption' movement through
 *     public.store_credit_apply), then claim the gift card part (guarded UPDATE), then charge the
 *     card remainder via chargeSavedCard. Any failure here throws BEFORE any booking write. If
 *     the card charge fails after a store-credit/gift-card claim, the claimed amounts are put
 *     back (a positive 'redemption_reversal' movement for store credit, and the gift card balance
 *     restored with its redeemed_at stamp undone when this call stamped it) before rethrowing;
 *  3. only then flip the booking (guarded UPDATE on status = 'payment_needed', with nothing open on
 *     the reader) and set seat 1's pay_by to 'paid'. If that statement fails or affects zero rows,
 *     everything taken goes back, the card charge through its own PaymentIntent, and a failed
 *     reversal says exactly what to check. In the NEW reader flow the flip happens BEFORE the charge
 *     (nothing taken yet), so only the claimed parts go back.
 *
 * Reader (new flow): the flip happens first and PENDING — the PaymentIntent is created with
 * metadata { flow: 'settle', record_id } and the frontend collects then calls
 * finaliseReaderPayment (which records the payment); cancelReaderPayment restores
 * payment_needed. Cash was confirmed in the UI — no server-side action.
 *
 * Capacity is intentionally untouched: a payment_needed booking still holds its session capacity,
 * and settling it must not double-count. Guest seats are untouched.
 */
export default async function settleLapsedBooking(
  req: { params: SettleLapsedBookingParams; user: User }
): Promise<SettleLapsedBookingResult> {
  const { bookingId, payment } = req.params

  if (!bookingId) {
    return { settled: false, reason: 'booking_not_found' }
  }

  // Staff attribution like the other staff-performed mutations — fails loudly when the logged-in
  // user has no staff record rather than settling a payment unattributed.
  const staffId = await requireStaffId(req.user.email)

  const lookup = await paddockData.query<LapsedBookingInfo>(
    `SELECT b.id, b.customer_id, b.session_id, b.party_size, b.status, b.price_paid, b.updated_at::text AS updated_at,
            b.redemption_source, b.redeemed_membership_id, b.credit_period_id, b.payment_due_by,
            (SELECT bg.unit_price FROM booking_guests bg WHERE bg.booking_id = b.id
             ORDER BY bg.created_at, bg.id LIMIT 1) AS seat1_unit_price,
            (SELECT bg.pay_by FROM booking_guests bg WHERE bg.booking_id = b.id
             ORDER BY bg.created_at, bg.id LIMIT 1) AS seat1_pay_by
     FROM bookings b
     WHERE b.id = $1`,
    [bookingId]
  )
  const booking = lookup.data[0]
  if (!booking) {
    return { settled: false, reason: 'booking_not_found' }
  }
  if (booking.status !== 'payment_needed') {
    return { settled: false, reason: 'booking_not_payment_needed' }
  }
  if (booking.seat1_unit_price === null || booking.seat1_unit_price.trim() === '') {
    return {
      settled: false,
      reason: 'seat_price_missing',
    }
  }
  const amount = Number.parseFloat(booking.seat1_unit_price)
  if (!Number.isFinite(amount) || amount < 0) {
    return { settled: false, reason: 'seat_price_missing' }
  }

  // A payment on the reader changes what this booking holds, and an undo would put back figures
  // from before this settle. The statement below checks again.
  if (await anyReaderPaymentOpenOnBooking(bookingId)) {
    return { settled: false, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
  }

  // 1. Validate the money movement before touching anything — same order and rules as moveBooking.
  const giftCardAmount = payment?.giftCard?.amount ?? 0
  const storeCreditAmount = payment?.storeCredit?.amount ?? 0
  const remainder = Math.max(0, Math.round((amount - giftCardAmount - storeCreditAmount) * 100) / 100)
  // The screen's figure comes from when the booking was loaded, and the seat's price can have
  // changed since, either way. Nothing has been claimed or written yet, so there is nothing to put
  // back. Ahead of the checks below so that a price falling under the gift card and store credit
  // still gets the new figure.
  const cashRefusal = cashDifferenceRefusal(payment?.method, remainder, payment?.confirmedCashAmount)
  if (cashRefusal) {
    return { settled: false, reason: cashRefusal.reason, message: cashRefusal.message, amountDue: amount }
  }
  // Each refusal below carries the figure too: the screen's can be out of date, and a price that
  // rose from nothing has no payment choices on screen until it moves.
  if (exceedsAmount(giftCardAmount, amount)) {
    return { settled: false, reason: 'gift_card_amount_exceeds_total', amountDue: amount }
  }
  if (exceedsAmount(giftCardAmount + storeCreditAmount, amount)) {
    return { settled: false, reason: 'store_credit_amount_exceeds_total', amountDue: amount }
  }
  if (remainder > 0.001 && !payment?.method) {
    return { settled: false, reason: 'payment_method_required', amountDue: amount }
  }
  // New reader flow: no pre-charged PaymentIntent — the flip happens below and PENDING, then the
  // PaymentIntent is created with metadata and the frontend collects + finalises. There must be
  // something for the reader to charge. The screen only sends the reader with something left to
  // pay, so here the amount has changed.
  if (payment?.method === 'reader' && remainder <= 0.005) {
    return { settled: false, reason: 'payment_method_required', message: AMOUNT_CHANGED_MESSAGE, amountDue: amount }
  }

  // 2. Collect the money FIRST. Nothing below has written to the booking yet, so a failure here
  // leaves the booking exactly as it was — still payment_needed, still awaiting payment.
  // Store credit is claimed first (a negative 'redemption' movement through
  // public.store_credit_apply, which records it on store_credit_transactions with this
  // booking_id), then the gift card, then the card remainder.
  const cardCharge = { flow: 'settle' as const, bookingId, customerId: booking.customer_id, bookingUpdatedAt: booking.updated_at, amount: remainder }
  // Another press may be taking this same payment now: wait for it. Or one died after its charge,
  // having taken these parts too, and nothing gave them back.
  const earlier = remainder > 0 && payment?.method === 'card' ? await earlierCardCharge(cardCharge) : ({ state: 'none' } as const)
  if (earlier.state === 'in_progress') {
    return { settled: false, reason: 'card_charge_in_progress', message: CARD_CHARGE_IN_PROGRESS_MESSAGE }
  }
  const resuming = earlier.state === 'resume'
  let storeCreditClaimed = resuming && storeCreditAmount > 0
  if (storeCreditAmount > 0 && !resuming) {
    const applied = await applyStoreCredit({
      customerId: booking.customer_id,
      amount: -storeCreditAmount,
      reason: 'redemption',
      bookingId,
      staffId,
      note: 'Store credit redeemed to settle a lapsed-membership booking.',
    })
    if (!applied.ok) {
      return {
        settled: false,
        reason: applied.reason === 'insufficient_store_credit' ? 'store_credit_insufficient_or_invalid' : 'store_credit_failed',
      }
    }
    storeCreditClaimed = true
  }
  let giftCardClaimed = resuming && giftCardAmount > 0
  // True only when THIS call stamped redeemed_at on the gift card (balance drained to zero by the
  // claim below) — the restore path must never un-redeem a stamp an earlier redemption made.
  let stampedRedeemedAt = false
  if (giftCardAmount > 0 && payment?.giftCard && !resuming) {
    // A failed claim leaves the booking as it was, so the store credit taken above goes back before
    // refusing. Returns what staff must do if it couldn't, or null.
    const giveStoreCreditBack = async (): Promise<string | null> => {
      if (!storeCreditClaimed) return null
      const back = await storeCreditMoved({
        customerId: booking.customer_id,
        amount: storeCreditAmount,
        reason: 'redemption_reversal',
        bookingId,
        staffId,
        note: 'Automatic reversal — the gift card could not be claimed.',
      })
      return back
        ? null
        : `Giving the £${storeCreditAmount.toFixed(2)} store credit back failed — check their balance, then add it by hand if it isn't there.`
    }
    let claim: { data: Array<{ id: string; remaining_balance: string }> }
    try {
      claim = await paddockData.query<{ id: string; remaining_balance: string }>(
        `UPDATE gift_cards SET remaining_balance = remaining_balance - $1, updated_at = now()
         WHERE id = $2 AND remaining_balance >= $3 AND voided IS NOT TRUE AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
         RETURNING id, remaining_balance`,
        [giftCardAmount, payment.giftCard.giftCardId, giftCardAmount]
      )
    } catch (err) {
      // A database error can't say whether the claim landed, unlike finding no row.
      const notBack = await giveStoreCreditBack()
      return {
        settled: false,
        reason: 'gift_card_insufficient_or_invalid',
        message: [
          `Claiming the gift card failed (${err instanceof Error ? err.message : String(err)}).`,
          notBack ?? (storeCreditClaimed ? 'The store credit was given back.' : null),
          "Check the gift card's balance before trying again.",
        ]
          .filter(Boolean)
          .join(' '),
      }
    }
    if (claim.data.length === 0) {
      const notBack = await giveStoreCreditBack()
      return {
        settled: false,
        reason: 'gift_card_insufficient_or_invalid',
        ...(notBack ? { message: `That gift card no longer has enough balance remaining. ${notBack}` } : {}),
      }
    }
    giftCardClaimed = true
    if (Number.parseFloat(claim.data[0]!.remaining_balance) <= 0) {
      await paddockData.query(`UPDATE gift_cards SET redeemed_at = now() WHERE id = $1 AND redeemed_at IS NULL`, [
        payment.giftCard.giftCardId,
      ])
      stampedRedeemedAt = true
    }
  }
  /** The saved-card charge's PaymentIntent: a reversal refunds exactly this. */
  let cardChargedPaymentIntentId: string | null = null
  let cardCharged = false
  /** Whose parts this press holds: its own started row, or the dead press's it resumed. */
  let partsFrom: string | null = earlier.state === 'resume' ? earlier.startedId : null
  /** This press's own started row. */
  let ownStartedId: string | null = null
  if (remainder > 0 && payment?.method === 'card') {
    try {
      const charged = await chargeBookingCard({
        ...cardCharge,
        staffId,
        description: `Payment to settle lapsed-membership booking (${bookingId})`,
        lineItems: [{ itemType: 'booking', quantity: 1, unitPrice: remainder, bookingId }],
      })
      cardChargedPaymentIntentId = charged.paymentIntentId
      cardCharged = true
      ownStartedId = charged.startedId
      partsFrom ??= charged.startedId
    } catch (err) {
      // The card charge failed after the store credit and/or gift card part was already claimed —
      // put everything back the way this call found it, then rethrow so staff see the decline
      // with nothing written.
      let allBack = true
      if (storeCreditClaimed) {
        allBack = await storeCreditMoved({
          customerId: booking.customer_id,
          amount: storeCreditAmount,
          reason: 'redemption_reversal',
          bookingId,
          staffId,
          note: 'Automatic reversal — the card charge failed.',
        })
      }
      if (giftCardClaimed && payment.giftCard) {
        try {
          await paddockData.query(
            `UPDATE gift_cards SET remaining_balance = remaining_balance + $1, updated_at = now()
             WHERE id = $2
             RETURNING id`,
            [giftCardAmount, payment.giftCard.giftCardId]
          )
          if (stampedRedeemedAt) {
            await paddockData.query(
              `UPDATE gift_cards SET redeemed_at = NULL WHERE id = $1 AND redeemed_at IS NOT NULL`,
              [payment.giftCard.giftCardId]
            )
          }
        } catch {
          allBack = false
        }
      }
      // No clear answer: the charge may land later. The parts are back, so the next press must take
      // them again rather than count them.
      const unsure = cardChargeUnsure(err)
      if (unsure && allBack) {
        const marked = await markCardChargePartsReturned(bookingId, [unsure.startedId, ...(partsFrom ? [partsFrom] : [])], staffId)
        if (!marked) throw new Error(`${unsure.message} Recording that the store credit and gift card went back failed, so check their balance after pressing again.`)
      }
      if (!allBack) {
        const why = err instanceof Error ? err.message : String(err)
        throw new Error(`${why} Putting the store credit or gift card back failed too: check their balance and the gift card by hand.`)
      }
      throw err
    }
  }
  // 'reader' (new flow): the PaymentIntent is created first, as nothing is charged until the
  // frontend collects and finalises. The flip below then writes the pending row with it, so
  // price_paid never holds this money without the row that stops it being refunded. 'cash': staff
  // confirmed receipt in the UI — no server-side action.
  const readerPending = payment?.method === 'reader'
  const readerSnapshot: PendingReaderSnapshot = {
    customer_id: booking.customer_id,
    description: `Payment to settle lapsed-membership booking (${bookingId})`,
    booking_id: bookingId,
    old_status: 'payment_needed',
    old_price_paid: booking.price_paid,
    old_payment_due_by: booking.payment_due_by,
    old_redemption_source: booking.redemption_source,
    old_redeemed_membership_id: booking.redeemed_membership_id,
    old_credit_period_id: booking.credit_period_id,
    old_seat1_pay_by: booking.seat1_pay_by,
    amount,
    ...(storeCreditClaimed ? { store_credit_amount: storeCreditAmount } : {}),
    ...(giftCardClaimed && payment?.giftCard
      ? { gift_card: { gift_card_id: payment.giftCard.giftCardId, amount: giftCardAmount, stamped_redeemed_at: stampedRedeemedAt } }
      : {}),
  }
  let intent: { paymentIntentId: string; clientSecret: string } | null = null
  if (readerPending) {
    try {
      intent = await createTerminalPaymentIntent({
        params: {
          customerId: booking.customer_id,
          amount: remainder,
          saveCard: false,
          metadata: { flow: 'settle', record_id: bookingId },
          description: readerSnapshot.description,
        },
      })
    } catch (err) {
      // Nothing was charged or written: only the store credit and gift card parts go back.
      const problems = await reversePendingMoneyParts(booking.customer_id, readerSnapshot, bookingId)
      const message = err instanceof Error ? err.message : String(err)
      return {
        settled: false,
        reason: 'settle_undo_failed',
        message: `Creating the card reader payment failed — the settle was undone and nothing was charged (${message})${
          problems.length > 0 ? ` — warnings: ${problems.join('; ')}` : ''
        }.`,
      }
    }
  }

  // Everything this call took goes back, the card through its own PaymentIntent. No permission check:
  // returning money the caller's own action just took must not depend on can_issue_refunds. Answers
  // what couldn't be put back. A refunded PaymentIntent still replays as paid, so its key must be
  // finished with before it is refunded: if it can't be, everything stays taken, and pressing again
  // finishes the settle. With the key retired, a finished row for the payment means another press
  // (or this one's statement, whose answer was lost) settled the booking with it: it is never
  // refunded, and the parts go back only if that press didn't count them as its own.
  const reverseTaken = async (): Promise<{ problems: string[]; settledWithThisPayment: boolean }> => {
    let partsCounted = false
    let settledWithThisPayment = false
    if (cardCharged) {
      try {
        await retireCardCharge(bookingId)
      } catch {
        return { problems: ['the card, store credit and gift card are all still taken: wait a minute, then press again, which finishes it without charging twice'], settledWithThisPayment }
      }
      if (cardChargedPaymentIntentId) {
        try {
          const winner = await cardChargeWinner(bookingId, cardChargedPaymentIntentId)
          settledWithThisPayment = winner !== null
          partsCounted = winner !== null && winner.partsFrom === partsFrom
        } catch {
          return {
            problems: [
              `checking whether another press settled it with payment ${cardChargedPaymentIntentId} failed, so nothing was refunded or put back: check the booking and that payment before doing anything else`,
            ],
            settledWithThisPayment,
          }
        }
      }
    }
    const problems: string[] = []
    if (partsCounted) return { problems, settledWithThisPayment }
    if (storeCreditClaimed) {
      const back = await storeCreditMoved({
        customerId: booking.customer_id,
        amount: storeCreditAmount,
        reason: 'redemption_reversal',
        bookingId,
        staffId,
        note: 'Automatic reversal — the settle could not be written.',
      })
      if (!back) problems.push('the store credit reversal failed')
    }
    if (giftCardClaimed && payment?.giftCard) {
      try {
        await paddockData.query(`UPDATE gift_cards SET remaining_balance = remaining_balance + $1, updated_at = now() WHERE id = $2`, [
          giftCardAmount,
          payment.giftCard.giftCardId,
        ])
        if (stampedRedeemedAt) {
          await paddockData.query(`UPDATE gift_cards SET redeemed_at = NULL WHERE id = $1 AND redeemed_at IS NOT NULL`, [
            payment.giftCard.giftCardId,
          ])
        }
      } catch {
        problems.push('the gift card restore failed')
      }
    }
    if (cardCharged && !settledWithThisPayment) {
      const reversed = cardChargedPaymentIntentId
        ? await reverseSavedCardCharge(cardChargedPaymentIntentId, remainder).catch(() => ({ ok: false }))
        : { ok: false }
      if (!reversed.ok) problems.push(`the £${remainder.toFixed(2)} card refund failed`)
    }
    return { problems, settledWithThisPayment }
  }
  const SETTLED_WITH_THIS_PAYMENT =
    'This booking was already settled with the same payment (by a press at the same moment, or this one with its answer lost), so it was only taken once. Reload the booking.'

  // 3. Money is collected (or pending, for the reader flow) — flip the booking, seat 1 and the
  // pending row in ONE statement. The guarded WHERE (status = 'payment_needed') is what keeps two
  // simultaneous settles from both applying. Seat 1 becomes a paid seat (createBooking's value for
  // a paid seat). Guest seats untouched.
  //
  // With no card charge, this press marks its own write (shared/pressFinished), so an answer lost
  // after the statement wrote is never undone. A card charge has its finished row for that.
  const pressId = cardCharged ? null : newPressId()
  let update: {
    data: Array<{ id: string; status: string; redemption_source: string; price_paid: string; payment_due_by: string | null; pending_id: string | null }>
  }
  try {
    update = await paddockData.query(
      `WITH bk AS (
         UPDATE bookings b
         SET status = 'confirmed',
             redemption_source = 'paid',
             redeemed_membership_id = NULL,
             credit_period_id = NULL,
             price_paid = COALESCE(b.price_paid, 0) + $1,
             payment_due_by = NULL,
             updated_at = now()
         WHERE b.id = $2 AND b.status = 'payment_needed'
           AND ${CHARGE_KEY_STILL_STANDS('b', '$3')}
           AND ${NO_READER_PAYMENT_OPEN}
         RETURNING b.id, b.status, b.redemption_source, b.price_paid, b.payment_due_by
       ),
       seat AS (
         UPDATE booking_guests g SET pay_by = 'paid'
         FROM bk
         WHERE g.booking_id = bk.id AND g.guest_type = 'account_holder' AND g.pay_by IS DISTINCT FROM 'paid'
         RETURNING g.id
       ),
       pending AS (
         INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status)
         SELECT 'settle', bk.id, $4::text, $5::numeric, $6::jsonb, 'pending' FROM bk WHERE $7::boolean
         RETURNING id
       ),
       ${CHARGE_FINISHED_AUDIT('$8', '$9', '$10::boolean')},
       -- The gift card part goes in the card's redemption history with the settle, as Add Guest's
       -- does: this booking, no order (a settle has none of its own). On the reader it is written at
       -- finalise (finaliseSettlePending), so an undo has no row to remove.
       gcr AS (
         INSERT INTO gift_card_redemptions (gift_card_id, order_id, booking_id, amount_used, redeemed_at)
         SELECT $11::uuid, NULL, bk.id, $12::numeric, now() FROM bk WHERE $13::boolean
         RETURNING id
       ),
       ${PRESS_FINISHED_AUDIT(
         '$14',
         `jsonb_build_object('press', $15::text, 'pending', (SELECT id FROM pending), 'price_paid', (SELECT price_paid::text FROM bk))`,
         '$16::boolean'
       )}
       SELECT bk.*, (SELECT id FROM pending) AS pending_id FROM bk`,
      [
        amount,
        bookingId,
        cardCharged ? booking.updated_at : null,
        intent?.paymentIntentId ?? null,
        remainder,
        JSON.stringify(readerSnapshot),
        intent !== null,
        staffId,
        chargeFinishedDetails(
          cardCharge,
          cardCharged && partsFrom && ownStartedId ? { paymentIntentId: cardChargedPaymentIntentId, partsFrom, by: ownStartedId, resumed: resuming } : null
        ),
        cardCharged,
        payment?.giftCard?.giftCardId ?? null,
        giftCardAmount,
        giftCardClaimed && !readerPending,
        staffId,
        pressId,
        pressId !== null,
      ]
    )
  } catch (err) {
    // The statement may have written and lost its answer: then its row is there, and the settle goes
    // on as if the answer had come back. Not there: nothing was written, so everything goes back.
    let landed: Record<string, unknown> | null = null
    if (pressId) {
      try {
        landed = await findPressFinished(bookingId, pressId)
      } catch {
        return { settled: false, reason: 'settle_failed', message: SETTLE_SAVE_UNCLEAR_MESSAGE }
      }
    }
    if (landed) {
      // The statement's own values: confirmed, paid, nothing due by.
      update = {
        data: [
          {
            id: bookingId,
            status: 'confirmed',
            redemption_source: 'paid',
            price_paid: detailId(landed, 'price_paid') ?? '',
            payment_due_by: null,
            pending_id: detailId(landed, 'pending'),
          },
        ],
      }
    } else {
      const { problems, settledWithThisPayment } = await reverseTaken()
      if (settledWithThisPayment && problems.length === 0) {
        return { settled: false, reason: 'booking_not_payment_needed', message: SETTLED_WITH_THIS_PAYMENT }
      }
      return {
        settled: false,
        reason: 'settle_failed',
        message:
          `Recording the payment failed (${err instanceof Error ? err.message : String(err)}), so the booking is still awaiting payment. ` +
          (problems.length > 0 ? `Check the customer's money: ${problems.join('; ')}.` : 'Everything taken was put back.'),
      }
    }
  }
  if (update.data.length === 0) {
    const { problems, settledWithThisPayment } = await reverseTaken()
    if (settledWithThisPayment && problems.length === 0) {
      return { settled: false, reason: 'booking_not_payment_needed', message: SETTLED_WITH_THIS_PAYMENT }
    }
    if (problems.length > 0) {
      return {
        settled: false,
        reason: 'settle_failed',
        message: `Payment of £${amount.toFixed(2)} was taken for booking ${bookingId}, but the booking is no longer awaiting payment, and putting it back failed. Check the customer's money: ${problems.join('; ')}.`,
      }
    }
    return {
      settled: false,
      reason: 'booking_not_payment_needed',
      ...(cardCharged ? { message: 'The booking is no longer awaiting payment, so the payment was put back. Check the booking.' } : {}),
    }
  }

  // New reader flow: the settle is written and PENDING — hand back to the frontend to collect on
  // the reader.
  if (intent) {
    return {
      settled: false,
      pendingReaderPayment: {
        flow: 'settle',
        recordId: bookingId,
        pendingId: update.data[0]!.pending_id!,
        paymentIntentId: intent.paymentIntentId,
        clientSecret: intent.clientSecret,
        amount: remainder,
      },
    }
  }

  const updated = update.data[0]!
  return {
    settled: true,
    booking: {
      id: updated.id,
      status: updated.status,
      redemption_source: updated.redemption_source,
      price_paid: updated.price_paid,
      payment_due_by: updated.payment_due_by,
    },
    amountCharged: amount,
  }
}
