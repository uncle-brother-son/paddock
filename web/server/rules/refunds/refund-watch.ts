// New in W32 (E-plan section 5; W13a review L2, W21 review L3, the W26 audit's row 11): the refund watch's record.
//
// Stripe answers some card refunds `pending` (or `requires_action`) and settles them later. Until W32 such a refund was
// counted as gone and never looked at again: if Stripe failed it days later, the booking or order still said the money
// went back and nobody was told. From W32:
// - every finished claim (a booking's, an order's, an event booking's) keeps each card refund's id and status on its
//   finished row (`refunds`);
// - each of those refunds gets one `refund.watch` row (`watching`), written in the same transaction as the finished
//   row, so a recorded card refund is always a watched one (W32: only one not `succeeded`; W32a: every one);
// - step C's compensation refunds (membership.ts: the refunds a membership order's compensation, a put-back or its
//   retry send) get the same row.
//
// Reconcile reads each watched refund every run until it ends (refund-watch-settle.ts). It never sends a refund. A
// watch ends with one more row for the same refund: `succeeded`, `failed` (Stripe's `failed` or `canceled`: the money
// is back on the payment, so it is put back as owed), or `expired` (still pending after WATCH_DAYS: lead call L7). A
// `failed` or `expired` watch stays on the stuck list until a person marks it sorted (`sorted`).
//
// W32a (lead call 1, 15 Nov 2026): every card refund is watched for WATCH_DAYS, whatever its first status. Stripe can
// answer a refund `succeeded` and fail it afterwards (its own failing test card does exactly that), so `succeeded` no
// longer ends a watch before its days are up. One still going is read every run; one that reads `succeeded` is read
// again once it hasn't been read for WATCH_READ_HOURS. Each read that ends nothing leaves a `checked` row (the status
// seen), which is where "last read" lives: the due list reads it on the existing (entity_type, entity_id) index, so no
// migration (W32 review S1). At the end of its days a watch that reads `succeeded` ends quietly; any other ends
// `expired`, for a person. W12's automatic refunds of late payments are watched by the same rows (review S3).
//
// Rows, all `refund.watch` on entity `refund_watch` with the Stripe refund's id as entity id, so everything about one
// refund is found by that id. The `watching` row's own id is the watch's id (what the manual close names).
//
// This file imports nothing that knows a booking, an order line or an event place, so each subject's R2 can import it.
import 'server-only'
import { audit, type AuditEntry } from '@/server/audit'
import type { Queryable, Tx } from '@/server/db'
import type { CardPart, CardPartLine } from './pipeline'

export const REFUND_WATCH = 'refund.watch'
export const REFUND_WATCH_ENTITY = 'refund_watch'

/**
 * How many days a card refund is watched from the day it was recorded. Lead call 2 (15 Nov 2026): 50, not L7's 30:
 * Stripe can keep a refund pending for 45 days and then fail it.
 */
export const WATCH_DAYS = 50

/** W32a (call 1): a watched refund that reads `succeeded` is read again once it hasn't been read for this many hours. */
export const WATCH_READ_HOURS = 24

/** What a watched refund is for: a claim on one of the three subjects, or one of step C's compensation refunds. */
export type WatchSubject = 'booking' | 'order' | 'event_booking' | 'compensation'

/** One card part's refund as Stripe answered or listed it: kept on the claim's finished row (`refunds`). */
export interface RefundSeen {
  /** The order whose card the part refunds. */
  orderId: string
  /** The part's own PaymentIntent (a membership's first invoice, W29; the order's for an event booking, W30). */
  paymentIntentId: string
  refundId: string
  status: string | null
  /** Pounds: the part's amount. */
  amount: number
}

export const refundSeen = (part: CardPart, refund: { id: string; status: string | null }): RefundSeen => ({
  orderId: part.orderId,
  paymentIntentId: part.paymentIntentId,
  refundId: refund.id,
  status: refund.status,
  amount: part.amount,
})

/**
 * A refund still on its way: any status that isn't `succeeded` and isn't an end (`failed`, `canceled`). Stripe's are
 * `pending` and `requires_action`; an unknown or missing status counts too, so nothing is ever taken as settled on a
 * status this code doesn't know. These are read every run, and are what Resolve now calls "waiting on Stripe".
 */
export const stillGoing = (status: string | null | undefined): boolean => status !== 'succeeded' && status !== 'failed' && status !== 'canceled'

/**
 * W32a (call 1): a refund that gets a watch: every one Stripe accepted, `succeeded` included. Only one that is already
 * at an end (`failed`, `canceled`) has nothing to watch: its money never went, and its caller says so at once.
 */
export const toWatch = (status: string | null | undefined): boolean => status !== 'failed' && status !== 'canceled'

/** What a `watching` row carries: everything the settle needs, from the row alone. */
export interface WatchDetails {
  state: 'watching'
  refundId: string
  paymentIntentId: string
  /** Pounds. */
  amount: number
  /** The status it had when it was recorded. */
  status: string | null
  /** The Stripe key's mode the refund was made with (true live): a refund is only read with a key of its own mode. */
  livemode: boolean | null
  on: WatchSubject
  /** The booking, order or event booking the claim is on; for a compensation, the order it was made for (maybe gone). */
  subjectId: string
  /** The order whose money owed rises on a failure: the claim's own order, or the one that paid the event booking. Null for a booking (owed on the booking) and a compensation (a line for a person). */
  orderId: string | null
  claimId: string | null
  /** The lines the card money was recorded on, so a failure takes exactly that off them again. */
  lines: CardPartLine[]
  /** A compensation refund: the step that sent it (`refund-charge`, `refund-subscription`, `refund-reader`). W32a: `late-refund` for a late payment's automatic refund. */
  step?: string
  /** W32a (review S3): a late payment's automatic refund: what its `order.reconcile` rows are on (`subjectId` is that order's or flow's id). */
  late?: 'order' | 'reader_payment'
}

/** W32a (review S3): the step a late payment's automatic refund is watched under. */
export const LATE_REFUND_STEP = 'late-refund'

export interface WatchBy {
  actor: { type: 'staff' | 'customer' | 'system'; id: string | null }
  requestId: string
}

// Fixed text: the action and entity are constants; the refund's id comes in as $1.
/** Any watch row for the refund. */
const WATCH_THERE_SQL = `SELECT 1 FROM audit_log WHERE action = '${REFUND_WATCH}' AND entity_type = '${REFUND_WATCH_ENTITY}' AND entity_id = $1::text LIMIT 1`
/** The refund's watch has ended. */
const WATCH_ENDED_SQL = `SELECT 1 FROM audit_log WHERE action = '${REFUND_WATCH}' AND entity_type = '${REFUND_WATCH_ENTITY}' AND entity_id = $1::text AND details->>'state' IN ('succeeded', 'failed', 'expired') LIMIT 1`

const entry = (by: WatchBy, refundId: string, details: Record<string, unknown>): AuditEntry => ({
  actorType: by.actor.type,
  actorId: by.actor.id,
  action: REFUND_WATCH,
  entityType: REFUND_WATCH_ENTITY,
  entityId: refundId,
  requestId: by.requestId,
  details,
})

/**
 * The `watching` rows for a finished claim's card parts: one for each refund Stripe accepted, whatever its status
 * (W32a, call 1). R2 writes them with its finished row, in its transaction (which runs once per claim: the finished row
 * is checked under the subject's lock), so each refund is watched once.
 */
export function claimWatchEntries(
  claim: { id: string; on: Exclude<WatchSubject, 'compensation'>; subjectId: string; livemode: boolean | null },
  went: readonly CardPart[],
  refunds: readonly RefundSeen[] | undefined,
  by: WatchBy
): AuditEntry[] {
  const entries: AuditEntry[] = []
  for (const seen of refunds ?? []) {
    if (!toWatch(seen.status)) continue
    const part = went.find((one) => one.orderId === seen.orderId)
    if (!part) continue
    const details: WatchDetails = {
      state: 'watching',
      refundId: seen.refundId,
      paymentIntentId: seen.paymentIntentId,
      amount: part.amount,
      status: seen.status,
      livemode: claim.livemode,
      on: claim.on,
      subjectId: claim.subjectId,
      orderId: claim.on === 'booking' ? null : part.orderId,
      claimId: claim.id,
      lines: part.lines,
    }
    entries.push(entry(by, seen.refundId, { ...details }))
  }
  return entries
}

/** The refunds of the parts that went, for the finished row (`refunds`): none when no refund is known for a part. */
export const refundsForRow = (went: readonly CardPart[], refunds: readonly RefundSeen[] | undefined): { refunds?: RefundSeen[] } => {
  const kept = (refunds ?? []).filter((seen) => went.some((part) => part.orderId === seen.orderId))
  return kept.length > 0 ? { refunds: kept } : {}
}

/**
 * A refund with no claim behind it, watched once however many times it is seen: an advisory lock on the refund's id
 * makes two runs at once queue, and the second finds the row. False when it was watched already.
 */
async function watchOnce(tx: Tx, details: WatchDetails, by: WatchBy): Promise<boolean> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`refund-watch:${details.refundId}`])
  const there = await tx.query(WATCH_THERE_SQL, [details.refundId])
  if (there.length > 0) return false
  await audit.record(tx, entry(by, details.refundId, { ...details }))
  return true
}

/**
 * A compensation refund Stripe accepted: its `watching` row, written once however many times the same refund is seen
 * (a compensation is sent again under its key until every step is confirmed, and Stripe answers the key with the same
 * refund).
 */
export async function watchCompensationRefund(
  tx: Tx,
  refund: { refundId: string; paymentIntentId: string; amountPence: number | null; status: string | null; step: string },
  orderId: string,
  livemode: boolean | null,
  by: WatchBy
): Promise<void> {
  await watchOnce(
    tx,
    {
      state: 'watching',
      refundId: refund.refundId,
      paymentIntentId: refund.paymentIntentId,
      amount: Math.round(refund.amountPence ?? 0) / 100,
      status: refund.status,
      livemode,
      on: 'compensation',
      subjectId: orderId,
      orderId: null,
      claimId: null,
      lines: [],
      step: refund.step,
    },
    by
  )
}

/**
 * W32a (W32 review S3): a late payment's automatic refund (reconcile.ts, settleLateRefund), handed to the same rows
 * once Stripe has given it an id, so it is watched once, for the same days, and a failure is one line. If the payment's
 * refund is a compensation's (the same refund under the same key), that watch is the one kept. Its order or flow is
 * gone, so a failure is a line for a person, as a compensation's is.
 */
export async function watchLateRefund(
  tx: Tx,
  refund: { refundId: string; paymentIntentId: string; amountPence: number | null; status: string | null },
  on: { type: 'order' | 'reader_payment'; id: string },
  livemode: boolean | null,
  by: WatchBy
): Promise<void> {
  await watchOnce(
    tx,
    {
      state: 'watching',
      refundId: refund.refundId,
      paymentIntentId: refund.paymentIntentId,
      amount: Math.round(refund.amountPence ?? 0) / 100,
      status: refund.status,
      livemode,
      on: 'compensation',
      subjectId: on.id,
      orderId: null,
      claimId: null,
      lines: [],
      step: LATE_REFUND_STEP,
      late: on.type,
    },
    by
  )
}

/** How a watch ended. `sorted`: a person closed a `failed` or `expired` line by hand. */
export type WatchEnd = 'succeeded' | 'failed' | 'expired' | 'sorted'

/**
 * W32a (review S1): a read that ended nothing: the status seen (the last one known when Stripe couldn't be read) and
 * why the watch goes on. The newest of these is the watch's "last read".
 */
export const watchCheckedEntry = (by: WatchBy, refundId: string, status: string | null, reason: string): AuditEntry => entry(by, refundId, { state: 'checked', refundId, status, reason })

/** A watch's end row, for the caller's own transaction. */
export const watchEndEntry = (by: WatchBy, refundId: string, state: WatchEnd, details: Record<string, unknown> = {}): AuditEntry => entry(by, refundId, { state, refundId, ...details })

/** True once the refund's watch has ended (`succeeded`, `failed` or `expired`): read under the subject's lock before it is ended. */
export async function watchEnded(db: Queryable, refundId: string): Promise<boolean> {
  return (await db.query(WATCH_ENDED_SQL, [refundId])).length > 0
}

/** One watched refund that hasn't ended and is due a read, as reconcile reads it. */
export interface WatchDue {
  id: string
  at: unknown
  /** Past the watch's days (`$1`): this run ends the watch, quietly if it reads `succeeded`, else for a person, unless Stripe now shows a failure. */
  expired: boolean
  details: WatchDetails
  /** W32a: the status at its last read (its first status until it has been read). */
  lastStatus: string | null
  /** W32a: when it was last read (when it was recorded, until it has been). */
  readAt: unknown
}

/** The newest `checked` row of the watch `w`: its last read. */
const LAST_READ_SQL = `
  LEFT JOIN LATERAL (
    SELECT c.at, c.details->>'status' AS status
    FROM audit_log c
    WHERE c.action = '${REFUND_WATCH}' AND c.entity_type = '${REFUND_WATCH_ENTITY}' AND c.entity_id = w.entity_id AND c.details->>'state' = 'checked'
    ORDER BY c.at DESC
    LIMIT 1
  ) l ON true`
const LAST_STATUS_SQL = `(CASE WHEN l.at IS NULL THEN w.details->>'status' ELSE l.status END)`
const NOT_ENDED_SQL = `
  NOT EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${REFUND_WATCH}' AND e.entity_type = '${REFUND_WATCH_ENTITY}' AND e.entity_id = w.entity_id
      AND e.details->>'state' IN ('succeeded', 'failed', 'expired')
  )`

/**
 * The watched refunds due a read, the one read longest ago first, at most `$3` of them (W32a, review S1: the list
 * decides, so a run's budget always goes to the ones waiting longest and none is starved). Due: past its days (`$1`:
 * WATCH_DAYS); or its last status isn't `succeeded` (still going, or a failure waiting to be put back); or it reads
 * `succeeded` and hasn't been read for `$2` hours (WATCH_READ_HOURS; 0 on a staff run, which reads whatever is oldest).
 */
export const WATCHES_DUE_SQL = `
SELECT w.id, w.at, (w.at < now() - make_interval(days => $1::int)) AS expired, w.details,
       ${LAST_STATUS_SQL} AS "lastStatus", COALESCE(l.at, w.at) AS "readAt"
FROM audit_log w${LAST_READ_SQL}
WHERE w.action = '${REFUND_WATCH}' AND w.entity_type = '${REFUND_WATCH_ENTITY}' AND w.details->>'state' = 'watching'
  AND${NOT_ENDED_SQL}
  AND (w.at < now() - make_interval(days => $1::int)
       OR ${LAST_STATUS_SQL} IS DISTINCT FROM 'succeeded'
       OR COALESCE(l.at, w.at) <= now() - make_interval(hours => $2::int))
ORDER BY COALESCE(l.at, w.at), w.id
LIMIT $3::int`

/**
 * W67 (H14): one refund's watch (`$2`, Stripe's refund id), not ended, as the due list reads it but whether it is due
 * or not: the late path (reconcile.ts, settleLateRefund) reads it in the same run when it meets that refund failed.
 * `$1` as WATCHES_DUE_SQL's.
 */
export const WATCH_OF_REFUND_SQL = `
SELECT w.id, w.at, (w.at < now() - make_interval(days => $1::int)) AS expired, w.details,
       ${LAST_STATUS_SQL} AS "lastStatus", COALESCE(l.at, w.at) AS "readAt"
FROM audit_log w${LAST_READ_SQL}
WHERE w.action = '${REFUND_WATCH}' AND w.entity_type = '${REFUND_WATCH_ENTITY}' AND w.details->>'state' = 'watching'
  AND w.entity_id = $2
  AND${NOT_ENDED_SQL}
ORDER BY w.at, w.id
LIMIT 1`

/**
 * W32a (review S2): how many watched refunds are still on their way at Stripe (their last status is neither
 * `succeeded` nor an end): what Resolve now shows as "waiting on Stripe". Nothing to do for any of them.
 */
export const WATCHES_WAITING_SQL = `
SELECT count(*)::int AS waiting
FROM audit_log w${LAST_READ_SQL}
WHERE w.action = '${REFUND_WATCH}' AND w.entity_type = '${REFUND_WATCH_ENTITY}' AND w.details->>'state' = 'watching'
  AND${NOT_ENDED_SQL}
  AND COALESCE(${LAST_STATUS_SQL}, '') NOT IN ('succeeded', 'failed', 'canceled')`

/**
 * The watches the stuck list shows: ended `failed` or `expired`, and not yet marked sorted. Newest end first. With
 * `$1` (a watch's id, as text) only that one: what the manual close reads.
 */
export const WATCHES_LISTED_SQL = `
SELECT w.id, w.entity_id AS refund_id, w.details, e.at AS ended_at, e.details->>'state' AS state, e.details AS ended
FROM audit_log w
JOIN audit_log e ON e.action = '${REFUND_WATCH}' AND e.entity_type = '${REFUND_WATCH_ENTITY}' AND e.entity_id = w.entity_id
  AND e.details->>'state' IN ('failed', 'expired')
WHERE w.action = '${REFUND_WATCH}' AND w.entity_type = '${REFUND_WATCH_ENTITY}' AND w.details->>'state' = 'watching'
  AND ($1::text IS NULL OR w.id::text = $1::text)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log s
    WHERE s.action = '${REFUND_WATCH}' AND s.entity_type = '${REFUND_WATCH_ENTITY}' AND s.entity_id = w.entity_id AND s.details->>'state' = 'sorted'
  )
ORDER BY e.at DESC, w.id`
