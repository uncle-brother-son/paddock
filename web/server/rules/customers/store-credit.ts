// Ported in W37 from the staff app's adjustCustomerStoreCredit.ts and shared/storeCredit.ts (F-plan 1.5, 4.5; brief
// W37 item 1; bug FB12). No Stripe: one transaction holds the database's store_credit_apply (the balance and its
// ledger row, under the customer's lock) and the audit row. A refusal is a throw, so nothing of it is kept.
import 'server-only'
import type { AdjustStoreCreditInput, AdjustStoreCreditOutput } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db } from '@/server/db'
import { accountRefusal, type AccountOptions } from '@/server/rules/account/refusal'
import { ISSUE_REFUNDS_NEEDED_MESSAGE, STORE_CREDIT_MIN_REASON_LENGTH, STORE_CREDIT_WORDS } from './failure-messages'

/**
 * adjustCustomerStoreCredit, with the old checks in the old order and the old words: the mode, an amount above 0
 * (rounded to the penny), a reason of 5 characters, then Issue refunds, then store_credit_apply with
 * `manual_adjustment`, the reason as the note and the staff member. A `customer.store_credit_adjusted` audit row goes
 * with it. The route's press key stops a repeated press giving twice (FB12). No upper limit (lead call L14).
 */
export async function adjustStoreCredit(db: Db, customerId: string, input: AdjustStoreCreditInput, options: AccountOptions): Promise<AdjustStoreCreditOutput> {
  const { mode, amount } = input
  if (mode !== 'add' && mode !== 'remove') throw accountRefusal('VALIDATION', 'store_credit', 'mode_invalid', STORE_CREDIT_WORDS.modeInvalid, { field: 'mode' })
  const amountValue = typeof amount === 'number' ? Math.round(amount * 100) / 100 : Number.NaN
  if (!Number.isFinite(amountValue) || amountValue <= 0) {
    throw accountRefusal('VALIDATION', 'store_credit', 'amount_invalid', STORE_CREDIT_WORDS.amountInvalid, { field: 'amount' })
  }
  const note = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (note.length < STORE_CREDIT_MIN_REASON_LENGTH) {
    throw accountRefusal('VALIDATION', 'store_credit', 'reason_required', STORE_CREDIT_WORDS.reasonRequired, { field: 'reason' })
  }
  if (!options.actor.canIssueRefunds) throw accountRefusal('FORBIDDEN', 'store_credit', 'permission_denied', ISSUE_REFUNDS_NEEDED_MESSAGE)

  const signedAmount = mode === 'add' ? amountValue : -amountValue
  return db.transaction(async (tx) => {
    const applied = (
      await tx.query<{ result: { ok?: boolean; reason?: string; balance?: number | string | null; transaction_id?: string } | null }>(
        'SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, NULL::uuid, NULL::uuid, $4::uuid, $5::text, NULL::uuid) AS result',
        [customerId, signedAmount, 'manual_adjustment', options.actor.id, note]
      )
    )[0]?.result
    if (applied?.ok !== true) {
      if (applied?.reason === 'insufficient_store_credit') throw accountRefusal('CONFLICT', 'store_credit', 'insufficient_store_credit', STORE_CREDIT_WORDS.belowZero)
      if (applied?.reason === 'customer_not_found') throw accountRefusal('NOT_FOUND', 'store_credit', 'customer_not_found', STORE_CREDIT_WORDS.customerGone)
      throw accountRefusal('CONFLICT', 'store_credit', typeof applied?.reason === 'string' ? applied.reason : 'refused', STORE_CREDIT_WORDS.refused)
    }
    const balance = applied.balance !== undefined && applied.balance !== null ? Number(applied.balance) : undefined
    const transactionId = typeof applied.transaction_id === 'string' ? applied.transaction_id : undefined
    await audit.record(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: 'customer.store_credit_adjusted',
      entityType: 'customer',
      entityId: customerId,
      requestId: options.requestId,
      details: {
        mode,
        amount: signedAmount,
        reason: note,
        ...(balance !== undefined ? { balanceBefore: Math.round((balance - signedAmount) * 100) / 100, balanceAfter: balance } : {}),
        ...(transactionId !== undefined ? { transactionId } : {}),
      },
    })
    return {
      appliedAmount: signedAmount,
      ...(balance !== undefined ? { balance } : {}),
      ...(transactionId !== undefined ? { transactionId } : {}),
    }
  })
}
