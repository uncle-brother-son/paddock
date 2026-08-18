import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
})

type CatalogItemType = 'service_type' | 'product' | 'addon' | 'membership_plan' | 'session_pass_type'

interface SyncStripeRequest {
  itemType: CatalogItemType
  itemId: string
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

// Create Stripe product and prices for an item
async function createStripeProduct(item: any, itemType: CatalogItemType): Promise<any> {
  // Create Stripe Product
  const product = await stripe.products.create({
    name: item.name,
    description: item.description || undefined,
    images: item.thumbnail_url ? [item.thumbnail_url] : undefined,
    active: item.active ?? true,
    metadata: {
      supabase_id: item.id,
      item_type: itemType,
    },
  })

  const updates: any = {
    stripe_product_id: product.id,
  }

  // Create Stripe Prices based on item type
  if (itemType === 'service_type') {
    // Service types only have base_price
    if (item.base_price !== null && item.base_price !== undefined) {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(item.base_price * 100),
        currency: 'usd',
      })
      updates.stripe_price_id = price.id
    }
  } else {
    // Products, addons, membership plans have three-tier pricing
    if (item.base_price !== null && item.base_price !== undefined) {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(item.base_price * 100),
        currency: 'usd',
      })
      updates.stripe_price_id_base = price.id
    }
    
    if (item.member_price !== null && item.member_price !== undefined) {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(item.member_price * 100),
        currency: 'gbp',
      })
      updates.stripe_price_id_member = price.id
    }
    
    if (item.sale_price !== null && item.sale_price !== undefined) {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(item.sale_price * 100),
        currency: 'gbp',
      })
      updates.stripe_price_id_sale = price.id
    }
  }

  return updates
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
    const body: SyncStripeRequest = await request.json()
    const { itemType, itemId } = body

    // Validate required fields
    if (!itemType || !itemId) {
      return NextResponse.json(
        { error: 'Missing required fields: itemType, itemId' },
        { status: 400 }
      )
    }

    // Initialize Supabase client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Get the table name
    const tableName = itemType === 'service_type' ? 'service_types' : `${itemType}s`

    // Fetch current item data
    const { data: item, error: fetchError } = await supabase
      .from(tableName)
      .select('*')
      .eq('id', itemId)
      .single()

    if (fetchError || !item) {
      return NextResponse.json(
        { error: 'Item not found' },
        { status: 404 }
      )
    }

    // Check if Stripe product already exists
    if (item.stripe_product_id) {
      return NextResponse.json(
        { error: 'Item already has a Stripe product', stripeProductId: item.stripe_product_id },
        { status: 400 }
      )
    }

    // Validate required fields for Stripe
    if (!item.name) {
      return NextResponse.json(
        { error: 'Item must have a name to sync to Stripe' },
        { status: 400 }
      )
    }

    // Create Stripe product and prices
    const updates = await createStripeProduct(item, itemType)

    // Update database with Stripe IDs
    const { data: updatedItem, error: updateError } = await supabase
      .from(tableName)
      .update(updates)
      .eq('id', itemId)
      .select()
      .single()

    if (updateError) {
      console.error('Supabase update error:', updateError)
      return NextResponse.json(
        { error: 'Failed to update item with Stripe IDs' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      item: updatedItem,
      stripeProductId: updates.stripe_product_id,
    })

  } catch (error) {
    console.error('Error syncing to Stripe:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
