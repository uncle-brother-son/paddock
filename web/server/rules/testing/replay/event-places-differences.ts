import { PENNY_TEXT_FIELDS, samePence, type AllowedDifference } from './compare'

/*
 * W30 (brief item 7; E-plan 4.13 items 3 and 4): the event place golden families (W27's `w27-event-cancel-*`, the E8
 * and E9 recordings, and W05k's `p3` and `p5`) through the Worker's routes, and the only differences allowed in each,
 * every one tied to a decision. A scenario not named in EVENT_PLACES_DIFFERENCES must match its golden file exactly;
 * an allowance that stops being needed fails (compareRecordings).
 *
 * Each named difference is pinned: every path it allows carries the one value the new route gives there, so a path
 * that differs in any other way is not allowed. The table at the end is written by
 * briefs/W30-logs/generate-event-differences.py (staff app repo) from a dump of the replay's raw differences, after
 * each was read against the design; the names and decisions are written by hand in that script.
 */

/** True for a scenario that cancels event places and never the whole event: W27's place families, E8, E9, p3 and p5. */
export const isEventPlacesScenario = (name: string): boolean => /^(w27-(event-cancel-|e[89]-)|p3-|p5-)/.test(name)

const W30 = 'Brief W30 (E-plan 4.4; lead call L2: claims in audit_log)'
const BY_DESIGN = `${W30}; E-plan "six things" item 4 (one transaction and a key from the claim replace the old safety machinery)`
const LOST_ANSWER = `${W30} item 6 (the press key, kept after no answer); W20's model of a lost answer (the route ran to the end)`

const CLAIM_KEY = /^audit_log#\d+:refund:orders#\d+$/
const CLAIM_LABEL = /^audit_log#\d+$/
const KEY_PATHS = String.raw`^\.stripeCalls\[\d+\]\.(idempotencyKey|params\.metadata\.(refund_key|claim_id))$`

/**
 * A card refund's key and metadata come from its claim: `<claimId>:refund:<orderId>`, with `metadata.claim_id` naming
 * the claim and `refund_key` the key. The old key was built from the order line, the card money the order had had
 * back, the places, the amount and a count of refusals. Only those values pass.
 */
export const EVENT_CLAIM_KEYS: AllowedDifference = {
  name: "An event place cancel's card refund is keyed from its claim (`<claimId>:refund:<orderId>`) and names it in `metadata.claim_id`; the old key built from the line, the places, the figures and a count of refusals is replaced",
  decision: `${W30}: keys from the claim id; W05i noticed 2 and W05j call 1 (the old keys and their refusal counts go)`,
  path: new RegExp(KEY_PATHS),
  actual: (value, _expected, path) => (path.endsWith('.claim_id') ? typeof value === 'string' && CLAIM_LABEL.test(value) : typeof value === 'string' && CLAIM_KEY.test(value)),
}

// --- What a pinned path may hold

type Matcher = (value: unknown) => boolean
/** The path holds nothing on the new side (the old side's value is gone). */
const GONE: Matcher = (value) => value === undefined || value === null
type Pin = string | number | boolean | Matcher

const escaped = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * One named difference whose every path is pinned to the value the new route gives there: a literal (compared
 * exactly), or a matcher for an answer that is an object. A path that isn't listed is not allowed.
 */
function pinned(name: string, decision: string, pins: ReadonlyArray<readonly [string, Pin]>): AllowedDifference {
  const byPath = new Map(pins)
  return {
    name,
    decision,
    path: new RegExp(`^(${pins.map(([path]) => escaped(path)).join('|')})$`),
    actual: (value, _expected, path) => {
      const pin = byPath.get(path)
      if (pin === undefined) return false
      if (typeof pin === 'function') return pin(value)
      // W53 (migration 033): a place's three figures are text to the penny now (`40.00`); the pins say `40`.
      return value === pin || (PENNY_TEXT_FIELDS.has(path.slice(path.lastIndexOf('.') + 1)) && samePence(value, pin))
    },
  }
}

/** The booking as the attendee list shows it after the press: its status and places still booked. */
const booking =
  (status: string, places: number): Matcher =>
  (value) => {
    const row = value as { id?: unknown; status?: unknown; places?: unknown; attendees?: unknown } | null
    return row !== null && typeof row === 'object' && /^event_bookings#\d+$/.test(String(row.id)) && row.status === status && row.places === places && Array.isArray(row.attendees)
  }

/** The quote sent back with a refusal (Q18): what the places are worth now. */
const quoteOf =
  (worth: number, places: number): Matcher =>
  (value) => {
    const quote = value as { value?: unknown; places?: unknown } | null
    return quote !== null && typeof quote === 'object' && quote.value === worth && quote.places === places
  }

/** One refund sent under its claim's key, for this many pence. */
const refundCall =
  (pence: number): Matcher =>
  (value) => {
    const call = value as { method?: unknown; idempotencyKey?: unknown; params?: { amount?: unknown; metadata?: { claim_id?: unknown; refund_key?: unknown } } } | null
    return (
      call !== null &&
      typeof call === 'object' &&
      call.method === 'refunds.create' &&
      call.params?.amount === pence &&
      CLAIM_KEY.test(String(call.idempotencyKey)) &&
      call.params.metadata?.refund_key === call.idempotencyKey &&
      CLAIM_LABEL.test(String(call.params.metadata?.claim_id))
    )
  }

/** A refund's metadata, from its claim. */
const CLAIM_METADATA: Matcher = (value) => {
  const metadata = value as { claim_id?: unknown; refund_key?: unknown } | null
  return metadata !== null && typeof metadata === 'object' && CLAIM_LABEL.test(String(metadata.claim_id)) && CLAIM_KEY.test(String(metadata.refund_key)) && Object.keys(metadata).length === 2
}

type Changed = { added?: unknown[]; changed?: Array<Record<string, unknown>>; removed?: unknown[] } | null
const onlyChange = (value: unknown, column: string, from: unknown, to: unknown): boolean => {
  const table = value as Changed
  const change = table?.changed?.[0]?.[column]
  return table !== null && typeof table === 'object' && table.added?.length === 0 && table.removed?.length === 0 && table.changed?.length === 1 && Array.isArray(change) && change[0] === from && change[1] === to
}

/** The event's places booked, from the seed's figure to the recording's last. */
const placesBooked =
  (from: number, to: number): Matcher =>
  (value) =>
    onlyChange(value, 'places_booked', from, to)

/** The customer's store credit balance, from the seed's to the recording's last. */
const storeCreditBalance =
  (from: string, to: string): Matcher =>
  (value) =>
    onlyChange(value, 'store_credit_balance', from, to)

/** The store credit rows written: each a refund, linked to the order, of these amounts in order. */
const creditRefunds =
  (amounts: readonly string[]): Matcher =>
  (value) => {
    const table = value as { added?: Array<{ amount?: unknown; reason?: unknown; order_id?: unknown; note?: unknown }>; changed?: unknown[]; removed?: unknown[] } | null
    const added = table?.added ?? []
    return (
      table !== null &&
      typeof table === 'object' &&
      table.changed?.length === 0 &&
      table.removed?.length === 0 &&
      added.length === amounts.length &&
      added.every((row, index) => row.amount === amounts[index] && row.reason === 'refund' && /^orders#\d+$/.test(String(row.order_id)) && String(row.note).startsWith('Event refund: '))
    )
  }

/** The scenarios that differ only in the refund's key. */
const KEYS_ONLY: readonly string[] = [
  "w27-event-cancel-refused-booking-already-cancelled",
  "w27-event-cancel-refused-place-already-cancelled",
  "w27-event-cancel-refused-place-checked-in",
  "w27-event-cancel-refused-by-stripe-then-pressed-again",
  "w27-event-cancel-one-place-to-card",
  "w27-event-cancel-several-places-then-the-last",
  "w27-event-cancel-whole-booking-to-card",
  "w27-event-cancel-split-card-and-store-credit",
  "w27-event-cancel-gift-card-part-paid-one-place-then-the-other",
  "w27-event-cancel-promo-line-the-last-place-takes-what-is-left",
  "w27-event-cancel-after-the-cut-off-with-a-reason",
]

/**
 * Every event place golden scenario that differs on the new route, and the only differences allowed in each. The rest
 * of the families match their golden files exactly.
 */
export const EVENT_PLACES_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ...KEYS_ONLY.map((name): [string, readonly AllowedDifference[]] => [name, [EVENT_CLAIM_KEYS]]),
  [
    "p3-one-event-place-cancelled-twice-at-once",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "Two overlapping presses on one place: the overlap is hooked on the old code's own refund call, which the Worker never makes, so only one press runs here. The first place is cancelled once with one £40 refund, then the second. (The old code sent the refund twice under one key and told the overlapped press that someone else had cancelled the places.) The Worker's race is the order's lock (cancel-places-postgres.test.ts: two cancels of one place at once)",
        'W05k finding 2; W05 review 3, finding 5 (the key rows go: R2 records the card money once, under the order\'s lock); E-plan 4.13 item 7',
        [
          [".results[2].ok", true],
          [".results[2].reason", GONE],
          [".results[2].message", GONE],
          [".results[2].places", 1],
          [".results[2].refundedAmount", 40],
          [".results[2].cardRefundedAmount", 40],
          [".results[2].storeCreditRefundedAmount", 0],
          [".results[2].booking", booking("cancelled", 0)],
          [".results[2].eventPlacesBooked", 0],
          [".results[3]", GONE],
          [".stripeCalls[3]", GONE],
        ]
      ),
    ],
  ],
  [
    "p5-held-event-refund-two-days-later",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "The route ran to the end and only its answer was lost: the first place is cancelled and its £40 refunded once (no answer; the dialog keeps its key). Two days later the second place cancels with its own £40 refund, with no look in Stripe for the first; pressing the first place again gets the first press's stored answer. (The old code cancelled nothing, held the refund, and found it by a look in Stripe two days later.)",
        `${LOST_ANSWER}; W05k finding 3; W05j call 1 (held refunds settled on the next press are replaced by claims and reconcile)`,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].noAnswer", true],
          [".results[2].cardRefundedAmount", 40],
          [".results[2].booking.status", "cancelled"],
          [".results[2].booking.places", 0],
          [".results[2].booking.cancelled_at", "<time>"],
          [".results[2].booking.attendees[0].cancelled_at", "<time>"],
          [".results[2].booking.attendees[0].cancelled_by_name", "Jo Staff"],
          [".results[2].booking.attendees[0].cancelled_value", "40"],
          [".results[2].booking.attendees[0].refunded_amount", "40"],
          [".results[2].booking.attendees[0].card_refunded_amount", "40"],
          [".results[2].booking.attendees[0].refund_method", "card"],
          [".results[2].eventPlacesBooked", 0],
          [".results[3].booking.status", "confirmed"],
          [".results[3].booking.places", 1],
          [".results[3].booking.cancelled_at", GONE],
          [".results[3].booking.attendees[1].cancelled_at", GONE],
          [".results[3].booking.attendees[1].cancelled_by_name", GONE],
          [".results[3].booking.attendees[1].cancelled_value", "0"],
          [".results[3].booking.attendees[1].refunded_amount", "0"],
          [".results[3].booking.attendees[1].card_refunded_amount", "0"],
          [".results[3].booking.attendees[1].refund_method", GONE],
          [".results[3].eventPlacesBooked", 1],
          [".stripeCalls[2].method", "refunds.create"],
          [".stripeCalls[2].params.limit", GONE],
          [".stripeCalls[2].params.amount", 4000],
          [".stripeCalls[2].params.metadata", CLAIM_METADATA],
          [".stripeCalls[3]", GONE],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-refused-without-issue-refunds-for-a-card-refund",
    [
      pinned(
        "No Issue refunds: refused as data (`permission_denied`, the same words), where the old function threw them",
        'E-plan 4.10 (Issue refunds checked on the Worker); E-plan 4.8 (refusals come back in the old result shape)',
        [
          [".results[1].thrown", GONE],
          [".results[1].ok", false],
          [".results[1].reason", "permission_denied"],
          [".results[1].message", "Needs Issue refunds permission — this action moves money back to the customer."],
          [".results[2].thrown", GONE],
          [".results[2].ok", false],
          [".results[2].reason", "permission_denied"],
          [".results[2].message", "Needs Issue refunds permission — this action moves money back to the customer."],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-by-someone-with-no-staff-record",
    [
      pinned(
        "Bug E12: someone with no staff record is refused whatever they choose, as data, by the Worker's staff check. The old function refused a refund (thrown) and then cancelled the place with No refund, with nobody's name on it; here the place stays booked",
        'Bug E12 (W27 report, "For the Worker step"); brief W30 item 3; E-plan 4.10 (defineRoute refuses anyone who isn\'t active staff)',
        [
          [".results[1].thrown", GONE],
          [".results[1].ok", false],
          [".results[1].reason", "permission_denied"],
          [".results[1].message", "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."],
          [".results[2].ok", false],
          [".results[2].places", GONE],
          [".results[2].refundedAmount", GONE],
          [".results[2].cardRefundedAmount", GONE],
          [".results[2].storeCreditRefundedAmount", GONE],
          [".results[2].booking", GONE],
          [".results[2].eventPlacesBooked", GONE],
          [".results[2].reason", "permission_denied"],
          [".results[2].message", "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."],
          [".tables.event_attendees.added[0].cancelled_at", GONE],
          [".tables.event_attendees.added[0].cancelled_value", "0.00"],
          [".tables.event_attendees.added[0].refund_method", GONE],
          [".tables.event_bookings.added[0].places", 2],
          [".tables.events.changed[0].places_booked[1]", 2],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-by-an-inactive-staff-member",
    [
      pinned(
        "An inactive staff member is refused as data (`permission_denied`, the same words), where the old function threw them",
        'E-plan 4.10 (inactive staff: refused by defineRoute everywhere); E-plan 4.8',
        [
          [".results[1].thrown", GONE],
          [".results[1].ok", false],
          [".results[1].reason", "permission_denied"],
          [".results[1].message", "This staff account is inactive. Ask an admin to reactivate it."],
          [".results[2].thrown", GONE],
          [".results[2].ok", false],
          [".results[2].reason", "permission_denied"],
          [".results[2].message", "This staff account is inactive. Ask an admin to reactivate it."],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-refused-refund-choice-not-known",
    [
      pinned(
        "`cash` is a refund choice now (Q42). This booking was paid by card, so no cash can be handed back: refused `no_cash_left`, with the quote (the old function refused any choice but card, store credit or none)",
        "Wayne's Q42 (14 Nov): cash back only up to the cash paid on the order; E-plan 4.6",
        [
          [".results[1].reason", "no_cash_left"],
          [".results[1].message", "No cash paid on this booking's order is left to hand back, so it can't be handed back in cash."],
          [".results[1].quote", quoteOf(40, 1)],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-refused-order-line-not-found",
    [
      pinned(
        "The old code read the quote, then looked for the order line in a second statement; the recording takes the line away in between (nothing on a screen does). The Worker reads both under one lock in one transaction, so there is no in-between: the whole booking is cancelled and its £80 goes back to the card",
        `${BY_DESIGN}; E-plan 4.2 (read the ids, lock, then check again under the lock)`,
        [
          [".results[1].ok", true],
          [".results[1].reason", GONE],
          [".results[1].message", GONE],
          [".results[1].places", 2],
          [".results[1].refundedAmount", 80],
          [".results[1].cardRefundedAmount", 80],
          [".results[1].storeCreditRefundedAmount", 0],
          [".results[1].booking", booking("cancelled", 0)],
          [".results[1].eventPlacesBooked", 0],
          [".stripeCalls[1]", refundCall(8000)],
          [".tables.event_attendees.added[0].cancelled_at", "<set>"],
          [".tables.event_attendees.added[0].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.event_attendees.added[0].cancelled_value", "40.00"],
          [".tables.event_attendees.added[0].refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].card_refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].refund_method", "card"],
          [".tables.event_attendees.added[1].cancelled_at", "<set>"],
          [".tables.event_attendees.added[1].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.event_attendees.added[1].cancelled_value", "40.00"],
          [".tables.event_attendees.added[1].refunded_amount", "40.00"],
          [".tables.event_attendees.added[1].card_refunded_amount", "40.00"],
          [".tables.event_attendees.added[1].refund_method", "card"],
          [".tables.event_bookings.added[0].places", 0],
          [".tables.event_bookings.added[0].status", "cancelled"],
          [".tables.event_bookings.added[0].cancelled_at", "<set>"],
          [".tables.event_bookings.added[0].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.events", GONE],
          [".tables.order_line_items.added[0].refunded_at", "<set>"],
          [".tables.order_line_items.added[0].refund_method", "card"],
          [".tables.order_line_items.added[0].card_refunded_amount", "80.00"],
          [".tables.order_line_items.added[0].event_booking_id", "event_bookings#1"],
          [".tables.orders.added[0].payment_status", "refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-refused-when-the-card-check-cannot-be-read",
    [
      pinned(
        "The old key needed a count of earlier refusals, and refused when that read failed. The claim's key needs no count, so there is no such read: the place is cancelled and its £40 refunded",
        `${BY_DESIGN}; W05j call 1 (refusal counts in the key go)`,
        [
          [".results[1].ok", true],
          [".results[1].reason", GONE],
          [".results[1].message", GONE],
          [".results[1].places", 1],
          [".results[1].refundedAmount", 40],
          [".results[1].cardRefundedAmount", 40],
          [".results[1].storeCreditRefundedAmount", 0],
          [".results[1].booking", booking("confirmed", 1)],
          [".results[1].eventPlacesBooked", 1],
          [".stripeCalls[1]", refundCall(4000)],
          [".tables.event_attendees.added[0].cancelled_at", "<set>"],
          [".tables.event_attendees.added[0].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.event_attendees.added[0].cancelled_value", "40.00"],
          [".tables.event_attendees.added[0].refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].card_refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].refund_method", "card"],
          [".tables.event_bookings.added[0].places", 1],
          [".tables.events.changed[0].places_booked[1]", 1],
          [".tables.order_line_items.added[0].card_refunded_amount", "40.00"],
          [".tables.orders.added[0].payment_status", "partially_refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-refused-when-the-look-for-a-held-refund-fails",
    [
      pinned(
        "The old code looked for an earlier held refund before every press, and refused when that read failed. An open claim is found under the order's lock instead (`refund_open`), so there is no such read: the place is cancelled and its £40 refunded",
        `${BY_DESIGN}; W05j calls 1 and 2 (held refunds settled on the next press are replaced by claims and reconcile)`,
        [
          [".results[1].ok", true],
          [".results[1].reason", GONE],
          [".results[1].message", GONE],
          [".results[1].places", 1],
          [".results[1].refundedAmount", 40],
          [".results[1].cardRefundedAmount", 40],
          [".results[1].storeCreditRefundedAmount", 0],
          [".results[1].booking", booking("confirmed", 1)],
          [".results[1].eventPlacesBooked", 1],
          [".stripeCalls[1]", refundCall(4000)],
          [".tables.event_attendees.added[0].cancelled_at", "<set>"],
          [".tables.event_attendees.added[0].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.event_attendees.added[0].cancelled_value", "40.00"],
          [".tables.event_attendees.added[0].refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].card_refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].refund_method", "card"],
          [".tables.event_bookings.added[0].places", 1],
          [".tables.events.changed[0].places_booked[1]", 1],
          [".tables.order_line_items.added[0].card_refunded_amount", "40.00"],
          [".tables.orders.added[0].payment_status", "partially_refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-store-credit-write-fails",
    [
      pinned(
        "The store credit is given inside R1's transaction: when its write fails, the whole of R1 is rolled back and the words are the Worker's for that (the old function answered `store_credit_failed`). Nothing was cancelled either way",
        `${W30}: R1 is one transaction (W05 review 2, item 9: no take-backs)`,
        [
          [".results[1].reason", "cancel_not_saved"],
          [".results[1].message", "The cancellation couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was cancelled. Try again."],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-store-credit-fails-after-the-card-part",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "£50 went back to the card, then R2 (which gives the £30 of store credit) can't be saved: the places stay cancelled and the claim is held with \"…went back to the card, but the refund couldn't be finished…\". The recording ends there, with the write still failing; reconcile then records the £50 and gives the £30 (the test beside the replay). (The old code recorded the cancel with £50 back, never gave the £30, and said it needed a manual check.)",
        `${W30} item 2 (R2 is one transaction; unclear is held); E-plan 4.9 (reconcile finishes it); W05k later 3`,
        [
          [".results[1].booking.attendees[0].refunded_amount", "0"],
          [".results[1].booking.attendees[0].card_refunded_amount", "0"],
          [".results[1].booking.attendees[1].refunded_amount", "0"],
          [".results[1].booking.attendees[1].card_refunded_amount", "0"],
          [".results[1].warning", "The places are cancelled and £50.00 went back to the card, but the refund couldn't be finished on the booking yet. It's on hold: don't refund it again. Check the Orders page in a few minutes."],
          [".results[1].held", true],
          [".tables.event_attendees.added[0].refunded_amount", "0.00"],
          [".tables.event_attendees.added[0].card_refunded_amount", "0.00"],
          [".tables.event_attendees.added[1].refunded_amount", "0.00"],
          [".tables.event_attendees.added[1].card_refunded_amount", "0.00"],
          [".tables.order_line_items.added[0].refunded_at", GONE],
          [".tables.order_line_items.added[0].refund_method", GONE],
          [".tables.order_line_items.added[0].card_refunded_amount", "0.00"],
          [".tables.orders.added[0].payment_status", "paid"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-changed-by-someone-else-a-place-checked-in-meanwhile",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "The check-in is hooked between the old code's quote and its recording statement, after its card refund had gone. The Worker's quote and cancel are one transaction and nothing is sent until it commits, so the hook never opens here: the place is cancelled and its £40 refunded once. A check-in that really lands at the same moment refuses the whole cancel before anything is sent (cancel-places-postgres.test.ts). (The old code left £40 back on the card and the place still booked and checked in.)",
        'W27 review L8 (a known fault, closed by design); bug E13; E-plan 4.4 (R1 before anything is sent; R1\'s own guard refuses a place checked in at the same moment)',
        [
          [".results[1].ok", true],
          [".results[1].reason", GONE],
          [".results[1].message", GONE],
          [".results[1].warning", GONE],
          [".results[1].places", 1],
          [".results[1].refundedAmount", 40],
          [".results[1].cardRefundedAmount", 40],
          [".results[1].storeCreditRefundedAmount", 0],
          [".results[1].booking", booking("confirmed", 1)],
          [".results[1].eventPlacesBooked", 1],
          [".tables.event_attendees.added[0].checked_in_at", GONE],
          [".tables.event_attendees.added[0].cancelled_at", "<set>"],
          [".tables.event_attendees.added[0].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.event_attendees.added[0].cancelled_value", "40.00"],
          [".tables.event_attendees.added[0].refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].card_refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].refund_method", "card"],
          [".tables.event_bookings.added[0].places", 1],
          [".tables.events.changed[0].places_booked[1]", 1],
          [".tables.orders.added[0].payment_status", "partially_refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-recording-fails-after-the-card-refund",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "The place's stamp is in R1, before anything is sent: when it fails, nothing is sent and nothing is cancelled (`cancel_not_saved`), and the next press makes the one £40 refund. (The old code refunded £40, failed to record the cancel, kept the money \"unallocated\" on the line, and the next press used it up.)",
        `${W30} item 2 (R1 before anything is sent; bug E13)`,
        [
          [".results[1].reason", "cancel_not_saved"],
          [".results[1].message", "The cancellation couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was cancelled. Try again."],
          [".results[1].warning", GONE],
          [".results[2].cardRefundedAmount", 40],
          [".tables.orders.added[0].payment_status", "partially_refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-recording-fails-to-store-credit-is-taken-back",
    [
      pinned(
        "No store credit row is ever written: the stamp failing rolls back the whole of R1 (the old code gave £40 of store credit, then took it back)",
        `${W30}: R1 is one transaction (W05 review 2, item 9; W05k later 3: no take-backs)`,
        [
          [".results[1].reason", "cancel_not_saved"],
          [".results[1].message", "The cancellation couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was cancelled. Try again."],
          [".results[1].warning", GONE],
          [".tables.store_credit_transactions", GONE],
        ]
      ),
    ],
  ],
  [
    "w27-e8-event-with-no-cut-off-counts-as-after-it",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "Q43 / bug E8: an event with no cut-off uses its start. Three weeks before it, the quote says before the cut-off, the refund needs no reason and is not recorded as an exception; the next press finds the place already cancelled. (The old code refused it without a reason, and with one recorded it as after the cut-off.)",
        "Wayne's Q43 (14 Nov): an event with no cut-off uses its start as the cut-off; bug E8",
        [
          [".results[1].beforeCutoff", true],
          [".results[2].ok", true],
          [".results[2].reason", GONE],
          [".results[2].message", GONE],
          [".results[2].places", 1],
          [".results[2].refundedAmount", 40],
          [".results[2].cardRefundedAmount", 40],
          [".results[2].storeCreditRefundedAmount", 0],
          [".results[2].booking", booking("confirmed", 1)],
          [".results[2].eventPlacesBooked", 1],
          [".results[3].ok", false],
          [".results[3].places", GONE],
          [".results[3].refundedAmount", GONE],
          [".results[3].cardRefundedAmount", GONE],
          [".results[3].storeCreditRefundedAmount", GONE],
          [".results[3].booking", GONE],
          [".results[3].eventPlacesBooked", GONE],
          [".results[3].reason", "already_cancelled"],
          [".results[3].message", "One of the places has already been cancelled."],
          [".tables.event_attendees.added[0].cancel_reason", GONE],
          [".tables.event_attendees.added[0].refund_after_cutoff", false],
        ]
      ),
    ],
  ],
  [
    "w27-e9-figure-changes-between-the-quote-and-the-press",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "Q18 / bug E9: the dialog showed the whole booking's £115, another tab cancelled a place, and the press is refused `figures_changed` with the quote as it now stands (£76.66 for the two places left). Nothing more is cancelled or refunded. (The old code gave back £76.66 without saying the figure had changed.)",
        'Q18 (the confirmed refund is required and checked to half a penny); bug E9; E-plan 4.7',
        [
          [".results[3].ok", false],
          [".results[3].places", GONE],
          [".results[3].refundedAmount", GONE],
          [".results[3].cardRefundedAmount", GONE],
          [".results[3].storeCreditRefundedAmount", GONE],
          [".results[3].booking", GONE],
          [".results[3].eventPlacesBooked", GONE],
          [".results[3].reason", "figures_changed"],
          [".results[3].message", "The figures on this event booking have just changed. Check them and confirm again."],
          [".results[3].quote", quoteOf(76.66, 2)],
          [".stripeCalls[2]", GONE],
          [".tables.event_attendees.added[1].cancelled_at", GONE],
          [".tables.event_attendees.added[1].cancelled_by", GONE],
          [".tables.event_attendees.added[1].cancelled_value", "0.00"],
          [".tables.event_attendees.added[1].refunded_amount", "0.00"],
          [".tables.event_attendees.added[1].card_refunded_amount", "0.00"],
          [".tables.event_attendees.added[1].refund_method", GONE],
          [".tables.event_attendees.added[2].cancelled_at", GONE],
          [".tables.event_attendees.added[2].cancelled_by", GONE],
          [".tables.event_attendees.added[2].cancelled_value", "0.00"],
          [".tables.event_attendees.added[2].refunded_amount", "0.00"],
          [".tables.event_attendees.added[2].card_refunded_amount", "0.00"],
          [".tables.event_attendees.added[2].refund_method", GONE],
          [".tables.event_bookings.added[0].places", 2],
          [".tables.event_bookings.added[0].status", "confirmed"],
          [".tables.event_bookings.added[0].cancelled_at", GONE],
          [".tables.event_bookings.added[0].cancelled_by", GONE],
          [".tables.order_line_items.added[0].refunded_at", GONE],
          [".tables.order_line_items.added[0].refund_method", GONE],
          [".tables.order_line_items.added[0].card_refunded_amount", "38.34"],
          [".tables.orders.added[0].payment_status", "partially_refunded"],
          [".tables.events", placesBooked(0, 2)],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-answer-lost-then-pressed-again",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "The route ran to the end and only its answer was lost: the place is cancelled and its £40 refunded once; the dialog says no answer came and keeps its key; the same press again gets the first press's answer, and nothing is sent again",
        LOST_ANSWER,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].noAnswer", true],
          [".results[2].cardRefundedAmount", 40],
          [".stripeCalls[2]", GONE],
          [".tables.orders.added[0].payment_status", "partially_refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-answer-lost-then-another-place-to-store-credit",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "The first place's cancel ran to the end (£40 to the card) and only its answer was lost. The other place then goes to store credit, as asked (£40); pressing the first place again gets the first press's stored answer. £40 to the card and £40 of store credit for two places. (The old code settled the held refund first and recorded its card money on the second place, then refunded the first again: £80 to the card and no store credit, though store credit was chosen.)",
        `${LOST_ANSWER}; W05j call 1`,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].noAnswer", true],
          [".results[2].storeCreditRefundedAmount", 40],
          [".results[2].booking.status", "cancelled"],
          [".results[2].booking.places", 0],
          [".results[2].booking.cancelled_at", "<time>"],
          [".results[2].booking.attendees[0].cancelled_at", "<time>"],
          [".results[2].booking.attendees[0].cancelled_by_name", "Jo Staff"],
          [".results[2].booking.attendees[0].cancelled_value", "40"],
          [".results[2].booking.attendees[0].refunded_amount", "40"],
          [".results[2].booking.attendees[0].card_refunded_amount", "40"],
          [".results[2].booking.attendees[0].refund_method", "card"],
          [".results[2].booking.attendees[1].card_refunded_amount", "0"],
          [".results[2].booking.attendees[1].refund_method", "credit"],
          [".results[2].eventPlacesBooked", 0],
          [".results[2].storeCreditBalance", 70],
          [".results[3].booking.status", "confirmed"],
          [".results[3].booking.places", 1],
          [".results[3].booking.cancelled_at", GONE],
          [".results[3].booking.attendees[1].cancelled_at", GONE],
          [".results[3].booking.attendees[1].cancelled_by_name", GONE],
          [".results[3].booking.attendees[1].cancelled_value", "0"],
          [".results[3].booking.attendees[1].refunded_amount", "0"],
          [".results[3].booking.attendees[1].card_refunded_amount", "0"],
          [".results[3].booking.attendees[1].refund_method", GONE],
          [".results[3].eventPlacesBooked", 1],
          [".stripeCalls[2]", GONE],
          [".stripeCalls[3]", GONE],
          [".tables.event_attendees.added[1].card_refunded_amount", "0.00"],
          [".tables.event_attendees.added[1].refund_method", "credit"],
          [".tables.order_line_items.added[0].card_refunded_amount", "40.00"],
          [".tables.customers", storeCreditBalance("30.00", "70.00")],
          [".tables.store_credit_transactions", creditRefunds(["40.00"])],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-answer-lost-then-no-refund-chosen",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "The first press ran to the end (the place cancelled, £40 to the card) and only its answer was lost. A changed press under the kept key (No refund now) is refused, nothing done: the dialog says to close, reload and check. (The old code settled the held refund first and then recorded the place with the £40 card money, though No refund was chosen.)",
        LOST_ANSWER,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].noAnswer", true],
          [".results[2].ok", false],
          [".results[2].places", GONE],
          [".results[2].refundedAmount", GONE],
          [".results[2].cardRefundedAmount", GONE],
          [".results[2].storeCreditRefundedAmount", GONE],
          [".results[2].booking", GONE],
          [".results[2].eventPlacesBooked", GONE],
          [".results[2].reason", "pressed_after_no_answer"],
          [".results[2].message", "The last press didn't get an answer, so this can't be sent as a new one. Close this, reload the attendee list and check whether the places were cancelled before trying again."],
          [".results[2].noAnswer", true],
          [".stripeCalls[2]", GONE],
          [".tables.orders.added[0].payment_status", "partially_refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-answer-lost-then-store-credit-chosen",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "The first press ran to the end (the place cancelled, £40 to the card) and only its answer was lost. A changed press under the kept key (store credit now) is refused, nothing done. (The old code settled the held refund first and recorded the place with the card money.)",
        LOST_ANSWER,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].noAnswer", true],
          [".results[2].ok", false],
          [".results[2].places", GONE],
          [".results[2].refundedAmount", GONE],
          [".results[2].cardRefundedAmount", GONE],
          [".results[2].storeCreditRefundedAmount", GONE],
          [".results[2].booking", GONE],
          [".results[2].eventPlacesBooked", GONE],
          [".results[2].reason", "pressed_after_no_answer"],
          [".results[2].message", "The last press didn't get an answer, so this can't be sent as a new one. Close this, reload the attendee list and check whether the places were cancelled before trying again."],
          [".results[2].noAnswer", true],
          [".stripeCalls[2]", GONE],
          [".tables.orders.added[0].payment_status", "partially_refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-died-after-the-refund-then-pressed-again",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "The route ran to the end (the place cancelled, £40 to the card, recorded) and the function died before its answer came back: no answer, the key kept, and the same press again gets the stored answer. One refund. (The old code died with the refund sent and nothing recorded, and the next press got its first refund back by its key.)",
        LOST_ANSWER,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].warning", GONE],
          [".results[1].noAnswer", true],
          [".stripeCalls[2]", GONE],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-died-on-one-place-then-the-other-at-the-same-figures",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "Bug E13 is closed: the first place's cancel is saved before its refund is sent, so it stands (cancelled, £40 to the card) though its answer was lost. The other place then cancels with its own £40, and pressing the first again gets its stored answer: £80 back for two places cancelled. (The old code left £80 back on the card with one place still booked, and the first place's own cancel refused by Stripe.)",
        `Bug E13 (W27 report, "For the Worker step"); ${W30} item 2; ${LOST_ANSWER}`,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].warning", GONE],
          [".results[1].noAnswer", true],
          [".results[2].booking.status", "cancelled"],
          [".results[2].booking.places", 0],
          [".results[2].booking.cancelled_at", "<time>"],
          [".results[2].booking.attendees[0].cancelled_at", "<time>"],
          [".results[2].booking.attendees[0].cancelled_by_name", "Jo Staff"],
          [".results[2].booking.attendees[0].cancelled_value", "40"],
          [".results[2].booking.attendees[0].refunded_amount", "40"],
          [".results[2].booking.attendees[0].card_refunded_amount", "40"],
          [".results[2].booking.attendees[0].refund_method", "card"],
          [".results[2].eventPlacesBooked", 0],
          [".results[3].ok", true],
          [".results[3].reason", GONE],
          [".results[3].message", GONE],
          [".results[3].places", 1],
          [".results[3].refundedAmount", 40],
          [".results[3].cardRefundedAmount", 40],
          [".results[3].storeCreditRefundedAmount", 0],
          [".results[3].booking", booking("confirmed", 1)],
          [".results[3].eventPlacesBooked", 1],
          [".stripeCalls[3]", GONE],
          [".tables.event_attendees.added[0].cancelled_at", "<set>"],
          [".tables.event_attendees.added[0].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.event_attendees.added[0].cancelled_value", "40.00"],
          [".tables.event_attendees.added[0].refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].card_refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].refund_method", "card"],
          [".tables.event_bookings.added[0].places", 0],
          [".tables.event_bookings.added[0].status", "cancelled"],
          [".tables.event_bookings.added[0].cancelled_at", "<set>"],
          [".tables.event_bookings.added[0].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.events", GONE],
          [".tables.order_line_items.added[0].refunded_at", "<set>"],
          [".tables.order_line_items.added[0].refund_method", "card"],
          [".tables.order_line_items.added[0].card_refunded_amount", "80.00"],
          [".tables.orders.added[0].payment_status", "refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-still-no-clear-answer-on-the-next-press",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "One refund in all. The first press ran to the end and its answer was lost; a changed press under the kept key (store credit) is refused, nothing done; the same press again gets the stored answer. (The old code sent the refund on each press.)",
        LOST_ANSWER,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].noAnswer", true],
          [".results[2].reason", "pressed_after_no_answer"],
          [".results[2].message", "The last press didn't get an answer, so this can't be sent as a new one. Close this, reload the attendee list and check whether the places were cancelled before trying again."],
          [".results[2].noAnswer", true],
          [".results[3].cardRefundedAmount", 40],
          [".stripeCalls[2]", GONE],
          [".stripeCalls[3]", GONE],
          [".tables.orders.added[0].payment_status", "partially_refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-held-record-fails-too",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "There is no held record to fail, so no warning about it: the route ran to the end, its answer was lost, and the same press again gets the stored answer",
        `${LOST_ANSWER}; W05j call 1`,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].warning", GONE],
          [".results[1].noAnswer", true],
          [".stripeCalls[2]", GONE],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-never-reached-stripe-then-two-days-later",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "A refund Stripe never received is sent once more by the same press, under the same key, and goes: the first place is cancelled and refunded at once. Two days later the other place cancels (the booking with it), and the first place's cancel is refused: the booking is already cancelled. £80 back for two places, with no look in Stripe. (The old code held the first press, then looked in Stripe two days later, found nothing and refunded each.)",
        `${BY_DESIGN}; the shared pipeline's rule (pipeline.ts, sendCardPart: sent once more under its key), as W28's difference 25`,
        [
          [".results[1].ok", true],
          [".results[1].reason", GONE],
          [".results[1].message", GONE],
          [".results[1].places", 1],
          [".results[1].refundedAmount", 40],
          [".results[1].cardRefundedAmount", 40],
          [".results[1].storeCreditRefundedAmount", 0],
          [".results[1].booking", booking("confirmed", 1)],
          [".results[1].eventPlacesBooked", 1],
          [".results[2].booking.status", "cancelled"],
          [".results[2].booking.places", 0],
          [".results[2].booking.cancelled_at", "<time>"],
          [".results[2].booking.attendees[0].cancelled_at", "<time>"],
          [".results[2].booking.attendees[0].cancelled_by_name", "Jo Staff"],
          [".results[2].booking.attendees[0].cancelled_value", "40"],
          [".results[2].booking.attendees[0].refunded_amount", "40"],
          [".results[2].booking.attendees[0].card_refunded_amount", "40"],
          [".results[2].booking.attendees[0].refund_method", "card"],
          [".results[2].eventPlacesBooked", 0],
          [".results[3].ok", false],
          [".results[3].places", GONE],
          [".results[3].refundedAmount", GONE],
          [".results[3].cardRefundedAmount", GONE],
          [".results[3].storeCreditRefundedAmount", GONE],
          [".results[3].booking", GONE],
          [".results[3].eventPlacesBooked", GONE],
          [".results[3].reason", "booking_not_confirmed"],
          [".results[3].message", "This event booking has already been cancelled."],
          [".stripeCalls[2].method", "refunds.create"],
          [".stripeCalls[2].params.limit", GONE],
          [".stripeCalls[2].params.amount", 4000],
          [".stripeCalls[2].params.metadata", CLAIM_METADATA],
          [".stripeCalls[4]", GONE],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-held-two-days-and-the-look-fails",
    [
      EVENT_CLAIM_KEYS,
      pinned(
        "The first press ran to the end (the place cancelled, £40 to the card, recorded) and only its answer was lost, so there is no look in Stripe to fail two days later: the other place cancels with its own £40. (The old code had refunded £40 it never recorded, and refused the next press when its look failed.)",
        `W27 review L8 (a known fault, closed by design); ${LOST_ANSWER}`,
        [
          [".results[1].reason", "no_answer"],
          [".results[1].message", "The cancellation didn't get an answer, so it may or may not have gone through. Don't start a new one: press again here (it won't cancel or refund twice), or close this and check the attendee list first."],
          [".results[1].noAnswer", true],
          [".results[2].ok", true],
          [".results[2].reason", GONE],
          [".results[2].message", GONE],
          [".results[2].places", 1],
          [".results[2].refundedAmount", 40],
          [".results[2].cardRefundedAmount", 40],
          [".results[2].storeCreditRefundedAmount", 0],
          [".results[2].booking", booking("cancelled", 0)],
          [".results[2].eventPlacesBooked", 0],
          [".stripeCalls[2].method", "refunds.create"],
          [".stripeCalls[2].params.limit", GONE],
          [".stripeCalls[2].params.amount", 4000],
          [".stripeCalls[2].params.metadata", CLAIM_METADATA],
          [".tables.event_attendees.added[0].cancelled_at", "<set>"],
          [".tables.event_attendees.added[0].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.event_attendees.added[0].cancelled_value", "40.00"],
          [".tables.event_attendees.added[0].refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].card_refunded_amount", "40.00"],
          [".tables.event_attendees.added[0].refund_method", "card"],
          [".tables.event_attendees.added[1].cancelled_at", "<set>"],
          [".tables.event_attendees.added[1].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.event_attendees.added[1].cancelled_value", "40.00"],
          [".tables.event_attendees.added[1].refunded_amount", "40.00"],
          [".tables.event_attendees.added[1].card_refunded_amount", "40.00"],
          [".tables.event_attendees.added[1].refund_method", "card"],
          [".tables.event_bookings.added[0].places", 0],
          [".tables.event_bookings.added[0].status", "cancelled"],
          [".tables.event_bookings.added[0].cancelled_at", "<set>"],
          [".tables.event_bookings.added[0].cancelled_by", "10000000-0000-4000-8000-000000000001"],
          [".tables.events", GONE],
          [".tables.order_line_items.added[0].refunded_at", "<set>"],
          [".tables.order_line_items.added[0].refund_method", "card"],
          [".tables.order_line_items.added[0].card_refunded_amount", "80.00"],
          [".tables.orders.added[0].payment_status", "refunded"],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-store-credit-that-cannot-be-looked-for-counts-as-given",
    [
      pinned(
        "The store credit is given once, inside R1, and answered with the balance: there is nothing to look for, so no \"counted as given\" warning",
        `${BY_DESIGN}; W05j call 2`,
        [
          [".results[1].warning", GONE],
          [".results[1].storeCreditBalance", 70],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-store-credit-cannot-be-looked-for-then-recording-fails",
    [
      pinned(
        "Nothing is given: the place's stamp failing rolls back the store credit with it (`cancel_not_saved`). (The old code left £40 of store credit it couldn't check, with a warning to look at the balance.)",
        `${BY_DESIGN}; W05j call 2; W05 review 2, item 9`,
        [
          [".results[1].reason", "cancel_not_saved"],
          [".results[1].message", "The cancellation couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was cancelled. Try again."],
          [".results[1].warning", GONE],
          [".tables.customers", GONE],
          [".tables.store_credit_transactions", GONE],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-recording-fails-and-the-take-back-answer-is-lost",
    [
      pinned(
        "No store credit row is ever written, so there is nothing to take back and no take-back answer to lose",
        `${BY_DESIGN}; W05k later 3`,
        [
          [".results[1].reason", "cancel_not_saved"],
          [".results[1].message", "The cancellation couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was cancelled. Try again."],
          [".results[1].warning", GONE],
          [".tables.store_credit_transactions", GONE],
        ]
      ),
    ],
  ],
  [
    "w27-event-cancel-refused-while-its-reader-payment-is-open",
    [
      pinned(
        'W58: the in-progress words say "A payment is still in progress…": a saved-card payment is held the same way as a reader one (the old words said "A card reader payment")',
        'Brief W58 (W35 audit row 22; W31 "Noticed" 3)',
        [
          [".results[1].message", "A payment is still in progress for this booking. Finish or cancel it first."],
          [".results[2].message", "A payment is still in progress for this booking. Finish or cancel it first."],
        ]
      ),
    ],
  ],
])
