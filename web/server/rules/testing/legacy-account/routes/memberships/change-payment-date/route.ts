import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import {
  changeMembershipPaymentDate,
  type ChangePaymentDateParams,
  type StripeChangePaymentDateDeps,
} from './core'

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

    const body: ChangePaymentDateParams = await request.json()
    const { stripeSubscriptionId, newRenewalDate, partMonthAmount } = body

    if (!stripeSubscriptionId || !newRenewalDate || partMonthAmount === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: stripeSubscriptionId, newRenewalDate, partMonthAmount' },
        { status: 400 }
      )
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const stripeClient = getStripe()
    const stripeDeps: StripeChangePaymentDateDeps = {
      subscriptionsRetrieve: (id) => stripeClient.subscriptions.retrieve(id),
      subscriptionsUpdate: (id, params) => stripeClient.subscriptions.update(id, params),
      paymentIntentsCreate: (params) => stripeClient.paymentIntents.create(params),
      refundsCreate: (params) => stripeClient.refunds.create(params),
    }

    const result = await changeMembershipPaymentDate(body, supabase, stripeDeps)

    if (!result.success) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Error changing membership payment date:', error instanceof Error ? error.message : 'Unknown error')
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
