import { PRICING_ADMIN_NEW_WORDS } from '@/server/rules/pricing/admin-failure-messages'
import { PROMO_ADMIN_WORDS } from '@/server/rules/promo/admin-failure-messages'
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

/** One named difference whose every path is pinned to the value the new routes give there. A path that isn't listed is not allowed. */
export function pinned(name: string, decision: string, pins: ReadonlyArray<readonly [string, Pin]>): AllowedDifference {
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
 */
const GB14_THE_MOVED_READS_REFUSE = pinned(
  "Bug GB14 is closed for the reads moved so far: an inactive account, and a sign-in with no staff row, are refused the promo code list and a code's uses (W54), each in the words every staff route gives. (The old code answered them both. The reads W50 to W57 move still do.)",
  'Bug GB14 (G-plan section 3); G-plan 4.2 (reads: an active staff member); brief W49 + W54 "Parity and tests" (the staff check on reads)',
  [
    // The inactive pass: getPromoCodes, getPromoCodeRedemptions.
    ['.results[11]', refusedAs(INACTIVE_WORDS)],
    ['.results[12]', refusedAs(INACTIVE_WORDS)],
    // The pass with no staff row.
    ['.results[35]', refusedAs(NO_STAFF_RECORD_WORDS)],
    ['.results[36]', refusedAs(NO_STAFF_RECORD_WORDS)],
  ]
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
  return [...(W49_W54_DIFFERENCES.get(name) ?? []), ...s3]
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
  [DECISION_SCENARIOS.GB14[0], [GB14_THE_MOVED_READS_REFUSE]],
])
