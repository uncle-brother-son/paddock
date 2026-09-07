import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

interface RefundOrderRequest {
  paymentIntentId: string
  amount?: number // pounds; partial refund if provided, full refund otherwise
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
    const body: RefundOrderRequest = await request.json()
    const { paymentIntentId, amount } = body

    // Validate required fields
    if (!paymentIntentId) {
      return NextResponse.json(
        { error: 'Missing required field: paymentIntentId' },
        { status: 400 }
      )
    }

    if (amount !== undefined && amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be greater than 0 if provided' },
        { status: 400 }
      )
    }

    // Issue the Stripe refund (full refund if amount is omitted)
    let refund: Stripe.Refund
    try {
      refund = await getStripe().refunds.create({
        payment_intent: paymentIntentId,
        ...(amount !== undefined ? { amount: Math.round(amount * 100) } : {}),
      })
    } catch (stripeError) {
      const stripeErr = stripeError as Stripe.errors.StripeError
      console.error('Error creating Stripe refund:', stripeError)
      return NextResponse.json(
        { error: 'Failed to refund payment', details: stripeErr.message ?? 'Unknown error' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      refund,
    })
  } catch (error) {
    console.error('Error processing order refund:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
