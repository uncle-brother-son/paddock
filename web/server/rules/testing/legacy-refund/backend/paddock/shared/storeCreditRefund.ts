import { applyStoreCredit, type StoreCreditApplyFailureReason, type StoreCreditApplyInput } from './storeCredit'

/**
 * Store credit moved on a refund path or put back after a failed action, with a clear answer even
 * after a database error.
 *
 * A database error can't say whether the credit landed. So each movement carries a reference of its
 * own in its note, and after an error the note is looked for: there means a clear yes, not there a
 * clear no, and a failed look leaves it unsure. Before looking, the customer's row is locked and let
 * go, so a movement still being written (store_credit_apply holds that row until it commits) is
 * waited for rather than missed.
 *
 * Writes, so no read-only getter may import it (CLAUDE.md).
 */

export type StoreCreditGiven =
  | { outcome: 'given'; balance?: number }
  | { outcome: 'refused'; reason?: StoreCreditApplyFailureReason }
  /** `note` is what the movement was written with, for storeCreditLanded to look for again. */
  | { outcome: 'unsure'; message: string; note: string }

const detail = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Did the movement with exactly this note land? Answers its balance after, or null. Throws if it
 *  can't tell. */
export async function storeCreditLanded(customerId: string, note: string): Promise<{ balance: number } | null> {
  await paddockData.query('SELECT id FROM customers WHERE id = $1 FOR SHARE', [customerId])
  const found = await paddockData.query<{ balance_after: string }>(
    'SELECT balance_after FROM store_credit_transactions WHERE customer_id = $1 AND note = $2 LIMIT 1',
    [customerId, note]
  )
  const row = found.data[0]
  return row ? { balance: Number.parseFloat(row.balance_after) } : null
}

/**
 * A store credit movement of either sign, and never throws: `input.amount` positive gives credit (a
 * refund, or a 'redemption_reversal' putting back what a failed action took), negative takes it back.
 */
export async function giveStoreCredit(input: StoreCreditApplyInput & { note: string }): Promise<StoreCreditGiven> {
  const note = `${input.note} [ref ${crypto.randomUUID()}]`
  try {
    const applied = await applyStoreCredit({ ...input, note })
    if (applied.ok) return { outcome: 'given', ...(applied.balance !== undefined ? { balance: applied.balance } : {}) }
    return { outcome: 'refused', ...(applied.reason ? { reason: applied.reason } : {}) }
  } catch (err) {
    try {
      const landed = await storeCreditLanded(input.customerId, note)
      return landed ? { outcome: 'given', balance: landed.balance } : { outcome: 'refused' }
    } catch (readErr) {
      return { outcome: 'unsure', message: `${detail(err)}; checking whether it landed failed too: ${detail(readErr)}`, note }
    }
  }
}

/**
 * A put-back or a take-back that undoes an action's own movement: true once it has landed, found by
 * its note when its answer was lost. False when it was refused, or still can't be told, for the
 * caller to tell staff to check the balance. Never throws.
 */
export async function storeCreditMoved(input: StoreCreditApplyInput & { note: string }): Promise<boolean> {
  return (await giveStoreCredit(input)).outcome === 'given'
}
