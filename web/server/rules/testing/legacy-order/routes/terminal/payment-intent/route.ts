import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { handlePaymentIntent, type PaymentIntentParams } from './core'

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
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false
  return authHeader.substring(7) === retoolApiKey
}

// POST /api/terminal/payment-intent  { paymentIntentId, action: 'retrieve' | 'cancel' }
export async function POST(request: NextRequest) {
  try {
    if (!verifyRetoolAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const body: PaymentIntentParams = await request.json()
    const stripe = getStripe()
    const result = await handlePaymentIntent(body, {
      retrieve: (id) => stripe.paymentIntents.retrieve(id),
      cancel: (id) => stripe.paymentIntents.cancel(id),
    })
    if (!result.success) {
      return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status })
    }
    return NextResponse.json(result)
  } catch (error) {
    console.error('Error handling payment intent:', error instanceof Error ? error.message : error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
