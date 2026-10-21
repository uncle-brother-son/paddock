import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { chargeSavedCard, type ChargeSavedCardParams, type StripeChargeDeps } from './core'

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

    const body: ChargeSavedCardParams = await request.json()

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const stripeClient = getStripe()
    const stripeDeps: StripeChargeDeps = {
      paymentIntentsCreate: (params) => stripeClient.paymentIntents.create(params),
    }

    const result = await chargeSavedCard(body, supabase, stripeDeps)

    if (!result.success) {
      const { status, ...rest } = result
      return NextResponse.json(rest, { status })
    }

    const { success, ...rest } = result
    return NextResponse.json({ success, ...rest })
  } catch (error) {
    console.error('Error processing saved-card charge:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
