import type { Db } from '@/server/db'
import { throughStaffApp } from './booking-presses'

/*
 * W64 (H-plan 3.3 step 3): the customer presses (W39), as the screen presses them, moved here unchanged from
 * `replay/customer-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded. The replay side re-exports all of it; what it keeps is its old side and its comparisons (W65).
 */

/** The old customer actions W39 gives to the Worker. */
export const W39_ACTIONS: ReadonlySet<string> = new Set(['createCustomer', 'getCustomers', 'getCustomerDetail'])

/**
 * The reads earlier slices gave to the Worker (W37's credit history, W38's two gift card reads). FB16's recording
 * calls them beside W39's two, so its replay sends all five through the staff app's wrappers.
 */
export const READS_ALREADY_SWITCHED: ReadonlySet<string> = new Set(['getGiftCards', 'getGiftCardRedemptions', 'getMembershipCreditAdjustments'])

export type CreateAnswer = { created?: boolean; reason?: string; message?: string; noAnswer?: boolean } | null

/**
 * Create as the New Customer dialog presses it (NewCustomerDialog): each press has a key; a press that got no answer
 * keeps it for the next press; any other answer starts a new one. The wrapper answers a refusal as data
 * (`created: false`, so the dialog can tell it from no answer); the dialog shows its words where it showed the old
 * function's thrown error, so the replay reads it as that throw.
 */
export function createAsTheDialogPresses(): (db: Db, params: unknown) => Promise<unknown> {
  let held: string | null = null
  return async (db, params) => {
    const idempotencyKey = held ?? crypto.randomUUID()
    const answer = (await throughStaffApp('createCustomer')(db, { ...(params as object), idempotencyKey })) as CreateAnswer
    held = answer?.noAnswer ? idempotencyKey : null
    if (answer && answer.created === false) throw new Error(String(answer.message))
    return answer
  }
}
