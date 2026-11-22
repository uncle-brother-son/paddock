import type { Db } from '@/server/db'
import { throughStaffApp } from './booking-presses'

/*
 * W64 (H-plan 3.3 step 3): the membership cancel presses (W40), as the screen presses them, moved here unchanged from
 * `replay/membership-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded. The replay side re-exports all of it; what it keeps is its old side and its comparisons (W65).
 */

/** The old actions this side gives to the Worker: W40's two, and the profile (W39's, whose membership rows are W40's code). */
export const W40_ACTIONS: ReadonlySet<string> = new Set(['setMembershipCancellation', 'getSubscriptions', 'getCustomerDetail'])

/** ORDER_SWITCH as it will be live once Wayne adds `membership_changes` (W36's kind; off with today's secret). */
export const MEMBERSHIP_KINDS_ON = 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels,membership_changes'

export type Params = Record<string, unknown> | null | undefined

/**
 * The cancel and its undo as CancelMembershipDialog presses them: each press has a key; a press that got no answer
 * keeps it for the same press made again in the same dialog (the same membership, the same direction); any other
 * answer starts a new one.
 */
export function membershipsAsTheDialogPresses(): (db: Db, action: string, params: unknown) => Promise<unknown> {
  const heldKeys = new Map<string, string>()
  return async (db, action, params) => {
    if (action !== 'setMembershipCancellation') return throughStaffApp(action)(db, params)
    const dialog = `${String((params as Params)?.['membershipId'])}|${String((params as Params)?.['cancel'])}`
    const idempotencyKey = heldKeys.get(dialog) ?? crypto.randomUUID()
    const answer = (await throughStaffApp(action)(db, { ...(params as object), idempotencyKey })) as { noAnswer?: boolean } | null
    if (answer?.noAnswer) heldKeys.set(dialog, idempotencyKey)
    else heldKeys.delete(dialog)
    return answer
  }
}
