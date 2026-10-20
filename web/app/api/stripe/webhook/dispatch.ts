import Stripe from 'stripe'

export interface DispatchResult {
  outcome: 'processed' | 'ignored'
  detail: Record<string, unknown>
}

// The only part of the Supabase client dispatchStripeEvent needs — kept minimal so tests can
// pass a plain mock instead of a real SupabaseClient.
export interface RpcClient {
  rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: any; error: any }>
}

// invoice.parent.subscription_details.subscription is where the subscription id lives on
// recent API versions (2026-07-29.dahlia and later) — confirmed against the installed Stripe
// SDK's own type declarations. The older top-level invoice.subscription field is no longer part
// of the typed Invoice object at all, but is read here defensively as a runtime fallback in case
// an older-shaped payload still carries it.
export function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const fromParent = invoice.parent?.subscription_details?.subscription
  if (fromParent) {
    return typeof fromParent === 'string' ? fromParent : fromParent.id
  }
  const legacy = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription
  if (legacy) {
    return typeof legacy === 'string' ? legacy : legacy.id
  }
  return undefined
}

// subscription.items.data[0].current_period_end is where the period end lives on recent API
// versions — confirmed against the installed SDK's types (current_period_end only exists on
// SubscriptionItem, not on Subscription itself, in this version). Same defensive runtime
// fallback as above for an older-shaped payload.
export function getSubscriptionPeriodEnd(subscription: Stripe.Subscription): number | undefined {
  const fromItem = subscription.items?.data?.[0]?.current_period_end
  if (typeof fromItem === 'number') return fromItem
  const legacy = (subscription as unknown as { current_period_end?: number }).current_period_end
  return typeof legacy === 'number' ? legacy : undefined
}

function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

export async function dispatchStripeEvent(event: Stripe.Event, supabase: RpcClient): Promise<DispatchResult> {
  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice
      // The membership row and its first credit period are created by the checkout/Retool
      // flow, not by this webhook — the invoice for that initial charge must be skipped.
      if (invoice.billing_reason === 'subscription_create') {
        return { outcome: 'ignored', detail: { reason: 'first_invoice' } }
      }
      const subscriptionId = getInvoiceSubscriptionId(invoice)
      if (!subscriptionId) {
        return { outcome: 'ignored', detail: { reason: 'no_subscription_id' } }
      }
      const periodEndSeconds = invoice.lines?.data?.[0]?.period?.end
      if (!periodEndSeconds) {
        return { outcome: 'ignored', detail: { reason: 'no_period_end' } }
      }
      const { data, error } = await supabase.rpc('membership_mark_paid', {
        p_stripe_subscription_id: subscriptionId,
        p_period_end: unixSecondsToIso(periodEndSeconds),
      })
      if (error) throw error
      return { outcome: data?.found === false ? 'ignored' : 'processed', detail: data }
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice
      if (invoice.billing_reason === 'subscription_create') {
        return { outcome: 'ignored', detail: { reason: 'first_invoice' } }
      }
      const subscriptionId = getInvoiceSubscriptionId(invoice)
      if (!subscriptionId) {
        return { outcome: 'ignored', detail: { reason: 'no_subscription_id' } }
      }
      const { data, error } = await supabase.rpc('membership_mark_payment_failed', {
        p_stripe_subscription_id: subscriptionId,
      })
      if (error) throw error
      return { outcome: data?.found === false ? 'ignored' : 'processed', detail: data }
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription
      const { data, error } = await supabase.rpc('membership_mark_cancelled_by_stripe', {
        p_stripe_subscription_id: subscription.id,
      })
      if (error) throw error
      return { outcome: data?.found === false ? 'ignored' : 'processed', detail: data }
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription
      const periodEndSeconds = getSubscriptionPeriodEnd(subscription)
      if (!periodEndSeconds) {
        return { outcome: 'ignored', detail: { reason: 'no_period_end' } }
      }
      const { data, error } = await supabase.rpc('membership_sync_cancel_at_period_end', {
        p_stripe_subscription_id: subscription.id,
        p_cancel_at_period_end: subscription.cancel_at_period_end,
        p_period_end: unixSecondsToIso(periodEndSeconds),
      })
      if (error) throw error
      return { outcome: data?.found === false ? 'ignored' : 'processed', detail: data }
    }

    default:
      return { outcome: 'ignored', detail: { reason: 'unhandled_event_type' } }
  }
}
