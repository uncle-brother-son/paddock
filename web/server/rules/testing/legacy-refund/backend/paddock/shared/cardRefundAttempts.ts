/**
 * Keys for card refunds. A key that repeats gets the first refund back from Stripe, which is what a
 * retry after a lost answer needs. But Stripe saves a refusal against its key too, so a definite no
 * must lead to a new key or the next press could only ever be refused (W03 plan, section 2.6: a
 * definite answer means a new key, no answer means the same one). Each no is written down here, and
 * the count goes in the key. Failing to write it only means the same refusal comes back.
 *
 * Writes, so no read-only getter may import it (CLAUDE.md).
 */

export const pence = (pounds: number): number => Math.round(pounds * 100)

/** What a refusal is counted against: a booking, an order (refundOrder) or an event booking. */
export type RefundEntity = 'booking' | 'order' | 'event_booking'

/** How many card refunds on this booking, order or event booking got a definite no. Part of each
 *  refund's key. */
export async function refusedCardRefundsOn(entityType: RefundEntity, entityId: string): Promise<number> {
  const counted = await paddockData.query<{ refused: number }>(
    `SELECT count(*)::int AS refused FROM audit_log
     WHERE entity_type = $1 AND entity_id = $2 AND action = $3`,
    [entityType, entityId, `${entityType}.card_refund_refused`]
  )
  return counted.data[0]?.refused ?? 0
}

export async function noteRefusedCardRefundOn(args: {
  entityType: RefundEntity
  entityId: string
  staffId: string | null
  amount: number
  message: string | undefined
}): Promise<void> {
  try {
    await paddockData.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       VALUES ('staff', $1, $2, $3, $4, $5::jsonb)`,
      [
        args.staffId,
        `${args.entityType}.card_refund_refused`,
        args.entityType,
        args.entityId,
        JSON.stringify({ amount: args.amount, message: args.message ?? null }),
      ]
    )
  } catch {
    // Nothing moved. The next press just meets the same refusal.
  }
}

/** How many card refunds on this booking got a definite no. Part of each refund's key. */
export async function refusedCardRefunds(bookingId: string): Promise<number> {
  return refusedCardRefundsOn('booking', bookingId)
}

export async function noteRefusedCardRefund(args: { bookingId: string; staffId: string | null; amount: number; message: string | undefined }): Promise<void> {
  await noteRefusedCardRefundOn({ entityType: 'booking', entityId: args.bookingId, staffId: args.staffId, amount: args.amount, message: args.message })
}

/**
 * Eight hex characters standing for a set of ids, whatever order they come in: a key names the
 * places or lines it refunds without growing past Stripe's 255 characters. FNV-1a, 32 bits.
 */
export function idsFingerprint(ids: readonly string[]): string {
  let hash = 0x811c9dc5
  for (const char of [...ids].sort().join(',')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
