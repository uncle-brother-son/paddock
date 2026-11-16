export type StoreCreditReason =
  | 'refund'
  | 'manual_adjustment'
  | 'redemption'
  | 'redemption_reversal'
  | 'migrated_from_gift_card'
// The runtime globals (paddockData) are typed by the generated declarations in
// backend/resources/; ../globals.ts is now an empty module, kept so this import stays valid.
import '../globals'

export type StoreCreditApplyFailureReason =
  | 'insufficient_store_credit'
  | 'customer_not_found'
  | 'amount_required'

export interface StoreCreditApplyInput {
  customerId: string
  /** Positive adds credit, negative removes it. */
  amount: number
  reason: StoreCreditReason
  orderId?: string | null
  bookingId?: string | null
  staffId?: string | null
  note?: string | null
  giftCardId?: string | null
}

export interface StoreCreditApplyResult {
  ok: boolean
  /** The customer's balance AFTER the movement, when ok. */
  balance?: number
  /** The created store_credit_transactions row id, when ok. */
  transactionId?: string
  reason?: StoreCreditApplyFailureReason
}

/**
 * Applies a signed store-credit movement through the database's atomic
 * public.store_credit_apply(...) function and parses its jsonb result
 * ({ ok, balance, transaction_id } or { ok: false, reason: 'insufficient_store_credit' |
 * 'customer_not_found' | 'amount_required' }). Every placeholder is bound exactly once — this
 * driver maps $N to the Nth parameter and rejects reused placeholders.
 */
export async function applyStoreCredit(input: StoreCreditApplyInput): Promise<StoreCreditApplyResult> {
  const result = await paddockData.query<{ result: unknown }>(
    `SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, $4::uuid, $5::uuid, $6::uuid, $7::text, $8::uuid) AS result`,
    [
      input.customerId,
      input.amount,
      input.reason,
      input.orderId ?? null,
      input.bookingId ?? null,
      input.staffId ?? null,
      input.note ?? null,
      input.giftCardId ?? null,
    ]
  )
  const raw = result.data[0]?.result
  const parsed: Record<string, unknown> | null =
    typeof raw === 'string' ? tryParseJson(raw) : ((raw ?? null) as Record<string, unknown> | null)
  if (!parsed || parsed['ok'] !== true) {
    return {
      ok: false,
      ...(parsed && typeof parsed['reason'] === 'string'
        ? { reason: parsed['reason'] as StoreCreditApplyFailureReason }
        : {}),
    }
  }
  return {
    ok: true,
    ...(parsed['balance'] !== undefined && parsed['balance'] !== null ? { balance: Number(parsed['balance']) } : {}),
    ...(typeof parsed['transaction_id'] === 'string' ? { transactionId: parsed['transaction_id'] as string } : {}),
  }
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
