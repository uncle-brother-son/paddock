// Ported from backend/paddock/shared/cashConfirmation.ts (the sums; the refusals move with W06).
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
