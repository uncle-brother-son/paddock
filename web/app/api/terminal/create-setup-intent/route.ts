import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

interface CreateSetupIntentRequest {
  customerId: string
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
    const body: CreateSetupIntentRequest = await request.json()
    const { customerId } = body

    if (!customerId) {
      return NextResponse.json(
        { error: 'Missing required field: customerId' },
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
    // second, orphaned one. This removes the duplicate-customer risk by design, rather than
    // depending on the caller correctly handling a prior failure response.
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
        // Found via search rather than our own column — backfill it now so future calls
        // don't need to search again. Not fatal if this particular save fails, since we've
        // already resolved the correct customer either way.
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
        // The Stripe customer already exists — surface it so it isn't silently lost (and to
        // avoid creating a duplicate on a naive retry), even though the DB write failed.
        return NextResponse.json({
          success: false,
          error: 'Stripe customer was created but saving it to the customer record failed — verify manually.',
          stripeCustomerId,
        }, { status: 500 })
      }
    }

    // Create the SetupIntent the reader will use to capture and save the card
    let setupIntent: Stripe.SetupIntent
    try {
      setupIntent = await getStripe().setupIntents.create({
        customer: stripeCustomerId,
        payment_method_types: ['card_present'],
        usage: 'off_session',
      })
    } catch (stripeError) {
      const stripeErr = stripeError as Stripe.errors.StripeError
      console.error('Error creating Stripe SetupIntent:', stripeError)
      return NextResponse.json(
        { error: 'Failed to create SetupIntent', details: stripeErr.message ?? 'Unknown error' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      stripeCustomerId,
    })
  } catch (error) {
    console.error('Error creating setup intent:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
