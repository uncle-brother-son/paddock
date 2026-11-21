// New in W32 (E-plan section 5; lead call L7): reconcile's side of the refund watch (refund-watch.ts holds the record).
//
// Each run reads the watched refunds that are due (refund-watch.ts, WATCHES_DUE_SQL), from Stripe's list of the
// refunds on its PaymentIntent, by its id. It never sends a refund, and nothing here ever makes Stripe move money:
// - `succeeded`: W32a (lead call 1): the watch goes on until its days are up, because Stripe can fail a refund it
//   answered `succeeded`; it is read again once a day. Past its days it ends quietly. Nothing else changes either way:
//   the claim recorded the money as gone when it finished.
// - `failed` or `canceled`: Stripe has put the money back on the payment, so the customer never got it. In one
//   transaction, under the subject's own locks (the ones its R2 takes), the card money is taken off the lines R2
//   recorded it on and put back as money owed, exactly where R2 puts a part that never went: on the booking (with
//   `price_paid` on a live one, as R2), or on the order (Q39), which for an event booking is the order that paid for
//   it. Staff then choose: Refund the rest, or It already arrived. Never store credit by the system (Wayne, 14 Nov).
//   Where there is nothing to owe it on (a compensation refund: its order was undone or isn't a refunded order; or a
//   subject that no longer exists), the watch ends `failed` with no money moved, as a line for a person.
// - still going after WATCH_DAYS: the watch ends `expired`, as a line for a person.
// - anything else (still pending, Stripe didn't answer, the other Stripe mode): read again next run.
// - W32a (review S1): every read that ends nothing leaves a `checked` row with the status seen: the watch's last read.
// - W32a: past its days with Stripe not readable: a watch that last read `succeeded` isn't ended on a guess. No answer:
//   read again next run. The other Stripe mode (it never will be readable with this key): it ends quietly.
// - a failure is put back only while no refund claim is open on its subject (`refund_open`: read again next run). An
//   open claim holds its subject, and its undo puts the subject back as its R1 found it: a cancel's undo writes the
//   booking's money owed back to the figure it had then, which would wipe out money this put on it in between.
//
// Run twice, or by two runs at once: the end rows are written under an advisory lock on the refund's id (after the
// subject's row locks, never before them), and the watch is read as ended under it, so the money is put back once.
import 'server-only'
import { PAYMENT_DATE_RECONCILE_ENTITY, PAYMENT_DATE_REFUND_WATCH_STEP } from '@/server/rules/memberships/payment-date'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Tx } from '@/server/db'
import type { StripeClient } from '@/server/stripe/client'
import type { StripeTiming } from '@/server/stripe/deadline'
import { lockForBooking } from '@/server/rules/bookings/locks'
import { recordBookingOrdersPaymentStatus, recordOrderPaymentStatus } from '@/server/rules/bookings/money-left'
import { openRefundClaimOn, readClaim } from '@/server/rules/bookings/refunds'
import { splitByUnitPrice } from '@/server/rules/events/cancel-places'
import { raiseMoneyOwed } from '@/server/rules/orders/money-owed'
import { openClaimHoldingOrder, readEventBookingClaim } from './claims'
import { lockForRefund } from './locks'
import { listRefunds } from './pipeline'
import { LATE_REFUND_STEP, watchCheckedEntry, watchEnded, watchEndEntry, type WatchBy, type WatchDue, type WatchDetails } from './refund-watch'

/** What one look at a watched refund ended with. */
export type WatchChecked =
  | { outcome: 'succeeded' }
  /** `owed`: what went back on the subject as money owed (0 when there was nothing to owe it on: a line for a person). */
  | { outcome: 'failed'; owed: number; status: string }
  | { outcome: 'expired'; detail: string }
  /** Not ended: read again (next run; `succeeded_so_far`, W32a: once it hasn't been read for a day). */
  | { outcome: 'waiting'; reason: 'refund_pending' | 'succeeded_so_far' | 'unclear' | 'other_mode' | 'refund_open'; detail: string }
  /** Another run ended it first. */
  | { outcome: 'ended_elsewhere' }

const round2 = (n: number): number => Math.round(n * 100) / 100

/** A refund claim is open on the subject: nothing is put back now, and the next run looks again. */
const waitsForClaim = (claimId: string): WatchChecked => ({ outcome: 'waiting', reason: 'refund_open', detail: `refund claim ${claimId} is open on it` })

const lockRefund = (tx: Tx, refundId: string): Promise<unknown> => tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`refund-watch:${refundId}`])

/** What the subject's own row is on: a compensation's order; W32a: a late refund's order or flow (`reader_payment`). */
const subjectEntity = (watch: WatchDetails): string =>
  // W41: a payment date change's compensation refund names its change (memberships/payment-date.ts), which has no order.
  watch.on === 'compensation' ? (watch.step === PAYMENT_DATE_REFUND_WATCH_STEP ? PAYMENT_DATE_RECONCILE_ENTITY : (watch.late ?? 'order')) : watch.on

/** The row on the subject itself (its history), beside the watch's own end row. */
const subjectRow = (by: WatchBy, watch: WatchDetails, owed: number, status: string): AuditEntry => ({
  actorType: by.actor.type,
  actorId: by.actor.id,
  action: `${subjectEntity(watch)}.refund_failed_later`,
  entityType: subjectEntity(watch),
  entityId: watch.subjectId,
  requestId: by.requestId,
  details: { claimId: watch.claimId, refundId: watch.refundId, paymentIntentId: watch.paymentIntentId, amount: watch.amount, owed, status },
})

/** An end with no money moved (`succeeded`, `expired`), once. False when the watch had ended already. */
async function endWatch(db: Db, watch: WatchDetails, state: 'succeeded' | 'expired', details: Record<string, unknown>, by: WatchBy): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockRefund(tx, watch.refundId)
    if (await watchEnded(tx, watch.refundId)) return false
    await audit.recordAll(tx, [watchEndEntry(by, watch.refundId, state, { amount: watch.amount, on: watch.on, subjectId: watch.subjectId, ...details })])
    return true
  })
}

/** The `failed` end's rows, under the refund's lock. False when the watch had ended already (nothing may be changed). */
async function failedOnce(tx: Tx, watch: WatchDetails): Promise<boolean> {
  await lockRefund(tx, watch.refundId)
  return !(await watchEnded(tx, watch.refundId))
}

const failedRows = (by: WatchBy, watch: WatchDetails, owed: number, status: string, more: Record<string, unknown> = {}): AuditEntry[] => [
  watchEndEntry(by, watch.refundId, 'failed', { amount: watch.amount, owed, status, on: watch.on, subjectId: watch.subjectId, orderId: watch.orderId, claimId: watch.claimId, ...more }),
  subjectRow(by, watch, owed, status),
]

/** The card money off an order's line again (never below £0). */
const offOrderLine = (tx: Tx, lineId: string, amount: number): Promise<unknown> =>
  tx.query('UPDATE order_line_items SET card_refunded_amount = GREATEST(card_refunded_amount - $1::numeric, 0) WHERE id = $2::uuid', [amount, lineId])

/**
 * The card money off a booking add-on's line again, and its stamp as R2 would have left it had the part never gone:
 * `card` while card money is still on it, `credit` while only store credit is, else `none` (stampAddonLines' rule).
 */
const offAddonLine = (tx: Tx, lineId: string, amount: number): Promise<unknown> =>
  tx.query(
    `UPDATE addon_order_lines
     SET card_refunded_amount = GREATEST(card_refunded_amount - $1::numeric, 0),
         refunded_amount = GREATEST(refunded_amount - $1::numeric, 0),
         refund_method = CASE WHEN card_refunded_amount - $1::numeric > 0 THEN 'card' WHEN refunded_amount - $1::numeric > 0 THEN 'credit' ELSE 'none' END
     WHERE id = $2::uuid`,
    [amount, lineId]
  )

/**
 * A booking claim's refund that failed: R2's record of the part undone, and the part owed on the booking as R2 owes a
 * part that never went (finishClaimInTransaction): on a cancel's claim or a cancelled booking in `refund_owed_amount`
 * alone, on a live booking in `price_paid` too. A removed add-on's part was recorded on its add-on lines (W22), as was
 * a cancel's add-on share (W23, `addon`); everything else on booking lines.
 */
async function failBookingWatch(db: Db, watch: WatchDetails, status: string, by: WatchBy): Promise<WatchChecked> {
  return db.transaction(async (tx): Promise<WatchChecked> => {
    const locks = await lockForBooking(tx, { bookingId: watch.subjectId })
    if (!(await failedOnce(tx, watch))) return { outcome: 'ended_elsewhere' }
    // Under the booking's lock, as every claim's R1 writes under it: an open claim holds the booking.
    const open = locks ? await openRefundClaimOn(tx, watch.subjectId) : null
    if (open) return waitsForClaim(open)
    const claim = locks && watch.claimId ? await readClaim(tx, watch.claimId) : null
    if (!locks || !claim) {
      // Nothing to owe it on: a line for a person.
      await audit.recordAll(tx, failedRows(by, watch, 0, status, { gone: true }))
      return { outcome: 'failed', owed: 0, status }
    }
    const addonLines = claim.details.kind === 'remove_addon'
    for (const line of watch.lines) {
      if (addonLines || line.addon) await offAddonLine(tx, line.lineId, line.amount)
      else await offOrderLine(tx, line.lineId, line.amount)
    }
    const owed = round2(watch.amount)
    const bookingStatus = (await tx.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1::uuid', [watch.subjectId]))[0]?.status
    await tx.query(
      claim.details.cancel || bookingStatus === 'cancelled'
        ? 'UPDATE bookings SET refund_owed_amount = refund_owed_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid'
        : 'UPDATE bookings SET price_paid = price_paid + $1::numeric, refund_owed_amount = refund_owed_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid',
      [owed, watch.subjectId]
    )
    const part = claim.details.plan.card.find((one) => one.paymentIntentId === watch.paymentIntentId)
    if (part) await recordOrderPaymentStatus(tx, part.orderId)
    // W53 (W32 "Noticed" 4): the money is owed on the booking again, so none of its orders may read `refunded`: each
    // is worked out again (money-left.ts), the ones this refund never touched included.
    await recordBookingOrdersPaymentStatus(tx, watch.subjectId)
    await audit.recordAll(tx, failedRows(by, watch, owed, status))
    return { outcome: 'failed', owed, status }
  })
}

/** An order claim's refund that failed: the card money off its lines, and owed on the order (Q39). */
async function failOrderWatch(db: Db, watch: WatchDetails, status: string, by: WatchBy): Promise<WatchChecked> {
  return db.transaction(async (tx): Promise<WatchChecked> => {
    const locks = await lockForRefund(tx, { orderId: watch.subjectId })
    if (!(await failedOnce(tx, watch))) return { outcome: 'ended_elsewhere' }
    // Under the order's lock, which both claim writers take: an open claim on the order, its event booking, or a
    // booking's card part on its payment holds the order.
    const open = locks ? await openClaimHoldingOrder(tx, watch.subjectId) : null
    if (open) return waitsForClaim(open)
    if (!locks) {
      // The order no longer exists: a line for a person.
      await audit.recordAll(tx, failedRows(by, watch, 0, status, { gone: true }))
      return { outcome: 'failed', owed: 0, status }
    }
    for (const line of watch.lines) await offOrderLine(tx, line.lineId, line.amount)
    const owed = round2(watch.amount)
    await raiseMoneyOwed(tx, watch.subjectId, owed)
    await recordOrderPaymentStatus(tx, watch.subjectId)
    await audit.recordAll(tx, failedRows(by, watch, owed, status))
    return { outcome: 'failed', owed, status }
  })
}

/**
 * An event booking claim's refund that failed: the places' figures as R2 writes them when the card part never went
 * (what the plan's store credit and cash gave, shared out by unit price, and no card money), the card money off the
 * event line, and owed on the order that paid for the booking (Q39). The places stay cancelled.
 */
async function failEventWatch(db: Db, watch: WatchDetails, status: string, by: WatchBy): Promise<WatchChecked> {
  const claim = watch.claimId ? await readEventBookingClaim(db, watch.claimId) : null
  const cancelled = claim?.details.cancel
  const orderId = watch.orderId ?? claim?.orderId ?? null
  return db.transaction(async (tx): Promise<WatchChecked> => {
    const locks = orderId ? await lockForRefund(tx, { orderId, eventId: cancelled?.eventId ?? null, eventBookingId: watch.subjectId }) : null
    if (!(await failedOnce(tx, watch))) return { outcome: 'ended_elsewhere' }
    const open = locks && orderId ? await openClaimHoldingOrder(tx, orderId) : null
    if (open) return waitsForClaim(open)
    if (!locks || !orderId || !claim || !cancelled) {
      await audit.recordAll(tx, failedRows(by, watch, 0, status, { gone: true }))
      return { outcome: 'failed', owed: 0, status }
    }
    const given = round2(claim.details.plan.storeCredit + claim.details.plan.cash)
    const unitPrices = cancelled.places.map((place) => place.unitPrice)
    await tx.query(
      `UPDATE event_attendees ea
       SET refunded_amount = s.refunded, card_refunded_amount = 0
       FROM unnest($1::uuid[], $2::numeric[]) AS s(id, refunded)
       WHERE ea.id = s.id AND ea.event_booking_id = $3::uuid`,
      [cancelled.places.map((place) => place.id), splitByUnitPrice(given, unitPrices), watch.subjectId]
    )
    for (const line of watch.lines) await offOrderLine(tx, line.lineId, line.amount)
    const owed = round2(watch.amount)
    await raiseMoneyOwed(tx, orderId, owed)
    await recordOrderPaymentStatus(tx, orderId)
    await audit.recordAll(tx, failedRows(by, watch, owed, status))
    return { outcome: 'failed', owed, status }
  })
}

/**
 * A compensation refund that failed: nothing to owe it on (its order was undone, or is not a refunded order). W32a
 * (review S3): and a late payment's automatic refund, whose order or flow is gone.
 */
async function failCompensationWatch(db: Db, watch: WatchDetails, status: string, by: WatchBy): Promise<WatchChecked> {
  return db.transaction(async (tx): Promise<WatchChecked> => {
    if (!(await failedOnce(tx, watch))) return { outcome: 'ended_elsewhere' }
    await audit.recordAll(tx, failedRows(by, watch, 0, status, watch.step === LATE_REFUND_STEP ? { step: watch.step } : {}))
    return { outcome: 'failed', owed: 0, status }
  })
}

/**
 * W32a (review S1): the read's `checked` row. Only the due list reads it (which watch was read longest ago, and what
 * it showed), so a fault writing it is not the item's: the watch is simply read again sooner.
 */
async function noteChecked(db: Db, watch: WatchDetails, status: string | null, reason: string, by: WatchBy): Promise<void> {
  try {
    await db.transaction((tx) => audit.recordAll(tx, [watchCheckedEntry(by, watch.refundId, status, reason)]))
  } catch {
    // Read again next run.
  }
}

/**
 * One watched refund read from Stripe and, when it has ended, settled. Never sends anything. `due.expired`: the watch
 * is past its days, so it ends now: quietly if Stripe shows `succeeded`, for a person if it is still going, and as a
 * failure if Stripe shows one.
 */
export async function checkWatchedRefund(db: Db, stripe: StripeClient, due: WatchDue, by: WatchBy, timing: StripeTiming | undefined): Promise<WatchChecked> {
  const watch = due.details
  const lastStatus = due.lastStatus ?? watch.status
  const expire = async (detail: string): Promise<WatchChecked> =>
    (await endWatch(db, watch, 'expired', { detail, orderId: watch.orderId, claimId: watch.claimId }, by)) ? { outcome: 'expired', detail } : { outcome: 'ended_elsewhere' }
  const succeed = async (details: Record<string, unknown> = {}): Promise<WatchChecked> => ((await endWatch(db, watch, 'succeeded', details, by)) ? { outcome: 'succeeded' } : { outcome: 'ended_elsewhere' })
  const wait = async (reason: Extract<WatchChecked, { outcome: 'waiting' }>['reason'], detail: string, status: string | null): Promise<WatchChecked> => {
    await noteChecked(db, watch, status, reason, by)
    return { outcome: 'waiting', reason, detail }
  }

  // A refund is only ever read with a key of the mode it was made in: with the other key Stripe shows nothing for it.
  if (typeof watch.livemode === 'boolean' && watch.livemode !== stripe.keyLivemode) {
    const detail = `the refund's mode ${String(watch.livemode)}, the key's ${String(stripe.keyLivemode)}`
    if (!due.expired) return wait('other_mode', detail, lastStatus)
    return lastStatus === 'succeeded' ? succeed({ detail: `not read at the end: ${detail}` }) : expire(detail)
  }
  const listed = await listRefunds(stripe, watch.paymentIntentId, timing)
  if (listed.kind === 'unclear') return due.expired && lastStatus !== 'succeeded' ? expire(listed.detail) : wait('unclear', listed.detail, lastStatus)
  const refund = listed.refunds.find((one) => one.id === watch.refundId)
  if (refund?.status === 'succeeded') return due.expired ? succeed() : wait('succeeded_so_far', `${watch.refundId} is succeeded`, 'succeeded')
  if (refund && (refund.status === 'failed' || refund.status === 'canceled')) {
    const failed =
      watch.on === 'booking'
        ? await failBookingWatch(db, watch, refund.status, by)
        : watch.on === 'order'
          ? await failOrderWatch(db, watch, refund.status, by)
          : watch.on === 'event_booking'
            ? await failEventWatch(db, watch, refund.status, by)
            : await failCompensationWatch(db, watch, refund.status, by)
    // Waiting for an open claim on its subject: read as failed, so the next run looks again.
    if (failed.outcome === 'waiting') await noteChecked(db, watch, refund.status, failed.reason, by)
    return failed
  }
  const detail = refund ? `${watch.refundId} is ${String(refund.status)}` : `Stripe doesn't list ${watch.refundId} on ${watch.paymentIntentId}`
  return due.expired ? expire(detail) : wait('refund_pending', detail, refund ? refund.status : 'not_listed')
}
