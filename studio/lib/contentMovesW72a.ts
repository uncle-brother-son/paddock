// Brief W72a item 5: the one-off content moves, as a plan worked out from the documents and nothing else. No Sanity
// import here, so web/lib/sanity/content-moves.test.ts can test it; scripts/w72a-content-moves.ts reads the
// documents, prints this plan, and writes it only when asked to.
//
// The moves: an "Apparel" category is made (if there is none); each product whose category is still the word
// "apparel" is pointed at it; and the old `images` of each product, event and gift card are copied into its gallery
// (the gift card's Physical gallery). A document that has already been moved is left alone, so the plan of a second
// run is empty. A document's draft is moved with it, or the next publish of the draft would undo the move.

export interface OldImage {
  _key?: string
  _type?: string
  asset?: { _type?: string; _ref?: string }
  alt?: string
  crop?: unknown
  hotspot?: unknown
}

export interface MovedDocument {
  _id: string
  _type: string
  name?: string
  title?: string
  slug?: { current?: string }
  category?: unknown
  images?: OldImage[]
  gallery?: unknown[]
  physicalGallery?: unknown[]
}

export interface CategoryToMake {
  _id: string
  _type: 'productCategory'
  title: string
  slug: { _type: 'slug'; current: string }
  order: number
}

export interface PlannedPatch {
  id: string
  /** What the document is, for the print-out. */
  label: string
  set: Record<string, unknown>
  unset: string[]
  /** One line per change, in words. */
  says: string[]
}

export interface ContentMovesPlan {
  /** The category to make, or null when one is there already (or nothing needs it). */
  create: CategoryToMake | null
  patches: PlannedPatch[]
  /** What was seen and left as it is, and why. */
  notes: string[]
}

/** The word the old Studio stored for the one category live content uses, and the category it becomes. */
export const OLD_WORD = 'apparel'
export const APPAREL: CategoryToMake = { _id: 'productCategory-apparel', _type: 'productCategory', title: 'Apparel', slug: { _type: 'slug', current: 'apparel' }, order: 1 }

/** The field each type's old `images` are copied into. */
const GALLERY_FIELD: Record<string, 'gallery' | 'physicalGallery'> = { product: 'gallery', event: 'gallery', giftCardType: 'physicalGallery' }

const publishedId = (id: string): string => id.replace(/^drafts\./, '')
const isDraft = (id: string): boolean => id.startsWith('drafts.')

/** An old image as a gallery item: the same file, alt text, crop and hotspot, as the Studio's `media` block saves a picture. */
export function galleryItem(image: OldImage, index: number): Record<string, unknown> {
  const picture: Record<string, unknown> = { _type: 'picture', asset: image.asset }
  if (image.alt !== undefined) picture.alt = image.alt
  if (image.crop !== undefined) picture.crop = image.crop
  if (image.hotspot !== undefined) picture.hotspot = image.hotspot
  return { _type: 'media', _key: image._key ?? `w72a${index}`, kind: 'image', image: picture }
}

/**
 * The plan. `documents`: every product, event, gift card and product category, drafts included (the raw
 * perspective). `unsetImages`: also take the old `images` field off each document once it is copied.
 */
export function planContentMoves(documents: readonly MovedDocument[], { unsetImages = false }: { unsetImages?: boolean } = {}): ContentMovesPlan {
  const notes: string[] = []
  const patches: PlannedPatch[] = []
  const label = (document: MovedDocument) => `${document._type} "${document.name ?? document.title ?? '(no name)'}" (${document._id})`

  // The category: a published one whose slug or title is Apparel's, else the one this plan makes.
  const categories = documents.filter((document) => document._type === 'productCategory' && !isDraft(document._id))
  const existing = categories.find((category) => category.slug?.current === APPAREL.slug.current || category.title?.trim().toLowerCase() === APPAREL.title.toLowerCase())
  const categoryId = existing?._id ?? APPAREL._id
  let needsCategory = false

  for (const document of documents) {
    const field = GALLERY_FIELD[document._type]
    if (!field) continue
    const set: Record<string, unknown> = {}
    const unset: string[] = []
    const says: string[] = []

    if (document._type === 'product') {
      if (document.category === OLD_WORD) {
        set.category = { _type: 'reference', _ref: categoryId }
        says.push(`category: the word "${OLD_WORD}" becomes a reference to the Apparel category (${categoryId})`)
        needsCategory = true
      } else if (typeof document.category === 'string') {
        notes.push(`${label(document)}: its category is the word "${document.category}", which this script makes no category for. Left as it is: pick its category in the Studio.`)
      }
    }

    const images = Array.isArray(document.images) ? document.images : []
    const withFile = images.filter((image) => Boolean(image?.asset?._ref))
    const current = document[field]
    if (images.length > 0 && Array.isArray(current) && current.length > 0) {
      notes.push(`${label(document)}: it has ${images.length} old image(s) and its ${field} already has ${current.length} item(s). The ${field} is left as it is.`)
    } else if (withFile.length > 0) {
      set[field] = withFile.map(galleryItem)
      says.push(`${field}: ${withFile.length} image(s) copied from \`images\`, in order (${withFile.map((image) => image.asset?._ref).join(', ')})`)
      if (withFile.length < images.length) notes.push(`${label(document)}: ${images.length - withFile.length} old image(s) with no file were not copied.`)
    }
    // The old field goes only once its pictures are in the gallery (now, or on an earlier run).
    const copied = field in set || (Array.isArray(current) && current.length > 0)
    if (unsetImages && document.images !== undefined && (copied || images.length === 0)) {
      unset.push('images')
      says.push('images: the old field is taken off')
    }

    if (says.length > 0) patches.push({ id: document._id, label: label(document), set, unset, says })
  }

  // A product's draft and its published document move together, each from what it holds itself.
  const moved = new Set(patches.map((patch) => patch.id))
  for (const patch of patches) {
    const other = isDraft(patch.id) ? publishedId(patch.id) : `drafts.${patch.id}`
    const there = documents.some((document) => document._id === other)
    if (there && !moved.has(other)) notes.push(`${patch.label}: ${other} exists and needs none of these changes.`)
  }

  return { create: needsCategory && !existing ? APPAREL : null, patches, notes }
}

/** The plan in words, as the script prints it before anything is changed. */
export function describePlan(plan: ContentMovesPlan): string[] {
  const lines: string[] = []
  if (plan.create) lines.push(`CREATE ${plan.create._type} ${plan.create._id}: title "${plan.create.title}", slug "${plan.create.slug.current}", order ${plan.create.order}`)
  for (const patch of plan.patches) {
    lines.push(`PATCH ${patch.label}`)
    for (const line of patch.says) lines.push(`  - ${line}`)
  }
  if (!plan.create && plan.patches.length === 0) lines.push('Nothing to change: every document has been moved already.')
  for (const note of plan.notes) lines.push(`NOTE ${note}`)
  return lines
}
