import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPAREL, describePlan, galleryItem, planContentMoves, type MovedDocument } from '../../../studio/lib/contentMovesW72a'

// Brief W72a item 5: the one-off content moves (studio/scripts/w72a-content-moves.ts), as the plan it works out
// before it changes anything (studio/lib/contentMovesW72a.ts). Live content on 24 Nov 2026: one product (Paddock
// T-Shirt, category "apparel", `images`), one gift card (`images`), no event, no category.

const image = (name: string, alt: string, extra: Record<string, unknown> = {}) => ({ _key: `k-${name}`, _type: 'image', asset: { _type: 'reference', _ref: `image-${name}-800x600-jpg` }, alt, ...extra })
const TEE: MovedDocument = { _id: 'tee', _type: 'product', name: 'Paddock T-Shirt', category: 'apparel', images: [image('front', 'The front'), image('back', 'The back', { hotspot: { x: 0.5, y: 0.4 }, crop: { top: 0.1 } })] }
const GIFT: MovedDocument = { _id: 'gift', _type: 'giftCardType', name: 'The Paddock Gift Card', images: [image('card', 'A gift card')] }
const LIVE = [TEE, GIFT]

/** The documents as they are once a plan has been written. */
function after(documents: readonly MovedDocument[], unsetImages = false): MovedDocument[] {
  const plan = planContentMoves(documents, { unsetImages })
  const moved = documents.map((document) => {
    const patch = plan.patches.find((one) => one.id === document._id)
    if (!patch) return document
    const next: Record<string, unknown> = { ...document, ...patch.set }
    for (const field of patch.unset) delete next[field]
    return next as unknown as MovedDocument
  })
  return plan.create ? [...moved, plan.create] : moved
}

describe('the plan for the live content', () => {
  const plan = planContentMoves(LIVE)

  it('makes the Apparel category, points the T-Shirt at it, and copies both documents\' images into their galleries (the gift card\'s Physical one)', () => {
    expect(plan.create).toEqual({ _id: 'productCategory-apparel', _type: 'productCategory', title: 'Apparel', slug: { _type: 'slug', current: 'apparel' }, order: 1 })
    expect(plan.patches.map((patch) => [patch.id, Object.keys(patch.set), patch.unset])).toEqual([
      ['tee', ['category', 'gallery'], []],
      ['gift', ['physicalGallery'], []],
    ])
    expect(plan.patches[0]?.set.category).toEqual({ _type: 'reference', _ref: 'productCategory-apparel' })
    expect(plan.notes).toEqual([])
  })

  it('each image becomes a picture in the gallery: the same file, alt text, crop and hotspot, in the same order', () => {
    expect(plan.patches[0]?.set.gallery).toEqual([
      { _type: 'media', _key: 'k-front', kind: 'image', image: { _type: 'picture', asset: { _type: 'reference', _ref: 'image-front-800x600-jpg' }, alt: 'The front' } },
      { _type: 'media', _key: 'k-back', kind: 'image', image: { _type: 'picture', asset: { _type: 'reference', _ref: 'image-back-800x600-jpg' }, alt: 'The back', crop: { top: 0.1 }, hotspot: { x: 0.5, y: 0.4 } } },
    ])
    expect(plan.patches[1]?.set.physicalGallery).toEqual([{ _type: 'media', _key: 'k-card', kind: 'image', image: { _type: 'picture', asset: { _type: 'reference', _ref: 'image-card-800x600-jpg' }, alt: 'A gift card' } }])
    // An image saved with no key gets one.
    expect(galleryItem({ asset: { _ref: 'image-x-1x1-jpg' } }, 3)).toMatchObject({ _key: 'w72a3', kind: 'image' })
  })

  it('it is copied, not moved: the old `images` stay unless asked to go, and then only once they are in the gallery', () => {
    expect(plan.patches.every((patch) => patch.unset.length === 0)).toBe(true)
    const asked = planContentMoves(LIVE, { unsetImages: true })
    expect(asked.patches.map((patch) => [patch.id, patch.unset])).toEqual([
      ['tee', ['images']],
      ['gift', ['images']],
    ])
    // A later run that asks: only the old field goes; the gallery made before is not written again.
    const later = planContentMoves(after(LIVE), { unsetImages: true })
    expect(later.create).toBeNull()
    expect(later.patches.map((patch) => [patch.id, patch.set, patch.unset])).toEqual([
      ['tee', {}, ['images']],
      ['gift', {}, ['images']],
    ])
  })

  it('what it prints before changing anything names every change', () => {
    expect(describePlan(plan)).toEqual([
      'CREATE productCategory productCategory-apparel: title "Apparel", slug "apparel", order 1',
      'PATCH product "Paddock T-Shirt" (tee)',
      '  - category: the word "apparel" becomes a reference to the Apparel category (productCategory-apparel)',
      '  - gallery: 2 image(s) copied from `images`, in order (image-front-800x600-jpg, image-back-800x600-jpg)',
      'PATCH giftCardType "The Paddock Gift Card" (gift)',
      '  - physicalGallery: 1 image(s) copied from `images`, in order (image-card-800x600-jpg)',
    ])
  })
})

describe('run again, or on content that has moved on', () => {
  it('a second run changes nothing, with the old images kept or taken off', () => {
    for (const unset of [false, true]) {
      const again = planContentMoves(after(LIVE, unset), { unsetImages: unset })
      expect([again.create, again.patches], String(unset)).toEqual([null, []])
      expect(describePlan(again)[0]).toBe('Nothing to change: every document has been moved already.')
    }
  })

  it('an Apparel category that is there already (by its slug or its title) is the one used, and none is made; a draft of one is not', () => {
    for (const existing of [
      { _id: 'cat-1', _type: 'productCategory', title: 'Clothing', slug: { current: 'apparel' } },
      { _id: 'cat-2', _type: 'productCategory', title: ' apparel ', slug: { current: 'clothes' } },
    ]) {
      const plan = planContentMoves([...LIVE, existing])
      expect(plan.create).toBeNull()
      expect(plan.patches[0]?.set.category).toEqual({ _type: 'reference', _ref: existing._id })
    }
    const draftOnly = planContentMoves([...LIVE, { _id: 'drafts.cat-3', _type: 'productCategory', title: 'Apparel', slug: { current: 'apparel' } }])
    expect(draftOnly.create).toEqual(APPAREL)
    expect(draftOnly.patches[0]?.set.category).toEqual({ _type: 'reference', _ref: APPAREL._id })
  })

  it('a draft is moved with its published document, each from what it holds itself', () => {
    const draft: MovedDocument = { ...TEE, _id: 'drafts.tee', name: 'Paddock Tee', images: [image('new', 'A new front')] }
    const plan = planContentMoves([TEE, draft])
    expect(plan.patches.map((patch) => patch.id)).toEqual(['tee', 'drafts.tee'])
    expect((plan.patches[1]?.set.gallery as Array<{ _key: string }>).map((item) => item._key)).toEqual(['k-new'])
    expect(plan.patches[1]?.set.category).toEqual({ _type: 'reference', _ref: APPAREL._id })
    // A draft that needs nothing is said, not changed.
    const moved = planContentMoves([TEE, { _id: 'drafts.tee', _type: 'product', name: 'Paddock T-Shirt', category: { _type: 'reference', _ref: 'x' }, gallery: [{}] }])
    expect(moved.patches.map((patch) => patch.id)).toEqual(['tee'])
    expect(moved.notes).toEqual(['product "Paddock T-Shirt" (tee): drafts.tee exists and needs none of these changes.'])
  })

  it('a gallery that already has something in it is never written over; another old word is left for a person; an image with no file is not copied', () => {
    const filled: MovedDocument = { ...TEE, gallery: [{ _type: 'media', _key: 'own', kind: 'image' }] }
    const plan = planContentMoves([filled, { _id: 'cap', _type: 'product', name: 'Cap', category: 'accessories', images: [image('cap', 'A cap'), { _key: 'empty' }] }])
    expect(plan.patches.map((patch) => [patch.id, Object.keys(patch.set)])).toEqual([
      ['tee', ['category']],
      ['cap', ['gallery']],
    ])
    expect((plan.patches[1]?.set.gallery as unknown[]).length).toBe(1)
    expect(plan.notes).toEqual([
      'product "Paddock T-Shirt" (tee): it has 2 old image(s) and its gallery already has 1 item(s). The gallery is left as it is.',
      'product "Cap" (cap): its category is the word "accessories", which this script makes no category for. Left as it is: pick its category in the Studio.',
      'product "Cap" (cap): 1 old image(s) with no file were not copied.',
    ])
    // No category is made when no product needs it.
    expect(planContentMoves([GIFT]).create).toBeNull()
  })

  it('an event is moved as a product is; the other types, and their `images`, are never touched', () => {
    const plan = planContentMoves([
      { _id: 'event', _type: 'event', name: 'Solstice', images: [image('fire', 'A fire')] },
      { _id: 'addon', _type: 'addon', name: 'Towel', category: 'amenities', images: [image('towel', 'A towel')] },
      { _id: 'plan', _type: 'membershipPlan', name: 'Core', images: [image('plan', 'A plan')] },
    ])
    expect(plan.patches.map((patch) => [patch.id, Object.keys(patch.set)])).toEqual([['event', ['gallery']]])
    expect([plan.create, plan.notes]).toEqual([null, []])
  })
})

describe('the script', () => {
  const script = readFileSync(path.resolve(__dirname, '../../../studio/scripts/w72a-content-moves.ts'), 'utf8')

  it('prints the plan first, and changes nothing unless it is run with --write: the dry run ends before any transaction is made', () => {
    expect(script).toContain("const write = process.argv.includes('--write')")
    const printed = script.indexOf('for (const line of describePlan(plan)) console.log(line)')
    const stopped = script.indexOf('if (!write) {')
    const made = script.indexOf('client.transaction()')
    expect(printed).toBeGreaterThan(0)
    expect(stopped).toBeGreaterThan(printed)
    expect(made).toBeGreaterThan(stopped)
    expect(script.slice(stopped, made)).toContain('return')
    // One transaction, and no other write anywhere in it.
    expect(script.match(/\.commit\(\)/g)).toHaveLength(1)
    expect(script).not.toMatch(/\.(create|createOrReplace|delete)\(|client\.patch\(/)
  })

  it('reads every version (a draft is moved with its document), straight from the dataset', () => {
    expect(script).toContain("withConfig({perspective: 'raw', useCdn: false})")
  })
})
