import { applyStoreCredit } from './shared/storeCredit'
import { resolveStaffId } from './shared/resolveStaffId'
import { requireCanIssueRefunds } from './shared/staffAccess'

export interface AdjustCustomerStoreCreditParams {
  customerId: string
  /** The magnitude of the adjustment in pounds — always positive; `mode` decides the direction. */
  amount: number
  /** 'add' puts credit on the customer's balance, 'remove' takes it off (fails if it would go negative). */
  mode: 'add' | 'remove'
  /** Required free-text explanation (staff-entered), stored as the transaction's note. */
  reason: string
}

export interface AdjustCustomerStoreCreditResult {
  ok: boolean
  /** The customer's balance AFTER the movement, when ok. */
  balance?: number
  /** The signed amount actually applied — positive for add, negative for remove. */
  appliedAmount?: number
  transactionId?: string
  reason?: 'insufficient_store_credit' | 'customer_not_found' | 'amount_required'
  message?: string
}

const MIN_REASON_LENGTH = 5

/**
 * Manual store-credit adjustment, staff-initiated from the customer profile. Writes through the
 * database's atomic public.store_credit_apply(...) (via shared/storeCredit.ts) with
 * p_reason = 'manual_adjustment', the staff-entered reason as p_note, and the acting staff id
 * (the DB function has a dedicated p_staff_id parameter). Only staff with can_issue_refunds may
 * adjust credit — enforced here with the same guard every other money-moving action uses.
 */
export default async function adjustCustomerStoreCredit(
  req: { params: AdjustCustomerStoreCreditParams; user: User }
): Promise<AdjustCustomerStoreCreditResult> {
  const { customerId, amount, mode, reason } = req.params

  if (!customerId) {
    return { ok: false, message: 'Customer id is required.' }
  }
  if (mode !== 'add' && mode !== 'remove') {
    return { ok: false, message: 'Mode must be "add" or "remove".' }
  }
  const amountValue = typeof amount === 'number' ? Math.round(amount * 100) / 100 : NaN
  if (!Number.isFinite(amountValue) || amountValue <= 0) {
    return { ok: false, message: 'Amount must be greater than 0.' }
  }
  const note = typeof reason === 'string' ? reason.trim() : ''
  if (note.length < MIN_REASON_LENGTH) {
    return { ok: false, message: 'A reason of at least 5 characters is required.' }
  }

  // Same permission guard as every other money-back-to-customer action (Cancel & Refund, refunds).
  await requireCanIssueRefunds(req.user.email)

  const signedAmount = mode === 'add' ? amountValue : -amountValue
  const result = await applyStoreCredit({
    customerId,
    amount: signedAmount,
    reason: 'manual_adjustment',
    staffId: await resolveStaffId(req.user.email),
    note,
  })

  if (!result.ok) {
    if (result.reason === 'insufficient_store_credit') {
      return {
        ok: false,
        reason: result.reason,
        message: 'Removing that much would take the balance below zero — the adjustment was refused.',
      }
    }
    if (result.reason === 'customer_not_found') {
      return { ok: false, reason: result.reason, message: 'That customer no longer exists.' }
    }
    return {
      ok: false,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      message: 'The adjustment was refused.',
    }
  }

  return {
    ok: true,
    appliedAmount: signedAmount,
    ...(result.balance !== undefined ? { balance: result.balance } : {}),
    ...(result.transactionId !== undefined ? { transactionId: result.transactionId } : {}),
  }
}
