import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import Stripe from 'stripe'
import { createImageUrlBuilder } from '@sanity/image-url'

const imageBuilder = createImageUrlBuilder({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
})

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-07-29.dahlia',
    httpClient: Stripe.createFetchHttpClient(), // Workers' runtime doesn't support the SDK's default Node socket client
  })
}

// Verify webhook signature from Sanity
function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.SANITY_WEBHOOK_SECRET
  if (!secret) {
    console.error('SANITY_WEBHOOK_SECRET not configured')
    return false
  }

  // Parse Sanity signature format: t=timestamp,v1=hash
  const signatureParts = signature.split(',')
  const timestampPart = signatureParts.find((part) => part.startsWith('t='))
  const hashPart = signatureParts.find((part) => part.startsWith('v1='))
  
  if (!timestampPart || !hashPart) {
    console.error('Invalid signature format')
    return false
  }
  
  const timestamp = timestampPart.split('=')[1]
  const receivedHash = hashPart.split('=')[1]
  
  // Create HMAC with timestamp and body
  const signedPayload = `${timestamp}.${body}`
  const computedHash = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  return computedHash === receivedHash
}

// Extract thumbnail URL from a Sanity image object, resized to 80px wide (height scales
// proportionally, no crop). Uses the actual @sanity/image-url builder rather than hand-parsing
// the asset reference string \u2014 the builder correctly reads the real dimensions Sanity bakes
// into the asset filename, which a manually constructed URL was missing entirely.
function getThumbnailUrl(image: any): string | null {
  if (!image || !image.asset || !image.asset._ref) return null
  return imageBuilder.image(image).width(80).url()
}

// Deactivates whichever catalog table has a row matching this Sanity document id. Used for
// delete/unpublish events, which never reliably include `_type` in the payload body once the
// document no longer exists — matching by id across all catalog tables avoids depending on
// that. Per 07-write-architecture.md: Sanity-side deletion always means "deactivate", never a
// raw table delete.
async function deactivateBySanityId(sanityId: string, supabase: any) {
  const tables: Array<{ table: string; column: string }> = [
    { table: 'service_types', column: 'sanity_service_type_id' },
    { table: 'products', column: 'sanity_product_id' },
    { table: 'addons', column: 'sanity_addon_id' },
    { table: 'membership_plans', column: 'sanity_plan_id' },
    { table: 'session_pass_types', column: 'sanity_pass_type_id' },
  ]

  for (const { table, column } of tables) {
    const { data, error } = await supabase
      .from(table)
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq(column, sanityId)
      .select('id')

    if (error) {
      console.error(`Error deactivating ${table} for deleted Sanity doc ${sanityId}:`, error)
      continue
    }
    if (data && data.length > 0) {
      console.log(`Deactivated ${table} row for deleted Sanity document: ${sanityId}`)
      return
    }
  }

  console.log(`No matching catalog row found for deleted Sanity document: ${sanityId}`)
}

export async function POST(request: NextRequest) {
  try {
    // Initialize Supabase client with service role key for admin operations
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Verify webhook signature
    const signature = request.headers.get('sanity-webhook-signature')
    const body = await request.text()
    
    if (!signature || !verifySignature(body, signature)) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      )
    }

    // Sanity always sends this header regardless of payload shape — relied on here instead of
    // inferring create/update/delete from the body, since a delete event's body may not
    // reliably include every field once the document no longer exists.
    const operation = request.headers.get('sanity-operation')

    if (operation === 'delete') {
      const headerDocumentId = request.headers.get('sanity-document-id')
      let bodyDocumentId: string | null = null
      try {
        bodyDocumentId = JSON.parse(body)?._id ?? null
      } catch {
        // Body may be empty/non-JSON for a delete event — the header is the reliable source.
      }
      const documentId = headerDocumentId ?? bodyDocumentId

      if (!documentId) {
        console.error('Delete event received with no document id in header or body')
        return NextResponse.json({ message: 'No document id on delete event' })
      }
      if (documentId.startsWith('drafts.')) {
        return NextResponse.json({ message: 'Draft delete ignored' })
      }

      await deactivateBySanityId(documentId, supabase)
      return NextResponse.json({ success: true })
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
  const { _id, name, images } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  // Check if service type already exists
  const { data: existing, error: lookupError } = await supabase
    .from('service_types')
    .select('id, stripe_product_id')
    .eq('sanity_service_type_id', _id)
    .single()

  // PGRST116 = "no rows found", the expected case for a new document. Any other error is a
  // real query failure and must not be silently treated as "doesn't exist yet".
  if (lookupError && lookupError.code !== 'PGRST116') {
    throw lookupError
  }

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

    // Keep Stripe's name/image in sync on every republish, not just at creation
    try {
      if (existing.stripe_product_id) {
        await getStripe().products.update(existing.stripe_product_id, {
          name,
          images: thumbnailUrl ? [thumbnailUrl] : [],
        })
        console.log(`Updated Stripe product for service_type: ${existing.stripe_product_id}`)
      } else {
        // Never got a Stripe product at creation (e.g. Stripe was down at the time) —
        // self-heal by creating it now instead of leaving this permanently unsynced.
        const stripeProduct = await getStripe().products.create({
          name,
          images: thumbnailUrl ? [thumbnailUrl] : undefined,
          active: true,
          metadata: { sanity_id: _id, type: 'service_type' },
        })
        await supabase.from('service_types').update({ stripe_product_id: stripeProduct.id }).eq('id', existing.id)
        console.log(`Created Stripe product for service_type (self-healed): ${stripeProduct.id}`)
      }
    } catch (stripeError) {
      console.error('Error syncing Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
  } else {
    // Create new record
    // Note: duration, capacity, booking_type, price, and tiers are Postgres-owned
    // and must be set manually in Retool after initial sync
    const { data, error } = await supabase
      .from('service_types')
      .insert({
        sanity_service_type_id: _id,
        name,
        thumbnail_url: thumbnailUrl,
        active: true
      })
      .select('id')
      .single()

    if (error) throw error
    console.log(`Created service_type: ${_id}`)

    // Create Stripe Product
    try {
      const stripeProduct = await getStripe().products.create({
        name,
        images: thumbnailUrl ? [thumbnailUrl] : undefined,
        active: true,
        metadata: {
          sanity_id: _id,
          type: 'service_type'
        }
      })
      
      await supabase
        .from('service_types')
        .update({ stripe_product_id: stripeProduct.id })
        .eq('id', data.id)
      
      console.log(`Created Stripe product for service_type: ${stripeProduct.id}`)
    } catch (stripeError) {
      console.error('Error creating Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
  }
}

async function handleProduct(payload: any, supabase: any) {
  const { _id, name, category, images } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  const { data: existing, error: lookupError } = await supabase
    .from('products')
    .select('id, stripe_product_id')
    .eq('sanity_product_id', _id)
    .single()

  if (lookupError && lookupError.code !== 'PGRST116') {
    throw lookupError
  }

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

    // Keep Stripe's name/image in sync on every republish, not just at creation
    try {
      if (existing.stripe_product_id) {
        await getStripe().products.update(existing.stripe_product_id, {
          name,
          images: thumbnailUrl ? [thumbnailUrl] : [],
        })
        console.log(`Updated Stripe product for product: ${existing.stripe_product_id}`)
      } else {
        const stripeProduct = await getStripe().products.create({
          name,
          images: thumbnailUrl ? [thumbnailUrl] : undefined,
          active: true,
          metadata: { sanity_id: _id, type: 'product', category: category || '' },
        })
        await supabase.from('products').update({ stripe_product_id: stripeProduct.id }).eq('id', existing.id)
        console.log(`Created Stripe product for product (self-healed): ${stripeProduct.id}`)
      }
    } catch (stripeError) {
      console.error('Error syncing Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
  } else {
    const { data, error } = await supabase
      .from('products')
      .insert({
        sanity_product_id: _id,
        name,
        category,
        thumbnail_url: thumbnailUrl,
        active: true
      })
      .select('id')
      .single()

    if (error) throw error
    console.log(`Created product: ${_id}`)

    // Create Stripe Product
    try {
      const stripeProduct = await getStripe().products.create({
        name,
        images: thumbnailUrl ? [thumbnailUrl] : undefined,
        active: true,
        metadata: {
          sanity_id: _id,
          type: 'product',
          category: category || ''
        }
      })

      await supabase
        .from('products')
        .update({ stripe_product_id: stripeProduct.id })
        .eq('id', data.id)

      console.log(`Created Stripe product for product: ${stripeProduct.id}`)
    } catch (stripeError) {
      console.error('Error creating Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
  }
}

async function handleAddon(payload: any, supabase: any) {
  const { _id, name, category, images } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  const { data: existing, error: lookupError } = await supabase
    .from('addons')
    .select('id, stripe_product_id')
    .eq('sanity_addon_id', _id)
    .single()

  if (lookupError && lookupError.code !== 'PGRST116') {
    throw lookupError
  }

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

    // Keep Stripe's name/image in sync on every republish, not just at creation
    try {
      if (existing.stripe_product_id) {
        await getStripe().products.update(existing.stripe_product_id, {
          name,
          images: thumbnailUrl ? [thumbnailUrl] : [],
        })
        console.log(`Updated Stripe product for addon: ${existing.stripe_product_id}`)
      } else {
        const stripeProduct = await getStripe().products.create({
          name,
          images: thumbnailUrl ? [thumbnailUrl] : undefined,
          active: true,
          metadata: { sanity_id: _id, type: 'addon', category: category || '' },
        })
        await supabase.from('addons').update({ stripe_product_id: stripeProduct.id }).eq('id', existing.id)
        console.log(`Created Stripe product for addon (self-healed): ${stripeProduct.id}`)
      }
    } catch (stripeError) {
      console.error('Error syncing Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
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

    // Create Stripe Product
    try {
      const stripeProduct = await getStripe().products.create({
        name,
        images: thumbnailUrl ? [thumbnailUrl] : undefined,
        active: true,
        metadata: {
          sanity_id: _id,
          type: 'addon',
          category: category || ''
        }
      })

      await supabase
        .from('addons')
        .update({ stripe_product_id: stripeProduct.id })
        .eq('id', data.id)

      console.log(`Created Stripe product for addon: ${stripeProduct.id}`)
    } catch (stripeError) {
      console.error('Error creating Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
  }
}

async function handleMembershipPlan(payload: any, supabase: any) {
  const { _id, name, images } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  const { data: existing, error: lookupError } = await supabase
    .from('membership_plans')
    .select('id, stripe_product_id')
    .eq('sanity_plan_id', _id)
    .single()

  if (lookupError && lookupError.code !== 'PGRST116') {
    throw lookupError
  }

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

    // Keep Stripe's name/image in sync on every republish, not just at creation
    try {
      if (existing.stripe_product_id) {
        await getStripe().products.update(existing.stripe_product_id, {
          name,
          images: thumbnailUrl ? [thumbnailUrl] : [],
        })
        console.log(`Updated Stripe product for membership_plan: ${existing.stripe_product_id}`)
      } else {
        const stripeProduct = await getStripe().products.create({
          name,
          images: thumbnailUrl ? [thumbnailUrl] : undefined,
          active: true,
          metadata: { sanity_id: _id, type: 'membership_plan' },
        })
        await supabase.from('membership_plans').update({ stripe_product_id: stripeProduct.id }).eq('id', existing.id)
        console.log(`Created Stripe product for membership_plan (self-healed): ${stripeProduct.id}`)
      }
    } catch (stripeError) {
      console.error('Error syncing Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
  } else {
    const { data, error } = await supabase
      .from('membership_plans')
      .insert({
        sanity_plan_id: _id,
        name,
        thumbnail_url: thumbnailUrl,
        active: true
      })
      .select('id')
      .single()

    if (error) throw error
    console.log(`Created membership_plan: ${_id}`)

    // Create Stripe Product
    try {
      const stripeProduct = await getStripe().products.create({
        name,
        images: thumbnailUrl ? [thumbnailUrl] : undefined,
        active: true,
        metadata: {
          sanity_id: _id,
          type: 'membership_plan'
        }
      })

      await supabase
        .from('membership_plans')
        .update({ stripe_product_id: stripeProduct.id })
        .eq('id', data.id)

      console.log(`Created Stripe product for membership_plan: ${stripeProduct.id}`)
    } catch (stripeError) {
      console.error('Error creating Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
  }
}

async function handleSessionPassType(payload: any, supabase: any) {
  const { _id, name, images } = payload
  
  const thumbnailUrl = images?.[0] ? getThumbnailUrl(images[0]) : null

  const { data: existing, error: lookupError } = await supabase
    .from('session_pass_types')
    .select('id, stripe_product_id')
    .eq('sanity_pass_type_id', _id)
    .single()

  if (lookupError && lookupError.code !== 'PGRST116') {
    throw lookupError
  }

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

    // Keep Stripe's name/image in sync on every republish, not just at creation
    try {
      if (existing.stripe_product_id) {
        await getStripe().products.update(existing.stripe_product_id, {
          name,
          images: thumbnailUrl ? [thumbnailUrl] : [],
        })
        console.log(`Updated Stripe product for session_pass_type: ${existing.stripe_product_id}`)
      } else {
        const stripeProduct = await getStripe().products.create({
          name,
          images: thumbnailUrl ? [thumbnailUrl] : undefined,
          active: true,
          metadata: { sanity_id: _id, type: 'session_pass_type' },
        })
        await supabase.from('session_pass_types').update({ stripe_product_id: stripeProduct.id }).eq('id', existing.id)
        console.log(`Created Stripe product for session_pass_type (self-healed): ${stripeProduct.id}`)
      }
    } catch (stripeError) {
      console.error('Error syncing Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
  } else {
    const { data, error } = await supabase
      .from('session_pass_types')
      .insert({
        sanity_pass_type_id: _id,
        name,
        thumbnail_url: thumbnailUrl,
        active: true
      })
      .select('id')
      .single()

    if (error) throw error
    console.log(`Created session_pass_type: ${_id}`)

    // Create Stripe Product
    try {
      const stripeProduct = await getStripe().products.create({
        name,
        images: thumbnailUrl ? [thumbnailUrl] : undefined,
        active: true,
        metadata: {
          sanity_id: _id,
          type: 'session_pass_type'
        }
      })

      await supabase
        .from('session_pass_types')
        .update({ stripe_product_id: stripeProduct.id })
        .eq('id', data.id)

      console.log(`Created Stripe product for session_pass_type: ${stripeProduct.id}`)
    } catch (stripeError) {
      console.error('Error creating Stripe product:', stripeError)
      // Don't fail the whole operation if Stripe fails
    }
  }
}
