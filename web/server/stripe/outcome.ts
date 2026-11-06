import 'server-only'
import Stripe from 'stripe'

/**
 * What a failed Stripe call means for the money.
 *
 * - definite: Stripe answered and nothing was taken, so it is safe to compensate and undo.
 * - unknown: the money may have moved. NEVER undo: retry once with the same key, then leave the
 *   order pending for reconcile. Stripe replays a saved 500 for the same key, so a retry can't
 *   always settle it.
 *
 * Anything not known to be definite counts as unknown, including errors that aren't Stripe's.
 */
export type StripeFailure =
  | { outcome: 'definite'; code: string | null; message: string }
  | { outcome: 'unknown'; code: string | null; message: string }

export function readStripeFailure(err: unknown): StripeFailure {
  const message = err instanceof Error ? err.message : String(err)
  if (!(err instanceof Stripe.errors.StripeError)) return { outcome: 'unknown', code: null, message }
  const code = err.code ?? null
  const definite = err instanceof Stripe.errors.StripeCardError || err instanceof Stripe.errors.StripeInvalidRequestError
  return { outcome: definite ? 'definite' : 'unknown', code, message }
}
