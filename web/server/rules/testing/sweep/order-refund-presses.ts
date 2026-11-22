import type { Db } from '@/server/db'
import type { OrderRefundFigures } from '@/contracts'
import { reconcileClaimNow } from '@/server/rules/orders/reconcile'
import { ORDER_CLAIMS, openClaimOn } from '@/server/rules/refunds/pipeline'
import { BOOKING_KINDS_ON, throughStaffApp, withSwitch } from './booking-presses'
import { replayStripe } from '../replay/stripe-binding'

/*
 * W64 (H-plan 3.3 step 3): an order refund's press (W28, W29), as the screen presses them, moved here unchanged from
 * `replay/order-refund-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded. The replay side re-exports all of it; what it keeps is its old side and its comparisons (W65).
 */

/** ORDER_SWITCH as it will be live once Wayne adds `order_refunds` (W27's kind; off with today's secret). */
export const ORDER_REFUND_KINDS_ON = `${BOOKING_KINDS_ON},order_refunds`

export type Params = { orderId?: string; lineItemIds?: string[]; refundMethod?: string; restock?: Record<string, boolean> }

/**
 * A refund the Worker held: staff check the Orders page, where reconcile has settled it, before they do anything else
 * to the order. The replay settles it as reconcile does (it never sends a refund) straight after the press, and again
 * before the order's next step.
 */
export async function settleHeldOrderRefund(db: Db, orderId: string | undefined): Promise<void> {
  if (!orderId || !replayStripe.current || !/^[0-9a-f-]{36}$/i.test(orderId)) return
  const held = await openClaimOn(db, ORDER_CLAIMS, orderId)
  if (held) await reconcileClaimNow(db, replayStripe.current, held, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID() })
}

/**
 * refundOrder as the Refund Line Items dialog presses it (brief W28 item 5): it loads the Worker's figures when it
 * opens, shows what the chosen lines give back, and sends that total back as `confirmed` (Q18; the old params had no
 * figure, and the old dialog added up `line_total` itself, E1), with a press key kept after a press that got no answer
 * until the dialog closes (E11), and the switch on. With no figures (an order that doesn't exist) the dialog can't
 * show a total: the press goes with £0, and the Worker refuses the order first.
 */
export function refundOrderAsTheDialogPresses(options: { settleHeld?: boolean } = {}): (db: Db, params: unknown) => Promise<unknown> {
  // The key of a press that got no answer, with the total the dialog is still showing (it stays open with its figures).
  const heldKeys = new Map<string, { key: string; amount: number }>()
  return async (db, params) => {
    const sent = (params ?? {}) as Params
    const orderId = sent.orderId ?? ''
    const held = heldKeys.get(orderId)
    let amount = held?.amount ?? 0
    if (orderId && !held) {
      try {
        const figures = (await withSwitch(ORDER_REFUND_KINDS_ON, () => throughStaffApp('getOrderRefundFigures')(db, { orderId }))) as OrderRefundFigures
        const chosen = new Set(sent.lineItemIds ?? [])
        amount = Math.round(figures.lines.filter((line) => chosen.has(line.lineItemId)).reduce((total, line) => total + line.refundable, 0) * 100) / 100
      } catch {
        // No figures: nothing to show, so £0 is sent and the Worker answers for the order.
      }
    }
    const idempotencyKey = held?.key ?? crypto.randomUUID()
    const answer = (await withSwitch(ORDER_REFUND_KINDS_ON, () => throughStaffApp('refundOrder')(db, { ...sent, confirmed: { amount }, idempotencyKey }))) as { noAnswer?: boolean } | null
    if (answer?.noAnswer) heldKeys.set(orderId, { key: idempotencyKey, amount })
    else heldKeys.delete(orderId)
    if (options.settleHeld !== false) await settleHeldOrderRefund(db, orderId)
    return answer
  }
}
