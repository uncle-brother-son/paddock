import type { AllowedDifference } from './compare'

/*
 * W39 (brief item 5; F-plan 4.12 items 3 and 4): the customer golden families (W36's recordings) through the Worker's
 * routes, driven as the screens press them, and the only differences allowed in each, every one tied to a decision. A
 * scenario not named in W39_DIFFERENCES must match its golden file exactly; an allowance that stops being needed
 * fails (compareRecordings).
 *
 * Each named difference is pinned: every path it allows carries the one value the new routes give there, so a path
 * that differs in any other way is not allowed. Written by hand from a dump of the replay's raw differences
 * (briefs/W39-logs/customer-differences-first-pass.jsonl, staff app repo), each read against the design.
 */

/**
 * W39's golden families: create a customer (8, with FB21's two and FB23's one), the list and the detail (2), and the
 * two recordings of reads that carry W39's beside reads other slices own: the payment date refusal on the profile
 * (getSubscriptions and the cancel are W40's, still the old functions) and FB16's (every read, with an inactive
 * account).
 */
export const isW39Scenario = (name: string): boolean => /^w36-(create-customer|fb21-|customers-list-and-search$|customer-detail$|membership-reads-carry-the-payment-date-refusal$|fb16-)/.test(name)

/** FB16's recording makes every read with `call`: the new side answers a refused read as `{ thrown }`, so it runs to its end. */
export const FB16_SCENARIO = 'w36-fb16-every-read-answers-an-inactive-staff-member'

const W39 = 'Brief W39 (F-plan 4.6)'
const STAFF_FIRST = `${W39}; F-plan 4.2 item 3 (every /api/v1/staff route refuses someone with no staff record or an inactive account before anything else, as steps C to E)`

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

export const NO_STAFF_RECORD_WORDS = "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."
export const INACTIVE_WORDS = 'This staff account is inactive. Ask an admin to reactivate it.'
/** A read's refusal, as its wrapper throws it (callWorker adds the code; the request id is left out by the replay). */
export const INACTIVE_READ_THROWN = `${INACTIVE_WORDS} (FORBIDDEN)`
/** The old function's own sentence for a date of birth it can't read (customers/failure-messages.ts; the replay test holds the two together). */
export const DATE_OF_BIRTH_WORDS = 'A valid date of birth is required'

/** A read refused: the whole answer is the wrapper's throw, where the old function answered a list. */
const refusedList: Matcher = (value) => JSON.stringify(value) === JSON.stringify({ thrown: INACTIVE_READ_THROWN })

// --- Named fields (F-plan 4.6)

const NOT_SENT_DECISION = `${W39}; F-plan 4.6 (named fields, not \`*\`); W36's contract for the profile (w36-contracts.test.ts: the Worker's read names its fields, without the column \`cm.*\` and \`csp.*\` brought along that no screen's type names)`

/**
 * The profile's membership and pass rows no longer carry `order_line_item_id` (the order line that sold them). The
 * old read was `cm.*` and `csp.*`, which sent every column; no screen's type names this one, and W36's contract left
 * it out. Every other field of every row is compared exactly.
 */
export const notSent = (paths: readonly string[]): AllowedDifference =>
  pinned(
    "Named fields: a membership's and a pass's `order_line_item_id` (the order line that sold it) is no longer sent to the profile. The old read sent every column of both tables; no screen reads this one. Every other field is as it was.",
    NOT_SENT_DECISION,
    paths.map((path) => [path, GONE] as const)
  )

/**
 * W40 (W35 row 10, lead call L9): the profile's membership rows say whether the membership's order line was refunded.
 * New on every membership row; `false` on these recordings (nothing in them is refunded). memberships/cancel.test.ts
 * holds the `true` case.
 */
const refundedMark = (paths: readonly string[]): AllowedDifference =>
  pinned(
    "W35 row 10: each of the profile's membership rows now carries `refunded`, worked out from the membership's own order line (false here: none of these was refunded), so the screen can say \"Refunded\" in place of \"Cancelled\". Every other field is as it was.",
    'Brief W40 item 5; W35 row 10; lead call L9 (worked out from the order line, no new column)',
    paths.map((path) => [path, false] as const)
  )

// --- The bugs (F-plan section 3; the W36 report for FB23)

/**
 * FB23. 1990-02-30 got past the old function's check (JavaScript reads it as 2 March) and reached the database, whose
 * own words staff saw. Now the date must be one the calendar has, and the refusal is the old function's own sentence
 * for a date of birth it can't read. Nothing was written either way.
 */
const FB23_A_DATE_THE_CALENDAR_DOES_NOT_HAVE = pinned(
  'Bug FB23 is closed: a date of birth the calendar doesn\'t have (30 February 1990) is refused in our own words, "A valid date of birth is required". (The old code let it through to the database, and staff saw its words: date/time field value out of range: "1990-02-30".)',
  `Bug FB23 (W36 report, "For the Worker step"); ${W39}; brief W39 item 1 (an impossible date of birth refused with our own words, not the database's)`,
  [['.results[0].thrown', DATE_OF_BIRTH_WORDS]]
)

/**
 * FB21, its first half. Nothing recorded who created a customer, so someone signed in with no staff record could
 * make one. Now the route refuses them before anything is read, and every customer has a `customer.created` audit row
 * naming the staff member (checked on every scenario by customerRowProblems).
 */
const FB21_NO_STAFF_RECORD_CREATES_NOBODY = pinned(
  'Bug FB21 is closed (who created a customer): someone with no staff record is refused, in the words every staff route gives, and no customer is made. (The old code made the customer, with nothing recording who.)',
  `Bug FB21 (F-plan section 3); ${STAFF_FIRST}; brief W39 item 1 (a customer.created audit row with who and the channel)`,
  [
    ['.results[0].id', GONE],
    ['.results[0].first_name', GONE],
    ['.results[0].last_name', GONE],
    ['.results[0].email', GONE],
    ['.results[0].phone', GONE],
    ['.results[0].date_of_birth', GONE],
    ['.results[0].created_at', GONE],
    ['.results[0].updated_at', GONE],
    ['.results[0].thrown', NO_STAFF_RECORD_WORDS],
    ['.tables.customers', GONE],
  ]
)

/**
 * FB16. None of the old reads checked the staff member, so an inactive account read every customer, a profile, every
 * gift card and code, a card's history and a membership's credit history. Now each is refused. The Subscriptions list
 * and the payment date quote are still the old functions (W40, W41) and still answer.
 */
const FB16_AN_INACTIVE_ACCOUNT_READS_NOTHING = pinned(
  "Bug FB16 is closed for the reads moved so far: an inactive account is refused the customer list and a customer's profile (W39), the gift card list and a card's history (W38) and a membership's credit history (W37), each in the words every staff route gives. (The old code answered them all. The Subscriptions list and the payment date quote, W40's and W41's, still do.)",
  `Bug FB16 (F-plan section 3); ${STAFF_FIRST}; brief W39 item 2 (active staff only)`,
  [
    // getCustomers
    ['.results[0]', refusedList],
    // getCustomerDetail
    ['.results[1].memberships', GONE],
    ['.results[1].sessionPasses', GONE],
    ['.results[1].bookingHistory', GONE],
    ['.results[1].storeCreditBalance', GONE],
    ['.results[1].storeCreditHistory', GONE],
    ['.results[1].eventBookings', GONE],
    ['.results[1].thrown', INACTIVE_READ_THROWN],
    // getGiftCards, getGiftCardRedemptions, getMembershipCreditAdjustments
    ['.results[3]', refusedList],
    ['.results[4]', refusedList],
    ['.results[5]', refusedList],
  ]
)

/** The three bugs W39's recordings hold, with the recordings of what the old code did. */
export const DECISION_SCENARIOS = {
  FB16: [FB16_SCENARIO],
  FB21: ['w36-fb21-create-customer-with-no-staff-record'],
  FB23: ['w36-create-customer-a-date-that-does-not-exist'],
} as const

/**
 * FB21's second half (the same email in another case) has no difference to name on its own recording: there the old
 * function refuses too, because the lower-cased address is already on file as typed. customer-replay.test.ts proves
 * the change on that recording's seed instead: an address on file only in capitals, which the old function adds again
 * and the Worker refuses.
 */
export const FB21_ANOTHER_CASE_SCENARIO = 'w36-fb21-the-same-email-in-another-case-added-by-another-writer'

/** The two recordings of a profile with a membership or a pass on it. */
export const NOT_SENT_SCENARIOS = ['w36-customer-detail', 'w36-membership-reads-carry-the-payment-date-refusal'] as const

export const W39_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  [NOT_SENT_SCENARIOS[0], [notSent(['.results[3].memberships[0].order_line_item_id', '.results[4].sessionPasses[0].order_line_item_id']), refundedMark(['.results[3].memberships[0].refunded'])]],
  [NOT_SENT_SCENARIOS[1], [notSent(['.results[1].memberships[0].order_line_item_id', '.results[4].memberships[0].order_line_item_id']), refundedMark(['.results[1].memberships[0].refunded', '.results[4].memberships[0].refunded'])]],
  [DECISION_SCENARIOS.FB23[0], [FB23_A_DATE_THE_CALENDAR_DOES_NOT_HAVE]],
  [DECISION_SCENARIOS.FB21[0], [FB21_NO_STAFF_RECORD_CREATES_NOBODY]],
  [DECISION_SCENARIOS.FB16[0], [FB16_AN_INACTIVE_ACCOUNT_READS_NOTHING]],
])
