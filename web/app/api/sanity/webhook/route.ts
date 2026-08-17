import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

// Verify webhook signature from Sanity
function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.SANITY_WEBHOOK_SECRET
  if (!secret) {
    console.error('SANITY_WEBHOOK_SECRET not configured')
    return false
  }

  const hash = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex')

  return hash === signature
}

// Extract thumbnail URL from Sanity image object
function getThumbnailUrl(image: any): string | null {
  if (!image || !image.asset || !image.asset._ref) return null
  
  const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
  const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET
  
  // Extract image ID from reference (format: image-{assetId}-{dimensions}-{format})
  const parts = image.asset._ref.split('-')
  if (parts.length < 3) return null
  
  const assetId = parts[1]
  const format = parts[parts.length - 1]
  
  // Build Sanity CDN URL
  return `https://cdn.sanity.io/images/${projectId}/${dataset}/${assetId}.${format}`
}

export async function POST(request: NextRequest) {
  try {
    // Initialize Supabase client with service role key for admin operations
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Verify webhook signature
    const signature = request.headers.get('x-sanity-signature')
    const body = await request.text()
    
    if (!signature || !verifySignature(body, signature)) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      )
    }

    const payload = JSON.parse(body)
    const { _type, _id, _rev } = payload

    // Only process published documents (drafts have _id starting with 'drafts.')
    if (_id.startsWith('drafts.')) {
      return NextResponse.json({ message: 'Draft ignored' })
    }

    console.log(`Processing ${_type} webhook for ${_id}`)

    // Route to appropriate handler based on document type
    switch (_type) {
      case 'serviceType':
        await handleServiceType(payload, supabase)
        break
      case 'product':
        await handleProduct(payload, supabase)
        break
      case 'addon':
        await handleAddon(payload, supabase)
        break
      case 'membershipPlan':
        await handleMembershipPlan(payload, supabase)
        break
      case 'sessionPassType':
        await handleSessionPassType(payload, supabase)
        break
      default:
        // Ignore non-catalog types (page, blogPost, galleryImage)
        return NextResponse.json({ message: 'Non-catalog type ignored' })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

async function handleServiceType(payload: any, supabase: any) {
  const { _id, name, images, duration, capacity } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  // Check if service type already exists
  const { data: existing } = await supabase
    .from('service_types')
    .select('id, stripe_product_id')
    .eq('sanity_service_type_id', _id)
    .single()

  if (existing) {
    // Update existing record (only mirror fields)
    const { error } = await supabase
      .from('service_types')
      .update({
        name,
        thumbnail_url: thumbnailUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)

    if (error) throw error
    console.log(`Updated service_type: ${_id}`)
  } else {
    // Create new record
    // Note: price, booking_type, and tiers must be set manually in Retool
    const { data, error } = await supabase
      .from('service_types')
      .insert({
        sanity_service_type_id: _id,
        name,
        thumbnail_url: thumbnailUrl,
        duration: duration || 60,
        capacity: capacity || 6,
        active: true
      })
      .select('id')
      .single()

    if (error) throw error
    console.log(`Created service_type: ${_id}`)

    // TODO: Create Stripe Product when Stripe integration is ready
    // const stripeProduct = await stripe.products.create({ name })
    // await supabase.from('service_types').update({ stripe_product_id: stripeProduct.id }).eq('id', data.id)
  }
}

async function handleProduct(payload: any, supabase: any) {
  const { _id, name, category, images } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  const { data: existing } = await supabase
    .from('products')
    .select('id, stripe_product_id')
    .eq('sanity_product_id', _id)
    .single()

  if (existing) {
    const { error } = await supabase
      .from('products')
      .update({
        name,
        category,
        thumbnail_url: thumbnailUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)

    if (error) throw error
    console.log(`Updated product: ${_id}`)
  } else {
    const { data, error } = await supabase
      .from('products')
      .insert({
        sanity_product_id: _id,
        name,
        category,
        thumbnail_url: thumbnailUrl,
        active: true,
        stock_quantity: 0
      })
      .select('id')
      .single()

    if (error) throw error
    console.log(`Created product: ${_id}`)

    // TODO: Create Stripe Product
  }
}

async function handleAddon(payload: any, supabase: any) {
  const { _id, name, category, images } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  const { data: existing } = await supabase
    .from('addons')
    .select('id, stripe_product_id')
    .eq('sanity_addon_id', _id)
    .single()

  if (existing) {
    const { error } = await supabase
      .from('addons')
      .update({
        name,
        category,
        thumbnail_url: thumbnailUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)

    if (error) throw error
    console.log(`Updated addon: ${_id}`)
  } else {
    const { data, error } = await supabase
      .from('addons')
      .insert({
        sanity_addon_id: _id,
        name,
        category,
        thumbnail_url: thumbnailUrl,
        active: true
      })
      .select('id')
      .single()

    if (error) throw error
    console.log(`Created addon: ${_id}`)

    // TODO: Create Stripe Product
  }
}

async function handleMembershipPlan(payload: any, supabase: any) {
  const { _id, name, images } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  const { data: existing } = await supabase
    .from('membership_plans')
    .select('id, stripe_product_id')
    .eq('sanity_membership_plan_id', _id)
    .single()

  if (existing) {
    const { error } = await supabase
      .from('membership_plans')
      .update({
        name,
        thumbnail_url: thumbnailUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)

    if (error) throw error
    console.log(`Updated membership_plan: ${_id}`)
  } else {
    const { data, error } = await supabase
      .from('membership_plans')
      .insert({
        sanity_membership_plan_id: _id,
        name,
        thumbnail_url: thumbnailUrl,
        active: true
      })
      .select('id')
      .single()

    if (error) throw error
    console.log(`Created membership_plan: ${_id}`)

    // TODO: Create Stripe Product
  }
}

async function handleSessionPassType(payload: any, supabase: any) {
  const { _id, name, images } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  const { data: existing } = await supabase
    .from('session_pass_types')
    .select('id, stripe_product_id')
    .eq('sanity_session_pass_type_id', _id)
    .single()

  if (existing) {
    const { error } = await supabase
      .from('session_pass_types')
      .update({
        name,
        thumbnail_url: thumbnailUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)

    if (error) throw error
    console.log(`Updated session_pass_type: ${_id}`)
  } else {
    const { data, error } = await supabase
      .from('session_pass_types')
      .insert({
        sanity_session_pass_type_id: _id,
        name,
        thumbnail_url: thumbnailUrl,
        active: true,
        session_count: 10, // Default, edit in Retool
        expiry_months: 12  // Default, edit in Retool
      })
      .select('id')
      .single()

    if (error) throw error
    console.log(`Created session_pass_type: ${_id}`)

    // TODO: Create Stripe Product
  }
}
