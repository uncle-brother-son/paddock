import type { Db } from '@/server/db'
import { throughStaffApp } from './booking-presses'
import { MEMBERSHIP_KINDS_ON } from './membership-presses'

/*
 * W64 (H-plan 3.3 step 3): the payment date presses (W41), as the screen presses them, moved here unchanged from
 * `replay/payment-date-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded. The replay side re-exports all of it; what it keeps is its old side and its comparisons (W65).
 */

/** The old actions this side gives to the Worker. */
export const W41_ACTIONS: ReadonlySet<string> = new Set(['changeMembershipPaymentDate', 'getMembershipPaymentDateQuote'])

export type Params = Record<string, unknown> | null | undefined

/**
 * The press as ChangePaymentDateDialog makes it. The dialog always shows the figure for the picked date before the
 * button can be pressed, and sends that figure (Q18): so a press sends the amount of the last quote this run made for
 * that membership and date, and where a recorded scenario pressed without asking for one, the dialog's own read is
 * made first (it is a read, and is not one of the scenario's recorded answers). A quote with no figure (a refusal, a
 * date outside the window) sends none, as nothing was shown. Each press has a key; a press that got no answer keeps it
 * for the same press made again in the same dialog; any other answer starts a new one.
 */
export function paymentDatesAsTheDialogPresses(): (db: Db, action: string, params: unknown) => Promise<unknown> {
  const heldKeys = new Map<string, string>()
  const shown = new Map<string, number | undefined>()
  const dialogOf = (params: Params): string => `${String(params?.['membershipId'])}|${String(params?.['newRenewalDate'])}`
  return async (db, action, params) => {
    const given = params as Params
    if (action === 'getMembershipPaymentDateQuote') {
      let quote: { newRenewalDate?: string; amount?: number } | null
      try {
        quote = (await throughStaffApp(action)(db, params)) as { newRenewalDate?: string; amount?: number } | null
      } catch (err) {
        // The recorded scenarios read the quote with `call`, which stops at the first throw. A read the Worker now
        // refuses (an inactive account, FB16) answers `{ thrown }` instead, so the scenario runs on to its press.
        return { thrown: err instanceof Error ? err.message : String(err) }
      }
      if (given?.['newRenewalDate'] !== undefined) shown.set(dialogOf(given), quote?.amount)
      return quote
    }
    if (action !== 'changeMembershipPaymentDate') return throughStaffApp(action)(db, params)
    const dialog = dialogOf(given)
    if (!shown.has(dialog) && given?.['membershipId'] && given['newRenewalDate']) {
      const quote = (await throughStaffApp('getMembershipPaymentDateQuote')(db, { membershipId: given['membershipId'], newRenewalDate: given['newRenewalDate'] }).catch(() => null)) as { amount?: number } | null
      shown.set(dialog, quote?.amount)
    }
    const confirmedAmount = shown.get(dialog)
    const idempotencyKey = heldKeys.get(dialog) ?? crypto.randomUUID()
    const answer = (await throughStaffApp(action)(db, { ...(given as object), ...(confirmedAmount !== undefined ? { confirmedAmount } : {}), idempotencyKey })) as { noAnswer?: boolean } | null
    if (answer?.noAnswer) heldKeys.set(dialog, idempotencyKey)
    else heldKeys.delete(dialog)
    return asTheOldShape(answer)
  }
}

/**
 * The press's answer mapped back to the old result's shape (F-plan 4.12 item 3): the old result had no `reason`, and
 * the dialog shows the words. What each refusal's reason is, is held by memberships/payment-date.test.ts. The fields
 * that change what staff see or may do (`held`, `amountNow`, `noAnswer`) stay, and are named differences.
 */
export function asTheOldShape(answer: unknown): unknown {
  if (answer === null || typeof answer !== 'object' || !('reason' in answer)) return answer
  const rest: Record<string, unknown> = { ...(answer as Record<string, unknown>) }
  delete rest['reason']
  return rest
}

/** ORDER_SWITCH as it will be live once the lead adds `payment_date_changes` (W41a: the payment date change's own kind). */
export const PAYMENT_DATE_KINDS_ON = `${MEMBERSHIP_KINDS_ON},payment_date_changes`
