import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createImageUrlBuilder } from '@sanity/image-url'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { syncSanityDocument, takeSanityDocumentOffSale, type SanityKind, type SanityMirror, type SanityOptions } from '@/server/rules/catalog/sanity-sync'
import { createStripeClient } from '@/server/stripe/client'

// W66 (H-plan 4.3, H7; Q57): every write on the Worker's own database connection (server/rules/catalog/sanity-sync.ts),
// where it was Supabase's client with the service-role key. The signature check first; then one transaction per
// document. A new item arrives off sale; no Stripe product is made or renamed for anything but a membership plan; a
// delete takes the item off sale with an audit row by the system as `sanity`.
// W66a (W66 review F7): the signature must be no older than 5 minutes, so a signed delete someone captured can't be
// sent again later, and it is compared in constant time.

/** W59 (W45 audit row 3): an image field as this route reads it (the builder takes its asset reference). */
interface SanityImage {
  asset?: { _ref?: string }
}
/**
 * W59 (W45 audit row 3): the fields of a Sanity document this route reads (no generated Sanity types here). Each
 * handler destructures these; anything else on the document is never read.
 */
interface SanityDocument {
  _id: string
  _type?: string
  _rev?: string
  name: string
  category?: string | null
  images?: SanityImage[]
  extraWaiver?: unknown
}

const imageBuilder = createImageUrlBuilder({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
})

/** W66a (F7): how old a signature may be. Sanity sends a failed delivery again twice, 30 seconds apart (its docs, 23 Nov 2026). */
const SIGNATURE_LIFE_MS = 5 * 60 * 1000

/**
 * When Sanity signed it, in milliseconds, or null when `t=` isn't a whole number. Sanity's is in milliseconds; a number
 * too small to be one (before 1973) is read as seconds, as Stripe's scheme, which Sanity's follows, writes it. `t` is
 * part of what is signed, so nobody without the secret chooses it.
 */
function signedAtMs(timestamp: string): number | null {
  if (!/^\d{1,16}$/.test(timestamp)) return null
  const t = Number(timestamp)
  return t < 100_000_000_000 ? t * 1000 : t
}

/** Whether two texts are the same, in a time that doesn't say where they differ. Only their length shows. */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
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

  const timestamp = timestampPart.slice('t='.length)
  const receivedHash = hashPart.slice('v1='.length)
  const signedAt = signedAtMs(timestamp)
  if (signedAt === null) {
    console.error('Invalid signature format')
    return false
  }

  // Create HMAC with timestamp and body
  const signedPayload = `${timestamp}.${body}`
  const computedHash = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  if (!sameText(computedHash, receivedHash)) return false
  if (Date.now() - signedAt > SIGNATURE_LIFE_MS) {
    console.error('Sanity webhook signature refused: signed more than 5 minutes ago')
    return false
  }
  return true
}

// Extract thumbnail URL from a Sanity image object, resized to 80px wide (height scales
// proportionally, no crop). Uses the actual @sanity/image-url builder rather than hand-parsing
// the asset reference string — the builder correctly reads the real dimensions Sanity bakes
// into the asset filename, which a manually constructed URL was missing entirely.
function getThumbnailUrl(image: SanityImage | null | undefined): string | null {
  if (!image || !image.asset || !image.asset._ref) return null
  return imageBuilder.image(image).width(80).url()
}

/** The Sanity document types with a row here; any other (page, blogPost, galleryImage) is ignored. */
const CATALOG_TYPES: ReadonlySet<string> = new Set<SanityKind>(['serviceType', 'product', 'addon', 'membershipPlan', 'sessionPassType', 'giftCardType', 'event'])

/**
 * The row's fields from the document. A product's or add-on's category only when the document has the field, so a
 * document without one leaves the row's as it is (as the client's update did). Events: whether there is an extra
 * waiver, with a short fingerprint of its text as the version, so a changed waiver is a new version for attendees who
 * accept it later.
 */
function mirrorOf(kind: SanityKind, payload: SanityDocument): SanityMirror {
  const thumbnailUrl = payload.images?.[0] ? getThumbnailUrl(payload.images[0]) : null
  const mirror: SanityMirror = { name: payload.name, thumbnailUrl }
  if ((kind === 'product' || kind === 'addon') && 'category' in payload) mirror.category = payload.category ?? null
  if (kind === 'event') {
    const waiverText = typeof payload.extraWaiver === 'string' ? payload.extraWaiver.trim() : ''
    mirror.hasExtraWaiver = waiverText.length > 0
    mirror.extraWaiverVersion = waiverText.length > 0 ? crypto.createHash('sha256').update(waiverText).digest('hex').slice(0, 12) : null
  }
  return mirror
}

export async function POST(request: NextRequest) {
  try {
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
    const options: SanityOptions = { requestId: crypto.randomUUID(), stripe: () => createStripeClient() }

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

      // Per 07-write-architecture.md: Sanity-side deletion always means "off sale", never a raw table delete.
      const db = openRequestDb()
      try {
        const deleted = await takeSanityDocumentOffSale(db, documentId, options)
        if (!deleted.found) console.log(`No matching catalog row found for deleted Sanity document: ${documentId}`)
        else if ('refused' in deleted) return NextResponse.json({ success: true, kept: deleted.refused })
        else console.log(`Took ${deleted.entity} ${deleted.id} off sale for deleted Sanity document: ${documentId}`)
      } finally {
        await closeRequestDb(db)
      }
      return NextResponse.json({ success: true })
    }

    const payload = JSON.parse(body) as SanityDocument
    const { _type, _id } = payload

    // Only process published documents (drafts have _id starting with 'drafts.')
    if (_id.startsWith('drafts.')) {
      return NextResponse.json({ message: 'Draft ignored' })
    }

    if (!_type || !CATALOG_TYPES.has(_type)) {
      // Ignore non-catalog types (page, blogPost, galleryImage)
      return NextResponse.json({ message: 'Non-catalog type ignored' })
    }
    const kind = _type as SanityKind

    console.log(`Processing ${_type} webhook for ${_id}`)
    const db = openRequestDb()
    try {
      const synced = await syncSanityDocument(db, kind, _id, mirrorOf(kind, payload), options)
      console.log(`${synced.created ? 'Created' : 'Updated'} ${kind}: ${_id}${synced.planProduct ? ` (Stripe product ${synced.planProduct})` : ''}`)
    } finally {
      await closeRequestDb(db)
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
