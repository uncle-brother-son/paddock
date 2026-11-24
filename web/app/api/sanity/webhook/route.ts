import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createImageUrlBuilder } from '@sanity/image-url'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { syncSanityCategory, syncSanityDocument, takeSanityDocumentOffSale, type SanityKind, type SanityMirror, type SanityOptions } from '@/server/rules/catalog/sanity-sync'
import { createStripeClient } from '@/server/stripe/client'

// W66 (H-plan 4.3, H7; Q57): every write on the Worker's own database connection (server/rules/catalog/sanity-sync.ts),
// where it was Supabase's client with the service-role key. The signature check first; then one transaction per
// document. A new item arrives off sale; no Stripe product is made or renamed for anything but a membership plan; a
// delete takes the item off sale with an audit row by the system as `sanity`.
// W66a (W66 review F7): the signature must be no older than 5 minutes, so a signed delete someone captured can't be
// sent again later, and it is compared in constant time.
// W70a (the W70 audit's L1): a delete acts on the signed body's `_id` alone. Sanity's headers aren't signed, so a
// `sanity-document-id` that names another document is refused (400), and so is a delete whose body names none.
// W72a (WQ7, WQ15, WQ19; the lead's design, 24 Nov 2026): a product category is a document of its own with a row of its
// own, and a product's row holds its category's id (the reference's `_ref`: the projection is empty, so no title ever
// comes with it). A product's, an event's and the gift card's pictures are galleries of the Studio's `media` block (a
// picture, or a video): the staff app's picture is the first PICTURE in the gallery, videos skipped; a gallery with
// none gives no picture, never an error. The gift card has two galleries: the physical one's first picture, else the
// digital one's. The other four types keep `images`, as before.

/** W59 (W45 audit row 3): an image field as this route reads it (the builder takes its asset reference). */
interface SanityImage {
  asset?: { _ref?: string }
}
/** W72a: a gallery's item as this route reads it (the Studio's `media` block). A video's poster and file are never read. */
interface SanityMedia {
  kind?: string
  image?: SanityImage
}
/**
 * W59 (W45 audit row 3): the fields of a Sanity document this route reads (no generated Sanity types here). Each
 * handler destructures these; anything else on the document is never read. W72a: `category` is a word on an add-on
 * and a reference on a product; `title` and `order` are a category's own.
 */
interface SanityDocument {
  _id: string
  _type?: string
  _rev?: string
  name: string
  category?: unknown
  images?: SanityImage[]
  gallery?: unknown
  digitalGallery?: unknown
  physicalGallery?: unknown
  extraWaiver?: unknown
  title: string
  order?: unknown
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

/**
 * The Sanity document types with an item's row here. A product category (below) has a row of another kind; any other
 * type (a content page, an info page, a blog post, a family, a size guide, the settings) is ignored.
 */
const CATALOG_TYPES: ReadonlySet<string> = new Set<SanityKind>(['serviceType', 'product', 'addon', 'membershipPlan', 'sessionPassType', 'giftCardType', 'event'])
/** W72a: the document type of a product category (its row: product_categories). */
const CATEGORY_TYPE = 'productCategory'

/**
 * W72a: the first picture in a gallery, or null. A video is skipped whatever else it carries (the Studio keeps a
 * picture someone added before switching the item to a video), and so is an item with no picture file. Anything that
 * isn't a gallery (the field missing, or not a list) has no picture: never an error.
 */
function firstPicture(gallery: unknown): SanityImage | null {
  if (!Array.isArray(gallery)) return null
  for (const item of gallery as Array<SanityMedia | null>) {
    if (item === null || typeof item !== 'object' || item.kind === 'video') continue
    if (item.image?.asset?._ref) return item.image
  }
  return null
}

/** The picture the staff app shows for a document, as the row's `thumbnail_url`. */
function thumbnailOf(kind: SanityKind, payload: SanityDocument): string | null {
  if (kind === 'product' || kind === 'event') return getThumbnailUrl(firstPicture(payload.gallery))
  if (kind === 'giftCardType') return getThumbnailUrl(firstPicture(payload.physicalGallery) ?? firstPicture(payload.digitalGallery))
  return payload.images?.[0] ? getThumbnailUrl(payload.images[0]) : null
}

/**
 * W72a: the id of the category a product points to (its reference's `_ref`), or null when the field is there and
 * empty. Undefined for anything else, which is then not written: a word from before categories were documents
 * (`"apparel"`) leaves the row's category as it is, so a word or a title is never stored where an id belongs.
 */
function categoryIdOf(category: unknown): string | null | undefined {
  if (category === null) return null
  if (typeof category !== 'object') return undefined
  const ref = (category as { _ref?: unknown })._ref
  return typeof ref === 'string' && ref !== '' ? ref : undefined
}

/** A category's Order as its row holds it: a whole number an integer column takes, or none. */
function sortOrderOf(order: unknown): number | null {
  return typeof order === 'number' && Number.isInteger(order) && Math.abs(order) <= 2_147_483_647 ? order : null
}

/**
 * The row's fields from the document. A product's or add-on's category only when the document has the field, so a
 * document without one leaves the row's as it is (as the client's update did). Events: whether there is an extra
 * waiver, with a short fingerprint of its text as the version, so a changed waiver is a new version for attendees who
 * accept it later.
 */
function mirrorOf(kind: SanityKind, payload: SanityDocument): SanityMirror {
  const mirror: SanityMirror = { name: payload.name, thumbnailUrl: thumbnailOf(kind, payload) }
  if (kind === 'addon' && 'category' in payload) mirror.category = typeof payload.category === 'string' ? payload.category : null
  if (kind === 'product' && 'category' in payload) {
    const categoryId = categoryIdOf(payload.category)
    if (categoryId !== undefined) mirror.category = categoryId
  }
  if (kind === 'event') {
    const waiverText = typeof payload.extraWaiver === 'string' ? payload.extraWaiver.trim() : ''
    mirror.hasExtraWaiver = waiverText.length > 0
    mirror.extraWaiverVersion = waiverText.length > 0 ? crypto.createHash('sha256').update(waiverText).digest('hex').slice(0, 12) : null
  }
  return mirror
}

/** The document id in a signed body, or null when it isn't JSON or names none. */
function signedDocumentId(body: string): string | null {
  try {
    const id: unknown = (JSON.parse(body) as { _id?: unknown } | null)?._id
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
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

    // Sanity always sends this header, and nothing in the body says which of the three it is (the projection is the
    // document itself). It isn't signed: W70a (L1), so a delete takes its document's id from the signed body only.
    const operation = request.headers.get('sanity-operation')
    const options: SanityOptions = { requestId: crypto.randomUUID(), stripe: () => createStripeClient() }

    if (operation === 'delete') {
      // W70a (L1): the document named in what Sanity signed. A 400 is never sent again (Sanity's docs) and shows in its
      // attempts log, so an id that isn't in the body is seen there, not passed over with a 200.
      const documentId = signedDocumentId(body)
      if (!documentId) {
        console.error('Sanity delete refused: its signed body names no document')
        return NextResponse.json({ error: 'No document id in the signed body' }, { status: 400 })
      }
      const headerDocumentId = request.headers.get('sanity-document-id')
      if (headerDocumentId !== null && headerDocumentId !== documentId) {
        console.error(`Sanity delete refused: its signed body names ${documentId}, its header another document`)
        return NextResponse.json({ error: 'Document id mismatch' }, { status: 400 })
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
        else if ('category' in deleted) {
          // W72a: a category some product row still names keeps its row, and the delivery's answer and the log say why.
          if (deleted.category === 'in_use') {
            console.error(`Sanity deleted product category ${documentId}, but its row is kept: ${deleted.products} product row(s) still name it. Publish those products again in Sanity (with their new category), then delete the category again.`)
            return NextResponse.json({ success: true, kept: 'category_in_use', products: deleted.products })
          }
          console.log(`Deleted the row of product category ${documentId}: its Sanity document was deleted and no product names it`)
        } else console.log(`Took ${deleted.entity} ${deleted.id} off sale for deleted Sanity document: ${documentId}`)
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

    if (_type === CATEGORY_TYPE) {
      // W72a: a product category's own row. No product row is written: each holds the category's id.
      console.log(`Processing ${_type} webhook for ${_id}`)
      const db = openRequestDb()
      try {
        const synced = await syncSanityCategory(db, _id, { title: payload.title, sortOrder: sortOrderOf(payload.order) })
        console.log(`${synced.created ? 'Created' : 'Updated'} product category: ${_id}`)
      } finally {
        await closeRequestDb(db)
      }
      return NextResponse.json({ success: true })
    }

    if (!_type || !CATALOG_TYPES.has(_type)) {
      // Ignore the types with no row here (pages, blog posts, families, size guides, settings)
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
