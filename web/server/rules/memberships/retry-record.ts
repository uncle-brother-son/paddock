// W47r-a: the names of a payment retry's record ("Try the payment again now", memberships/retry-payment.ts), in a file
// that imports nothing, so the lapse sweep's cancel (bookings/cancel.ts) can ask "is a retry open on this membership"
// without loading the retry's rule (and Stripe's client with it), and so there is one list of the rows that end a
// retry. Read-only: no statement here writes.
import 'server-only'

/** Every row about a retry: `started`, `held`, and one of the closing states, each naming the retry (`retryId`). */
export const PAYMENT_RETRY_ACTION = 'membership.payment_retried'
export const PAYMENT_RETRY_ENTITY = 'membership'

/**
 * The rows that end a retry. `started` opens it; `held` is a note on one still open.
 * `refunded` (W47r-a, W47r review S1): the payment was taken after the subscription had ended, a person refunded it in
 * Stripe, and Mark refunded found it refunded there in full.
 */
export const PAYMENT_RETRY_CLOSING_STATES = ['paid', 'declined', 'not_taken', 'not_sent', 'refunded'] as const
export type PaymentRetryClosingState = (typeof PAYMENT_RETRY_CLOSING_STATES)[number]
export const PAYMENT_RETRY_CLOSING_SQL = PAYMENT_RETRY_CLOSING_STATES.map((state) => `'${state}'`).join(', ')

/**
 * W47r-a (W47r review S2 b): how long an open retry keeps the lapse sweep off its membership's credit bookings. The
 * hour the banner's line for Stripe's notices uses (orders/stuck-list.ts, WEBHOOK_ERROR_MINUTES; a test holds the two
 * equal): a payment taken at the desk is recorded by the automatic check within minutes, and by Stripe's own notice
 * well inside the hour. Past it the bookings lapse as they always did: a retry that never ends (its payment waiting on
 * the customer for ever) must not keep unpaid bookings for ever.
 */
export const PAYMENT_RETRY_HOLDS_LAPSE_MINUTES = 60

/**
 * Whether a membership (`$1`, as text) has an open retry started less than `$2` minutes ago: a `started` row with no
 * closing row. One row when it has.
 */
export const RECENT_OPEN_RETRY_SQL = `
SELECT 1 FROM audit_log s
WHERE s.action = '${PAYMENT_RETRY_ACTION}' AND s.entity_type = '${PAYMENT_RETRY_ENTITY}' AND s.entity_id = $1::text AND s.details->>'state' = 'started'
  AND s.at > now() - make_interval(mins => $2::int)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${PAYMENT_RETRY_ACTION}' AND e.entity_type = '${PAYMENT_RETRY_ENTITY}' AND e.entity_id = s.entity_id
      AND e.details->>'retryId' = s.details->>'retryId' AND e.details->>'state' IN (${PAYMENT_RETRY_CLOSING_SQL})
  )
LIMIT 1`
