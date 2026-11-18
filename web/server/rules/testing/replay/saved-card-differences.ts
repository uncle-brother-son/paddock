import type { AllowedDifference } from './compare'
import { ID } from './scenarios'

/** One press of the saved card: who it is saved to, and the tap (whose Stripe customer it was made for, and the reusable card it left). */
export interface SavedCardPress {
  customerId: string
  /** None: an intent Stripe doesn't know. */
  tap?: { stripeCustomer?: string; card?: string }
}

const MO = 'cus_member'
const SAM = 'cus_seed'

export const SAVED_CARD_SCENARIOS: Readonly<Record<string, readonly SavedCardPress[]>> = {
  'w42-card-save-no-membership': [{ customerId: ID.customer, tap: { stripeCustomer: SAM, card: 'pm_sams_new_card' } }],
  'w42-card-save-one-membership': [{ customerId: ID.member, tap: { stripeCustomer: MO, card: 'pm_mos_new_card' } }],
  'w42-card-save-another-customers-tap': [{ customerId: ID.member, tap: { stripeCustomer: SAM, card: 'pm_sams_card' } }],
  'w42-card-save-simulated-reader': [{ customerId: ID.member, tap: { stripeCustomer: MO } }],
  'w42-card-save-no-card-on-the-intent': [{ customerId: ID.member }],
  'w42-card-save-unknown-customer': [{ customerId: '10000000-0000-4000-8000-0000000042ff', tap: { stripeCustomer: MO, card: 'pm_mos_new_card' } }],
}

/*
 * W42 (brief item 6; F-plan 4.12 items 3 and 4): the only differences allowed between the saved card as W11 built it
 * (the route with `card_moves` off) and as W42 builds it (on), each tied to a decision and pinned to the one value the
 * new code gives there. A scenario not named in W42_DIFFERENCES must match exactly (the three refusals W11 already
 * made do); an allowance that stops being needed fails (compareRecordings). Written from a dump of the raw
 * differences (briefs/W42-logs/saved-card-differences-second-pass.jsonl, staff app repo), each read against the design.
 */

export const Q19 =
  "W03-decisions Q19 and F-plan 4.7 (replacing a saved card moves every live membership's renewals to it); Wayne's Q45, 15 Nov 2026 (a failing membership included; no payment is taken); brief W42 item 2 (K1, then Stripe: each subscription's card under its step's key and the invoice default; W42a, review L4: the subscriptions first)"
export const FB17 =
  "Bug FB17 (F-plan section 3), W11 F4 (W11 report): refuse unless the intent's Stripe customer is this customer's, in plain words, with nothing saved; brief W42 item 2"

export const Q19_SCENARIOS = ['w42-card-save-no-membership', 'w42-card-save-one-membership']
export const FB17_SCENARIO = 'w42-card-save-another-customers-tap'

type Matcher = (value: unknown) => boolean
type Pin = string | number | boolean | Matcher
const escaped = (path: string): string => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One named difference whose every path is pinned to the value the new code gives there. A path that isn't listed is not allowed. */
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

/** JSON with every object's keys in order, so two values are compared by what they hold. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : inner
  )
/** The path holds exactly this. */
const exactly =
  (wanted: unknown): Matcher =>
  (value) =>
    canonical(value) === canonical(wanted)
/** The path holds nothing on the new side. */
const GONE: Matcher = (value) => value === undefined || value === null
/** An id the comparison has renamed (`gone#3`): random on every run. */
const SOME_ID = /^gone#\d+$/

/** An audit row with this action, against this entity, by the signed-in staff member, holding exactly these details (ids it can't know checked by `ids`). */
const auditRow =
  (action: string, entityType: string, entityId: string, details: Record<string, unknown>, ids: readonly string[] = []): Matcher =>
  (value) => {
    const row = value as Record<string, unknown> | null
    if (!row || row['action'] !== action || row['entity_type'] !== entityType || row['entity_id'] !== entityId || row['actor_type'] !== 'staff' || row['actor_id'] !== ID.staff) return false
    const found = { ...(row['details'] as Record<string, unknown>) }
    for (const id of ids) {
      if (typeof found[id] !== 'string' || !SOME_ID.test(found[id] as string)) return false
      delete found[id]
    }
    return canonical(found) === canonical(details)
  }

/** The answer says how many memberships moved and how many are still to move, on the screen's answer and in the answer stored against the press's key. */
const counts = (moved: number): AllowedDifference =>
  pinned(`The answer gains the memberships moved (${moved}) and still to move (0); W11's had the customer's five fields only`, Q19, [
    ['.results[0].membershipsMoved', moved],
    ['.results[0].membershipsToMove', 0],
    ['.tables.api_idempotency.added[0].response.data.membershipsMoved', moved],
    ['.tables.api_idempotency.added[0].response.data.membershipsToMove', 0],
  ])

/**
 * The Stripe customer's invoice default set to the new card, once, with no key (a value set, safe to repeat), and its
 * outcome recorded. W42a (W42 review L4): it is the last Stripe call, after every subscription's step (two calls
 * each), so its place among the calls and the rows depends on how many memberships moved.
 */
const invoiceDefault = (stripeCustomer: string, customerId: string, card: string, replaced: string, subscriptions: readonly string[]): AllowedDifference =>
  pinned(
    "The Stripe customer's invoice default is set to the new card after the save and after each subscription's own move, and what Stripe said is recorded (`customer.invoice_default`); the `customer.card_saved` row also names the card replaced and the subscriptions to move. W11 sent Stripe nothing after reading the tap",
    Q19,
    [
      [`.stripeCalls[${3 + 2 * subscriptions.length}]`, exactly({ method: 'customers.update', params: { id: stripeCustomer, invoice_settings: { default_payment_method: card } }, idempotencyKey: null })],
      ['.tables.audit_log.added[0].details.replaced', replaced],
      ['.tables.audit_log.added[0].details.subscriptions', exactly(subscriptions)],
      // W42b (W42a review L3): the saved card is read once more just before the send, so the row's transaction now
      // starts after the last step's `done` row was stamped. It is the last row, as the call is the last call.
      [`.tables.audit_log.added[${1 + 2 * subscriptions.length}]`, auditRow('customer.invoice_default', 'customer', customerId, { set: true, paymentMethodId: card, stripeCustomerId: stripeCustomer })],
    ]
  )

/** One live membership: its card step left in K1, its subscription read and sent its card alone under the step's key, the step done. */
const moved = (membershipId: string, subscriptionId: string, card: string): AllowedDifference =>
  pinned(
    "The membership's subscription is moved to the new card: a card step left with the save (`membership.step_left`), the subscription read, then sent `default_payment_method` and nothing else under the step's key, and the step marked done. W11 left the subscription on the old card",
    Q19,
    [
      ['.stripeCalls[3]', exactly({ method: 'subscriptions.retrieve', params: { id: subscriptionId }, idempotencyKey: null })],
      [
        '.stripeCalls[4]',
        (value) => {
          const call = value as { method?: string; params?: unknown; idempotencyKey?: string | null } | null
          return call?.method === 'subscriptions.update' && canonical(call.params) === canonical({ id: subscriptionId, default_payment_method: card }) && /^gone#\d+:payment-method$/.test(call.idempotencyKey ?? '')
        },
      ],
      ['.tables.audit_log.added[1]', auditRow('membership.step_left', 'membership', membershipId, { kind: 'payment_method', want: { paymentMethod: card }, state: 'left', subscriptionId }, ['stepId'])],
      ['.tables.audit_log.added[2]', auditRow('membership.step_left', 'membership', membershipId, { kind: 'payment_method', want: { paymentMethod: card }, state: 'done', detail: 'sent', subscriptionId }, ['stepId'])],
    ]
  )

const OTHER_CUSTOMER_WORDS = "This card was tapped for a different customer, so it can't be saved to this one. Nothing was saved. Start again from this customer's own page and ask them to tap their card."

/** FB17: W11 saved another customer's card to this one. W42 refuses, 409, and writes nothing but the refusal stored against the press's key. */
const FB17_REFUSED = pinned(
  "A tap made for another customer's Stripe customer is refused (409, `other_customer`) in plain words: the customer's row is untouched and there is no `customer.card_saved` row. W11 saved the card to the wrong customer, whose next saved-card charge then failed at Stripe",
  FB17,
  [
    ['.results[0].id', GONE],
    ['.results[0].stripe_customer_id', GONE],
    ['.results[0].saved_payment_method_id', GONE],
    ['.results[0].saved_card_last4', GONE],
    ['.results[0].saved_card_brand', GONE],
    ['.results[0].thrown', OTHER_CUSTOMER_WORDS],
    ['.tables.api_idempotency.added[0].response.ok', false],
    ['.tables.api_idempotency.added[0].response.data', GONE],
    ['.tables.api_idempotency.added[0].response.error', exactly({ code: 'CONFLICT', message: OTHER_CUSTOMER_WORDS, details: { action: 'saved_card', reason: 'other_customer', message: OTHER_CUSTOMER_WORDS } })],
    ['.tables.api_idempotency.added[0].http_status', 409],
    ['.tables.audit_log', GONE],
    ['.tables.customers', GONE],
  ]
)

export const W42_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map([
  ['w42-card-save-no-membership', [counts(0), invoiceDefault(SAM, ID.customer, 'pm_sams_new_card', 'pm_seed', [])]],
  ['w42-card-save-one-membership', [counts(1), invoiceDefault(MO, ID.member, 'pm_mos_new_card', 'pm_member', ['sub_mo']), moved(ID.membership, 'sub_mo', 'pm_mos_new_card')]],
  [FB17_SCENARIO, [FB17_REFUSED]],
])
