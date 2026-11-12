/**
 * Claims a booking's money BEFORE any of it moves. Each claim is one guarded statement, so two
 * refunds at the same moment can't both take the same money, and the figures are already true while
 * the money is on its way. A claim that touches no row means something changed: nothing has moved,
 * and the caller refuses with the new figures. If money then fails, the caller puts back exactly
 * what didn't go.
 *
 * Every claim compares price_paid with the figure it was worked out from. That is more than
 * "enough is left" needs, but it is what catches a reader payment that committed while the claim
 * waited for the row (see NO_READER_PAYMENT_OPEN). The cost: of two refunds at once, the second is
 * refused and asked to confirm the new figures, even when enough was left for both.
 *
 * Each claim also writes booking.refund_claimed to audit_log in its own statement, and answers that
 * row's id. finishRefundClaim writes booking.refund_finished once the money's fate is on the
 * booking. A claim with no finished row is a function that died with money on its way, which
 * nothing on the booking shows: server/rules/README.md in the Worker has the query. The Worker takes
 * this table over at step E.
 *
 * Writes, so no read-only getter may import it (CLAUDE.md).
 */
import { NO_READER_PAYMENT_OPEN } from './readerPaymentOpen'

export type RefundClaimKind = 'part_refund' | 'refund_owed' | 'cancel' | 'remove_guest' | 'move'

/** The CTE that writes the claim's row, for a statement whose `bk` answers the booking claimed. */
export const CLAIM_AUDIT = (actor: string, details: string, when = 'true') => `claim AS (
       INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       SELECT 'staff', ${actor}, 'booking.refund_claimed', 'booking', bk.id::text, ${details}::jsonb FROM bk WHERE ${when}
       RETURNING id
     )`

interface ClaimedBy {
  staffId?: string | null
  method?: 'card' | 'credit'
  /** Part refund only: a card refund has nowhere else to keep it. */
  reason?: string
}

/** Goes with a claim, so the row can say what was on its way. */
export function refundClaimDetails(kind: RefundClaimKind, args: { amount: number; seenPricePaid: number } & ClaimedBy): string {
  return JSON.stringify({ kind, amount: args.amount, pricePaidBefore: args.seenPricePaid, method: args.method ?? null, reason: args.reason ?? null })
}

/** What became of the claimed money: `given` reached the customer, `put_back` never left and is
 *  back on the booking, `owed` is on the booking as money owed, for Refund the rest. */
export type RefundClaimOutcome = 'given' | 'put_back' | 'owed'

/**
 * The claim's money is now accounted for on the booking. Never throws: a missing row only makes the
 * claim show up in the query, and the money has already gone or been put back.
 */
export async function finishRefundClaim(args: {
  claimId: string
  bookingId: string
  staffId: string | null
  outcome: RefundClaimOutcome
  cardRefunded?: number
  storeCreditRefunded?: number
  owed?: number
}): Promise<void> {
  const { claimId, bookingId, staffId, outcome, cardRefunded = 0, storeCreditRefunded = 0, owed = 0 } = args
  try {
    await paddockData.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       VALUES ('staff', $1, 'booking.refund_finished', 'booking', $2, $3::jsonb)`,
      [staffId, bookingId, JSON.stringify({ claimId, outcome, cardRefunded, storeCreditRefunded, owed })]
    )
  } catch {
    // See above.
  }
}

/** Part refund: takes `amount` off what is left and counts it as a part refund. Answers the claim's
 *  id, or null if something changed. */
export async function claimPartRefund(args: { bookingId: string; amount: number; seenPricePaid: number } & ClaimedBy): Promise<string | null> {
  const claimed = await paddockData.query<{ id: string; claim_id: string }>(
    `WITH bk AS (
       UPDATE bookings b
       SET price_paid = b.price_paid - $1::numeric, part_refunded_amount = b.part_refunded_amount + $2::numeric, updated_at = now()
       WHERE b.id = $3 AND b.status <> 'cancelled' AND b.price_paid = $4::numeric
         AND b.price_paid - b.refund_owed_amount >= $5::numeric
         AND ${NO_READER_PAYMENT_OPEN}
       RETURNING b.id
     ),
     ${CLAIM_AUDIT('$6', '$7')}
     SELECT bk.id, (SELECT id FROM claim) AS claim_id FROM bk`,
    [args.amount, args.amount, args.bookingId, args.seenPricePaid, args.amount, args.staffId ?? null, refundClaimDetails('part_refund', args)]
  )
  return claimed.data[0]?.claim_id ?? null
}

/** A part refund's money all failed: it never left, so it was never a part refund. */
export async function putBackPartRefund(bookingId: string, amount: number): Promise<void> {
  await paddockData.query(
    `UPDATE bookings
     SET price_paid = price_paid + $1::numeric, part_refunded_amount = GREATEST(part_refunded_amount - $2::numeric, 0), updated_at = now()
     WHERE id = $3`,
    [amount, amount, bookingId]
  )
}

/** Refund the rest: takes the whole of what is owed. Only that exact figure: staff confirmed it. */
export async function claimOwedMoney(args: { bookingId: string; amount: number; seenPricePaid: number } & ClaimedBy): Promise<string | null> {
  const claimed = await paddockData.query<{ id: string; claim_id: string }>(
    `WITH bk AS (
       UPDATE bookings b
       SET price_paid = b.price_paid - $1::numeric, refund_owed_amount = b.refund_owed_amount - $2::numeric, updated_at = now()
       WHERE b.id = $3 AND b.status <> 'cancelled' AND b.price_paid = $4::numeric
         AND b.refund_owed_amount = $5::numeric AND b.price_paid >= $6::numeric
         AND ${NO_READER_PAYMENT_OPEN}
       RETURNING b.id
     ),
     ${CLAIM_AUDIT('$7', '$8')}
     SELECT bk.id, (SELECT id FROM claim) AS claim_id FROM bk`,
    [args.amount, args.amount, args.bookingId, args.seenPricePaid, args.amount, args.amount, args.staffId ?? null, refundClaimDetails('refund_owed', args)]
  )
  return claimed.data[0]?.claim_id ?? null
}

/**
 * It already arrived: what is owed reached the customer after all, so it comes off the booking with
 * no money moving. The audit row is in the same statement, because nothing else records this.
 */
export async function clearOwedMoneyThatArrived(args: {
  bookingId: string
  amount: number
  seenPricePaid: number
  staffId: string | null
  reason: string
}): Promise<boolean> {
  const cleared = await paddockData.query<{ id: string }>(
    `WITH bk AS (
       UPDATE bookings b
       SET price_paid = b.price_paid - $1::numeric, refund_owed_amount = b.refund_owed_amount - $2::numeric, updated_at = now()
       WHERE b.id = $3 AND b.status <> 'cancelled' AND b.price_paid = $4::numeric
         AND b.refund_owed_amount = $5::numeric AND b.price_paid >= $6::numeric
         AND ${NO_READER_PAYMENT_OPEN}
       RETURNING b.id
     ),
     audit AS (
       INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
       SELECT 'staff', $7, 'booking.refund_owed_arrived', 'booking', bk.id::text, $8::jsonb FROM bk
       RETURNING id
     )
     SELECT bk.id FROM bk`,
    [
      args.amount,
      args.amount,
      args.bookingId,
      args.seenPricePaid,
      args.amount,
      args.amount,
      args.staffId,
      JSON.stringify({ amount: args.amount, reason: args.reason }),
    ]
  )
  return cleared.data.length > 0
}

/**
 * Money that was claimed, or taken off by a move, and didn't reach the customer: it goes back on
 * the booking as owed, for Refund the rest.
 */
export async function putBackAsOwed(bookingId: string, amount: number): Promise<void> {
  await paddockData.query(
    `UPDATE bookings
     SET price_paid = price_paid + $1::numeric, refund_owed_amount = refund_owed_amount + $2::numeric, updated_at = now()
     WHERE id = $3`,
    [amount, amount, bookingId]
  )
}

/**
 * Remove Guest: takes `amount` off what is left and off the guest's seat. The seat is what stops a
 * second Remove of the same guest: it reads the lowered seat, and is refused on the amount. The
 * seat is locked first, as a statement that waited for it sees the seat as it is now.
 */
export async function claimGuestRefund(
  args: {
    bookingId: string
    guestId: string
    seenUnitPrice: number
    amount: number
    seenPricePaid: number
  } & ClaimedBy
): Promise<string | null> {
  const claimed = await paddockData.query<{ id: string; claim_id: string }>(
    `WITH seat AS (
       SELECT g.id FROM booking_guests g WHERE g.id = $1 AND g.unit_price = $2::numeric FOR UPDATE
     ),
     bk AS (
       UPDATE bookings b
       SET price_paid = b.price_paid - $3::numeric, updated_at = now()
       FROM seat
       WHERE b.id = $4 AND b.status <> 'cancelled' AND b.price_paid = $5::numeric
         AND b.price_paid - b.refund_owed_amount >= $6::numeric
         AND ${NO_READER_PAYMENT_OPEN}
       RETURNING b.id
     ),
     lowered AS (
       UPDATE booking_guests g SET unit_price = g.unit_price - $7::numeric
       FROM seat, bk
       WHERE g.id = seat.id
       RETURNING g.id
     ),
     ${CLAIM_AUDIT('$8', '$9')}
     SELECT bk.id, (SELECT id FROM claim) AS claim_id FROM bk`,
    [
      args.guestId,
      args.seenUnitPrice,
      args.amount,
      args.bookingId,
      args.seenPricePaid,
      args.amount,
      args.amount,
      args.staffId ?? null,
      refundClaimDetails('remove_guest', args),
    ]
  )
  return claimed.data[0]?.claim_id ?? null
}

/** Remove Guest: the money that didn't go stays on the guest's seat, for pressing Remove again. */
export async function putBackGuestRefund(args: { bookingId: string; guestId: string; amount: number }): Promise<void> {
  await paddockData.query(
    `WITH seat AS (UPDATE booking_guests SET unit_price = unit_price + $1::numeric WHERE id = $2 RETURNING id)
     UPDATE bookings SET price_paid = price_paid + $3::numeric, updated_at = now() WHERE id = $4`,
    [args.amount, args.guestId, args.amount, args.bookingId]
  )
}

/**
 * Cancel & Refund: claims the whole booking by cancelling it, because every action refuses a
 * cancelled booking. Lowering price_paid wouldn't do: a second cancel would read £0 and go through,
 * and a cancelled booking keeps its price_paid. Its session place is released once the money has gone.
 * A cancel with no money to give claims none, so `claimId` is null and only `claimed` says it worked.
 */
export async function claimCancel(
  args: { bookingId: string; /** Never 'cancelled': the caller has refused that. */ seenStatus: string; seenPricePaid: number } & ClaimedBy
): Promise<{ claimed: boolean; claimId: string | null }> {
  const claimed = await paddockData.query<{ id: string; claim_id: string | null }>(
    `WITH bk AS (
       UPDATE bookings b
       SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE b.id = $1 AND b.status = $2 AND b.price_paid = $3::numeric
         AND ${NO_READER_PAYMENT_OPEN}
       RETURNING b.id
     ),
     ${CLAIM_AUDIT('$4', '$5', '$6::boolean')}
     SELECT bk.id, (SELECT id FROM claim) AS claim_id FROM bk`,
    [
      args.bookingId,
      args.seenStatus,
      args.seenPricePaid,
      args.staffId ?? null,
      refundClaimDetails('cancel', { ...args, amount: args.seenPricePaid }),
      args.seenPricePaid > 0,
    ]
  )
  const row = claimed.data[0]
  return { claimed: row !== undefined, claimId: row?.claim_id ?? null }
}

/** The cancel didn't go through: the booking goes back to the status it had. */
export async function putBackCancel(bookingId: string, status: string): Promise<void> {
  await paddockData.query(
    `UPDATE bookings SET status = $1, cancelled_at = NULL, updated_at = now() WHERE id = $2 AND status = 'cancelled'`,
    [status, bookingId]
  )
}

/**
 * The cancel's money may have gone, and nobody can say: the booking goes back to the status it had,
 * and all that is still on it is owed, because a cancel gives everything. A cancelled booking has no
 * button left to give it, so it can't stay cancelled.
 */
export async function putBackCancelAsOwed(bookingId: string, status: string): Promise<void> {
  await paddockData.query(
    `UPDATE bookings SET status = $1, cancelled_at = NULL, refund_owed_amount = price_paid, updated_at = now() WHERE id = $2 AND status = 'cancelled'`,
    [status, bookingId]
  )
}
