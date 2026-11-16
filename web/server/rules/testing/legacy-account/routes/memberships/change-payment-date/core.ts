import type Stripe from 'stripe'
import { londonWallClockToUtc } from '@/lib/london-time'

export interface ChangePaymentDateParams {
  stripeSubscriptionId: string
  newRenewalDate: string // London date, YYYY-MM-DD
  partMonthAmount: number // pounds, charged now for the extra days
}

export interface ChangePaymentDateSuccess {
  success: true
  paymentIntentId: string
  newPeriodEnd: string // ISO timestamp of the subscription's current period end after the change
  extraDays: number
  warning?: string
}

export interface ChangePaymentDateFailure {
  success: false
  status: number
  error: string
  code?: string
}

export type ChangePaymentDateResult = ChangePaymentDateSuccess | ChangePaymentDateFailure

// The subset of the Stripe client this module needs — kept minimal so tests can pass a plain
// mock instead of a real Stripe instance.
export interface StripeChangePaymentDateDeps {
  subscriptionsRetrieve: (id: string) => Promise<Stripe.Subscription>
  subscriptionsUpdate: (id: string, params: Stripe.SubscriptionUpdateParams) => Promise<Stripe.Subscription>
  paymentIntentsCreate: (params: Stripe.PaymentIntentCreateParams) => Promise<Stripe.PaymentIntent>
  refundsCreate: (params: Stripe.RefundCreateParams) => Promise<Stripe.Refund>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The London calendar date (YYYY-MM-DD) of a Unix timestamp in seconds. */
export function londonDateOf(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSeconds * 1000))
}

/** 00:00 London time on the given date, as a Unix timestamp in seconds (GMT or BST as it applies). */
export function londonMidnightUnix(date: string): number {
  return Math.floor(londonWallClockToUtc(`${date}T00:00:00.000Z`).getTime() / 1000)
}

/**
 * The same day one month later, clamped to the end of a shorter month — the same as Postgres's
 * `date + interval '1 month'` (31 Jan → 28/29 Feb), which Retool uses for the allowed window.
 */
export function addOneMonth(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const nextMonthIndex = m // 0-based index of the following month
  const year = y + Math.floor(nextMonthIndex / 12)
  const month = nextMonthIndex % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(d, lastDay))).toISOString().slice(0, 10)
}

/** Whole days from one YYYY-MM-DD date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

function isRealDate(date: string): boolean {
  return DATE_RE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
}

export async function changeMembershipPaymentDate(
  params: ChangePaymentDateParams,
  supabase: any,
  stripe: StripeChangePaymentDateDeps
): Promise<ChangePaymentDateResult> {
  const { stripeSubscriptionId, newRenewalDate, partMonthAmount } = params

  if (!stripeSubscriptionId || typeof stripeSubscriptionId !== 'string') {
    return { success: false, status: 400, error: 'Missing required field: stripeSubscriptionId' }
  }
  if (typeof newRenewalDate !== 'string' || !isRealDate(newRenewalDate)) {
    return { success: false, status: 400, error: 'newRenewalDate must be a date in the form YYYY-MM-DD' }
  }
  const amountPence = Math.round(Number(partMonthAmount) * 100)
  if (!Number.isFinite(partMonthAmount) || amountPence <= 0 || Math.abs(partMonthAmount * 100 - amountPence) > 1e-6) {
    return { success: false, status: 400, error: 'partMonthAmount must be a positive amount in pounds and pence' }
  }

  const { data: membership, error: membershipError } = await supabase
    .from('customer_memberships')
    .select('id, customer_id, subscription_status, billing_frequency, next_renewal_date, cancel_effective_date')
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .single()

  if (membershipError || !membership) {
    return { success: false, status: 404, error: 'Membership not found for that subscription' }
  }
  if (membership.billing_frequency !== 'monthly') {
    return { success: false, status: 400, error: "Yearly memberships renew once a year, so the payment date can't be changed", code: 'not_monthly' }
  }
  if (membership.subscription_status !== 'active') {
    return { success: false, status: 400, error: 'Only an active membership can have its payment date changed', code: 'not_active' }
  }
  if (membership.cancel_effective_date) {
    return { success: false, status: 400, error: 'This membership has a cancellation scheduled', code: 'cancel_scheduled' }
  }

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id, stripe_customer_id, saved_payment_method_id')
    .eq('id', membership.customer_id)
    .single()

  if (customerError || !customer) {
    return { success: false, status: 404, error: 'Customer not found' }
  }
  if (!customer.stripe_customer_id || !customer.saved_payment_method_id) {
    return { success: false, status: 400, error: 'Customer has no saved payment method on file.', code: 'no_saved_card' }
  }

  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptionsRetrieve(stripeSubscriptionId)
  } catch (stripeError) {
    const message = stripeError instanceof Error ? stripeError.message : 'Failed to load the Stripe subscription'
    console.error('Error loading subscription for payment date change:', stripeSubscriptionId, message)
    return { success: false, status: 500, error: message }
  }

  const subscriptionCustomerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id
  if (subscriptionCustomerId !== customer.stripe_customer_id) {
    return { success: false, status: 409, error: "The subscription doesn't belong to this customer's Stripe account", code: 'customer_mismatch' }
  }
  if (subscription.status !== 'active') {
    return { success: false, status: 409, error: `The Stripe subscription is ${subscription.status}, not active`, code: 'not_active' }
  }
  if (subscription.cancel_at_period_end || subscription.cancel_at) {
    return { success: false, status: 409, error: 'The Stripe subscription has a cancellation scheduled', code: 'cancel_scheduled' }
  }

  const item = subscription.items?.data?.[0]
  const recurring = item?.price?.recurring
  if (!item || subscription.items.data.length !== 1 || recurring?.interval !== 'month' || recurring.interval_count !== 1) {
    return { success: false, status: 409, error: 'The Stripe subscription is not a single monthly price', code: 'not_monthly' }
  }

  // Stale data guard: Stripe's next charge must be on the date Retool showed staff.
  const currentRenewalDate = londonDateOf(item.current_period_end)
  if (currentRenewalDate !== membership.next_renewal_date) {
    return {
      success: false,
      status: 409,
      error: `Stripe's next payment is on ${currentRenewalDate}, but the membership shows ${membership.next_renewal_date}. Refresh and try again.`,
      code: 'stale_renewal_date',
    }
  }

  // Forward only, at most to the day before the renewal after this one.
  const renewalAfter = addOneMonth(currentRenewalDate)
  if (newRenewalDate <= currentRenewalDate || newRenewalDate >= renewalAfter) {
    return {
      success: false,
      status: 400,
      error: `The new payment date must be after ${currentRenewalDate} and before ${renewalAfter}`,
      code: 'date_out_of_range',
    }
  }
  const extraDays = daysBetween(currentRenewalDate, newRenewalDate)

  // The part-month charge can never be more than a full month at the subscription's price.
  // Retool works it out from the plan's monthly price, which is right: a plan price change moves
  // members to the new price from their next renewal, and the extra days fall after that date.
  const monthlyPence = (item.price.unit_amount ?? 0) * (item.quantity ?? 1)
  if (monthlyPence > 0 && amountPence > monthlyPence) {
    return { success: false, status: 400, error: 'partMonthAmount is more than a full month at the subscription price', code: 'amount_too_high' }
  }

  // 1. Charge the extra days first. If this fails nothing else changes.
  let paymentIntent: Stripe.PaymentIntent
  try {
    paymentIntent = await stripe.paymentIntentsCreate({
      amount: amountPence,
      currency: 'gbp',
      customer: customer.stripe_customer_id,
      payment_method: customer.saved_payment_method_id,
      off_session: true,
      confirm: true,
      description: `Payment date change: ${extraDays} extra days`,
      metadata: {
        purpose: 'membership_payment_date_change',
        stripe_subscription_id: stripeSubscriptionId,
        membership_id: membership.id,
        new_renewal_date: newRenewalDate,
      },
    })
  } catch (stripeError) {
    const stripeErr = stripeError as Stripe.errors.StripeError
    if (stripeErr.code === 'authentication_required') {
      return {
        success: false,
        status: 402,
        error: 'Card requires additional authentication and cannot be charged off-session. Ask the customer to complete a new payment.',
        code: 'payment_failed',
      }
    }
    console.error('Error charging the payment date change:', stripeSubscriptionId, stripeErr.code ?? stripeErr.type)
    return {
      success: false,
      status: stripeErr.type === 'StripeCardError' ? 402 : 500,
      error: stripeErr.message ?? 'Failed to charge the saved card',
      code: 'payment_failed',
    }
  }

  if (paymentIntent.status !== 'succeeded') {
    return { success: false, status: 402, error: `The card payment did not complete (status: ${paymentIntent.status})`, code: 'payment_failed' }
  }

  // 2. Move the billing date without proration. Setting trial_end on an existing subscription
  //    moves its billing_cycle_anchor to trial_end; the next invoice is then the full price on
  //    the new date (Stripe docs: "Change the billing period using a trial period").
  const trialEnd = londonMidnightUnix(newRenewalDate)
  let updated: Stripe.Subscription
  try {
    updated = await stripe.subscriptionsUpdate(stripeSubscriptionId, {
      trial_end: trialEnd,
      proration_behavior: 'none',
    })
  } catch (stripeError) {
    const message = stripeError instanceof Error ? stripeError.message : 'Failed to update the Stripe subscription'
    console.error('Error moving the subscription billing date:', stripeSubscriptionId, message)
    // 3. The date didn't move, so give the part-month charge back in full.
    try {
      await stripe.refundsCreate({ payment_intent: paymentIntent.id })
    } catch (refundError) {
      const refundMessage = refundError instanceof Error ? refundError.message : 'unknown error'
      console.error('Error refunding the payment date change charge:', paymentIntent.id, refundMessage)
      return {
        success: false,
        status: 500,
        error: `${message}. The £${(amountPence / 100).toFixed(2)} charge (${paymentIntent.id}) could not be refunded automatically (${refundMessage}): refund it in Stripe.`,
        code: 'refund_failed',
      }
    }
    return { success: false, status: 500, error: `${message}. The part-month charge was refunded in full.`, code: 'subscription_update_failed' }
  }

  const updatedItem = updated.items?.data?.[0]
  const newPeriodEndSeconds = updatedItem?.current_period_end ?? trialEnd
  const warning =
    updated.trial_end !== trialEnd || updated.billing_cycle_anchor !== trialEnd
      ? `Stripe accepted the change but reports trial_end ${updated.trial_end} and billing_cycle_anchor ${updated.billing_cycle_anchor}, expected ${trialEnd}: check the subscription in Stripe.`
      : undefined

  return {
    success: true,
    paymentIntentId: paymentIntent.id,
    newPeriodEnd: new Date(newPeriodEndSeconds * 1000).toISOString(),
    extraDays,
    ...(warning ? { warning } : {}),
  }
}
