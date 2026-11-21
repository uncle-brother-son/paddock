import { GONE, pinned, type Pin } from './admin-differences'
import type { AllowedDifference } from './compare'
import { GONE_VALUE, W57_PINS } from './plan-difference-pins'

/*
 * Brief W57 ("Parity and tests"; G-plan 4.9 items 3 and 4): the membership plan and settings families (W48's
 * recordings of the old functions) through the Worker's routes, and the only differences allowed in each, every one
 * tied to a decision.
 *
 * The values: plan-difference-pins.ts holds the new side's value at every path where a recording differs from its
 * golden file, written from the replay's dump (briefs/W57-logs/07-replay-dump-2.jsonl and its summary, staff app repo).
 * The names: here, by hand, each recording's paths are grouped into named differences, each with its decision, and
 * every path is claimed by exactly one (a path no group claims, or a group that claims none, throws). The replay then
 * holds each recording's raw differences to exactly the paths pinned (pathsPinnedBy), so a value that moves, or a new
 * difference, fails.
 *
 * Eight recordings match their golden files exactly: the plan list, the create and details refusals, a details save
 * with no price change, the three settings recordings and GB19's flags (the Herd refresh is the same function).
 */

/** The W57 recordings: plans (read, create, details and price, on and off sale), GB1, GB2's plan, GB20, the settings and GB19. */
export const isW57Scenario = (name: string): boolean => /^w48-(plans-read$|plan-|gb1-|gb2-plan-|gb20-|membership-settings-|gb19-)/.test(name)

/** The Worker's own rows for these actions (the old functions wrote none), set aside before comparing and checked on their own. */
export const W57_OWN_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  'plan.created',
  'plan.details_set',
  'plan.price_change',
  'plan.active_set',
  'plan.stripe_step',
  'membership.price_moved',
  'membership.step_left',
  'membership.step_check',
  'membership_settings.set',
])

/**
 * The recordings whose `call` the old code let through and the Worker now refuses: updateCatalogItemPrice for a plan
 * with no member count (Q53: no screen presses it; the plan's dialog shows the count and sends it). Replayed with the
 * refusal answered `{ thrown }`, as staff are shown it, so the recording runs on (admin-side.ts, refusedPressesAsAnswers).
 */
export const REFUSED_NOW: ReadonlySet<string> = new Set(['w48-gb1-the-legacy-route-answers-the-counts-the-plan-function-drops', 'w48-gb1-an-ended-subscription-is-skipped'])

export const W57_DECISIONS = {
  S3: 'Brief W49 + W54 S3 (W48 review): every route checks the staff member first, in the staff check\'s own words ("…before performing this action.")',
  GB20: 'Bug GB20 (G-plan section 3); brief W57 item 4: the row and its record, then the Stripe product and prices under keys from the plan, then on sale with the ids in one transaction',
  GB20_REFUSED: 'Bug GB20; brief W57 item 4 ("refused for good: removes, or leaves off sale": left off sale and off every list) and "Where I was unsure" (the words)',
  GB1_GB2: 'Bugs GB1 and GB2 (G-plan section 3); brief W57 item 1 (G-plan 4.4: D1, S1 under the record\'s key, D2, then the moves); brief W57a item 2 (S2 is the automatic check\'s, once no pending order names the old price); Wayne\'s Q53',
  GB2_REFUSED: 'Bug GB2; brief W57 item 1 ("refused at Stripe: the plan unchanged, the record failed, Stripe\'s reason"); the details are D1\'s ("Where I was unsure")',
  Q53_COUNT: "Wayne's Q53 (21 Nov 2026): the screen shows how many members will move and sends that count; the Worker refuses without it, or if it has changed",
  ACTIVE: 'Brief W57 item 5 (on: Stripe\'s product first, then the row; off: the row first, then the product as a step left); F-plan 4.2 item 4 (keys from the record)',
  NO_ANSWER: 'Briefs W49 + W54 "Where I was unsure" 5, as every step G slice: a failed write is no answer to the staff app; brief W57 item 4 (reconcile finishes a plan left half made)',
  GB19: 'Bug GB19 (G-plan section 3); brief W57 item 6: the waiting period and the Herd refresh in one transaction',
} as const
const D = W57_DECISIONS

/** One named difference over the paths `paths` claims. */
interface Group {
  name: string
  decision: string
  paths: (path: string) => boolean
}
const results = (index: number) => (path: string) => path.startsWith(`.results[${index}]`)
const stripe = (path: string) => path.startsWith('.stripeCalls')
const tables = (path: string) => path.startsWith('.tables')
const either =
  (...tests: Array<(path: string) => boolean>) =>
  (path: string) =>
    tests.some((test) => test(path))

const S3_WORDS: Group = { name: 'A sign-in with no staff row is told "…before performing this action." by the staff check every route makes first, not the old Manage pricing check\'s "…before managing pricing."', decision: D.S3, paths: results(2) }
const CREATE_STRIPE: Group = {
  name: "GB20: the plan's Stripe product is made on sale at once (it is put on sale in Stripe and here together, in one step), under a key from the plan's record, and each price under its own key, with the plan and frequency in its metadata; there is no separate on-sale call (the old route made the product off sale, then a second call put it on).",
  decision: D.GB20,
  paths: stripe,
}

/** Each recording's named differences. */
const RECORDINGS: Readonly<Record<string, readonly Group[]>> = {
  'w48-plan-create-who-may': [S3_WORDS],
  'w48-plan-active-who-may': [S3_WORDS],
  'w48-plan-details-who-may': [S3_WORDS],
  'w48-membership-settings-who-may': [S3_WORDS],
  'w48-plan-create': [CREATE_STRIPE],
  'w48-plan-create-monthly-only-and-unlimited': [CREATE_STRIPE],
  'w48-gb20-plan-create-stripe-step-fails-and-leaves-a-row-each-press': [
    {
      name: 'GB20: Stripe refusing the product is said plainly ("Stripe refused to set up the plan, so it was not made: …"), not the legacy route\'s "Internal server error: …"; the row is left off sale and off every list, and the record failed.',
      decision: D.GB20_REFUSED,
      paths: either(results(0), results(1)),
    },
    CREATE_STRIPE,
  ],
  'w48-gb20-plan-create-fails-part-way-through-stripe': [
    { name: 'GB20: the yearly price refused: Stripe\'s reason said plainly, the plan not made (left off sale and off every list).', decision: D.GB20_REFUSED, paths: results(0) },
    {
      name: "GB20: the product and the monthly price Stripe had made are tidied, as plan steps left with the failed record (each read first, under a key from its step): the price archived, the product taken off sale. Nothing names them. Before the calls, as for every plan's set-up: the product made on sale under the plan's key, each price under its own key.",
      decision: D.GB20_REFUSED,
      paths: stripe,
    },
  ],
  'w48-gb20-plan-create-stripe-made-then-the-row-write-fails': [
    {
      name: "GB20: the write of the Stripe ids failing is no answer to the staff app (\"Making the plan didn't get an answer…\": the dialog keeps its key), not the legacy route's \"Failed to update item with Stripe IDs\". The plan stays off sale with its record open, and reconcile finishes it.",
      decision: D.NO_ANSWER,
      paths: results(0),
    },
    CREATE_STRIPE,
  ],
  'w48-gb20-plan-create-the-on-sale-step-fails': [
    {
      name: "GB20 is closed: there is no separate on-sale call to fail. The product is made on sale and the plan put on sale with its ids in one transaction, so the plan is made and on sale (the old code left it made, synced and off sale, and said \"Failed to update Stripe product\").",
      decision: D.GB20,
      paths: either(results(0), tables),
    },
    CREATE_STRIPE,
  ],
  'w48-plan-active-off-and-on': [
    {
      name: "On and off sale: Stripe's product is read first and sent only if it differs, each send under a key from its step. Off: the row first, then the product (a step left). On: the product first, then the row.",
      decision: D.ACTIVE,
      paths: stripe,
    },
  ],
  'w48-plan-details-price-change-on-a-plan-never-synced': [
    {
      name: "GB2: a plan never set up in Stripe gets its product and its prices once, at the new prices, under the change's keys (the old code made a product and prices at the old prices, then archived them and made them again), so the plan's price ids are the change's own.",
      decision: D.GB1_GB2,
      paths: either(stripe, results(0), tables),
    },
  ],
  'w48-gb1-plan-price-change-moves-every-live-member-and-says-nothing': [
    {
      name: "GB1, GB2, Q53: the new price is made first, under the record's key; the plan's price and its new id are written together; then only the members on the price that changed are read and moved, each under a key from their own step, with no proration (Yan pays yearly and is not read). Each move is recorded (set aside here, checked in plans.test.ts). W57a (W57 review S2): the old price is not archived in the press (the old code archived it at once, so a sale already on its way met an archived price): the automatic check archives it past its window, once no pending order names it (plans.test.ts).",
      decision: D.GB1_GB2,
      paths: stripe,
    },
  ],
  'w48-gb1-one-members-move-is-refused-and-nothing-says-which': [
    {
      name: "GB1, GB2, Q53: as above. The move Stripe refuses is left as a step (listed, sent again by reconcile, and for a person if refused for good): the answer's own row is the same as before.",
      decision: D.GB1_GB2,
      paths: stripe,
    },
  ],
  'w48-gb1-the-legacy-route-answers-the-counts-the-plan-function-drops': [
    {
      name: "Q53: a plan's price changed with no member count is refused (\"…it needs the number of members the screen showed…\"), before anything is sent or written. No screen presses updateCatalogItemPrice for a plan: the plan's dialog shows the count and sends it.",
      decision: D.Q53_COUNT,
      paths: either(results(0), stripe, tables),
    },
  ],
  'w48-gb1-an-ended-subscription-is-skipped': [
    { name: "Q53: as above: refused with no member count, before anything is sent or written.", decision: D.Q53_COUNT, paths: either(results(0), stripe, tables) },
  ],
  'w48-gb2-plan-price-old-stripe-price-archived-then-the-new-one-fails': [
    {
      name: "GB2 is closed: the new price is made first, under the record's key, and the old one is never archived before it: Stripe refusing it leaves the plan's price and its live Stripe price as they were, said plainly (\"Stripe refused the new price, so the plan's price was not changed (its other details were saved): …\"). The name and sessions the same press carried are saved (D1, before Stripe).",
      decision: D.GB2_REFUSED,
      paths: either(results(0), stripe, tables),
    },
  ],
  'w48-gb19-the-waiting-period-is-saved-and-the-herd-refresh-fails': [
    {
      name: "GB19: the waiting period and the Herd refresh are one transaction on the Worker. The fault this recording planted is in the old function's own second statement, which no longer exists, so the press is saved whole: the period and every flag together (Mo's flag off at 12 months). A refresh that fails takes the period back with it (plans.test.ts).",
      decision: D.GB19,
      paths: either(results(0), tables),
    },
  ],
}

/** Every recording with a named difference. */
export const W57_DIFFERING: readonly string[] = Object.keys(RECORDINGS)

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
/** Two values the same, whatever the order of an object's keys. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((one, i) => same(one, b[i]))
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a).filter((key) => a[key] !== undefined)
    return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length && keys.every((key) => same(a[key], b[key]))
  }
  return a === b
}
const asPin = (value: unknown): Pin => (value === GONE_VALUE ? GONE : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : (actual: unknown) => same(actual, value))

/** The recording's named differences: each group with the pinned values of the paths it claims (from the pins, not the golden file). */
export function planDifferences(name: string): AllowedDifference[] {
  const pins = W57_PINS[name] ?? []
  const groups = RECORDINGS[name] ?? []
  const claimed = new Set<string>()
  const out = groups.map((group) => {
    const mine = pins.filter(([path]) => group.paths(path) && !claimed.has(path))
    if (mine.length === 0) throw new Error(`${name}: "${group.name}" claims no path: an allowance nobody needs.`)
    for (const [path] of mine) claimed.add(path)
    return pinned(group.name, group.decision, mine.map(([path, value]) => [path, asPin(value)] as const))
  })
  const unclaimed = pins.filter(([path]) => !claimed.has(path)).map(([path]) => path)
  if (unclaimed.length > 0) throw new Error(`${name}: no named difference claims ${unclaimed.join(', ')}`)
  return out
}
