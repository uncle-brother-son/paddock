// Ported from app/api/terminal/create-payment-intent/route.ts (and create-setup-intent, the same block):
// finding or making the customer's Stripe customer. New in W10, for the saved card; W11's reader is
// the first caller that can meet a customer with none.
import 'server-only'
import type { Db, Tx } from '@/server/db'
import { LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS } from '@/server/db/client'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from './client'
import { NoTimeLeft, sendOptions, type StripeTiming } from './deadline'

/** Under this much time before the deadline, the customer's statements aren't run (W11a). */
export const MIN_STATEMENT_MS = 250

/**
 * W11a (review S1): the customer's read and its write-back each run in their own transaction, so they
 * get the transaction limits (a lock waited for at most 5 s, a statement at most 8 s, both enforced by
 * Postgres) instead of only the client's 10 s; and with a deadline, both limits are cut to what is
 * left before it, so they end by it, as the Stripe calls do. With under MIN_STATEMENT_MS left nothing
 * is run (NoTimeLeft). A statement Postgres stops is rolled back, so it never lands later.
 */
async function withinDeadline<T>(db: Db, timing: StripeTiming | undefined, work: (tx: Tx) => Promise<T>): Promise<T> {
  const timeLeft = () => (timing ? Math.floor(timing.deadline - timing.now()) : Number.POSITIVE_INFINITY)
  if (timeLeft() < MIN_STATEMENT_MS) throw new NoTimeLeft(timeLeft())
  return db.transaction(async (tx) => {
    if (timing) {
      // Read again once the transaction is open, so connecting and BEGIN count against the deadline too.
      const left = timeLeft()
      if (left < MIN_STATEMENT_MS) throw new NoTimeLeft(left)
      await tx.query("SELECT set_config('statement_timeout', $1::text, true), set_config('lock_timeout', $2::text, true)", [
        String(Math.min(STATEMENT_TIMEOUT_MS, left)),
        String(Math.min(LOCK_TIMEOUT_MS, left)),
      ])
    }
    return work(tx)
  })
}

/**
 * The customer's Stripe customer id, as the legacy routes find it:
 *   1. the id already on the customer row, with no Stripe call;
 *   2. else a Stripe customer already tagged with this customer's id (an earlier attempt made one and
 *      failed to save it), saved back to the row;
 *   3. else a new one, tagged the same way, and saved.
 *
 * Two differences from the legacy block, both so that a retry can't make a second customer: the
 * create carries a key built from the customer's id, and the row is only filled when it is still
 * empty (whoever saved first wins, and that id is the one returned). A search that fails is passed
 * over, as the legacy block did. A failed create throws Stripe's error for the caller to read
 * (outcome.ts); nothing has been charged at that point.
 *
 * A saved card always has its Stripe customer on the row (saving a card writes both), so on the
 * saved-card path only step 1 runs: no Stripe call.
 */
export async function ensureStripeCustomer(
  db: Db,
  stripe: StripeClient,
  customer: { id: string; stripeCustomerId: string | null },
  /**
   * The press's deadline (server/stripe/deadline.ts): every Stripe call and both statements here end by
   * it, and a call or statement with too little time left isn't made (NoTimeLeft, thrown, nothing
   * sent). Without one (W10's saved card, which only ever takes step 1), no deadline.
   */
  timing?: StripeTiming
): Promise<string> {
  if (customer.stripeCustomerId) return customer.stripeCustomerId
  const send = () => sendOptions(timing)

  let found: string | null = null
  try {
    const search = await stripe.customers.search({ query: `metadata['supabase_customer_id']:'${customer.id}'`, limit: 1 }, send())
    found = search.data[0]?.id ?? null
  } catch {
    // As the legacy block: a failed search falls through to creating one.
  }

  if (!found) {
    const rows = await withinDeadline(db, timing, (tx) =>
      tx.query<{ email: string | null; first_name: string | null; last_name: string | null }>(
        'SELECT email, first_name, last_name FROM customers WHERE id = $1::uuid',
        [customer.id]
      )
    )
    const row = rows[0]
    if (!row) throw new Error('The customer no longer exists.')
    const created = await stripe.customers.create(
      {
        ...(row.email ? { email: row.email } : {}),
        name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
        metadata: { supabase_customer_id: customer.id },
      },
      { ...send(), idempotencyKey: stripeIdempotencyKey(customer.id, 'stripe-customer') }
    )
    found = created.id
  }

  // Another transaction holding the customer's row (another order's T1 for them, say) makes this wait,
  // at most until the deadline. A write that can't be made in time throws: no intent has been asked for
  // yet, so the caller can still give everything back. The next press finds this Stripe customer by its
  // metadata (step 2), so it is never made twice.
  const stripeCustomerId = found
  const saved = await withinDeadline(db, timing, (tx) =>
    tx.query<{ stripe_customer_id: string }>(
      `UPDATE customers SET stripe_customer_id = COALESCE(stripe_customer_id, $1::text), updated_at = now()
       WHERE id = $2::uuid
       RETURNING stripe_customer_id`,
      [stripeCustomerId, customer.id]
    )
  )
  return saved[0]?.stripe_customer_id ?? found
}
