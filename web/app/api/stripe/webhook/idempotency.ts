import Stripe from 'stripe'
import { dispatchStripeEvent } from './dispatch'

export interface ProcessResult {
  status: number
  body: Record<string, unknown>
}

// Idempotency + dispatch for a single, already signature-verified Stripe event. Split out from
// route.ts so it can be unit tested without mocking Stripe signature verification or NextRequest.
// supabase is typed `any` (matching the rest of this codebase, e.g. sanity/webhook/route.ts) —
// PostgREST's query builder is thenable but not a strict Promise, which fights a stricter type.
export async function processWebhookEvent(event: Stripe.Event, supabase: any): Promise<ProcessResult> {
  // Step 1: claim this event id. ON CONFLICT DO NOTHING via ignoreDuplicates — a conflict just
  // means we've seen this event before, which the lookup below distinguishes from a fresh claim.
  const { error: upsertError } = await supabase
    .from('stripe_webhook_events')
    .upsert({ event_id: event.id, event_type: event.type }, { onConflict: 'event_id', ignoreDuplicates: true })

  if (upsertError) {
    console.error('Error recording webhook event:', event.id, event.type, upsertError.message)
    return { status: 500, body: { error: 'Internal server error' } }
  }

  const { data: existing, error: lookupError } = await supabase
    .from('stripe_webhook_events')
    .select('outcome')
    .eq('event_id', event.id)
    .single()

  if (lookupError || !existing) {
    console.error('Error looking up webhook event:', event.id, event.type, lookupError?.message)
    return { status: 500, body: { error: 'Internal server error' } }
  }

  // A prior attempt already finished (successfully or as a deliberate no-op) — do nothing.
  // outcome 'error' or null (crashed or never finished) falls through and is retried below.
  if (existing.outcome === 'processed' || existing.outcome === 'ignored') {
    console.log('Duplicate Stripe webhook event, skipping:', event.id, event.type)
    return { status: 200, body: { received: true, duplicate: true } }
  }

  try {
    const result = await dispatchStripeEvent(event, supabase)

    const { error: updateError } = await supabase
      .from('stripe_webhook_events')
      .update({
        processed_at: new Date().toISOString(),
        outcome: result.outcome,
        detail: result.detail,
        error: null,
      })
      .eq('event_id', event.id)

    if (updateError) {
      console.error('Error recording webhook outcome:', event.id, event.type, updateError.message)
    }

    console.log('Stripe webhook handled:', event.id, event.type, result.outcome)
    return { status: 200, body: { received: true } }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Stripe webhook handler error:', event.id, event.type, message)

    const { error: updateError } = await supabase
      .from('stripe_webhook_events')
      .update({ processed_at: new Date().toISOString(), outcome: 'error', error: message })
      .eq('event_id', event.id)

    if (updateError) {
      console.error('Error recording webhook error outcome:', event.id, event.type, updateError.message)
    }

    return { status: 500, body: { error: 'Internal server error' } }
  }
}
