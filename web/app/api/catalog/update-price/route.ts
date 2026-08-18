import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
})

// Type definitions for catalog items
type CatalogItemType = 'service_type' | 'product' | 'addon' | 'membership_plan' | 'session_pass_type'

interface UpdatePriceRequest {
  itemType: CatalogItemType
  itemId: string
  basePrice?: number
  memberPrice?: number
  salePrice?: number
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

// Get Stripe price ID field names for the item type
function getStripePriceFields(itemType: CatalogItemType): string[] {
  switch (itemType) {
    case 'service_type':
      return ['stripe_price_id']
    case 'product':
    case 'addon':
      return ['stripe_price_id_base', 'stripe_price_id_member', 'stripe_price_id_sale']
    case 'membership_plan':
      return ['stripe_price_id']
    case 'session_pass_type':
      return ['stripe_price_id']
    default:
      return []
  }
}

// Create or update Stripe Price
async function upsertStripePrice(
  stripeProductId: string,
  unitAmount: number,
  currency: string = 'gbp',
  existingPriceId?: string | null
): Promise<string> {
  // If there's an existing price, archive it and create a new one
  // (Stripe prices are immutable once created)
  if (existingPriceId) {
    try {
      await stripe.prices.update(existingPriceId, { active: false })
    } catch (error) {
      console.error('Error archiving old Stripe price:', error)
      // Continue anyway - we'll create a new price
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
    const body: UpdatePriceRequest = await request.json()
    const { itemType, itemId, basePrice, memberPrice, salePrice } = body

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

    // Get the table name (plural form)
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

    // Verify item has a Stripe product
    if (!item.stripe_product_id) {
      return NextResponse.json(
        { error: 'Item has no Stripe product. Sync from Sanity first.' },
        { status: 400 }
      )
    }

    // Build update object
    const updates: any = {}
    const priceUpdates: { [key: string]: number } = {}

    // Update prices and create/update Stripe prices
    if (itemType === 'service_type') {
      // Service types: only PUBLIC sessions have a single price field
      // Private sessions use service_type_price_tiers table instead (separate endpoint)
      
      // Verify this is a public service type
      if (item.booking_type !== 'public') {
        return NextResponse.json(
          { error: 'Private service types use price tiers. Use /api/catalog/update-tier-price instead.' },
          { status: 400 }
        )
      }
      
      if (basePrice !== undefined) {
        updates.price = basePrice  // Note: field is 'price' not 'base_price' for service types
        priceUpdates.price = basePrice
        
        // Update Stripe price
        const stripePriceId = await upsertStripePrice(
          item.stripe_product_id,
          basePrice,
          'gbp',  // Using GBP per project currency
          item.stripe_price_id
        )
        updates.stripe_price_id = stripePriceId
      }
    } else {
      // Products, addons, membership plans, session passes have three-tier pricing
      if (basePrice !== undefined) {
        updates.base_price = basePrice
        priceUpdates.base_price = basePrice
        
        const stripePriceId = await upsertStripePrice(
          item.stripe_product_id,
          basePrice,
          'gbp',
          item.stripe_price_id_base
        )
        updates.stripe_price_id_base = stripePriceId
      }
      
      if (memberPrice !== undefined) {
        updates.member_price = memberPrice
        priceUpdates.member_price = memberPrice
        
        const stripePriceId = await upsertStripePrice(
          item.stripe_product_id,
          memberPrice,
          'gbp',
          item.stripe_price_id_member
        )
        updates.stripe_price_id_member = stripePriceId
      }
      
      if (salePrice !== undefined) {
        updates.sale_price = salePrice
        priceUpdates.sale_price = salePrice
        
        const stripePriceId = await upsertStripePrice(
          item.stripe_product_id,
          salePrice,
          'gbp',
          item.stripe_price_id_sale
        )
        updates.stripe_price_id_sale = stripePriceId
      }
    }

    // Perform database update
    const { data: updatedItem, error: updateError } = await supabase
      .from(tableName)
      .update(updates)
      .eq('id', itemId)
      .select()
      .single()

    if (updateError) {
      console.error('Supabase update error:', updateError)
      return NextResponse.json(
        { error: 'Failed to update item' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      item: updatedItem,
      pricesUpdated: priceUpdates,
    })

  } catch (error) {
    console.error('Error updating price:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
