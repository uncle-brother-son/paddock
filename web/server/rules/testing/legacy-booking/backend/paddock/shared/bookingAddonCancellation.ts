/**
 * Cancels add-on lines on a booking, with their refund. Shared by Cancel & Refund (refundBooking),
 * Cancel & return credit (cancelCreditBooking) and Remove add-on (removeBookingAddon). Writes, so no
 * read-only getter may import it (CLAUDE.md).
 *
 *  1. Claim: the chosen lines still active are stamped removed (removed_at / removed_by) in one
 *     guarded UPDATE, so two staff can never refund the same line twice. Only claimed lines go on.
 *  2. 24-hour rule: inside 24 real hours of the session start (shared/londonTime, the same check
 *     the booking refunds use) no money goes back and no add-on credit is returned — the lines are
 *     still cancelled, with refund_method 'none'.
 *  3. Paid lines: what was actually paid for each, price_at_purchase × quantity (booking add-ons
 *     get no share of an order promo — createOrder only spreads promos over standalone add-ons).
 *     Per paying order (the line's order_id): card first, capped at that order's card portion
 *     still refundable (shared/orderCardPortion, which counts earlier add-on card refunds too), the
 *     rest to store credit (reason 'refund', with orderId). A failed card refund or store credit
 *     un-claims that order's lines (they stay active) and says so. One with no clear answer may
 *     have gone, so the claim stands: the lines stay removed, and the money goes on a live booking
 *     as owed, for Refund the rest or It already arrived. A cancelled booking has neither, so staff
 *     are told to check by hand.
 *  4. Credit lines (membership_credit): the add-on credits go back to redeemed_membership_id while
 *     that membership is still active (refund_method 'credit_returned'); otherwise the result
 *     says the credit couldn't come back.
 *  5. The claimed lines get their refunded / card amounts and refund_method; each paying order's
 *     payment_status is recomputed.
 */
import { giveStoreCredit } from './storeCreditRefund'
import { refundPaymentIntent } from './refundPaymentIntent'
import { putBackAsOwed } from './bookingMoneyClaim'
import { REFUND_UNSURE_MESSAGE } from './bookingRefund'
import { noteRefusedCardRefund, pence, refusedCardRefunds } from './cardRefundAttempts'
import { loadOrderCardPortion, type OrderCardPortion } from './orderCardPortion'
import { recomputeOrderPaymentStatus } from './orderPaymentStatus'
import { startsWithinRealHours } from './londonTime'

export type AddonRefundChoice = 'card' | 'credit' | 'none'

export interface CancelAddonLinesInput {
  bookingId: string
  lineIds: string[]
  /** How PAID lines are refunded ('none' cancels them with nothing back). */
  refund: AddonRefundChoice
  /** Give add-on credits back for membership-credit lines (subject to the 24-hour rule). */
  returnCredits: boolean
  /** false: only membership-credit lines are touched; paid lines are left as they are (the
   *  no-money cancel paths — paid add-ons are refunded with Cancel & Refund or Remove). */
  includePaidLines: boolean
  staffId: string | null
}

export interface CancelAddonLinesResult {
  /** Lines cancelled (removed) by this call. */
  cancelledLineIds: string[]
  refundedAmount: number
  cardRefundedAmount: number
  storeCreditRefundedAmount: number
  /** Add-on credits given back to memberships. */
  creditsReturned: number
  storeCreditBalance?: number
  /** Plain-words notes for staff (24-hour rule, a membership no longer active, a line already
   *  removed). */
  notes: string[]
  /** Something that needs a manual check (money moved but a later step failed, or a refund
   *  failed so those add-ons were left as they were). */
  warning?: string
}

interface LineRow {
  id: string
  addon_name: string
  quantity: number
  price_at_purchase: string
  redemption_source: string | null
  redeemed_membership_id: string | null
  order_id: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => `£${n.toFixed(2)}`
const detail = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function cancelBookingAddonLines(input: CancelAddonLinesInput): Promise<CancelAddonLinesResult> {
  const { bookingId, refund, returnCredits, includePaidLines, staffId } = input
  const result: CancelAddonLinesResult = {
    cancelledLineIds: [],
    refundedAmount: 0,
    cardRefundedAmount: 0,
    storeCreditRefundedAmount: 0,
    creditsReturned: 0,
    notes: [],
  }
  const warnings: string[] = []
  const lineIds = [...new Set(input.lineIds)]
  if (lineIds.length === 0) return result

  const bookingLookup = await paddockData.query<{ customer_id: string; start_time: string; status: string }>(
    `SELECT b.customer_id, s.start_time, b.status FROM bookings b JOIN sessions s ON s.id = b.session_id WHERE b.id = $1`,
    [bookingId]
  )
  const booking = bookingLookup.data[0]
  if (!booking) {
    result.notes.push('The booking no longer exists, so no add-ons were cancelled.')
    return result
  }

  // --- 1. Claim the lines still active ---------------------------------------------------------
  const claimed = await paddockData.query<LineRow>(
    `UPDATE addon_order_lines aol
     SET removed_at = now(), removed_by = $1
     FROM addons a
     WHERE a.id = aol.addon_id AND aol.id = ANY($2::uuid[]) AND aol.booking_id = $3 AND aol.removed_at IS NULL
       AND ($4::boolean OR aol.redemption_source = 'membership_credit')
     RETURNING aol.id, a.name AS addon_name, aol.quantity, aol.price_at_purchase, aol.redemption_source,
               aol.redeemed_membership_id, aol.order_id`,
    [staffId, lineIds, bookingId, includePaidLines]
  )
  const lines = claimed.data
  if (lines.length < lineIds.length && includePaidLines) {
    result.notes.push(`${lineIds.length - lines.length} add-on${lineIds.length - lines.length === 1 ? ' was' : 's were'} already removed.`)
  }
  if (lines.length === 0) return result

  const unclaim = async (ids: string[]) => {
    if (ids.length === 0) return
    // Never throws: an earlier order's refund may have gone through and still has to be recorded.
    try {
      await paddockData.query('UPDATE addon_order_lines SET removed_at = NULL, removed_by = NULL WHERE id = ANY($1::uuid[])', [ids])
    } catch (err) {
      warnings.push(`Putting ${ids.length === 1 ? 'an add-on' : 'add-ons'} back on the booking failed, so it may show as removed — check it: ${detail(err)}`)
    }
  }

  // --- 2. 24-hour rule ----------------------------------------------------------------------------
  const inside24Hours = startsWithinRealHours(booking.start_time, 24)
  const paidRefund: AddonRefundChoice = inside24Hours ? 'none' : refund
  const giveCreditsBack = returnCredits && !inside24Hours
  const paidLines = lines.filter((l) => l.redemption_source !== 'membership_credit')
  const creditLines = lines.filter((l) => l.redemption_source === 'membership_credit')
  if (inside24Hours && ((refund !== 'none' && paidLines.length > 0) || (returnCredits && creditLines.length > 0))) {
    result.notes.push('Inside 24 hours of the session, so no add-on money or credit was given back.')
  }

  /** No clear answer on this much, for these add-ons: the claim stands. On a live booking it is
   *  owed, and on a cancelled one nothing can give it, so staff check by hand. */
  const keepAsOwed = async (amount: number, group: LineRow[]) => {
    const names = group.map((l) => l.addon_name).join(', ')
    if (booking.status === 'cancelled') {
      warnings.push(`${money(amount)} for ${names} may have gone through. Check Stripe or their balance, and give it by hand if it isn't there.`)
      return
    }
    try {
      await putBackAsOwed(bookingId, amount)
      warnings.push(`${money(amount)} for ${names}: ${REFUND_UNSURE_MESSAGE}`)
    } catch (err) {
      warnings.push(`${money(amount)} for ${names} may have gone through, and marking it as owed failed. Check Stripe or their balance, and give it by hand if it isn't there: ${detail(err)}`)
    }
  }

  // Per line: what goes back and how.
  const stamp = new Map<string, { refunded: number; card: number; method: 'card' | 'credit' | 'none' | 'credit_returned' }>()

  // --- 3. Paid lines, per paying order ------------------------------------------------------------
  const affectedOrders = new Set<string>()
  if (paidRefund === 'none') {
    for (const line of paidLines) stamp.set(line.id, { refunded: 0, card: 0, method: 'none' })
  } else {
    const byOrder = new Map<string, LineRow[]>()
    for (const line of paidLines) {
      const key = line.order_id ?? ''
      byOrder.set(key, [...(byOrder.get(key) ?? []), line])
    }
    for (const [orderKey, group] of byOrder) {
      const orderId = orderKey || null
      const amounts = group.map((l) => round2(Number.parseFloat(l.price_at_purchase) * l.quantity))
      const total = round2(amounts.reduce((a, b) => a + b, 0))
      let card = 0
      if (paidRefund === 'card' && orderId && total > 0) {
        let portion: OrderCardPortion | null
        try {
          portion = await loadOrderCardPortion(orderId)
        } catch (err) {
          await unclaim(group.map((l) => l.id))
          warnings.push(
            `Checking the card payment for ${group.map((l) => l.addon_name).join(', ')} failed (${detail(err)}), so ${group.length === 1 ? 'it was' : 'they were'} left on the booking — refund ${group.length === 1 ? 'it' : 'them'} manually.`
          )
          continue
        }
        if (portion?.paymentIntentId) card = round2(Math.min(total, portion.cardPortionRemaining))
        if (card > 0) {
          // A line is only refunded once, so its id and the amount are enough, with the count of
          // definite noes so that a refusal doesn't stay saved against the key.
          const refused = await refusedCardRefunds(bookingId).catch(() => 0)
          const refunded = await refundPaymentIntent(portion!.paymentIntentId!, card, `addon-refund:${group[0]!.id}:${group.length}:${pence(card)}:${refused}`)
          if (!refunded.ok && refunded.unsure) {
            await keepAsOwed(total, group)
            for (const line of group) stamp.set(line.id, { refunded: 0, card: 0, method: 'none' })
            continue
          }
          if (!refunded.ok) {
            await noteRefusedCardRefund({ bookingId, staffId, amount: card, message: refunded.message })
            await unclaim(group.map((l) => l.id))
            warnings.push(
              `The card refund for ${group.map((l) => l.addon_name).join(', ')} failed (${refunded.message ?? 'unknown error'}), so ${group.length === 1 ? 'it was' : 'they were'} left on the booking — refund ${group.length === 1 ? 'it' : 'them'} manually.`
            )
            continue
          }
        }
      }
      let credit = round2(total - card)
      if (credit > 0) {
        // After a database error the credit is looked for by its note: only a failed look stays unsure.
        const given = await giveStoreCredit({
          customerId: booking.customer_id,
          amount: credit,
          reason: 'refund',
          orderId,
          bookingId,
          staffId,
          note: `Add-on refund: ${group.map((l) => `${l.quantity}× ${l.addon_name}`).join(', ')}.`,
        })
        if (given.outcome === 'unsure') {
          await keepAsOwed(credit, group)
          credit = 0
          if (card <= 0) {
            for (const line of group) stamp.set(line.id, { refunded: 0, card: 0, method: 'none' })
            continue
          }
        } else if (given.outcome === 'refused') {
          if (card <= 0) {
            await unclaim(group.map((l) => l.id))
            warnings.push(
              `Adding ${money(credit)} store credit for ${group.map((l) => l.addon_name).join(', ')} failed, so ${group.length === 1 ? 'it was' : 'they were'} left on the booking — refund ${group.length === 1 ? 'it' : 'them'} manually.`
            )
            continue
          }
          warnings.push(`${money(card)} went back to the card, but adding the ${money(credit)} remainder to store credit failed — add it manually.`)
          credit = 0
        } else if (given.balance !== undefined) {
          result.storeCreditBalance = given.balance
        }
      }
      // Card first, line by line in order; the rest of each line is store credit.
      let cardLeft = card
      let creditLeft = credit
      group.forEach((line, i) => {
        const amount = amounts[i]!
        const cardPart = round2(Math.min(cardLeft, amount))
        cardLeft = round2(cardLeft - cardPart)
        const creditPart = round2(Math.min(creditLeft, amount - cardPart))
        creditLeft = round2(creditLeft - creditPart)
        stamp.set(line.id, {
          refunded: round2(cardPart + creditPart),
          card: cardPart,
          method: cardPart > 0 ? 'card' : creditPart > 0 ? 'credit' : 'none',
        })
      })
      result.cardRefundedAmount = round2(result.cardRefundedAmount + card)
      result.storeCreditRefundedAmount = round2(result.storeCreditRefundedAmount + credit)
      if (orderId && card + credit > 0) affectedOrders.add(orderId)
    }
  }

  // --- 4. Credit lines ----------------------------------------------------------------------------
  for (const line of creditLines) {
    if (!giveCreditsBack || !line.redeemed_membership_id) {
      stamp.set(line.id, { refunded: 0, card: 0, method: 'none' })
      continue
    }
    // Caught so the paid lines' refunds above still get recorded in step 5.
    let released: { data: Array<{ id: string }> }
    try {
      released = await paddockData.query<{ id: string }>(
        `UPDATE customer_memberships
         SET addon_credits_remaining = addon_credits_remaining + $1, updated_at = now()
         WHERE id = $2 AND subscription_status = 'active'
           AND (cancel_effective_date IS NULL OR cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
         RETURNING id`,
        [line.quantity, line.redeemed_membership_id]
      )
    } catch (err) {
      warnings.push(`Returning the add-on credit for ${line.addon_name} failed and needs a manual check: ${detail(err)}`)
      stamp.set(line.id, { refunded: 0, card: 0, method: 'none' })
      continue
    }
    if (released.data.length > 0) {
      result.creditsReturned += line.quantity
      stamp.set(line.id, { refunded: 0, card: 0, method: 'credit_returned' })
    } else {
      result.notes.push(`The membership that paid for ${line.addon_name} is no longer active, so its add-on credit couldn't be returned.`)
      stamp.set(line.id, { refunded: 0, card: 0, method: 'none' })
    }
  }

  // --- 5. Record what went back ---------------------------------------------------------------
  const stamped = [...stamp.entries()]
  result.cancelledLineIds = stamped.map(([id]) => id)
  result.refundedAmount = round2(result.cardRefundedAmount + result.storeCreditRefundedAmount)
  if (stamped.length > 0) {
    try {
      await paddockData.query(
        `UPDATE addon_order_lines aol
         SET refunded_amount = s.refunded, card_refunded_amount = s.card, refund_method = s.method
         FROM unnest($1::uuid[], $2::numeric[], $3::numeric[], $4::text[]) AS s(id, refunded, card, method)
         WHERE aol.id = s.id`,
        [stamped.map(([id]) => id), stamped.map(([, v]) => v.refunded), stamped.map(([, v]) => v.card), stamped.map(([, v]) => v.method)]
      )
    } catch (err) {
      warnings.push(
        `The add-ons were cancelled and ${money(result.refundedAmount)} given back, but recording the amounts on them failed and needs a manual check: ${detail(err)}`
      )
    }
  }
  for (const orderId of affectedOrders) {
    try {
      await recomputeOrderPaymentStatus(orderId)
    } catch (err) {
      warnings.push(`Updating an order's payment status failed and needs a manual check: ${detail(err)}`)
    }
  }
  if (warnings.length > 0) result.warning = warnings.join(' ')
  return result
}

/** "2 add-ons: £9.00 to store credit, 1 add-on credit returned" — a one-line summary for staff. */
export function describeAddonCancellation(result: CancelAddonLinesResult): string {
  const parts: string[] = []
  if (result.cardRefundedAmount > 0) parts.push(`${money(result.cardRefundedAmount)} to the card`)
  if (result.storeCreditRefundedAmount > 0) parts.push(`${money(result.storeCreditRefundedAmount)} to store credit`)
  if (result.creditsReturned > 0) parts.push(`${result.creditsReturned} add-on credit${result.creditsReturned === 1 ? '' : 's'} returned`)
  const count = result.cancelledLineIds.length
  const head = `${count} add-on${count === 1 ? '' : 's'} cancelled`
  return parts.length > 0 ? `${head}: ${parts.join(', ')}` : `${head}, nothing given back`
}
