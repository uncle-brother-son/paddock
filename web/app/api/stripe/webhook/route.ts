import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { createStripeClient, READ_STRIPE_LIMITS } from '@/server/stripe/client'
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

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // W45a (W45 audit S1): the handlers read a subscription as Stripe holds it now (dispatch.ts). A read only: 10
  // seconds a call, and one more send by the SDK itself.
  const result = await processWebhookEvent(event, supabase, createStripeClient(process.env.STRIPE_SECRET_KEY, READ_STRIPE_LIMITS))
  return NextResponse.json(result.body, { status: result.status })
}
