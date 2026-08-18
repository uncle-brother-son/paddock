import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
})

interface UpdateTierPriceRequest {
  tierId: string
  price: number
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

// Create or update Stripe Price for a tier
async function upsertStripePrice(
  stripeProductId: string,
  unitAmount: number,
  currency: string = 'gbp',
  existingPriceId?: string | null
): Promise<string> {
  // If there's an existing price, archive it
  if (existingPriceId) {
    try {
      await stripe.prices.update(existingPriceId, { active: false })
    } catch (error) {
      console.error('Error archiving old Stripe price:', error)
    }
  }
  
  // Create new price
  const price = await stripe.prices.create({
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
    const body: UpdateTierPriceRequest = await request.json()
    const { tierId, price } = body

    // Validate required fields
    if (!tierId || price === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: tierId, price' },
        { status: 400 }
      )
    }

    // Initialize Supabase client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch the tier and its parent service type
    const { data: tier, error: tierError } = await supabase
      .from('service_type_price_tiers')
      .select('*, service_types!inner(stripe_product_id, name)')
      .eq('id', tierId)
      .single()

    if (tierError || !tier) {
      return NextResponse.json(
        { error: 'Tier not found' },
        { status: 404 }
      )
    }

    // Verify the parent service type has a Stripe product
    const serviceType = tier.service_types
    if (!serviceType.stripe_product_id) {
      return NextResponse.json(
        { error: 'Service type has no Stripe product. Sync from Sanity first.' },
        { status: 400 }
      )
    }

    // Create/update Stripe price
    const stripePriceId = await upsertStripePrice(
      serviceType.stripe_product_id,
      price,
      'gbp',
      tier.stripe_price_id
    )

    // Update tier in database
    const { data: updatedTier, error: updateError } = await supabase
      .from('service_type_price_tiers')
      .update({
        price,
        stripe_price_id: stripePriceId,
      })
      .eq('id', tierId)
      .select()
      .single()

    if (updateError) {
      console.error('Supabase update error:', updateError)
      return NextResponse.json(
        { error: 'Failed to update tier' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      tier: updatedTier,
      stripePriceId,
    })

  } catch (error) {
    console.error('Error updating tier price:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
