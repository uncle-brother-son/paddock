// W12a (W12 review S1, part 1): Worker orders the old screens moved out of `pending` while their payment was
// unconfirmed. From minute 15 the old booking checks no longer protect a held Worker card order (it has no
// reader PaymentIntent on it), so the old Cancel & Refund can give the booking's money back as store credit
// and set the order `partially_refunded`, with no record of it. Reconcile and the stuck list select only
// `pending` orders, so without this nobody would see the order again. Reconcile reads Stripe for these and
// records what it finds (money taken or not, with the amount); it never cancels, refunds, finalises or undoes
// them. The stuck list shows them for a person to put right by hand.
//
// Read-only: shared by reconcile.ts (which writes its `order.reconcile` rows itself) and stuck-list.ts.
import 'server-only'

/** How far back (by the order's `created_at`) reconcile and the stuck list look for these orders. */
export const CHANGED_ELSEWHERE_DAYS = 30

/** The reason they are listed and recorded under. */
export const CHANGED_ELSEWHERE = 'changed_elsewhere'

/**
 * Worker card or reader orders (their pending record carries the Worker's `method`) that are neither
 * `pending` nor `paid`, made in the last CHANGED_ELSEWHERE_DAYS and over the 15-minute window old, that
 * neither T2 nor the undo settled:
 * - T2 sets the order `paid` with its PaymentIntent and writes `order.paid`; the old reader finalise also
 *   sets `stripe_payment_intent_id`. So an order with a PaymentIntent on it, or an `order.paid` row, was paid
 *   (and anything after that is an ordinary refund, not this).
 * - The undo deletes the order and writes `order.undo`, so an undone order isn't here; the row check is for
 *   safety only.
 * Fast: the `created_at` range uses `idx_orders_created`, so only the last 30 days of orders are read, and
 * each candidate's audit rows are read through `audit_log_entity_idx` (entity_type, entity_id).
 * `$1`: the window in minutes; `$2`: CHANGED_ELSEWHERE_DAYS.
 */
export const CHANGED_ELSEWHERE_WHERE = `
o.payment_status NOT IN ('pending', 'paid')
AND o.reader_payment IS NOT NULL
AND o.reader_payment->>'method' IN ('card', 'reader')
AND o.stripe_payment_intent_id IS NULL
AND o.created_at > now() - make_interval(days => $2::int)
AND COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) < now() - make_interval(mins => $1::int)
AND NOT EXISTS (
  SELECT 1 FROM audit_log a
  WHERE a.entity_type = 'order' AND a.entity_id = o.id::text AND a.action IN ('order.paid', 'order.undo')
)`

/**
 * What reconcile found in Stripe for one of these orders, by the intents naming it (`metadata.order_id`):
 * - `taken`: an intent succeeded; `amount` is the pence Stripe took (`amount_received`).
 * - `nothing_taken`: none found (with a key of the record's own mode), or every one found is cancelled.
 * - `open`: nothing taken yet, but an intent naming it can still be paid (reconcile never cancels it here).
 * - `unclear`: Stripe gave no clear answer, or an intent is still processing.
 * - `other_mode`: none found, but the key is of another mode than the record's, so "none" proves nothing.
 * `taken` and `nothing_taken` are final: the order isn't read again. The others are read again each run, and
 * recorded only when the finding changes.
 */
export type ChangedElsewhereState = 'taken' | 'nothing_taken' | 'open' | 'unclear' | 'other_mode'

export interface ChangedElsewhereFinding {
  state: ChangedElsewhereState
  /** Pence Stripe took (0 unless `taken`). */
  amount: number
  paymentIntentIds: string[]
}

export const FINAL_FINDINGS: readonly ChangedElsewhereState[] = ['taken', 'nothing_taken']

const SAID = 'Changed on the old screens while its payment was unconfirmed'

/** The stuck list's words for one of these orders, from reconcile's last finding (null: not looked yet). */
export function changedElsewhereWords(finding: ChangedElsewhereFinding | null): string {
  switch (finding?.state) {
    case undefined:
      return `${SAID}. The automatic check is looking in Stripe for what was taken. Don't take payment again.`
    case 'taken':
      return `${SAID}: Stripe shows £${(finding.amount / 100).toFixed(2)} taken. Check and put it right by hand.`
    case 'nothing_taken':
      return `${SAID}: Stripe shows nothing taken. Check and put it right by hand.`
    case 'open':
      return `${SAID}: Stripe shows nothing taken yet, but its payment (${finding.paymentIntentIds.join(', ')}) is still open in Stripe. Check and put it right by hand.`
    case 'unclear':
      return `${SAID}. Stripe didn't give a clear answer about its payment yet; the automatic check asks again every 5 minutes. Check and put it right by hand.`
    case 'other_mode':
      return `${SAID}. Stripe can't find its payment with the payment account in use now (it may be in the other Stripe mode, live or test). Check the payment in Stripe and put it right by hand.`
  }
}
