// New in W47 (W25 review L1 and L2; the W26 audit's rows 28 and 29): what a watched payment's readers share.
//
// A watched payment (W25) is a saved-card payment that was still at the bank when a person undid its booking change by
// hand (the manual close's `held_flow`). Reconcile reads it every run (reconcile.ts, checkWatchedPayment): if it goes
// through it is handed to the automatic refund; cancelled, or it took nothing, the watch ends. Until W47:
// - it showed nowhere while it was watched, and every Resolve now counted it as "1 left for a person" with nothing
//   on the list to act on (L1). Now it is a line of its own on the stuck list ("nothing to do"), and a read that ends
//   nothing is no item of the run: it is counted in `paymentsWatched`, never in `left`;
// - a watch never ended when Stripe couldn't read the payment (the other Stripe mode, or the record never said which
//   mode it was made in): one Stripe read a run for ever (L2). Now, once a payment has been watched for
//   PAYMENT_WATCH_DAYS and Stripe still can't find it with the key in use, the watch ends `expired`: a line for a
//   person, with Mark sorted (the manual close's `payment_watch`).
//
// W47a (W47 review S2): that is the only way a watch runs out. W47 ended it on any read with no clear answer, which
// took in a payment Stripe reads and still shows as `processing`; nothing read it again, so had it gone through after
// a person pressed Mark sorted, money would have been taken with nothing recorded or refunded. A payment Stripe can
// read stays watched until it ends, however long that takes, and Mark sorted reads the payment again and refuses
// while it hasn't ended (close-stuck.ts).
//
// W47b (W47a "Noticed" 1 and 2): `expired` is no longer always an end. When a person presses Mark sorted and Stripe
// can find the payment after all (the key was put right), the payment isn't sorted: a `handed_back` row ends the
// `expired` rows it names (`ends`), and the watch is read again by every run, exactly as before it ran out. Until W47b
// an expired watch was never read again, so a payment that went through after the key was put right was kept unless a
// person refunded it by hand; Mark sorted let it be sorted unrefunded.
//
// Rows, all `reader_payment.payment_watched` on the flow's own id: `watching` (the close), then one end: `landed`,
// `nothing_taken`, or `expired`; after `expired`, `sorted` once a person has marked it (Stripe still can't find it), or
// `handed_back` (Stripe can: watched again, so one of the ends follows). Read-only text: nothing here writes.
import 'server-only'
import { FLOW_CHARGE_WITHOUT_RECORD, FLOW_PAYMENT_WATCHED } from './reader-flow'

/**
 * How many days a payment Stripe can't find with the key in use is watched before the watch ends for a person. My
 * call (the W25 review said "say, 30"): one unreadable for a month will not become readable with the key in use.
 * W47a: no limit applies to a payment Stripe can read (above).
 */
export const PAYMENT_WATCH_DAYS = 30

/**
 * W47b: the `expired` row `row` was handed back to the automatic check (Mark sorted found the payment in Stripe): a
 * `handed_back` row for the same flow names it in `ends`. By the row's id, never by time: two rows written in one
 * moment can't be told apart by `at`, and a hand-back must end exactly the expiries it saw, not a later one.
 */
const HANDED_BACK_SQL = (row: string): string => `
        SELECT 1 FROM audit_log h
        WHERE h.entity_type = 'reader_payment' AND h.entity_id = ${row}.entity_id AND h.action = '${FLOW_PAYMENT_WATCHED}'
          AND h.details->>'state' = 'handed_back' AND (h.details->'ends') ? (${row}.id::text)`

/**
 * The end rows for the payment the `watching` row `w` names: read by every list below. W47b: an `expired` row that
 * was handed back is no end.
 */
const ENDED_SQL = (states: string): string => `
    SELECT 1 FROM audit_log d
    WHERE d.entity_type = 'reader_payment' AND d.entity_id = w.entity_id AND d.details->>'paymentIntentId' = w.details->>'paymentIntentId'
      AND ((d.action = '${FLOW_PAYMENT_WATCHED}' AND d.details->>'state' IN (${states})
            AND NOT (d.details->>'state' = 'expired' AND EXISTS (${HANDED_BACK_SQL('d')}
            )))
           OR d.action = '${FLOW_CHARGE_WITHOUT_RECORD}')`

/** W47b: the `expired` rows of the payment the `watching` row `w` names that no hand-back has ended. */
const EXPIRED_ROWS_SQL = `
        FROM audit_log e
        WHERE e.entity_type = 'reader_payment' AND e.entity_id = w.entity_id AND e.action = '${FLOW_PAYMENT_WATCHED}'
          AND e.details->>'paymentIntentId' = w.details->>'paymentIntentId' AND e.details->>'state' = 'expired'
          AND NOT EXISTS (${HANDED_BACK_SQL('e')}
          )`

/**
 * The payments a manual close left watched (`watching` rows) with no end yet: `landed`, `nothing_taken` or `expired`,
 * or a `charge_without_record` row for that payment (the automatic refund has it). Oldest first. `past_window`: it has
 * been watched for `$1` days, so a read on which Stripe still can't find it ends the watch for a person.
 * W47b: a watch handed back by Mark sorted is here again (its `expired` rows no longer count), still `past_window`:
 * if the key in use stops finding the payment again, the next read ends the watch for a person again.
 */
export const WATCHED_PAYMENTS_DUE_SQL = `
SELECT w.entity_id, w.details->>'paymentIntentId' AS payment_intent_id, (w.details->>'livemode')::boolean AS livemode,
       w.details->>'flow' AS flow, w.details->>'recordId' AS record_id,
       (w.at < now() - make_interval(days => $1::int)) AS past_window
FROM audit_log w
WHERE w.action = '${FLOW_PAYMENT_WATCHED}' AND w.entity_type = 'reader_payment' AND w.details->>'state' = 'watching'
  AND NOT EXISTS (${ENDED_SQL("'landed', 'nothing_taken', 'expired'")}
  )
ORDER BY w.at, w.id`

/** How many payments are still being watched: what Resolve now shows beside the refunds waiting on Stripe. */
export const WATCHED_PAYMENTS_COUNT_SQL = `
SELECT count(*)::int AS watched
FROM audit_log w
WHERE w.action = '${FLOW_PAYMENT_WATCHED}' AND w.entity_type = 'reader_payment' AND w.details->>'state' = 'watching'
  AND NOT EXISTS (${ENDED_SQL("'landed', 'nothing_taken', 'expired'")}
  )`

/**
 * What the stuck list shows: every payment still watched (`expired` null), and every watch that ran out and hasn't
 * been marked sorted (`expired`: its end row's details). Oldest first. With `$1` (a `watching` row's id, as text)
 * only that one: what the manual close reads. The customer is the undone change's, from its record.
 * W47b: a watch handed back is watched again (`expired` null); `expired_ids` are the `expired` rows still standing,
 * which a hand-back names.
 */
export const WATCHED_PAYMENTS_LISTED_SQL = `
SELECT w.id, w.entity_id, w.at, w.details->>'paymentIntentId' AS payment_intent_id, w.details->>'flow' AS flow, w.details->>'recordId' AS record_id,
       c.first_name, c.last_name,
       (SELECT e.details${EXPIRED_ROWS_SQL}
        ORDER BY e.at DESC LIMIT 1) AS expired,
       ARRAY(SELECT e.id::text${EXPIRED_ROWS_SQL}
        ORDER BY e.at, e.id) AS expired_ids
FROM audit_log w
LEFT JOIN pending_reader_payments p ON p.id::text = w.entity_id
LEFT JOIN customers c ON c.id::text = p.snapshot->>'customer_id'
WHERE w.action = '${FLOW_PAYMENT_WATCHED}' AND w.entity_type = 'reader_payment' AND w.details->>'state' = 'watching'
  AND ($1::text IS NULL OR w.id::text = $1::text)
  AND NOT EXISTS (${ENDED_SQL("'landed', 'nothing_taken', 'sorted'")}
  )
ORDER BY w.at, w.id`

export interface ListedWatchedPayment {
  id: string
  entity_id: string
  at: unknown
  payment_intent_id: string
  flow: string | null
  record_id: string | null
  first_name: string | null
  last_name: string | null
  expired: { detail?: string | null } | null
  /** W47b: the ids of the `expired` rows no hand-back has ended (none while it is watched). */
  expired_ids: string[]
}

/** The stuck list's words for a watched payment (W47). */
export const WATCHED_PAYMENT_WORDS = {
  watching: (paymentIntentId: string): string =>
    `A card payment (${paymentIntentId}) was still at the bank when its booking change was undone by hand. The automatic check reads it every 5 minutes: if it goes through, it is refunded automatically and shows on this list until Stripe confirms the refund; if it takes nothing, this line goes. Nothing to do. Don't refund it by hand.`,
  // W47a (W47 review S2): a watch now runs out one way only (Stripe can't find the payment with the key in use), so
  // the line says that in its own words. Until W47a it quoted the last read's message, which for a payment still
  // `processing` was the refused cancel's, under words saying Stripe couldn't say how it ended.
  expired: (paymentIntentId: string): string =>
    `A card payment (${paymentIntentId}) was still at the bank when its booking change was undone by hand, and after ${PAYMENT_WATCH_DAYS} days Stripe still can't say how it ended with the payment account the system is using: it can't find the payment there (the system's Stripe key may be for the other Stripe mode, live or test, than the payment). So the automatic check has stopped watching it. Look at the payment in Stripe: if it took money, refund it there by hand (or tell a manager). Then press Mark sorted (needs the Issue refunds permission).`,
} as const
