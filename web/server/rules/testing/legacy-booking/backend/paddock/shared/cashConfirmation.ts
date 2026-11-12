/**
 * Cash must be recorded for exactly what staff confirmed, no more and no less. The screen sends the
 * figure on the "I confirm £X in cash was received" tick, and each function that takes cash
 * compares it with the amount it worked out itself, before anything is kept. A missing figure
 * counts as nothing confirmed. frontend/utils/cashConfirmation.ts holds the screen's side.
 *
 * Each function checks this first, whatever else has changed: a price can fall so far that nothing
 * is owed, or that the gift card and store credit are more than the total, and staff are still
 * holding the cash they confirmed.
 */

/** Pennies are the smallest amount, so anything above half a penny is a real difference. */
const TOLERANCE = 0.005

/** For a refusal over the amount that isn't about cash: the screen moves to the new figures. */
export const AMOUNT_CHANGED_MESSAGE = 'The amount due has changed. Check it with the customer and confirm again.'
const NOTHING_TO_COLLECT_MESSAGE =
  "The amount due has changed. There's nothing left to collect in cash. Check it with the customer and confirm again."

/** What is left to pay after the gift card and store credit. Taking pounds from pounds leaves
 *  noise: £1.00 less 95p and 5p comes out a hair above nothing, which would ask for a payment
 *  method for a remainder that isn't there. */
export function amountLeftToPay(due: number, ...parts: number[]): number {
  const left = parts.reduce((rest, part) => rest - part, due)
  return left < TOLERANCE ? 0 : left
}

/** Whether a gift card and store credit come to more than the amount, to the penny. Noise again:
 *  £4.05 and £2.90 add up to a hair more than £6.95. */
export function exceedsAmount(parts: number, amount: number): boolean {
  return Math.round((parts - amount) * 100) > 0
}

export interface CashDifferenceRefusal {
  reason: 'cash_amount_changed'
  message: string
  /** What now has to be collected in cash, to the penny. */
  amountToCollect: number
}

/** The refusal when `amountToCollect` differs from the cash staff confirmed, otherwise null. */
export function cashDifferenceRefusal(
  method: string | null | undefined,
  amountToCollect: number,
  confirmedAmount: number | null | undefined
): CashDifferenceRefusal | null {
  if (method !== 'cash') return null
  const confirmed = typeof confirmedAmount === 'number' && Number.isFinite(confirmedAmount) ? confirmedAmount : 0
  // Rounded first: 9 - 8.995 comes out a hair over half a penny, and refusing that would show
  // staff the figure they just confirmed, every time they confirmed it.
  const difference = Math.round(Math.abs(amountToCollect - confirmed) * 1e6) / 1e6
  if (difference <= TOLERANCE) return null
  const rounded = Math.round(amountToCollect * 100) / 100
  return {
    reason: 'cash_amount_changed',
    message:
      rounded === 0
        ? NOTHING_TO_COLLECT_MESSAGE
        : `The amount due has changed to £${rounded.toFixed(2)}. Check it with the customer and confirm again.`,
    amountToCollect: rounded,
  }
}
