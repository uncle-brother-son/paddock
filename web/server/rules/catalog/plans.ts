// Brief W57 (G-plan 1.4, 4.3, 4.4, 4.6, 4.8, 4.10; bugs GB1, GB2, GB14, GB19, GB20; Wayne's Q53; lead calls L3, L11,
// L13; W54a's stale-page rule): membership plans and membership settings on the Worker. Ported from the staff app's
// old functions as they were at W48 (getMembershipPlans, createMembershipPlan,
// setMembershipPlanActive, setMembershipPlanDetails, getMembershipSettings, setMembershipSettings, and
// updateCatalogItemPrice's plan branch), with their words (failure-messages.ts) and the legacy routes' (sync-stripe,
// update-price, toggle-active; lib/membership-price-migration.ts; all removed from the app at W61). Their Stripe side
// is plan-stripe.ts.
//
// Level A (G-plan 4.2): making a plan, its price, and on and off sale. Each is gated by `plan_changes` at its route
// (plan-switch.ts), before anything is read; reconcile still finishes what is held or left.
// Level B: the details a price press carries (D1), and the membership settings (GB19: one transaction, a count shown
// before the press and confirmed by it).
// Reads (GB14): an active staff member, named columns. On the customer channel (G-plan 4.8, for the website's shop;
// lead call L13: no customer route yet) only plans on sale, with no Stripe ids, counts or stamp.
import 'server-only'
import type { AdminAction } from '@/contracts'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { adminRead, namedColumns, namedRead } from '@/server/rules/admin/read'
import { adminRefusal, requireAdminPermission, type AdminActor } from '@/server/rules/admin/refusal'
import { CHANGED_SINCE_REASON, CHANGED_SINCE_WORDS, fieldsStampSql, sameStamp } from '@/server/rules/admin/stamp'
import { lockAdminRows, SETTINGS_ROW } from '@/server/rules/admin/locks'
import type { AdminWriteOptions } from '@/server/rules/admin/write'
import type { StepBy } from '@/server/rules/memberships/left'
import type { StripeClient } from '@/server/stripe/client'
import { stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import { CATALOG_ADMIN_WORDS, LEGACY_CATALOG_ROUTE_WORDS } from './failure-messages'
import { CATALOG_ITEM_NEW_WORDS } from './item-failure-messages'
import { isPoundsAndPence, priceFirst, priceText, withIsoTimes } from './items'
import { herdChangeWords, MEMBERSHIP_SETTINGS_NEW_WORDS, PLAN_NEW_WORDS, planMoveWords, type PlanMoveFigures } from './plan-failure-messages'
import {
  applyPriceChange,
  changeStartedEntry,
  changeStillOpen,
  CREATE_FAILED_SQL,
  createStillOpen,
  failPlanCreate,
  failPriceChange,
  finishPlanCreate,
  FREQUENCIES,
  holdPlanCreate,
  holdPriceChange,
  liveCounts,
  makeChangePrices,
  makePlanInStripe,
  newPlanStep,
  offPressSteps,
  offStillBeingSent,
  openChanges,
  openCreates,
  PLAN_ACTIVE_ACTION,
  PLAN_CREATED_ACTION,
  PLAN_DETAILS_ACTION,
  PLAN_ENTITY,
  planStepDoneEntry,
  planStepLeftEntry,
  recordPlanStep,
  replaceProductSteps,
  sendAfterD2,
  sendPlanStep,
  type ChangedPrice,
  type Frequency,
  type PlanCreate,
  type PriceChange,
} from './plan-stripe'

const WORDS = CATALOG_ADMIN_WORDS
const NEW = PLAN_NEW_WORDS

/** Who is reading (G-plan 4.8): staff, or the website's shop. */
export type PlanReader = { channel: 'staff'; actor: AdminActor } | { channel: 'customer' }

/** What a level A press needs beyond an admin write's: Stripe (made only when it is called), and the request's start for its deadline. */
export interface PlanPressOptions extends AdminWriteOptions {
  stripe: () => StripeClient
  startedAt: number
  now?: () => number
}

const byOf = (options: AdminWriteOptions): StepBy => ({ actor: { type: options.actor.type, id: options.actor.id }, requestId: options.requestId })
const timingOf = (options: PlanPressOptions): StripeTiming => stripeTiming(options.startedAt, options.now ?? Date.now)

// --- Reads

/** Every column of a plan's row, by name, in the table's order (as the old `SELECT *` answered it). */
export const PLAN_COLUMNS = ['id', 'sanity_plan_id', 'name', 'thumbnail_url', 'sessions_included', 'addons_included', 'stripe_product_id', 'stripe_price_id', 'active', 'created_at', 'updated_at', 'price_monthly', 'price_yearly', 'level', 'is_unlimited', 'stripe_price_id_yearly'] as const
const PLAN_MONEY = ['price_monthly', 'price_yearly'] as const
export const planColumnsSql = (alias: string): string => namedColumns(alias, PLAN_COLUMNS, PLAN_MONEY)

/**
 * W54a: the columns the edit dialog sends back whole (the details and both prices). The stamp is of these only (W54a
 * "Noticed" 2): an on or off sale press, a Stripe id written, or a thumbnail synced from Sanity doesn't refuse an edit
 * that puts none of them back. W57a (W57 review point 8): the Sanity webhook also writes `name` on every republish,
 * and `name` is one of these, so a republish while an edit is open refuses that edit (`changed_since`): safe, and the
 * dialog reloads.
 */
export const PLAN_EDIT_COLUMNS = ['name', 'level', 'is_unlimited', 'sessions_included', 'addons_included', 'price_monthly', 'price_yearly'] as const
const planStampSql = (alias: string): string => fieldsStampSql(alias, PLAN_EDIT_COLUMNS)

export type PlanRow = Record<(typeof PLAN_COLUMNS)[number], unknown>

const LIVE = "cm.stripe_subscription_id IS NOT NULL AND cm.subscription_status IN ('active', 'past_due')"
const PLANS_SQL = `
SELECT ${planColumnsSql('mp')}, ${planStampSql('mp')} AS stamp,
       (SELECT count(*)::int FROM customer_memberships cm WHERE cm.plan_id = mp.id AND ${LIVE} AND COALESCE(cm.billing_frequency, 'monthly') = 'monthly') AS members_monthly,
       (SELECT count(*)::int FROM customer_memberships cm WHERE cm.plan_id = mp.id AND ${LIVE} AND cm.billing_frequency = 'yearly') AS members_yearly
FROM membership_plans mp
WHERE NOT ${CREATE_FAILED_SQL}
ORDER BY mp.name`

/** The website's shop: plans on sale, set up in Stripe, with no Stripe ids. */
const CUSTOMER_PLANS_SQL = `
SELECT mp.id, mp.sanity_plan_id, mp.name, mp.thumbnail_url, mp.sessions_included, mp.addons_included, mp.price_monthly::text AS price_monthly,
       mp.price_yearly::text AS price_yearly, mp.level, mp.is_unlimited
FROM membership_plans mp
WHERE mp.active = true AND mp.stripe_product_id IS NOT NULL AND NOT ${CREATE_FAILED_SQL}
ORDER BY mp.name`

/** A plan as the staff list has it: its row (the old read's), and what the page needs beside it. */
export type PlanListRow = PlanRow & {
  stamp: string
  /** Q53: the live members on each price, for the edit dialog's words and the count it sends. */
  members_monthly: number
  members_yearly: number
  /** GB20: `being_set_up` while its Stripe set-up is open; `not_set_up` with no Stripe product (never synced). */
  setup: 'ready' | 'being_set_up' | 'not_set_up'
  /** A price change still being made: the dialog says so, and the Worker refuses another. */
  price_change_open: boolean
}

/**
 * `GET catalog/membership-plans` (getMembershipPlans; New Order's plan picker reads it too). Staff: every plan by
 * name (a plan whose Stripe set-up failed for good is left out: GB20), each row as the old read had it with its
 * stamp, its live members per price, its set-up state and whether a price change is open. Customer: plans on sale only.
 */
export async function listPlans(db: Queryable, reader: PlanReader): Promise<Array<Record<string, unknown>>> {
  if (reader.channel === 'customer') return namedRead(db, { name: 'catalog.membership_plans', sql: CUSTOMER_PLANS_SQL })
  const rows = await adminRead<Record<string, unknown>>(db, { name: 'catalog.membership_plans', needs: 'staff', sql: PLANS_SQL, times: ['created_at', 'updated_at'] }, { actor: reader.actor })
  const creating = new Set((await openCreates(db)).map((open) => open.plan.planId))
  const changing = new Set((await openChanges(db)).map((open) => open.change.planId))
  return rows.map((row) => ({
    ...row,
    setup: creating.has(String(row['id'])) ? 'being_set_up' : row['stripe_product_id'] ? 'ready' : 'not_set_up',
    price_change_open: changing.has(String(row['id'])),
  }))
}

const SETTINGS_SQL = 'SELECT addon_credit_wait_months FROM membership_settings WHERE id = true LIMIT 1'
/** The schema's default, as the old read answered with no row. */
export const DEFAULT_WAIT_MONTHS = 6

/** `GET membership-settings` (getMembershipSettings): the waiting period, or the schema's default with no row, as before. */
export async function readMembershipSettings(db: Queryable, actor: AdminActor): Promise<{ addonCreditWaitMonths: number }> {
  const [row] = await adminRead<{ addon_credit_wait_months: number }>(db, { name: 'membership_settings.read', needs: 'staff', sql: SETTINGS_SQL }, { actor })
  return { addonCreditWaitMonths: row ? row.addon_credit_wait_months : DEFAULT_WAIT_MONTHS }
}

// --- Membership settings (GB19, level B)

/**
 * How many members' Herd flag a waiting period of `$1` months would change: the rule `refresh_herd_flags()` applies
 * (the same expression, word for word), against every membership with no override. `become`: now Herd; `leave`: no
 * longer. What the refresh will change, counted before it does.
 */
const HERD_CHANGE_SQL = `
WITH rule AS (
  SELECT cm.is_herd,
         coalesce((cm.billing_frequency = 'yearly'
                   or cm.start_date <= (now() at time zone 'Europe/London')::date - ($1::int || ' months')::interval), false) AS herd
  FROM public.customer_memberships cm
  WHERE cm.herd_override IS NULL
)
SELECT count(*) FILTER (WHERE herd AND is_herd IS DISTINCT FROM herd)::int AS become,
       count(*) FILTER (WHERE NOT herd AND is_herd IS DISTINCT FROM herd)::int AS leave
FROM rule`

const settingsAction: AdminAction = 'membership_settings.set'
function checkedMonths(action: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 60) {
    throw adminRefusal('VALIDATION', action, 'invalid_params', WORDS.setMembershipSettings.waitingPeriodMustWholeNumberMonths, { field: 'addonCreditWaitMonths' })
  }
  return value
}

async function herdChange(db: Queryable, months: number): Promise<{ become: number; leave: number }> {
  const [row] = await db.query<{ become: number; leave: number }>(HERD_CHANGE_SQL, [months])
  return { become: row?.become ?? 0, leave: row?.leave ?? 0 }
}

export interface HerdQuote {
  addonCreditWaitMonths: number
  herdFlagsToChange: number
  becomeHerd: number
  leaveHerd: number
  message: string
}

/** `GET membership-settings/quote`: what the control shows before the press (GB19). Any active staff member; nothing written. */
export async function quoteMembershipSettings(db: Queryable, months: unknown, actor: AdminActor): Promise<HerdQuote> {
  requireAdminPermission(actor, 'staff', 'membership_settings.quote')
  const wait = checkedMonths('membership_settings.quote', months)
  const change = await herdChange(db, wait)
  return { addonCreditWaitMonths: wait, herdFlagsToChange: change.become + change.leave, becomeHerd: change.become, leaveHerd: change.leave, message: herdChangeWords(wait, change.become, change.leave) }
}

/**
 * `POST membership-settings` (setMembershipSettings; GB19). Manage pricing; the old check in its words; then one
 * transaction under the settings row's lock: the row must be there (the old words), the count of members whose Herd
 * flag changes must be the one the control showed and sent (else refused, nothing written), the waiting period set,
 * the Herd rule run again (`refresh_herd_flags()`, as before, in the same transaction now), and a
 * `membership_settings.set` row with the period before and after and both counts. Answers as before.
 */
export async function setMembershipSettings(db: Db, months: unknown, confirmed: unknown, options: AdminWriteOptions): Promise<{ addonCreditWaitMonths: number; herdFlagsChanged: number }> {
  if (!options.pressKey) throw new Error('The membership settings press was run without a press key: its route must be idempotent.')
  requireAdminPermission(options.actor, 'manage_pricing', settingsAction)
  const wait = checkedMonths(settingsAction, months)
  return db.transaction(async (tx) => {
    const held = await lockAdminRows(tx, [{ table: 'membership_settings', ids: SETTINGS_ROW }])
    const [before] = await tx.query<{ addon_credit_wait_months: number }>(SETTINGS_SQL)
    if (!held.membership_settings?.length || !before) throw adminRefusal('NOT_FOUND', settingsAction, 'settings_missing', WORDS.setMembershipSettings.membershipSettingsRowMissingInsertIt)
    const change = await herdChange(tx, wait)
    const now = change.become + change.leave
    if (typeof confirmed !== 'number') throw adminRefusal('VALIDATION', settingsAction, 'count_missing', MEMBERSHIP_SETTINGS_NEW_WORDS.confirmCountMissing, { field: 'herdFlagsToChange' })
    if (confirmed !== now) throw adminRefusal('CONFLICT', settingsAction, CHANGED_SINCE_REASON, MEMBERSHIP_SETTINGS_NEW_WORDS.countChanged(confirmed, now))
    const [after] = await tx.query<{ addon_credit_wait_months: number }>('UPDATE membership_settings SET addon_credit_wait_months = $1::int, updated_at = now() WHERE id = true RETURNING addon_credit_wait_months', [wait])
    const [refreshed] = await tx.query<{ rows_changed: number | null }>('SELECT public.refresh_herd_flags() AS rows_changed')
    const herdFlagsChanged = refreshed?.rows_changed ?? 0
    await audit.record(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: settingsAction,
      entityType: 'membership_settings',
      entityId: 'true',
      requestId: options.requestId,
      details: { before: { addon_credit_wait_months: before.addon_credit_wait_months }, after: { addon_credit_wait_months: after?.addon_credit_wait_months ?? wait }, herdFlagsShown: confirmed, herdFlagsChanged, becomeHerd: change.become, leaveHerd: change.leave, key: options.pressKey },
    })
    return { addonCreditWaitMonths: after?.addon_credit_wait_months ?? wait, herdFlagsChanged }
  })
}

// --- A plan's row, read back

const PLAN_ROW_SQL = `SELECT ${planColumnsSql('mp')}, ${planStampSql('mp')} AS stamp FROM membership_plans mp WHERE mp.id = $1::uuid`
async function planRow(db: Queryable, planId: string): Promise<{ plan: PlanRow; stamp: string } | null> {
  const [row] = await db.query<PlanRow & { stamp: string }>(PLAN_ROW_SQL, [planId])
  if (!row) return null
  const { stamp, ...plan } = row
  return { plan: withIsoTimes(plan as Record<string, unknown>) as PlanRow, stamp }
}

// --- Creating a plan (GB20; level A)

const createAction: AdminAction = 'plan.created'
const invalid = (action: string, message: string, field?: string) => adminRefusal('VALIDATION', action, 'invalid_params', message, field ? { field } : {})

/** A price sent for a plan: a number 0 or more (the old words), then pounds and pence (W53 review L7). Null stays null. */
function planPrice(action: string, value: unknown, field: string, oldWords: string, nullable: boolean): number | null {
  if (value === null && nullable) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid(action, oldWords, field)
  return value
}

export interface PlanCreateInput {
  name?: unknown
  level?: unknown
  sessionsIncluded?: unknown
  addonsIncluded?: unknown
  isUnlimited?: unknown
  priceMonthly?: unknown
  priceYearly?: unknown
}

/** The plan as made, and (GB20) what its Stripe set-up came to when it didn't finish. */
export type PlanCreateAnswer = PlanRow & { create?: { state: 'held'; message: string } }

/**
 * `POST catalog/membership-plans` (createMembershipPlan; GB20). Manage pricing; the old checks in their words and
 * order, then L7's; then:
 *  1. one transaction: the row, off sale, with its record (`plan.created`, `started`);
 *  2. the Stripe product and its prices, under keys from the plan's id (plan-stripe.ts);
 *  3. one transaction: the ids written and the plan put on sale (`done`).
 * Refused by Stripe: the record `failed`, the row left off sale and off every list, Stripe's reason. Unclear: `held`,
 * the plan answered off sale with the words; reconcile finishes it. The route is idempotent: a press repeated under
 * its key is answered from the first, so a repeated press makes one plan.
 */
export async function createPlan(db: Db, input: PlanCreateInput, options: PlanPressOptions): Promise<PlanCreateAnswer> {
  if (!options.pressKey) throw new Error('The plan create press was run without a press key: its route must be idempotent.')
  const action = createAction
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const W = WORDS.createMembershipPlan
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const isUnlimited = input.isUnlimited
  const sessions = isUnlimited ? 0 : input.sessionsIncluded
  if (!name) throw invalid(action, W.nameRequired, 'name')
  if (input.level !== 'core' && input.level !== 'all_access') throw invalid(action, W.levelMustEitherCoreOrAll, 'level')
  if (typeof sessions !== 'number' || !Number.isInteger(sessions) || sessions < 0) throw invalid(action, W.sessionsIncludedMustNonNegativeWhole, 'sessionsIncluded')
  if (!isUnlimited && sessions < 1) throw invalid(action, W.sessionsIncludedMustPositiveWholeNumber, 'sessionsIncluded')
  if (typeof input.addonsIncluded !== 'number' || !Number.isInteger(input.addonsIncluded) || input.addonsIncluded < 0) throw invalid(action, W.addOnsIncludedMustNonNegative, 'addonsIncluded')
  if (typeof isUnlimited !== 'boolean') throw invalid(action, W.isunlimitedMustTrueOrFalse, 'isUnlimited')
  // A price left out is sent as null by the dialog; JSON has no undefined.
  const monthlyIn = input.priceMonthly === undefined ? null : input.priceMonthly
  const yearlyIn = input.priceYearly === undefined ? null : input.priceYearly
  if (monthlyIn === null && yearlyIn === null) throw invalid(action, W.atLeastOnePriceMustProvided)
  const monthly = planPrice(action, monthlyIn, 'priceMonthly', W.monthlyPriceMustNonNegativeNumber, true)
  const yearly = planPrice(action, yearlyIn, 'priceYearly', W.yearlyPriceMustNonNegativeNumber, true)
  for (const [field, value] of [['priceMonthly', monthly], ['priceYearly', yearly]] as const) {
    if (value !== null && !isPoundsAndPence(value)) throw adminRefusal('VALIDATION', action, 'not_pounds_and_pence', CATALOG_ITEM_NEW_WORDS.notPoundsAndPence(field), { field })
  }
  const by = byOf(options)

  const made = await db.transaction(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO membership_plans (name, level, is_unlimited, sessions_included, addons_included, price_monthly, price_yearly, active)
       VALUES ($1::text, $2::text, $3::boolean, $4::int, $5::int, $6::numeric, $7::numeric, false) RETURNING id`,
      [name, input.level as string, isUnlimited, sessions, input.addonsIncluded as number, monthly === null ? null : priceText(monthly), yearly === null ? null : priceText(yearly)]
    )
    if (!row) throw new Error('The plan was not written.')
    const after = await planRow(tx, row.id)
    await audit.record(tx, { actorType: options.actor.type, actorId: options.actor.id, action, entityType: PLAN_ENTITY, entityId: row.id, requestId: options.requestId, details: { state: 'started', before: null, after: after?.plan ?? null, key: options.pressKey } })
    return row.id
  })
  const plan: PlanCreate = { planId: made, name, prices: { ...(monthly !== null ? { monthly: priceText(monthly) } : {}), ...(yearly !== null ? { yearly: priceText(yearly) } : {}) } }

  const stripe = options.stripe()
  const timing = timingOf(options)
  const outcome = await makePlanInStripe(stripe, plan, timing, false)
  if (outcome.kind === 'refused') {
    const failed = await failPlanCreate(db, plan, outcome.message, outcome.partly, by)
    for (const step of failed.tidy) {
      const answer = await sendPlanStep(stripe, step, timing)
      if (answer.kind !== 'unclear') await recordPlanStep(db, step, answer, by).catch(() => false)
    }
    throw adminRefusal('CONFLICT', action, 'stripe_refused', NEW.createRefused(outcome.message))
  }
  if (outcome.kind === 'unclear') {
    await holdPlanCreate(db, plan, outcome.message, by).catch(() => undefined)
    const row = await planRow(db, plan.planId)
    return { ...((row?.plan ?? {}) as PlanRow), create: { state: 'held', message: NEW.createHeld } }
  }
  await finishPlanCreate(db, plan, outcome.value, by)
  const row = await planRow(db, plan.planId)
  return (row?.plan ?? {}) as PlanRow
}

// --- On and off sale (level A)

const activeAction: AdminAction = 'plan.active_set'
const itemNotFound = (action: string) => adminRefusal('NOT_FOUND', action, 'item_not_found', LEGACY_CATALOG_ROUTE_WORDS['toggle-active'].itemNotFound)
const LOCK_PLAN_ROW_SQL = 'SELECT id, active, stripe_product_id, name, (price_monthly IS NOT NULL OR price_yearly IS NOT NULL) AS priced FROM membership_plans WHERE id = $1::uuid'

type PlanSwitchSeen = { id: string; active: boolean | null; stripe_product_id: string | null; name: string; priced: boolean }

/** The plan's row under its lock, as the switch reads it; "Item not found" when there is none. */
async function lookAtPlan(tx: Tx, planId: string): Promise<PlanSwitchSeen> {
  const held = await lockAdminRows(tx, [{ table: 'membership_plans', ids: [planId] }])
  const [row] = held.membership_plans?.length ? await tx.query<PlanSwitchSeen>(LOCK_PLAN_ROW_SQL, [planId]) : []
  if (!row) throw itemNotFound(activeAction)
  return row
}

/** The switch's `plan.active_set` row (after any step rows in `extra`), by whoever pressed it. */
const recordPlanSwitch = (tx: Tx, by: StepBy, key: string | null, planId: string, before: PlanSwitchSeen, active: boolean, extra: AuditEntry[]) =>
  audit.recordAll(tx, [...extra, { actorType: by.actor.type, actorId: by.actor.id, action: activeAction, entityType: PLAN_ENTITY, entityId: planId, requestId: by.requestId, details: { before: { id: before.id, active: before.active === true }, after: { id: before.id, active }, key } }])

/**
 * `POST catalog/membership-plans/:planId/active` (setMembershipPlanActive). Manage pricing. Live members are never
 * touched, as before.
 *  On:  the plan must be set up in Stripe (not still being set up; not just taken off sale with that still being
 *       sent) and (W66a, Wayne's Q61) have a price, monthly or yearly: "Set its price first." otherwise, before
 *       anything is sent; Stripe's product put on sale first, then one transaction: the row on, any off step closed as
 *       replaced, a product step recorded `done` (so it is checked 20 minutes later), and `plan.active_set`. A Stripe
 *       refusal or no clear answer changes nothing here.
 *  Off: refused while a price change on the plan is still open (W58c, FL4). Otherwise one transaction: the row off,
 *       any open product step replaced, a product step left (off), `plan.active_set`;
 *       then the step sent. Stripe's answer never undoes the row: unclear or refused, the step is reconcile's (and a
 *       refusal is listed for a person).
 * A switch writes only what was pressed, so it carries no stamp (W54a).
 */
export async function setPlanActive(db: Db, planId: string, active: unknown, options: PlanPressOptions): Promise<{ id: string; active: boolean }> {
  if (!options.pressKey) throw new Error('The plan switch was run without a press key: its route must be idempotent.')
  const action = activeAction
  requireAdminPermission(options.actor, 'manage_pricing', action)
  if (typeof active !== 'boolean') throw invalid(action, 'active must be true or false', 'active')
  const by = byOf(options)
  const stripe = () => options.stripe()
  const timing = timingOf(options)

  const look = (tx: Tx): Promise<PlanSwitchSeen> => lookAtPlan(tx, planId)
  const record = (tx: Tx, before: PlanSwitchSeen, extra: AuditEntry[]) => recordPlanSwitch(tx, by, options.pressKey, planId, before, active, extra)

  if (active) {
    const seen = await db.transaction(async (tx) => {
      const row = await look(tx)
      if (await createStillOpen(tx, planId)) throw adminRefusal('CONFLICT', action, 'still_being_set_up', NEW.stillBeingSetUp)
      if (!row.stripe_product_id) throw adminRefusal('CONFLICT', action, 'no_stripe_product', NEW.noStripeProduct)
      if (await offStillBeingSent(tx, planId)) throw adminRefusal('CONFLICT', action, 'off_still_being_sent', NEW.offStillBeingSent)
      // W66a (Q61): a plan sold at one frequency only needs that one price (the checkout refuses the other).
      if (!row.priced) throw priceFirst(action)
      // W57a (W57 review L3): the off presses made so far, so the second transaction can tell one made meanwhile.
      return { ...row, offPresses: await offPressSteps(tx, planId) }
    })
    const step = newPlanStep(planId, 'product_active', { productId: seen.stripe_product_id as string, active: true })
    const sent = await sendPlanStep(stripe(), step, timing)
    if (sent.kind === 'refused') throw adminRefusal('CONFLICT', action, 'stripe_refused', NEW.onRefused(sent.message))
    if (sent.kind === 'unclear') throw adminRefusal('CONFLICT', action, 'stripe_unclear', NEW.onUnclear)
    return db.transaction(async (tx) => {
      const before = await look(tx)
      // W57a (W57 review L3): an off press made while this one was at Stripe stands. Writing the row on over it (and
      // closing its step as replaced) would leave the row on and the product off in Stripe until the 20-minute check.
      // Refused, nothing written: the row stays off, and the off press's own step (sent, or reconcile's) and its
      // 20-minute check put Stripe's product back off if this press's send landed last.
      if ((await offPressSteps(tx, planId)).some((id) => !seen.offPresses.includes(id))) throw adminRefusal('CONFLICT', action, 'off_pressed_meanwhile', NEW.offPressedMeanwhile)
      await replaceProductSteps(tx, planId, by, step.id)
      await tx.query('UPDATE membership_plans SET active = true, updated_at = now() WHERE id = $1::uuid', [planId])
      await record(tx, before, [planStepLeftEntry(by, step, { byPress: true }), planStepDoneEntry(by, step, sent.detail)])
      return { id: planId, active: true }
    })
  }

  return takePlanOffSale(db, planId, { by, key: options.pressKey, stripe, timing })
}

/**
 * The plan switch's "off" (setPlanActive above), by whoever takes the plan off sale: a staff member's press, or (W66,
 * H7) a Sanity delete of the plan's document, by the system as `sanity`. Refused while a price change on the plan is
 * still open (`price_change_open`), nothing written. Otherwise one transaction: the row off, any open product step
 * replaced, a product step left (off), `plan.active_set`; then the step sent. Stripe's answer never undoes the row:
 * unclear or refused, the step is reconcile's (and a refusal is listed for a person).
 */
export async function takePlanOffSale(db: Db, planId: string, how: { by: StepBy; key: string | null; stripe: () => StripeClient; timing: StripeTiming | undefined }): Promise<{ id: string; active: false }> {
  const { by, timing } = how
  const left = await db.transaction(async (tx) => {
    const before = await lookAtPlan(tx, planId)
    // W58c (W58 review FL4): Stripe won't move a subscription onto an off-sale product's price, so while a price change
    // on the plan is still open (its record, or its members' moves inside their press's window) the plan stays on
    // sale. Refused under the plan's lock, nothing written.
    if (await changeStillOpen(tx, planId)) throw adminRefusal('CONFLICT', activeAction, 'price_change_open', NEW.offWhileChangeOpen)
    await replaceProductSteps(tx, planId, by, null)
    const step = before.stripe_product_id ? newPlanStep(planId, 'product_active', { productId: before.stripe_product_id, active: false }) : null
    await tx.query('UPDATE membership_plans SET active = false, updated_at = now() WHERE id = $1::uuid', [planId])
    await recordPlanSwitch(tx, by, how.key, planId, before, false, step ? [planStepLeftEntry(by, step, { byPress: true })] : [])
    return step
  })
  if (left) {
    const client = how.stripe()
    const answer = await sendPlanStep(client, left, timing)
    if (answer.kind !== 'unclear') await recordPlanStep(db, left, answer, by).catch(() => false)
  }
  return { id: planId, active: false }
}

// --- Details and price (D1; level A when a price changes)

export interface PlanDetailsInput {
  name?: unknown
  level?: unknown
  isUnlimited?: unknown
  sessionsIncluded?: unknown
  addonsIncluded?: unknown
  priceMonthly?: unknown
  priceYearly?: unknown
  /** updateCatalogItemPrice's own fields (a price-only press): its plan branch's. */
  monthlyPrice?: unknown
  yearlyPrice?: unknown
  basePrice?: unknown
  memberPrice?: unknown
  salePrice?: unknown
  /** Q53: how many members the dialog said will move. */
  membersToMove?: unknown
  /** W54a: the stamp of the row the dialog opened on (details presses only). */
  stamp?: unknown
}

/** What a price change came to, for the screen (Q53). */
export interface PriceChangeAnswer {
  changeId: string
  state: 'done' | 'held'
  membersToMove: number
  moved: number
  toMove: number
  message: string
}

export interface PlanDetailsAnswer {
  plan: PlanRow
  stamp: string
  priceChange: PriceChangeAnswer | null
  /** A price-only press (updateCatalogItemPrice): each price set, as the number sent, as the legacy route answered. */
  pricesUpdated?: Record<string, number>
}

type PlanSeen = {
  id: string
  name: string
  active: boolean | null
  stripe_product_id: string | null
  stripe_price_id: string | null
  stripe_price_id_yearly: string | null
  price_monthly: string | null
  price_yearly: string | null
  level: string | null
  is_unlimited: boolean
  sessions_included: number | null
  addons_included: number | null
  stamp: string
}
const PLAN_SEEN_SQL = `SELECT id, name, active, stripe_product_id, stripe_price_id, stripe_price_id_yearly, price_monthly::text AS price_monthly, price_yearly::text AS price_yearly,
  level, is_unlimited, sessions_included, addons_included, ${planStampSql('membership_plans')} AS stamp FROM membership_plans WHERE id = $1::uuid`

const PRICE_ONLY_FIELDS = ['basePrice', 'memberPrice', 'salePrice', 'monthlyPrice', 'yearlyPrice'] as const

/** The checked press: details (or none, for a price-only press) and the prices sent, in pounds. */
interface CheckedPress {
  priceOnly: boolean
  details: { name: string | null; level: string; isUnlimited: boolean; sessions: number; addons: number } | null
  prices: Partial<Record<Frequency, number>>
  action: AdminAction
  notFound: string
}

/** The old checks, in their order and words, then L7's: the details press's (setMembershipPlanDetails) or the price-only press's (updateCatalogItemPrice's). */
function checkPress(input: PlanDetailsInput): CheckedPress {
  // A details press always sends the level (the old function's type required it); a price-only press never does.
  const priceOnly = input.level === undefined
  if (priceOnly) {
    const action: AdminAction = 'plan.price_change'
    const P = WORDS.updateCatalogItemPrice
    const sent = PRICE_ONLY_FIELDS.filter((field) => input[field] !== undefined)
    if (sent.length === 0) throw invalid(action, P.atLeastOnePriceFieldMust)
    for (const field of sent) {
      const value = input[field]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid(action, P.mustNonNegativeNumber(field), field)
    }
    for (const field of sent) {
      if (!isPoundsAndPence(input[field] as number)) throw adminRefusal('VALIDATION', action, 'not_pounds_and_pence', CATALOG_ITEM_NEW_WORDS.notPoundsAndPence(field), { field })
    }
    const other = sent.find((field) => field !== 'monthlyPrice' && field !== 'yearlyPrice')
    if (other) throw adminRefusal('VALIDATION', action, 'field_not_on_item', CATALOG_ITEM_NEW_WORDS.fieldNotOnThisItem(other, 'a membership plan'), { field: other })
    return {
      priceOnly,
      details: null,
      prices: { ...(input.monthlyPrice !== undefined ? { monthly: input.monthlyPrice as number } : {}), ...(input.yearlyPrice !== undefined ? { yearly: input.yearlyPrice as number } : {}) },
      action,
      notFound: LEGACY_CATALOG_ROUTE_WORDS['update-price'].itemNotFound,
    }
  }
  const action: AdminAction = 'plan.details_set'
  const D = WORDS.setMembershipPlanDetails
  const isUnlimited = input.isUnlimited
  const sessions = isUnlimited ? 0 : input.sessionsIncluded
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw invalid(action, D.nameRequired, 'name')
  if (input.level !== 'core' && input.level !== 'all_access') throw invalid(action, D.levelMustEitherCoreOrAll, 'level')
  if (typeof sessions !== 'number' || !Number.isInteger(sessions) || sessions < 0) throw invalid(action, D.sessionsIncludedMustNonNegativeWhole, 'sessionsIncluded')
  if (!isUnlimited && sessions < 1) throw invalid(action, D.sessionsIncludedMustPositiveWholeNumber, 'sessionsIncluded')
  if (typeof input.addonsIncluded !== 'number' || !Number.isInteger(input.addonsIncluded) || input.addonsIncluded < 0) throw invalid(action, D.addOnsIncludedMustNonNegative, 'addonsIncluded')
  // New: the old edit never checked it, and a value that isn't true or false was saved as whatever the database made of it.
  if (typeof isUnlimited !== 'boolean') throw invalid(action, NEW.isUnlimitedTrueOrFalse, 'isUnlimited')
  const monthly = planPrice(action, input.priceMonthly, 'priceMonthly', D.monthlyPriceMustNonNegativeNumber, false) as number
  const yearly = planPrice(action, input.priceYearly, 'priceYearly', D.yearlyPriceMustNonNegativeNumber, false) as number
  for (const [field, value] of [['priceMonthly', monthly], ['priceYearly', yearly]] as const) {
    if (!isPoundsAndPence(value)) throw adminRefusal('VALIDATION', action, 'not_pounds_and_pence', CATALOG_ITEM_NEW_WORDS.notPoundsAndPence(field), { field })
  }
  return {
    priceOnly,
    details: { name: typeof input.name === 'string' ? input.name.trim() : null, level: input.level, isUnlimited, sessions, addons: input.addonsIncluded },
    prices: { monthly, yearly },
    action,
    notFound: D.membershipPlanNotFound,
  }
}

const penceOf = (pounds: string | number | null): number | null => (pounds === null ? null : Math.round(Number(pounds) * 100))

/**
 * Which prices the press changes, as the old function decided (setMembershipPlanDetails): a price sent that differs
 * from the stored one (in pence), or one with no Stripe price yet while a price above £0 is stored (so a plan whose
 * Stripe price was never made gets one).
 */
function pricesToChange(seen: PlanSeen, sent: Partial<Record<Frequency, number>>): Partial<Record<Frequency, ChangedPrice>> {
  const out: Partial<Record<Frequency, ChangedPrice>> = {}
  for (const frequency of FREQUENCIES) {
    const value = sent[frequency]
    if (value === undefined) continue
    const stored = frequency === 'monthly' ? seen.price_monthly : seen.price_yearly
    const priceId = frequency === 'monthly' ? seen.stripe_price_id : seen.stripe_price_id_yearly
    const changed = stored === null || penceOf(stored) !== penceOf(value)
    const needsStripePrice = priceId === null && stored !== null && Number(stored) > 0
    if (changed || needsStripePrice) out[frequency] = { from: stored, to: priceText(value), oldPriceId: priceId }
  }
  return out
}

/**
 * `POST catalog/membership-plans/:planId/details` (setMembershipPlanDetails; and updateCatalogItemPrice's plan
 * branch, as a price-only press with no details). G-plan 4.4:
 *  D1  one transaction under the plan's lock: Manage pricing (before anything is read); the old checks and words;
 *      the plan found; not still being set up in Stripe; (a details press) the stamp of the row the dialog opened on;
 *      the details written with `plan.details_set`; and when a price changes: refused while another change is open,
 *      refused unless the member count staff were shown is still right (Q53), then the record (`plan.price_change`,
 *      `started`) with the old and new prices and the count.
 *  then (a price changed) S1, D2 and the moves (plan-stripe.ts). Refused by Stripe: the record failed, the price
 *      unchanged, Stripe's reason. Unclear: held, answered with the words; reconcile finishes or fails it. W57a (W57
 *      review S2): S2, the old price archived, is reconcile's, once no pending order names it (plan-stripe.ts).
 * Answers the plan's row as the old function did, its new stamp, and what the price change came to.
 */
export async function setPlanDetails(db: Db, planId: string, input: PlanDetailsInput, options: PlanPressOptions): Promise<PlanDetailsAnswer> {
  if (!options.pressKey) throw new Error('The plan details press was run without a press key: its route must be idempotent.')
  requireAdminPermission(options.actor, 'manage_pricing', input.level === undefined ? 'plan.price_change' : 'plan.details_set')
  const press = checkPress(input)
  const { action } = press
  const by = byOf(options)

  const started = await db.transaction(async (tx) => {
    const held = await lockAdminRows(tx, [{ table: 'membership_plans', ids: [planId] }])
    const [seen] = held.membership_plans?.length ? await tx.query<PlanSeen>(PLAN_SEEN_SQL, [planId]) : []
    if (!seen) throw adminRefusal('NOT_FOUND', action, 'plan_not_found', press.notFound)
    if (!press.priceOnly && !sameStamp(input.stamp, seen.stamp)) throw adminRefusal('CONFLICT', action, CHANGED_SINCE_REASON, CHANGED_SINCE_WORDS)
    if (await createStillOpen(tx, planId)) throw adminRefusal('CONFLICT', action, 'still_being_set_up', NEW.stillBeingSetUp)
    const changing = pricesToChange(seen, press.prices)
    const frequencies = FREQUENCIES.filter((frequency) => changing[frequency] !== undefined)
    let change: PriceChange | null = null
    let figures: PlanMoveFigures = {}
    if (frequencies.length > 0) {
      if (await changeStillOpen(tx, planId)) throw adminRefusal('CONFLICT', 'plan.price_change', 'price_change_open', NEW.changeStillOpen)
      const counts = await liveCounts(tx, planId)
      const toMove = frequencies.reduce((total, frequency) => total + counts[frequency], 0)
      // W58 item 0: Stripe refuses a subscription onto an inactive product's price (the W57 preview), so an off-sale
      // plan with members on the changing price is refused here, before any Stripe price is made. The details the
      // same press carries aren't saved either (the refusal ends the transaction): staff are told nothing changed.
      if (seen.active !== true && toMove > 0) throw adminRefusal('CONFLICT', 'plan.price_change', 'off_sale_with_members', NEW.offSaleWithMembers(toMove))
      if (typeof input.membersToMove !== 'number') throw adminRefusal('VALIDATION', 'plan.price_change', 'count_missing', NEW.confirmCountMissing, { field: 'membersToMove' })
      if (input.membersToMove !== toMove) throw adminRefusal('CONFLICT', 'plan.price_change', CHANGED_SINCE_REASON, NEW.countChanged(input.membersToMove, toMove))
      figures = Object.fromEntries(frequencies.map((frequency) => [frequency, { members: counts[frequency], price: Number((changing[frequency] as ChangedPrice).to) }]))
      change = {
        changeId: crypto.randomUUID(),
        planId,
        productId: seen.stripe_product_id,
        productName: press.details?.name ?? seen.name,
        productActive: seen.active === true,
        prices: changing,
        membersToMove: toMove,
      }
    }
    const entries: AuditEntry[] = []
    if (press.details) {
      const before = { name: seen.name, level: seen.level, is_unlimited: seen.is_unlimited, sessions_included: seen.sessions_included, addons_included: seen.addons_included }
      const [after] = await tx.query<typeof before>(
        `UPDATE membership_plans SET name = COALESCE($1::text, name), level = $2::text, is_unlimited = $3::boolean, sessions_included = $4::int, addons_included = $5::int, updated_at = now()
         WHERE id = $6::uuid RETURNING name, level, is_unlimited, sessions_included, addons_included`,
        [press.details.name, press.details.level, press.details.isUnlimited, press.details.sessions, press.details.addons, planId]
      )
      entries.push({ actorType: options.actor.type, actorId: options.actor.id, action: PLAN_DETAILS_ACTION, entityType: PLAN_ENTITY, entityId: planId, requestId: options.requestId, details: { before, after: after ?? null, key: options.pressKey, ...(change ? { changeId: change.changeId } : {}) } })
    }
    if (change) entries.push(changeStartedEntry(by, change, options.pressKey))
    if (entries.length > 0) await audit.recordAll(tx, entries)
    return { change, figures }
  })

  const answer = async (priceChange: PriceChangeAnswer | null): Promise<PlanDetailsAnswer> => {
    const row = await planRow(db, planId)
    if (!row) throw adminRefusal('NOT_FOUND', action, 'plan_not_found', press.notFound)
    const pricesUpdated = press.priceOnly ? Object.fromEntries(Object.entries(press.prices).map(([frequency, value]) => [`price_${frequency}`, value as number])) : undefined
    return { plan: row.plan, stamp: row.stamp, priceChange, ...(pricesUpdated ? { pricesUpdated } : {}) }
  }
  const change = started.change
  if (!change) return answer(null)

  const stripe = options.stripe()
  const timing = timingOf(options)
  const made = await makeChangePrices(stripe, change, timing)
  if (made.kind === 'refused') {
    const failed = await failPriceChange(db, change, made.message, made.partly, by)
    for (const step of failed.tidy) {
      const sent = await sendPlanStep(stripe, step, timing)
      if (sent.kind !== 'unclear') await recordPlanStep(db, step, sent, by).catch(() => false)
    }
    throw adminRefusal('CONFLICT', 'plan.price_change', 'stripe_refused', NEW.priceRefused(made.message))
  }
  if (made.kind === 'unclear') {
    await holdPriceChange(db, change, made.message, by).catch(() => undefined)
    return answer({ changeId: change.changeId, state: 'held', membersToMove: change.membersToMove, moved: 0, toMove: change.membersToMove, message: NEW.priceHeld })
  }
  const applied = await applyPriceChange(db, change, made.value, by)
  if (!applied) {
    // Closed meanwhile (reconcile can't have: it waits for the window): answered as held, for the list to settle.
    return answer({ changeId: change.changeId, state: 'held', membersToMove: change.membersToMove, moved: 0, toMove: change.membersToMove, message: NEW.priceHeld })
  }
  const sent = await sendAfterD2(db, stripe, applied, by, timing)
  return answer({ changeId: change.changeId, state: 'done', membersToMove: change.membersToMove, moved: sent.moved, toMove: sent.toMove, message: `${planMoveWords(started.figures)} ${NEW.priceChanged(sent.moved, sent.toMove)}` })
}

export { PLAN_CREATED_ACTION, PLAN_ACTIVE_ACTION }
