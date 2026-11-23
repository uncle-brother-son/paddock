import type Stripe from 'stripe'
import { membershipFunctions, webhookStore, type WebhookStore } from '@/app/api/stripe/webhook/database'
import type { RpcClient } from '@/app/api/stripe/webhook/dispatch'
import type { Queryable } from '@/server/db'

// W45a (W45 audit S1, F4): Stripe's webhook on a test database, for tests only, so a test can hand a real event to
// the real handlers (dispatchStripeEvent, processWebhookEvent) and read what the real database functions wrote.
// Before this, tests modelled an event by calling its database function themselves, with whatever values they chose:
// that skips the handler, which is where the event's own snapshot was passed on.
// W66 (H8): until W66 these stood in for Supabase's client with SQL of their own. The webhook now runs its database
// steps on the Worker's connection (app/api/stripe/webhook/database.ts), so these are that very code on the test's
// database, with a record of each function called (`calls`) and a read of an event's row (`eventRow`).

const parsed = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)

/** One call the handlers made: the function and what it was given. */
export interface WebhookRpcCall {
  fn: string
  params: Record<string, unknown>
}

/** `rpc` as the webhook uses it, on `db` (database.ts, membershipFunctions), recording each call in `calls`. */
export function webhookRpc(db: Queryable): RpcClient & { calls: WebhookRpcCall[] } {
  const calls: WebhookRpcCall[] = []
  const functions = membershipFunctions(db)
  return {
    calls,
    rpc(fn, params = {}) {
      calls.push({ fn, params })
      return functions.rpc(fn, params)
    },
  }
}

const EVENT_ROW_SQL = 'SELECT event_type, outcome, detail, error FROM stripe_webhook_events WHERE event_id = $1::text'

export interface WebhookEventRow {
  event_type: string
  outcome: string | null
  detail: Record<string, unknown> | null
  error: string | null
}

/**
 * The store processWebhookEvent takes, on `db`: the webhook's own (database.ts, webhookStore), with each function
 * call recorded as above. `eventRow` reads back what was recorded for an event.
 */
export function webhookClient(db: Queryable): WebhookStore & { calls: WebhookRpcCall[]; eventRow(eventId: string): Promise<WebhookEventRow | null> } {
  const rpc = webhookRpc(db)
  return {
    ...webhookStore(db),
    calls: rpc.calls,
    rpc: rpc.rpc,
    async eventRow(eventId: string): Promise<WebhookEventRow | null> {
      const row = (await db.query<{ event_type: string; outcome: string | null; detail: unknown; error: string | null }>(EVENT_ROW_SQL, [eventId]))[0]
      return row ? { ...row, detail: parsed(row.detail) as Record<string, unknown> | null } : null
    },
  }
}

// W46b (W46 review S1): an event says which mode it was made in, and the handlers go by it. These are test-mode
// events, as the fake Stripe's key is; `asLive` gives the same event as live Stripe would send it.
const eventOf = (type: string, object: unknown): Stripe.Event => ({ id: `evt_${crypto.randomUUID()}`, type, livemode: false, data: { object } }) as unknown as Stripe.Event

/** The same event (the same id) as Stripe sends it in live mode. */
export const asLive = (event: Stripe.Event): Stripe.Event => ({ ...event, livemode: true })

/**
 * A customer.subscription.updated event: the subscription as it was when the event was made (its snapshot), which is
 * not what Stripe holds by the time the event is handled. Times in seconds.
 */
export function subscriptionUpdatedEvent(subscriptionId: string, snapshot: { cancelAt: number | null; periodEnd: number; cancelAtPeriodEnd?: boolean; status?: Stripe.Subscription.Status }): Stripe.Event {
  return eventOf('customer.subscription.updated', {
    id: subscriptionId,
    object: 'subscription',
    status: snapshot.status ?? 'active',
    cancel_at: snapshot.cancelAt,
    cancel_at_period_end: snapshot.cancelAtPeriodEnd ?? false,
    items: { data: [{ current_period_end: snapshot.periodEnd }] },
  })
}

/**
 * An invoice.paid or invoice.payment_failed event for a subscription's invoice, as the handlers read it. Times in
 * seconds. W46b (W46 review B1): `id` is the invoice's own id, which the handlers hold against the subscription's
 * newest invoice as Stripe has it (the fake's `latestInvoice`), so every event says which invoice it is for.
 */
export function invoiceEvent(
  type: 'invoice.paid' | 'invoice.payment_failed',
  subscriptionId: string,
  invoice: { id: string; periodStart?: number; periodEnd: number; billingReason?: Stripe.Invoice.BillingReason; amountPaid?: number }
): Stripe.Event {
  return eventOf(type, {
    id: invoice.id,
    object: 'invoice',
    billing_reason: invoice.billingReason ?? 'subscription_cycle',
    amount_paid: invoice.amountPaid ?? 0,
    parent: { subscription_details: { subscription: subscriptionId } },
    lines: { data: [{ period: { ...(invoice.periodStart === undefined ? {} : { start: invoice.periodStart }), end: invoice.periodEnd } }] },
  })
}
