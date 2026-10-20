import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { createMembershipSubscription, type CreateSubscriptionParams, type StripeDeps } from './core'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
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
    if (!verifyRetoolAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body: CreateSubscriptionParams = await request.json()
    const { customerId, membershipPlanId, billingFrequency } = body

    if (!customerId || !membershipPlanId || !billingFrequency) {
      return NextResponse.json(
        { error: 'Missing required fields: customerId, membershipPlanId, billingFrequency' },
        { status: 400 }
      )
    }
    if (billingFrequency !== 'monthly' && billingFrequency !== 'yearly') {
      return NextResponse.json({ error: 'billingFrequency must be "monthly" or "yearly"' }, { status: 400 })
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const stripeClient = getStripe()
    const stripeDeps: StripeDeps = {
      pricesRetrieve: (id) => stripeClient.prices.retrieve(id),
      customersUpdate: (id, params) => stripeClient.customers.update(id, params),
      subscriptionsCreate: (params, options) => stripeClient.subscriptions.create(params, options),
      subscriptionsCancel: (id) => stripeClient.subscriptions.cancel(id),
    }

    const result = await createMembershipSubscription(body, supabase, stripeDeps)

    if (!result.success) {
      return NextResponse.json(
        { error: result.error, ...(result.code ? { code: result.code } : {}) },
        { status: result.status }
      )
    }

    const { success, ...rest } = result
    return NextResponse.json({ success, ...rest })
  } catch (error) {
    console.error('Error creating membership subscription:', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
