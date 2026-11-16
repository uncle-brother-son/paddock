import type Stripe from 'stripe'

export interface UndoCancelMembershipParams {
  membershipId: string
}

export interface UndoCancelMembershipSuccess {
  success: true
}

export interface UndoCancelMembershipFailure {
  success: false
  status: number
  error: string
}

export type UndoCancelMembershipResult = UndoCancelMembershipSuccess | UndoCancelMembershipFailure

// The subset of the Stripe client this module needs — kept minimal so tests can pass a plain
// mock instead of a real Stripe instance.
export interface StripeUndoCancelDeps {
  subscriptionsUpdate: (id: string, params: Stripe.SubscriptionUpdateParams) => Promise<Stripe.Subscription>
}

export async function undoCancelMembership(
  params: UndoCancelMembershipParams,
  supabase: any,
  stripe: StripeUndoCancelDeps
): Promise<UndoCancelMembershipResult> {
  const { membershipId } = params

  const { data: membership, error: membershipError } = await supabase
    .from('customer_memberships')
    .select('id, stripe_subscription_id')
    .eq('id', membershipId)
    .single()

  if (membershipError || !membership) {
    return { success: false, status: 404, error: 'Membership not found' }
  }

  // Call Stripe first (if there's a subscription to update) — only write to Postgres once that
  // has actually succeeded, so a Stripe failure never leaves the DB out of sync with Stripe.
  if (membership.stripe_subscription_id) {
    try {
      // '' is the Stripe SDK's documented way to explicitly clear a nullable Emptyable field —
      // confirmed against the installed SDK's SubscriptionUpdateParams type.
      await stripe.subscriptionsUpdate(membership.stripe_subscription_id, { cancel_at: '' })
    } catch (stripeError) {
      console.error(
        'Error clearing cancel_at on Stripe subscription:',
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
    .update({ cancel_effective_date: null })
    .eq('id', membershipId)

  if (updateError) {
    console.error('Error clearing cancel_effective_date:', membershipId, updateError.message)
    return { success: false, status: 500, error: 'Failed to update membership record' }
  }

  return { success: true }
}
