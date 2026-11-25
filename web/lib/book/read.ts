import { connection } from 'next/server'
import { cache } from 'react'

import { sizedImage } from '@/lib/sanity/image'
import { readSanity } from '@/lib/sanity/read'
import type { AddonPictures } from '@/lib/sanity/schemas'
import { readShopAddonsKept, type ShopAddon } from '@/lib/shop/read'

import type { BookAddOn } from './book'

// W77: the Book panel's add-ons, read with the frame because the panel opens over every page. Which are on sale,
// their names and what a visitor pays are the Worker's (W77a's `readShopAddons()`, through lib/shop/read.ts, at most a
// minute old); each one's picture is its Sanity document's first image. The panel's days, sessions and group prices
// are asked by the browser when it opens (lib/book/api.ts).

/** An add-on card's picture is 4 by 5 (Figma "AddOnCard", 845:16651). */
const CARD_RATIO = 4 / 5
/** A card is a third of the add-ons column: about 224px on a desktop and 109px on a phone. */
const CARD_WIDTHS = [120, 240, 360, 480, 720] as const

/** W77a's add-ons, in its order, each with its picture when Sanity has one. */
export function bookAddOns(onSale: readonly ShopAddon[], pictures: AddonPictures): BookAddOn[] {
  const pictureOf = new Map(pictures.map(({ id, picture }) => [id, picture]))
  return onSale.map(({ sanityId, name, price }) => {
    const picture = pictureOf.get(sanityId) ?? null
    return { id: sanityId, name, price, picture: picture ? { ...sizedImage(picture, CARD_RATIO, CARD_WIDTHS), alt: picture.alt } : null }
  })
}

/**
 * The add-ons for the panel, once for a request. The frame stands whatever happens to them, as it does without its
 * own content (lib/frame/read.ts): add-ons that can't be read are none (the panel then has no add-ons to offer, and a
 * session can still be booked), and pictures that can't be read leave each card's picture area empty.
 */
export const readBookAddOns = cache(async (): Promise<BookAddOn[]> => {
  await connection()
  const [onSale, pictures] = await Promise.all([
    readShopAddonsKept().catch((error: unknown) => {
      console.error('The Book panel could not read its add-ons; it is shown without them.', error)
      return [] as ShopAddon[]
    }),
    readSanity('addons').catch((error: unknown) => {
      console.error("The Book panel could not read its add-ons' pictures from Sanity; they are shown without them.", error)
      return [] as AddonPictures
    }),
  ])
  return bookAddOns(onSale, pictures)
})
