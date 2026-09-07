import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

// Single-sauna business today — future-proofed the same way sessions.resource_id is, in case
// a second location is ever added.
const DEFAULT_TERMINAL_LOCATION_ID = 'tml_GpvkTAMWAnUGe1'

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
    // Verify authentication
    if (!verifyRetoolAuth(request)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Optional override for a future second location; defaults to the business's only
    // Stripe Terminal location today. Scoping to a location isn't required for Bluetooth-scan
    // reader discovery, but it is required for internet-discovery and is recommended by
    // Stripe either way for correct reader/location attribution in reporting.
    let locationId = DEFAULT_TERMINAL_LOCATION_ID
    try {
      const body = await request.json()
      if (body?.locationId) locationId = body.locationId
    } catch {
      // No body (or invalid JSON) is fine — falls back to the default location.
    }

    let connectionToken: Stripe.Terminal.ConnectionToken
    try {
      connectionToken = await getStripe().terminal.connectionTokens.create({ location: locationId })
    } catch (stripeError) {
      const stripeErr = stripeError as Stripe.errors.StripeError
      console.error('Error creating Stripe terminal connection token:', stripeError)
      return NextResponse.json(
        { error: 'Failed to create connection token', details: stripeErr.message ?? 'Unknown error' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      secret: connectionToken.secret,
    })
  } catch (error) {
    console.error('Error creating terminal connection token:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
