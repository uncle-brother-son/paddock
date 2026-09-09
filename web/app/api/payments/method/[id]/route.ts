import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Verify authentication
    if (!verifyRetoolAuth(request)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { id } = await params
    if (!id) {
      return NextResponse.json(
        { error: 'Missing required parameter: id' },
        { status: 400 }
      )
    }

    let paymentMethod: Stripe.PaymentMethod
    try {
      paymentMethod = await getStripe().paymentMethods.retrieve(id)
    } catch (stripeError) {
      const stripeErr = stripeError as Stripe.errors.StripeError
      console.error('Error retrieving Stripe PaymentMethod:', stripeError)
      return NextResponse.json(
        { error: 'Failed to retrieve payment method', details: stripeErr.message ?? 'Unknown error' },
        { status: 404 }
      )
    }

    // A payment method captured via a Terminal reader exposes card details under
    // `card_present`, not `card` (that field is only for online/keyed-in cards) — check both,
    // since it isn't certain which type is being passed in here.
    const cardDetails = paymentMethod.card_present ?? paymentMethod.card
    if (!cardDetails) {
      return NextResponse.json(
        { error: 'Payment method has no card details (not a card or card_present type)' },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      last4: cardDetails.last4,
      brand: cardDetails.brand,
    })
  } catch (error) {
    console.error('Error retrieving payment method:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
