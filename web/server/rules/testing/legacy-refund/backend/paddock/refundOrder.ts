import { cancelMembershipSubscription } from './shared/cancelMembershipSubscription'
import { insertStockAdjustment, deleteStockAdjustment } from './shared/stockAdjustments'
import { giveStoreCredit, storeCreditMoved } from './shared/storeCreditRefund'
import { refundPaymentIntent } from './shared/refundPaymentIntent'
import { idsFingerprint, noteRefusedCardRefundOn, pence, refusedCardRefundsOn } from './shared/cardRefundAttempts'
import { heldRefundMessage, holdCardRefund, settleHeldCardRefunds } from './shared/heldCardRefund'
import { loadOrderCardPortion, type OrderCardPortion } from './shared/orderCardPortion'
import { recomputeOrderPaymentStatus, recomputeOrdersPaymentStatus } from './shared/orderPaymentStatus'
import { refuseIfInactive } from './shared/staffAccess'
// Side-effect import: pulls every shared module into the typecheck's graph (see typecheckAll.ts).
// The runtime globals (paddockData, paddockBackendApi2, User) are typed by the generated
// declarations in backend/resources/ and backend/user.d.ts.
import './typecheckAll'

export type RefundMethod = 'card' | 'credit'
// 'credit' means STORE CREDIT — a signed movement on the customer's store_credit_balance through
// public.store_credit_apply(...). It is NOT a gift card: no gift_cards row is ever created for a
// refund, the credit never expires, and order_line_items.refund_method records 'credit'.
// (Permission-gated by can_issue_refunds — see the staff check below.)

export interface RefundOrderParams {
  orderId: string
  lineItemIds: string[]
  refundMethod: RefundMethod
  /** Required for every selected line item whose item_type is 'product' — keyed by line item id. */
  restock?: Record<string, boolean>
}

export type RefundOrderFailureReason =
  | 'permission_denied'
  | 'invalid_params'
  | 'order_not_found'
  | 'line_item_not_found'
  | 'booking_not_supported'
  | 'use_event_cancellation'
  | 'already_refunded'
  | 'restock_decision_required'
  | 'no_payment_intent_for_card_refund'
  | 'gift_card_already_redeemed'
  | 'session_pass_already_used'
  | 'membership_instance_not_found'
  | 'session_pass_instance_not_found'
  | 'refund_failed'
  /** The card refund gave no clear answer: nothing else was done, and the next press on this order
   *  settles it first (shared/heldCardRefund). */
  | 'refund_unsure'
  | 'store_credit_failed'
  | 'unexpected_error'

export interface RefundOrderResult {
  success: boolean
  reason?: RefundOrderFailureReason
  message?: string
  refundedAmount?: number
  refundMethod?: RefundMethod
  /** The part of the refund that went back to the original card (refundMethod 'card' only). */
  cardRefundedAmount?: number
  /** The part of the refund that was added to the customer's store credit instead — non-zero
   *  when the selected lines exceed the card portion still refundable, or when the payment had
   *  no card part at all. */
  storeCreditRefundedAmount?: number
  /** The customer's store-credit balance AFTER the refund was applied (store-credit part only). */
  storeCreditBalance?: number
  orderPaymentStatus?: string
  warning?: string
}

interface OrderRow {
  id: string
  customer_id: string
  stripe_payment_intent_id: string | null
  order_total: string
}

interface LineItemRow {
  id: string
  order_id: string
  item_type: string
  quantity: number
  unit_price: string
  line_total: string
  /** Promo discount recorded on this line — the refundable amount is line_total minus this. */
  discount_amount: string
  /** Card money this line has already had back. Non-zero on a line that isn't stamped refunded when
   *  an earlier refund stopped after its card part. */
  card_refunded_amount: string | null
  product_variant_id: string | null
  membership_plan_id: string | null
  session_pass_type_id: string | null
  gift_card_id: string | null
  refunded_at: string | null
}

// Refunds one or more specific order_line_items rows on an order, as a single combined refund
// (one Stripe refund or one store-credit movement for the summed amount — never both, never
// split across the selected lines). Bookings are explicitly out of scope: they route through
// the existing refundBooking.ts flow, which already knows how to cancel the booking and release
// session capacity. Add-ons attached to a booking (addon_order_lines) are also out of scope —
// they aren't real order_line_items rows at all.
//
// A card refund with no clear answer stops the press and is held: the next press on this order sends
// it again with the same key before anything else (shared/heldCardRefund), so it can't be paid twice.
// The key names the order, the lines, the card the order has had back, the amount and the refusals so
// far. Store credit that can't be told to have landed (shared/storeCreditRefund) is counted as given.
export default async function refundOrder(
  req: { params: RefundOrderParams; user: User }
): Promise<RefundOrderResult> {
  const { orderId, lineItemIds, refundMethod, restock } = req.params

  // --- Staff permission check ---------------------------------------------------------------
  const staffLookup = await paddockData.query<{ id: string; can_issue_refunds: boolean | null }>(
    'SELECT id, can_issue_refunds FROM staff WHERE email = $1 AND active = true LIMIT 1',
    [req.user.email]
  )
  const staff = staffLookup.data[0]
  if (!staff) {
    await refuseIfInactive(req.user.email)
    return {
      success: false,
      reason: 'permission_denied',
      message: `No staff record matches the logged-in user's email (${req.user.email}).`,
    }
  }
  if (staff.can_issue_refunds !== true) {
    return {
      success: false,
      reason: 'permission_denied',
      message: 'This staff member is not permitted to issue refunds (can_issue_refunds is not enabled).',
    }
  }

  // --- Basic param validation ------------------------------------------------------------------
  if (!orderId || !Array.isArray(lineItemIds) || lineItemIds.length === 0) {
    return { success: false, reason: 'invalid_params', message: 'orderId and at least one lineItemId are required.' }
  }
  if (refundMethod !== 'card' && refundMethod !== 'credit') {
    return { success: false, reason: 'invalid_params', message: 'refundMethod must be "card" or "credit".' }
  }

  const orderLookup = await paddockData.query<OrderRow>(
    'SELECT id, customer_id, stripe_payment_intent_id, order_total FROM orders WHERE id = $1',
    [orderId]
  )
  const order = orderLookup.data[0]
  if (!order) {
    return { success: false, reason: 'order_not_found' }
  }

  // An earlier press's card refund with no clear answer is settled first, before the lines are read.
  const earlier = await settleHeldCardRefunds('order', orderId, staff.id, req.user)
  if (!earlier.settled) {
    return { success: false, reason: 'refund_unsure', message: earlier.message }
  }

  const lineItemLookup = await paddockData.query<LineItemRow>(
    'SELECT * FROM order_line_items WHERE id = ANY($1::uuid[]) AND order_id = $2',
    [lineItemIds, orderId]
  )
  const lineItems = lineItemLookup.data
  if (lineItems.length !== lineItemIds.length) {
    return { success: false, reason: 'line_item_not_found', message: 'One or more selected line items do not exist on this order.' }
  }
  // Event places are cancelled (and refunded) per place from the event's attendee list
  // (cancelEventPlaces / cancelEvent), never as a whole line here.
  if (lineItems.some((l) => l.item_type === 'event')) {
    return {
      success: false,
      reason: 'use_event_cancellation',
      message: "Event places are cancelled and refunded from the event's attendee list.",
    }
  }
  if (lineItems.some((l) => l.item_type === 'booking')) {
    return {
      success: false,
      reason: 'booking_not_supported',
      message: 'Booking line items are not refundable here — use the booking cancellation/refund flow instead.',
    }
  }
  const alreadyRefunded = lineItems.filter((l) => l.refunded_at !== null)
  if (alreadyRefunded.length > 0) {
    return {
      success: false,
      reason: 'already_refunded',
      message: `Already refunded: ${alreadyRefunded.map((l) => l.id).join(', ')}`,
    }
  }

  const productLines = lineItems.filter((l) => l.item_type === 'product')
  for (const line of productLines) {
    if (restock?.[line.id] === undefined) {
      return {
        success: false,
        reason: 'restock_decision_required',
        message: `A restock decision (true or false) is required for product line item ${line.id}.`,
      }
    }
  }

  // --- Pre-checks for non-monetary reversals (read-only — no writes yet) ---------------------
  const giftCardLines = lineItems.filter((l) => l.item_type === 'gift_card')
  for (const line of giftCardLines) {
    const lookup = await paddockData.query<{ remaining_balance: string; original_value: string; voided: boolean | null }>(
      'SELECT remaining_balance, original_value, voided FROM gift_cards WHERE id = $1',
      [line.gift_card_id]
    )
    const card = lookup.data[0]
    if (!card) {
      return { success: false, reason: 'gift_card_already_redeemed', message: `Gift card for line item ${line.id} not found.` }
    }
    if (card.voided === true || Number.parseFloat(card.remaining_balance) !== Number.parseFloat(card.original_value)) {
      return {
        success: false,
        reason: 'gift_card_already_redeemed',
        message: `Gift card for line item ${line.id} has already been redeemed (or voided) in part or in full — it can no longer be refunded.`,
      }
    }
  }

  const sessionPassLines = lineItems.filter((l) => l.item_type === 'session_pass')
  const sessionPassChecks = new Map<string, { id: string; sessions_remaining: number }>()
  for (const line of sessionPassLines) {
    const passLookup = await paddockData.query<{ id: string; sessions_remaining: number; pass_type_id: string }>(
      'SELECT id, sessions_remaining, pass_type_id FROM customer_session_passes WHERE order_line_item_id = $1',
      [line.id]
    )
    const pass = passLookup.data[0]
    if (!pass) {
      return { success: false, reason: 'session_pass_instance_not_found', message: `No customer_session_passes row references line item ${line.id}.` }
    }
    const typeLookup = await paddockData.query<{ sessions_included: number | null }>(
      'SELECT sessions_included FROM session_pass_types WHERE id = $1',
      [pass.pass_type_id]
    )
    const originalGranted = typeLookup.data[0]?.sessions_included ?? 0
    if (pass.sessions_remaining < originalGranted) {
      return {
        success: false,
        reason: 'session_pass_already_used',
        message: `Session pass for line item ${line.id} has already had sessions used from it (${pass.sessions_remaining} of ${originalGranted} remaining) — it can no longer be refunded.`,
      }
    }
    sessionPassChecks.set(line.id, { id: pass.id, sessions_remaining: pass.sessions_remaining })
  }

  // A payment date change charge (changeMembershipPaymentDate) is recorded as its own order with
  // one membership line, but it isn't a membership sale: it refunds as a plain card line, with no
  // subscription cancel and no membership update.
  const dateChangeLookup = await paddockData.query<{ n: string }>(
    'SELECT count(*) AS n FROM membership_payment_date_changes WHERE order_id = $1',
    [orderId]
  )
  const isPaymentDateChangeOrder = Number(dateChangeLookup.data[0]?.n ?? 0) > 0
  const membershipLines = isPaymentDateChangeOrder ? [] : lineItems.filter((l) => l.item_type === 'membership')
  const membershipChecks = new Map<string, { id: string; stripe_subscription_id: string | null; cancel_effective_date: string | null }>()
  for (const line of membershipLines) {
    const lookup = await paddockData.query<{ id: string; stripe_subscription_id: string | null; cancel_effective_date: string | null }>(
      'SELECT id, stripe_subscription_id, cancel_effective_date FROM customer_memberships WHERE order_line_item_id = $1',
      [line.id]
    )
    const membership = lookup.data[0]
    if (!membership) {
      return { success: false, reason: 'membership_instance_not_found', message: `No customer_memberships row references line item ${line.id}.` }
    }
    membershipChecks.set(line.id, membership)
  }

  const round2 = (n: number) => Math.round(n * 100) / 100
  const lineCardRefunded = (l: LineItemRow): number => Number.parseFloat(l.card_refunded_amount ?? '0')
  // What a line can still give back. A retry after a partial failure only pays the rest: the card
  // money it has had back must not go out again as store credit.
  const lineRefundable = (l: LineItemRow): number =>
    Math.max(0, round2(Number.parseFloat(l.line_total) - Number.parseFloat(l.discount_amount ?? '0') - lineCardRefunded(l)))
  const refundedAmount = round2(lineItems.reduce((sum, l) => sum + lineRefundable(l), 0))

  // --- Card portion of the payment (refundMethod 'card' only) -------------------------------
  // What the order's PaymentIntent took, less card refunds already made on its lines — worked out
  // by the shared helper the event cancellations use too (see shared/orderCardPortion.ts).
  let cardPortionRemaining = 0
  let portion: OrderCardPortion | null = null
  if (refundMethod === 'card') {
    portion = await loadOrderCardPortion(orderId)
    if (!portion) {
      return { success: false, reason: 'order_not_found' }
    }
    cardPortionRemaining = portion.cardPortionRemaining
    // Card money can only be reversed through the original PaymentIntent.
    if (cardPortionRemaining > 0 && !order.stripe_payment_intent_id) {
      return {
        success: false,
        reason: 'no_payment_intent_for_card_refund',
        message: 'This order has no stripe_payment_intent_id — nothing was ever charged to a card, so there is no card to refund. Use store credit instead.',
      }
    }
  }
  // Card refunds cap at the card portion still refundable; anything above that (or the whole
  // amount when there is no card portion) goes to the customer's store credit in the same
  // action. With no card portion this behaves exactly like the store-credit-only path.
  const cardRefundAmount = refundMethod === 'card' ? Math.min(refundedAmount, cardPortionRemaining) : 0
  const storeCreditRefundAmount = round2(refundedAmount - cardRefundAmount)

  // --- Step 1 of the external actions: the money/credit action, per this app's
  // compensating-rollback convention (external action first, then local Postgres writes).
  // With refundMethod 'card' the refund is SPLIT: the card portion goes back through the
  // original PaymentIntent, and any remainder (lines above the card portion still refundable,
  // or the whole amount when the payment had no card part) is added to the customer's store
  // credit in the same action.
  let irreversible = false
  let storeCreditApplied = false
  let storeCreditBalanceAfter: number | undefined
  // Store credit nobody can say landed: counted as given, so this is added to whatever staff are told.
  let creditUnsureWarning: string | null = null
  const withCreditWarning = (warning?: string): { warning?: string } => {
    const all = [creditUnsureWarning, warning].filter((w): w is string => Boolean(w))
    return all.length > 0 ? { warning: all.join(' ') } : {}
  }

  // Best-effort compensating reversal: puts the credited amount back (a negative 'refund'
  // movement with an explanatory note) if the rest of the flow fails while `irreversible` is
  // still false.
  async function reverseStoreCreditIfAny() {
    if (!storeCreditApplied) return
    // Clear failure rather than a non-null assertion: if either record is somehow missing the
    // reversal must not run with made-up values — the throw marks the compensating step as
    // failed instead of silently skipping it.
    if (!order || !staff) {
      throw new Error('Cannot reverse the refunded store credit — the order or staff record is missing.')
    }
    storeCreditApplied = false
    // Found by its note if its answer is lost (shared/storeCreditRefund), so a take-back that landed
    // is never counted as failed.
    const back = await storeCreditMoved({
      customerId: order.customer_id,
      amount: -storeCreditRefundAmount,
      reason: 'refund',
      orderId,
      staffId: staff.id,
      note: 'Automatic reversal — the refund flow failed after the store credit was applied.',
    })
    if (!back) throw new Error('Taking back the refunded store credit failed.')
  }

  if (cardRefundAmount > 0 && order.stripe_payment_intent_id) {
    const paymentIntentId = order.stripe_payment_intent_id
    let refused: number
    try {
      refused = await refusedCardRefundsOn('order', orderId)
    } catch (err) {
      return { success: false, reason: 'refund_failed', message: `Checking the card payment failed, so nothing was refunded: ${err instanceof Error ? err.message : String(err)}` }
    }
    const key = `order-refund:${orderId}:${idsFingerprint(lineItemIds)}:${pence(portion?.alreadyCardRefunded ?? 0)}:${pence(cardRefundAmount)}:${refused}`
    const refunded = await refundPaymentIntent(paymentIntentId, cardRefundAmount, key)
    if (!refunded.ok && refunded.unsure) {
      // The card money each line would get, as recorded below, so a yes later lands on the same lines.
      let budget = cardRefundAmount
      const heldLines: Array<{ lineId: string; amount: number }> = []
      for (const line of lineItems) {
        const part = round2(Math.min(budget, lineRefundable(line)))
        if (part <= 0) continue
        heldLines.push({ lineId: line.id, amount: part })
        budget = round2(budget - part)
      }
      const held = await holdCardRefund({ on: 'order', entityId: orderId, staffId: staff.id, paymentIntentId, amount: cardRefundAmount, key, lines: heldLines })
      return {
        success: false,
        reason: 'refund_unsure',
        message: heldRefundMessage(cardRefundAmount),
        ...(held ? {} : { warning: 'Keeping it for the next press failed too, so press again only with Card on the same lines: that gets the first refund back.' }),
      }
    }
    if (!refunded.ok) {
      await noteRefusedCardRefundOn({ entityType: 'order', entityId: orderId, staffId: staff.id, amount: cardRefundAmount, message: refunded.message })
      return { success: false, reason: 'refund_failed', message: refunded.message ?? 'Failed to refund payment' }
    }
    irreversible = true
  }

  if (storeCreditRefundAmount > 0) {
    // Refund to store credit: a positive movement on the customer's store_credit_balance through
    // the database's atomic apply function. Store credit never expires and is never a gift card.
    const given = await giveStoreCredit({
      customerId: order.customer_id,
      amount: storeCreditRefundAmount,
      reason: 'refund',
      orderId,
      staffId: staff.id,
      note:
        cardRefundAmount > 0
          ? 'Refund to store credit — the lines refunded exceeded the card portion of the payment; the card part went back to the card.'
          : 'Refund to store credit — order line items refunded by staff.',
    })
    if (given.outcome === 'unsure') {
      // Counted as given: the lines are stamped below, so they can't be refunded again. It can't be
      // taken back automatically either, so from here a failure is a warning, as after the card.
      creditUnsureWarning = `Adding the £${storeCreditRefundAmount.toFixed(2)} store credit gave no clear answer (${given.message}), so it is counted as given. Check their balance, and add it with Adjust store credit if it isn't there.`
      irreversible = true
    }
    const applied =
      given.outcome === 'given'
        ? { ok: true as const, ...(given.balance !== undefined ? { balance: given.balance } : {}) }
        : given.outcome === 'refused'
          ? { ok: false as const, ...(given.reason ? { reason: given.reason } : {}) }
          : null
    if (applied && !applied.ok) {
      const message =
        applied.reason === 'customer_not_found'
          ? 'The order has no matching customer record — the store credit could not be applied and no refund was processed.'
          : applied.reason === 'amount_required'
            ? 'The refund amount was invalid — no store credit was applied.'
            : 'Applying the store credit failed — no refund was processed.'
      if (irreversible) {
        // The card part already went back to the card — report success with a warning rather
        // than pretending the whole refund failed. The card money is still recorded on the lines
        // (card_refunded_amount, in selection order) so the order's card portion can't be refunded
        // twice; the lines themselves stay unrefunded for the manual check.
        let recordNote = ''
        try {
          let left = cardRefundAmount
          for (const line of lineItems) {
            if (left <= 0.001) break
            const part = round2(Math.min(left, lineRefundable(line)))
            if (part <= 0) continue
            await paddockData.query(
              'UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1 WHERE id = $2',
              [part, line.id]
            )
            left = round2(left - part)
          }
        } catch (err) {
          recordNote = ` Recording the card refund on the order lines also failed: ${err instanceof Error ? err.message : String(err)}`
        }
        return {
          success: true,
          refundedAmount: cardRefundAmount,
          refundMethod,
          cardRefundedAmount: cardRefundAmount,
          storeCreditRefundedAmount: 0,
          warning: `The card portion (${cardRefundAmount.toFixed(2)}) was refunded to the card, but applying the ${storeCreditRefundAmount.toFixed(2)} remainder to store credit failed and needs a manual check.${recordNote}`,
        }
      }
      return { success: false, reason: 'store_credit_failed', message }
    }
    if (applied?.ok) {
      storeCreditApplied = true
      storeCreditBalanceAfter = applied.balance
    }
  }

  // Per-line refund_method allocation for a split refund: in selection order, lines are recorded
  // as 'card' while the card refund still has budget left, then 'credit'. With a pure card or
  // pure credit refund every line gets that method. A line that had its card money back on an
  // earlier attempt stays 'card'. The exact per-line card amount is tracked in
  // card_refunded_amount (also written by the booking refund flows) so later refunds can see how
  // much card money the order has already paid back.
  let cardBudgetLeft = cardRefundAmount
  const lineRefundMethods = new Map<string, RefundMethod>()
  const lineCardAmounts = new Map<string, number>()
  for (const line of lineItems) {
    if (cardBudgetLeft > 0.001) {
      lineRefundMethods.set(line.id, 'card')
      const cardForLine = Math.min(cardBudgetLeft, lineRefundable(line))
      lineCardAmounts.set(line.id, Math.round(cardForLine * 100) / 100)
      cardBudgetLeft = Math.round((cardBudgetLeft - cardForLine) * 100) / 100
    } else {
      lineRefundMethods.set(line.id, lineCardRefunded(line) > 0 ? 'card' : 'credit')
      lineCardAmounts.set(line.id, 0)
    }
  }

  // Once the money has all gone, a line left unfinished could be refunded again. Stamping it is what
  // stops that: card_refunded_amount alone would still let a retry pay its store credit part twice.
  // Returns the words to add to the warning.
  const linesFinished = new Set<string>()
  async function stampUnfinishedLines(): Promise<string> {
    const unfinished = lineItems.filter((l) => !linesFinished.has(l.id))
    if (unfinished.length === 0) return ''
    try {
      for (const line of unfinished) {
        await paddockData.query(
          `UPDATE order_line_items
           SET refunded_at = now(), refund_method = $1, card_refunded_amount = card_refunded_amount + $2
           WHERE id = $3`,
          [lineRefundMethods.get(line.id) ?? refundMethod, lineCardAmounts.get(line.id) ?? 0, line.id]
        )
        linesFinished.add(line.id)
      }
    } catch (err) {
      return ` Recording it on the order lines also failed, so check in Stripe before refunding this order again: ${err instanceof Error ? err.message : String(err)}`
    }
    const statusWarning = await recomputeOrdersPaymentStatus([orderId])
    return ` The money is recorded on the order lines, so they can't be refunded twice. Check any restock, gift card, session pass or membership on them by hand.${statusWarning ? ` ${statusWarning}` : ''}`
  }

  // --- Step 2 of the external actions: cancel Stripe subscriptions for any refunded membership
  // lines (independent of how the dollar amount itself was refunded above).
  for (const line of membershipLines) {
    const membership = membershipChecks.get(line.id)!
    if (!membership.stripe_subscription_id) {
      // No real Stripe subscription was ever created for this membership (createOrder.ts does
      // not yet wire up real subscription creation) — nothing to cancel; local deactivation
      // below still applies.
      continue
    }
    const cancelResult = await cancelMembershipSubscription(membership.stripe_subscription_id)
    if (cancelResult.attempted && !cancelResult.success) {
      const message = cancelResult.message ?? 'Failed to cancel subscription'
      if (irreversible) {
        const recordNote = await stampUnfinishedLines()
        return {
          success: true,
          refundedAmount,
          refundMethod,
          ...(cardRefundAmount > 0 ? { cardRefundedAmount: cardRefundAmount } : {}),
          ...(storeCreditRefundAmount > 0 ? { storeCreditRefundedAmount: storeCreditRefundAmount } : {}),
          ...(storeCreditBalanceAfter !== undefined ? { storeCreditBalance: storeCreditBalanceAfter } : {}),
          ...withCreditWarning(`The payment/credit action succeeded, but cancelling the Stripe subscription for membership line item ${line.id} failed and needs a manual check: ${message}${recordNote}`),
        }
      }
      await reverseStoreCreditIfAny()
      return { success: false, reason: 'refund_failed', message }
    }
    if (cancelResult.attempted) {
      irreversible = true
    }
  }

  // --- Local Postgres writes. Fully reversible unless `irreversible` is already true, in which
  // case a failure here becomes a `warning` instead of a rollback (real money/subscription
  // actions already happened and cannot be undone).
  const rollbacks: Array<() => Promise<void>> = []
  if (storeCreditApplied) {
    rollbacks.push(reverseStoreCreditIfAny)
  }
  async function rollbackAll() {
    for (const fn of rollbacks.slice().reverse()) {
      try {
        await fn()
      } catch {
        // Best-effort.
      }
    }
  }

  try {
    for (const line of lineItems) {
      if (line.item_type === 'gift_card') {
        await paddockData.query('UPDATE gift_cards SET voided = true, updated_at = now() WHERE id = $1', [line.gift_card_id])
        const capturedId = line.gift_card_id
        rollbacks.push(async () => {
          await paddockData.query('UPDATE gift_cards SET voided = false, updated_at = now() WHERE id = $1', [capturedId])
        })
      }

      if (line.item_type === 'session_pass') {
        const pass = sessionPassChecks.get(line.id)!
        await paddockData.query('UPDATE customer_session_passes SET sessions_remaining = 0, updated_at = now() WHERE id = $1', [pass.id])
        rollbacks.push(async () => {
          await paddockData.query(
            'UPDATE customer_session_passes SET sessions_remaining = $1, updated_at = now() WHERE id = $2',
            [pass.sessions_remaining, pass.id]
          )
        })
      }

      const membership = membershipChecks.get(line.id)
      if (line.item_type === 'membership' && membership) {
        await paddockData.query(
          `UPDATE customer_memberships
           SET subscription_status = 'cancelled', addon_credits_remaining = 0,
               cancel_effective_date = NULL, updated_at = now()
           WHERE id = $1`,
          [membership.id]
        )
        rollbacks.push(async () => {
          await paddockData.query(
            `UPDATE customer_memberships SET subscription_status = 'active', cancel_effective_date = $1, updated_at = now() WHERE id = $2`,
            [membership.cancel_effective_date, membership.id]
          )
        })
      }

      const restockedValue = line.item_type === 'product' ? restock?.[line.id] === true : null
      if (line.item_type === 'product' && restockedValue) {
        await paddockData.query(
          'UPDATE product_variants SET stock_quantity = stock_quantity + $1, updated_at = now() WHERE id = $2',
          [line.quantity, line.product_variant_id]
        )
        rollbacks.push(async () => {
          await paddockData.query(
            'UPDATE product_variants SET stock_quantity = stock_quantity - $1, updated_at = now() WHERE id = $2',
            [line.quantity, line.product_variant_id]
          )
        })
        // Audit entry matching the restock above — staff_id NULL marks it as system-generated.
        const restockAdjustmentId = await insertStockAdjustment({
          variantId: line.product_variant_id!,
          changeAmount: line.quantity,
          reason: `Refund Restock (Order #${orderId})`,
          staffId: null,
        })
        rollbacks.push(async () => {
          await deleteStockAdjustment(restockAdjustmentId)
        })
      }

      await paddockData.query(
        `UPDATE order_line_items
         SET refunded_at = now(), refund_method = $1, restocked = $2,
             card_refunded_amount = card_refunded_amount + $3
         WHERE id = $4`,
        [lineRefundMethods.get(line.id) ?? refundMethod, restockedValue, lineCardAmounts.get(line.id) ?? 0, line.id]
      )
      linesFinished.add(line.id)
      const cardAmountForLine = lineCardAmounts.get(line.id) ?? 0
      rollbacks.push(async () => {
        await paddockData.query(
          'UPDATE order_line_items SET refunded_at = NULL, refund_method = NULL, restocked = NULL, card_refunded_amount = GREATEST(card_refunded_amount - $1, 0) WHERE id = $2',
          [cardAmountForLine, line.id]
        )
      })
    }

    // Recompute the order's overall status with the shared helper (event lines count; booking
    // lines don't — see shared/orderPaymentStatus.ts).
    const newStatus = await recomputeOrderPaymentStatus(orderId)

    return {
      success: true,
      refundedAmount,
      refundMethod,
      ...(cardRefundAmount > 0 ? { cardRefundedAmount: cardRefundAmount } : {}),
      ...(storeCreditRefundAmount > 0 ? { storeCreditRefundedAmount: storeCreditRefundAmount } : {}),
      ...(storeCreditBalanceAfter !== undefined ? { storeCreditBalance: storeCreditBalanceAfter } : {}),
      ...(newStatus ? { orderPaymentStatus: newStatus } : {}),
      ...withCreditWarning(),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (irreversible) {
      const recordNote = await stampUnfinishedLines()
      return {
        success: true,
        refundedAmount,
        refundMethod,
        ...(cardRefundAmount > 0 ? { cardRefundedAmount: cardRefundAmount } : {}),
        ...(storeCreditRefundAmount > 0 ? { storeCreditRefundedAmount: storeCreditRefundAmount } : {}),
        ...(storeCreditBalanceAfter !== undefined ? { storeCreditBalance: storeCreditBalanceAfter } : {}),
        ...withCreditWarning(`The refund/credit succeeded, but recording it locally failed partway through and needs a manual check: ${message}${recordNote}`),
      }
    }
    await rollbackAll()
    return { success: false, reason: 'unexpected_error', message }
  }
}
