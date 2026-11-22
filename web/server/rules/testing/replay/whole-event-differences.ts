import type { AllowedDifference } from './compare'
import { EVENT_CLAIM_KEYS } from './event-places-differences'
import { BOOKING_NO_ANSWER_MESSAGE } from './whole-event-side'

/*
 * W31 (brief item 7; E-plan 4.13 items 3 and 4): the whole-event golden family (W27's `w27-event-whole-cancel-*` and
 * the E7 recording) through the Worker's routes, driven as the Cancel event dialog presses them (the event's cancel,
 * then one press per booking), and the only differences allowed in each, every one tied to a decision. A scenario
 * not named in WHOLE_EVENT_DIFFERENCES must match its golden file exactly; an allowance that stops being needed fails
 * (compareRecordings).
 *
 * Each named difference is pinned: every path it allows carries the one value the new routes give there, so a path
 * that differs in any other way is not allowed. Written by hand from a dump of the replay's raw differences
 * (briefs/W31-logs/whole-event-differences-first-pass.jsonl, staff app repo), each read against the design.
 */

/** True for a scenario that cancels a whole event: W27's whole-event family and E7. */
export const isWholeEventScenario = (name: string): boolean => /^w27-(event-whole-cancel-|e7-)/.test(name)

const W31 = 'Brief W31 (E-plan 4.4 "Whole event"; lead call L5: the screen runs one booking per press)'

type Matcher = (value: unknown) => boolean
/** The path holds nothing on the new side (the old side's value is gone). */
const GONE: Matcher = (value) => value === undefined || value === null
const EMPTY_LIST: Matcher = (value) => Array.isArray(value) && value.length === 0
type Pin = string | number | boolean | Matcher

const escaped = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One named difference whose every path is pinned to the value the new routes give there. A path that isn't listed is not allowed. */
function pinned(name: string, decision: string, pins: ReadonlyArray<readonly [string, Pin]>): AllowedDifference {
  const byPath = new Map(pins)
  return {
    name,
    decision,
    path: new RegExp(`^(${pins.map(([path]) => escaped(path)).join('|')})$`),
    actual: (value, _expected, path) => {
      const pin = byPath.get(path)
      if (pin === undefined) return false
      return typeof pin === 'function' ? pin(value) : value === pin
    },
  }
}

/** The dialog's list after the run: exactly these rows, in this order (`[customer, places, ok, card, store credit]`). */
const rows =
  (...expected: ReadonlyArray<readonly [string, number, boolean, number, number]>): Matcher =>
  (value) =>
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every(([customerName, places, ok, card, credit], index) => {
      const row = value[index] as Record<string, unknown> | null
      return (
        row !== null &&
        typeof row === 'object' &&
        /^event_bookings#\d+$/.test(String(row['eventBookingId'])) &&
        row['customerName'] === customerName &&
        row['places'] === places &&
        row['ok'] === ok &&
        row['cardRefundedAmount'] === card &&
        row['storeCreditRefundedAmount'] === credit &&
        !('message' in row)
      )
    })

const PERMISSION_WORDS = 'Needs Issue refunds permission — this action moves money back to the customer.'

/** No Issue refunds: refused as data, where the old function threw the same words. */
const NO_PERMISSION_AS_DATA = pinned(
  'No Issue refunds: the whole-event cancel is refused as data (`permission_denied`, the same words), where the old function threw them. The event is left as it was',
  `${W31}; E-plan 4.10 (Issue refunds checked on the Worker); E-plan 4.8 (refusals come back in the old result shape); as W30's place cancel`,
  [
    ['.results[1].thrown', GONE],
    ['.results[1].ok', false],
    ['.results[1].reason', 'permission_denied'],
    ['.results[1].message', PERMISSION_WORDS],
  ]
)

/**
 * Bug E7. The old code checked for payments in progress and marked the event cancelled in separate statements; the
 * recording starts a reader order between the two, which is then paid, on a cancelled event, and refunded only if
 * someone opens the dialog again. The Worker's cancel is one transaction under the event's lock, which New Order also
 * takes, so there is no in-between: the gap (hooked on the old code's own statement) never opens, and the order is
 * started where it would land, straight after the cancel. It is refused (`event_cancelled`): no order, no booking, no
 * PaymentIntent, nothing to refund. The cash booking is cancelled to store credit exactly as before.
 * (An order that gets in first instead is seen by the cancel: cancel-event-postgres.test.ts, both ways round.)
 */
const E7_NO_ORDER_AFTER_THE_CANCEL = pinned(
  "Bug E7 is closed: the event's cancel is one transaction under the event's lock, so the reader order can't start between its check and its mark. It starts after the cancel and is refused (`event_cancelled`): no order, booking, places or PaymentIntent on a cancelled event, and the overview has nothing left to cancel. (The old code took the order, which was then paid £80 on a cancelled event.)",
  `Bug E7 (E-plan section 3); brief W31 item 1 (one transaction under the event's lock; New Order takes the same lock); ${W31}`,
  [
    // The second step is the cancel now (the order can't get in before it): the cash booking goes to store credit.
    ['.results[1].success', GONE],
    ['.results[1].orderId', GONE],
    ['.results[1].cardCharged', GONE],
    ['.results[1].paymentMethodUsed', GONE],
    ['.results[1].pendingReaderPayment', GONE],
    ['.results[1].ok', true],
    ['.results[1].results', rows(['Mo Member', 1, true, 0, 20])],
    // Then the reader order, refused by New Order.
    ['.results[2].ok', GONE],
    ['.results[2].results', GONE],
    ['.results[2].success', false],
    ['.results[2].stage', 'event'],
    ['.results[2].reason', 'event_cancelled'],
    ['.results[2].message', 'That event has been cancelled.'],
    // No tap to finish: the next step is the overview, with nothing left to cancel.
    ['.results[3].finalised', GONE],
    ['.results[3].orderId', GONE],
    ['.results[3].paymentIntentId', GONE],
    ['.results[3].eventName', 'Full Moon Sauna'],
    ['.results[3].ended', false],
    ['.results[3].cancelledAt', '<time>'],
    ['.results[3].cancelReason', 'Storm'],
    ['.results[3].pendingCustomers', EMPTY_LIST],
    ['.results[3].bookings', EMPTY_LIST],
    ['.results[3].totalPlaces', 0],
    ['.results[3].totalValue', 0],
    ['.results[4]', GONE],
    // Nothing of the reader order exists: no PaymentIntent, order, line, booking or places.
    ['.stripeCalls[0]', GONE],
    ['.stripeCalls[1]', GONE],
    ['.tables.event_attendees.added[1]', GONE],
    ['.tables.event_attendees.added[2]', GONE],
    ['.tables.event_bookings.added[1]', GONE],
    ['.tables.events.changed[0].places_booked', GONE],
    ['.tables.order_line_items.added[1]', GONE],
    ['.tables.orders.added[1]', GONE],
  ]
)

/**
 * Bug E6 and the press key. The old function cancelled every booking inside one call; the card booking's refund got
 * no clear answer, so nothing was cancelled for it and the refund was held, and the next call sent it again under the
 * same key and recorded the booking without its card money (£0 in the list, the order left `paid`). Here each booking
 * is its own press with its own key: the route ran to the end (the booking cancelled, £80 to the card, recorded) and
 * only its answer was lost, so its row says no answer; Retry sends the same press under the same key and gets the
 * first press's answer. One refund in all.
 */
const E6_ONE_PRESS_PER_BOOKING_ANSWER_LOST = pinned(
  "Bug E6 is closed: each booking is its own press with its own key. The card booking's press ran to the end (cancelled, £80 to the card) and only its answer was lost: its row says no answer and keeps its key; Retry gets that press's stored answer (£80 to the card) and sends nothing again; the order is `refunded`. (The old code held the refund inside its one call, sent it again on the next call, listed £0 to the card and left the order `paid`.)",
  `Bug E6 (E-plan section 3); ${W31}; brief W31 item 5 (each booking its own press key and claim, Retry); W20's model of a lost answer; W05j call 1 (held refunds settled on the next press are replaced by claims)`,
  [
    ['.results[2].results[0].message', BOOKING_NO_ANSWER_MESSAGE],
    ['.results[2].results[0].noAnswer', true],
    ['.results[3].results[0].cardRefundedAmount', 80],
    ['.stripeCalls[2]', GONE],
    ['.tables.orders.added[0].payment_status', 'refunded'],
  ]
)

/** The scenarios that differ only in the refund's key (each booking's card refund is keyed from its own claim). */
const KEYS_ONLY = [
  'w27-event-whole-cancel-card-and-cash-bookings-to-card',
  'w27-event-whole-cancel-one-booking-fails-then-retry',
  'w27-event-whole-cancel-a-card-refund-refused-by-stripe',
  'w27-event-whole-cancel-after-the-cut-off-and-a-place-already-cancelled',
] as const

export const E7_SCENARIO = 'w27-e7-a-reader-order-started-between-the-check-and-the-cancel'
export const E6_SCENARIO = 'w27-event-whole-cancel-answer-lost-then-retry'

export const WHOLE_EVENT_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ['w27-event-whole-cancel-refused-without-issue-refunds', [NO_PERMISSION_AS_DATA]],
  ...KEYS_ONLY.map((name) => [name, [EVENT_CLAIM_KEYS]] as [string, readonly AllowedDifference[]]),
  [E7_SCENARIO, [E7_NO_ORDER_AFTER_THE_CANCEL]],
  [E6_SCENARIO, [EVENT_CLAIM_KEYS, E6_ONE_PRESS_PER_BOOKING_ANSWER_LOST]],
  [
    'w27-event-whole-cancel-refused-while-a-reader-payment-is-open',
    [
      EVENT_CLAIM_KEYS,
      pinned(
        'W58: the in-progress words say "A payment is still in progress for …": a saved-card payment is held the same way as a reader one (the old words said "A card reader payment")',
        'Brief W58 (W35 audit row 22; W31 "Noticed" 3)',
        [['.results[3].message', 'A payment is still in progress for Sam Test. Finish or cancel it first.']]
      ),
    ],
  ],
])
