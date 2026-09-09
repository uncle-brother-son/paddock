import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

interface UpdateGiftCardPresetPriceRequest {
  presetId: string
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

// Create or update Stripe Price for a preset (Stripe prices are immutable once created)
async function upsertStripePrice(
  stripeProductId: string,
  unitAmount: number,
  currency: string = 'gbp',
  existingPriceId?: string | null
): Promise<string> {
  if (existingPriceId) {
    try {
      await getStripe().prices.update(existingPriceId, { active: false })
    } catch (error) {
      console.error('Error archiving old Stripe price:', error)
    }
  }

  const price = await getStripe().prices.create({
    product: stripeProductId,
    unit_amount: Math.round(unitAmount * 100), // Convert pounds to pence
    currency,
  })

  return price.id
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
    const body: UpdateGiftCardPresetPriceRequest = await request.json()
    const { presetId, amount } = body

    // Validate required fields
    if (!presetId || amount === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: presetId, amount' },
        { status: 400 }
      )
    }

    // Initialize Supabase client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch the preset
    const { data: preset, error: presetError } = await supabase
      .from('gift_card_presets')
      .select('*')
      .eq('id', presetId)
      .single()

    if (presetError || !preset) {
      console.error('Preset lookup error:', presetError)
      return NextResponse.json(
        { error: 'Preset not found', details: presetError?.message },
        { status: 404 }
      )
    }

    // Fetch its parent gift card type separately (avoids relying on a PostgREST
    // relational embed, which was swallowing the real error on failure — see
    // update-tier-price for the same fix applied to service type price tiers)
    const { data: giftCardType, error: giftCardTypeError } = await supabase
      .from('gift_card_types')
      .select('stripe_product_id, name')
      .eq('id', preset.gift_card_type_id)
      .single()

    if (giftCardTypeError || !giftCardType) {
      console.error('Parent gift card type lookup error:', giftCardTypeError)
      return NextResponse.json(
        { error: 'Parent gift card type not found for this preset', details: giftCardTypeError?.message },
        { status: 404 }
      )
    }

    // Verify the parent gift card type has a Stripe product
    if (!giftCardType.stripe_product_id) {
      return NextResponse.json(
        { error: 'Gift card type has no Stripe product. Sync from Sanity first.' },
        { status: 400 }
      )
    }

    // Create/update Stripe price
    const stripePriceId = await upsertStripePrice(
      giftCardType.stripe_product_id,
      amount,
      'gbp',
      preset.stripe_price_id
    )

    // Update preset in database
    const { data: updatedPreset, error: updateError } = await supabase
      .from('gift_card_presets')
      .update({
        amount,
        stripe_price_id: stripePriceId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', presetId)
      .select()
      .single()

    if (updateError) {
      console.error('Supabase update error:', updateError)
      return NextResponse.json(
        { error: 'Failed to update preset' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      preset: updatedPreset,
      stripePriceId,
    })

  } catch (error) {
    console.error('Error updating gift card preset price:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
