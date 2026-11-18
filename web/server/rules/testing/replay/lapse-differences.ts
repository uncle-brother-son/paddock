import type { AllowedDifference } from './compare'
import { ID } from './scenarios'

/*
 * W43 (brief item 5; F-plan 4.12 items 3 and 4): the lapse family (W36's four recordings of the database's own sweep)
 * through the Worker's sweep on the same seed, and the only differences allowed in each, every one tied to a decision.
 * A scenario not named in W43_DIFFERENCES must match its golden file exactly (the sweep's own audit rows apart, which
 * the database's sweep never wrote: lapse-side.ts sets them aside and holds them to lapseRowProblems); an allowance
 * that stops being needed fails (compareRecordings).
 *
 * Each named difference is pinned: every path it allows carries the one value the Worker's sweep gives there, so a
 * path that differs in any other way is not allowed. Written by hand from a dump of the replay's raw differences
 * (briefs/W43-logs/05b-parity-replay-dump.jsonl, staff app repo), each read against Q48.
 */

/** W43's golden family: the lapse sweep's four recordings. */
export const isW43Scenario = (name: string): boolean => /^w36-(lapse-sweep-|fb(18|19)-)/.test(name)

const W43 = "Wayne's Q48, 15 Nov (a payment-needed booking with money on it is cancelled at its deadline like any lapsed booking: 24 hours or more before the session, paid guests and paid add-ons go to store credit; never to a card); brief W43 item 2; F-plan 4.8"

type Matcher = (value: unknown) => boolean
/** The path holds nothing on the new side (the old side's value is gone). */
const GONE: Matcher = (value) => value === undefined || value === null
/** Exactly this value, compared whole (a table that only the new side changed). */
const exactly = (expected: unknown): Matcher => (value) => JSON.stringify(value) === JSON.stringify(expected)
type Pin = string | number | boolean | Matcher

const escaped = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Every path each named difference pins, by its name. A pin only bites when its path differs from the golden file: a
 * path that stopped differing (the towel line no longer removed) would otherwise pass unseen while the allowance's
 * other paths still use it. The replay test holds each scenario's raw differences to exactly these paths.
 */
const pinnedPaths = new Map<string, readonly string[]>()
export const pathsPinnedBy = (difference: AllowedDifference): readonly string[] => pinnedPaths.get(difference.name) ?? []

/** One named difference whose every path is pinned to the value the Worker's sweep gives there. A path that isn't listed is not allowed. */
function pinned(name: string, decision: string, pins: ReadonlyArray<readonly [string, Pin]>): AllowedDifference {
  const byPath = new Map(pins)
  pinnedPaths.set(name, pins.map(([path]) => path))
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

/** The one store credit row the sweep gives Mo: no staff member, the paying order, the booking, the old cancel's note. */
const storeCreditRow = (amount: string, note: string) =>
  exactly({
    added: [
      {
        id: 'store_credit_transactions#1',
        customer_id: ID.member,
        amount,
        balance_after: amount,
        reason: 'refund',
        order_id: 'orders#1',
        booking_id: 'bookings#1',
        gift_card_id: null,
        staff_id: null,
        note,
        created_at: '<set>',
        event_booking_id: null,
      },
    ],
    changed: [],
    removed: [],
    tied: 0,
  })
const balanceNow = (amount: string) => exactly({ added: [], changed: [{ id: ID.member, store_credit_balance: ['0.00', amount] }], removed: [], tied: 0 })

/**
 * FB18 (N8). Mo's credit seat with Alex, a paid guest (£20 in cash), flagged payment needed, its deadline a minute
 * ago, 49 hours before the session. The database's sweep passed it by for ever (it only reads bookings with nothing
 * paid), so it held its two places after the deadline and after the session. Now it lapses like any other: cancelled
 * with the same reason, both places released, and the guest's £20 given to Mo as store credit.
 */
const FB18_A_BOOKING_WITH_A_PAID_GUEST_LAPSES = pinned(
  "Wayne's Q48 (bug FB18, N8, is closed): a payment-needed booking with a paid guest now lapses at its deadline like any other. 49 hours before the session: it is cancelled (`membership_lapsed`), its two places are released, and the guest's £20 goes to the member's store credit (one row, no staff member, linked to the paying order and the booking; the order reads refunded). Nothing goes to a card. (The database's sweep never lapsed it: it stayed payment needed and held two places for ever.)",
  `${W43}; bug FB18 (F-plan section 3); N8 (D-plan section 3)`,
  [
    ['.tables.bookings.added[0].status', 'cancelled'],
    ['.tables.bookings.added[0].cancelled_at', '<set>'],
    ['.tables.bookings.added[0].cancel_reason', 'membership_lapsed'],
    // The two places taken by the order are given back: the session ends as it began, so it no longer shows as changed.
    ['.tables.sessions', GONE],
    // The guest's £20, as a cancel's seat money to store credit is recorded on its order and line.
    ['.tables.order_line_items.added[0].refunded_at', '<set>'],
    ['.tables.order_line_items.added[0].refund_method', 'credit'],
    ['.tables.orders.added[0].payment_status', 'refunded'],
    ['.tables.customers', balanceNow('20.00')],
    ['.tables.store_credit_transactions', storeCreditRow('20.00', 'Booking refund. [ref gone#1]')],
  ]
)

/**
 * FB19. Mo's credit seat with a paid towel (£5 in cash): nothing paid on the seat, so the database's sweep cancelled
 * it, left the towel line on the cancelled booking, kept the £5 and recorded nothing. The booking's own row and its
 * session end exactly as the database's sweep left them; what differs is the towel: its line is removed and its £5
 * given to Mo as store credit.
 */
const FB19_A_PAID_ADD_ON_GOES_BACK = pinned(
  "Wayne's Q48 (bug FB19 is closed): a paid add-on on a lapsed booking with `price_paid = 0` follows the same rule. 49 hours before the session: the booking is cancelled exactly as the database's sweep left it, and its £5 towel line is removed and refunded to the member's store credit (one row, no staff member, linked to the paying order and the booking; the order reads refunded), with the audit rows that record it. (The database's sweep cancelled the booking, left the towel line on it, kept the £5 and recorded nothing.)",
  `${W43}; bug FB19 (F-plan section 3: confirmed by test in W36's recording and again in lapse-sweep.test.ts)`,
  [
    ['.tables.addon_order_lines.added[0].removed_at', '<set>'],
    ['.tables.addon_order_lines.added[0].refunded_amount', '5.00'],
    ['.tables.addon_order_lines.added[0].refund_method', 'credit'],
    ['.tables.orders.added[0].payment_status', 'refunded'],
    ['.tables.customers', balanceNow('5.00')],
    ['.tables.store_credit_transactions', storeCreditRow('5.00', 'Add-on refund: 1× Towel. [ref gone#1]')],
  ]
)

/** The two bugs W43's recordings hold, each with the recording of what the database's sweep did. */
export const DECISION_SCENARIOS = {
  FB18: 'w36-fb18-lapse-sweep-never-lapses-a-booking-with-a-paid-guest',
  FB19: 'w36-fb19-lapse-sweep-cancels-a-credit-booking-and-keeps-its-paid-add-on',
} as const

export const W43_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  [DECISION_SCENARIOS.FB18, [FB18_A_BOOKING_WITH_A_PAID_GUEST_LAPSES]],
  [DECISION_SCENARIOS.FB19, [FB19_A_PAID_ADD_ON_GOES_BACK]],
])
