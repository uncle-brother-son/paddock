import { getStaffAccessRow } from './shared/staffAccess'
import { terminalPaymentIntentAction } from './shared/terminalPaymentIntent'
import { claimPendingReaderPaymentForUndo, loadPendingReaderPayment, type PendingReaderPaymentRow } from './shared/pendingReaderFlows'
import { undoMovePending, undoSettlePending, undoAddGuestPending } from './shared/readerFlowFinalise'
import finaliseReaderPayment, { type FinaliseReaderPaymentResult } from './finaliseReaderPayment'

export interface CancelReaderPaymentParams {
  /** The pending_reader_payments row id returned by the flow's pendingReaderPayment result. */
  pendingId: string
}

export interface CancelReaderPaymentResult {
  cancelled: boolean
  pendingId?: string
  flow?: string
  recordId?: string
  /** True when the row was already gone or already cancelled — nothing to do (idempotent). */
  alreadyDone?: boolean
  /** True when the reader payment had in fact SUCCEEDED: the flow was finalised instead of
   *  cancelled (money moved, so the change is real). Check `finaliseResult`. */
  finalisedInstead?: boolean
  finaliseResult?: FinaliseReaderPaymentResult
  reason?: 'not_found' | 'unexpected_state' | 'already_finalised' | 'stripe_error'
  message?: string
  warning?: string
}

function flowLabel(flow: string): string {
  if (flow === 'move') return 'booking move'
  if (flow === 'settle') return 'booking payment'
  if (flow === 'add_guest') return 'added guest'
  return flow
}

async function undoFlow(row: PendingReaderPaymentRow): Promise<string[]> {
  if (row.flow === 'move') return (await undoMovePending(row)).problems
  if (row.flow === 'settle') return (await undoSettlePending(row)).problems
  if (row.flow === 'add_guest') return (await undoAddGuestPending(row)).problems
  return [`unknown flow ${row.flow} — nothing was undone`]
}

/**
 * Shared cancel for the pending-first reader flows (move / settle / add_guest): cancels the
 * PaymentIntent via the Worker (which never cancels a succeeded intent and reports
 * `alreadySucceeded` instead — the flow is FINALISED in that case, because the money moved), and
 * otherwise undoes the flow's writes via the shared per-flow undo. Idempotent: a missing or
 * already-cancelled row returns success.
 */
export default async function cancelReaderPayment(
  req: { params: CancelReaderPaymentParams; user: User }
): Promise<CancelReaderPaymentResult> {
  const staff = await getStaffAccessRow(req.user.email)
  if (!staff) {
    return { cancelled: false, reason: 'stripe_error', message: 'No staff record matches the logged-in user.' }
  }
  const { pendingId } = req.params
  if (!pendingId) {
    return { cancelled: false, reason: 'not_found', message: 'pendingId is required.' }
  }

  const row = await loadPendingReaderPayment(pendingId)
  if (!row) {
    return { cancelled: true, pendingId, alreadyDone: true, message: 'That pending payment no longer exists — nothing to do.' }
  }
  if (row.status === 'cancelled') {
    return { cancelled: true, pendingId, flow: row.flow, recordId: row.record_id, alreadyDone: true, message: 'Already cancelled — nothing to do.' }
  }
  if (row.status === 'finalised') {
    return {
      cancelled: false,
      pendingId,
      flow: row.flow,
      recordId: row.record_id,
      reason: 'already_finalised',
      message:
        'This payment was already finalised — the change is complete and cannot be cancelled. Refund it through the normal refund flow instead.',
    }
  }

  const pi = await terminalPaymentIntentAction(row.payment_intent_id!, 'cancel')
  if (!pi.ok && pi.code !== 'not_found') {
    // Anything but a clear answer means the intent's true state is unknown (a Stripe failure, an
    // error page, or an intent too far along to cancel) — do NOT undo blind; the money may already
    // have moved. An intent that doesn't exist never took any.
    return {
      cancelled: false,
      pendingId,
      flow: row.flow,
      recordId: row.record_id,
      reason: 'stripe_error',
      message: pi.message ?? 'Failed to cancel the PaymentIntent in Stripe — retry after checking the payment in Stripe.',
    }
  }
  if (pi.alreadySucceeded) {
    // Money moved — finalise the flow instead of cancelling it.
    const finaliseResult = await finaliseReaderPayment({ params: { pendingId }, user: req.user })
    return {
      cancelled: false,
      pendingId,
      flow: row.flow,
      recordId: row.record_id,
      finalisedInstead: finaliseResult.finalised,
      message: finaliseResult.finalised
        ? `The reader payment actually succeeded — the ${flowLabel(row.flow)} was completed instead of cancelled.`
        : `The reader payment actually succeeded, but completing the ${flowLabel(row.flow)} failed: ${finaliseResult.message ?? finaliseResult.reason}`,
      ...(finaliseResult.warning ? { warning: finaliseResult.warning } : {}),
    }
  }

  // Cancelled (or the intent was already dead): undo the flow's writes, once. Claimed first, as the
  // undo can't run twice, and the sweep and staff can arrive together.
  if (!(await claimPendingReaderPaymentForUndo(pendingId))) {
    return { cancelled: true, pendingId, flow: row.flow, recordId: row.record_id, alreadyDone: true, message: 'Already cancelled — nothing to do.' }
  }
  const problems = await undoFlow(row)
  return {
    cancelled: true,
    pendingId,
    flow: row.flow,
    recordId: row.record_id,
    ...(problems.length > 0
      ? { warning: `The ${flowLabel(row.flow)} was undone with warnings that need a manual check: ${problems.join('; ')}` }
      : {}),
    message: `Payment not taken. The ${flowLabel(row.flow)} was undone and nothing was charged.`,
  }
}
