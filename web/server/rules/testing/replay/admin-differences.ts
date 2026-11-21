import { BOOKING_ADMIN_NEW_WORDS } from '@/server/rules/bookings/admin-failure-messages'
import { EVENT_ADMIN_NEW_WORDS, EVENT_ADMIN_WORDS } from '@/server/rules/events/admin-failure-messages'
import { ORDER_ADMIN_NEW_WORDS } from '@/server/rules/orders/admin-failure-messages'
import { PRICING_ADMIN_NEW_WORDS } from '@/server/rules/pricing/admin-failure-messages'
import { PROMO_ADMIN_WORDS } from '@/server/rules/promo/admin-failure-messages'
import { SESSION_ADMIN_NEW_WORDS } from '@/server/rules/sessions/admin-failure-messages'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import type { AllowedDifference, Recording } from './compare'

/*
 * W49 + W54 (brief "Parity and tests"; G-plan 4.9 items 3 and 4): step G's golden families (W48's recordings of the
 * old functions) through the Worker's routes, driven as the screens press them, and the only differences allowed in
 * each, every one tied to a decision. A scenario not named in W49_W54_DIFFERENCES must match its golden file
 * exactly; an allowance that stops being needed fails (compareRecordings).
 *
 * Each named difference is pinned: every path it allows carries the one value the new routes give there, so a path
 * that differs in any other way is not allowed. Written by hand from a dump of the replay's raw differences
 * (briefs/W49-W54-logs/admin-differences-first-pass-run2.jsonl, staff app repo), each read against the design.
 *
 * Two differences are on every recording and are not listed scenario by scenario: the Worker's audit rows (G-plan
 * 4.6, lead call L6: one for each write, which the old functions never wrote) and the stored answers that hold each
 * press's key (lead call L12). admin-side.ts sets both aside before the comparison and checks them on their own
 * (adminRowProblems, adminStoredAnswerProblems): exactly one audit row for each press answered with a success.
 *
 * The first part of this file is shared by every step G slice (W50 to W57 add their own maps beside W49_W54's).
 */

type Matcher = (value: unknown) => boolean
/** The path holds nothing on the new side (the old side's value is gone). */
export const GONE: Matcher = (value) => value === undefined || value === null
type Pin = string | number | boolean | Matcher

const escaped = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** W52: the paths each difference made by `pinned` names, kept beside it (see pathsPinnedBy). */
const PINNED_PATHS = new WeakMap<AllowedDifference, readonly string[]>()

/** One named difference whose every path is pinned to the value the new routes give there. A path that isn't listed is not allowed. */
export function pinned(name: string, decision: string, pins: ReadonlyArray<readonly [string, Pin]>): AllowedDifference {
  const byPath = new Map(pins)
  const difference: AllowedDifference = {
    name,
    decision,
    path: new RegExp(`^(${pins.map(([path]) => escaped(path)).join('|')})$`),
    actual: (value, _expected, path) => {
      const pin = byPath.get(path)
      if (pin === undefined) return false
      return typeof pin === 'function' ? pin(value) : value === pin
    },
  }
  PINNED_PATHS.set(difference, pins.map(([path]) => path))
  return difference
}

/**
 * W52: the paths a difference made by `pinned` names. A pin is only looked at where the new side differs from the
 * golden file, and an allowance with several paths is still "seen" when one of them has gone back to the golden
 * value. So a replay that wants every pin to bite holds a recording's raw differences (no allowance) to exactly the
 * paths its named differences pin: a path put back to what the old code recorded is then one path short
 * (event-admin-replay.test.ts does).
 */
export const pathsPinnedBy = (difference: AllowedDifference): readonly string[] => PINNED_PATHS.get(difference) ?? []

const SIGN_IN = 'jo@example.com'
/** What every staff route answers a sign-in with no staff row (server/auth/staff.ts), and an inactive account. */
export const NO_STAFF_RECORD_WORDS = STAFF_ADMIN_WORDS.staffAccess.noStaffRecordMatchesLoggedIn(SIGN_IN)
export const INACTIVE_WORDS = STAFF_ADMIN_WORDS.staffAccess.staffAccountInactiveAskAdminReactivate

// --- S3 (W48 review; the lead's call, 20 Nov): one decision, used by every step G slice

/** What the old Manage pricing check (shared/pricingStaff.ts) told a sign-in with no staff row. */
export const S3_OLD_WORDS = STAFF_ADMIN_WORDS.pricingStaff.noStaffRecordMatchesLoggedIn(SIGN_IN)
export const S3_DECISION =
  "W48 review S3 (the lead's call, 20 Nov: a named difference); G-plan 4.2 (every /api/v1/staff route refuses a sign-in with no staff row before its rule runs, in the staff check's own words)"

/** Where a golden recording holds the old sentence: each step that was refused in it. */
export const s3Paths = (golden: Recording): string[] => golden.results.flatMap((result, i) => ((result as { thrown?: unknown } | null)?.thrown === S3_OLD_WORDS ? [`.results[${i}].thrown`] : []))

/**
 * S3. On a Manage pricing action, a sign-in with no staff row was told "…before managing pricing." by the old
 * function's own check. The Worker's staff check runs first on every route and says "…before performing this
 * action.", as it does everywhere else. A sign-in fault, not something a customer or a working staff member sees.
 * Built from the golden file itself, so it allows exactly the steps the recording refused that way, each pinned to
 * the staff check's sentence. 34 of step G's golden files hold it (admin-replay.test.ts counts them).
 */
export const s3UnknownStaffOnManagePricing = (golden: Recording): AllowedDifference =>
  pinned(
    'W48 review S3: on a Manage pricing action, a sign-in with no staff row is told "…Ask an admin to add you as staff before performing this action." (the words every staff route gives), where the old function said "…before managing pricing.". Nothing is changed either way.',
    S3_DECISION,
    s3Paths(golden).map((path) => [path, NO_STAFF_RECORD_WORDS] as const)
  )

// --- W54a (W49 + W54 review, "the sign-in check in lower case"; the lead, 20 Nov): who a new row says made it

export const CREATED_BY_DECISION =
  'Bug GB16 (G-plan section 3: sign-in emails compared in lower case; W48 call 12); W49 + W54 review section 2 and "Claims" 3 (the lead, 20 Nov: named in the shared differences)'

/** Where a recording names who made a row by email: an answer's `created_by`, and a new row's. */
export const createdByPaths = (recording: Recording): string[] => {
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const answers = recording.results.flatMap((result, i) => (isObject(result) && 'created_by' in result ? [`.results[${i}].created_by`] : []))
  const rows = Object.entries(recording.tables).flatMap(([table, changes]) => changes.added.flatMap((row, i) => (isObject(row) && 'created_by' in row ? [`.tables.${table}.added[${i}].created_by`] : [])))
  return [...answers, ...rows]
}

/**
 * The `created_by` difference. A new row that keeps who made it by email (a promo code's `created_by`) holds the
 * staff member's email as their staff row has it. The old function wrote the sign-in as typed.
 *
 * The two are the same text whenever the old function ran at all: it matched the sign-in to its staff row exactly,
 * so a sign-in in another letter case was refused before anything was written ("No staff record matches…"). They
 * differ only where GB16 now lets such a sign-in through: a staff row stored as "Jo@Example.com", signed in as
 * "jo@example.com", makes a code `created_by` "Jo@Example.com". Live has no staff email with a capital (the lead's
 * check), so nothing differs there.
 *
 * No golden recording makes a row from a sign-in in another case, so no scenario lists this: an allowance nobody
 * needs fails. admin-replay.test.ts shows it on promo-create's own steps with the staff row in capitals: this is the
 * only thing that differs from the golden file. Built from the recording, so it allows exactly the answers and rows
 * that name who made them, each pinned to the stored email. A later slice whose create keeps an email uses it too.
 */
export const createdByIsTheStoredEmail = (recording: Recording, storedEmail: string): AllowedDifference =>
  pinned(
    `A new row's \`created_by\` is the staff member's email as their staff row holds it ("${storedEmail}"), where the old function wrote the sign-in as typed ("${SIGN_IN}"). The two differ only for a sign-in in another letter case than its staff row, which the old function refused before it wrote anything.`,
    CREATED_BY_DECISION,
    createdByPaths(recording).map((path) => [path, storedEmail] as const)
  )

// --- GB14: the reads check the staff member (shared by every slice that moves a read)

export const GB14_SCENARIO = 'w48-gb14-the-reads-check-nobody'
const refusedAs =
  (words: string): Matcher =>
  (value) =>
    JSON.stringify(value) === JSON.stringify({ thrown: words })

/**
 * GB14. None of the old reads asked who was calling, so an inactive account, and a sign-in with no staff row, read
 * every promo code and a code's uses. Now each is refused by the route's own staff check. The recording makes every
 * read twice (inactive, then no staff row); the reads later slices move still answer on both passes.
 *
 * W50: built from the golden file. A read that answered a list is now one refusal in its place (pinned whole); a
 * read that answered an object (one booking, its detail, the payments needing attention) differs field by field, so
 * each of the golden answer's fields is gone and what was thrown is pinned.
 */
const GB14_READS_MOVED: ReadonlyArray<readonly [index: number, read: string]> = [
  // W50 (result 0 is the order that sets the scenario up).
  [1, 'getBookings'],
  [2, 'getBookingById'],
  [3, 'getBookingDetail'],
  [4, 'getAddonPrepChecklistForRange'],
  [5, 'getWaiverGapsForRange'],
  // W53.
  [6, 'getOrders'],
  [7, 'getOrderLineItems'],
  [8, 'getPaymentAttentionItems'],
  // W51.
  [9, 'getSessionsForRange'],
  [10, 'getServiceTypesForSlot'],
  // W54.
  [11, 'getPromoCodes'],
  [12, 'getPromoCodeRedemptions'],
  // W52.
  [13, 'getEvents'],
  [14, 'getEventAttendees'],
  [15, 'getTodaysEvents'],
]
/** The recording's two passes: an inactive account, then (24 results further on) a sign-in with no staff row. */
const GB14_PASSES: ReadonlyArray<readonly [offset: number, words: string]> = [
  [0, INACTIVE_WORDS],
  [24, NO_STAFF_RECORD_WORDS],
]

const gb14TheMovedReadsRefuse = (golden: Recording): AllowedDifference =>
  pinned(
    "Bug GB14 is closed for the reads moved so far: an inactive account, and a sign-in with no staff row, are refused the promo code list and a code's uses (W54), and the booking list, one booking, its detail (with its guests' dates of birth), the add-on prep list, the waiver gaps and the payments needing attention (W50), and the calendar's sessions and the service types for a slot (W51), and the events list, an event's attendee list and today's events (W52), and the order list and an order's lines (W53), each in the words every staff route gives. (The old code answered them all. The reads W55 to W57 move still do.)",
    'Bug GB14 (G-plan section 3); G-plan 4.2 (reads: an active staff member); briefs W49 + W54, W50, W51, W52 and W53 "Parity and tests" (the staff check on reads)',
    GB14_PASSES.flatMap(([offset, words]) =>
      GB14_READS_MOVED.flatMap(([index]): Array<readonly [string, Pin]> => {
        const at = index + offset
        return Array.isArray(golden.results[at]) ? [[`.results[${at}]`, refusedAs(words)]] : answerRefused(golden, at, words)
      })
    )
  )

// --- W49: Staff (GB16)

export const isW49W54Scenario = (name: string): boolean => /^w48-(staff-|gb16-|promo-|gb18-|band-|gb8-|member-band-term-|postage-|gb14-)/.test(name)

const W49 = 'Brief W49 + W54 item 2 (G-plan 4.2, level B: one transaction under the lock, an audit row)'
const LAST_PRICING_HOLDER_WORDS = STAFF_ADMIN_WORDS.setStaffCanManagePricing.cannotRemovePricingPermissionLastStaff

/**
 * GB16, the race. The recording: while Jo takes Ada's Manage pricing, Ada's own press takes Jo's between the old
 * function's check and its write, so both land and nobody can change a price. Now every staff change holds the
 * staff table's guard, so the two take turns: Ada's lands first (the replay tells it in that order), and Jo's press
 * finds Ada is the last active holder and is refused in the old words. Ada keeps Manage pricing.
 * staff/admin-postgres.test.ts runs the two presses at once on real Postgres.
 */
const GB16_THE_SECOND_PRESS_IS_REFUSED = pinned(
  "Bug GB16 is closed (the last Manage pricing holder): two admins each taking the other's Manage pricing now take turns, and the second is refused, \"Cannot remove pricing permission: this is the last staff member with can_manage_pricing enabled. Grant it to another staff member first.\" One of them keeps it. (The old code let both through, and nobody could change a price.)",
  `Bug GB16 (G-plan section 3); ${W49}`,
  [
    ['.results[0].id', GONE],
    ['.results[0].can_manage_pricing', GONE],
    ['.results[0].thrown', LAST_PRICING_HOLDER_WORDS],
    ['.tables.staff.changed[1]', GONE],
  ]
)

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const CAPITALS = 'Jo@Example.com'

/**
 * GB16, the sign-in. The staff row is stored as "Jo@Example.com" and the sign-in is "jo@example.com". The old
 * functions compared exactly: the screen was told "not staff" (null) and the staff list refused. Now the sign-in
 * finds its row in lower case, in the staff check and in `staff/me` alike: the screen gets Jo's own row, and the
 * staff list answers (Jo is its one member).
 */
const GB16_A_SIGN_IN_IN_ANOTHER_CASE_FINDS_ITS_ROW = pinned(
  'Bug GB16 is closed (the sign-in email): a staff row stored with capitals ("Jo@Example.com") is found by a sign-in without them, so the screen gets the staff member\'s own row and the staff list answers. (The old code compared the two exactly: the screen was told the sign-in was not staff, and the list refused it with "No staff record matches…".)',
  'Bug GB16 (G-plan section 3); brief W49 + W54 item 2 (sign-in emails compared in lower case, in the Worker\'s own staff check too: W48 call 12)',
  [
    ['.results[0]', (value) => isObject(value) && value['email'] === CAPITALS && value['role'] === 'admin' && value['active'] === true && value['can_manage_pricing'] === true],
    ['.results[1]', (value) => Array.isArray(value) && value.length === 1 && isObject(value[0]) && value[0]['email'] === CAPITALS && value[0]['first_name'] === 'Jo'],
  ]
)

// --- W54: Pricing (GB8, the words that were missing) and promo codes (GB18)

const W54 = 'Brief W49 + W54 items 4 to 6 (G-plan 4.2, level B: one transaction under the lock, an audit row)'
const BAND_GONE_WORDS = PRICING_ADMIN_NEW_WORDS.bandNoLongerExists
/** What the staff app's thin function throws when a press got no answer (shared/adminWorker.ts; admin-replay.test.ts holds the two together). */
export const ADMIN_NO_ANSWER_WORDS = "That didn't get an answer, so it may or may not have been saved. The screen has been reloaded: check it, and press again if it hasn't changed."

/**
 * Brief item 11 (W48 call 9). A band that isn't there: the old function answered `updated: false` and nothing else,
 * and the Pricing page showed nothing at all. The Worker refuses with a reason and words, which the function passes
 * on beside the same `updated: false`.
 */
const BAND_PRICE_FOR_A_BAND_THAT_IS_NOT_THERE = pinned(
  'A band price set for a band that no longer exists is still answered `updated: false`, now with why: "That band no longer exists. Reload the page and try again." (The old code gave no reason and no words, so the Pricing page showed nothing.)',
  `Brief W49 + W54 item 11 (W48 report "Where I was unsure" 9: the words for refusals that had none); ${W54}`,
  [
    ['.results[2].reason', 'band_not_found'],
    ['.results[2].message', BAND_GONE_WORDS],
  ]
)

/**
 * W48 "For the Worker step" 8. A member term saved for a band that isn't there showed the database's own foreign key
 * error. Now it is refused before the write, in plain words.
 */
const MEMBER_TERM_FOR_A_BAND_THAT_IS_NOT_THERE = pinned(
  'A member term saved for a band that no longer exists is refused in plain words, "That band no longer exists. Reload the page and try again." (The old code showed the database\'s own error: insert or update on table "membership_band_terms" violates foreign key constraint….)',
  `W48 report "For the Worker step" 8 (plain words where the database's own error showed); ${W54}`,
  [['.results[4].thrown', BAND_GONE_WORDS]]
)

/**
 * GB8, a save that works. The day's two new windows are written in one transaction, so they carry one moment where
 * the old function's two separate inserts carried two. Which windows, their bands and times, the windows removed and
 * the session re-banded are all exactly as recorded; only the count of new rows sharing a moment differs.
 */
const GB8_ONE_TRANSACTION = pinned(
  "Bug GB8 is closed: a day's band windows are replaced in one transaction, so the two new windows are written at one moment (the old code wrote them as two separate statements, a moment apart, after a separate delete). The windows themselves, and the session re-banded, are exactly as before.",
  `Bug GB8 (G-plan section 3); ${W54}`,
  [['.tables.band_rules.tied', 2]]
)

/**
 * GB8, a save that fails part way. The three recordings: the old function had already deleted the day's windows
 * when an insert failed, then put the old ones back as new rows (first recording), failed to (second: the day left
 * with no windows at all), or met its own half-written window (third: the day left half cut). Now the same failure
 * rolls the whole save back: the day's windows are untouched, and staff are told the save got no answer (the
 * function can't tell a failed write from a lost answer, and pressing again is safe).
 */
const GB8_A_FAILED_SAVE_LEAVES_THE_DAY_AS_IT_WAS = pinned(
  "Bug GB8 is closed: a band-window save that fails part way changes nothing at all. The day keeps the windows it had (their own rows, never deleted), and staff are told \"That didn't get an answer, so it may or may not have been saved. The screen has been reloaded: check it, and press again if it hasn't changed.\" (The old code had already deleted the day's windows: it put them back as new rows, or failed to and left the day with no band or half cut, and showed the database's own words.)",
  `Bug GB8 (G-plan section 3); ${W54}`,
  [
    ['.results[0].thrown', ADMIN_NO_ANSWER_WORDS],
    ['.tables.band_rules', GONE],
  ]
)

/**
 * GB18, the race. The recording: an order uses ALLTEN between the old function's count of the code's uses and its
 * write, so the text changes anyway and the order's redemption belongs to a code now called ALLTWENTY. Now the edit
 * holds the code's row lock, which the order holds until its redemption is written, so the two take turns: the order
 * lands first (the replay tells it in that order), and the edit finds the code used and is refused in the old words.
 * The code keeps its text and its 10%. promo/admin-postgres.test.ts runs the two at once on real Postgres.
 */
const GB18_THE_EDIT_IS_REFUSED_ONCE_THE_CODE_IS_USED = pinned(
  "Bug GB18 is closed (the locked text): an edit of a code's text that meets an order using the code now waits for it, and is then refused, \"This code has been redeemed at least once — its text can no longer be changed. Deactivate it and create a new code instead.\" The code keeps its text and its discount. (The old code counted the uses, then wrote: the text changed anyway, under the order's redemption.)",
  `Bug GB18 (G-plan section 3); ${W54}`,
  [
    ['.results[1].updated', false],
    ['.results[1].promo', GONE],
    ['.results[1].reason', 'code_locked'],
    ['.results[1].message', PROMO_ADMIN_WORDS.updatePromoCode.codeHasBeenRedeemedAtLeast],
    ['.tables.promo_codes', GONE],
  ]
)

/** The recordings each decision is proved on. */
export const DECISION_SCENARIOS = {
  GB8_SAVED: ['w48-band-rules-set', 'w48-band-rules-set-leaves-a-band-set-by-hand'],
  GB8_FAILED: [
    'w48-gb8-band-windows-deleted-then-an-insert-fails-and-the-old-ones-are-put-back',
    'w48-gb8-band-windows-deleted-and-the-put-back-fails-too',
    'w48-gb8-band-windows-half-saved-then-the-put-back-overlaps',
  ],
  GB14: [GB14_SCENARIO],
  GB16: ['w48-gb16-two-admins-remove-each-others-manage-pricing', 'w48-gb16-sign-in-in-another-case-matches-no-staff-row'],
  GB18: ['w48-gb18-the-text-lock-is-a-read-then-a-write'],
  S3: ['w48-promo-create-who-may', 'w48-promo-update-who-may', 'w48-band-price-who-may', 'w48-band-rules-who-may', 'w48-member-band-term-who-may', 'w48-postage-who-may'],
  WORDS: ['w48-band-price-set', 'w48-member-band-term-refusals'],
} as const

/**
 * GB16's third recording ("a permission change leaves no record") and GB18's first ("a code edited to 100% and back
 * leaves no trace") have no difference to name in what staff are told or in the rows changed: what they prove is in
 * the audit rows, which admin-replay.test.ts reads on those two recordings.
 */
export const NOW_RECORDED_SCENARIOS = ['w48-gb16-a-permission-change-leaves-no-record', 'w48-gb18-a-code-edited-to-100-percent-and-back-leaves-no-trace'] as const

/** The named differences of each W49 + W54 scenario. S3's are built from the scenario's own golden file. */
export function w49W54Differences(name: string, golden: Recording): readonly AllowedDifference[] {
  const s3 = (DECISION_SCENARIOS.S3 as readonly string[]).includes(name) ? [s3UnknownStaffOnManagePricing(golden)] : []
  // W50: GB14's is built from its golden file too (the reads that answer an object differ field by field).
  const gb14 = name === GB14_SCENARIO ? [gb14TheMovedReadsRefuse(golden)] : []
  return [...(W49_W54_DIFFERENCES.get(name) ?? []), ...s3, ...gb14]
}

export const W49_W54_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  [DECISION_SCENARIOS.GB16[0], [GB16_THE_SECOND_PRESS_IS_REFUSED]],
  [DECISION_SCENARIOS.GB16[1], [GB16_A_SIGN_IN_IN_ANOTHER_CASE_FINDS_ITS_ROW]],
  [DECISION_SCENARIOS.GB18[0], [GB18_THE_EDIT_IS_REFUSED_ONCE_THE_CODE_IS_USED]],
  [DECISION_SCENARIOS.WORDS[0], [BAND_PRICE_FOR_A_BAND_THAT_IS_NOT_THERE]],
  [DECISION_SCENARIOS.WORDS[1], [MEMBER_TERM_FOR_A_BAND_THAT_IS_NOT_THERE]],
  [DECISION_SCENARIOS.GB8_SAVED[0], [GB8_ONE_TRANSACTION]],
  [DECISION_SCENARIOS.GB8_SAVED[1], [GB8_ONE_TRANSACTION]],
  [DECISION_SCENARIOS.GB8_FAILED[0], [GB8_A_FAILED_SAVE_LEAVES_THE_DAY_AS_IT_WAS]],
  [DECISION_SCENARIOS.GB8_FAILED[1], [GB8_A_FAILED_SAVE_LEAVES_THE_DAY_AS_IT_WAS]],
  [DECISION_SCENARIOS.GB8_FAILED[2], [GB8_A_FAILED_SAVE_LEAVES_THE_DAY_AS_IT_WAS]],
  // GB14's one difference is built from its golden file (w49W54Differences): listed here so the recording counts as differing.
  [DECISION_SCENARIOS.GB14[0], []],
])

// ---------------------------------------------------------------------------------------------------------------------
// W50: Bookings admin and Overview (GB14, GB17, Wayne's Q49)

/** The 16 recordings of the booking and Overview reads and the three flags (GB14's own recording is in W49 + W54's family above). */
export const isW50Scenario = (name: string): boolean =>
  /^w48-(bookings-read|booking-detail-read-|addon-prep-read$|waiver-gaps-read$|booking-check-in-|guest-waiver-|addon-prepared-|payment-attention-read$|gb17-)/.test(name)

/*
 * What W50's replay shows (briefs/W50-logs/04-replay-differences-first-pass-run3.jsonl, staff app repo): ten of the
 * sixteen match their golden files exactly, field for field: all seven recordings of the six reads (the booking list
 * by range and status, one booking, the detail with each kind of open payment, the prep list, the waiver gaps,
 * payments needing attention), and the three flags pressed on a live booking by an active staff member. Named
 * columns in place of `b.*` and `RETURNING *` change nothing: every column the old answers carried is named. The
 * check-in time is the database's clock where it was the staff app's: both are a time (the recordings hold a time's
 * place, not its value), so it shows in no recording; server/rules/bookings/admin.test.ts holds it.
 *
 * Also on every recording and set aside before the comparison, as for W49 + W54: the Worker's audit rows (one for
 * each flag set, with who) and the stored answers that hold each call's key.
 *
 * Six differ, each by a decision, named below. Each is split so that the refused answer and the row left unchanged
 * are separate allowances: a press that was refused in the right words but still changed the row would leave the
 * row's allowance unseen, which fails.
 */

const W50_FLAG = 'G-plan 4.2 (level C: one guarded statement, where the guard is the rule, and an audit row)'
export const W50_DECISIONS = {
  NO_STAFF_ROW: `W48 report "For the Worker step" 1 and W48 review point 7 (the old flag functions ignored a sign-in with no staff row); bug GB14's fix (G-plan 4.2: every /api/v1/staff route refuses an unknown sign-in before its rule runs)`,
  Q49: `Wayne's Q49 (20 Nov 2026: Check In is refused on a Payment needed booking, "This booking needs payment first. Use Take Payment.", his words as changed in W50a to name the button); bug GB17 (G-plan section 3); ${W50_FLAG}`,
  GB17_CANCELLED: `Bug GB17 (G-plan section 3); the lead's call in brief W50 (a cancelled booking: every flag change refused, on and off); ${W50_FLAG}`,
  GB17_REMOVED_ADDON: `Bug GB17 (G-plan section 3); brief W50 item 5 (a removed add-on line can't be marked prepared); ${W50_FLAG}`,
} as const

/**
 * A step the old function answered and the Worker refuses: every field of the golden answer is gone, and what was
 * thrown is exactly `words`. Built from the golden file's own answer, so it allows that step and nothing else.
 */
function answerRefused(golden: Recording, index: number, words: string): Array<readonly [string, Pin]> {
  const answered = golden.results[index]
  const fields = answered !== null && typeof answered === 'object' && !Array.isArray(answered) ? Object.keys(answered) : []
  return [...fields.map((field) => [`.results[${index}].${field}`, GONE] as const), [`.results[${index}].thrown`, words] as const]
}

const NOT_CHECKED_IN: ReadonlyArray<readonly [string, Pin]> = [['.tables.bookings.added[0].checked_in_at', GONE]]
const WAIVER_NOT_SIGNED: ReadonlyArray<readonly [string, Pin]> = [
  ['.tables.booking_guests.added[0].waiver_accepted', false],
  ['.tables.booking_guests.added[0].waiver_version', GONE],
  ['.tables.booking_guests.added[0].waiver_accepted_at', GONE],
  ['.tables.booking_guests.added[0].waiver_method', GONE],
]
const ADDON_NOT_PREPARED: ReadonlyArray<readonly [string, Pin]> = [
  ['.tables.addon_order_lines.added[0].prepared', false],
  ['.tables.addon_order_lines.added[0].prepared_at', GONE],
  ['.tables.addon_order_lines.added[0].prepared_by', GONE],
]

/** The three "who may" recordings: an active sign-in, then an inactive account (refused before and now), then a sign-in with no staff row. */
const noStaffRow = (golden: Recording, index: number, what: string, unchanged: ReadonlyArray<readonly [string, Pin]>, row: string): AllowedDifference[] => [
  pinned(
    `${what}, pressed by a sign-in with no staff row, is refused in the words every staff route gives ("No staff record matches the logged-in user's email…"). (The old function ignored that the sign-in had no staff row and went ahead: nobody who is staff had done it.)`,
    W50_DECISIONS.NO_STAFF_ROW,
    answerRefused(golden, index, NO_STAFF_RECORD_WORDS)
  ),
  ...(unchanged.length > 0 ? [pinned(`…and ${row} (The old function changed it.)`, W50_DECISIONS.NO_STAFF_ROW, unchanged)] : []),
]

/** The named differences of each W50 recording that has any, built from its own golden file. Ten have none. */
const W50_NAMED: Readonly<Record<string, (golden: Recording) => AllowedDifference[]>> = {
  'w48-booking-check-in-who-may': (golden) => noStaffRow(golden, 2, 'Check In', NOT_CHECKED_IN, 'the booking is not checked in.'),
  'w48-guest-waiver-who-may': (golden) => noStaffRow(golden, 2, "Marking a guest's waiver signed", WAIVER_NOT_SIGNED, "the guest's waiver is still not signed."),
  // Marking prepared already needed a staff row (it is recorded on the line): only un-preparing went ahead without one,
  // on a line that was not prepared, so no row differs.
  'w48-addon-prepared-who-may': (golden) => noStaffRow(golden, 3, 'Un-marking an add-on as prepared', [], ''),
  'w48-gb17-a-cancelled-booking-and-a-payment-needed-one-are-checked-in': (golden) => [
    pinned(
      'Q49 (bug GB17 is closed for a booking at Payment needed): Check In on a booking that needs payment is refused, "This booking needs payment first. Use Take Payment." (The old code checked it in: a member whose payment had failed was checked in without paying.)',
      W50_DECISIONS.Q49,
      answerRefused(golden, 1, BOOKING_ADMIN_NEW_WORDS.paymentNeededCheckIn)
    ),
    pinned(
      'Bug GB17 is closed for a cancelled booking: Check In on a cancelled booking is refused, "This booking is cancelled, so it can\'t be checked in and its check-in can\'t be undone." (The old code checked it in, so it read as attended on the customer\'s history.)',
      W50_DECISIONS.GB17_CANCELLED,
      answerRefused(golden, 2, BOOKING_ADMIN_NEW_WORDS.cancelledCheckIn)
    ),
    pinned('…and the cancelled booking is not checked in. (The old code left it checked in.)', W50_DECISIONS.GB17_CANCELLED, NOT_CHECKED_IN),
  ],
  'w48-gb17-a-cancelled-bookings-waiver-is-changed': (golden) => [
    pinned(
      "Bug GB17 is closed for a cancelled booking's waivers: marking a guest's waiver signed on a cancelled booking is refused, \"This booking is cancelled, so its guests' waivers can no longer be changed.\" (The old code changed it like any other.)",
      W50_DECISIONS.GB17_CANCELLED,
      answerRefused(golden, 1, BOOKING_ADMIN_NEW_WORDS.cancelledWaiver)
    ),
    pinned("…and the guest's waiver is still not signed. (The old code signed it.)", W50_DECISIONS.GB17_CANCELLED, WAIVER_NOT_SIGNED),
  ],
  'w48-gb17-a-removed-addon-is-marked-prepared': (golden) => [
    pinned(
      'Bug GB17 is closed for a removed add-on: marking an add-on prepared after it was removed from its booking is refused, "This add-on has been removed from the booking, so it can\'t be marked prepared or not prepared." (The old code marked it prepared.)',
      W50_DECISIONS.GB17_REMOVED_ADDON,
      answerRefused(golden, 1, BOOKING_ADMIN_NEW_WORDS.removedAddonPrepared)
    ),
    pinned('…and the removed add-on is not marked prepared, by anyone. (The old code marked it, with the staff member and the time.)', W50_DECISIONS.GB17_REMOVED_ADDON, ADDON_NOT_PREPARED),
  ],
}

/** The W50 recordings that have a named difference. */
export const W50_DIFFERING: readonly string[] = Object.keys(W50_NAMED)

/** The named differences of a W50 recording: none for the ten that match their golden files exactly. */
export const w50Differences = (name: string, golden: Recording): readonly AllowedDifference[] => W50_NAMED[name]?.(golden) ?? []

// ---------------------------------------------------------------------------------------------------------------------
// W51: sessions and the timetable (GB3 to GB7, GB14, Wayne's Q50, W51-1)

/**
 * The 43 recordings of the calendar's two reads and the session and timetable writes. Not here: GB24's two
 * (`generateUpcomingSessions`: the function is deleted, not moved, so there is nothing to replay them through) and
 * GB4's capacity recording (W55's function).
 */
export const isW51Scenario = (name: string): boolean =>
  /^w48-(sessions-read$|sessions-for-slot-read$|block-session|block-day|unblock-session|unblock-day|session-band-|session-start-time-|one-off-session-|slot-add|slot-remove|nightly-job-|gb3-|gb4-a-new-weekly-slot-|gb4-a-removed-weekly-slot-|gb5-|gb6-|gb7-)/.test(name)

/** The two recordings of a function W51 deletes (GB24). */
export const W51_DELETED_FUNCTION_SCENARIOS = ['w48-gb24-generate-upcoming-sessions-is-dead-code-that-still-runs', 'w48-generate-upcoming-sessions-who-may'] as const

/*
 * What W51's replay shows (briefs/W51-logs/12-replay-differences-first-pass-run2.jsonl, staff app repo): 22 of the 43
 * match their golden files exactly, field for field: both reads; a block, an unblock, a band change (one session and
 * a day), a reset, a start-time change, a one-off session and a weekly slot made by an active staff member with
 * nothing in the way; every old refusal in its old words; and the two recordings of a slot added or removed reaching
 * no date already made (Wayne's Q50 part 1: left as today). Named columns in place of `RETURNING *` change nothing:
 * every column the old answers carried is named.
 *
 * On every recording and set aside before the comparison, as for W49 to W50: the Worker's audit rows (one for each
 * write, with who) and the stored answers that hold each press's key. Also set aside: the date sessions are made up
 * to, which the calendar read now answers beside its sessions (checked on its own in the replay test).
 *
 * 21 differ, each by a decision, named below. A refused answer and the row left unchanged are separate allowances,
 * so a press refused in the right words that still changed the row leaves the row's allowance unseen, which fails.
 */

const NEW_SESSION_WORDS = SESSION_ADMIN_NEW_WORDS
const W51_LEVEL_B = 'G-plan 4.2 (level B: one transaction under the lock, an audit row, a press key)'
export const W51_DECISIONS = {
  NO_STAFF_ROW: `W48 report "For the Worker step" 1 (the old functions called resolveStaffId and ignored a sign-in with no staff row); bug GB14's fix (G-plan 4.2: every /api/v1/staff route refuses an unknown sign-in before its rule runs)`,
  Q50_PART_2: `Wayne's Q50 part 2 (20 Nov 2026: adding and removing a weekly slot need Manage pricing); W48 report "For the Worker step" 1; ${W51_LEVEL_B}`,
  GB14_COUNT: `Bug GB14 (G-plan section 3: "unblockDay's count" checked nobody); G-plan 4.2 (every /api/v1/staff route refuses an unknown or inactive staff member)`,
  GB3: `Bug GB3 (G-plan section 3 and 4.5); brief W51 item 1 (migration 032: the nightly job keeps its own "sessions made up to" date)`,
  GB5: `Bug GB5 (G-plan section 3 and 4.5); W50 review L1; brief W51 item 5; ${W51_LEVEL_B}`,
  GB6: `Bug GB6 (G-plan section 3 and 4.5); brief W51 item 6; ${W51_LEVEL_B}`,
  GB7: `Bug GB7 (G-plan section 3 and 4.5); brief W51 item 7; ${W51_LEVEL_B}`,
  WORDS: `W48 report "For the Worker step" 8 and call 9 (plain words where there were none, or where the database's own error showed); G-plan 4.5 (a one-off session checks its date as a start-time change does); ${W51_LEVEL_B}`,
  CLOSED_DATES: `Brief W51a item 2 (closed dates: W51 review L3; Wayne, 20 Nov 2026: "remember closed dates"); migration 032 (the closed_dates table, which the nightly job leaves out)`,
} as const

const SAUNA = '10000000-0000-4000-8000-000000000002'
const MANAGER = '10000000-0000-4000-8000-000000000a01'
const THURSDAY_MORNING = ['2026-11-12T10:00:00.000Z', '2026-11-12T11:00:00.000Z'] as const
/** The Thursdays the nightly job makes at 10:00 in the two job recordings: 19 November 2026 to 11 February 2027. */
const THURSDAYS_MADE = ['2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24', '2026-12-31', '2027-01-07', '2027-01-14', '2027-01-21', '2027-01-28', '2027-02-04', '2027-02-11'] as const

/** A Sauna session made by the job on a day: open, 10 places, 10:00 to 11:00. */
const sessionMadeOn =
  (day: string): Matcher =>
  (value) =>
    isObject(value) && value['service_type_id'] === SAUNA && value['start_time'] === `${day}T10:00:00.000Z` && value['end_time'] === `${day}T11:00:00.000Z` && value['status'] === 'open' && value['capacity'] === 10 && value['total_booked'] === 0
/** The job's own date, written once: made up to 16 February 2027 (the replay's today, 10 November 2026, plus 98). */
const madeUpToRowAdded: Matcher = (value) =>
  isObject(value) &&
  Array.isArray(value['added']) &&
  value['added'].length === 1 &&
  isObject(value['added'][0]) &&
  value['added'][0]['id'] === true &&
  value['added'][0]['made_up_to'] === '2027-02-16' &&
  Array.isArray(value['changed']) &&
  value['changed'].length === 0 &&
  Array.isArray(value['removed']) &&
  value['removed'].length === 0
/** W51a: the closed dates a recording's Block Day presses recorded, each with the press's reason and the staff member, and nothing else. */
const closedDatesAdded =
  (dates: readonly string[], reason: string): Matcher =>
  (value) =>
    isObject(value) &&
    Array.isArray(value['added']) &&
    value['added'].length === dates.length &&
    value['added'].every((row, index) => isObject(row) && row['closed_on'] === dates[index] && row['reason'] === reason && typeof row['closed_by'] === 'string' && row['closed_at'] === '<set>') &&
    Array.isArray(value['changed']) &&
    value['changed'].length === 0 &&
    Array.isArray(value['removed']) &&
    value['removed'].length === 0
/** Sam's booking as a block's conflict list names it, with the status it has. */
const samsBooking =
  (status: string, onTheDay = false): Matcher =>
  (value) =>
    isObject(value) &&
    value['customer_first_name'] === 'Sam' &&
    value['customer_last_name'] === 'Test' &&
    value['party_size'] === 1 &&
    value['price_paid'] === '20.00' &&
    value['redemption_source'] === 'paid' &&
    value['status'] === status &&
    (!onTheDay || (value['service_type_name'] === 'Sauna' && value['session_start_time'] === THURSDAY_MORNING[0] && value['session_end_time'] === THURSDAY_MORNING[1]))

const SESSION_NOT_BLOCKED: ReadonlyArray<readonly [string, Pin]> = [
  ['.tables.sessions.changed[0].status', GONE],
  ['.tables.sessions.changed[0].blocked_reason', GONE],
  ['.tables.sessions.changed[0].blocked_by', GONE],
]
/** A block answered as a conflict, as the old function answered one: not blocked, the booking listed, no session. */
const blockRefusedAsConflict = (index: number, status: string): Array<readonly [string, Pin]> => [
  [`.results[${index}].blocked`, false],
  [`.results[${index}].conflict`, true],
  [`.results[${index}].conflictingBookings[0]`, samsBooking(status)],
  [`.results[${index}].session`, GONE],
]

/** A "who may" recording's step by a sign-in with no staff row, which the old function let through. */
const w51NoStaffRow = (golden: Recording, index: number, what: string, decision: string, unchanged: ReadonlyArray<readonly [string, Pin]>, row: string): AllowedDifference[] => [
  pinned(
    `${what}, pressed by a sign-in with no staff row, is refused in the words every staff route gives ("No staff record matches the logged-in user's email…"). (The old function looked the staff member up, found none, and went ahead: nobody who is staff had done it.)`,
    decision,
    answerRefused(golden, index, NO_STAFF_RECORD_WORDS)
  ),
  pinned(`…and ${row} (The old function changed it.)`, decision, unchanged),
]

const W51_NAMED: Readonly<Record<string, (golden: Recording) => AllowedDifference[]>> = {
  // --- Who may
  'w48-slot-add-who-may': (golden) => w51NoStaffRow(golden, 1, 'Adding a weekly slot', W51_DECISIONS.Q50_PART_2, [['.tables.service_type_schedule_slots', GONE]], 'no weekly slot is added.'),
  'w48-slot-remove-who-may': (golden) => w51NoStaffRow(golden, 1, 'Removing a weekly slot', W51_DECISIONS.Q50_PART_2, [['.tables.service_type_schedule_slots', GONE]], 'the weekly slot is still there.'),
  'w48-unblock-session-who-may': (golden) => w51NoStaffRow(golden, 1, 'Unblocking a session', W51_DECISIONS.NO_STAFF_ROW, [['.tables.sessions', GONE]], 'the session is still blocked, with its reason.'),
  'w48-session-start-time-who-may': (golden) => w51NoStaffRow(golden, 1, 'Changing a session\'s start time', W51_DECISIONS.NO_STAFF_ROW, [['.tables.sessions', GONE]], 'the session keeps its time and its band.'),
  'w48-one-off-session-who-may': (golden) => w51NoStaffRow(golden, 1, 'Creating a one-off session', W51_DECISIONS.NO_STAFF_ROW, [['.tables.sessions', GONE]], 'no session is made.'),
  'w48-unblock-day-who-may': (golden) => [
    pinned(
      "Bug GB14 is closed for Unblock Day's count: an inactive account, and a sign-in with no staff row, are refused it in the words every staff route gives. (The old count asked nobody who they were and answered how many sessions were blocked.)",
      W51_DECISIONS.GB14_COUNT,
      [...answerRefused(golden, 0, INACTIVE_WORDS), ...answerRefused(golden, 1, NO_STAFF_RECORD_WORDS)]
    ),
  ],
  'w48-session-band-who-may': (golden) => [s3UnknownStaffOnManagePricing(golden)],
  'w48-session-band-reset-who-may': (golden) => [s3UnknownStaffOnManagePricing(golden)],

  // --- Words where there were none, or where the database's own showed
  'w48-slot-add-refusals': () => [
    pinned(
      'A weekly slot added for a service type that isn\'t there is refused in plain words, "That service type no longer exists. Reload the page and try again." (The old code showed the database\'s own error: insert or update on table "service_type_schedule_slots" violates foreign key constraint….)',
      W51_DECISIONS.WORDS,
      [['.results[5].thrown', NEW_SESSION_WORDS.serviceTypeGone]]
    ),
  ],
  'w48-one-off-session-refusals': () => [
    pinned(
      'A one-off session with a start that isn\'t a date and time is refused as a start-time change refuses it, "Enter a valid date and time." (The old code showed the database\'s own error: invalid input syntax for type timestamp with time zone: "next Friday".)',
      W51_DECISIONS.WORDS,
      [['.results[3].thrown', 'Enter a valid date and time.']]
    ),
  ],
  'w48-session-band-reset': () => [
    pinned(
      'A band reset that changes nothing is still answered `reset: false` with its old reason, now with why: "This session no longer exists. Reload the page and try again." and "This session\'s band is already set automatically." (The old code gave the reason and no words.)',
      W51_DECISIONS.WORDS,
      [
        ['.results[0].message', NEW_SESSION_WORDS.sessionGone],
        ['.results[1].message', NEW_SESSION_WORDS.notOverridden],
      ]
    ),
  ],
  'w48-block-session': (golden) => [
    pinned(
      'A block of a session that isn\'t there is refused, "This session no longer exists. Reload the page and try again." (The old code answered `blocked: true` with no session, and the dialog said "Session blocked".)',
      W51_DECISIONS.WORDS,
      answerRefused(golden, 1, NEW_SESSION_WORDS.sessionGone)
    ),
  ],
  'w48-session-band-set-for-one-session': (golden) => [
    pinned(
      'A band set for a session that isn\'t there is refused, "This session no longer exists. Reload the page and try again." (The old code answered `confirmed: true` for 0 sessions, and the dialog said the band was set.)',
      W51_DECISIONS.WORDS,
      answerRefused(golden, 3, NEW_SESSION_WORDS.sessionGone)
    ),
  ],

  // --- W51a: Block Day records the date as closed, and Unblock Day removes it
  'w48-block-day': () => [
    pinned(
      'Closed dates (W51a): each Block Day also records its date as closed, with the reason and the staff member: here Wednesday 11 and Thursday 12 November 2026, "Staff day". The sessions it blocks, its count and its answer are exactly as recorded. (The old code kept no closed dates: a date further ahead than sessions were made could not be closed, and the nightly job later made it open.)',
      W51_DECISIONS.CLOSED_DATES,
      [['.tables.closed_dates', closedDatesAdded(['2026-11-11', '2026-11-12'], 'Staff day')]]
    ),
  ],

  // --- GB5: every booking that isn't cancelled stops a block
  'w48-gb5-a-payment-needed-booking-does-not-stop-a-block': () => [
    pinned(
      'Bug GB5 is closed for a booking at Payment needed: it stops the block, and is listed for staff to move or cancel, as a confirmed one always was. (The old code looked only at confirmed bookings and blocked the session with the booking on it: the member pays for a session that is closed.)',
      W51_DECISIONS.GB5,
      blockRefusedAsConflict(1, 'payment_needed')
    ),
    pinned('…and the session is not blocked. (The old code blocked it.)', W51_DECISIONS.GB5, SESSION_NOT_BLOCKED),
  ],
  'w48-gb5-a-pending-booking-does-not-stop-a-block': () => [
    pinned(
      'Bug GB5 is closed for a booking whose payment is still being taken (pending): it stops Block Slot and Block Day alike, and is listed. (The old code blocked the session, and then the day, with the booking on it.)',
      W51_DECISIONS.GB5,
      [
        ...blockRefusedAsConflict(1, 'pending'),
        ['.results[2].blocked', false],
        ['.results[2].conflict', true],
        ['.results[2].conflictingBookings[0]', samsBooking('pending', true)],
        ['.results[2].blockedCount', 0],
      ]
    ),
    pinned('…and the session is not blocked, by the slot press or the day press. (The old code blocked it.)', W51_DECISIONS.GB5, SESSION_NOT_BLOCKED),
  ],
  'w48-gb5-a-booking-placed-between-the-check-and-the-block': () => [
    pinned(
      "Bug GB5 is closed for a booking placed while the block is pressed: the block reads the bookings under the session's lock, which the order holds until it commits, so the block waits, then finds the booking and is refused with it listed. (The old code read the bookings, then blocked in a second statement: a booking placed in between landed on a blocked session.)",
      W51_DECISIONS.GB5,
      blockRefusedAsConflict(1, 'confirmed')
    ),
    pinned('…and the session is not blocked. (The old code blocked it.)', W51_DECISIONS.GB5, SESSION_NOT_BLOCKED),
  ],

  // --- GB6: any booking that isn't cancelled refuses a start-time change
  'w48-gb6-a-session-with-a-payment-needed-booking-is-moved-into-peak': () => [
    pinned(
      'Bug GB6 is closed: a start-time change on a session with a Payment needed booking is refused, with the reason the dialog already has words for (since W51a: "This slot has a booking, so its start time can\'t be changed."). (The old code counted pending and confirmed bookings only and moved the session.)',
      W51_DECISIONS.GB6,
      [
        ['.results[1].updated', false],
        ['.results[1].session', GONE],
        ['.results[1].band', GONE],
        ['.results[1].reason', 'session_has_bookings'],
      ]
    ),
    pinned(
      '…and the booking, read again, is still at 10:00 to 11:00. (The old code moved it to 18:00 with its session, unseen: the member is charged the Peak price at Settle, for a time they didn\'t book.)',
      W51_DECISIONS.GB6,
      [
        ['.results[2].start_time', THURSDAY_MORNING[0]],
        ['.results[2].end_time', THURSDAY_MORNING[1]],
      ]
    ),
    pinned('…and the session keeps its 10:00 start, its 11:00 end and its Core band. (The old code moved it to 18:00, into Peak.)', W51_DECISIONS.GB6, [
      ['.tables.sessions.changed[0].start_time', GONE],
      ['.tables.sessions.changed[0].end_time', GONE],
      ['.tables.sessions.changed[0].band_id', GONE],
    ]),
  ],

  // --- GB7: unblock opens only what is blocked; a day block leaves earlier blocks; Unblock Day leaves them too
  'w48-unblock-day': () => [
    pinned(
      "Bug GB7 is closed for Unblock Day: it reopens the sessions a Block Day blocked and leaves a session blocked on its own. Here the one blocked session (a boiler repair) was blocked on its own, so the count says 0 to reopen and 1 blocked on its own, the press reopens none, and the answer carries that second figure (`blockedBefore`). (The old code counted and reopened every blocked session on the date.)",
      W51_DECISIONS.GB7,
      [
        ['.results[0].blockedSessions', 0],
        ['.results[0].blockedBefore', 1],
        ['.results[1].blockedSessions', 0],
        ['.results[1].unblocked', 0],
        ['.results[1].blockedBefore', 1],
        ['.results[2].blockedBefore', 1],
      ]
    ),
    pinned('…and the repair block is still there, with its reason and who. (The old code reopened the session.)', W51_DECISIONS.GB7, [['.tables.sessions', GONE]]),
    pinned(
      'Closed dates (W51a): the count also says whether the date is recorded as closed (here it is not: 0), and each press says whether it removed a closed date (it did not). (The old code kept no closed dates.)',
      W51_DECISIONS.CLOSED_DATES,
      [
        ['.results[0].closedDates', 0],
        ['.results[1].closedDateRemoved', false],
        ['.results[2].closedDateRemoved', false],
      ]
    ),
  ],
  'w48-gb7-a-day-block-and-unblock-loses-an-earlier-block': (golden) => [
    pinned(
      'Bug GB7 is closed (unblock): Unblock on a session that isn\'t blocked is refused, "This session isn\'t blocked, so there is nothing to unblock.", and the session is left exactly as it is. (The old code set it open again and answered its row.)',
      W51_DECISIONS.GB7,
      answerRefused(golden, 0, NEW_SESSION_WORDS.notBlocked)
    ),
    pinned(
      "Bug GB7 is closed (Block Day): the day block blocks the one open session and leaves the session already blocked for the boiler repair as it is: the count is 1, and the calendar still shows the repair's reason and the manager who blocked it. (The old code overwrote the reason and who on both: count 2.)",
      W51_DECISIONS.GB7,
      [
        ['.results[1].blockedCount', 1],
        ['.results[2][1].blocked_reason', 'Boiler repair'],
        ['.results[2][1].blocked_by', MANAGER],
      ]
    ),
    pinned(
      "Bug GB7 is closed (Unblock Day): it reopens the one session the day block blocked, says one was blocked on its own, and leaves that one blocked: the calendar still shows the repair block. (The old code reopened both, and the repair block was gone.)",
      W51_DECISIONS.GB7,
      [
        ['.results[3].blockedSessions', 1],
        ['.results[3].unblocked', 1],
        ['.results[3].blockedBefore', 1],
        ['.results[4][1].status', 'blocked'],
        ['.results[4][1].blocked_reason', 'Boiler repair'],
        ['.results[4][1].blocked_by', MANAGER],
      ]
    ),
    pinned('…and at the end no session has changed: the morning one is open again and the repair block is as it was. (The old code left the repair session open.)', W51_DECISIONS.GB7, [['.tables.sessions', GONE]]),
    pinned(
      'Closed dates (W51a): the Block Day recorded the date as closed, and the Unblock Day removed it again, and says so (`closedDateRemoved`); no closed date is left at the end. (The old code kept no closed dates.)',
      W51_DECISIONS.CLOSED_DATES,
      [['.results[3].closedDateRemoved', true]]
    ),
  ],

  // --- GB3: the nightly job keeps its own date
  'w48-nightly-job-makes-sessions-98-days-ahead': () => [
    pinned(
      'Migration 032: the nightly job writes the date it has made sessions up to (16 February 2027: today plus 98), in its own one-row table. The 13 sessions it makes are exactly the ones recorded. (The old job kept no date: it read the furthest session.)',
      W51_DECISIONS.GB3,
      [['.tables.sessions_made_up_to', madeUpToRowAdded]]
    ),
  ],
  'w48-gb3-one-far-future-session-stops-the-nightly-job': () => [
    pinned(
      'Bug GB3 is closed: with a one-off session made for 1 June 2027, the nightly job still makes its sessions: the 13 Thursdays at 10:00 from 19 November 2026 to 11 February 2027, in one statement, and the calendar for 15 November to 10 December shows four of them. (The old job saw a session past its 98-day target and made nothing: no session to book from 15 November until June.)',
      W51_DECISIONS.GB3,
      [
        ...THURSDAYS_MADE.slice(0, 4).map((day, i) => [`.results[1][${i}]`, sessionMadeOn(day)] as const),
        ...THURSDAYS_MADE.map((day, i) => [`.tables.sessions.added[${i + 1}]`, sessionMadeOn(day)] as const),
        ['.tables.sessions.tied', 13],
      ]
    ),
    pinned('…and the job writes the date it has made sessions up to (16 February 2027), which the one-off session for June does not move.', W51_DECISIONS.GB3, [['.tables.sessions_made_up_to', madeUpToRowAdded]]),
  ],
}

/** The W51 recordings that have a named difference. */
export const W51_DIFFERING: readonly string[] = Object.keys(W51_NAMED)

/** The named differences of a W51 recording: none for the ones that match their golden files exactly. */
export const w51Differences = (name: string, golden: Recording): readonly AllowedDifference[] => W51_NAMED[name]?.(golden) ?? []

// ---------------------------------------------------------------------------------------------------------------------
// W52: Events (GB11, GB14, Wayne's Q51, W48 report "For the Worker step" 5)

/** The 25 recordings of the event reads, the two catalogue writes and the three event-day flags (GB14's own recording is in W49 + W54's family above). */
export const isW52Scenario = (name: string): boolean => /^w48-(events-read$|event-|gb11-|todays-events-read)/.test(name)

/*
 * What W52's replay shows (briefs/W52-logs/04-replay-differences-first-pass-run1.jsonl, staff app repo): 17 of the 25
 * match their golden files exactly, field for field: the events list; on and off sale, with the table's own refusal;
 * the edit's refusals of a cancelled event and of a capacity below the places booked; a saved edit and a cleared one;
 * the attendee list; every check-in refusal, check-in at the desk and its undo, and check-in for many; every waiver
 * refusal, the standard and the extra waiver signed and revoked, and an older extra version read as outstanding; and
 * both recordings of today's events. Named columns change nothing: every column the old answers carried is named.
 * The check-in time is the database's clock where it was already the database's.
 *
 * On every recording and set aside before the comparison, as for W49 to W51: the Worker's audit rows (one for each
 * catalogue write and each waiver or undo; one for EACH attendee a check-in press checked in) and the stored answers
 * that hold each call's key. Set aside from the answers and checked on their own (admin-side.ts): the stamp on each
 * row of the events list and on a saved edit's event (W54a's rule), and `refund_open` on each booking of the attendee
 * list (W35 audit row 18).
 *
 * Eight differ, each by a decision, named below. Where a press is now refused, the refused answer and the row left
 * unchanged are separate allowances: a press refused in the right words that still changed the row would leave the
 * row's allowance unseen, which fails.
 */

const W52_LEVEL_B = 'G-plan 4.2 (level B: one transaction under the lock, an audit row, a press key)'
const W52_LEVEL_C = 'G-plan 4.2 (level C: one guarded statement, where the guard is the rule, and an audit row)'
export const W52_DECISIONS = {
  NO_STAFF_ROW: `W48 report "For the Worker step" 1 and W48 review point 7 (the old event-day functions ignored a sign-in with no staff row); bug GB14's fix (G-plan 4.2: every /api/v1/staff route refuses an unknown sign-in before its rule runs)`,
  Q51: `Wayne's Q51 (20 Nov 2026: once a place is sold the refund cut-off can move later but not earlier, so a customer keeps at least the cut-off they bought under; a price change applies to new bookings only; a date change is allowed); bug GB11 (G-plan section 3); brief W52 item 2; ${W52_LEVEL_B}`,
  UNDO: `W48 report "For the Worker step" 5 (undo: the same guards as check-in, less the window); brief W52 item 4; ${W52_LEVEL_C}`,
  NOT_A_NUMBER: `G-plan 4.10 (the staff app's functions are thin calls: what a dialog sends reaches the Worker's rule as JSON, which can't carry a number that isn't one); brief W52 item 1 (the table's own constraints keep their words)`,
} as const

/** The cut-off GB11's recording sold its two places under: 30 November 2026 at 19:00, as the refusal words it. */
const GB11_CUTOFF_IN_FORCE = 'Mon 30 Nov 2026, 7:00 pm'

/** A step the old function answered `updated: true` with a row, which the Worker now answers `updated: false` with a reason and words (as data: the thin function puts the old shape back). */
const answeredRefusal = (index: number, was: 'event' | 'attendee', reason: string, message: string): Array<readonly [string, Pin]> => [
  [`.results[${index}].updated`, false],
  [`.results[${index}].${was}`, GONE],
  [`.results[${index}].reason`, reason],
  [`.results[${index}].message`, message],
]

const ATTENDEE_NOT_CHECKED_IN: ReadonlyArray<readonly [string, Pin]> = [['.tables.event_attendees.added[0].checked_in_at', GONE]]
const ATTENDEE_WAIVER_NOT_SIGNED: ReadonlyArray<readonly [string, Pin]> = [
  ['.tables.event_attendees.added[0].waiver_accepted', false],
  ['.tables.event_attendees.added[0].waiver_version', GONE],
  ['.tables.event_attendees.added[0].waiver_accepted_at', GONE],
  ['.tables.event_attendees.added[0].waiver_method', GONE],
]

/** A "who may" recording's step by a sign-in with no staff row (its third), which the old function let through. */
const w52NoStaffRow = (golden: Recording, what: string, unchanged: ReadonlyArray<readonly [string, Pin]>, row: string): AllowedDifference[] => [
  pinned(
    `${what}, pressed by a sign-in with no staff row, is refused in the words every staff route gives ("No staff record matches the logged-in user's email…"). (The old function ignored that the sign-in had no staff row and went ahead: nobody who is staff had done it.)`,
    W52_DECISIONS.NO_STAFF_ROW,
    answerRefused(golden, 2, NO_STAFF_RECORD_WORDS)
  ),
  pinned(`…and ${row} (The old function changed it.)`, W52_DECISIONS.NO_STAFF_ROW, unchanged),
]

/** The named differences of each W52 recording that has any, built from its own golden file. Seventeen have none. */
const W52_NAMED: Readonly<Record<string, (golden: Recording) => AllowedDifference[]>> = {
  // S3 (one decision for every step G slice): the staff check's own words for a sign-in with no staff row.
  'w48-event-active-who-may': (golden) => [s3UnknownStaffOnManagePricing(golden)],
  'w48-event-details-who-may': (golden) => [s3UnknownStaffOnManagePricing(golden)],
  'w48-event-details-refusals': () => [
    pinned(
      'A price that is not a number can\'t be sent to the Worker at all: the dialog\'s press travels as JSON, which carries it as no price. So the recording\'s fifth press (the Herd price as "not a number") is read as the Herd price cleared, and on an event that is on sale the table\'s own rule refuses that, in its old words ("This event is on sale, so it needs a date, capacity, all three prices…"). Nothing is changed either way. (The old function, called directly, said "Prices can\'t be negative.". The edit dialog never sends such a price: it checks the box first.)',
      W52_DECISIONS.NOT_A_NUMBER,
      [
        ['.results[4].reason', 'constraint'],
        ['.results[4].message', EVENT_ADMIN_WORDS.setEventDetails.eventOnSaleSoItNeeds],
      ]
    ),
  ],
  'w48-gb11-cut-off-date-and-prices-change-after-places-are-sold': () => [
    pinned(
      'Q51 (bug GB11 is closed): with two places sold under a cut-off of 30 November, moving the cut-off to 10 November is refused, "Places are already booked on this event, so the refund cut-off can\'t be made earlier: customers keep at least the cut-off they booked under. The earliest it can be is Mon 30 Nov 2026, 7:00 pm." (The old code saved it with no warning: a customer cancelling on 26 November then got nothing.)',
      W52_DECISIONS.Q51,
      answeredRefusal(1, 'event', 'cutoff_earlier', EVENT_ADMIN_NEW_WORDS.cutoffEarlier(GB11_CUTOFF_IN_FORCE))
    ),
    pinned(
      '…and the second edit, which sends the same earlier cut-off together with a new price and a new date, is refused the same way, whole: an edit is one save. (The price and the date could each be changed on their own: brief W52\'s tests show both. The old code saved all three.)',
      W52_DECISIONS.Q51,
      answeredRefusal(2, 'event', 'cutoff_earlier', EVENT_ADMIN_NEW_WORDS.cutoffEarlier(GB11_CUTOFF_IN_FORCE))
    ),
    // On its own, so a cut-off that moved anyway (as the golden file has it) leaves this allowance unseen, which fails.
    pinned('…so the cut-off is where the customers booked under it: the event\'s row keeps 30 November. (The old code wrote 10 November.)', W52_DECISIONS.Q51, [['.tables.events.changed[0].refund_cutoff_at', GONE]]),
    pinned(
      '…and the rest of the event is as it was too: no change to its date or its public price (which the old code wrote with the cut-off), and the attendee list reads the event on 1 December with its cut-off on 30 November.',
      W52_DECISIONS.Q51,
      [
        ['.tables.events.changed[0].starts_at', GONE],
        ['.tables.events.changed[0].ends_at', GONE],
        ['.tables.events.changed[0].price_public', GONE],
        ['.results[3].event.starts_at', '2026-12-01T19:00:00.000Z'],
        ['.results[3].event.ends_at', '2026-12-01T21:00:00.000Z'],
        ['.results[3].event.refund_cutoff_at', '2026-11-30T19:00:00.000Z'],
      ]
    ),
  ],
  'w48-event-check-in-who-may': (golden) => w52NoStaffRow(golden, 'Checking an event attendee in', ATTENDEE_NOT_CHECKED_IN, 'the attendee is not checked in.'),
  'w48-event-check-in-many-who-may': (golden) => w52NoStaffRow(golden, 'Checking several event attendees in, with their waivers marked signed at the desk', [...ATTENDEE_WAIVER_NOT_SIGNED, ...ATTENDEE_NOT_CHECKED_IN], "the attendee is not checked in and their waiver is still not signed."),
  'w48-event-waiver-who-may': (golden) => w52NoStaffRow(golden, "Marking an event attendee's waiver signed", ATTENDEE_WAIVER_NOT_SIGNED, "the attendee's waiver is still not signed."),
  'w48-event-check-in-undo-has-no-checks': () => [
    pinned(
      'Undo check-in now has check-in\'s guards, less the window: on an attendee whose booking is cancelled it is refused, "This event booking isn\'t confirmed." (The old undo checked only the place, and un-checked an attendee of a cancelled booking.)',
      W52_DECISIONS.UNDO,
      answeredRefusal(1, 'attendee', 'booking_not_confirmed', EVENT_ADMIN_WORDS.eventCheckIn.booking_not_confirmed)
    ),
    pinned('…and that attendee is still checked in. (The old code cleared it.)', W52_DECISIONS.UNDO, [['.tables.event_attendees.added[0].checked_in_at', '<set>']]),
    pinned(
      '…and undo on a place that has been cancelled says so, "This place has been cancelled.", with its own reason. (The old undo was refused too, but as "This attendee no longer exists.": its one statement couldn\'t tell a cancelled place from one that isn\'t there.)',
      W52_DECISIONS.UNDO,
      [
        ['.results[2].reason', 'attendee_cancelled'],
        ['.results[2].message', EVENT_ADMIN_WORDS.eventCheckIn.attendee_cancelled],
      ]
    ),
  ],
}

/** The W52 recordings that have a named difference. */
export const W52_DIFFERING: readonly string[] = Object.keys(W52_NAMED)

/** The named differences of a W52 recording: none for the ones that match their golden files exactly. */
export const w52Differences = (name: string, golden: Recording): readonly AllowedDifference[] => W52_NAMED[name]?.(golden) ?? []

// ---------------------------------------------------------------------------------------------------------------------
// W53: Orders and fulfilment (GB14, GB22, the fulfilled tick's refusals, named columns)

/** The six recordings of the two order reads and the fulfilled tick (GB14's own recording is in W49 + W54's family above). */
export const isW53Scenario = (name: string): boolean => /^w48-(orders-read$|order-lines-read$|order-line-fulfilled-|gb22-)/.test(name)

/*
 * What W53's replay shows (briefs/W53-logs/08-replay-differences-first-pass.jsonl, staff app repo): two of the six
 * match their golden files exactly, field for field: the order list read ten ways (each view, the search, the
 * payment status, the source, the dates), and GB22's second half (an order with money owed is Needs action, as it has
 * been since W47). Named columns in place of `o.*` change nothing there: every column the old answer carried is
 * named. The line read's names and its two summary sentences are the old function's, word for word.
 *
 * On every recording and set aside before the comparison, as for W49 to W52: the Worker's audit rows (one for each
 * tick set, with who) and the stored answers that hold each call's key. Also set aside: how each order was paid, in
 * words, which the order list now answers beside each order (lead call L9; checked on its own in the replay test).
 *
 * Four differ, each by a decision, named below. A refused answer and the row left unchanged are separate allowances,
 * so a press refused in the right words that still changed the row leaves the row's allowance unseen, which fails.
 */

const W53_FLAG = 'G-plan 4.2 (level C: one guarded statement, where the guard is the rule, and an audit row)'
export const W53_DECISIONS = {
  NAMED_COLUMNS: "G-plan 4.2 (reads: named columns, never `*`); W48's contracts (w48-contracts.test.ts, LEFT_OUT: getOrderLineItems' four working columns, which no screen's type has); brief W53 item 1",
  NO_STAFF_ROW: `W48 report "For the Worker step" 1 and W48 review point 7 (the old tick called resolveStaffId and ignored a sign-in with no staff row); bug GB14's fix (G-plan 4.2: every /api/v1/staff route refuses an unknown sign-in before its rule runs)`,
  WORDS: `Brief W53 item 3 (the tick says why it refused); W48 report "Where I was unsure" 9 (words for refusals that had none); ${W53_FLAG}`,
  GB22: 'Bug GB22 (G-plan section 3: an order whose booking is at Payment needed reads Complete); brief W53 item 2',
} as const

/** The four columns the old line read worked its add-on sentence out from, and spread into its answer beside it. */
const LINE_WORKING_COLUMNS = ['addon_removed_count', 'addon_refunded', 'addon_card_refunded', 'addon_credits_returned'] as const

/** Where a golden recording of the line read holds those columns: each line of each answer that is a list of lines. */
const lineWorkingColumnPaths = (golden: Recording): Array<readonly [string, Pin]> =>
  golden.results.flatMap((result, i) =>
    Array.isArray(result) ? result.flatMap((line: unknown, j) => (isObject(line) ? LINE_WORKING_COLUMNS.filter((column) => column in line).map((column) => [`.results[${i}][${j}].${column}`, GONE] as const) : [])) : []
  )

/** An order the list answers as Needs action: the recording's one order, paid, with its booking line's booking at Payment needed. */
const needsActionOrder: Matcher = (value) => isObject(value) && value['id'] === 'orders#1' && value['computed_status'] === 'needs_action' && value['payment_status'] === 'paid' && value['order_total'] === '20.00'

/** The named differences of each W53 recording that has any, built from its own golden file. Two have none. */
const W53_NAMED: Readonly<Record<string, (golden: Recording) => AllowedDifference[]>> = {
  'w48-order-lines-read': (golden) => [
    pinned(
      "An order's lines no longer carry the four working columns the old function spread into its answer beside the add-on sentence it built from them (`addon_removed_count`, `addon_refunded`, `addon_card_refunded`, `addon_credits_returned`). No screen reads them: the sentence itself (`addon_refund_summary`) is answered, word for word as before.",
      W53_DECISIONS.NAMED_COLUMNS,
      lineWorkingColumnPaths(golden)
    ),
  ],
  'w48-order-line-fulfilled-who-may': (golden) => [
    pinned(
      'Marking a product line fulfilled, pressed by a sign-in with no staff row, is refused in the words every staff route gives ("No staff record matches the logged-in user\'s email…"). (The old function ignored that the sign-in had no staff row and went ahead: nobody who is staff had done it.)',
      W53_DECISIONS.NO_STAFF_ROW,
      answerRefused(golden, 2, NO_STAFF_RECORD_WORDS)
    ),
    pinned('…and the line is still to be fulfilled. (The old function marked it fulfilled.)', W53_DECISIONS.NO_STAFF_ROW, [['.tables.order_line_items.added[0].fulfillment_status', 'pending']]),
  ],
  'w48-order-line-fulfilled-and-undo': () => [
    pinned(
      'The tick refused on a line that isn\'t a product, and on a line that isn\'t there, is still answered `updated: false` with the old reason, now with why in words: "Only a product can be marked fulfilled. This line isn\'t one." and "That line is no longer on the order. Reload the page and try again." (The old function gave the reason alone, and the screen said "Failed to update fulfillment status" for both.)',
      W53_DECISIONS.WORDS,
      [
        ['.results[5].message', ORDER_ADMIN_NEW_WORDS.notAProductLine],
        ['.results[6].message', ORDER_ADMIN_NEW_WORDS.lineNotFound],
      ]
    ),
  ],
  'w48-gb22-an-order-whose-booking-needs-payment-reads-complete': () => [
    pinned(
      "Bug GB22 is closed: an order whose booking is at Payment needed is listed under Needs action, the Orders page's first view, reading Needs action. (The old read left it out of that view: a member whose payment had failed, with a booking to pay for, was only under Complete or All.)",
      W53_DECISIONS.GB22,
      [['.results[1][0]', needsActionOrder]]
    ),
    pinned('…and it is no longer listed under Complete. (The old read listed it there, reading Complete.)', W53_DECISIONS.GB22, [['.results[2][0]', GONE]]),
  ],
}

/** The W53 recordings that have a named difference. */
export const W53_DIFFERING: readonly string[] = Object.keys(W53_NAMED)

/** The named differences of a W53 recording: none for the ones that match their golden files exactly. */
export const w53Differences = (name: string, golden: Recording): readonly AllowedDifference[] => W53_NAMED[name]?.(golden) ?? []
