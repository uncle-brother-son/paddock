import type { AllowedDifference } from './compare'

/*
 * W37 (brief item 6; F-plan 4.12 items 3 and 4): the credits, Herd and store credit golden families (W36's
 * recordings) through the Worker's routes, driven as the screens press them, and the only differences allowed in
 * each, every one tied to a decision. A scenario not named in W37_DIFFERENCES must match its golden file exactly; an
 * allowance that stops being needed fails (compareRecordings).
 *
 * Each named difference is pinned: every path it allows carries the one value the new routes give there, so a path
 * that differs in any other way is not allowed. Written by hand from a dump of the replay's raw differences
 * (briefs/W37-logs/account-differences-second-pass.jsonl, staff app repo), each read against the design.
 */

/** W37's golden families: membership credits and their history, Herd, and store credit (W36's recordings). */
export const isW37Scenario = (name: string): boolean => /^w36-(credits-|herd-|store-credit-|fb(7|8|9|10|11|12)-)/.test(name)

/** The scenarios that record the same press sent twice (FB9, FB12): the screens now send the second under the first's key. */
export const REPEATED_PRESS_SCENARIOS: ReadonlySet<string> = new Set(['w36-fb9-the-same-adjustment-pressed-twice-adds-twice', 'w36-fb12-the-same-adjustment-pressed-twice-gives-twice'])

const W37 = 'Brief W37 (F-plan 4.5)'
const AS_DATA = `${W37}; F-plan 4.2 item 5 (refusals come back in the old result shape, with the old words)`
const STAFF_FIRST = `${W37}; F-plan 4.2 item 3 (the permission comes from the signed-in staff member; every /api/v1/staff route refuses someone with no staff record or an inactive account before anything else, as steps C to E)`

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
export const CREDITS_NO_ANSWER_MESSAGE =
  "The adjustment didn't get an answer, so the credits may or may not have changed. Don't adjust them another way: press Apply Adjustment again here (it won't apply twice), or close this and check the Adjustment History first."

const NO_STAFF_RECORD_WORDS = "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."
const INACTIVE_WORDS = 'This staff account is inactive. Ask an admin to reactivate it.'
const ISSUE_REFUNDS_WORDS = 'Needs Issue refunds permission — this action moves money back to the customer.'

/** The pins of one answer that the old function threw and the wrapper now gives as data, with the same words. */
const asData = (index: number, flag: 'adjusted' | 'updated' | 'ok', reason: string, message: string): ReadonlyArray<readonly [string, Pin]> => [
  [`.results[${index}].thrown`, GONE],
  [`.results[${index}].${flag}`, false],
  [`.results[${index}].reason`, reason],
  [`.results[${index}].message`, message],
]

/** A credit adjustment's refusal: thrown by the old function, now `adjusted: false` with a reason and the same words. */
const creditsRefusedAsData = (what: string, refusals: ReadonlyArray<readonly [number, string, string]>): AllowedDifference =>
  pinned(
    `${what}: the refusal comes back as data (\`adjusted: false\`, a reason, the same words), where the old function threw the words. Nothing is changed, as before`,
    AS_DATA,
    refusals.flatMap(([index, reason, message]) => asData(index, 'adjusted', reason, message))
  )

const period = (allocated: number, used: number): Matcher => (value) => {
  const row = value as Record<string, unknown> | null
  return row !== null && typeof row === 'object' && row['credits_allocated'] === allocated && row['credits_used'] === used && row['period_start'] === '2026-11-10' && row['period_end'] === '2026-12-09' && typeof row['period_id'] === 'string'
}

// --- Who may

const CREDITS_NO_STAFF_RECORD = pinned(
  'No staff record: refused with the words every staff route gives for it, where the old function said the Issue refunds sentence (it took a missing record for a missing permission). Still `permission_denied`, nothing changed',
  STAFF_FIRST,
  [['.results[0].message', NO_STAFF_RECORD_WORDS]]
)
const CREDITS_INACTIVE = pinned(
  'An inactive account: refused as data (`permission_denied`, the same words), where the old function threw them',
  STAFF_FIRST,
  asData(0, 'adjusted', 'permission_denied', INACTIVE_WORDS)
)
const HERD_NO_PERMISSION = pinned(
  'No Issue refunds: the Herd change is refused as data (`permission_denied`, the same words), where the old function threw them. The membership is left as it was',
  AS_DATA,
  asData(0, 'updated', 'permission_denied', ISSUE_REFUNDS_WORDS)
)
const HERD_NO_STAFF_RECORD = pinned(
  'No staff record: the Herd change is refused as data (`permission_denied`, the same words), where the old function threw them',
  STAFF_FIRST,
  asData(0, 'updated', 'permission_denied', NO_STAFF_RECORD_WORDS)
)
const STORE_CREDIT_NO_PERMISSION = pinned(
  'No Issue refunds: the store credit adjustment is refused as data (`permission_denied`, the same words), where the old function threw them. The balance is left as it was',
  AS_DATA,
  asData(0, 'ok', 'permission_denied', ISSUE_REFUNDS_WORDS)
)
const STORE_CREDIT_NO_STAFF_RECORD = pinned(
  'No staff record: the store credit adjustment is refused as data (`permission_denied`, the same words), where the old function threw them',
  STAFF_FIRST,
  asData(0, 'ok', 'permission_denied', NO_STAFF_RECORD_WORDS)
)
const STORE_CREDIT_INACTIVE = pinned(
  'An inactive account: the store credit adjustment is refused as data (`permission_denied`, the same words), where the old function threw them',
  STAFF_FIRST,
  asData(0, 'ok', 'permission_denied', INACTIVE_WORDS)
)

// --- The bugs (F-plan section 3)

/**
 * FB7, two adjustments at once. The old function read the allocation and then wrote a fixed figure; the recording
 * starts a second tab's +2 between the read and the write, and the first tab's +1 then overwrote it: 5 allocated, not
 * 7, with both recorded. The Worker's adjustment is one transaction under the credit period's lock and moves the
 * allocation from what is there, so the second waits and lands after: 4, then 5, then 7.
 * (Both at once on two connections: credits-postgres.test.ts.)
 */
const FB7_BOTH_ADJUSTMENTS_COUNT = pinned(
  "Bug FB7 is closed: an adjustment is one transaction under the credit period's lock and moves the allocation from what is there. The second tab's +2 waits for the first's +1 and lands after it: 4, then 5, then 7 allocated, each recorded. (The old code let the first overwrite the second: 5 allocated, with +1 and +2 both on record.)",
  `Bug FB7 (F-plan section 3); ${W37}; brief W37 item 2 (session credits changed relative to what is there, under the lock)`,
  [
    // The first tab's +1 is answered first now (the second can't get in before it): 5.
    ['.results[0].period.credits_allocated', 5],
    // Then the second tab's +2, on top of it: 7.
    ['.results[1].period.credits_allocated', 7],
    ['.tables.membership_credit_adjustments.added[0].amount', 1],
    ['.tables.membership_credit_adjustments.added[0].reason', 'Goodwill after a cold sauna'],
    ['.tables.membership_credit_adjustments.added[1].amount', 2],
    ['.tables.membership_credit_adjustments.added[1].reason', 'Second tab'],
    ['.tables.membership_credit_periods.changed[0].credits_allocated[1]', 7],
  ]
)

/**
 * FB7, a credit booking against an adjustment. One credit allocated, none used. The old function checked "0 allocated
 * is not below 0 used", a booking took the credit, and the write then left 0 allocated with 1 used (a £20 session
 * beyond the allowance), answering "0 used". Here the booking waits for the adjustment (it locks the same credit
 * period), then finds no credit left and is refused: no order, no booking, no place taken.
 * (The booking first instead: the adjustment is refused below what is used. Both ways round on two connections:
 * credits-postgres.test.ts.)
 */
const FB7_BOOKING_WAITS_FOR_THE_ADJUSTMENT = pinned(
  "Bug FB7 is closed: a booking paid with a session credit locks the same credit period, so it can't land between the adjustment's check and its write. The −1 goes first (0 allocated, 0 used, which is true), and the booking is then refused (`insufficient_membership_credit`): no order, booking or place. (The old code left 0 allocated with 1 used, a £20 session beyond the allowance, and told staff 0 were used.)",
  `Bug FB7 (F-plan section 3; W36 report "FB7, more than planned"); ${W37}; brief W37 item 2 (refused below what is used, under the lock a credit booking takes)`,
  [
    // The first step is the adjustment now.
    ['.results[0].success', GONE],
    ['.results[0].orderId', GONE],
    ['.results[0].bookingId', GONE],
    ['.results[0].cardCharged', GONE],
    ['.results[0].cardAmount', GONE],
    ['.results[0].paymentMethodUsed', GONE],
    ['.results[0].adjusted', true],
    ['.results[0].period', period(0, 0)],
    // Then the booking, refused by New Order.
    ['.results[1].adjusted', GONE],
    ['.results[1].period', GONE],
    ['.results[1].success', false],
    ['.results[1].stage', 'booking'],
    ['.results[1].reason', 'insufficient_membership_credit'],
    ['.results[1].bookingFailureReason', 'insufficient_membership_credit'],
    // Nothing of the booking exists.
    ['.tables.booking_guests', GONE],
    ['.tables.bookings', GONE],
    ['.tables.order_line_items', GONE],
    ['.tables.orders', GONE],
    ['.tables.sessions', GONE],
  ]
)

const noAnswer = (index: number): ReadonlyArray<readonly [string, Pin]> => [
  [`.results[${index}].adjusted`, false],
  [`.results[${index}].reason`, 'no_answer'],
  [`.results[${index}].message`, CREDITS_NO_ANSWER_MESSAGE],
  [`.results[${index}].noAnswer`, true],
]

/**
 * FB8. The old function moved the credits and wrote the record as a second statement; the recording makes the record
 * fail, and the retry the error invites then moved the credits again: +4 session credits with one record of +2, and
 * the same for add-on credits. Here the record and the change are one transaction, so a failed record takes the
 * change back with it: nothing moves and nothing is recorded. The press is told no answer (a fault never says
 * "nothing happened"), and the same press again under its key gets that press's stored answer, so it can't add twice
 * either. (A new press after the fault has cleared adds once, with its record: credits.test.ts.)
 */
const FB8_THE_RECORD_GOES_WITH_THE_CHANGE = pinned(
  "Bug FB8 is closed: the adjustment's record and the change are one transaction, so when the record fails nothing has moved: 4 session credits and 2 add-on credits still, and no record. The press is told no answer, and the same press again gets that answer back, not a second go. (The old code left +4 session and +4 add-on credits with one record of +2 each.)",
  `Bug FB8 (F-plan section 3); ${W37}; brief W37 item 2 (the adjustment row and an audit row in the same transaction); W20a's rule (a fault is no answer, the key is kept)`,
  [
    ['.results[0].thrown', GONE],
    ...noAnswer(0),
    ['.results[1].period', GONE],
    ...noAnswer(1),
    ['.results[2].thrown', GONE],
    ...noAnswer(2),
    ['.results[3].addon_credits_remaining', GONE],
    ...noAnswer(3),
    ['.tables.customer_memberships', GONE],
    ['.tables.membership_credit_adjustments', GONE],
    ['.tables.membership_credit_periods', GONE],
  ]
)

/** FB9. The same +2 pressed twice added +4. The dialog now sends the second press under the first's key: +2, once. */
const FB9_ONE_PRESS_ADDS_ONCE = pinned(
  "Bug FB9 is closed: the press has a key, so the same +2 sent again gets the first press's answer (6 allocated) and adds nothing: one record, 6 allocated. (The old code added +2 twice: 8 allocated, two records, two sessions or about £40.)",
  `Bug FB9 (F-plan section 3); ${W37}; F-plan 4.2 item 2 (every write route takes a press key, kept by the dialog)`,
  [
    ['.results[1].period.credits_allocated', 6],
    ['.tables.membership_credit_adjustments.added[1]', GONE],
    ['.tables.membership_credit_periods.changed[0].credits_allocated[1]', 6],
  ]
)

/** FB10. 2 add-on credits less 5 left −3. Now refused, nothing changed. */
const FB10_NEVER_BELOW_ZERO = pinned(
  'Bug FB10 is closed: add-on credits are never taken below zero. 2 less 5 is refused (`addon_below_zero`) and nothing changes or is recorded. (The old code left −3, so the next three credits the member earned would vanish.)',
  `Bug FB10 (F-plan section 3); ${W37}; brief W37 item 2 (add-on credits refused below zero)`,
  [
    ['.results[0].adjusted', false],
    ['.results[0].addon_credits_remaining', GONE],
    ['.results[0].reason', 'addon_below_zero'],
    ['.results[0].message', 'Adjustment rejected: the membership would be left with -3 add-on credit(s), below zero.'],
    ['.tables.customer_memberships', GONE],
    ['.tables.membership_credit_adjustments', GONE],
  ]
)

/** FB10. An empty reason (and one of spaces) was taken by the server. Now refused with the dialog's own sentence. */
const FB10_A_REASON_IS_REQUIRED = pinned(
  "Bug FB10 is closed: the server requires a reason. An empty one, and one of spaces, are refused (`reason_required`, the dialog's own sentence) and nothing changes or is recorded. (The old code took both: +1 session and +1 add-on credit with no reason on record.)",
  `Bug FB10 (F-plan section 3); ${W37}; brief W37 item 2 (a reason required on the server)`,
  [
    ['.results[0].adjusted', false],
    ['.results[0].period', GONE],
    ['.results[0].reason', 'reason_required'],
    ['.results[0].message', 'A reason is required for the audit trail'],
    ['.results[1].adjusted', false],
    ['.results[1].addon_credits_remaining', GONE],
    ['.results[1].reason', 'reason_required'],
    ['.results[1].message', 'A reason is required for the audit trail'],
    ['.tables.customer_memberships', GONE],
    ['.tables.membership_credit_adjustments', GONE],
    ['.tables.membership_credit_periods', GONE],
  ]
)

/**
 * FB11. Clearing the override was two statements; the recording stops the second (the automatic rule over every
 * membership), which left the flag on with no override for a member of ten days. Here the clear and the rule for this
 * one membership are one statement in one transaction, so there is nothing to stop between: the member is not Herd
 * again, with no override. Every Herd change now has its audit row (accountRowProblems holds one per change).
 */
const FB11_THE_CLEAR_AND_THE_RULE_ARE_ONE = pinned(
  'Bug FB11 is closed: clearing the override and applying the automatic rule to the membership are one statement in one transaction (it never runs the rule over every membership), so the failure the recording plants has nowhere to land: the ten-day member is not Herd again, with no override, and each change has its audit row. (The old code left Herd on with no override, and no record of who changed it.)',
  `Bug FB11 (F-plan section 3); ${W37}; brief W37 item 3 (on clear, the automatic Herd rule for this membership; an audit row with before and after)`,
  [
    ['.results[1].thrown', GONE],
    ['.results[1].updated', true],
    [
      '.results[1].membership',
      (value) => {
        const row = value as Record<string, unknown> | null
        return row !== null && typeof row === 'object' && row['is_herd'] === false && row['herd_override'] === null && row['addon_credits_remaining'] === 2 && row['plan_name'] === 'Core' && row['subscription_status'] === 'active'
      },
    ],
    ['.tables.customer_memberships', GONE],
  ]
)

/** FB12. The same £20 pressed twice gave £40. The dialog now sends the second press under the first's key: £20, once. */
const FB12_ONE_PRESS_GIVES_ONCE = pinned(
  "Bug FB12 is closed: the press has a key, so the same £20 sent again gets the first press's answer (a balance of £50, the same movement) and gives nothing more: £30 to £50, one movement. (The old code gave £20 twice: £30 to £70.)",
  `Bug FB12 (F-plan section 3); ${W37}; F-plan 4.2 item 2 (every write route takes a press key, kept by the dialog)`,
  [
    ['.results[1].balance', 50],
    ['.results[1].transactionId', 'store_credit_transactions#1'],
    ['.tables.customers.changed[0].store_credit_balance[1]', '50.00'],
    ['.tables.store_credit_transactions.added[1]', GONE],
  ]
)

const AMOUNT_WORDS = 'Amount must be a non-zero whole number.'
const NOT_FOUND_WORDS = 'Membership not found.'

/** Each bug of F-plan section 3 that W37 closes, with the recordings that hold what the old code did. */
export const FB_SCENARIOS = {
  FB7: ['w36-fb7-two-session-adjustments-at-once-lose-one', 'w36-fb7-a-credit-booking-lands-between-the-check-and-the-write'],
  FB8: ['w36-fb8-the-record-fails-after-the-credits-moved-then-retried'],
  FB9: ['w36-fb9-the-same-adjustment-pressed-twice-adds-twice'],
  FB10: ['w36-fb10-addon-credits-taken-below-zero', 'w36-fb10-an-empty-reason-is-accepted'],
  FB11: ['w36-fb11-herd-clear-stops-before-the-automatic-rule-runs'],
  FB12: ['w36-fb12-the-same-adjustment-pressed-twice-gives-twice'],
} as const

export const W37_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ['w36-credits-refused-no-staff-record', [CREDITS_NO_STAFF_RECORD]],
  ['w36-credits-refused-inactive-staff', [CREDITS_INACTIVE]],
  [
    'w36-credits-refused-amount-not-a-whole-number-or-zero',
    [
      creditsRefusedAsData('An amount of 0, or one that is not a whole number', [
        [0, 'amount_invalid', AMOUNT_WORDS],
        [1, 'amount_invalid', AMOUNT_WORDS],
      ]),
    ],
  ],
  [
    'w36-credits-refused-unknown-membership',
    [
      creditsRefusedAsData('An unknown membership, for either kind of credit', [
        [0, 'membership_not_found', NOT_FOUND_WORDS],
        [1, 'membership_not_found', NOT_FOUND_WORDS],
      ]),
    ],
  ],
  ['w36-credits-session-refused-unlimited-plan', [creditsRefusedAsData('An unlimited plan', [[0, 'unlimited', 'This membership is unlimited — its session credits cannot be adjusted.']])]],
  ['w36-credits-session-refused-no-current-period', [creditsRefusedAsData('No current credit period', [[0, 'no_current_period', 'This membership has no current credit period — there is nothing to adjust.']])]],
  ['w36-credits-session-refused-below-what-is-used', [creditsRefusedAsData('Below what is used', [[1, 'below_used', 'Adjustment rejected: the period would be left with 0 allocated credit(s), below the 1 already used.']])]],
  [FB_SCENARIOS.FB7[0], [FB7_BOTH_ADJUSTMENTS_COUNT]],
  [FB_SCENARIOS.FB7[1], [FB7_BOOKING_WAITS_FOR_THE_ADJUSTMENT]],
  [FB_SCENARIOS.FB8[0], [FB8_THE_RECORD_GOES_WITH_THE_CHANGE]],
  [FB_SCENARIOS.FB9[0], [FB9_ONE_PRESS_ADDS_ONCE]],
  [FB_SCENARIOS.FB10[0], [FB10_NEVER_BELOW_ZERO]],
  [FB_SCENARIOS.FB10[1], [FB10_A_REASON_IS_REQUIRED]],
  ['w36-herd-refused-without-issue-refunds', [HERD_NO_PERMISSION]],
  ['w36-herd-refused-no-staff-record', [HERD_NO_STAFF_RECORD]],
  [FB_SCENARIOS.FB11[0], [FB11_THE_CLEAR_AND_THE_RULE_ARE_ONE]],
  ['w36-store-credit-refused-without-issue-refunds', [STORE_CREDIT_NO_PERMISSION]],
  ['w36-store-credit-refused-no-staff-record', [STORE_CREDIT_NO_STAFF_RECORD]],
  ['w36-store-credit-refused-inactive-staff', [STORE_CREDIT_INACTIVE]],
  [FB_SCENARIOS.FB12[0], [FB12_ONE_PRESS_GIVES_ONCE]],
])
