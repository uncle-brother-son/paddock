// Ported from app/api/terminal/create-payment-intent/route.ts (and create-setup-intent, the same block):
// finding or making the customer's Stripe customer. New in W10, for the saved card; W11's reader is
// the first caller that can meet a customer with none.
import 'server-only'
import type { Queryable } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from './client'

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
  db: Queryable,
  stripe: StripeClient,
  customer: { id: string; stripeCustomerId: string | null }
): Promise<string> {
  if (customer.stripeCustomerId) return customer.stripeCustomerId

  let found: string | null = null
  try {
    const search = await stripe.customers.search({ query: `metadata['supabase_customer_id']:'${customer.id}'`, limit: 1 })
    found = search.data[0]?.id ?? null
  } catch {
    // As the legacy block: a failed search falls through to creating one.
  }

  if (!found) {
    const rows = await db.query<{ email: string | null; first_name: string | null; last_name: string | null }>(
      'SELECT email, first_name, last_name FROM customers WHERE id = $1::uuid',
      [customer.id]
    )
    const row = rows[0]
    if (!row) throw new Error('The customer no longer exists.')
    const created = await stripe.customers.create(
      {
        ...(row.email ? { email: row.email } : {}),
        name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
        metadata: { supabase_customer_id: customer.id },
      },
      { idempotencyKey: stripeIdempotencyKey(customer.id, 'stripe-customer') }
    )
    found = created.id
  }

  const saved = await db.query<{ stripe_customer_id: string }>(
    `UPDATE customers SET stripe_customer_id = COALESCE(stripe_customer_id, $1::text), updated_at = now()
     WHERE id = $2::uuid
     RETURNING stripe_customer_id`,
    [found, customer.id]
  )
  return saved[0]?.stripe_customer_id ?? found
}
