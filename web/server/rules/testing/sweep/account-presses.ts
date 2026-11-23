import type { Db } from '@/server/db'
import { throughStaffApp } from './booking-presses'

/*
 * W64 (H-plan 3.3 step 3): credits, Herd and store credit presses (W37), as the screen presses them, moved here unchanged from
 * `replay/account-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded.
 */

/** The old step F actions W37 gives to the Worker. */
export const W37_ACTIONS: ReadonlySet<string> = new Set(['adjustCustomerStoreCredit', 'adjustMembershipCredits', 'getMembershipCreditAdjustments', 'setMembershipHerd'])
/** The three of them that write, each with a press key. */
export const WRITES: ReadonlySet<string> = new Set(['adjustCustomerStoreCredit', 'adjustMembershipCredits', 'setMembershipHerd'])

export type Params = Record<string, unknown> | null | undefined

/** What a screen's press is for: the dialog (or the Herd switch) it was pressed in. */
export function screenFor(action: string, params: Params): string {
  if (action === 'adjustCustomerStoreCredit') return `store-credit|${String(params?.['customerId'])}`
  if (action === 'adjustMembershipCredits') return `credits|${String(params?.['membershipId'])}`
  // The Herd switch keeps a key for each value pressed (CustomersPage.tsx, herdKeys).
  return `herd|${String(params?.['membershipId'])}|${String(params?.['herd'])}`
}

export interface AccountPressOptions {
  /**
   * A scenario that records the same press sent twice (FB9, FB12: the answer lost, pressed again). The old functions
   * had no key, so the recording is two plain calls; the screens now send the second under the first's key, which is
   * what this models: a press exactly like the one before it, in the same dialog, goes under the same key.
   */
  repeatedPress?: boolean
}

/**
 * The three writes as their screens press them (AdjustStoreCreditDialog, MembershipCreditDialog, the Herd switch on
 * the Customers page): each press has a key; a press that got no answer keeps it for the same press made again in the
 * same dialog; any other answer starts a new one.
 *
 * A different press after one that got no answer (another amount, type or reason) is taken as the dialog closed and
 * opened again, so it has a new key: the old recordings have no step for the close, and a changed press under a kept
 * key is only ever answered "check first" (the wrappers' own test holds that).
 */
export function accountAsTheScreensPress(options: AccountPressOptions = {}): (db: Db, action: string, params: unknown) => Promise<unknown> {
  const heldKeys = new Map<string, { key: string; sent: string }>()
  const lastPress = new Map<string, { key: string; sent: string }>()
  return async (db, action, params) => {
    const screen = screenFor(action, params as Params)
    const sent = JSON.stringify(params)
    const held = heldKeys.get(screen)
    const last = lastPress.get(screen)
    const idempotencyKey = held?.sent === sent ? held.key : options.repeatedPress && last?.sent === sent ? last.key : crypto.randomUUID()
    lastPress.set(screen, { key: idempotencyKey, sent })
    const answer = (await throughStaffApp(action)(db, { ...(params as object), idempotencyKey })) as { noAnswer?: boolean } | null
    if (answer?.noAnswer) heldKeys.set(screen, { key: idempotencyKey, sent })
    else heldKeys.delete(screen)
    return answer
  }
}
