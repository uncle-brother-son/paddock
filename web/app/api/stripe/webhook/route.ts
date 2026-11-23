import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { syncCancelDateUnlessWanted } from '@/server/rules/memberships/cancel-kept'
import { listPaidAfterEnd } from '@/server/rules/memberships/paid-after-end'
import { createStripeClient, READ_STRIPE_LIMITS } from '@/server/stripe/client'
import { webhookStore } from './database'
import type { ListPaidAfterEnd, SyncCancelDate } from './dispatch'
import { processWebhookEvent } from './idempotency'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  // Must read the raw body — signature verification hashes the exact bytes Stripe sent, and
  // request.json() would silently reserialize it, breaking verification.
  const body = await request.text()

  let event: Stripe.Event
  try {
    // Workers' runtime has no Node crypto module, so the signature check needs the SubtleCrypto-
    // based provider explicitly — the SDK's default verifier depends on Node's crypto.
    event = await getStripe().webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider()
    )
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // W66 (H8, N1): every database step on the Worker's own connection, opened once for the event after the signature
  // check and closed when the answer has gone. Until W66 the event's row and the four membership functions went
  // through Supabase's client with the service-role key; the steps, their order and the answers are unchanged
  // (database.ts, idempotency.ts). Nothing connects until the first statement, and no statement is ever held open
  // across a Stripe read: each step is its own statement, and the two that need several (below) are each one
  // transaction with no Stripe call inside.
  // W45a (W45 audit S1): the handlers read a subscription as Stripe holds it now (dispatch.ts). A read only: 10
  // seconds a call, and one more send by the SDK itself.
  const db = openRequestDb()
  try {
    // W47r-b (W47r-a "Noticed" 1): an `invoice.paid` for a subscription that had already ended when the invoice was
    // paid is listed for a refund (dispatch.ts, recordInvoicePaid): an audit row, in a transaction under the
    // membership's lock. A failure to write throws, the notice is an error, and Stripe sends it again.
    const list: ListPaidAfterEnd = listPaidAfterEnd(db, { actor: { type: 'system', id: null }, requestId: event.id }, 'webhook')
    // W47r-e (W47r-d "Noticed" 1): a `customer.subscription.updated` for a subscription Stripe shows with no end is
    // written in one transaction under the membership's lock: the sync function is called there only when no cancel
    // pressed here still wants the last day (cancel-kept.ts). A notice that sets or moves an end is written by the
    // function alone, as before. A failure to write throws, the notice is an error, and Stripe sends it again.
    const syncCancelDate: SyncCancelDate = (params) => syncCancelDateUnlessWanted(db, params)
    const result = await processWebhookEvent(event, webhookStore(db), createStripeClient(process.env.STRIPE_SECRET_KEY, READ_STRIPE_LIMITS), list, syncCancelDate)
    return NextResponse.json(result.body, { status: result.status })
  } finally {
    await closeRequestDb(db)
  }
}
