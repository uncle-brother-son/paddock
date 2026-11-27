import { connection } from 'next/server'
import { cache } from 'react'

import { readSanity } from '@/lib/sanity/read'
import { readShopMembershipsKept } from '@/lib/shop/read'

import { membershipCards, passCards, type MembershipCardView, type PassCardView } from './cards'

// W81: what the Memberships and SessionPasses modules read. Names, lines and benefits are Sanity's (the Membership
// and Session Pass cards); which plans and passes are on sale, every price, "Save up to N%" and how long a pass lasts
// are the Worker's (lib/shop/read.ts, at most a minute old). Each is read once for a request. A read that fails
// throws: never an empty row of cards.

/** The Membership cards to show, with W80a's largest yearly saving (null when no yearly price saves). */
export const readMembershipCards = cache(async (): Promise<{ cards: MembershipCardView[]; saveUpTo: number | null }> => {
  await connection()
  const [cards, shop] = await Promise.all([readSanity('membershipCards'), readShopMembershipsKept()])
  return { cards: membershipCards({ cards, plans: shop.plans }), saveUpTo: shop.saveUpTo }
})

/** The Session Pass cards to show. */
export const readPassCards = cache(async (): Promise<PassCardView[]> => {
  await connection()
  const [cards, shop] = await Promise.all([readSanity('sessionPassCards'), readShopMembershipsKept()])
  return passCards({ cards, passes: shop.passes })
})
