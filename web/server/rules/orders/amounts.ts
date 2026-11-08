// Ported from backend/paddock/shared/cashConfirmation.ts: the sums, and the cash refusal (W06).
import 'server-only'

/** Pennies are the smallest amount, so anything above half a penny is a real difference. */
const TOLERANCE = 0.005

export const round2 = (n: number): number => Math.round(n * 100) / 100

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

const NOTHING_TO_COLLECT_MESSAGE =
  "The amount due has changed. There's nothing left to collect in cash. Check it with the customer and confirm again."

export interface CashDifferenceRefusal {
  reason: 'cash_amount_changed'
  message: string
  /** What now has to be collected in cash, to the penny. */
  amountToCollect: number
}

/**
 * Cash is recorded for exactly what staff confirmed. The refusal when `amountToCollect` differs from
 * the figure on the tick by more than half a penny, either way, otherwise null. A missing figure
 * counts as nothing confirmed. Checked first, whatever else has changed: staff are still holding
 * the cash they confirmed.
 */
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
