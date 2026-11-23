import Stripe from 'stripe'
import type { WebhookStore } from './database'
import { dispatchStripeEvent, type ListPaidAfterEnd, type SubscriptionReader, type SyncCancelDate } from './dispatch'

export interface ProcessResult {
  status: number
  body: Record<string, unknown>
}

const message = (err: unknown): string => (err instanceof Error ? err.message : 'Unknown error')

// Idempotency + dispatch for a single, already signature-verified Stripe event. Split out from
// route.ts so it can be unit tested without mocking Stripe signature verification or NextRequest.
// W45a: `stripe` is the handlers' read of Stripe (dispatch.ts). A read that fails throws out of the dispatch and
// lands in the catch below: outcome 'error' and a 500, never 'processed', so Stripe sends the event again.
// W47r-b: `list` writes the line for an invoice paid after its subscription had ended (dispatch.ts, recordInvoicePaid).
// A listing that fails throws like a failed read: the event is an error, and Stripe sends it again.
// W47r-e: `syncCancelDate` makes an update notice's write when Stripe shows no end (dispatch.ts): it throws the same way.
// W66 (H8, N1): `store` is the Worker's own database connection (database.ts), where it was Supabase's client. The
// same steps in the same order, with the same answers: a step Supabase's client answered with an error now throws,
// and is answered here exactly as that error was.
export async function processWebhookEvent(event: Stripe.Event, store: WebhookStore, stripe: SubscriptionReader, list?: ListPaidAfterEnd, syncCancelDate?: SyncCancelDate): Promise<ProcessResult> {
  // Step 1: claim this event id. ON CONFLICT DO NOTHING — a conflict just means we've seen this
  // event before, which the lookup below distinguishes from a fresh claim.
  try {
    await store.claim(event.id, event.type)
  } catch (err) {
    console.error('Error recording webhook event:', event.id, event.type, message(err))
    return { status: 500, body: { error: 'Internal server error' } }
  }

  let existing: { outcome: string | null } | null
  try {
    existing = await store.outcomeOf(event.id)
  } catch (err) {
    console.error('Error looking up webhook event:', event.id, event.type, message(err))
    return { status: 500, body: { error: 'Internal server error' } }
  }
  if (!existing) {
    console.error('Error looking up webhook event:', event.id, event.type, 'no row')
    return { status: 500, body: { error: 'Internal server error' } }
  }

  // A prior attempt already finished (successfully or as a deliberate no-op) — do nothing.
  // outcome 'error' or null (crashed or never finished) falls through and is retried below.
  if (existing.outcome === 'processed' || existing.outcome === 'ignored') {
    console.log('Duplicate Stripe webhook event, skipping:', event.id, event.type)
    return { status: 200, body: { received: true, duplicate: true } }
  }

  try {
    const result = await dispatchStripeEvent(event, store, stripe, list, syncCancelDate)

    // As before W66: the handler's writes are made, so a failure to record the outcome is logged and the event is
    // still answered 200 (its row is left unfinished, and a delivery Stripe sends again is handled afresh).
    try {
      await store.recordOutcome(event.id, { processedAt: new Date().toISOString(), outcome: result.outcome, detail: result.detail })
    } catch (err) {
      console.error('Error recording webhook outcome:', event.id, event.type, message(err))
    }

    console.log('Stripe webhook handled:', event.id, event.type, result.outcome)
    return { status: 200, body: { received: true } }
  } catch (err) {
    console.error('Stripe webhook handler error:', event.id, event.type, message(err))

    try {
      await store.recordError(event.id, { processedAt: new Date().toISOString(), message: message(err) })
    } catch (recordErr) {
      console.error('Error recording webhook error outcome:', event.id, event.type, message(recordErr))
    }

    return { status: 500, body: { error: 'Internal server error' } }
  }
}
