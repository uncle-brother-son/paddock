import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-07-29.dahlia',
})

interface CreateVariantRequest {
  productId: string
  size: string
  sku: string
  priceOverride?: number  // Optional - if not provided, inherits from product's base_price
  stockQuantity?: number  // Optional - defaults to 0
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
    const body: CreateVariantRequest = await request.json()
    const { productId, size, sku, priceOverride, stockQuantity = 0 } = body

    // Validate required fields
    if (!productId || !size || !sku) {
      return NextResponse.json(
        { error: 'Missing required fields: productId, size, sku' },
        { status: 400 }
      )
    }

    // Initialize Supabase client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch parent product
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .single()

    if (productError || !product) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404 }
      )
    }

    // Verify product has a Stripe product
    if (!product.stripe_product_id) {
      return NextResponse.json(
        { error: 'Product has no Stripe product. Sync from Sanity first.' },
        { status: 400 }
      )
    }

    // Check for duplicate SKU
    const { data: existingSku } = await supabase
      .from('product_variants')
      .select('id')
      .eq('sku', sku)
      .single()

    if (existingSku) {
      return NextResponse.json(
        { error: 'SKU already exists' },
        { status: 400 }
      )
    }

    // Determine price to use (override or inherit from product base_price)
    const variantPrice = priceOverride ?? product.base_price

    if (!variantPrice) {
      return NextResponse.json(
        { error: 'No price available. Set priceOverride or ensure product has base_price.' },
        { status: 400 }
      )
    }

    // Create Stripe Price
    let stripePriceId: string
    try {
      const price = await stripe.prices.create({
        product: product.stripe_product_id,
        unit_amount: Math.round(variantPrice * 100), // Convert pounds to pence
        currency: 'gbp',
        metadata: {
          size,
          sku,
        },
      })
      stripePriceId = price.id
    } catch (stripeError) {
      console.error('Error creating Stripe price:', stripeError)
      return NextResponse.json(
        { error: 'Failed to create Stripe price', details: stripeError instanceof Error ? stripeError.message : 'Unknown error' },
        { status: 500 }
      )
    }

    // Insert variant into Supabase
    const { data: variant, error: insertError } = await supabase
      .from('product_variants')
      .insert({
        product_id: productId,
        size,
        sku,
        price_override: priceOverride,
        stock_quantity: stockQuantity,
        stripe_price_id: stripePriceId,
      })
      .select()
      .single()

    if (insertError) {
      console.error('Supabase insert error:', insertError)
      
      // If Supabase fails, archive the Stripe price we just created
      try {
        await stripe.prices.update(stripePriceId, { active: false })
      } catch (cleanupError) {
        console.error('Error cleaning up Stripe price:', cleanupError)
      }
      
      return NextResponse.json(
        { error: 'Failed to create variant', details: insertError.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      variant,
      stripePriceId,
    })

  } catch (error) {
    console.error('Error creating variant:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
