/**
 * Booking money back to the customer, done in Retool (the Worker's /api/bookings/refund and
 * /api/bookings/partial-refund are no longer used for money: they need bookings.stripe_payment_id,
 * which nothing sets, and the full refund refunded the WHOLE PaymentIntent — add-ons, products and
 * all). Writes, so no read-only getter may import it (CLAUDE.md).
 *
 * Which order paid what: a booking's seat money can sit on more than one order — the original
 * order's booking line, plus one order per guest added later (saved card / reader / cash), plus a
 * move's extra charge. Card refunds go against those booking lines NEWEST FIRST: a partial refund
 * (remove a guest, a cheaper move) usually undoes the most recent change, whose money is on the
 * newest order; and taking the newest first leaves the original order's card money for its
 * add-ons and other basket items. Each order gives back at most the smaller of its card portion
 * still refundable (shared/orderCardPortion) and what its booking line still holds (line total
 * less promo less card already refunded on it), so a booking refund never dips into the same
 * order's add-on or product money. Whatever the cards can't take goes to store credit (reason
 * 'refund', with the booking's own order and the booking).
 *
 * A guest's saved-card or reader payment writes the whole charge on its booking line, add-ons
 * included, and the add-ons also have their own lines on that order. Everywhere else the booking
 * line holds the seat alone and order_total is the sum of the two. So the paid add-ons are taken
 * off a booking line only by as much as the order's lines add up to more than its total.
 */
import { refundPaymentIntent } from './refundPaymentIntent'
import { giveStoreCredit, storeCreditMoved } from './storeCreditRefund'
import { loadOrderCardPortion, type OrderCardPortion } from './orderCardPortion'
import { recomputeOrdersPaymentStatus } from './orderPaymentStatus'
import { startsWithinRealHours } from './londonTime'
import { ADDONS_INSIDE_LINE, loadBookingLines, type BookingLineRow } from './bookingMoneyLeft'
import { claimCancel, finishRefundClaim, putBackCancel, putBackCancelAsOwed } from './bookingMoneyClaim'
import { noteRefusedCardRefund, pence, refusedCardRefunds } from './cardRefundAttempts'
import { STRIPE_KEY_SAFE_HOURS, cardRefundWithKey } from './stripeRefundLookup'
import { READER_PAYMENT_OPEN_MESSAGE, anyReaderPaymentOpenOnBooking } from './readerPaymentOpen'

const round2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => `£${n.toFixed(2)}`
const detail = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Wording matches cancelCreditBooking (and the old card refund endpoint's) 24-hour rejection. */
export const WITHIN_24_HOURS_MESSAGE = 'Not eligible for refund or credit — within 24 hours of session start.'

/** What staff are told when nobody can say whether the money went. */
export const REFUND_UNSURE_MESSAGE = 'This may have gone through. Check Stripe or their balance, then use It already arrived or Refund the rest.'

export interface BookingMoneyBack {
  cardRefunded: number
  storeCreditRefunded: number
  storeCreditBalance?: number
  /** Card given back per booking line (order_line_items.id). */
  cardByLine: Array<{ lineId: string; orderId: string; amount: number }>
  /** The booking's own order (the store credit movement is linked to it). */
  ownOrderId: string | null
  /** Booking lines with no seat money on them, which a cancel must not stamp as refunded. */
  noSeatMoneyLineIds: string[]
  warning?: string
  /** What reached neither the card nor store credit. `warning` tells staff to add it by hand. */
  shortfall?: number
  /** `warning` less that line, for a caller that leaves the shortfall on the booking instead, where
   *  adding it by hand as well would refund it twice. */
  warningWithoutShortfall?: string
  /** The shortfall may have reached the customer: a card refund or store credit gave no clear answer.
   *  The caller keeps it on the booking as owed, and a cancel can't finish. */
  unsure?: boolean
}

/**
 * What staff are told by a caller that keeps the booking and takes only what was given back off
 * price_paid: a shortfall is still on the booking, held in refund_owed_amount, so they use Refund
 * the rest rather than add it by hand, and the figures stay true. Store credit that may have landed
 * is checked for first.
 */
export function shortfallStaysOnBookingWarnings(back: BookingMoneyBack): string[] {
  if (!back.shortfall) return back.warning ? [back.warning] : []
  const givenBack = round2(back.cardRefunded + back.storeCreditRefunded)
  return [
    ...(back.warningWithoutShortfall ? [back.warningWithoutShortfall] : []),
    back.unsure
      ? `${money(givenBack)} was refunded. The other ${money(back.shortfall)} is still on the booking. ${REFUND_UNSURE_MESSAGE}`
      : `${money(givenBack)} was refunded, but the other ${money(back.shortfall)} may not have reached store credit. It is still on the booking: check their balance, then use Refund the rest if it isn't there.`,
  ]
}

/**
 * A card refund's key. `pricePaid` is what the booking held just before this refund, so with what
 * the order has had back it is the state a retry finds again: a lost refund changes neither, as
 * nothing recorded it, and the claim it came from has gone back as owed. A refund recorded in
 * between raises `alreadyRefunded`, so the same amount on the same figures later is a new refund.
 */
const cardRefundKey = (lineId: string, pricePaid: number, alreadyRefunded: number, amount: number, refused: number) =>
  `booking-refund:${lineId}:${pence(pricePaid)}:${pence(alreadyRefunded)}:${pence(amount)}:${refused}`

/**
 * The keys of this booking's card refunds that got no clear answer longer ago than Stripe is sure to
 * keep a key (`booking.card_refund_unsure`, written below). One of those is never sent again: Refund
 * the rest builds the same key, and after 24 hours a resend could be a second refund. Throws if it
 * can't look.
 */
async function unsureCardRefundsPastKeyLife(bookingId: string): Promise<Set<string>> {
  const found = await paddockData.query<{ key: string }>(
    `SELECT details->>'key' AS key FROM audit_log
     WHERE action = 'booking.card_refund_unsure' AND entity_type = 'booking' AND entity_id = $1
     GROUP BY details->>'key'
     HAVING min(at) < now() - make_interval(hours => $2)`,
    [bookingId, STRIPE_KEY_SAFE_HOURS]
  )
  return new Set(found.data.map((row) => row.key))
}

/** A card refund with no clear answer, kept with its key so a press a day later looks for it rather
 *  than sending it again. Failing to write it leaves only the 24-hour window unguarded. */
async function noteUnsureCardRefund(args: { bookingId: string; staffId: string | null; key: string; paymentIntentId: string; amount: number }): Promise<void> {
  try {
    await paddockData.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       VALUES ('staff', $1, 'booking.card_refund_unsure', 'booking', $2, $3::jsonb)`,
      [args.staffId, args.bookingId, JSON.stringify({ key: args.key, paymentIntentId: args.paymentIntentId, amount: args.amount })]
    )
  } catch {
    // The refund's outcome is already in hand: this only guards a resend a day later.
  }
}

/**
 * Gives `amount` of a booking's seat money back: card first ('card' only) across the booking's
 * orders newest first, the rest to store credit. Never throws, so a caller can't lose track of
 * money that has already gone. Three outcomes:
 *  - `ok: false`: nothing moved, and the caller puts the claim back.
 *  - `ok: false, unsure: true`: no clear answer from the first card refund, or from store credit even
 *    after looking for it (shared/storeCreditRefund), so the money may have gone. The caller keeps
 *    the claim and puts it on the booking as owed.
 *  - `ok: true`: what went is in `result`. Once any card refund has gone through, a later failure (a
 *    card refund, or a database error reading the next order or adding the store credit) is a
 *    warning on this. A later order saying no sends the rest to store credit, so money is never left
 *    half returned. One giving no clear answer stops there, with `shortfall` and `unsure`, because
 *    sending the rest to store credit could pay it twice.
 *
 * `pricePaidBefore`: price_paid before the claim. It goes in each card refund's key. A key whose
 * earlier refund got no clear answer more than STRIPE_KEY_SAFE_HOURS ago is looked for on Stripe
 * (through `user`), never sent again: found, it went; not found, it never did, and is counted as a
 * refusal so a new key is sent.
 * `recordCardOnLines`: add each card refund to its booking line's card_refunded_amount straight away
 * (partial refunds); a full cancel records them inside its own guarded statement instead.
 */
export async function giveBookingMoneyBack(args: {
  bookingId: string
  customerId: string
  amount: number
  method: 'card' | 'credit'
  staffId: string | null
  /** Who is acting: an old refund with no clear answer is looked for on Stripe through the Worker. */
  user: User
  note: string
  recordCardOnLines: boolean
  pricePaidBefore: number
}): Promise<{ ok: true; result: BookingMoneyBack } | { ok: false; message: string; unsure?: true }> {
  const amount = round2(args.amount)
  let lines: BookingLineRow[]
  try {
    lines = await loadBookingLines(args.bookingId)
  } catch (err) {
    return { ok: false, message: `Looking up the booking's payments failed, so nothing was refunded: ${detail(err)}` }
  }
  const ownOrderId = lines.length > 0 ? lines[lines.length - 1]!.order_id : null
  const result: BookingMoneyBack = {
    cardRefunded: 0,
    storeCreditRefunded: 0,
    cardByLine: [],
    ownOrderId,
    noSeatMoneyLineIds: lines.filter((line) => line.no_seat_money).map((line) => line.id),
  }
  const warnings: string[] = []
  if (!(amount > 0)) return { ok: true, result }

  let left = amount
  // Why the card refunds stopped early, once some had gone through.
  let cardStopped: string | null = null
  // The card refund that gave no clear answer, once some had gone through.
  let cardUnsure: string | null = null
  if (args.method === 'card') {
    let refused: number
    let pastKeyLife: Set<string>
    try {
      ;[refused, pastKeyLife] = await Promise.all([refusedCardRefunds(args.bookingId), unsureCardRefundsPastKeyLife(args.bookingId)])
    } catch (err) {
      return { ok: false, message: `Checking the card payment failed, so nothing was refunded: ${detail(err)}` }
    }
    for (const line of lines) {
      if (left <= 0.005) break
      let portion: OrderCardPortion | null
      try {
        portion = await loadOrderCardPortion(line.order_id)
      } catch (err) {
        if (result.cardRefunded <= 0) {
          return { ok: false, message: `Checking the card payment failed, so nothing was refunded: ${detail(err)}` }
        }
        cardStopped = `Checking the next card payment failed (${detail(err)})`
        break
      }
      if (!portion?.paymentIntentId) continue
      const take = round2(Math.min(left, portion.cardPortionRemaining, Number.parseFloat(line.net_remaining)))
      if (take <= 0) continue
      let key = cardRefundKey(line.id, args.pricePaidBefore - result.cardRefunded, portion.alreadyCardRefunded, take, refused)
      let refunded: { ok: boolean; unsure?: boolean; message?: string }
      let looked = false
      if (pastKeyLife.has(key)) {
        // Sent before with no clear answer, longer ago than Stripe is sure to keep the key.
        looked = true
        try {
          const found = await cardRefundWithKey(args.user, portion.paymentIntentId, key)
          if (found) {
            refunded = { ok: true }
          } else {
            await noteRefusedCardRefund({ bookingId: args.bookingId, staffId: args.staffId, amount: take, message: 'Stripe has no refund with its key, so it never went.' })
            refused += 1
            key = cardRefundKey(line.id, args.pricePaidBefore - result.cardRefunded, portion.alreadyCardRefunded, take, refused)
            refunded = await refundPaymentIntent(portion.paymentIntentId, take, key)
            looked = false
          }
        } catch (err) {
          refunded = { ok: false, unsure: true, message: `an earlier refund of ${money(take)} got no clear answer more than a day ago, and checking Stripe for it failed: ${detail(err)}` }
        }
      } else {
        refunded = await refundPaymentIntent(portion.paymentIntentId, take, key)
      }
      if (!refunded.ok && refunded.unsure && !looked) {
        await noteUnsureCardRefund({ bookingId: args.bookingId, staffId: args.staffId, key, paymentIntentId: portion.paymentIntentId, amount: take })
      }
      if (!refunded.ok) {
        if (refunded.unsure) {
          if (result.cardRefunded <= 0) return { ok: false, unsure: true, message: `The card refund gave no clear answer: ${refunded.message ?? 'unknown error'}` }
          cardUnsure = `A further card refund of ${money(take)} gave no clear answer (${refunded.message ?? 'unknown error'}).`
          break
        }
        await noteRefusedCardRefund({ bookingId: args.bookingId, staffId: args.staffId, amount: take, message: refunded.message })
        if (result.cardRefunded <= 0) {
          return { ok: false, message: `The card refund failed, so nothing was refunded: ${refunded.message ?? 'unknown error'}` }
        }
        cardStopped = `A further card refund of ${money(take)} failed (${refunded.message ?? 'unknown error'})`
        break
      }
      result.cardByLine.push({ lineId: line.id, orderId: line.order_id, amount: take })
      result.cardRefunded = round2(result.cardRefunded + take)
      left = round2(left - take)
      if (args.recordCardOnLines) {
        try {
          await paddockData.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1 WHERE id = $2', [
            take,
            line.id,
          ])
        } catch (err) {
          warnings.push(
            `${money(take)} went back to the card but recording it on its order failed — check before refunding this booking again: ${detail(err)}`
          )
        }
      }
    }
  }

  let shortfallWarning: string | null = null
  if (cardUnsure) {
    result.unsure = true
    result.shortfall = left
    shortfallWarning = `${money(result.cardRefunded)} went back to the card. ${cardUnsure} The other ${money(left)} may have gone through: check Stripe.`
  } else if (left > 0.005) {
    // After a database error the credit is looked for by its note: only a failed look stays unsure.
    const given = await giveStoreCredit({
      customerId: args.customerId,
      amount: left,
      reason: 'refund',
      orderId: ownOrderId,
      bookingId: args.bookingId,
      staffId: args.staffId,
      note: result.cardRefunded > 0 ? `${args.note} (the rest went back to the card).` : `${args.note}.`,
    })
    const unsure = given.outcome === 'unsure' ? given.message : null
    if (given.outcome !== 'given') {
      if (result.cardRefunded <= 0) {
        return unsure
          ? { ok: false, unsure: true, message: `Adding the store credit gave no clear answer: ${unsure}` }
          : { ok: false, message: 'Adding the store credit failed, so nothing was refunded.' }
      }
      if (cardStopped) warnings.push(`${cardStopped}.`)
      shortfallWarning = unsure
        ? `${money(result.cardRefunded)} went back to the card, but adding the ${money(left)} remainder to store credit failed (${unsure}) — check their balance, then add it by hand if it isn't there.`
        : `${money(result.cardRefunded)} went back to the card, but adding the ${money(left)} remainder to store credit failed — add it by hand.`
      result.shortfall = left
      if (unsure) result.unsure = true
    } else {
      if (cardStopped) warnings.push(`${cardStopped}, so the rest went to store credit.`)
      result.storeCreditRefunded = left
      if (given.balance !== undefined) result.storeCreditBalance = given.balance
    }
  }
  // Partial refunds: every order whose booking line took card money back, plus the booking's own
  // order (the store credit is linked to it). A full cancel recomputes after its own statement.
  if (args.recordCardOnLines && result.cardRefunded + result.storeCreditRefunded > 0) {
    const statusWarning = await recomputeOrdersPaymentStatus([...result.cardByLine.map((c) => c.orderId), ownOrderId])
    if (statusWarning) warnings.push(statusWarning)
  }
  if (shortfallWarning && warnings.length > 0) result.warningWithoutShortfall = warnings.join(' ')
  const allWarnings = shortfallWarning ? [...warnings, shortfallWarning] : warnings
  if (allWarnings.length > 0) result.warning = allWarnings.join(' ')
  return { ok: true, result }
}

/** Who gave a refund, and why. The money has gone by now, so a failure is a warning for the caller
 *  to pass on, and never thrown. Details hold the reason, which a card refund has nowhere else to
 *  keep. The Worker writes this table from step E. */
export async function auditBookingRefund(args: {
  action: 'booking.part_refund' | 'booking.refund_owed'
  bookingId: string
  staffId: string | null
  details: { amount: number; reason?: string; method: 'card' | 'credit'; cardRefunded: number; storeCreditRefunded: number; owed: number }
}): Promise<string | undefined> {
  try {
    await paddockData.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       VALUES ('staff', $1, $2, 'booking', $3, $4::jsonb)`,
      [args.staffId, args.action, args.bookingId, JSON.stringify(args.details)]
    )
    return undefined
  } catch (err) {
    return `The refund went through, but recording it in the audit log failed: ${detail(err)}`
  }
}

/** Takes back store credit given by an action that then couldn't be recorded. A lost answer is
 *  looked for by its note (shared/storeCreditRefund), so a take-back that landed is never reported as
 *  failed, and staff never remove it a second time by hand. */
export async function takeBackStoreCredit(args: {
  customerId: string
  amount: number
  orderId: string | null
  bookingId: string
  staffId: string | null
}): Promise<boolean> {
  if (!(args.amount > 0)) return true
  return storeCreditMoved({
    customerId: args.customerId,
    amount: -args.amount,
    reason: 'refund',
    orderId: args.orderId,
    bookingId: args.bookingId,
    staffId: args.staffId,
    note: 'Automatic reversal: the refund could not be recorded on the booking.',
  })
}

/**
 * Reverses a saved-card charge the SAME action just took (a move or an added guest / add-ons whose
 * later steps failed): refunds that exact PaymentIntent and amount, then marks the charge's own
 * order (the one the Worker wrote for it) as refunded so its card portion is 0. No permission
 * check: returning money the caller's own action just took must not depend on can_issue_refunds.
 */
export async function reverseSavedCardCharge(paymentIntentId: string, amount: number): Promise<{ ok: boolean; message?: string }> {
  const refunded = await refundPaymentIntent(paymentIntentId, amount, `reverse-charge:${paymentIntentId}:${pence(amount)}`)
  if (!refunded.ok) return { ok: false, ...(refunded.message ? { message: refunded.message } : {}) }
  try {
    await paddockData.query(
      `WITH o AS (SELECT id FROM orders WHERE stripe_payment_intent_id = $1),
       l AS (
         UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $2,
                refunded_at = COALESCE(refunded_at, now()), refund_method = 'card'
         WHERE id = (SELECT oli.id FROM order_line_items oli WHERE oli.order_id IN (SELECT id FROM o)
                     ORDER BY oli.created_at LIMIT 1)
         RETURNING id
       )
       UPDATE orders SET payment_status = 'refunded', updated_at = now() WHERE id IN (SELECT id FROM o)`,
      [paymentIntentId, amount]
    )
  } catch (err) {
    return { ok: true, message: `The charge was refunded but marking its order refunded failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true }
}

/**
 * True when every penny of a booking's seat money has already gone back: the card refunds on its
 * booking lines and its store credit refunds, less the store credit that was for add-ons, reach
 * what its lines hold in seats. False when they held none, so a free booking never counts.
 */
async function seatMoneyAllBack(bookingId: string): Promise<boolean> {
  const answer = await paddockData.query<{ all_back: boolean }>(
    `WITH p AS (SELECT $1::uuid AS booking_id),
     seats AS (
       SELECT COALESCE(SUM(GREATEST(oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons, 0)), 0) AS money,
              COALESCE(SUM(oli.card_refunded_amount), 0) AS card
       FROM p
       JOIN order_line_items oli ON oli.booking_id = p.booking_id AND oli.item_type = 'booking'
       ${ADDONS_INSIDE_LINE}
     ),
     credit AS (
       SELECT COALESCE(SUM(sct.amount), 0) AS back
       FROM p JOIN store_credit_transactions sct ON sct.booking_id = p.booking_id AND sct.reason = 'refund'
     ),
     addons AS (
       SELECT COALESCE(SUM(aol.refunded_amount - aol.card_refunded_amount), 0) AS credit
       FROM p JOIN addon_order_lines aol ON aol.booking_id = p.booking_id
     )
     SELECT seats.money > 0 AND seats.card + credit.back - addons.credit >= seats.money AS all_back
     FROM seats, credit, addons`,
    [bookingId]
  )
  return answer.data[0]?.all_back === true
}

/**
 * After a cancel that gave no money itself (a credit booking at £0): when all the booking's seat
 * money has already gone back, stamps the lines that held it and works out their orders' status
 * again. The booking is already cancelled, so a failure is a warning and never thrown.
 */
export async function stampLinesIfSeatMoneyAllBack(bookingId: string): Promise<string | undefined> {
  try {
    if (!(await seatMoneyAllBack(bookingId))) return undefined
    const stamped = await paddockData.query<{ order_id: string }>(
      `UPDATE order_line_items
       SET refunded_at = COALESCE(refunded_at, now()),
           refund_method = COALESCE(refund_method, CASE WHEN card_refunded_amount > 0 THEN 'card' ELSE 'credit' END)
       WHERE id IN (
         SELECT oli.id
         FROM order_line_items oli
         ${ADDONS_INSIDE_LINE}
         WHERE oli.booking_id = $1 AND oli.item_type = 'booking'
           AND oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons > 0
       )
       RETURNING order_id`,
      [bookingId]
    )
    return await recomputeOrdersPaymentStatus(stamped.data.map((row) => row.order_id))
  } catch (err) {
    return `Marking the booking's orders refunded failed and needs a manual check: ${detail(err)}`
  }
}

/**
 * After Remove Guest gave a seat's money back: stamps the booking line the guest was paid on, so
 * its order can say refunded. Nothing links a guest to their line, so it is the newest unstamped
 * line holding no more than the seat. With two guests at one price either line is right: the money
 * is the same. The booking's first line holds the seats it was made with, so it only counts once
 * nothing is left on the booking. Never throws: the guest has gone.
 */
export async function stampRemovedGuestLine(bookingId: string, seatPrice: number): Promise<string | undefined> {
  try {
    const stamped = await paddockData.query<{ order_id: string }>(
      `WITH seat AS (
         SELECT oli.id
         FROM order_line_items oli
         ${ADDONS_INSIDE_LINE}
         WHERE oli.booking_id = $1 AND oli.item_type = 'booking' AND oli.refunded_at IS NULL
           AND oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons > 0
           AND oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons <= $2::numeric
           AND (
             EXISTS (
               SELECT 1 FROM order_line_items earlier
               WHERE earlier.booking_id = oli.booking_id AND earlier.item_type = 'booking'
                 AND (earlier.created_at, earlier.id) < (oli.created_at, oli.id)
             )
             OR (SELECT COALESCE(b.price_paid, 0) FROM bookings b WHERE b.id = oli.booking_id) <= 0
           )
         ORDER BY oli.created_at DESC, oli.id DESC
         LIMIT 1
       )
       UPDATE order_line_items
       SET refunded_at = now(), refund_method = CASE WHEN card_refunded_amount > 0 THEN 'card' ELSE 'credit' END
       WHERE id IN (SELECT id FROM seat)
       RETURNING order_id`,
      [bookingId, seatPrice]
    )
    return await recomputeOrdersPaymentStatus(stamped.data.map((row) => row.order_id))
  } catch (err) {
    return `Marking the guest's order refunded failed and needs a manual check: ${detail(err)}`
  }
}

export interface CancelAndRefundResult {
  cancelled: boolean
  /** 'refund_unsure': the money may have gone, so the booking went back to live with it owed. */
  reason?: string
  message?: string
  cardRefundedAmount?: number
  storeCreditRefundedAmount?: number
  storeCreditBalance?: number
  warning?: string
}

/**
 * Cancel & Refund: refuses inside 24 real hours of the session (startsWithinRealHours, as
 * everywhere else); claims the booking by cancelling it (claimCancel), so nothing else can touch its
 * money; gives its seat money (price_paid) back with giveBookingMoneyBack; then ONE statement
 * releases its capacity (private: the whole session; public: its party), records the card refunds
 * on the booking lines and stamps refunded those that held seat money, when this cancel gave money
 * back or all of it had gone back already. If no money moved, or that statement fails, the booking
 * goes back to the status it had. After a failed statement the store credit is taken back and the
 * card refunds are recorded on their lines, with price_paid lowered by them: the booking stays
 * live, so that money pays off anything owed first, the rest is a part refund, and nothing is left
 * given back without a record or asked for again. A retry only refunds the rest. price_paid
 * includes refund_owed_amount, so a cancel gives that too and clears it.
 *
 * Money with no clear answer can't stay on a cancelled booking, which has no button left to give it.
 * So the booking goes back to the status it had, with what went recorded the same way and all the
 * rest owed, and a retry's card refund has the same key as the first.
 */
export async function cancelAndRefundBooking(args: {
  bookingId: string
  method: 'card' | 'credit'
  staffId: string | null
  user: User
}): Promise<CancelAndRefundResult> {
  const lookup = await paddockData.query<{
    customer_id: string
    status: string
    price_paid: string | null
    party_size: number
    session_id: string
    start_time: string
    booking_type: 'public' | 'private'
  }>(
    `SELECT b.customer_id, b.status, b.price_paid, b.party_size, b.session_id, s.start_time, st.booking_type
     FROM bookings b JOIN sessions s ON s.id = b.session_id JOIN service_types st ON st.id = s.service_type_id
     WHERE b.id = $1`,
    [args.bookingId]
  )
  const booking = lookup.data[0]
  if (!booking) return { cancelled: false, reason: 'booking_not_found', message: 'Booking not found.' }
  if (booking.status === 'cancelled') return { cancelled: false, reason: 'already_cancelled', message: 'This booking is already cancelled.' }
  if (startsWithinRealHours(booking.start_time, 24)) {
    return { cancelled: false, reason: 'within_24_hours', message: WITHIN_24_HOURS_MESSAGE }
  }
  const pricePaid = round2(Number.parseFloat(booking.price_paid ?? '0'))
  // With nothing left to give, only earlier refunds can make its lines refunded. Read before any
  // write, so a failure here changes nothing.
  const allBackAlready = pricePaid > 0 ? false : await seatMoneyAllBack(args.bookingId)

  let claim: Awaited<ReturnType<typeof claimCancel>>
  try {
    claim = await claimCancel({ bookingId: args.bookingId, seenStatus: booking.status, seenPricePaid: pricePaid, staffId: args.staffId, method: args.method })
  } catch (err) {
    return {
      cancelled: false,
      reason: 'unexpected_error',
      message: `Recording the cancellation failed, so the booking was not cancelled and nothing was refunded: ${detail(err)}`,
    }
  }
  if (!claim.claimed) {
    if (await anyReaderPaymentOpenOnBooking(args.bookingId)) {
      return { cancelled: false, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
    }
    return {
      cancelled: false,
      reason: 'booking_changed',
      message: 'The booking changed while it was being cancelled, so it was not cancelled. Reload and try again.',
    }
  }
  const { claimId } = claim
  const finish = async (outcome: 'given' | 'put_back' | 'owed', figures: { cardRefunded?: number; storeCreditRefunded?: number; owed?: number } = {}) => {
    if (claimId) await finishRefundClaim({ claimId, bookingId: args.bookingId, staffId: args.staffId, outcome, ...figures })
  }
  /** Says so if it can't, as staff would otherwise see a cancelled booking that kept its place. */
  const uncancel = async (putBack: (bookingId: string, status: string) => Promise<void> = putBackCancel): Promise<string | null> => {
    try {
      await putBack(args.bookingId, booking.status)
      return null
    } catch (err) {
      return `The booking still shows as cancelled, but it wasn't, and its session place is still held — check it by hand: ${detail(err)}`
    }
  }
  /** The booking stays live, so card money that went is recorded and comes off it: it pays off
   *  anything owed first, and the rest is a part refund. Answers what staff should be told. */
  const recordCardOnLiveBooking = async (back: BookingMoneyBack): Promise<string[]> => {
    if (back.cardRefunded <= 0) return []
    const notes: string[] = []
    try {
      for (const c of back.cardByLine) {
        await paddockData.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1 WHERE id = $2', [c.amount, c.lineId])
      }
      await paddockData.query(
        `UPDATE bookings
         SET price_paid = GREATEST(COALESCE(price_paid, 0) - $1, 0),
             part_refunded_amount = part_refunded_amount + GREATEST($2::numeric - refund_owed_amount, 0),
             refund_owed_amount = GREATEST(refund_owed_amount - $3::numeric, 0),
             updated_at = now()
         WHERE id = $4`,
        [back.cardRefunded, back.cardRefunded, back.cardRefunded, args.bookingId]
      )
      notes.push(`${money(back.cardRefunded)} had already gone back to the card; it is recorded on the order and taken off the booking's price paid, so retrying refunds only the rest.`)
    } catch {
      notes.push(`${money(back.cardRefunded)} had already gone back to the card and recording it failed — check in Stripe before retrying.`)
    }
    const statusWarning = await recomputeOrdersPaymentStatus(back.cardByLine.map((c) => c.orderId))
    if (statusWarning) notes.push(statusWarning)
    return notes
  }

  const given = await giveBookingMoneyBack({
    bookingId: args.bookingId,
    customerId: booking.customer_id,
    amount: pricePaid,
    method: args.method,
    staffId: args.staffId,
    user: args.user,
    note: 'Booking refund',
    recordCardOnLines: false,
    pricePaidBefore: pricePaid,
  })
  if (!given.ok) {
    const stuck = await uncancel(given.unsure ? putBackCancelAsOwed : putBackCancel)
    await finish(given.unsure ? 'owed' : 'put_back', given.unsure ? { owed: pricePaid } : {})
    return {
      cancelled: false,
      reason: given.unsure ? 'refund_unsure' : 'refund_failed',
      message: given.unsure ? REFUND_UNSURE_MESSAGE : given.message,
      ...(stuck ? { warning: stuck } : {}),
    }
  }
  const back = given.result
  if (back.unsure) {
    const notes = await recordCardOnLiveBooking(back)
    const stuck = await uncancel(putBackCancelAsOwed)
    await finish('owed', { cardRefunded: back.cardRefunded, owed: back.shortfall ?? 0 })
    return {
      cancelled: false,
      reason: 'refund_unsure',
      message: `${money(back.cardRefunded)} went back to the card, and the other ${money(back.shortfall ?? 0)} is still on the booking. ${REFUND_UNSURE_MESSAGE}`,
      ...(stuck || notes.length > 0 ? { warning: [...(stuck ? [stuck] : []), ...notes].join(' ') } : {}),
    }
  }

  try {
    const done = await paddockData.query<{ id: string }>(
      `WITH p AS (
         SELECT $1::uuid AS booking_id, $2::numeric AS price_paid, $3::boolean AS private_session, $4::int AS party_size,
                $5::uuid[] AS line_ids, $6::numeric[] AS line_cards, $7::boolean AS refunded_any, $8::uuid[] AS no_seat_money
       ),
       bk AS (
         UPDATE bookings b SET refund_owed_amount = 0, updated_at = now()
         FROM p
         WHERE b.id = p.booking_id AND b.status = 'cancelled' AND b.price_paid = p.price_paid
         RETURNING b.id, b.session_id
       ),
       rel AS (
         UPDATE sessions s
         SET total_booked = CASE WHEN p.private_session THEN 0 ELSE GREATEST(s.total_booked - p.party_size, 0) END,
             updated_at = now()
         FROM bk, p
         WHERE s.id = bk.session_id
         RETURNING s.id
       ),
       cards AS (
         SELECT x.line_id, x.card FROM p, unnest(p.line_ids, p.line_cards) AS x(line_id, card)
       ),
       lines AS (
         UPDATE order_line_items oli
         SET card_refunded_amount = oli.card_refunded_amount + COALESCE((SELECT c.card FROM cards c WHERE c.line_id = oli.id), 0),
             refunded_at = CASE WHEN p.refunded_any AND oli.id <> ALL(p.no_seat_money) THEN COALESCE(oli.refunded_at, now()) ELSE oli.refunded_at END,
             refund_method = CASE
               WHEN NOT p.refunded_any OR oli.id = ANY(p.no_seat_money) THEN oli.refund_method
               WHEN oli.card_refunded_amount + COALESCE((SELECT c.card FROM cards c WHERE c.line_id = oli.id), 0) > 0 THEN 'card'
               ELSE 'credit' END
         FROM bk, p
         WHERE oli.booking_id = bk.id AND oli.item_type = 'booking'
         RETURNING oli.id
       )
       SELECT bk.id, (SELECT count(*) FROM rel) AS released, (SELECT count(*) FROM lines) AS lines FROM bk`,
      [
        args.bookingId,
        pricePaid,
        booking.booking_type === 'private',
        booking.party_size,
        back.cardByLine.map((c) => c.lineId),
        back.cardByLine.map((c) => c.amount),
        back.cardRefunded + back.storeCreditRefunded > 0 || allBackAlready,
        back.noSeatMoneyLineIds,
      ]
    )
    if (done.data.length === 0) throw new Error('booking_changed')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const notes: string[] = []
    const stuck = await uncancel()
    if (stuck) notes.push(stuck)
    if (back.storeCreditRefunded > 0) {
      const ok = await takeBackStoreCredit({
        customerId: booking.customer_id,
        amount: back.storeCreditRefunded,
        orderId: back.ownOrderId,
        bookingId: args.bookingId,
        staffId: args.staffId,
      })
      notes.push(ok ? `The ${money(back.storeCreditRefunded)} store credit was taken back.` : `Taking back the ${money(back.storeCreditRefunded)} store credit failed — remove it by hand.`)
    }
    notes.push(...(await recordCardOnLiveBooking(back)))
    await finish('put_back', { cardRefunded: back.cardRefunded })
    return {
      cancelled: false,
      reason: message === 'booking_changed' ? 'booking_changed' : 'unexpected_error',
      message:
        message === 'booking_changed'
          ? 'The booking changed while it was being cancelled, so it was not cancelled. Reload and try again.'
          : `Recording the cancellation failed, so the booking was not cancelled: ${message}`,
      ...(notes.length > 0 ? { warning: notes.join(' ') } : {}),
    }
  }

  // EVERY order with a booking line for this booking: the statement stamped them all bar any with no
  // seat money, not only the ones a card refund came from (a guest's own order is refunded too).
  // The booking is cancelled and the money has gone, so a failure here is a warning: staff reading
  // an error would refund by hand, and the caller still has the ticked add-ons to do.
  const warnings: string[] = back.warning ? [back.warning] : []
  let bookingOrderIds: string[] = []
  try {
    const bookingOrders = await paddockData.query<{ order_id: string }>(
      `SELECT DISTINCT order_id FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking'`,
      [args.bookingId]
    )
    bookingOrderIds = bookingOrders.data.map((r) => r.order_id)
  } catch (err) {
    warnings.push(`The booking was cancelled and refunded, but reading its orders failed, so their payment status needs a manual check: ${detail(err)}`)
  }
  const statusWarning = await recomputeOrdersPaymentStatus([
    ...bookingOrderIds,
    ...back.cardByLine.map((c) => c.orderId),
    back.ownOrderId,
  ])
  if (statusWarning) warnings.push(statusWarning)
  await finish('given', { cardRefunded: back.cardRefunded, storeCreditRefunded: back.storeCreditRefunded, owed: back.shortfall ?? 0 })
  return {
    cancelled: true,
    cardRefundedAmount: back.cardRefunded,
    storeCreditRefundedAmount: back.storeCreditRefunded,
    ...(back.storeCreditBalance !== undefined ? { storeCreditBalance: back.storeCreditBalance } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  }
}
