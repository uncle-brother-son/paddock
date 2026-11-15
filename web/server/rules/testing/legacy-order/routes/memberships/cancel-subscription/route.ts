import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

interface CancelSubscriptionRequest {
  stripeSubscriptionId: string
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
    const body: CancelSubscriptionRequest = await request.json()
    const { stripeSubscriptionId } = body

    // Validate required fields
    if (!stripeSubscriptionId) {
      return NextResponse.json(
        { error: 'Missing required field: stripeSubscriptionId' },
        { status: 400 }
      )
    }

    // Cancel the Stripe subscription
    let subscription: Stripe.Subscription
    try {
      subscription = await getStripe().subscriptions.cancel(stripeSubscriptionId)
    } catch (stripeError) {
      const stripeErr = stripeError as Stripe.errors.StripeError
      console.error('Error cancelling Stripe subscription:', stripeError)
      return NextResponse.json(
        { error: 'Failed to cancel subscription', details: stripeErr.message ?? 'Unknown error' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      subscription,
    })
  } catch (error) {
    console.error('Error cancelling subscription:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
