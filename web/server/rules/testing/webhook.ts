import type Stripe from 'stripe'
import type { RpcClient } from '@/app/api/stripe/webhook/dispatch'
import type { Queryable, SqlParam } from '@/server/db'

// W45a (W45 audit S1, F4): Stripe's webhook on a test database, for tests only. The webhook (app/api/stripe/webhook)
// reaches the database through Supabase's client: `rpc` for the four membership functions and `from` for its own
// table of events. These two stand in for that client on a test's own Postgres, so a test can hand a real event to
// the real handlers (dispatchStripeEvent, processWebhookEvent) and read what the real database functions wrote.
// Before this, tests modelled an event by calling its database function themselves, with whatever values they chose:
// that skips the handler, which is where the event's own snapshot was passed on.

/** The four functions the handlers call, by name as PostgREST takes them: a wrong or missing name is refused by Postgres. */
const FUNCTIONS: Record<string, { sql: string; params: readonly string[] }> = {
  membership_mark_paid: {
    sql: 'SELECT public.membership_mark_paid(p_stripe_subscription_id => $1::text, p_period_end => $2::timestamptz) AS data',
    params: ['p_stripe_subscription_id', 'p_period_end'],
  },
  membership_mark_payment_failed: {
    sql: 'SELECT public.membership_mark_payment_failed(p_stripe_subscription_id => $1::text) AS data',
    params: ['p_stripe_subscription_id'],
  },
  membership_mark_cancelled_by_stripe: {
    sql: 'SELECT public.membership_mark_cancelled_by_stripe(p_stripe_subscription_id => $1::text) AS data',
    params: ['p_stripe_subscription_id'],
  },
  membership_sync_cancel_at_period_end: {
    sql: 'SELECT public.membership_sync_cancel_at_period_end(p_stripe_subscription_id => $1::text, p_cancel_at_period_end => $2::boolean, p_cancel_at => $3::timestamptz, p_period_end => $4::timestamptz) AS data',
    params: ['p_stripe_subscription_id', 'p_cancel_at_period_end', 'p_cancel_at', 'p_period_end'],
  },
}

const parsed = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value)

/** One call the handlers made: the function and what it was given. */
export interface WebhookRpcCall {
  fn: string
  params: Record<string, unknown>
}

/**
 * `rpc` as the webhook uses it, on `db`. As Supabase's: it never throws; a failure comes back as `error`. The params
 * must be exactly the function's own (PostgREST finds a function by its argument names). `calls` holds each call.
 */
export function webhookRpc(db: Queryable): RpcClient & { calls: WebhookRpcCall[] } {
  const calls: WebhookRpcCall[] = []
  return {
    calls,
    async rpc(fn, params = {}) {
      calls.push({ fn, params })
      const known = FUNCTIONS[fn]
      if (!known) return { data: null, error: new Error(`The webhook's test database has no function ${fn}.`) }
      const given = Object.keys(params).sort().join(', ')
      if (given !== [...known.params].sort().join(', ')) return { data: null, error: new Error(`${fn} takes (${known.params.join(', ')}), not (${given}).`) }
      try {
        const rows = await db.query<{ data: unknown }>(known.sql, known.params.map((name) => (params[name] ?? null) as SqlParam))
        return { data: parsed(rows[0]?.data ?? null), error: null }
      } catch (err) {
        return { data: null, error: err }
      }
    },
  }
}

const CLAIM_EVENT_SQL = 'INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ($1::text, $2::text) ON CONFLICT (event_id) DO NOTHING'
const EVENT_OUTCOME_SQL = 'SELECT outcome FROM stripe_webhook_events WHERE event_id = $1::text'
// As PostgREST's update: only the fields given are written (`detail` is not given when a handler threw).
const RECORD_EVENT_SQL = `
UPDATE stripe_webhook_events
SET processed_at = $1::timestamptz, outcome = $2::text, detail = CASE WHEN $3::boolean THEN $4::text::jsonb ELSE detail END, error = $5::text
WHERE event_id = $6::text`
const EVENT_ROW_SQL = 'SELECT event_type, outcome, detail, error FROM stripe_webhook_events WHERE event_id = $1::text'

export interface WebhookEventRow {
  event_type: string
  outcome: string | null
  detail: Record<string, unknown> | null
  error: string | null
}

/**
 * The client processWebhookEvent takes, on `db`: the events table for real (`stripe_webhook_events`, the three calls
 * idempotency.ts makes on it and no others) and `rpc` as above. `eventRow` reads back what was recorded for an event.
 */
export function webhookClient(db: Queryable) {
  const rpc = webhookRpc(db)
  const answered = async (work: () => Promise<unknown>): Promise<{ error: { message: string } | null }> => {
    try {
      await work()
      return { error: null }
    } catch (err) {
      return { error: { message: err instanceof Error ? err.message : String(err) } }
    }
  }
  return {
    calls: rpc.calls,
    rpc: rpc.rpc,
    from(table: string) {
      if (table !== 'stripe_webhook_events') throw new Error(`The webhook's test client has only stripe_webhook_events, not ${table}.`)
      return {
        upsert: (row: { event_id: string; event_type: string }) => answered(() => db.query(CLAIM_EVENT_SQL, [row.event_id, row.event_type])),
        select: () => ({
          eq: (_column: string, eventId: string) => ({
            single: async () => {
              const rows = await db.query<{ outcome: string | null }>(EVENT_OUTCOME_SQL, [eventId])
              return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'no such event' } }
            },
          }),
        }),
        update: (fields: { processed_at: string; outcome: string; detail?: unknown; error?: string | null }) => ({
          eq: (_column: string, eventId: string) =>
            answered(() => db.query(RECORD_EVENT_SQL, [fields.processed_at, fields.outcome, 'detail' in fields, JSON.stringify(fields.detail ?? null), fields.error ?? null, eventId])),
        }),
      }
    },
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
