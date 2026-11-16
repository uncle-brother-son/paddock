// Ported in W39 from the staff app's shared/membershipPaymentDate.ts: only what the customer's profile reads, which
// is why "Change payment date" is refused on a membership row (F-plan 1.7; brief W39 item 2: the detail's membership
// rows keep today's shape). Read-only. The quote, the window and the action stay in the staff app until W41; W40
// takes over the membership rows (the Subscriptions list reads the same facts). Until then the staff app's
// getSubscriptions and its dialog still use the old module, so payment-date-status.test.ts holds this copy to it.
import 'server-only'
import { PAYMENT_DATE_REFUSALS } from './failure-messages'

/** The facts the refusal is worked out from. Needs `cm` (customer_memberships) and `c` (customers), and the join below. */
export const PAYMENT_DATE_FACTS_COLUMNS_SQL = `
  cm.next_renewal_date::text AS pdc_next_renewal_date,
  cm.cancel_effective_date::text AS pdc_cancel_effective_date,
  (now() AT TIME ZONE 'Europe/London')::date::text AS pdc_today,
  EXISTS (SELECT 1 FROM bookings pdc_b
          WHERE pdc_b.redeemed_membership_id = cm.id AND pdc_b.status = 'payment_needed') AS pdc_has_payment_needed,
  (c.stripe_customer_id IS NOT NULL AND c.saved_payment_method_id IS NOT NULL) AS pdc_has_saved_card,
  pdc_last.created_at AS pdc_last_done_at,
  (pdc_last.created_at AT TIME ZONE 'Europe/London')::date::text AS pdc_last_done_on,
  pdc_last.new_renewal_date::text AS pdc_last_done_new_date,
  COALESCE(pdc_last.created_at > now() - interval '6 months', false) AS pdc_within_six_months,
  EXISTS (SELECT 1 FROM membership_payment_date_changes pdc_p
          WHERE pdc_p.membership_id = cm.id AND pdc_p.status = 'pending'
            AND pdc_p.created_at > now() - interval '15 minutes') AS pdc_pending`

/** The membership's latest finished payment date change. */
export const PAYMENT_DATE_FACTS_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT created_at, new_renewal_date FROM membership_payment_date_changes
    WHERE membership_id = cm.id AND status = 'done'
    ORDER BY created_at DESC LIMIT 1
  ) pdc_last ON true`

export interface PaymentDateFacts {
  billing_frequency: string | null
  subscription_status: string | null
  stripe_subscription_id: string | null
  pdc_next_renewal_date: string | null
  pdc_cancel_effective_date: string | null
  pdc_today: string
  pdc_has_payment_needed: boolean
  pdc_has_saved_card: boolean
  pdc_last_done_at: Date | string | null
  /** London date of pdc_last_done_at, YYYY-MM-DD. */
  pdc_last_done_on: string | null
  pdc_last_done_new_date: string | null
  pdc_within_six_months: boolean
  pdc_pending: boolean
}

/** What the profile shows beside a membership's next payment date. */
export interface PaymentDateStatus {
  payment_date_changed_at: string | null
  payment_date_change_blocked: string | null
  payment_date_change_needs_override: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-11-28" as "28 Nov 2026", on the digits (shared/formatIsoDate). Anything else comes back unchanged. */
export function formatIsoDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.slice(0, 10))
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined
  if (!match || !month) return isoDate
  return `${Number(match[3])} ${month} ${match[1]}`
}

/** The first rule that refuses a payment date change, in the old order, or null. The 6-month rule is separate: it can be overridden. */
export function paymentDateRefusal(f: PaymentDateFacts): string | null {
  if (f.billing_frequency !== 'monthly') return PAYMENT_DATE_REFUSALS.yearly
  if (f.subscription_status === 'past_due') return PAYMENT_DATE_REFUSALS.paymentFailing
  if (f.subscription_status !== 'active') return PAYMENT_DATE_REFUSALS.notActive
  if (f.pdc_cancel_effective_date) return PAYMENT_DATE_REFUSALS.cancelScheduled
  if (!f.pdc_next_renewal_date || f.pdc_next_renewal_date < f.pdc_today) return PAYMENT_DATE_REFUSALS.renewalOverdue
  if (f.pdc_has_payment_needed) return PAYMENT_DATE_REFUSALS.paymentNeeded
  if (!f.stripe_subscription_id) return PAYMENT_DATE_REFUSALS.noSubscription
  if (!f.pdc_has_saved_card) return PAYMENT_DATE_REFUSALS.noSavedCard
  // Until the last change's new date arrives the subscription is in its no-charge period, which Stripe's side refuses.
  if (f.pdc_last_done_new_date && f.pdc_last_done_new_date >= f.pdc_next_renewal_date) {
    return PAYMENT_DATE_REFUSALS.changedRecently(f.pdc_last_done_on ? formatIsoDate(f.pdc_last_done_on) : null, formatIsoDate(f.pdc_last_done_new_date))
  }
  if (f.pdc_pending) return PAYMENT_DATE_REFUSALS.inProgress
  return null
}

export function paymentDateStatus(f: PaymentDateFacts): PaymentDateStatus {
  const changedAt = f.pdc_last_done_at
  return {
    payment_date_changed_at: changedAt === null ? null : changedAt instanceof Date ? changedAt.toISOString() : String(changedAt),
    payment_date_change_blocked: paymentDateRefusal(f),
    payment_date_change_needs_override: f.pdc_within_six_months,
  }
}
