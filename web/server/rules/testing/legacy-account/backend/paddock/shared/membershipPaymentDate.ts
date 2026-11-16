/**
 * Payment date change rules for monthly memberships (brief 13), shared by the read-only
 * getMembershipPaymentDateQuote, getCustomerDetail and getSubscriptions (so the button shows
 * the same refusal the action would give) and by changeMembershipPaymentDate, which re-checks
 * them against the live row. Read-only: no write SQL may be added here (CLAUDE.md).
 *
 * Rules: monthly only; the membership is active, has no scheduled cancellation, no failing or
 * overdue payment and no Payment needed bookings; it has a Stripe subscription and the customer
 * a saved card. The new date is after the current next_renewal_date and before the renewal
 * after it (Postgres `date + interval '1 month'`, the same as the Worker). One change every
 * 6 months ('done' rows) unless staff override with a reason.
 *
 * The part-month charge uses membership_plans.price_monthly: since 25 Oct a plan price change
 * moves every member to the new price from their next renewal, and the extra days always fall
 * after the next renewal date, so the plan price is what they pay for those days.
 */
// The runtime globals (paddockData) are typed by the generated declarations in backend/resources/.
import '../globals'
import { formatIsoDate } from './formatIsoDate'

/** Columns for the button's refusal; needs `cm` (customer_memberships) and `c` (customers) in
 *  the query and PAYMENT_DATE_CHANGE_JOIN_SQL after them. */
export const PAYMENT_DATE_CHANGE_COLUMNS_SQL = `
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

/** The membership's latest 'done' payment date change. */
export const PAYMENT_DATE_CHANGE_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT created_at, new_renewal_date FROM membership_payment_date_changes
    WHERE membership_id = cm.id AND status = 'done'
    ORDER BY created_at DESC LIMIT 1
  ) pdc_last ON true`

export interface PaymentDateChangeFacts {
  billing_frequency: string | null
  subscription_status: string | null
  stripe_subscription_id: string | null
  pdc_next_renewal_date: string | null
  pdc_cancel_effective_date: string | null
  pdc_today: string
  pdc_has_payment_needed: boolean
  pdc_has_saved_card: boolean
  pdc_last_done_at: string | null
  /** London date of pdc_last_done_at, YYYY-MM-DD. */
  pdc_last_done_on: string | null
  pdc_last_done_new_date: string | null
  pdc_within_six_months: boolean
  pdc_pending: boolean
}

/** What the screens show beside the next payment date. */
export interface PaymentDateChangeStatus {
  /** When the payment date was last changed ('done' row), or null. */
  payment_date_changed_at: string | null
  /** Why "Change payment date" is refused right now (null = allowed). Not set for yearly. */
  payment_date_change_blocked: string | null
  /** A change in the last 6 months: staff must tick Override and give a reason. */
  payment_date_change_needs_override: boolean
}

export const YEARLY_REFUSAL = "Yearly memberships renew once a year, so the payment date can't be changed"

/** The first rule that refuses a payment date change, or null when it's allowed (the 6-month
 *  rule is separate: it can be overridden). */
export function paymentDateChangeRefusal(f: PaymentDateChangeFacts): string | null {
  if (f.billing_frequency !== 'monthly') return YEARLY_REFUSAL
  if (f.subscription_status === 'past_due') return 'A payment is failing on this membership'
  if (f.subscription_status !== 'active') return "This membership isn't active"
  if (f.pdc_cancel_effective_date) return 'A cancellation is scheduled on this membership'
  if (!f.pdc_next_renewal_date || f.pdc_next_renewal_date < f.pdc_today) return 'The renewal payment is overdue'
  if (f.pdc_has_payment_needed) return 'Bookings on this membership are waiting for payment (Payment needed)'
  if (!f.stripe_subscription_id) return 'This membership has no Stripe subscription'
  if (!f.pdc_has_saved_card) return 'The customer has no saved card for the charge'
  // Until the last change's new date arrives the Stripe subscription is in its no-charge period
  // ('trialing'), which the Worker refuses — say so plainly instead.
  if (f.pdc_last_done_new_date && f.pdc_last_done_new_date >= f.pdc_next_renewal_date) {
    const changedOn = f.pdc_last_done_on ? `Changed on ${formatIsoDate(f.pdc_last_done_on)}. ` : ''
    return `${changedOn}It can be changed again from ${formatIsoDate(f.pdc_last_done_new_date)}.`
  }
  if (f.pdc_pending) return 'A payment date change is already in progress for this membership'
  return null
}

export function paymentDateChangeStatus(f: PaymentDateChangeFacts): PaymentDateChangeStatus {
  return {
    payment_date_changed_at: f.pdc_last_done_at,
    payment_date_change_blocked: paymentDateChangeRefusal(f),
    payment_date_change_needs_override: f.pdc_within_six_months,
  }
}

/** Drops the pdc_* helper columns from a row once paymentDateChangeStatus has read them. */
type PaymentDateFactColumn = Extract<keyof PaymentDateChangeFacts, `pdc_${string}`>

export function withoutPaymentDateFacts<T extends object>(row: T): Omit<T, PaymentDateFactColumn> {
  const copy = { ...row } as Record<string, unknown>
  for (const key of Object.keys(copy)) {
    if (key.startsWith('pdc_')) delete copy[key]
  }
  return copy as Omit<T, PaymentDateFactColumn>
}

export interface PaymentDateQuote {
  membershipId: string
  customerId: string
  planId: string
  stripeSubscriptionId: string | null
  /** Refusal (as paymentDateChangeRefusal), or null when a change is allowed. */
  refusal: string | null
  needsOverride: boolean
  lastChangedAt: string | null
  currentRenewalDate: string | null
  /** First and last allowed new dates (YYYY-MM-DD), null when refused for a date reason. */
  earliestDate: string | null
  latestDate: string | null
  /** Days from the current renewal date to the same day a month later. */
  daysInPeriod: number | null
  monthlyPrice: number | null
  cardLast4: string | null
  cardBrand: string | null
  /** Only when a new date was given and is inside the window. */
  newRenewalDate?: string
  extraDays?: number
  /** Pounds, rounded to the penny: monthly price × extra days ÷ days in the period. */
  amount?: number
  /** Set when a new date was given but is outside the window. */
  dateError?: string
}

interface QuoteRow extends PaymentDateChangeFacts {
  id: string
  customer_id: string
  plan_id: string
  price_monthly: string | null
  saved_card_last4: string | null
  saved_card_brand: string | null
  earliest_date: string | null
  latest_date: string | null
  days_in_period: number | null
  extra_days: number | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Live quote for one membership; null when the membership doesn't exist. */
export async function loadPaymentDateQuote(membershipId: string, newRenewalDate?: string): Promise<PaymentDateQuote | null> {
  const date = newRenewalDate && DATE_RE.test(newRenewalDate) ? newRenewalDate : null
  const result = await paddockData.query<QuoteRow>(
    `SELECT cm.id, cm.customer_id, cm.plan_id, cm.billing_frequency, cm.subscription_status, cm.stripe_subscription_id,
            mp.price_monthly::text AS price_monthly, c.saved_card_last4, c.saved_card_brand,
            (cm.next_renewal_date + 1)::text AS earliest_date,
            ((cm.next_renewal_date + interval '1 month')::date - 1)::text AS latest_date,
            ((cm.next_renewal_date + interval '1 month')::date - cm.next_renewal_date) AS days_in_period,
            ($1::date - cm.next_renewal_date) AS extra_days,
            ${PAYMENT_DATE_CHANGE_COLUMNS_SQL}
     FROM customer_memberships cm
     JOIN membership_plans mp ON mp.id = cm.plan_id
     JOIN customers c ON c.id = cm.customer_id
     ${PAYMENT_DATE_CHANGE_JOIN_SQL}
     WHERE cm.id = $2`,
    [date, membershipId]
  )
  const row = result.data[0]
  if (!row) return null

  const refusal = paymentDateChangeRefusal(row)
  const monthlyPrice = row.price_monthly !== null ? Number.parseFloat(row.price_monthly) : null
  const quote: PaymentDateQuote = {
    membershipId: row.id,
    customerId: row.customer_id,
    planId: row.plan_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    refusal: refusal ?? (monthlyPrice !== null && monthlyPrice > 0 ? null : 'The plan has no monthly price'),
    needsOverride: row.pdc_within_six_months,
    lastChangedAt: row.pdc_last_done_at,
    currentRenewalDate: row.pdc_next_renewal_date,
    earliestDate: row.earliest_date,
    latestDate: row.latest_date,
    daysInPeriod: row.days_in_period !== null ? Number(row.days_in_period) : null,
    monthlyPrice,
    cardLast4: row.saved_card_last4,
    cardBrand: row.saved_card_brand,
  }

  if (newRenewalDate !== undefined) {
    const extraDays = row.extra_days !== null ? Number(row.extra_days) : null
    const days = quote.daysInPeriod
    if (!date || extraDays === null || !row.earliest_date || !row.latest_date || date < row.earliest_date || date > row.latest_date) {
      quote.dateError =
        row.earliest_date && row.latest_date
          ? `Choose a date from ${formatIsoDate(row.earliest_date)} to ${formatIsoDate(row.latest_date)}`
          : 'This membership has no next renewal date'
    } else if (days && monthlyPrice !== null) {
      const pricePence = Math.round(monthlyPrice * 100)
      quote.newRenewalDate = date
      quote.extraDays = extraDays
      quote.amount = Math.round((pricePence * extraDays) / days) / 100
    }
  }
  return quote
}
