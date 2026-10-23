import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { migrateSubscriptionsToPlanPrices, type MigratableMembership, type PriceMigrationResult } from '@/lib/membership-price-migration'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

// Type definitions for catalog items
type CatalogItemType = 'service_type' | 'product' | 'addon' | 'membership_plan' | 'session_pass_type'

interface UpdatePriceRequest {
  itemType: CatalogItemType
  itemId: string
  basePrice?: number
  memberPrice?: number
  salePrice?: number
  monthlyPrice?: number
  yearlyPrice?: number
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
  existingPriceId?: string | null,
  recurring?: Stripe.PriceCreateParams.Recurring
): Promise<string> {
  // If there's an existing price, archive it and create a new one
  // (Stripe prices are immutable once created)
  if (existingPriceId) {
    try {
      await getStripe().prices.update(existingPriceId, { active: false })
    } catch (error) {
      console.error('Error archiving old Stripe price:', error)
      // Continue anyway - we'll create a new price
    }
  }
  
  // Create new price
  const price = await getStripe().prices.create({
    product: stripeProductId,
    unit_amount: Math.round(unitAmount * 100), // Convert pounds to pence
    currency,
    ...(recurring ? { recurring } : {}),
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
    const { itemType, itemId, basePrice, memberPrice, salePrice, monthlyPrice, yearlyPrice } = body

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
    } else if (itemType === 'membership_plan') {
      // Membership plans are monthly/yearly recurring subscriptions — price_monthly and
      // price_yearly are independent, each with their own Stripe recurring price. There is no
      // single 'price' column on this table (unlike session_pass_type/service_type).
      if (monthlyPrice !== undefined) {
        updates.price_monthly = monthlyPrice
        priceUpdates.price_monthly = monthlyPrice

        const stripePriceId = await upsertStripePrice(
          item.stripe_product_id,
          monthlyPrice,
          'gbp',
          item.stripe_price_id,
          { interval: 'month' }
        )
        updates.stripe_price_id = stripePriceId
      }

      if (yearlyPrice !== undefined) {
        updates.price_yearly = yearlyPrice
        priceUpdates.price_yearly = yearlyPrice

        // item.stripe_price_id_yearly may not exist yet — upsertStripePrice just creates a
        // new one in that case, there's nothing to archive.
        const stripePriceId = await upsertStripePrice(
          item.stripe_product_id,
          yearlyPrice,
          'gbp',
          item.stripe_price_id_yearly,
          { interval: 'year' }
        )
        updates.stripe_price_id_yearly = stripePriceId
      }
    } else if (itemType === 'session_pass_type') {
      // Session pass types have a single price field, same shape as service_type — no
      // base/member/sale tiers and no recurring interval on this table.
      if (basePrice !== undefined) {
        updates.price = basePrice
        priceUpdates.price = basePrice

        const stripePriceId = await upsertStripePrice(
          item.stripe_product_id,
          basePrice,
          'gbp',
          item.stripe_price_id
        )
        updates.stripe_price_id = stripePriceId
      }
    } else {
      // Products and addons have three-tier pricing
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

    // Existing members move to the new price from their NEXT renewal: each active subscription's
    // item is switched to the plan's current Stripe price with no proration, so the current period
    // stays as paid. Idempotent, and a failure here never undoes the (already saved) price change;
    // failures are reported so staff can re-save the plan to retry.
    let subscriptionMigration: PriceMigrationResult | null = null
    if (itemType === 'membership_plan' && (monthlyPrice !== undefined || yearlyPrice !== undefined)) {
      try {
        const { data: memberships, error: membershipsError } = await supabase
          .from('customer_memberships')
          .select('id, stripe_subscription_id, billing_frequency')
          .eq('plan_id', itemId)
          .not('stripe_subscription_id', 'is', null)
          .in('subscription_status', ['active', 'past_due'])
        if (membershipsError) throw membershipsError
        const stripe = getStripe()
        subscriptionMigration = await migrateSubscriptionsToPlanPrices(
          (memberships ?? []) as MigratableMembership[],
          { monthly: updatedItem.stripe_price_id ?? null, yearly: updatedItem.stripe_price_id_yearly ?? null },
          {
            retrieveSubscription: async (id) => {
              const sub = await stripe.subscriptions.retrieve(id)
              return {
                status: sub.status,
                items: sub.items.data.map((i) => ({ id: i.id, priceId: i.price.id })),
              }
            },
            switchSubscriptionItemPrice: async (id, itemId, priceId) => {
              await stripe.subscriptions.update(id, {
                items: [{ id: itemId, price: priceId }],
                proration_behavior: 'none',
              })
            },
          }
        )
      } catch (migrationError) {
        console.error('Membership price migration failed:', migrationError)
        subscriptionMigration = {
          migrated: 0,
          alreadyCurrent: 0,
          skipped: 0,
          failed: [
            {
              membershipId: 'all',
              subscriptionId: 'all',
              error: migrationError instanceof Error ? migrationError.message : 'Unknown error',
            },
          ],
        }
      }
    }

    return NextResponse.json({
      success: true,
      item: updatedItem,
      pricesUpdated: priceUpdates,
      ...(subscriptionMigration ? { subscriptionMigration } : {}),
    })

  } catch (error) {
    console.error('Error updating price:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
