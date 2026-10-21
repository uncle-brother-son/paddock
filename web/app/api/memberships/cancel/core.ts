import { computeMembershipCancellation, type BillingFrequency } from '@/lib/membership-cancellation'
import type Stripe from 'stripe'

export interface CancelMembershipParams {
  membershipId: string
}

export interface CancelMembershipSuccess {
  success: true
  endDate: string
  cancelEffectiveDate: string
  stripeUpdated: boolean
}

export interface CancelMembershipFailure {
  success: false
  status: number
  error: string
}

export type CancelMembershipResult = CancelMembershipSuccess | CancelMembershipFailure

// The subset of the Stripe client this module needs — kept minimal so tests can pass a plain
// mock instead of a real Stripe instance.
export interface StripeCancelDeps {
  subscriptionsUpdate: (id: string, params: Stripe.SubscriptionUpdateParams) => Promise<Stripe.Subscription>
}

export async function cancelMembership(
  params: CancelMembershipParams,
  supabase: any,
  stripe: StripeCancelDeps
): Promise<CancelMembershipResult> {
  const { membershipId } = params

  const { data: membership, error: membershipError } = await supabase
    .from('customer_memberships')
    .select('id, start_date, next_renewal_date, billing_frequency, stripe_subscription_id')
    .eq('id', membershipId)
    .single()

  if (membershipError || !membership) {
    return { success: false, status: 404, error: 'Membership not found' }
  }

  const { endDate, cancelEffectiveDate, cancelAtUnix } = computeMembershipCancellation({
    startDate: membership.start_date,
    nextRenewalDate: membership.next_renewal_date,
    billingFrequency: membership.billing_frequency as BillingFrequency,
  })

  // Call Stripe first (if there's a subscription to update) — only write to Postgres once that
  // has actually succeeded, so a Stripe failure never leaves the DB out of sync with Stripe.
  let stripeUpdated = false
  if (membership.stripe_subscription_id) {
    try {
      await stripe.subscriptionsUpdate(membership.stripe_subscription_id, { cancel_at: cancelAtUnix })
      stripeUpdated = true
    } catch (stripeError) {
      console.error(
        'Error setting cancel_at on Stripe subscription:',
        membership.stripe_subscription_id,
        stripeError instanceof Error ? stripeError.message : stripeError
      )
      return {
        success: false,
        status: 500,
        error: stripeError instanceof Error ? stripeError.message : 'Failed to update Stripe subscription',
      }
    }
  }

  const { error: updateError } = await supabase
    .from('customer_memberships')
    .update({ cancel_effective_date: cancelEffectiveDate })
    .eq('id', membershipId)

  if (updateError) {
    console.error('Error setting cancel_effective_date:', membershipId, updateError.message)
    return { success: false, status: 500, error: 'Failed to update membership record' }
  }

  return { success: true, endDate, cancelEffectiveDate, stripeUpdated }
}
