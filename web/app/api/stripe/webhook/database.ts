import type { Queryable, SqlParam } from '@/server/db'
import type { RpcClient } from './dispatch'

// New in W66 (H-plan 4.2, H8, N1): the Stripe webhook's database steps on the Worker's own connection, in place of
// Supabase's client and the service-role key. The same statements in the same order as before:
// - `claim`: the event's row, `INSERT … ON CONFLICT (event_id) DO NOTHING` (what the client's upsert with
//   `ignoreDuplicates` sent);
// - `outcomeOf`: the row's outcome, read back;
// - `rpc`: one of the four membership functions, called by name with its own argument names (as PostgREST called
//   them). Each call is its own statement and so its own transaction, as PostgREST made it: the function locks the
//   membership's row itself (`FOR UPDATE`) and the lock ends with the call. No Stripe read is ever made inside one;
// - `recordOutcome` / `recordError`: the row's outcome when the handler ends. As the client's update, only the
//   fields given are written: an error leaves `detail` as it was.
// The role (`paddock_worker`) holds INSERT and UPDATE on `stripe_webhook_events` and EXECUTE on the four functions
// (the lead's live check W66-1, 23 Nov); the functions are SECURITY DEFINER, as they were for the service role.

/** The four functions the handlers call (dispatch.ts), with their argument names in order. */
const MEMBERSHIP_FUNCTIONS: Readonly<Record<string, { sql: string; params: readonly string[] }>> = {
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

const CLAIM_EVENT_SQL = 'INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ($1::text, $2::text) ON CONFLICT (event_id) DO NOTHING'
const EVENT_OUTCOME_SQL = 'SELECT outcome FROM stripe_webhook_events WHERE event_id = $1::text'
const RECORD_OUTCOME_SQL = 'UPDATE stripe_webhook_events SET processed_at = $1::timestamptz, outcome = $2::text, detail = $3::jsonb, error = NULL WHERE event_id = $4::text'
const RECORD_ERROR_SQL = "UPDATE stripe_webhook_events SET processed_at = $1::timestamptz, outcome = 'error', error = $2::text WHERE event_id = $3::text"

/** The database steps of one event (idempotency.ts). Each throws when the database fails. */
export interface WebhookStore extends RpcClient {
  /** Claims the event's row; a row already there is left as it is. */
  claim(eventId: string, eventType: string): Promise<void>
  /** The row's outcome (null while unfinished), or null when there is no row. */
  outcomeOf(eventId: string): Promise<{ outcome: string | null } | null>
  /** The handler finished: `processed` or `ignored`, with what it found. */
  recordOutcome(eventId: string, fields: { processedAt: string; outcome: string; detail: Record<string, unknown> | null }): Promise<void>
  /** The handler threw: `error`, with the message; `detail` is left as it was. */
  recordError(eventId: string, fields: { processedAt: string; message: string }): Promise<void>
}

/**
 * `rpc` on `db`. As Supabase's client answered: it never throws; a failure comes back as `error` (dispatch.ts throws
 * it). The params must be exactly the function's own, as PostgREST finds a function by its argument names.
 */
export function membershipFunctions(db: Queryable): RpcClient {
  return {
    async rpc(fn, params = {}) {
      const known = MEMBERSHIP_FUNCTIONS[fn]
      if (!known) return { data: null, error: new Error(`The webhook has no database function ${fn}.`) }
      const given = Object.keys(params).sort().join(', ')
      if (given !== [...known.params].sort().join(', ')) return { data: null, error: new Error(`${fn} takes (${known.params.join(', ')}), not (${given}).`) }
      try {
        const rows = await db.query<{ data: unknown }>(known.sql, known.params.map((name) => (params[name] ?? null) as SqlParam))
        const data = rows[0]?.data ?? null
        return { data: typeof data === 'string' ? JSON.parse(data) : data, error: null }
      } catch (err) {
        return { data: null, error: err }
      }
    },
  }
}

/** The webhook's database steps on `db` (the route's own request connection). */
export function webhookStore(db: Queryable): WebhookStore {
  return {
    ...membershipFunctions(db),
    async claim(eventId, eventType) {
      await db.query(CLAIM_EVENT_SQL, [eventId, eventType])
    },
    async outcomeOf(eventId) {
      const [row] = await db.query<{ outcome: string | null }>(EVENT_OUTCOME_SQL, [eventId])
      return row ? { outcome: row.outcome } : null
    },
    async recordOutcome(eventId, { processedAt, outcome, detail }) {
      // SQL NULL for no detail, as the client wrote `detail: null` (never the JSON value null).
      await db.query(RECORD_OUTCOME_SQL, [processedAt, outcome, detail === null ? null : JSON.stringify(detail), eventId])
    },
    async recordError(eventId, { processedAt, message }) {
      await db.query(RECORD_ERROR_SQL, [processedAt, message, eventId])
    },
  }
}
