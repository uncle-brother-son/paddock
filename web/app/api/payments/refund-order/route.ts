import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { readStripeFailure } from '@/server/stripe/outcome'
import { REFUND_KEY_METADATA } from '@/server/rules/payments/payment-intent-refunds'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

interface RefundOrderRequest {
  paymentIntentId: string
  amount?: number // pounds; partial refund if provided, full refund otherwise
  // Stripe answers a repeat of this key with the first refund, so a retry can't pay twice. The
  // caller builds it: only it knows what the retry of a refund is.
  idempotencyKey?: string
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
    const { paymentIntentId, amount, idempotencyKey } = body

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
      // The key also goes on the refund itself, because Stripe forgets keys after 24 hours: a refund
      // with no clear answer older than that is found by its key in the PaymentIntent's refunds
      // (/api/v1/staff/payments/refunds), never by sending it again.
      refund = await getStripe().refunds.create(
        {
          payment_intent: paymentIntentId,
          ...(amount !== undefined ? { amount: Math.round(amount * 100) } : {}),
          ...(idempotencyKey ? { metadata: { [REFUND_KEY_METADATA]: idempotencyKey } } : {}),
        },
        idempotencyKey ? { idempotencyKey } : undefined
      )
    } catch (stripeError) {
      console.error('Error creating Stripe refund:', stripeError)
      const failure = readStripeFailure(stripeError)
      // `unsure`: Stripe never said no. The refund may have happened, so the caller mustn't treat
      // this as a refusal and offer the money again.
      return NextResponse.json(
        { error: 'Failed to refund payment', details: failure.message, ...(failure.outcome === 'unknown' ? { unsure: true } : {}) },
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
