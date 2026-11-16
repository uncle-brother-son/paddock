import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { extractApiErrorMessage } from './shared/extractApiErrorMessage'
import { getStaffAccessRow } from './shared/staffAccess'
import { loadPaymentDateQuote } from './shared/membershipPaymentDate'
import { formatIsoDate, formatIsoDatesIn } from './shared/formatIsoDate'

export interface ChangeMembershipPaymentDateParams {
  membershipId: string
  /** The new payment date (YYYY-MM-DD, London). */
  newRenewalDate: string
  /** Staff ticked Override for the once-every-6-months rule. */
  override?: boolean
  overrideReason?: string
}

export interface ChangeMembershipPaymentDateResult {
  changed: boolean
  message?: string
  /** Something to fix by hand after the money and Stripe already moved. */
  warning?: string
  newRenewalDate?: string
  extraDays?: number
  amountCharged?: number
  paymentIntentId?: string
  orderId?: string | null
}

interface WorkerChangePaymentDateResponse {
  success?: boolean
  paymentIntentId?: string
  newPeriodEnd?: string
  extraDays?: number
  warning?: string
  error?: string
  /** The Worker's failure code, e.g. 'payment_failed' for a declined card. */
  code?: string
  details?: string
}

function londonDateOfIso(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(iso))
}

/**
 * Moves a monthly membership's payment date forward (brief 13). The member pays now for the
 * extra days, then the full monthly price from the new date; credit periods and Herd stay on
 * start_date, so only the payment date moves.
 *
 * Order: every rule checked against the live row (shared/membershipPaymentDate) → a 'pending'
 * membership_payment_date_changes row → the Worker (/api/memberships/change-payment-date)
 * charges the saved card, then moves the Stripe billing date, refunding the charge itself if the
 * move fails → the charge recorded as its own order, next_renewal_date set and the row 'done',
 * in one statement. A Worker failure marks the row 'failed'. If the Worker succeeded but the
 * local write fails, the result is still a success with a warning naming what to fix by hand.
 */
export default async function changeMembershipPaymentDate(
  req: { params: ChangeMembershipPaymentDateParams; user: User }
): Promise<ChangeMembershipPaymentDateResult> {
  const { membershipId, newRenewalDate, override = false } = req.params
  const overrideReason = req.params.overrideReason?.trim() ?? ''
  if (!membershipId || !newRenewalDate) {
    return { changed: false, message: 'membershipId and newRenewalDate are required' }
  }

  // Moves money and the Stripe subscription: the same Issue refunds group as cancel / undo.
  const staff = await getStaffAccessRow(req.user.email)
  if (!staff?.can_issue_refunds) {
    return { changed: false, message: 'Needs the Issue refunds permission to change a payment date.' }
  }

  const quote = await loadPaymentDateQuote(membershipId, newRenewalDate)
  if (!quote) return { changed: false, message: 'Membership not found.' }
  if (quote.refusal) return { changed: false, message: quote.refusal }
  if (quote.dateError) return { changed: false, message: quote.dateError }
  if (!quote.stripeSubscriptionId || !quote.currentRenewalDate || quote.extraDays === undefined || quote.amount === undefined) {
    return { changed: false, message: 'Could not work out the part-month charge.' }
  }
  if (!(quote.amount > 0)) {
    return { changed: false, message: 'The part-month charge works out at £0.00, so there is nothing to charge.' }
  }
  if (quote.needsOverride && !(override && overrideReason)) {
    return {
      changed: false,
      message: 'The payment date was changed in the last 6 months. Tick Override and give a reason to change it again.',
    }
  }
  const { extraDays, amount, stripeSubscriptionId, currentRenewalDate } = quote

  // One attempt at a time: the insert only happens while no other attempt is pending.
  const pending = await paddockData.query<{ id: string }>(
    `INSERT INTO membership_payment_date_changes
       (membership_id, old_renewal_date, new_renewal_date, extra_days, amount_charged, staff_id, override_reason, status)
     SELECT $1::uuid, $2::date, $3::date, $4::int, $5::numeric, $6::uuid, $7::text, 'pending'
     WHERE NOT EXISTS (SELECT 1 FROM membership_payment_date_changes
                       WHERE membership_id = $8::uuid AND status = 'pending' AND created_at > now() - interval '15 minutes')
     RETURNING id`,
    [
      membershipId,
      currentRenewalDate,
      newRenewalDate,
      extraDays,
      amount,
      staff.id,
      quote.needsOverride ? overrideReason : null,
      membershipId,
    ]
  )
  const changeId = pending.data[0]?.id
  if (!changeId) {
    return { changed: false, message: 'A payment date change is already in progress for this membership.' }
  }

  async function markFailed(message: string): Promise<ChangeMembershipPaymentDateResult> {
    try {
      await paddockData.query(
        `UPDATE membership_payment_date_changes SET status = 'failed', failure_message = $1 WHERE id = $2`,
        [message, changeId]
      )
    } catch (err) {
      return {
        changed: false,
        message: `${message} (The attempt could not be marked failed: ${err instanceof Error ? err.message : String(err)}.)`,
      }
    }
    return { changed: false, message }
  }

  let worker: WorkerChangePaymentDateResponse
  try {
    const response = await paddockBackendApi2.rawRequest<WorkerChangePaymentDateResponse>({
      path: '/api/memberships/change-payment-date',
      method: 'POST',
      body: { stripeSubscriptionId, newRenewalDate, partMonthAmount: amount },
    })
    if (isHtmlErrorPage(response.data)) {
      return markFailed(
        'The payment date endpoint returned an HTML page instead of a JSON response: the "Paddock Backend API" resource ' +
          'is very likely misconfigured, or the Worker has not been deployed with this endpoint yet.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      // A declined card stops the Worker before anything else happens; say so. Other codes'
      // messages already say what happened to the money. Worker dates read "28 Nov 2026".
      if (response.data.code === 'payment_failed') {
        const stripeMessage = (response.data.error ?? structuredError).trim().replace(/\.+$/, '')
        return markFailed(
          `The card was declined: ${stripeMessage}. Nothing was charged and the payment date has not changed.`
        )
      }
      return markFailed(formatIsoDatesIn(structuredError))
    }
    if (!response.data.success || !response.data.paymentIntentId) {
      return markFailed('The payment date endpoint did not report success.')
    }
    worker = response.data
  } catch (err) {
    // A thrown call can't tell us whether the card was charged before it failed.
    const message = formatIsoDatesIn(extractApiErrorMessage(err, 'The payment date change request failed'))
    return markFailed(`${message}. If unsure, check Stripe for a "Payment date change" charge on this customer.`)
  }

  const paymentIntentId = worker.paymentIntentId as string
  const warnings: string[] = []
  if (worker.warning) warnings.push(formatIsoDatesIn(worker.warning))
  if (worker.newPeriodEnd && londonDateOfIso(worker.newPeriodEnd) !== newRenewalDate) {
    warnings.push(
      `Stripe's next payment is now on ${formatIsoDate(londonDateOfIso(worker.newPeriodEnd))}, not ${formatIsoDate(newRenewalDate)}: check the subscription in Stripe.`
    )
  }

  // The charge as its own order (so refunds can find it), the new date, and the row 'done', all
  // or nothing.
  let orderId: string | null = null
  try {
    const recorded = await paddockData.query<{ order_id: string }>(
      `WITH o AS (
         INSERT INTO orders (customer_id, order_total, payment_status, stripe_payment_intent_id, order_source, payment_method)
         VALUES ($1, $2, 'paid', $3, 'staff_created', 'card')
         RETURNING id
       ), line AS (
         INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, membership_plan_id)
         SELECT o.id, 'membership', 1, $4::numeric, $5::numeric, $6::uuid FROM o
         RETURNING order_id
       ), m AS (
         UPDATE customer_memberships SET next_renewal_date = $7::date, updated_at = now() WHERE id = $8
         RETURNING id
       ), done AS (
         UPDATE membership_payment_date_changes
         SET status = 'done', stripe_payment_intent_id = $9, order_id = (SELECT id FROM o)
         WHERE id = $10
         RETURNING id
       )
       SELECT (SELECT id FROM o) AS order_id FROM line, m, done`,
      [quote.customerId, amount, paymentIntentId, amount, amount, quote.planId, newRenewalDate, membershipId, paymentIntentId, changeId]
    )
    orderId = recorded.data[0]?.order_id ?? null
    if (!orderId) throw new Error('the statement wrote nothing')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Keep the 6-month rule and the history right even when the order couldn't be written.
    let rowFixed = true
    try {
      await paddockData.query(
        `UPDATE membership_payment_date_changes SET status = 'done', stripe_payment_intent_id = $1, failure_message = $2 WHERE id = $3`,
        [paymentIntentId, `Recording failed: ${reason}`, changeId]
      )
    } catch {
      rowFixed = false
    }
    warnings.push(
      `The card was charged £${amount.toFixed(2)} (${paymentIntentId}) and Stripe now bills on ${formatIsoDate(newRenewalDate)}, but recording it failed (${reason}). ` +
        `Fix by hand: add a paid card order for £${amount.toFixed(2)} with PaymentIntent ${paymentIntentId} (one membership line), ` +
        `set this membership's next renewal date to ${formatIsoDate(newRenewalDate)}` +
        (rowFixed ? '.' : `, and mark payment date change ${changeId} 'done' with that PaymentIntent.`)
    )
  }

  return {
    changed: true,
    newRenewalDate,
    extraDays,
    amountCharged: amount,
    paymentIntentId,
    orderId,
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  }
}
