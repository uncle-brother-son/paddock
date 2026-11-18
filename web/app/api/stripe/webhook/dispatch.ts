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

// W45a (W45 audit S1): the one Stripe read the handlers make. An event carries the subscription as it was when the
// event was made, and events are not handled in the order things happened: a delivery that failed is sent again up to
// days later, and two deliveries can be handled at once. So what is written to a membership comes from the
// subscription as Stripe holds it now, never from the event. Kept to the one call, so tests pass the fake Stripe
// (server/stripe/fake.ts) and the route passes the real client.
export interface SubscriptionReader {
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> }
}

/** A subscription whose latest payment is still owed: what an invoice.payment_failed event must find to act. */
const BEHIND_ON_PAYMENT: readonly Stripe.Subscription.Status[] = ['past_due', 'unpaid']

export async function dispatchStripeEvent(event: Stripe.Event, supabase: RpcClient, stripe: SubscriptionReader): Promise<DispatchResult> {
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
      // W45a (audit S1): a failed payment handled late, after the payment that followed it went through, must not
      // mark a paid member past due and flag their credit bookings. The subscription is read now, and only one
      // still behind on its payment marks the membership. A read that fails throws: the event is recorded as an
      // error and answered 500, so Stripe sends it again.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      if (!BEHIND_ON_PAYMENT.includes(subscription.status)) {
        return { outcome: 'ignored', detail: { reason: 'subscription_not_past_due', status: subscription.status } }
      }
      const { data, error } = await supabase.rpc('membership_mark_payment_failed', {
        p_stripe_subscription_id: subscriptionId,
      })
      if (error) throw error
      return { outcome: data?.found === false ? 'ignored' : 'processed', detail: data }
    }

    case 'customer.subscription.deleted': {
      // W45a: no read here. Only the subscription's id is taken from the event (the end date is worked out in the
      // database from the membership's own rows), and a subscription that has ended never comes back, so this event
      // is still true however late it is handled.
      const subscription = event.data.object as Stripe.Subscription
      const { data, error } = await supabase.rpc('membership_mark_cancelled_by_stripe', {
        p_stripe_subscription_id: subscription.id,
      })
      if (error) throw error
      return { outcome: data?.found === false ? 'ignored' : 'processed', detail: data }
    }

    case 'customer.subscription.updated': {
      // W45a (audit S1): the event only says which subscription changed. Its own cancel_at, cancel_at_period_end and
      // period end are what the subscription showed when the event was made; handled after a newer event (Cancel,
      // then Undo, with the Cancel's event last) they left the membership ending on a date Stripe no longer had.
      // The subscription is read now and its current values are passed. A read that fails throws: the event is
      // recorded as an error and answered 500, so Stripe sends it again; nothing is written from the event.
      const subscription = await stripe.subscriptions.retrieve((event.data.object as Stripe.Subscription).id)
      const periodEndSeconds = getSubscriptionPeriodEnd(subscription)
      if (!periodEndSeconds) {
        return { outcome: 'ignored', detail: { reason: 'no_period_end' } }
      }
      const { data, error } = await supabase.rpc('membership_sync_cancel_at_period_end', {
        p_stripe_subscription_id: subscription.id,
        p_cancel_at_period_end: subscription.cancel_at_period_end,
        p_cancel_at: subscription.cancel_at ? unixSecondsToIso(subscription.cancel_at) : null,
        p_period_end: unixSecondsToIso(periodEndSeconds),
      })
      if (error) throw error
      return { outcome: data?.found === false ? 'ignored' : 'processed', detail: data }
    }

    default:
      return { outcome: 'ignored', detail: { reason: 'unhandled_event_type' } }
  }
}
