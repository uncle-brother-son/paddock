import type { AllowedDifference } from './compare'

/**
 * Brief W53a item 1 (W53 review S1): Remove Guest refunds the payment that took the guest's seat first (the guest's
 * own Add Guest order, or the booking's own order for one of the original party), then the other payments newest
 * first, then store credit. The old code went newest payment first, so in three booking replay scenarios the refund
 * now goes to a different card payment. These are MONEY differences: the same amounts back to the customer, on a
 * different payment (or split differently between two). Wayne's Q40 (14 Nov) decides them: each line's money goes
 * back to the payment that took it.
 *
 * Each difference is one exact path with the golden file's value and the Worker's, both exact, one allowance for one
 * path, so none can hide another value and each must still be seen (compareRecordings fails an allowance nothing
 * used; the replay test also holds the counts). Every other amount, Stripe call and row is still compared exactly.
 */

const Q40 =
  "Wayne's Q40 (14 Nov): each line's money goes back to the payment that took it. Brief W53a item 1 (W53 review S1): Remove Guest plans the payment that took the guest's seat first"

const escaped = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One value: its path, the golden file's value and the Worker's. */
function money(name: string, path: string, golden: unknown, now: unknown): AllowedDifference {
  return {
    name: `${name} [${path}: ${JSON.stringify(golden)} in the golden file, ${JSON.stringify(now)} now]`,
    decision: Q40,
    path: new RegExp(`^${escaped(path)}$`),
    actual: (value, expected) => value === now && expected === golden,
  }
}

/** The booking replay scenarios whose Remove Guest refund goes to a different payment (W53a), and only those values. */
export const W53A_PAYMENT_FIRST_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  // Sam's booking on the card; Bea (pi_fake_0004), then Cy (pi_fake_0006), each added on the card. Bea removed.
  [
    'remove-guest-the-older-of-two',
    [
      money("Bea, the older of two guests, removed to the card: her £20 goes back to her own card payment, not to Cy's newer one", '.stripeCalls[3].params.payment_intent', 'pi_fake_0006', 'pi_fake_0004'),
      money("Bea removed: her own line records the £20 that went back to her payment", '.tables.order_line_items.added[1].card_refunded_amount', '0.00', '20.00'),
      money("Bea removed: Cy's line, whose payment gave nothing back, records no card money (Cy is still booked)", '.tables.order_line_items.added[2].card_refunded_amount', '20.00', '0.00'),
    ],
  ],
  // The same two guests, then both removed, Bea first: each £20 goes back to the guest's own payment. The two refunds
  // are the same £20 each; only which one goes first differs.
  [
    'remove-guest-both-of-two',
    [
      money('Bea removed first: her £20 goes back to her own card payment, not to Cy\'s newer one', '.stripeCalls[3].params.payment_intent', 'pi_fake_0006', 'pi_fake_0004'),
      money("Cy removed next: Cy's £20 goes back to Cy's own card payment (the old code sent it to Bea's, the only one left)", '.stripeCalls[4].params.payment_intent', 'pi_fake_0004', 'pi_fake_0006'),
    ],
  ],
  // Bea added on the card (£20, pi_fake_0004); a dearer Move on the reader (£16.50 for the three seats, pi_fake_0005).
  // Bea removed at the peak seat price, £25.50: £20 of it was her own payment, £5.50 her share of the Move's charge.
  [
    'reader-move-finished-then-remove-guest',
    [
      money("Bea removed after a dearer Move (£25.50): the first refund goes to her own card payment", '.stripeCalls[4].params.payment_intent', 'pi_fake_0005', 'pi_fake_0004'),
      money("Bea removed after a dearer Move: her own payment gives back all her £20 (the old code took £16.50 from the Move's charge first and £9 from hers)", '.stripeCalls[4].params.amount', 1650, 2000),
      money('Bea removed after a dearer Move: the rest goes to the Move\'s charge on the reader', '.stripeCalls[5].params.payment_intent', 'pi_fake_0004', 'pi_fake_0005'),
      money("Bea removed after a dearer Move: the Move's charge gives back £5.50, her share of it", '.stripeCalls[5].params.amount', 900, 550),
      money("Bea removed after a dearer Move: her own line records the £20 back on her payment", '.tables.order_line_items.added[1].card_refunded_amount', '9.00', '20.00'),
      money("Bea removed after a dearer Move: the Move's line records the £5.50 back on its payment", '.tables.order_line_items.added[2].card_refunded_amount', '16.50', '5.50'),
    ],
  ],
])
