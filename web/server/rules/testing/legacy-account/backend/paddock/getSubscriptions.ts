import {
  PAYMENT_DATE_CHANGE_COLUMNS_SQL,
  PAYMENT_DATE_CHANGE_JOIN_SQL,
  paymentDateChangeStatus,
  withoutPaymentDateFacts,
  type PaymentDateChangeFacts,
  type PaymentDateChangeStatus,
} from './shared/membershipPaymentDate'

export interface SubscriptionRow extends PaymentDateChangeStatus {
  id: string
  customer_id: string
  first_name: string
  last_name: string
  email: string
  plan_name: string
  subscription_status: string
  cancel_effective_date: string | null
  billing_frequency: string
  start_date: string
  next_renewal_date: string
  /** Whether the plan is unlimited — session credit display comes from the CURRENT period. */
  plan_is_unlimited: boolean
  /** Current credit period (from membership_current_credits) — null when no period covers today. */
  current_period_end: string | null
  current_period_credits_allocated: number | null
  current_period_credits_remaining: number | null
  addon_credits_remaining: number
  /** Herd membership flag — add-on credits are usable if and only if this is true. */
  is_herd: boolean
  /** Manual Herd override by staff (null = automatic rule). */
  herd_override: boolean | null
  created_at: string
}

type SubscriptionQueryRow = Omit<SubscriptionRow, keyof PaymentDateChangeStatus> & PaymentDateChangeFacts & { stripe_subscription_id: string | null }

function toSubscriptionRow(row: SubscriptionQueryRow): SubscriptionRow {
  const { stripe_subscription_id: _stripeSubscriptionId, ...rest } = withoutPaymentDateFacts(row)
  return { ...rest, ...paymentDateChangeStatus(row) }
}

export interface GetSubscriptionsParams {
  search?: string
}

/**
 * Newest customer memberships with their customer and plan details, for the Subscriptions page.
 * Optional `search` matches (case-insensitively) on customer first name, last name, email, or
 * plan name — multi-word: every word must match a customer field, and the full "first last"
 * name matches as a whole (see getCustomers). Newest first by created_at, capped at 200 rows.
 */
export default async function getSubscriptions(req: { params?: GetSubscriptionsParams }): Promise<SubscriptionRow[]> {
  const search = req.params?.search?.trim()

  const baseSelect = `
    SELECT
      cm.id,
      cm.customer_id,
      c.first_name,
      c.last_name,
      c.email,
      mp.name AS plan_name,
      cm.subscription_status,
      cm.cancel_effective_date,
      cm.billing_frequency,
      cm.start_date,
      cm.next_renewal_date,
      mp.is_unlimited AS plan_is_unlimited,
      mcc.period_end AS current_period_end,
      mcc.credits_allocated AS current_period_credits_allocated,
      mcc.credits_remaining AS current_period_credits_remaining,
      cm.addon_credits_remaining,
      cm.is_herd,
      cm.herd_override,
      cm.created_at,
      cm.stripe_subscription_id,
      ${PAYMENT_DATE_CHANGE_COLUMNS_SQL}
    FROM customer_memberships cm
    JOIN customers c ON c.id = cm.customer_id
    JOIN membership_plans mp ON mp.id = cm.plan_id
    LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
    ${PAYMENT_DATE_CHANGE_JOIN_SQL}
  `

  if (search) {
    // Same multi-word customer match as getCustomers: each whitespace-separated word must hit
    // first/last name, email or phone, and the whole search also matches the full
    // "first last" name as one string. The plan name keeps matching the whole search, as before.
    const words = search.split(/\s+/).filter((word) => word.length > 0)
    const params: string[] = []
    const clauses: string[] = []
    for (const word of words) {
      const start = params.length + 1
      params.push(`%${word}%`, `%${word}%`, `%${word}%`, `%${word}%`)
      clauses.push(
        `(c.first_name ILIKE $${start} OR c.last_name ILIKE $${start + 1} OR c.email ILIKE $${start + 2} OR c.phone ILIKE $${start + 3})`
      )
    }
    params.push(`%${search}%`)
    const fullNameClause = `((c.first_name || ' ' || c.last_name) ILIKE $${params.length})`
    params.push(`%${search}%`)
    const planClause = `(mp.name ILIKE $${params.length})`
    // The whole-search matches (full name, plan name) are ALTERNATIVES to the per-word clauses
    // (searching "Holland Wayne" must still find "Wayne Holland" via the words), not extra ANDs.
    const whereClause = words.length > 0
      ? `(${clauses.join(' AND ')} OR ${fullNameClause} OR ${planClause})`
      : `(${fullNameClause} OR ${planClause})`
    const result = await paddockData.query<SubscriptionQueryRow>(
      `${baseSelect}
       WHERE ${whereClause}
       ORDER BY cm.created_at DESC
       LIMIT 200`,
      params
    )
    return result.data.map(toSubscriptionRow)
  }

  const result = await paddockData.query<SubscriptionQueryRow>(
    `${baseSelect}
     ORDER BY cm.created_at DESC
     LIMIT 200`
  )
  return result.data.map(toSubscriptionRow)
}
