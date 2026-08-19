import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-07-29.dahlia',
})

type CatalogItemType = 'service_type' | 'product' | 'addon' | 'membership_plan' | 'session_pass_type'

interface ToggleActiveRequest {
  itemType: CatalogItemType
  itemId: string
  active: boolean
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
    const body: ToggleActiveRequest = await request.json()
    const { itemType, itemId, active } = body

    // Validate required fields
    if (!itemType || !itemId || typeof active !== 'boolean') {
      return NextResponse.json(
        { error: 'Missing required fields: itemType, itemId, active' },
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

    // Update Stripe product if it exists
    if (item.stripe_product_id) {
      try {
        await stripe.products.update(item.stripe_product_id, {
          active,
        })
      } catch (error) {
        console.error('Error updating Stripe product:', error)
        return NextResponse.json(
          { error: 'Failed to update Stripe product' },
          { status: 500 }
        )
      }
    }

    // Update database
    const { data: updatedItem, error: updateError } = await supabase
      .from(tableName)
      .update({ active })
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
    })

  } catch (error) {
    console.error('Error toggling active status:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
