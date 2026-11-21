import type { AllowedDifference } from './compare'

/**
 * Brief W53 (items 4 and 5): the labels an order and a booking line read after a refund, and L9's payment method. The
 * booking replay's golden files were recorded on the old code, whose labels these were; each scenario below differs
 * from its golden file in a label and nothing else. No money differs: every amount, every Stripe call and every store
 * credit row's amount is still compared exactly.
 *
 * Every difference is one path with the golden file's value and the Worker's, both exact, so an allowance can't hide
 * another value on its path, and one allowance for one path, so each must still be seen (compareRecordings fails an
 * allowance nothing used).
 */

const escaped = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const W05H_2 = "Brief W53 item 4 (W05h step E item 2, E-plan 2.2): Remove Guest's store credit is linked to the guest's own order, so the booking's own order isn't part refunded by a guest's refund"
const W05H_3 = "Brief W53 item 4 (W05h step E items 3 and 4, E-plan 2.2): the line stamped is the guest's own, the one their Add Guest wrote (its booking.guest_add audit row), whatever the seat costs now and whichever line is newest"
const W47_L5 = "Brief W53 item 4 (W47 review L5): a cancelled booking's line that still holds seat money counts, so an order that kept some of its money reads part refunded, not refunded"
const W32_N4 = "Brief W53 item 4 (W32 \"Noticed\" 4): It already arrived works the booking's orders out again (as Refund the rest does), so an order reads what its rows say once what was owed is settled"
const L9 = "Brief W53 item 5 (lead call L9; W03-decisions Q9's table): an order paid by store credit alone records payment_method 'store_credit'"

/** One label: its path, the golden file's value and the Worker's. */
function label(name: string, decision: string, path: string, golden: unknown, now: unknown): AllowedDifference {
  return {
    name: `${name} [${path}: ${JSON.stringify(golden)} in the golden file, ${JSON.stringify(now)} now]`,
    decision,
    path: new RegExp(`^${escaped(path)}$`),
    actual: (value, expected) => value === now && expected === golden,
  }
}

/** The £N store credit of a removed guest: linked to the guest's own order (`orders#2`), not the booking's (`orders#1`). */
const creditOnTheGuestsOrder = (row: number): AllowedDifference =>
  label(
    "Remove Guest to store credit: the credit's row is linked to Bea's own order (the one her Add Guest wrote), where it was linked to the booking's own order",
    W05H_2,
    `.tables.store_credit_transactions.added[${row}].order_id`,
    'orders#1',
    'orders#2'
  )

/** With the credit on the guest's order, the booking's own order has had nothing back: it stays `paid`. */
const ownOrderStaysPaid = label(
  "Remove Guest to store credit: the booking's own order has had nothing back, so it stays paid (it read part refunded, by the guest's credit linked to it)",
  W05H_2,
  '.tables.orders.added[0].payment_status',
  'partially_refunded',
  'paid'
)

/** A guest's own line stamped (line `stamped`), and the line the old guess stamped in its place left alone (`left`). */
function guestsOwnLine(what: string, stamped: number, left: number | null): AllowedDifference[] {
  return [
    label(`${what}: the guest's own line is stamped`, W05H_3, `.tables.order_line_items.added[${stamped}].refunded_at`, null, '<set>'),
    label(`${what}: the guest's own line is stamped "card"`, W05H_3, `.tables.order_line_items.added[${stamped}].refund_method`, null, 'card'),
    ...(left === null
      ? []
      : [
          label(`${what}: the line the price guess stamped in its place is left alone`, W05H_3, `.tables.order_line_items.added[${left}].refunded_at`, '<set>', null),
          label(`${what}: the line the price guess stamped in its place has no refund method`, W05H_3, `.tables.order_line_items.added[${left}].refund_method`, 'card', null),
        ]),
  ]
}

const status = (what: string, decision: string, order: number, golden: string, now: string): AllowedDifference =>
  label(what, decision, `.tables.orders.added[${order}].payment_status`, golden, now)

/**
 * The one scenario whose order the Worker's status rule and the old one read differently from the SAME rows at the
 * end of the run (the booking replay asks both of every order: 831 orders, this one differs). W47 review L5: the
 * booking is cancelled with £5 of its seat money never given back and its line never stamped. The old rule didn't
 * count that line, so the refunded Towel alone made the order `refunded`; the Worker counts a cancelled booking's
 * line that still holds seat money. Each scenario here has one order.
 */
export const W53_STATUS_AT_THE_END: ReadonlyMap<string, { worker: string; old: string }> = new Map([
  ['price-paid-cleared-addon-credit-is-not-seat-money', { worker: 'partially_refunded', old: 'refunded' }],
])

/** The booking replay scenarios whose labels differ (W53), and the only differences allowed in each. */
export const W53_LABEL_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  // --- W05h item 2: the store credit follows the guest's order
  ['remove-guest-to-store-credit', [ownOrderStaysPaid, creditOnTheGuestsOrder(0)]],
  ['remove-guest-paid-in-cash', [ownOrderStaysPaid, creditOnTheGuestsOrder(0)]],
  // The capped, unsure and cancelled ones: the booking's own order already reads as the golden file has it for
  // another reason (a part refund, the cancel), so only the credit's link differs.
  ['remove-guest-capped-to-store-credit', [creditOnTheGuestsOrder(0)]],
  ['unsure-remove-guest-store-credit-arrived', [creditOnTheGuestsOrder(0)]],
  ['remove-guest-then-cancel', [creditOnTheGuestsOrder(0)]],
  ['remove-guest-credit-fails-partway-then-retried', [creditOnTheGuestsOrder(1)]],
  // --- W05h items 3 and 4: the guest's own line
  [
    'remove-guest-the-older-of-two',
    [
      ...guestsOwnLine('Two guests added on the card, the older one removed to the card', 1, 2),
      status(
        "The older of two guests removed: her order reads refunded (her line is stamped), where it read paid with her seat gone. Since W53a her £20 comes back from her own card payment (W53A_PAYMENT_FIRST_DIFFERENCES; until then the newest, the other guest's: W53 report, \"Noticed\" 3)",
        W05H_3,
        1,
        'paid',
        'refunded'
      ),
      status(
        "The older of two guests removed: the other guest's order still reads paid (its line isn't stamped and, since W53a, its card payment gave nothing back: that guest is still booked), where it read refunded with its line stamped",
        `${W05H_3}; brief W53a item 1 (Wayne's Q40)`,
        2,
        'refunded',
        'paid'
      ),
    ],
  ],
  [
    'remove-guest-after-a-cheaper-move',
    [
      ...guestsOwnLine('A guest added at £20, a cheaper Move, then removed at the cheaper seat price (W05h item 3: her £20 line held more than the seat, so the guess never found it)', 1, null),
      status('A guest removed after a cheaper Move: her order, with all its money back, reads refunded (it stayed part refunded for ever)', W05H_3, 1, 'partially_refunded', 'refunded'),
    ],
  ],
  [
    'reader-move-finished-then-remove-guest',
    [
      ...guestsOwnLine("A guest removed after a dearer Move on the reader (W05h item 4: the Move's own charge line, the newest that fitted, was stamped in her place)", 1, 2),
      status("A guest removed after a dearer Move: her order reads refunded (it read part refunded, her line never stamped)", W05H_3, 1, 'partially_refunded', 'refunded'),
      status("A guest removed after a dearer Move: the Move's own order reads part refunded (its card payment gave money back; its line, the booking's, isn't stamped), where it read refunded", W05H_3, 2, 'refunded', 'partially_refunded'),
    ],
  ],
  [
    'owed-then-remove-guest-stops-at-what-is-left',
    [
      ...guestsOwnLine('A guest removed for the £10 the booking had left (her £20 line held more than that, so the guess never found it)', 1, null),
      status("A guest removed for what the booking had left: her order, whose £20 card payment all went back, reads refunded once nothing is owed (it stayed part refunded)", W05H_3, 1, 'partially_refunded', 'refunded'),
    ],
  ],
  // --- W47 review L5: a cancel that kept money
  [
    'price-paid-cleared-addon-credit-is-not-seat-money',
    [
      status(
        "£105 on the card (£100 of seats, a £5 Towel): the Towel to store credit, £95 back to the card, then a cancel that found nothing left to give. £5 of seat money was never given back, so the order reads part refunded (it read refunded: the cancelled booking's unstamped line wasn't counted)",
        W47_L5,
        0,
        'refunded',
        'partially_refunded'
      ),
    ],
  ],
  // --- W32 "Noticed" 4: worked out again when what is owed is settled
  ...['owed-arrived-after-a-lost-answer', 'owed-arrived-then-a-same-price-move'].map((name): [string, readonly AllowedDifference[]] => [
    name,
    [
      status(
        "A cheaper Move's £40 store credit landed though its answer was lost (the Move's own label was never written); It already arrived then settles the £40 owed. The order, with £40 of its money back as store credit, reads part refunded (it went on reading paid)",
        W32_N4,
        0,
        'paid',
        'partially_refunded'
      ),
    ],
  ]),
  // --- L9
  [
    'figures-card-order-and-a-guest-on-store-credit',
    [
      label(
        "Add Guest paid by store credit alone: the guest's own order records how it was paid (it recorded nothing)",
        L9,
        '.tables.orders.added[1].payment_method',
        null,
        'store_credit'
      ),
    ],
  ],
])
