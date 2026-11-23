import type { Db } from '@/server/db'
import { throughStaffApp } from './booking-presses'

/*
 * W64 (H-plan 3.3 step 3): the gift card presses (W38), as the screen presses them, moved here unchanged from
 * `replay/gift-card-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded.
 */

/** The old gift card actions W38 gives to the Worker. */
export const W38_ACTIONS: ReadonlySet<string> = new Set(['extendGiftCardExpiry', 'setGiftCardPickedUp', 'setGiftCardShipped', 'getGiftCards', 'getGiftCardRedemptions'])

export interface GiftCardPressOptions {
  /**
   * A scenario that records the same press sent twice (FB15: the answer lost, pressed again). The old function had no
   * key, so the recording is two plain calls; the dialog now sends the second under the first's key, which is what
   * this models: a press exactly like the one before it, on the same card, goes under the same key.
   */
  repeatedPress?: boolean
}

/**
 * Extend as its dialog presses it (ExtendGiftCardDialog): each press has a key; a press that got no answer keeps it
 * for the same press made again on the same card; any other answer starts a new one. Picked up and shipped send no
 * key of their own (a flag is set to a value, not moved): each wrapper makes one for its call.
 */
export function giftCardsAsTheScreensPress(options: GiftCardPressOptions = {}): (db: Db, action: string, params: unknown) => Promise<unknown> {
  const heldKeys = new Map<string, { key: string; sent: string }>()
  const lastPress = new Map<string, { key: string; sent: string }>()
  return async (db, action, params) => {
    if (action !== 'extendGiftCardExpiry') return throughStaffApp(action)(db, params)
    const card = String((params as Record<string, unknown> | null)?.['giftCardId'])
    const sent = JSON.stringify(params)
    const held = heldKeys.get(card)
    const last = lastPress.get(card)
    const idempotencyKey = held?.sent === sent ? held.key : options.repeatedPress && last?.sent === sent ? last.key : crypto.randomUUID()
    lastPress.set(card, { key: idempotencyKey, sent })
    const answer = (await throughStaffApp(action)(db, { ...(params as object), idempotencyKey })) as { noAnswer?: boolean } | null
    if (answer?.noAnswer) heldKeys.set(card, { key: idempotencyKey, sent })
    else heldKeys.delete(card)
    return answer
  }
}
