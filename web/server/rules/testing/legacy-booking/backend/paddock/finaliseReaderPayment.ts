import { getStaffAccessRow } from './shared/staffAccess'
import { terminalPaymentIntentAction, type TerminalPaymentIntentInfo } from './shared/terminalPaymentIntent'
import {
  claimPendingReaderPaymentForUndo,
  loadPendingReaderPayment,
  markPendingReaderPayment,
  type PendingReaderPaymentRow,
} from './shared/pendingReaderFlows'
import {
  finaliseMovePending,
  finaliseSettlePending,
  finaliseAddGuestPending,
  undoMovePending,
  undoSettlePending,
  undoAddGuestPending,
} from './shared/readerFlowFinalise'
import { refundPaymentIntent } from './shared/refundPaymentIntent'
import { pence } from './shared/cardRefundAttempts'

export interface FinaliseReaderPaymentParams {
  /** The pending_reader_payments row id returned by the flow's pendingReaderPayment result. */
  pendingId: string
}

export interface FinaliseReaderPaymentResult {
  finalised: boolean
  pendingId?: string
  flow?: string
  recordId?: string
  paymentIntentId?: string
  /** True when the row was already finalised — nothing was done (idempotent). */
  alreadyFinalised?: boolean
  /** True when the PaymentIntent had NOT succeeded (callers should cancel instead). */
  paymentNotSucceeded?: boolean
  piStatus?: string
  reason?:
    | 'not_found'
    | 'unexpected_state'
    | 'payment_not_succeeded'
    | 'metadata_mismatch'
    | 'currency_mismatch'
    | 'amount_mismatch'
    | 'record_failed'
    | 'refund_failed'
    /** The automatic refund gave no clear answer, so it may have gone. It is a full refund, so
     *  Stripe can't pay it twice: staff check the payment and refund it there only if it isn't. */
    | 'refund_unsure'
  message?: string
  warning?: string
}

function flowLabel(flow: string): string {
  if (flow === 'move') return 'booking move'
  if (flow === 'settle') return 'booking payment'
  if (flow === 'add_guest') return 'added guest'
  return flow
}

/** Per-flow finalise. The payment RECORD step throws (post-money failure → refund + undo);
 *  capacity/hold releases only collect warnings. */
async function finaliseFlow(row: PendingReaderPaymentRow): Promise<{ problems: string[] }> {
  if (row.flow === 'move') return finaliseMovePending(row)
  if (row.flow === 'settle') return finaliseSettlePending(row)
  if (row.flow === 'add_guest') return finaliseAddGuestPending(row)
  throw new Error(`Unknown pending reader flow: ${row.flow}`)
}

async function undoFlow(row: PendingReaderPaymentRow): Promise<string[]> {
  if (row.flow === 'move') return (await undoMovePending(row)).problems
  if (row.flow === 'settle') return (await undoSettlePending(row)).problems
  if (row.flow === 'add_guest') return (await undoAddGuestPending(row)).problems
  return [`unknown flow ${row.flow} — nothing was undone`]
}

/**
 * Shared finalise for the pending-first reader flows (move / settle / add_guest). Verifies the
 * PaymentIntent exactly like checkout does (succeeded, GBP, amount, metadata.flow + record_id),
 * runs the per-flow finalise, and marks the pending row finalised. Any failure after the money
 * was taken refunds the PaymentIntent IN FULL, undoes the flow's writes, and marks the row
 * cancelled — staff never have money taken with the flow half-applied. Idempotent: an already
 * finalised row returns success without doing anything.
 */
export default async function finaliseReaderPayment(
  req: { params: FinaliseReaderPaymentParams; user: User }
): Promise<FinaliseReaderPaymentResult> {
  const staff = await getStaffAccessRow(req.user.email)
  if (!staff) {
    return { finalised: false, reason: 'unexpected_state', message: 'No staff record matches the logged-in user.' }
  }
  const { pendingId } = req.params
  if (!pendingId) {
    return { finalised: false, reason: 'not_found', message: 'pendingId is required.' }
  }

  const row = await loadPendingReaderPayment(pendingId)
  if (!row) {
    return { finalised: false, pendingId, reason: 'not_found', message: 'That pending payment no longer exists.' }
  }
  if (row.status === 'finalised') {
    return {
      finalised: true,
      pendingId,
      flow: row.flow,
      recordId: row.record_id,
      ...(row.payment_intent_id ? { paymentIntentId: row.payment_intent_id } : {}),
      alreadyFinalised: true,
      message: 'This payment was already finalised — nothing further was done.',
    }
  }
  if (row.status === 'cancelled') {
    return { finalised: false, pendingId, reason: 'unexpected_state', message: 'This pending payment was already cancelled.' }
  }

  const retrieved = await terminalPaymentIntentAction(row.payment_intent_id!, 'retrieve')
  if (!retrieved.ok || !retrieved.paymentIntent) {
    return {
      finalised: false,
      pendingId,
      reason: 'unexpected_state',
      message: retrieved.message ?? 'Failed to look up the PaymentIntent in Stripe.',
    }
  }
  const pi: TerminalPaymentIntentInfo = retrieved.paymentIntent
  if (pi.status !== 'succeeded') {
    return {
      finalised: false,
      pendingId,
      reason: 'payment_not_succeeded',
      paymentNotSucceeded: true,
      piStatus: pi.status,
      message: `The reader payment has not succeeded yet (status: ${pi.status}). Cancel it or retry the card on the reader.`,
    }
  }
  if ((pi.metadata['flow'] ?? '') !== row.flow || (pi.metadata['record_id'] ?? '') !== row.record_id) {
    return {
      finalised: false,
      pendingId,
      reason: 'metadata_mismatch',
      message: 'This PaymentIntent does not belong to this payment (metadata mismatch) — check it in Stripe before doing anything.',
    }
  }
  if (pi.currency !== 'gbp') {
    return {
      finalised: false,
      pendingId,
      reason: 'currency_mismatch',
      message: `The reader payment is in ${pi.currency.toUpperCase()}, not GBP — check it in Stripe before doing anything.`,
    }
  }
  if (Math.abs(pi.amountReceived - Number.parseFloat(row.expected_amount)) > 0.01) {
    return {
      finalised: false,
      pendingId,
      reason: 'amount_mismatch',
      message: `The reader charged £${pi.amountReceived.toFixed(2)} but £${Number.parseFloat(row.expected_amount).toFixed(2)} was expected — do NOT retry. Check the PaymentIntent (${pi.id}) in Stripe and refund/adjust manually.`,
    }
  }

  const refundAndUndo = async (reason: NonNullable<FinaliseReaderPaymentResult['reason']>, staffMessage: string): Promise<FinaliseReaderPaymentResult> => {
    // Claimed first, as the undo can't run twice. Nothing has moved if this throws.
    if (!(await claimPendingReaderPaymentForUndo(pendingId))) {
      return { finalised: false, pendingId, reason: 'unexpected_state', message: 'This pending payment was already cancelled.' }
    }
    // The row is claimed, so nothing in the app sends this again: the key only makes a repeat of this
    // one call safe. A refund of the whole payment can't be paid twice at Stripe either way.
    const refund = await refundPaymentIntent(pi.id, pi.amountReceived, `reader-undo:${pendingId}:${pi.id}:${pence(pi.amountReceived)}`)
    // The row is claimed, so it no longer stops refunds or a cancel: the booking must go back to how
    // it was whatever the refund said, or a later refund would count money nothing recorded (W05k).
    const problems = await undoFlow(row)
    const undone = `The ${flowLabel(row.flow)} was undone${problems.length > 0 ? ` with warnings: ${problems.join('; ')}` : ''}.`
    if (!refund.ok) {
      const what = refund.unsure ? 'gave no clear answer' : 'failed'
      return {
        finalised: false,
        pendingId,
        reason: refund.unsure ? 'refund_unsure' : 'refund_failed',
        message:
          `${staffMessage} ${undone} The automatic refund of £${pi.amountReceived.toFixed(2)} ${what}: ` +
          `check payment ${pi.id} in Stripe and refund it there only if it isn't refunded.`,
      }
    }
    return {
      finalised: false,
      pendingId,
      reason,
      message:
        `${staffMessage} The customer's card has been refunded in full (payment ${pi.id}) and the ${flowLabel(row.flow)} was undone` +
        (problems.length > 0 ? ` with warnings: ${problems.join('; ')}` : '') +
        '.',
    }
  }

  // An earlier run recorded this payment but couldn't mark the row: the row stayed pending, so the
  // sweep is here again. Running the flow twice would write a second order and release the old
  // session's capacity and pass credit twice, so only the mark is left to do.
  const recorded = await paddockData.query<{ id: string }>('SELECT id FROM orders WHERE stripe_payment_intent_id = $1 LIMIT 1', [pi.id])

  let flowProblems: string[] = []
  if (recorded.data.length === 0) {
    try {
      const result = await finaliseFlow(row)
      flowProblems = result.problems
    } catch (err) {
      return refundAndUndo('record_failed', `Recording the reader payment failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // The money is taken and recorded, so a failed mark can't turn this into a failure: staff would
  // redo a payment that went through. The sweep finishes the mark, through the check above.
  try {
    await markPendingReaderPayment(pendingId, 'finalised')
  } catch (err) {
    flowProblems.push(`mark the payment finalised: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    finalised: true,
    pendingId,
    flow: row.flow,
    recordId: row.record_id,
    paymentIntentId: pi.id,
    ...(flowProblems.length > 0
      ? { warning: `The payment was recorded, but these steps need a manual check: ${flowProblems.join('; ')}` }
      : {}),
  }
}
