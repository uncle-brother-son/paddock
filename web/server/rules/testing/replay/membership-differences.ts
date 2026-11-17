import type { AllowedDifference } from './compare'
import { notSent } from './customer-differences'

/*
 * W40 (brief item 9; F-plan 4.12 items 3 and 4): the membership cancel family and the membership reads (W36's
 * recordings) through the Worker's routes, driven as the dialog presses them, and the only differences allowed in
 * each, every one tied to a decision. A scenario not named in W40_DIFFERENCES must match its golden file exactly; an
 * allowance that stops being needed fails (compareRecordings).
 *
 * Each named difference is pinned: every path it allows carries the one value the new routes give there, so a path
 * that differs in any other way is not allowed. Written by hand from a dump of the replay's raw differences
 * (briefs/W40-logs/membership-differences-first-pass.jsonl, staff app repo), each read against the design.
 */

/**
 * W40's golden families: the cancel and its undo, FB5, FB6, the Subscriptions list, and the recording that reads the
 * list and the profile round a cancel. (`w36-customer-detail` is the profile alone: customer-replay.test.ts, W39.)
 */
export const isW40Scenario = (name: string): boolean => /^w36-(cancel-|undo-|fb5-|fb6-|subscriptions-list-and-search$|membership-reads-carry-the-payment-date-refusal$)/.test(name)

const W40 = 'Brief W40 (F-plan 4.3)'
const STAFF_FIRST = `${W40}; bug FB20 (F-plan section 3: the permission comes from the signed-in staff member; every /api/v1/staff route refuses someone with no staff record or an inactive account before anything else, as steps C to E)`
const FB5 = `Bug FB5 (F-plan section 3); ${W40} (M1 checks the membership's state under its lock, with the words the dialog already holds)`
const FB6 = `Bug FB6 (F-plan section 3); Wayne's Q33, 9 Nov (dates "N months on" clamp to the month's last day); ${W40}`
const RENEWAL_DAY = "Wayne, 16 Nov (brief W40a item 3; W40 review L1): a cancel when the next renewal date is today or earlier in London is refused before anything is written, until the payment has gone through"
const DATABASE_FIRST = `${W40} ("Why the database first": a record before any Stripe call; M1 is one transaction, so a write that fails leaves nothing changed and nothing sent); W20a's rule (a fault is no answer, the key is kept)`

type Matcher = (value: unknown) => boolean
/** The path holds nothing on the new side (the old side's value is gone). */
const GONE: Matcher = (value) => value === undefined || value === null
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

/** The staff app's own words for a press that got no answer (a copy of shared/accountWorker.ts's; the replay test holds the two together). */
export const MEMBERSHIP_CANCEL_NO_ANSWER_MESSAGE =
  "The change didn't get an answer, so the membership may or may not have changed. Press again here (it won't apply twice), or close this and check the membership's status first."
export const NO_STAFF_RECORD_WORDS = "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."
export const INACTIVE_WORDS = 'This staff account is inactive. Ask an admin to reactivate it.'
/** The rule's own sentence for FB22 (memberships/failure-messages.ts; the replay test holds the two together). */
export const NO_RENEWAL_DATE_WORDS = "This membership has no next payment date, so the day it would end can't be worked out. Nothing was changed. Tell a manager."
/** W40a (Wayne, 16 Nov): a cancel on the day the renewal is due, or while it is overdue. */
export const RENEWAL_DUE_WORDS =
  "Today's payment for this membership hasn't gone through yet, so it can't be cancelled until it has. Try again after the payment (the membership will then end at its next renewal)."
export const NOT_ACTIVE_WORDS = 'This membership is not currently active.'
export const ALREADY_CANCELLING_WORDS = 'This membership is already scheduled to cancel.'
export const NOT_CANCELLING_WORDS = 'This membership has no pending cancellation to undo.'

// --- What is sent to Stripe

/** A key from the step's id. The step is no row of its own, so the comparator labels its id `gone#N`. */
const stepKey: Matcher = (value) => typeof value === 'string' && /^gone#\d+:cancel-at$/.test(value)

const sendPins = (index: number): ReadonlyArray<readonly [string, Pin]> => [
  [`.stripeCalls[${index}].params.proration_behavior`, 'none'],
  [`.stripeCalls[${index}].idempotencyKey`, stepKey],
]

/**
 * Every cancel date sent or cleared. The old routes sent `cancel_at` alone, with no key. The Worker sends it with
 * `proration_behavior: 'none'`, so an end inside a paid period never bills or credits a part period, and under a key
 * from its step's id, so a repeat of the same send can't apply twice. (The read before each send is set aside and
 * checked on its own: stripeReadProblems.)
 */
const sent = (...indexes: number[]): AllowedDifference =>
  pinned(
    "What Stripe is sent: each cancel date goes with `proration_behavior: 'none'` and under a key from its step's id, where the old routes sent `cancel_at` alone with no key. The subscription, the date and the order of the sends are as they were",
    'W36 review L1 (no proration with `cancel_at`; brief W40 item 4); F-plan 4.2 item 4 (Stripe after the transaction, under a key from the record\'s id)',
    indexes.flatMap(sendPins)
  )

// --- Who may

const NO_STAFF_RECORD = pinned(
  'No staff record: refused with the words every staff route gives for it, where the old function said the Issue refunds sentence (it took a missing record for a missing permission). Still `permission_denied`, nothing changed',
  STAFF_FIRST,
  [['.results[0].message', NO_STAFF_RECORD_WORDS]]
)
const INACTIVE = pinned(
  'An inactive account: refused as data (`permission_denied`, the same words), where the old function threw them. Nothing changed',
  STAFF_FIRST,
  [
    ['.results[0].thrown', GONE],
    ['.results[0].updated', false],
    ['.results[0].reason', 'permission_denied'],
    ['.results[0].message', INACTIVE_WORDS],
  ]
)

// --- Stripe says no, the database fails, an answer is lost

const stripeRefused = (index: number, what: string): AllowedDifference =>
  pinned(
    `${what}: the refusal carries a reason (\`stripe_refused\`) beside Stripe's own words, which are as they were. The membership is as it was before the press (M1 is put back in one transaction), as the old order left it by never writing`,
    `${W40} ("Refused: M1 undone in one transaction; Stripe's reason shown with the old words"); F-plan 4.2 item 5`,
    [[`.results[${index}].reason`, 'stripe_refused']]
  )

const noAnswer = (index: number): ReadonlyArray<readonly [string, Pin]> => [
  [`.results[${index}].message`, MEMBERSHIP_CANCEL_NO_ANSWER_MESSAGE],
  [`.results[${index}].reason`, 'no_answer'],
  [`.results[${index}].noAnswer`, true],
]

/**
 * The membership row's write fails. The old route had already changed Stripe (the cancel date set, or cleared) and
 * then told staff "Failed to update membership record": Stripe and the membership disagreed until the webhook's event
 * repaired the row. Now the row's write is in M1, before Stripe: when it fails nothing is changed and nothing is
 * sent. The press is told no answer (a fault never says "nothing happened"), and keeps its key.
 */
const databaseFirst = (index: number, lostSend: number, what: string): AllowedDifference =>
  pinned(
    `${what}: the membership's write is in M1, before Stripe, so when it fails nothing has changed and Stripe is sent nothing. The press is told no answer and keeps its key. (The old route had already changed Stripe, and said "Failed to update membership record" with the two out of step.)`,
    DATABASE_FIRST,
    [...noAnswer(index), [`.stripeCalls[${lostSend}]`, GONE]]
  )

/**
 * The Worker did the work and its answer was lost; staff press again. The old function's second press ran the whole
 * thing again (a second send to Stripe). The dialog now sends the second press under the first's key, so it gets the
 * first press's answer: one change, one send. What staff end up seeing is the same success.
 */
const answerLost = (index: number, secondSend: number, what: string): AllowedDifference =>
  pinned(
    `${what}: the press whose answer was lost is told so in the dialog's own words and keeps its key; the same press again gets the first press's answer, so Stripe is sent the change once. (The old function showed "socket hang up", and its second press sent the change to Stripe again.)`,
    `${W40}; F-plan 4.2 item 2 (every write route takes a press key, kept by the dialog after no answer; a repeat answers what the first press did); W20a's rule`,
    [...noAnswer(index), [`.stripeCalls[${secondSend}]`, GONE]]
  )

// --- The bugs (F-plan section 3; the W36 report for FB22)

/**
 * FB22. The seed's membership has no next payment date. The old route's date sum failed on it, and staff saw
 * "Internal server error: Cannot read properties of null (reading 'split')"; the member kept paying until someone
 * fixed the row by hand. Now it is refused in plain words, with a reason, and nothing is changed.
 */
const FB22_NO_RENEWAL_DATE = pinned(
  'Bug FB22 is closed: a membership with no next payment date is refused in plain words (`no_renewal_date`), where the old route failed with "Cannot read properties of null (reading \'split\')". Nothing is changed, as before',
  'Bug FB22 (W36 report "For the Worker step"); brief W40 item 4 (refused in plain words, never a fault)',
  [
    ['.results[0].message', NO_RENEWAL_DATE_WORDS],
    ['.results[0].reason', 'no_renewal_date'],
  ]
)

/** The answer of a press the old code let through and M1 now refuses, with the dialog's own words for the reason. */
const refusedNow = (index: number, reason: string, message: string, was: { endDate?: true; stripeUpdated?: true }): ReadonlyArray<readonly [string, Pin]> => [
  [`.results[${index}].updated`, false],
  [`.results[${index}].membership`, GONE],
  ...(was.endDate ? [[`.results[${index}].endDate`, GONE] as const] : []),
  ...(was.stripeUpdated ? [[`.results[${index}].stripeUpdated`, GONE] as const] : []),
  [`.results[${index}].reason`, reason],
  [`.results[${index}].message`, message],
]

const FB5_CANCELLED = pinned(
  "Bug FB5 is closed: a cancel on a membership that is already cancelled is refused (`not_active`, the dialog's words), and its last day is not written. (The old route wrote 9 December on a membership that had ended.)",
  FB5,
  [...refusedNow(0, 'not_active', NOT_ACTIVE_WORDS, { endDate: true, stripeUpdated: true }), ['.tables.customer_memberships', GONE]]
)
const FB5_PAYMENT_FAILING = pinned(
  "Bug FB5 is closed: a cancel on a membership whose payment is failing is refused (`not_active`, the dialog's words): nothing is written and Stripe is sent nothing. (The old route scheduled the cancel.)",
  FB5,
  [...refusedNow(0, 'not_active', NOT_ACTIVE_WORDS, { endDate: true, stripeUpdated: true }), ['.stripeCalls[0]', GONE], ['.tables.customer_memberships', GONE]]
)
const FB5_CANCEL_TWICE = pinned(
  "Bug FB5 is closed: a second cancel on a membership already scheduled to cancel is refused (`already_cancelling`, the dialog's words), and Stripe is sent the date once. (The old route sent it again and answered a second success.)",
  FB5,
  [...refusedNow(1, 'already_cancelling', ALREADY_CANCELLING_WORDS, { endDate: true, stripeUpdated: true }), ['.stripeCalls[1]', GONE]]
)
const FB5_UNDO_NOTHING = pinned(
  "Bug FB5 is closed: an undo with no cancel scheduled is refused (`not_cancelling`, the dialog's words), and Stripe is sent nothing. (The old route cleared a date that wasn't there, in Stripe too, and answered a success.)",
  FB5,
  [...refusedNow(0, 'not_cancelling', NOT_CANCELLING_WORDS, {}), ['.stripeCalls[0]', GONE]]
)
/**
 * FB5's £ example. Mo's membership ended yesterday and has no subscription. A credit booking is refused. The old undo
 * then cleared the end date, and the same credit booking went through: a £20 session for no payment, on a membership
 * that reads as running again. Now the undo is refused (the cancellation is no longer pending), the end date stays,
 * and the second credit booking is refused as the first was: no order, no booking, no place taken.
 */
const FB5_ENDED_YESTERDAY = pinned(
  'Bug FB5 is closed: an undo on a membership whose last day was yesterday is refused (`not_cancelling`): its end date stays, and the credit booking that follows is refused as before the undo (no order, booking or place). (The old route cleared the end date, and the booking then went through: a £20 session for no payment.)',
  FB5,
  [
    ...refusedNow(1, 'not_cancelling', NOT_CANCELLING_WORDS, {}),
    ['.results[2].success', false],
    ['.results[2].orderId', GONE],
    ['.results[2].bookingId', GONE],
    ['.results[2].cardCharged', GONE],
    ['.results[2].cardAmount', GONE],
    ['.results[2].paymentMethodUsed', GONE],
    ['.results[2].stage', 'booking'],
    ['.results[2].reason', 'membership_not_found'],
    ['.results[2].bookingFailureReason', 'membership_not_found'],
    ['.tables.booking_guests', GONE],
    ['.tables.bookings', GONE],
    ['.tables.customer_memberships', GONE],
    ['.tables.order_line_items', GONE],
    ['.tables.orders', GONE],
    ['.tables.sessions', GONE],
  ]
)
const FB5_ENDED_IN_STRIPE = pinned(
  "Bug FB5 is closed: an undo on a membership whose last day was yesterday, with a subscription Stripe has already ended, is refused by M1 (`not_cancelling`, the dialog's words) before Stripe is asked. (The old route asked Stripe, and showed Stripe's own refusal.)",
  FB5,
  [
    ['.results[0].message', NOT_CANCELLING_WORDS],
    ['.results[0].reason', 'not_cancelling'],
    ['.stripeCalls[0]', GONE],
  ]
)

/**
 * FB6 (Q33). Started 31 December, cancelled in January: the minimum term is two payments, so it ends two months on.
 * The old sum rolled over a month with no 31st: 3 March (last day 2 March). Stripe would then have renewed on
 * 28 February for the days to 3 March: about £3.87 more on a £40 plan than the two payments agreed. Clamped, the end
 * is 28 February (last day 27 February). `seconds` is London midnight on the new end date.
 */
const fb6 = (was: string, lastDay: string, endDate: string, seconds: number): AllowedDifference =>
  pinned(
    `Bug FB6 is closed (Q33): the monthly minimum term ends on the month's last day when the month has no such day: the end is ${endDate} (last day ${lastDay}), and Stripe is sent that midnight. (The old sum rolled over to ${was}.)`,
    FB6,
    [
      ['.results[0].membership.cancel_effective_date', lastDay],
      ['.results[0].endDate', endDate],
      ['.stripeCalls[0].params.cancel_at', seconds],
      ['.tables.customer_memberships.changed[0].cancel_effective_date[1]', lastDay],
    ]
  )
const FB6_31_DECEMBER = fb6('3 March', '2027-02-27', '2027-02-28', Date.UTC(2027, 1, 28) / 1000)

/**
 * W40a, the renewal day (Wayne, 16 Nov). The old recording made for FB6's 31 July start cancels, on 10 November, a
 * membership whose second payment (31 August) was never recorded as taken: its renewal is overdue. The old route
 * scheduled it to end on 1 October, a day already past, and sent Stripe that past `cancel_at`: Stripe either refuses
 * it or ends the subscription at once with the overdue £40 never taken. Now the cancel is refused in plain words
 * until the payment has gone through, and nothing is written or sent. (FB6's clamp for a 31 July start, 30 September,
 * is held by the rule's own sum in memberships/cancel.test.ts; the 31 December recording holds it here.)
 */
const RENEWAL_DUE_31_JULY = pinned(
  'The renewal day (W40a): a cancel on a membership whose renewal is due today or overdue is refused (`renewal_due_today`) in plain words: nothing is written and Stripe is sent nothing. (The old route scheduled an end already past, 1 October, and sent Stripe that past date.)',
  RENEWAL_DAY,
  [...refusedNow(0, 'renewal_due_today', RENEWAL_DUE_WORDS, { endDate: true, stripeUpdated: true }), ['.stripeCalls[0]', GONE], ['.tables.customer_memberships', GONE]]
)

// --- The reads (W35 row 10)

/**
 * `refunded` on each membership row. New, and `false` on these recordings (nothing in them is refunded);
 * memberships/cancel.test.ts holds the `true` case on the list and the profile alike.
 */
const refundedMark = (paths: readonly string[]): AllowedDifference =>
  pinned(
    'W35 row 10: each membership row now carries `refunded`, worked out from the membership\'s own order line (false here: none of these was refunded), so the screens can say "Refunded" in place of "Cancelled". Every other field of every row is as it was',
    'Brief W40 item 5; W35 row 10; lead call L9 (worked out from the order line, no new column)',
    paths.map((path) => [path, false] as const)
  )

/** The scenarios each decision names, for the test that holds every one to its own allowance. */
export const DECISION_SCENARIOS = {
  FB5: [
    'w36-fb5-cancel-on-a-cancelled-membership',
    'w36-fb5-cancel-on-a-membership-whose-payment-is-failing',
    'w36-fb5-cancel-twice',
    'w36-fb5-undo-with-no-cancel-scheduled',
    'w36-fb5-undo-on-a-membership-that-ended-yesterday',
    'w36-fb5-undo-on-an-ended-subscription-is-refused-by-stripe',
  ],
  FB6: ['w36-fb6-monthly-started-31-december-ends-3-march'],
  /** W40a: the recording made for FB6's 31 July start has its renewal overdue, so its cancel is now refused. */
  RENEWAL_DAY: ['w36-fb6-monthly-started-31-july-ends-1-october'],
  FB20: ['w36-cancel-refused-no-staff-record', 'w36-cancel-refused-inactive-staff'],
  FB22: ['w36-cancel-with-no-next-renewal-date'],
} as const

export const W40_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  [DECISION_SCENARIOS.FB20[0], [NO_STAFF_RECORD]],
  [DECISION_SCENARIOS.FB20[1], [INACTIVE]],
  ['w36-cancel-monthly-after-the-minimum-term', [sent(0)]],
  ['w36-cancel-monthly-inside-the-minimum-term', [sent(0)]],
  ['w36-cancel-yearly', [sent(0)]],
  ['w36-cancel-then-undo', [sent(0, 1)]],
  [DECISION_SCENARIOS.FB22[0], [FB22_NO_RENEWAL_DATE]],
  ['w36-cancel-refused-by-stripe', [stripeRefused(0, 'A cancel Stripe refuses'), sent(0)]],
  ['w36-cancel-stripe-went-then-the-database-write-fails', [databaseFirst(0, 0, 'A cancel whose membership write fails')]],
  ['w36-cancel-answer-lost-then-pressed-again', [answerLost(0, 1, 'A cancel whose answer is lost, then pressed again'), sent(0)]],
  ['w36-undo-refused-by-stripe', [stripeRefused(1, 'An undo Stripe refuses'), sent(0, 1)]],
  ['w36-undo-stripe-went-then-the-database-write-fails', [databaseFirst(1, 1, 'An undo whose membership write fails'), sent(0)]],
  ['w36-undo-answer-lost-then-pressed-again', [answerLost(1, 2, 'An undo whose answer is lost, then pressed again'), sent(0, 1)]],
  [DECISION_SCENARIOS.FB5[0], [FB5_CANCELLED]],
  [DECISION_SCENARIOS.FB5[1], [FB5_PAYMENT_FAILING]],
  [DECISION_SCENARIOS.FB5[2], [FB5_CANCEL_TWICE, sent(0)]],
  [DECISION_SCENARIOS.FB5[3], [FB5_UNDO_NOTHING]],
  [DECISION_SCENARIOS.FB5[4], [FB5_ENDED_YESTERDAY]],
  [DECISION_SCENARIOS.FB5[5], [FB5_ENDED_IN_STRIPE]],
  [DECISION_SCENARIOS.FB6[0], [FB6_31_DECEMBER, sent(0)]],
  [DECISION_SCENARIOS.RENEWAL_DAY[0], [RENEWAL_DUE_31_JULY]],
  ['w36-subscriptions-list-and-search', [refundedMark(['.results[0][0].refunded', '.results[0][1].refunded', '.results[1][0].refunded', '.results[2][0].refunded', '.results[2][1].refunded', '.results[3][0].refunded'])]],
  [
    'w36-membership-reads-carry-the-payment-date-refusal',
    [
      refundedMark(['.results[0][0].refunded', '.results[1].memberships[0].refunded', '.results[3][0].refunded', '.results[4].memberships[0].refunded']),
      notSent(['.results[1].memberships[0].order_line_item_id', '.results[4].memberships[0].order_line_item_id']),
      sent(0),
    ],
  ],
])
