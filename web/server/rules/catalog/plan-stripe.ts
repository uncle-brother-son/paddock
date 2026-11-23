// Brief W57 (G-plan 4.4, 4.6, 4.7, 4.9 items 5 and 6; bugs GB1, GB2, GB20; Wayne's Q53): a membership plan's Stripe
// side, the only level A work in step G, built on step F's membership steps (memberships/left.ts: record first, keys
// from the record, held when unclear, reconcile finishes, one step per subscription at a time).
//
// A price change (catalog/plans.ts presses it; reconcile finishes it):
//   D1  (plans.ts) one transaction: the details, and the record (`plan.price_change`, `started`): the old and new
//       prices, the product to price them on, and how many members will move (Q53). Refused while another is open.
//   S1  the new Stripe price(s), each under a key from the record (`<changeId>:monthly`, `:yearly`), with the record's
//       id in `metadata.change_id`; first the product (`<changeId>:product`) for a plan never set up in Stripe.
//         refused -> the record `failed`, the plan's price unchanged, Stripe's reason (any price already made is
//                    archived as a plan step: nothing names it)
//         unclear -> the record `held`. Reconcile lists the product's prices by `metadata.change_id` past the window:
//                    all found -> D2; none (or only some) -> `failed` (GB2: a second price is never made for a change)
//   D2  one transaction: the plan's price and its new price id together (GB2: the plan never names an archived
//       price); one `price` step per live subscription on the changed price (Q53), each under its membership's lock,
//       with the interval of the member's frequency, and a `membership.price_moved` row; a plan step to archive each
//       old price; the record `done`.
//   then each member's step sent (left.ts, trySendStep: read first, the one item switched with no proration; W57a:
//       never across intervals, refused for good and listed instead).
//   S2  W57a (W57 review S2): NOT in the press. Reconcile archives each old price (read first, safe to repeat) only
//       past its window and only while no pending order names it (`planStepDue`): an order whose T1 read the old price
//       before D2 makes its subscription on it, still active, and its T2 then leaves that member's own move
//       (`followPlanPrice`). So a sale started before a change finishes on the price it was quoted, and a sale
//       started after it reads the new one; neither meets an archived price. (Before W57a the press archived the old
//       price at once, and a reader sale tapped in between was refused at finalise and its tap refunded.)
//       `failPriceChange` and `failPlanCreate` archive only prices nothing names (made for a change or a plan that
//       failed, never written to a plan), so no order can name them; the same check applies to them, harmlessly.
//
// A new plan (GB20): the row, off sale, with its record (`plan.created`, `started`) in one transaction (plans.ts);
// then the Stripe product and its prices under keys from the plan's id; then the ids written and the plan put on sale
// in one transaction (`done`). Refused for good: the record `failed`, the row left off sale and off every list (the
// Worker has no right to delete a plan row, and nothing else can name it). Unclear: `held`; reconcile finds what was
// made (products and prices listed by `metadata.plan_id`) and makes what wasn't, under the same keys, then finishes.
//
// On and off sale (plans.ts): on, Stripe's product first and then the row; off, the row first and the product as a
// plan step left. Every product step that closes is checked once more 20 minutes later against the plan's row (as
// left.ts's W40c check): a late send that undid it is put right by a new step.
import 'server-only'
import type Stripe from 'stripe'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import { CHECK_AFTER_MINUTES, leaveStepReplacing, membershipHasEnded, newestOf, openSteps, recordStepDone, ENDED_HERE_DETAIL, trySendStep, type LeftStep, type StepBy } from '@/server/rules/memberships/left'
import { PROCESSING_MINUTES } from '@/server/rules/orders/pending-order'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { PLAN_STUCK_WORDS } from './plan-failure-messages'

export const PLAN_CHANGE_ACTION = 'plan.price_change'
export const PLAN_CREATED_ACTION = 'plan.created'
export const PLAN_ACTIVE_ACTION = 'plan.active_set'
export const PLAN_DETAILS_ACTION = 'plan.details_set'
export const PLAN_STEP_ACTION = 'plan.stripe_step'
export const PRICE_MOVED_ACTION = 'membership.price_moved'
export const PLAN_ENTITY = 'membership_plan'

export type Frequency = 'monthly' | 'yearly'
export const FREQUENCIES: readonly Frequency[] = ['monthly', 'yearly']
const INTERVAL: Readonly<Record<Frequency, 'month' | 'year'>> = { monthly: 'month', yearly: 'year' }
/** The plan's column that holds each frequency's Stripe price. */
export const PRICE_ID_COLUMN: Readonly<Record<Frequency, 'stripe_price_id' | 'stripe_price_id_yearly'>> = { monthly: 'stripe_price_id', yearly: 'stripe_price_id_yearly' }

/** The membership statuses that move with a plan's price (the legacy route's): active, or failing. */
export const LIVE_STATUSES = ['active', 'past_due'] as const

const pence = (pounds: string): number => Math.round(Number.parseFloat(pounds) * 100)
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// --- The record

/** One price of a change: from and to (the column's text), and the Stripe price it replaces (null: none yet). */
export interface ChangedPrice {
  from: string | null
  to: string
  oldPriceId: string | null
}

/** A price change as its `started` row records it: everything S1, reconcile and D2 need, so a retry sends exactly the same. */
export interface PriceChange {
  changeId: string
  planId: string
  /** The plan's Stripe product, or null when S1 makes one (a plan never set up in Stripe). */
  productId: string | null
  productName: string
  /** Whether the product S1 makes starts on sale: as the plan is. */
  productActive: boolean
  prices: Partial<Record<Frequency, ChangedPrice>>
  /** How many live members are on the changing prices, as D1 counted them and staff confirmed (Q53). */
  membersToMove: number
}

type By = StepBy

function planEntry(by: By, action: string, planId: string, details: Record<string, unknown>): AuditEntry {
  return { actorType: by.actor.type, actorId: by.actor.id, action, entityType: PLAN_ENTITY, entityId: planId, requestId: by.requestId, details }
}

/** The change's `started` row, written by D1 in the press's transaction. */
export function changeStartedEntry(by: By, change: PriceChange, key: string | null): AuditEntry {
  return planEntry(by, PLAN_CHANGE_ACTION, change.planId, { ...change, state: 'started', ...(key ? { key } : {}) })
}

const changeEndEntry = (by: By, change: Pick<PriceChange, 'changeId' | 'planId'>, state: 'held' | 'failed' | 'done', extra: Record<string, unknown>): AuditEntry =>
  planEntry(by, PLAN_CHANGE_ACTION, change.planId, { changeId: change.changeId, state, ...extra })

/** The open changes: `started` with no `done` or `failed` row. `held` when the press found no clear answer. */
const OPEN_CHANGES_SQL = `
SELECT s.entity_id AS plan_id, s.details AS started, s.at,
       EXISTS (SELECT 1 FROM audit_log h WHERE h.action = '${PLAN_CHANGE_ACTION}' AND h.entity_type = '${PLAN_ENTITY}' AND h.entity_id = s.entity_id
               AND h.details->>'changeId' = s.details->>'changeId' AND h.details->>'state' = 'held') AS held,
       s.at > now() - interval '${PROCESSING_MINUTES} minutes' AS in_window,
       p.name AS plan_name
FROM audit_log s
LEFT JOIN membership_plans p ON p.id::text = s.entity_id
WHERE s.action = '${PLAN_CHANGE_ACTION}' AND s.entity_type = '${PLAN_ENTITY}' AND s.details->>'state' = 'started'
  AND NOT EXISTS (SELECT 1 FROM audit_log e WHERE e.action = '${PLAN_CHANGE_ACTION}' AND e.entity_type = '${PLAN_ENTITY}' AND e.entity_id = s.entity_id
                  AND e.details->>'changeId' = s.details->>'changeId' AND e.details->>'state' IN ('done', 'failed'))
ORDER BY s.at, s.details->>'changeId'`

export interface OpenChange {
  change: PriceChange
  at: string
  held: boolean
  inWindow: boolean
  planName: string | null
}

const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString())

export async function openChanges(db: Queryable): Promise<OpenChange[]> {
  const rows = await db.query<{ plan_id: string; started: PriceChange & { state: string }; at: string | Date; held: boolean; in_window: boolean; plan_name: string | null }>(OPEN_CHANGES_SQL)
  return rows.map((row) => ({ change: changeOf(row.started), at: iso(row.at), held: row.held === true, inWindow: row.in_window === true, planName: row.plan_name }))
}

function changeOf(details: PriceChange): PriceChange {
  return {
    changeId: details.changeId,
    planId: details.planId,
    productId: details.productId ?? null,
    productName: details.productName,
    productActive: details.productActive === true,
    prices: details.prices ?? {},
    membersToMove: Number(details.membersToMove ?? 0),
  }
}

/**
 * Whether a price change on the plan is still open: its record not yet done or failed, or its members' steps still
 * inside their press's window (that press may still be sending them). D1 refuses a second change while so.
 */
export async function changeStillOpen(tx: Queryable, planId: string): Promise<boolean> {
  if ((await openChanges(tx)).some((open) => open.change.planId === planId)) return true
  return priceStepsInWindow(tx, planId)
}

/** A price step left for the plan (its `left` row's `planId`) still open, not refused, and inside its press's window. */
const PRICE_STEPS_IN_WINDOW_SQL = `
SELECT 1 FROM audit_log s
WHERE s.action = 'membership.step_left' AND s.details->>'state' = 'left' AND s.details->>'kind' = 'price' AND s.details->>'planId' = $1
  AND s.at > now() - interval '${PROCESSING_MINUTES} minutes'
  AND NOT EXISTS (SELECT 1 FROM audit_log e WHERE e.action = 'membership.step_left' AND e.details->>'stepId' = s.details->>'stepId'
                  AND e.details->>'state' IN ('done', 'sorted', 'replaced', 'undone', 'refused'))
LIMIT 1`
async function priceStepsInWindow(tx: Queryable, planId: string): Promise<boolean> {
  return (await tx.query(PRICE_STEPS_IN_WINDOW_SQL, [planId])).length > 0
}

// --- S1: the new price(s)

export type Made = { productId: string; priceIds: Partial<Record<Frequency, string>> }
export type StripeOutcome<T> = { kind: 'made'; value: T } | { kind: 'refused'; message: string; partly?: Partial<Made> } | { kind: 'unclear'; message: string }

/** A Stripe failure as an outcome: refused when Stripe answered and said no, unclear otherwise. */
function failureOf(err: unknown): { kind: 'refused'; message: string } | { kind: 'unclear'; message: string } {
  if (err instanceof NoTimeLeft) return { kind: 'unclear', message: err.message }
  const failure = readStripeFailure(err)
  return failure.outcome === 'definite' ? { kind: 'refused', message: failure.message } : { kind: 'unclear', message: failure.message }
}

/** The keys a change's sends carry: from the record's id (F-plan 4.2 item 4). */
export const changeKey = (changeId: string, what: 'product' | Frequency): string => stripeIdempotencyKey(changeId, what)

/** What S1 sends for a price: built from the record alone, so reconcile's never differs from the press's. */
export function changePriceParams(change: PriceChange, frequency: Frequency, productId: string): Stripe.PriceCreateParams {
  const price = change.prices[frequency] as ChangedPrice
  return {
    product: productId,
    unit_amount: pence(price.to),
    currency: 'gbp',
    recurring: { interval: INTERVAL[frequency] },
    metadata: { plan_id: change.planId, change_id: change.changeId, frequency },
  }
}

const changeProductParams = (change: PriceChange): Stripe.ProductCreateParams => ({
  name: change.productName,
  active: change.productActive,
  metadata: { supabase_id: change.planId, item_type: 'membership_plan', plan_id: change.planId, change_id: change.changeId },
})

/** S1: the product (only for a plan never set up in Stripe), then each new price, each under its key. Never throws for Stripe. */
export async function makeChangePrices(stripe: StripeClient, change: PriceChange, timing: StripeTiming | undefined): Promise<StripeOutcome<Made>> {
  let productId = change.productId
  const priceIds: Partial<Record<Frequency, string>> = {}
  try {
    if (!productId) productId = (await stripe.products.create(changeProductParams(change), sendOptions(timing, { idempotencyKey: changeKey(change.changeId, 'product') }))).id
    for (const frequency of FREQUENCIES) {
      if (!change.prices[frequency]) continue
      const made = await stripe.prices.create(changePriceParams(change, frequency, productId), sendOptions(timing, { idempotencyKey: changeKey(change.changeId, frequency) }))
      priceIds[frequency] = made.id
    }
    return { kind: 'made', value: { productId, priceIds } }
  } catch (err) {
    const failed = failureOf(err)
    return failed.kind === 'refused' ? { ...failed, partly: { ...(productId ? { productId } : {}), priceIds } } : failed
  }
}

/** Every page of a list, up to `most` rows (a plan has a handful of prices; the bound only stops a loop in bad data). */
export async function everyPage<T extends { id: string }>(page: (startingAfter: string | undefined) => Promise<Stripe.ApiList<T>>, most = 1000): Promise<T[]> {
  const all: T[] = []
  let after: string | undefined
  for (;;) {
    const list = await page(after)
    all.push(...list.data)
    if (!list.has_more || list.data.length === 0 || all.length >= most) return all
    after = list.data.at(-1)?.id
  }
}

/**
 * Reconcile's read for a held change: the product (from the record, or found by `metadata.change_id` when S1 was to
 * make it) and each price found by `metadata.change_id` and its frequency. Never sends anything. `found` lists what
 * there is; `whole` says whether every price the change needs is there.
 */
export async function findChangePrices(stripe: StripeClient, change: PriceChange): Promise<{ kind: 'read'; whole: boolean; found: Partial<Made> } | { kind: 'unclear'; message: string }> {
  try {
    let productId = change.productId
    if (!productId) {
      const products = await everyPage((after) => stripe.products.list({ limit: 100, ...(after ? { starting_after: after } : {}) }))
      productId = products.find((product) => product.metadata?.['change_id'] === change.changeId)?.id ?? null
    }
    if (!productId) return { kind: 'read', whole: false, found: { priceIds: {} } }
    const prices = await everyPage((after) => stripe.prices.list({ product: productId as string, limit: 100, ...(after ? { starting_after: after } : {}) }))
    const priceIds: Partial<Record<Frequency, string>> = {}
    for (const frequency of FREQUENCIES) {
      const found = prices.find((price) => price.metadata?.['change_id'] === change.changeId && price.metadata?.['frequency'] === frequency)
      if (found) priceIds[frequency] = found.id
    }
    const whole = FREQUENCIES.every((frequency) => !change.prices[frequency] || priceIds[frequency] !== undefined)
    return { kind: 'read', whole, found: { productId, priceIds } }
  } catch (err) {
    return { kind: 'unclear', message: `not read (${message(err)})` }
  }
}

// --- Plan steps: an old price to archive, the product on or off sale

export type PlanStepKind = 'archive_price' | 'product_active'
export interface PlanStep {
  id: string
  planId: string
  kind: PlanStepKind
  /** `archive_price`: the price. `product_active`: the product and whether it should be on sale. */
  want: { priceId?: string; productId?: string; active?: boolean }
}
type PlanStepState = 'left' | 'done' | 'refused' | 'replaced' | 'sorted' | 'checked'
const PLAN_STEP_CLOSING: readonly PlanStepState[] = ['done', 'replaced', 'sorted']

const planStepEntry = (by: By, step: PlanStep, state: PlanStepState, extra: Record<string, unknown> = {}): AuditEntry =>
  planEntry(by, PLAN_STEP_ACTION, step.planId, { stepId: step.id, kind: step.kind, want: step.want, state, ...extra })

export function newPlanStep(planId: string, kind: PlanStepKind, want: PlanStep['want']): PlanStep {
  return { id: crypto.randomUUID(), planId, kind, want }
}
export const planStepLeftEntry = (by: By, step: PlanStep, extra: Record<string, unknown> = {}): AuditEntry => planStepEntry(by, step, 'left', extra)
export const planStepDoneEntry = (by: By, step: PlanStep, detail: string): AuditEntry => planStepEntry(by, step, 'done', { detail })

/**
 * W57a (W57 review S2): an old price a pending order still names. A membership order's T1 puts the plan's Stripe price
 * in its snapshot (`reader_payment.membership.stripe_price_id`) and makes the subscription on it later (a second
 * later on a saved card; after the tap, at finalise, on the reader), so the price must stay active until no pending
 * order names it. Booking flows (pending_reader_payments) never sell a membership, so only orders are asked.
 */
export const PRICE_NAMED_BY_PENDING_ORDER_SQL = `EXISTS (SELECT 1 FROM orders o WHERE o.payment_status = 'pending' AND o.reader_payment->'membership'->>'stripe_price_id' = s.details->'want'->>'priceId')`

const OPEN_PLAN_STEPS_SQL = `
SELECT s.entity_id AS plan_id, s.details->>'stepId' AS step_id, s.details->>'kind' AS kind, s.details->'want' AS want, s.at,
       r.detail IS NOT NULL AS refused, r.detail AS refusal,
       s.at > now() - interval '${PROCESSING_MINUTES} minutes' AS in_window, p.name AS plan_name,
       (s.details->>'kind' = 'archive_price' AND ${PRICE_NAMED_BY_PENDING_ORDER_SQL}) AS named_by_order
FROM audit_log s
LEFT JOIN LATERAL (
  SELECT COALESCE(f.details->>'detail', '') AS detail FROM audit_log f
  WHERE f.action = '${PLAN_STEP_ACTION}' AND f.entity_id = s.entity_id AND f.details->>'stepId' = s.details->>'stepId' AND f.details->>'state' = 'refused'
  ORDER BY f.at DESC LIMIT 1
) r ON true
LEFT JOIN membership_plans p ON p.id::text = s.entity_id
WHERE s.action = '${PLAN_STEP_ACTION}' AND s.entity_type = '${PLAN_ENTITY}' AND s.details->>'state' = 'left'
  AND NOT EXISTS (SELECT 1 FROM audit_log e WHERE e.action = '${PLAN_STEP_ACTION}' AND e.entity_id = s.entity_id AND e.details->>'stepId' = s.details->>'stepId'
                  AND e.details->>'state' IN (${PLAN_STEP_CLOSING.map((state) => `'${state}'`).join(', ')}))
ORDER BY s.at, s.details->>'stepId'`

export interface OpenPlanStep extends PlanStep {
  at: string
  refused: boolean
  refusal: string | null
  inWindow: boolean
  planName: string | null
  /** W57a (S2): an `archive_price` step whose price a pending order still names: not sent, and not listed, until none does. */
  namedByOrder: boolean
}

export async function openPlanSteps(db: Queryable): Promise<OpenPlanStep[]> {
  const rows = await db.query<{ plan_id: string; step_id: string; kind: string; want: PlanStep['want'] | null; at: string | Date; refused: boolean; refusal: string | null; in_window: boolean; plan_name: string | null; named_by_order: boolean | null }>(OPEN_PLAN_STEPS_SQL)
  return rows
    .filter((row) => row.kind === 'archive_price' || row.kind === 'product_active')
    .map((row) => ({
      id: row.step_id,
      planId: row.plan_id,
      kind: row.kind as PlanStepKind,
      want: row.want ?? {},
      at: iso(row.at),
      refused: row.refused === true,
      refusal: row.refused ? (row.refusal ?? '') : null,
      inWindow: row.in_window === true,
      planName: row.plan_name,
      namedByOrder: row.named_by_order === true,
    }))
}

/**
 * W57a (W57 review S2): whether reconcile may send the plan step now: past its press's window, not refused, and, for
 * an old price to archive, no pending order naming it (an order that read it before D2 makes its subscription on it).
 */
export const planStepDue = (step: Pick<OpenPlanStep, 'refused' | 'inWindow' | 'namedByOrder'>): boolean => !step.refused && !step.inWindow && !step.namedByOrder

/** Every open product step of the plan closed as `replaced` (a newer on or off press), in the caller's transaction. */
export async function replaceProductSteps(tx: Tx, planId: string, by: By, replacedBy: string | null): Promise<OpenPlanStep[]> {
  const open = (await openPlanSteps(tx)).filter((step) => step.planId === planId && step.kind === 'product_active')
  if (open.length > 0) await audit.recordAll(tx, open.map((step) => planStepEntry(by, step, 'replaced', replacedBy ? { replacedBy } : {})))
  return open
}

/** Whether an off press's product step for the plan is still inside its press's window (that press may still be sending it). */
export async function offStillBeingSent(tx: Queryable, planId: string): Promise<boolean> {
  return (await openPlanSteps(tx)).some((step) => step.planId === planId && step.kind === 'product_active' && step.want.active === false && step.inWindow && !step.refused)
}

/**
 * W57a (W57 review L3): every product step an off press has left for the plan (open or closed), by id. An on press
 * reads them before it goes to Stripe and again after, under the plan's lock: a new one means an off press was made
 * meanwhile, and the on press is refused rather than written over it. A step the 20-minute check leaves is not a press.
 */
const OFF_PRESS_STEPS_SQL = `
SELECT DISTINCT details->>'stepId' AS step_id FROM audit_log
WHERE action = '${PLAN_STEP_ACTION}' AND entity_type = '${PLAN_ENTITY}' AND entity_id = $1 AND details->>'state' = 'left'
  AND details->>'kind' = 'product_active' AND details->'want'->>'active' = 'false' AND details->>'byPress' = 'true'`
export async function offPressSteps(tx: Queryable, planId: string): Promise<string[]> {
  return (await tx.query<{ step_id: string }>(OFF_PRESS_STEPS_SQL, [planId])).map((row) => row.step_id)
}

const planStepKey = (step: PlanStep, attempt?: string): string => {
  const key = stripeIdempotencyKey(step.id, step.kind === 'archive_price' ? 'archive-price' : step.want.active ? 'product-on' : 'product-off')
  return attempt ? `${key}:${attempt}` : key
}

export type PlanStepAnswer = { kind: 'done'; detail: string } | { kind: 'refused'; message: string } | { kind: 'unclear'; message: string }

/**
 * One plan step's send. An old price archived (`active: false`; a price Stripe can't find has nothing to archive:
 * done); the product on or off sale. Read first, sent only if Stripe doesn't already show it. Never throws for Stripe.
 */
export async function sendPlanStep(stripe: StripeClient, step: PlanStep, timing: StripeTiming | undefined, attempt?: string): Promise<PlanStepAnswer> {
  try {
    if (step.kind === 'archive_price') {
      const priceId = step.want.priceId as string
      let price: Stripe.Price
      try {
        price = await stripe.prices.retrieve(priceId, undefined, sendOptions(timing))
      } catch (err) {
        if (readStripeFailure(err).code === 'resource_missing') return { kind: 'done', detail: 'Stripe has no such price: nothing to archive' }
        throw err
      }
      if (price.active === false) return { kind: 'done', detail: 'Stripe already showed it archived' }
      await stripe.prices.update(priceId, { active: false }, sendOptions(timing, { idempotencyKey: planStepKey(step, attempt) }))
      return { kind: 'done', detail: 'archived' }
    }
    const productId = step.want.productId as string
    const active = step.want.active === true
    const now = await stripe.products.retrieve(productId, undefined, sendOptions(timing))
    if (now.active === active) return { kind: 'done', detail: 'Stripe already showed it' }
    await stripe.products.update(productId, { active }, sendOptions(timing, { idempotencyKey: planStepKey(step, attempt) }))
    return { kind: 'done', detail: 'sent' }
  } catch (err) {
    return failureOf(err)
  }
}

/** A plan step's answer recorded, only while it is still open (one closed meanwhile gets no row). Answers whether written. */
export async function recordPlanStep(db: Db, step: PlanStep, answer: Exclude<PlanStepAnswer, { kind: 'unclear' }>, by: By): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT id FROM membership_plans WHERE id::text = $1 FOR NO KEY UPDATE', [step.planId])
    const still = (await openPlanSteps(tx)).find((open) => open.id === step.id)
    if (!still) return false
    if (answer.kind === 'refused' && still.refused) return false
    await audit.recordAll(tx, [answer.kind === 'done' ? planStepEntry(by, step, 'done', { detail: answer.detail }) : planStepEntry(by, step, 'refused', { detail: answer.message })])
    return true
  })
}

/**
 * Reconcile's turn at one open plan step (past its press's window, not refused). A product step is looked at again
 * under the plan's lock first: one whose wish is no longer the plan's (a later press put it the other way) is closed
 * as `replaced`, with nothing sent.
 */
export async function settlePlanStep(db: Db, stripe: StripeClient, stepId: string, by: By, timing: StripeTiming | undefined): Promise<{ kind: 'done' | 'refused' | 'left' | 'closed'; detail: string }> {
  const step = (await openPlanSteps(db)).find((open) => open.id === stepId)
  if (!step) return { kind: 'closed', detail: 'closed' }
  if (step.refused) return { kind: 'refused', detail: step.refusal ?? '' }
  if (step.inWindow) return { kind: 'left', detail: `recorded less than ${PROCESSING_MINUTES} minutes ago: its press may still be sending it` }
  // W57a (W57 review S2): an old price stays active while a pending order names it (read again here, just before the send).
  if (step.namedByOrder) return { kind: 'left', detail: 'a pending order still names this price: archived once no pending order does' }
  if (step.kind === 'product_active') {
    const stale = await db.transaction(async (tx) => {
      const [plan] = await tx.query<{ active: boolean | null }>('SELECT active FROM membership_plans WHERE id::text = $1 FOR NO KEY UPDATE', [step.planId])
      if (plan && (plan.active === true) !== (step.want.active === true)) {
        await audit.recordAll(tx, [planStepEntry(by, step, 'replaced', { detail: "the plan's row is now the other way" })])
        return true
      }
      return false
    })
    if (stale) return { kind: 'closed', detail: "the plan's row is now the other way: not sent" }
  }
  const answer = await sendPlanStep(stripe, step, timing, by.requestId)
  if (answer.kind === 'unclear') return { kind: 'left', detail: answer.message }
  await recordPlanStep(db, step, answer, by)
  return answer.kind === 'done' ? { kind: 'done', detail: answer.detail } : { kind: 'refused', detail: answer.message }
}

/**
 * A person records a refused plan step as sorted, once Stripe has been put right by hand. Nothing is sent. `closeRow`:
 * the manual close's own `order.close` row, written with the `sorted` row.
 */
const PLAN_STEP_SORTED_SQL = `SELECT 1 FROM audit_log WHERE action = '${PLAN_STEP_ACTION}' AND details->>'stepId' = $1 AND details->>'state' = 'sorted' LIMIT 1`
export async function sortPlanStep(db: Db, stepId: string, why: string, by: By, closeRow?: (step: OpenPlanStep) => AuditEntry): Promise<{ closed: boolean; alreadyClosed?: true; reason?: 'not_listed' | 'still_trying' }> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`plan-step:${stepId}`])
    const step = (await openPlanSteps(tx)).find((open) => open.id === stepId)
    if (!step) {
      const sorted = await tx.query(PLAN_STEP_SORTED_SQL, [stepId])
      return sorted.length > 0 ? { closed: true, alreadyClosed: true as const } : { closed: false, reason: 'not_listed' as const }
    }
    if (!step.refused) return { closed: false, reason: 'still_trying' as const }
    await audit.recordAll(tx, [planStepEntry(by, step, 'sorted', { byHand: { why } }), ...(closeRow ? [closeRow(step)] : [])])
    return { closed: true }
  })
}

// --- The product checked once more after a product step closes (as left.ts's W40c)

const PRODUCT_CHECKS_DUE_SQL = `
SELECT e.entity_id AS plan_id, jsonb_agg(DISTINCT e.details->>'stepId') AS step_ids, max(s.details->'want'->>'productId') AS product_id
FROM audit_log e
JOIN audit_log s ON s.action = '${PLAN_STEP_ACTION}' AND s.entity_id = e.entity_id AND s.details->>'stepId' = e.details->>'stepId' AND s.details->>'state' = 'left'
WHERE e.action = '${PLAN_STEP_ACTION}' AND e.entity_type = '${PLAN_ENTITY}' AND e.details->>'kind' = 'product_active'
  AND e.details->>'state' IN ('done', 'replaced') AND e.at < now() - interval '${CHECK_AFTER_MINUTES} minutes'
  AND NOT EXISTS (SELECT 1 FROM audit_log c WHERE c.action = '${PLAN_STEP_ACTION}' AND c.entity_id = e.entity_id AND c.details->>'state' = 'checked'
                  AND c.details->'steps' ? (e.details->>'stepId'))
GROUP BY e.entity_id
ORDER BY min(e.at), e.entity_id`

export interface ProductCheckDue {
  planId: string
  stepIds: string[]
  productId: string | null
}

export async function productChecksDue(db: Queryable): Promise<ProductCheckDue[]> {
  const rows = await db.query<{ plan_id: string; step_ids: string[] | null; product_id: string | null }>(PRODUCT_CHECKS_DUE_SQL)
  return rows.filter((row) => (row.step_ids ?? []).length > 0).map((row) => ({ planId: row.plan_id, stepIds: row.step_ids ?? [], productId: row.product_id }))
}

/**
 * One plan's closed product steps, checked once against Stripe: the product's `active` set against the plan's row.
 * Agrees: one `checked` row. Differs: a new product step wanting the row's state, left in the same transaction (sent
 * by a later run past its window). With a product step still open, nothing is read: it is checked when it closes.
 * No clear read: nothing written, and the next run reads again. Answers what it found, or null for nothing to report.
 */
export async function checkProduct(db: Db, stripe: StripeClient, due: ProductCheckDue, by: By, timing: StripeTiming | undefined): Promise<{ kind: 'checked' | 'left_again' | 'wait'; detail: string }> {
  if ((await openPlanSteps(db)).some((step) => step.planId === due.planId && step.kind === 'product_active')) {
    return db.transaction(async (tx) => {
      await audit.recordAll(tx, [planEntry(by, PLAN_STEP_ACTION, due.planId, { state: 'checked', steps: due.stepIds, outcome: 'open', detail: 'a newer product step is open: checked when it closes' })])
      return { kind: 'checked' as const, detail: 'a newer product step is open' }
    })
  }
  const [plan] = await db.query<{ active: boolean | null; stripe_product_id: string | null }>('SELECT active, stripe_product_id FROM membership_plans WHERE id::text = $1', [due.planId])
  const productId = plan?.stripe_product_id ?? due.productId
  if (!plan || !productId) {
    return db.transaction(async (tx) => {
      await audit.recordAll(tx, [planEntry(by, PLAN_STEP_ACTION, due.planId, { state: 'checked', steps: due.stepIds, outcome: 'checked', detail: 'no plan or no product to hold Stripe to' })])
      return { kind: 'checked' as const, detail: 'nothing to check' }
    })
  }
  let shown: boolean
  try {
    shown = (await stripe.products.retrieve(productId, undefined, sendOptions(timing))).active === true
  } catch (err) {
    return { kind: 'wait', detail: `not read (${message(err)})` }
  }
  return db.transaction(async (tx) => {
    const [now] = await tx.query<{ active: boolean | null }>('SELECT active FROM membership_plans WHERE id::text = $1 FOR NO KEY UPDATE', [due.planId])
    const wanted = now?.active === true
    const again = shown === wanted ? null : newPlanStep(due.planId, 'product_active', { productId, active: wanted })
    await audit.recordAll(tx, [
      ...(again ? [planStepLeftEntry(by, again, { leftAgainBy: 'check' })] : []),
      planEntry(by, PLAN_STEP_ACTION, due.planId, { state: 'checked', steps: due.stepIds, outcome: again ? 'left_again' : 'checked', detail: `Stripe shows the product ${shown ? 'on' : 'off'} sale; the plan is ${wanted ? 'on' : 'off'} sale`, ...(again ? { leftAgain: again.id } : {}) }),
    ])
    return again ? { kind: 'left_again' as const, detail: `Stripe showed the product ${shown ? 'on' : 'off'} sale: left again as step ${again.id}` } : { kind: 'checked' as const, detail: 'Stripe agrees' }
  })
}

// --- D2

const LOCK_PLAN_SQL = 'SELECT id FROM membership_plans WHERE id = $1::uuid FOR NO KEY UPDATE'
const CHANGE_CLOSED_SQL = `SELECT 1 FROM audit_log WHERE action = '${PLAN_CHANGE_ACTION}' AND entity_type = '${PLAN_ENTITY}' AND entity_id = $1 AND details->>'changeId' = $2 AND details->>'state' IN ('done', 'failed') LIMIT 1`

/**
 * The live memberships on the plan whose price changes, locked in id order (after the plan's lock: LOCK_ORDER's
 * admin_row, then membership). A membership with no frequency recorded renews monthly, as the legacy route had it.
 */
const LIVE_ON_PLAN_SQL = `
SELECT id::text AS id, stripe_subscription_id, COALESCE(billing_frequency, 'monthly') AS frequency
FROM customer_memberships
WHERE plan_id = $1::uuid AND stripe_subscription_id IS NOT NULL
  AND subscription_status IN (${LIVE_STATUSES.map((status) => `'${status}'`).join(', ')})
  AND COALESCE(billing_frequency, 'monthly') = ANY($2::text[])
ORDER BY id
FOR NO KEY UPDATE`

/** How many live members are on each frequency of the plan (what Q53's words count). */
const LIVE_COUNTS_SQL = `
SELECT COALESCE(billing_frequency, 'monthly') AS frequency, count(*)::int AS members
FROM customer_memberships
WHERE plan_id = $1::uuid AND stripe_subscription_id IS NOT NULL AND subscription_status IN (${LIVE_STATUSES.map((status) => `'${status}'`).join(', ')})
GROUP BY 1`

/** The plan's newest change that is done (its id), for a move left after D2 by an order's T2. Null when none. */
const LATEST_DONE_CHANGE_SQL = `SELECT details->>'changeId' AS change_id FROM audit_log WHERE action = '${PLAN_CHANGE_ACTION}' AND entity_type = '${PLAN_ENTITY}' AND entity_id = $1 AND details->>'state' = 'done' ORDER BY at DESC, id DESC LIMIT 1`
export async function latestDoneChange(db: Queryable, planId: string): Promise<string | null> {
  return (await db.query<{ change_id: string | null }>(LATEST_DONE_CHANGE_SQL, [planId]))[0]?.change_id ?? null
}

export async function liveCounts(db: Queryable, planId: string): Promise<Record<Frequency, number>> {
  const rows = await db.query<{ frequency: string; members: number }>(LIVE_COUNTS_SQL, [planId])
  return { monthly: rows.find((row) => row.frequency === 'monthly')?.members ?? 0, yearly: rows.find((row) => row.frequency === 'yearly')?.members ?? 0 }
}

export interface Applied {
  moveSteps: LeftStep[]
  archiveSteps: PlanStep[]
}

/**
 * D2, one transaction: the plan's prices and their new ids written together, one price step per live subscription on
 * a changed price (each under its membership's lock, step F's machinery), a `membership.price_moved` row for each, a
 * plan step to archive each old price, and the record `done`. Null when the change was closed meanwhile (another D2,
 * or reconcile failed it): nothing is written twice.
 */
export async function applyPriceChange(db: Db, change: PriceChange, made: Made, by: By): Promise<Applied | null> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK_PLAN_SQL, [change.planId])
    if ((await tx.query(CHANGE_CLOSED_SQL, [change.planId, change.changeId])).length > 0) return null
    const changed = FREQUENCIES.filter((frequency) => change.prices[frequency] !== undefined)
    const sets: string[] = []
    const values: unknown[] = []
    for (const frequency of changed) {
      values.push((change.prices[frequency] as ChangedPrice).to)
      sets.push(`price_${frequency} = $${values.length}::numeric`)
      values.push(made.priceIds[frequency])
      sets.push(`${PRICE_ID_COLUMN[frequency]} = $${values.length}::text`)
    }
    if (!change.productId) {
      values.push(made.productId)
      sets.push(`stripe_product_id = $${values.length}::text`)
    }
    values.push(change.planId)
    // eslint-disable-next-line no-restricted-syntax -- the columns are literals from PRICE_ID_COLUMN and FREQUENCIES; every value is a parameter
    const updated = await tx.query(`UPDATE membership_plans SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}::uuid RETURNING id`, values as never[])
    if (updated.length !== 1) throw new Error('The plan was held but its price not written.')

    const live = await tx.query<{ id: string; stripe_subscription_id: string; frequency: Frequency }>(LIVE_ON_PLAN_SQL, [change.planId, changed])
    const open = await openSteps(tx)
    const moveSteps: LeftStep[] = []
    const moved: AuditEntry[] = []
    for (const membership of live) {
      const to = made.priceIds[membership.frequency] as string
      // W57a (W57 review S1): with the interval of the member's frequency, so the send never moves them across intervals.
      const left = await leaveStepReplacing(tx, { membershipId: membership.id, subscriptionId: membership.stripe_subscription_id, kind: 'price', want: { price: to, interval: INTERVAL[membership.frequency] } }, by, { planId: change.planId, changeId: change.changeId }, true, open)
      moveSteps.push(left.step)
      moved.push({
        actorType: by.actor.type,
        actorId: by.actor.id,
        action: PRICE_MOVED_ACTION,
        entityType: 'membership',
        entityId: membership.id,
        requestId: by.requestId,
        details: { changeId: change.changeId, planId: change.planId, frequency: membership.frequency, subscriptionId: membership.stripe_subscription_id, fromPriceId: change.prices[membership.frequency]?.oldPriceId ?? null, toPriceId: to, stepId: left.step.id },
      })
    }
    const archiveSteps = changed.flatMap((frequency) => {
      const old = change.prices[frequency]?.oldPriceId
      return old && old !== made.priceIds[frequency] ? [newPlanStep(change.planId, 'archive_price', { priceId: old })] : []
    })
    await audit.recordAll(tx, [
      ...moved,
      ...archiveSteps.map((step) => planStepLeftEntry(by, step, { changeId: change.changeId })),
      changeEndEntry(by, change, 'done', { productId: made.productId, priceIds: made.priceIds, members: moveSteps.length, stepIds: moveSteps.map((step) => step.id) }),
    ])
    return { moveSteps, archiveSteps }
  })
}

/**
 * The change failed (Stripe refused, or reconcile found nothing made past the window): the record `failed`, the
 * plan's price unchanged, and any price (or product) already made archived as a plan step, since nothing names it.
 * False when the change was closed meanwhile.
 */
export async function failPriceChange(db: Db, change: PriceChange, reason: string, made: Partial<Made> | undefined, by: By): Promise<{ failed: boolean; tidy: PlanStep[] }> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK_PLAN_SQL, [change.planId])
    if ((await tx.query(CHANGE_CLOSED_SQL, [change.planId, change.changeId])).length > 0) return { failed: false, tidy: [] }
    const tidy = Object.values(made?.priceIds ?? {}).map((priceId) => newPlanStep(change.planId, 'archive_price', { priceId }))
    await audit.recordAll(tx, [...tidy.map((step) => planStepLeftEntry(by, step, { changeId: change.changeId, orphan: true })), changeEndEntry(by, change, 'failed', { reason, ...(made ? { made } : {}) })])
    return { failed: true, tidy }
  })
}

export async function holdPriceChange(db: Db, change: PriceChange, why: string, by: By): Promise<void> {
  await db.transaction(async (tx) => {
    if ((await tx.query(CHANGE_CLOSED_SQL, [change.planId, change.changeId])).length > 0) return
    await audit.recordAll(tx, [changeEndEntry(by, change, 'held', { detail: why })])
  })
}

/**
 * After D2: each member's move sent (read first; the one item switched with no proration). A membership that has
 * ended here since is closed with no Stripe call. Never throws. Answers how many members Stripe now shows on the new
 * price (or that need nothing more) and how many are still to move (left for reconcile, or refused and listed).
 *
 * W57a (W57 review S2): the old prices are NOT archived here. D2 records their archive steps, and reconcile sends each
 * only past its window and only while no pending order names that price (settlePlanStep): an order whose T1 read the
 * old price before D2 still makes its subscription (or, on the reader, finalises after the tap) on it, and its T2
 * then leaves that member's own move (followPlanPrice).
 */
export async function sendAfterD2(db: Db, stripe: StripeClient, applied: Applied, by: By, timing: StripeTiming | undefined): Promise<{ moved: number; toMove: number }> {
  let moved = 0
  for (const step of applied.moveSteps) {
    try {
      // A newer step has replaced it since (a later change): that one's own press sends it.
      const newest = await newestOf(db, step.id).catch(() => step.id)
      if (newest !== step.id) continue
      if (await membershipHasEnded(db, step.membershipId)) {
        await recordStepDone(db, step, by, ENDED_HERE_DETAIL).catch(() => false)
        moved += 1
        continue
      }
      const answer = await trySendStep(stripe, step, timing)
      // Refused or unclear: left as it is, as a replaced card's step (customers/card-steps.ts). Reconcile sends it again
      // past its window; one Stripe refuses for good is then recorded and listed for a person.
      if (answer.kind !== 'done') continue
      await recordStepDone(db, step, by, answer.detail).catch(() => false)
      moved += 1
    } catch {
      // Left: listed, and reconcile's.
    }
  }
  return { moved, toMove: applied.moveSteps.length - moved }
}

/**
 * Reconcile's turn at an open price change past its press's window: the product's prices read by the record's id.
 * Every one found: D2, then S2 and the moves, as the press would have. None, or only some: failed (a price is never
 * made a second time for a change; any found is archived). No clear read: left for the next run.
 */
export async function settleOpenChange(db: Db, stripe: StripeClient, open: OpenChange, by: By, timing: StripeTiming | undefined): Promise<{ kind: 'done' | 'failed' | 'left' | 'closed'; detail: string }> {
  if (open.inWindow) return { kind: 'left', detail: `recorded less than ${PROCESSING_MINUTES} minutes ago: its press may still be making it` }
  const found = await findChangePrices(stripe, open.change)
  if (found.kind === 'unclear') return { kind: 'left', detail: found.message }
  if (!found.whole) {
    const failed = await failPriceChange(db, open.change, 'Stripe shows no new price made for this change after the window', found.found, by)
    for (const step of failed.tidy) {
      const answer = await sendPlanStep(stripe, step, timing, by.requestId)
      if (answer.kind !== 'unclear') await recordPlanStep(db, step, answer, by).catch(() => false)
    }
    return failed.failed ? { kind: 'failed', detail: 'no new price found in Stripe: the change failed, the plan keeps its price' } : { kind: 'closed', detail: 'closed' }
  }
  const applied = await applyPriceChange(db, open.change, { productId: found.found.productId as string, priceIds: found.found.priceIds ?? {} }, by)
  if (!applied) return { kind: 'closed', detail: 'closed' }
  const sent = await sendAfterD2(db, stripe, applied, by, timing)
  return { kind: 'done', detail: `the new price found in Stripe and written; ${sent.moved} moved, ${sent.toMove} still to move` }
}

// --- A new plan (GB20)

/** What a new plan's sends carry: keys from the plan's own id (its record). */
export const createKey = (planId: string, what: 'plan-product' | 'plan-monthly' | 'plan-yearly'): string => stripeIdempotencyKey(planId, what)

/** A new plan as its `started` row records it, for its sends. */
export interface PlanCreate {
  planId: string
  name: string
  prices: Partial<Record<Frequency, string>>
}

const createProductParams = (plan: PlanCreate): Stripe.ProductCreateParams => ({
  name: plan.name,
  active: true,
  metadata: { supabase_id: plan.planId, item_type: 'membership_plan', plan_id: plan.planId },
})
const createPriceParams = (plan: PlanCreate, frequency: Frequency, productId: string): Stripe.PriceCreateParams => ({
  product: productId,
  unit_amount: pence(plan.prices[frequency] as string),
  currency: 'gbp',
  recurring: { interval: INTERVAL[frequency] },
  metadata: { plan_id: plan.planId, frequency, made_with: 'plan' },
})

/**
 * The plan's Stripe set-up: the product, then each price, each under its key. With `find` (reconcile), each is first
 * looked for in Stripe (the product by `metadata.plan_id`, a price by its product, `metadata.plan_id` and frequency)
 * and made only if missing, under the same key. Never throws for Stripe.
 */
export async function makePlanInStripe(stripe: StripeClient, plan: PlanCreate, timing: StripeTiming | undefined, find: boolean): Promise<StripeOutcome<Made>> {
  let productId: string | null = null
  const priceIds: Partial<Record<Frequency, string>> = {}
  try {
    if (find) {
      const products = await everyPage((after) => stripe.products.list({ limit: 100, ...(after ? { starting_after: after } : {}) }))
      productId = products.find((product) => product.metadata?.['plan_id'] === plan.planId && product.metadata?.['change_id'] === undefined)?.id ?? null
    }
    if (!productId) productId = (await stripe.products.create(createProductParams(plan), sendOptions(timing, { idempotencyKey: createKey(plan.planId, 'plan-product') }))).id
    const existing = find ? await everyPage((after) => stripe.prices.list({ product: productId as string, limit: 100, ...(after ? { starting_after: after } : {}) })) : []
    for (const frequency of FREQUENCIES) {
      if (plan.prices[frequency] === undefined) continue
      const found = existing.find((price) => price.metadata?.['plan_id'] === plan.planId && price.metadata?.['frequency'] === frequency && price.metadata?.['made_with'] === 'plan')
      priceIds[frequency] = found?.id ?? (await stripe.prices.create(createPriceParams(plan, frequency, productId), sendOptions(timing, { idempotencyKey: createKey(plan.planId, frequency === 'monthly' ? 'plan-monthly' : 'plan-yearly') }))).id
    }
    return { kind: 'made', value: { productId, priceIds } }
  } catch (err) {
    const failed = failureOf(err)
    return failed.kind === 'refused' ? { ...failed, partly: { ...(productId ? { productId } : {}), priceIds } } : failed
  }
}

const CREATE_CLOSED_SQL = `SELECT 1 FROM audit_log WHERE action = '${PLAN_CREATED_ACTION}' AND entity_type = '${PLAN_ENTITY}' AND entity_id = $1 AND details->>'state' IN ('done', 'failed') LIMIT 1`

/** The open creates: `started` with no `done` or `failed` row. */
const OPEN_CREATES_SQL = `
SELECT s.entity_id AS plan_id, s.at, p.name, p.price_monthly::text AS price_monthly, p.price_yearly::text AS price_yearly,
       EXISTS (SELECT 1 FROM audit_log h WHERE h.action = '${PLAN_CREATED_ACTION}' AND h.entity_id = s.entity_id AND h.details->>'state' = 'held') AS held,
       s.at > now() - interval '${PROCESSING_MINUTES} minutes' AS in_window
FROM audit_log s
LEFT JOIN membership_plans p ON p.id::text = s.entity_id
WHERE s.action = '${PLAN_CREATED_ACTION}' AND s.entity_type = '${PLAN_ENTITY}' AND s.details->>'state' = 'started'
  AND NOT EXISTS (SELECT 1 FROM audit_log e WHERE e.action = '${PLAN_CREATED_ACTION}' AND e.entity_id = s.entity_id AND e.details->>'state' IN ('done', 'failed'))
ORDER BY s.at, s.entity_id`

export interface OpenCreate {
  plan: PlanCreate
  at: string
  held: boolean
  inWindow: boolean
}

export async function openCreates(db: Queryable): Promise<OpenCreate[]> {
  const rows = await db.query<{ plan_id: string; at: string | Date; name: string | null; price_monthly: string | null; price_yearly: string | null; held: boolean; in_window: boolean }>(OPEN_CREATES_SQL)
  return rows.map((row) => ({
    plan: { planId: row.plan_id, name: row.name ?? '', prices: { ...(row.price_monthly !== null ? { monthly: row.price_monthly } : {}), ...(row.price_yearly !== null ? { yearly: row.price_yearly } : {}) } },
    at: iso(row.at),
    held: row.held === true,
    inWindow: row.in_window === true,
  }))
}

/** Whether the plan is still being set up in Stripe (its create open). */
export async function createStillOpen(db: Queryable, planId: string): Promise<boolean> {
  return (await openCreates(db)).some((open) => open.plan.planId === planId)
}

/** Whether the plan's set-up failed for good (its create `failed`): such a row is left off every list. */
export const CREATE_FAILED_SQL = `EXISTS (SELECT 1 FROM audit_log f WHERE f.action = '${PLAN_CREATED_ACTION}' AND f.entity_type = '${PLAN_ENTITY}' AND f.entity_id = mp.id::text AND f.details->>'state' = 'failed')`

/** C2, one transaction: the Stripe ids written and the plan put on sale, the record `done`. False when closed meanwhile. */
export async function finishPlanCreate(db: Db, plan: PlanCreate, made: Made, by: By): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK_PLAN_SQL, [plan.planId])
    if ((await tx.query(CREATE_CLOSED_SQL, [plan.planId])).length > 0) return false
    const updated = await tx.query(
      'UPDATE membership_plans SET stripe_product_id = $1::text, stripe_price_id = $2::text, stripe_price_id_yearly = $3::text, active = true, updated_at = now() WHERE id = $4::uuid RETURNING id',
      [made.productId, made.priceIds.monthly ?? null, made.priceIds.yearly ?? null, plan.planId]
    )
    if (updated.length !== 1) throw new Error('The plan was held but its Stripe ids not written.')
    await audit.recordAll(tx, [planEntry(by, PLAN_CREATED_ACTION, plan.planId, { state: 'done', productId: made.productId, priceIds: made.priceIds })])
    return true
  })
}

/** The set-up failed for good: the record `failed`; the row stays off sale with no Stripe ids, left off every list; anything made is archived. */
export async function failPlanCreate(db: Db, plan: PlanCreate, reason: string, made: Partial<Made> | undefined, by: By): Promise<{ failed: boolean; tidy: PlanStep[] }> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK_PLAN_SQL, [plan.planId])
    if ((await tx.query(CREATE_CLOSED_SQL, [plan.planId])).length > 0) return { failed: false, tidy: [] }
    const tidy = [
      ...Object.values(made?.priceIds ?? {}).map((priceId) => newPlanStep(plan.planId, 'archive_price', { priceId })),
      ...(made?.productId ? [newPlanStep(plan.planId, 'product_active', { productId: made.productId, active: false })] : []),
    ]
    await audit.recordAll(tx, [...tidy.map((step) => planStepLeftEntry(by, step, { orphan: true })), planEntry(by, PLAN_CREATED_ACTION, plan.planId, { state: 'failed', reason, ...(made ? { made } : {}) })])
    return { failed: true, tidy }
  })
}

export async function holdPlanCreate(db: Db, plan: PlanCreate, why: string, by: By): Promise<void> {
  await db.transaction(async (tx) => {
    if ((await tx.query(CREATE_CLOSED_SQL, [plan.planId])).length > 0) return
    await audit.recordAll(tx, [planEntry(by, PLAN_CREATED_ACTION, plan.planId, { state: 'held', detail: why })])
  })
}

/** Reconcile's turn at a plan left half made, past its press's window: find or make what is missing, then finish; refused for good: failed. */
export async function settleOpenCreate(db: Db, stripe: StripeClient, open: OpenCreate, by: By, timing: StripeTiming | undefined): Promise<{ kind: 'done' | 'failed' | 'left' | 'closed'; detail: string }> {
  if (open.inWindow) return { kind: 'left', detail: `recorded less than ${PROCESSING_MINUTES} minutes ago: its press may still be making it` }
  const made = await makePlanInStripe(stripe, open.plan, timing, true)
  if (made.kind === 'unclear') return { kind: 'left', detail: made.message }
  if (made.kind === 'refused') {
    const failed = await failPlanCreate(db, open.plan, made.message, made.partly, by)
    for (const step of failed.tidy) {
      const answer = await sendPlanStep(stripe, step, timing, by.requestId)
      if (answer.kind !== 'unclear') await recordPlanStep(db, step, answer, by).catch(() => false)
    }
    return failed.failed ? { kind: 'failed', detail: `Stripe refused: ${made.message}` } : { kind: 'closed', detail: 'closed' }
  }
  return (await finishPlanCreate(db, open.plan, made.value, by)) ? { kind: 'done', detail: 'set up in Stripe and put on sale' } : { kind: 'closed', detail: 'closed' }
}

// --- An order's T2: a subscription made on a price a change had just replaced (brief W57 item 3; invariant 11)

/** The plan a membership order sells, read with no lock before T2's first lock (an order's plan never changes). */
export const ORDER_PLAN_SQL = "SELECT o.reader_payment->'membership'->>'plan_id' AS plan_id FROM orders o WHERE o.id = $1::uuid"
/**
 * The plan's Stripe prices, FOR SHARE: a price change's D2 holds the plan FOR NO KEY UPDATE, so T2 and D2 take turns.
 * T2 first: D2 then finds the new membership live and leaves it a step. D2 first: T2 reads the new price here and,
 * when the subscription was made on the old one (its order read the plan before D2), leaves the step itself. Taken
 * before T2's order lock, as LOCK_ORDER has it (admin_row before order); two T2s share it.
 */
export const PLAN_PRICES_FOR_SHARE_SQL = 'SELECT stripe_price_id, stripe_price_id_yearly FROM membership_plans WHERE id = $1::uuid FOR SHARE'
export type PlanPrices = { stripe_price_id: string | null; stripe_price_id_yearly: string | null }

/**
 * After T2 has written the membership (it holds its row's lock): a `price` step when the subscription was made on a
 * price that is no longer the plan's for its frequency, with a `membership.price_moved` row, so the member renews at
 * the plan's price like every other (Q53). Null when the subscription is on the plan's price.
 */
export async function followPlanPrice(
  tx: Tx,
  membership: { planId: string; membershipId: string; subscriptionId: string; frequency: string; madeOn: string | null; orderId: string },
  prices: PlanPrices,
  by: By
): Promise<LeftStep | null> {
  const frequency: Frequency = membership.frequency === 'yearly' ? 'yearly' : 'monthly'
  const target = prices[PRICE_ID_COLUMN[frequency]]
  if (!target || target === membership.madeOn) return null
  const changeId = await latestDoneChange(tx, membership.planId)
  // W57a (W57 review S1): with the interval of the order's frequency, as D2's steps.
  const left = await leaveStepReplacing(tx, { membershipId: membership.membershipId, subscriptionId: membership.subscriptionId, kind: 'price', want: { price: target, interval: INTERVAL[frequency] } }, by, { planId: membership.planId, changeId, leftBy: 'order', orderId: membership.orderId })
  await audit.recordAll(tx, [
    {
      actorType: by.actor.type,
      actorId: by.actor.id,
      action: PRICE_MOVED_ACTION,
      entityType: 'membership',
      entityId: membership.membershipId,
      requestId: by.requestId,
      details: { changeId, planId: membership.planId, frequency: membership.frequency, subscriptionId: membership.subscriptionId, fromPriceId: membership.madeOn, toPriceId: target, stepId: left.step.id, orderId: membership.orderId },
    },
  ])
  return left.step
}

// --- The stuck list's lines (G-plan 4.7)

export interface StuckPlanLine {
  lineId: string
  planId: string
  planName: string | null
  what: 'price_change' | 'plan_create' | 'product_on' | 'product_off' | 'archive_price'
  state: 'left' | 'refused'
  at: string
  words: string
  /** A plan step Stripe refused for good: Mark sorted (`plan_step`). */
  stepId?: string
}

/**
 * A plan's own lines: a price change held (or past its window with no answer), a plan half made, and a plan step
 * left past its window or refused for good. A member's move is a membership step (`steps`, kind `price`).
 */
export async function planStuckLines(db: Queryable): Promise<StuckPlanLine[]> {
  const name = (value: string | null) => value ?? 'a plan'
  const changes = (await openChanges(db))
    .filter((open) => open.held || !open.inWindow)
    .map((open) => ({ lineId: open.change.changeId, planId: open.change.planId, planName: open.planName, what: 'price_change' as const, state: 'left' as const, at: open.at, words: PLAN_STUCK_WORDS.priceHeld(name(open.planName)) }))
  const creates = (await openCreates(db))
    .filter((open) => open.held || !open.inWindow)
    .map((open) => ({ lineId: open.plan.planId, planId: open.plan.planId, planName: open.plan.name || null, what: 'plan_create' as const, state: 'left' as const, at: open.at, words: PLAN_STUCK_WORDS.createHeld(name(open.plan.name || null)) }))
  // W57a (W57 review S2): an old price waiting for a pending order that names it isn't listed: it is waiting, not stuck.
  const steps = (await openPlanSteps(db))
    .filter((step) => step.refused || (!step.inWindow && !step.namedByOrder))
    .map((step) => {
      const what = step.kind === 'archive_price' ? ('archive_price' as const) : step.want.active ? ('product_on' as const) : ('product_off' as const)
      const words =
        step.kind === 'archive_price'
          ? step.refused
            ? PLAN_STUCK_WORDS.archiveRefused(name(step.planName))
            : PLAN_STUCK_WORDS.archiveLeft(name(step.planName))
          : step.refused
            ? PLAN_STUCK_WORDS.productRefused(name(step.planName), step.want.active === true)
            : PLAN_STUCK_WORDS.productLeft(name(step.planName), step.want.active === true)
      return { lineId: step.id, planId: step.planId, planName: step.planName, what, state: step.refused ? ('refused' as const) : ('left' as const), at: step.at, words, ...(step.refused ? { stepId: step.id } : {}) }
    })
  return [...changes, ...creates, ...steps]
}
