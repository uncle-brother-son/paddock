import { refundPaymentIntent } from './refundPaymentIntent'
import { noteRefusedCardRefundOn } from './cardRefundAttempts'
import { STRIPE_KEY_SAFE_HOURS, cardRefundWithKey } from './stripeRefundLookup'

/**
 * A card refund on an order (refundOrder) or an event booking (event cancellations) that got no
 * clear answer, so the money may have gone. Nothing else is done on that press, and the refund is
 * held: an audit_log row `card_refund_held` with its PaymentIntent, amount, key and the order lines
 * it was for. The next press on the same order or event booking settles it FIRST, whatever it is
 * asked to do. Within STRIPE_KEY_SAFE_HOURS it sends the same refund with the same key, so Stripe
 * answers with the first refund if it went, or makes it now. After that Stripe may have forgotten
 * the key, so the refund is never sent again: it is looked for on the payment by its key (the Worker
 * writes the key on every refund), and found means it went, not found means it never did. A yes is
 * recorded on those lines as card money given back, so the press carries on as if the earlier one
 * had recorded it. A definite no, or not found, is counted as a refusal and the press carries on
 * with a new key. Still no clear answer, or a look that fails, stops the press again. So pressing
 * again, with another method or other lines or places, can't pay it twice.
 *
 * Settling marks the held row itself (details.settled) in the same statement as recording the lines,
 * and only while it isn't marked, so two presses at once can't both record it.
 *
 * Writes, so no read-only getter may import it (CLAUDE.md).
 */

export type HeldOn = 'order' | 'event_booking'

export interface HeldCardRefund {
  id: string
  paymentIntentId: string
  amount: number
  key: string
  lines: Array<{ lineId: string; amount: number }>
  /** Held longer than Stripe is sure to keep its key: looked for, never sent again. */
  pastKeyLife: boolean
}

const money = (n: number) => `£${n.toFixed(2)}`

/** Staff's words for a refund held with no clear answer. */
export const heldRefundMessage = (amount: number) =>
  `The card refund of ${money(amount)} gave no clear answer, so it may have gone through, and nothing else was done. ` +
  "Check Stripe, but don't refund it there by hand: pressing again first finds out whether it went, and can't pay it twice."

/** Keeps a refund with no clear answer for the next press. False if that couldn't be written. */
export async function holdCardRefund(args: {
  on: HeldOn
  entityId: string
  staffId: string | null
  paymentIntentId: string
  amount: number
  key: string
  lines: Array<{ lineId: string; amount: number }>
}): Promise<boolean> {
  try {
    await paddockData.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       VALUES ('staff', $1, 'card_refund_held', $2, $3, $4::jsonb)`,
      [
        args.staffId,
        args.on,
        args.entityId,
        JSON.stringify({ paymentIntentId: args.paymentIntentId, amount: args.amount, key: args.key, lines: args.lines }),
      ]
    )
    return true
  } catch {
    return false
  }
}

/** Any refund still held on this order or event booking, oldest first. Throws if it can't look. */
export async function heldCardRefunds(on: HeldOn, entityId: string): Promise<HeldCardRefund[]> {
  const found = await paddockData.query<{ id: string; details: Record<string, unknown> | string; past_key_life: boolean }>(
    `SELECT id, details, at < now() - make_interval(hours => $1) AS past_key_life FROM audit_log
     WHERE action = 'card_refund_held' AND entity_type = $2 AND entity_id = $3 AND details->>'settled' IS NULL
     ORDER BY at, id`,
    [STRIPE_KEY_SAFE_HOURS, on, entityId]
  )
  return found.data.map((row) => {
    const details = (typeof row.details === 'string' ? JSON.parse(row.details) : row.details) as {
      paymentIntentId: string
      amount: number
      key: string
      lines?: Array<{ lineId: string; amount: number }>
    }
    return {
      id: row.id,
      paymentIntentId: details.paymentIntentId,
      amount: Number(details.amount),
      key: details.key,
      lines: details.lines ?? [],
      pastKeyLife: row.past_key_life === true,
    }
  })
}

export type HeldSettlement = { settled: true } | { settled: false; message: string }

/**
 * Settles every refund held on this order or event booking. `{ settled: false }` stops the press:
 * a refund still has no clear answer, or its yes couldn't be recorded. Never throws.
 */
export async function settleHeldCardRefunds(on: HeldOn, entityId: string, staffId: string | null, user: User): Promise<HeldSettlement> {
  let held: HeldCardRefund[]
  try {
    held = await heldCardRefunds(on, entityId)
  } catch (err) {
    return { settled: false, message: `Checking for an earlier card refund with no clear answer failed, so nothing was done: ${err instanceof Error ? err.message : String(err)}` }
  }
  for (const refund of held) {
    let sent: { ok: boolean; unsure?: boolean; message?: string }
    if (refund.pastKeyLife) {
      try {
        const found = await cardRefundWithKey(user, refund.paymentIntentId, refund.key)
        sent = found ? { ok: true } : { ok: false, message: 'Stripe has no refund with its key, so it never went.' }
      } catch (err) {
        return {
          settled: false,
          message:
            `An earlier card refund of ${money(refund.amount)} got no clear answer more than a day ago, and checking Stripe for it failed, so nothing was done. ` +
            `Try again in a minute; don't refund it in Stripe by hand. (${err instanceof Error ? err.message : String(err)})`,
        }
      }
    } else {
      sent = await refundPaymentIntent(refund.paymentIntentId, refund.amount, refund.key)
    }
    if (!sent.ok && sent.unsure) return { settled: false, message: heldRefundMessage(refund.amount) }
    try {
      if (sent.ok) {
        await paddockData.query(
          `WITH settle AS (
             UPDATE audit_log SET details = details || jsonb_build_object('settled', 'given', 'settledBy', $1::text)
             WHERE id = $2 AND details->>'settled' IS NULL
             RETURNING id
           ),
           x AS (SELECT * FROM unnest($3::uuid[], $4::numeric[]) AS x(line_id, amount))
           UPDATE order_line_items oli SET card_refunded_amount = oli.card_refunded_amount + x.amount
           FROM x WHERE oli.id = x.line_id AND EXISTS (SELECT 1 FROM settle)`,
          [staffId, refund.id, refund.lines.map((l) => l.lineId), refund.lines.map((l) => l.amount)]
        )
      } else {
        await noteRefusedCardRefundOn({ entityType: on, entityId, staffId, amount: refund.amount, message: sent.message })
        await paddockData.query(
          `UPDATE audit_log SET details = details || jsonb_build_object('settled', 'refused', 'settledBy', $1::text)
           WHERE id = $2 AND details->>'settled' IS NULL`,
          [staffId, refund.id]
        )
      }
    } catch (err) {
      return {
        settled: false,
        message:
          `An earlier card refund of ${money(refund.amount)} ${sent.ok ? 'has gone through' : 'was refused'}, but recording that failed, so nothing was done. ` +
          `Press again: it can't pay it twice. (${err instanceof Error ? err.message : String(err)})`,
      }
    }
  }
  return { settled: true }
}
