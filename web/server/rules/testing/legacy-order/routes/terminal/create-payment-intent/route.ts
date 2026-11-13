import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

interface CreatePaymentIntentRequest {
  customerId: string
  amount: number
  saveCard: boolean
  // Optional link back to the Retool record this charge pays for, so a pending order can be
  // matched to its PaymentIntent later (finalise / cancel / scheduled check).
  // Only these keys are accepted: order_id, flow, record_id.
  metadata?: Record<string, string>
  description?: string
}

const ALLOWED_METADATA_KEYS = ['order_id', 'flow', 'record_id'] as const

function cleanMetadata(input: unknown): Record<string, string> | null | 'invalid' {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object' || Array.isArray(input)) return 'invalid'
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(ALLOWED_METADATA_KEYS as readonly string[]).includes(key)) return 'invalid'
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) return 'invalid'
    out[key] = value
  }
  return Object.keys(out).length ? out : null
}

// Verify Retool API key
function verifyRetoolAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const retoolApiKey = process.env.RETOOL_API_KEY

  if (!retoolApiKey) {
    console.error('RETOOL_API_KEY not configured')
    return false
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false
  }

  const token = authHeader.substring(7)
  return token === retoolApiKey
}

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    if (!verifyRetoolAuth(request)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Parse request body
    const body: CreatePaymentIntentRequest = await request.json()
    const { customerId, amount, saveCard } = body
    const metadata = cleanMetadata(body.metadata)
    if (metadata === 'invalid') {
      return NextResponse.json(
        { error: 'metadata may only contain non-empty string values for: order_id, flow, record_id' },
        { status: 400 }
      )
    }
    if (body.description !== undefined && typeof body.description !== 'string') {
      return NextResponse.json({ error: 'description must be a string' }, { status: 400 })
    }

    if (!customerId) {
      return NextResponse.json(
        { error: 'Missing required field: customerId' },
        { status: 400 }
      )
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400 }
      )
    }
    if (typeof saveCard !== 'boolean') {
      return NextResponse.json(
        { error: 'Missing required field: saveCard (boolean)' },
        { status: 400 }
      )
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id, first_name, last_name, email, stripe_customer_id')
      .eq('id', customerId)
      .single()

    if (customerError || !customer) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    }

    let stripeCustomerId = customer.stripe_customer_id

    // Before creating a new Stripe customer, check Stripe itself (not just our own possibly
    // stale column) for one already tagged with this customer's id. This covers the case
    // where an earlier attempt created the Stripe customer successfully but failed to save
    // it to Postgres — a retry then reuses the existing customer instead of creating a
    // second, orphaned one. Same approach as /api/terminal/create-setup-intent.
    if (!stripeCustomerId) {
      try {
        const existingSearch = await getStripe().customers.search({
          query: `metadata['supabase_customer_id']:'${customerId}'`,
          limit: 1,
        })
        stripeCustomerId = existingSearch.data[0]?.id ?? null
      } catch (searchError) {
        console.error('Error searching for an existing Stripe customer by metadata:', searchError)
        // Non-fatal — fall through to creating a new customer if the search itself fails.
      }

      if (stripeCustomerId) {
        const { error: backfillError } = await supabase
          .from('customers')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', customerId)
        if (backfillError) {
          console.error('Error backfilling stripe_customer_id found via search:', backfillError)
        }
      }
    }

    // Create the Stripe customer if one still doesn't exist
    if (!stripeCustomerId) {
      let stripeCustomer: Stripe.Customer
      try {
        stripeCustomer = await getStripe().customers.create({
          email: customer.email,
          name: `${customer.first_name} ${customer.last_name}`,
          metadata: { supabase_customer_id: customerId },
        })
      } catch (stripeError) {
        const stripeErr = stripeError as Stripe.errors.StripeError
        console.error('Error creating Stripe customer:', stripeError)
        return NextResponse.json(
          { error: 'Failed to create Stripe customer', details: stripeErr.message ?? 'Unknown error' },
          { status: 500 }
        )
      }

      stripeCustomerId = stripeCustomer.id

      const { error: updateError } = await supabase
        .from('customers')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', customerId)

      if (updateError) {
        console.error('Error saving stripe_customer_id after creation:', updateError)
        return NextResponse.json({
          success: false,
          error: 'Stripe customer was created but saving it to the customer record failed — verify manually.',
          stripeCustomerId,
        }, { status: 500 })
      }
    }

    // Create the PaymentIntent the reader will use to collect and charge the card in one tap.
    // setup_future_usage is only included when the customer consents to saving the card —
    // omitted entirely (not set to a falsy value) for a one-off charge.
    let paymentIntent: Stripe.PaymentIntent
    try {
      paymentIntent = await getStripe().paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: 'gbp',
        customer: stripeCustomerId,
        payment_method_types: ['card_present'],
        ...(saveCard ? { setup_future_usage: 'off_session' as const } : {}),
        metadata: { supabase_customer_id: customerId, ...(metadata ?? {}) },
        ...(body.description ? { description: body.description.slice(0, 500) } : {}),
      })
    } catch (stripeError) {
      const stripeErr = stripeError as Stripe.errors.StripeError
      console.error('Error creating Stripe PaymentIntent:', stripeError)
      return NextResponse.json(
        { error: 'Failed to create PaymentIntent', details: stripeErr.message ?? 'Unknown error' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      stripeCustomerId,
    })
  } catch (error) {
    console.error('Error creating payment intent:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
