import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

interface CreateGiftCardPresetRequest {
  giftCardTypeId: string
  amount: number
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
    const body: CreateGiftCardPresetRequest = await request.json()
    const { giftCardTypeId, amount } = body

    // Validate required fields
    if (!giftCardTypeId || !amount || amount <= 0) {
      return NextResponse.json(
        { error: 'Missing required fields: giftCardTypeId, amount (must be > 0)' },
        { status: 400 }
      )
    }

    // Initialize Supabase client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch parent gift card type
    const { data: giftCardType, error: typeError } = await supabase
      .from('gift_card_types')
      .select('*')
      .eq('id', giftCardTypeId)
      .single()

    if (typeError || !giftCardType) {
      return NextResponse.json(
        { error: 'Gift card type not found' },
        { status: 404 }
      )
    }

    // Verify the gift card type has a Stripe product
    if (!giftCardType.stripe_product_id) {
      return NextResponse.json(
        { error: 'Gift card type has no Stripe product. Sync from Sanity first.' },
        { status: 400 }
      )
    }

    // Create Stripe Price for this fixed amount
    let stripePriceId: string
    try {
      const price = await getStripe().prices.create({
        product: giftCardType.stripe_product_id,
        unit_amount: Math.round(amount * 100), // Convert pounds to pence
        currency: 'gbp',
      })
      stripePriceId = price.id
    } catch (stripeError) {
      console.error('Error creating Stripe price:', stripeError)
      return NextResponse.json(
        { error: 'Failed to create Stripe price', details: stripeError instanceof Error ? stripeError.message : 'Unknown error' },
        { status: 500 }
      )
    }

    // Insert preset into Supabase
    const { data: preset, error: insertError } = await supabase
      .from('gift_card_presets')
      .insert({
        gift_card_type_id: giftCardTypeId,
        amount,
        stripe_price_id: stripePriceId,
      })
      .select()
      .single()

    if (insertError) {
      console.error('Supabase insert error:', insertError)

      // If Supabase fails, archive the Stripe price we just created
      try {
        await getStripe().prices.update(stripePriceId, { active: false })
      } catch (cleanupError) {
        console.error('Error cleaning up Stripe price:', cleanupError)
      }

      return NextResponse.json(
        { error: 'Failed to create gift card preset', details: insertError.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      preset,
      stripePriceId,
    })

  } catch (error) {
    console.error('Error creating gift card preset:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
