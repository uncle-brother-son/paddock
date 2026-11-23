import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as activeRoute } from '@/app/api/v1/staff/catalog/membership-plans/[planId]/active/route'
import { POST as detailsRoute } from '@/app/api/v1/staff/catalog/membership-plans/[planId]/details/route'
import { GET as plansRoute, POST as createRoute } from '@/app/api/v1/staff/catalog/membership-plans/route'
import { GET as quoteRoute } from '@/app/api/v1/staff/membership-settings/quote/route'
import { GET as settingsRoute, POST as setSettingsRoute } from '@/app/api/v1/staff/membership-settings/route'
import { catalogPlansRouteOutputSchema, stuckListOutputSchema } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db } from '@/server/db'
import { CHANGED_SINCE_WORDS } from '@/server/rules/admin/stamp'
import { LEFT_STEP_WORDS, MEMBERSHIP_PATH_OFF_MESSAGE, PRICE_MOVE_INTERVAL_WORDS } from '@/server/rules/memberships/failure-messages'
import { checkAfterClosing, checksDue, ENDED_HERE_REFUSED_DETAIL, sortLeftStep, STEP_LEFT_ACTION, type CheckDue } from '@/server/rules/memberships/left'
import { closeStuckItem } from '@/server/rules/orders/close-stuck'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { ADMIN_TEST_KEY, pressRoute, type AdminAnswer, type AdminRouteHandler } from '@/server/rules/testing/admin-routes'
import { insert } from '@/server/rules/testing/database'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { ALL_KINDS_ON, orderInput, postOrder, postReaderStep, withQuotedCardFigure } from '@/server/rules/testing/sweep/order-presses'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { CATALOG_ADMIN_WORDS } from './failure-messages'
import { herdChangeWords, MEMBERSHIP_SETTINGS_NEW_WORDS, PLAN_NEW_WORDS, PLAN_STUCK_WORDS, planMoveWords } from './plan-failure-messages'
import { applyPriceChange, changeStartedEntry, followPlanPrice, makeChangePrices, openChanges, PLAN_CHANGE_ACTION, PLAN_STEP_ACTION, PRICE_MOVED_ACTION, type PriceChange } from './plan-stripe'
import { listPlans } from './plans'

// Brief W57 (G-plan 4.4, 4.7, 4.9 items 5 and 6; bugs GB1, GB2, GB19, GB20; Wayne's Q53): membership plans and settings
// through the Worker's routes, on the replay's live schema, with the fake Stripe. What must hold: the record before any
// Stripe call; every Stripe key from the record; a plan never pointing at an archived price; a subscription moved to a
// price at most once per change; every live member moved once or listed; the switch; Manage pricing on every write.
vi.setConfig({ testTimeout: 120_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal())
})

const JO = REPLAY_USER.email
const FRAN = 'front.desk@example.com'
const GONE = 'gone@example.com'
const MONTHLY = 'price_seed_monthly'
const YEARLY = 'price_seed_yearly'
const WINDOW_MS = 15 * 60_000
const PAT = '10000000-0000-4000-8000-0000000057a1'
const YAN = '10000000-0000-4000-8000-0000000057a2'
const IVY = '10000000-0000-4000-8000-0000000057a3'
const PAT_MEMBERSHIP = '10000000-0000-4000-8000-0000000057b1'
const YAN_MEMBERSHIP = '10000000-0000-4000-8000-0000000057b2'
const IVY_MEMBERSHIP = '10000000-0000-4000-8000-0000000057b3'
const UNKNOWN = '10000000-0000-4000-8000-0000000057ff'
const W = CATALOG_ADMIN_WORDS
const NEW = PLAN_NEW_WORDS
const NO_PRICING = STAFF_ADMIN_WORDS.pricingStaff.youDoNotHavePermissionManage
const pastTheWindow = () => vi.setSystemTime(Date.now() + WINDOW_MS + 60_000)
const refused = () => ({ kind: 'error' as const, error: fakeStripeErrors.invalid('parameter_invalid', 'Stripe refused this change.') })

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => {
  replayStripe.current = null
  vi.unstubAllEnvs()
  return environment.stop()
})

type Prepare = (seedDb: Db, stripe: FakeStripe) => Promise<void> | void

/**
 * The replay's seed with Core's Stripe product known to the fake, and three live members on Core: Mo (monthly, active),
 * Pat (monthly, failing) and Yan (yearly); Ivy's monthly membership has ended. Two more staff: Fran (no Manage pricing)
 * and an inactive one. Then `prepare`, then `work`, with `plan_changes` on.
 */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>, prepare?: Prepare, orderSwitch = 'plan_changes'): Promise<void> {
  await replay(
    environment,
    {
      name: 'w57 plans',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        stripe.addProduct('prod_seed')
        await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = 'sub_mo', next_renewal_date = '2026-12-10' WHERE id = $1", [ID.membership])
        stripe.addSubscription('sub_mo', 'cus_member', MONTHLY)
        for (const [id, name, email, cus] of [[PAT, 'Pat', 'pat@example.com', 'cus_pat'], [YAN, 'Yan', 'yan@example.com', 'cus_yan'], [IVY, 'Ivy', 'ivy@example.com', 'cus_ivy']] as const) {
          stripe.addCustomer(cus)
          await insert(seedDb, 'customers', { id, first_name: name, last_name: 'Member', email, date_of_birth: '1980-02-02', stripe_customer_id: cus })
        }
        await insert(seedDb, 'customer_memberships', { id: PAT_MEMBERSHIP, customer_id: PAT, plan_id: ID.plan, start_date: '2026-09-15', subscription_status: 'past_due', billing_frequency: 'monthly', stripe_subscription_id: 'sub_pat', next_renewal_date: '2026-11-15' })
        await insert(seedDb, 'customer_memberships', { id: YAN_MEMBERSHIP, customer_id: YAN, plan_id: ID.plan, start_date: '2026-06-01', subscription_status: 'active', billing_frequency: 'yearly', stripe_subscription_id: 'sub_yan', next_renewal_date: '2027-06-01', is_herd: true })
        await insert(seedDb, 'customer_memberships', { id: IVY_MEMBERSHIP, customer_id: IVY, plan_id: ID.plan, start_date: '2025-06-01', subscription_status: 'cancelled', billing_frequency: 'monthly', stripe_subscription_id: 'sub_ivy', next_renewal_date: '2026-06-01' })
        stripe.addSubscription('sub_pat', 'cus_pat', MONTHLY)
        stripe.addSubscription('sub_yan', 'cus_yan', YEARLY)
        stripe.addSubscription('sub_ivy', 'cus_ivy', MONTHLY)
        await stripe.subscriptions.cancel('sub_ivy')
        stripe.calls.length = 0
        await insert(seedDb, 'staff', { first_name: 'Fran', last_name: 'Desk', email: FRAN, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        await insert(seedDb, 'staff', { first_name: 'Gone', last_name: 'Away', email: GONE, role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: false })
        await prepare?.(seedDb, stripe)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        vi.stubEnv('ORDER_SWITCH', orderSwitch)
        try {
          await work(stripe)
        } finally {
          replayStripe.current = null
          vi.unstubAllEnvs()
          process.env.STAFF_API_KEY = ADMIN_TEST_KEY
        }
      },
    },
    workerSide()
  )
}

const press = async <T = Record<string, unknown>>(handler: AdminRouteHandler, params: Record<string, string>, body: unknown = {}, email: string = JO, key?: string): Promise<AdminAnswer<T>> => {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  return pressRoute<T>(handler, 'POST', { email, params, body, ...(key ? { key } : {}) })
}
const read = <T = unknown>(handler: AdminRouteHandler, email: string = JO, params: Record<string, string> = {}): Promise<AdminAnswer<T>> => pressRoute<T>(handler, 'GET', { email, params })

type PlanListRow = Record<string, unknown> & { id: string; stamp: string; members_monthly: number; members_yearly: number; setup: string; price_change_open: boolean }
const planRows = async (): Promise<PlanListRow[]> => (await read<PlanListRow[]>(plansRoute)).data ?? []
const corePlan = async (): Promise<PlanListRow> => (await planRows()).find((row) => row.id === ID.plan) as PlanListRow
const coreDetails = { level: 'core', isUnlimited: false, sessionsIncluded: 4, addonsIncluded: 0, priceMonthly: 40, priceYearly: 400 }
/** A details press as the dialog makes it: the row's stamp from the list just before. */
const saveCore = async (body: Record<string, unknown>, email = JO, key?: string) => press(detailsRoute, { planId: ID.plan }, { stamp: (await corePlan()).stamp, ...coreDetails, ...body }, email, key)

type Row = Record<string, unknown>
const one = async <T = Row>(sql: string, params: unknown[] = []): Promise<T> => (await db.query<T>(sql, params as never[]))[0] as T
const plan = (id: string = ID.plan) => one<{ price_monthly: string | null; price_yearly: string | null; stripe_price_id: string | null; stripe_price_id_yearly: string | null; stripe_product_id: string | null; active: boolean; name: string }>(
  'SELECT price_monthly::text AS price_monthly, price_yearly::text AS price_yearly, stripe_price_id, stripe_price_id_yearly, stripe_product_id, active, name FROM membership_plans WHERE id = $1',
  [id]
)
const audited = (action: string) => db.query<{ action: string; actor_id: string | null; entity_id: string; details: Row }>('SELECT action, actor_id, entity_id, details FROM audit_log WHERE action = $1 ORDER BY at, id', [action])
/** A change's rows in the order they can only have been written (rows of one press share the replay's frozen time). */
const STATE_ORDER = ['started', 'held', 'done', 'failed']
const changeStates = async () => (await audited(PLAN_CHANGE_ACTION)).map((row) => String(row.details['state'])).sort((a, b) => STATE_ORDER.indexOf(a) - STATE_ORDER.indexOf(b))
const priceSteps = async () => (await audited(STEP_LEFT_ACTION)).filter((row) => row.details['kind'] === 'price')
const moves = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.update').map((call) => call.params as { id: string; items?: Array<{ id: string; price: string }>; proration_behavior?: string })
const madePrices = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'prices.create')
const priceOf = (stripe: FakeStripe, subscriptionId: string) => stripe.subscriptions.retrieve(subscriptionId).then((sub) => sub.items.data[0]?.price.id)
const reconcileNow = (stripe: FakeStripe, requestId: string = crypto.randomUUID()) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId, maxItems: 50, budgetMs: 60_000 })
const by = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'test' }

/**
 * G-plan 4.9 item 5, on every scenario that changes a price:
 *  1. a plan never points at an archived price (each price id on a plan is an active price in Stripe);
 *  2. a subscription is moved to a price at most once per change (one update naming that price, at most);
 *  3. every live member on a changed price is on the new price in Stripe, or has an open price step (listed).
 */
async function invariants(stripe: FakeStripe): Promise<void> {
  const plans = await db.query<{ id: string; stripe_price_id: string | null; stripe_price_id_yearly: string | null }>('SELECT id, stripe_price_id, stripe_price_id_yearly FROM membership_plans')
  for (const row of plans) {
    for (const priceId of [row.stripe_price_id, row.stripe_price_id_yearly]) {
      if (priceId) expect(stripe.price(priceId)?.['active'], `plan ${row.id} on ${priceId}`).toBe(true)
    }
  }
  // A move that took effect is a step closed `done` with `sent` (a refused or unanswered send closes nothing).
  const stepRows = await priceSteps()
  const changeOfStep = new Map(stepRows.filter((row) => row.details['state'] === 'left').map((row) => [String(row.details['stepId']), `${String(row.details['subscriptionId'])}:${String(row.details['changeId'])}`]))
  const counted = new Map<string, number>()
  for (const row of stepRows.filter((one) => one.details['state'] === 'done' && one.details['sent'] === true)) {
    const key = changeOfStep.get(String(row.details['stepId'])) ?? 'unknown'
    counted.set(key, (counted.get(key) ?? 0) + 1)
  }
  for (const [key, count] of counted) expect(count, key).toBe(1)
  const done = (await audited(PLAN_CHANGE_ACTION)).filter((row) => row.details['state'] === 'done')
  const open = (await stuckList(db)).steps.filter((step) => step.step === 'price')
  for (const change of done) {
    const priceIds = (change.details['priceIds'] ?? {}) as Record<string, string>
    const live = await db.query<{ id: string; stripe_subscription_id: string; frequency: string }>(
      "SELECT id, stripe_subscription_id, COALESCE(billing_frequency, 'monthly') AS frequency FROM customer_memberships WHERE plan_id::text = $1 AND subscription_status IN ('active', 'past_due') AND stripe_subscription_id IS NOT NULL",
      [change.entity_id]
    )
    for (const member of live) {
      const wanted = priceIds[member.frequency]
      if (!wanted) continue
      const on = await priceOf(stripe, member.stripe_subscription_id)
      // A newer change replaces an older one's wish: only the newest change on the plan is held to Stripe here.
      const newest = done.filter((row) => row.entity_id === change.entity_id).at(-1) === change
      const listed = open.some((step) => step.subscriptionId === member.stripe_subscription_id)
      if (newest) expect(on === wanted || listed, `${member.stripe_subscription_id} on ${String(on)}, wanted ${wanted}`).toBe(true)
    }
  }
}

describe('reads (GB14; G-plan 4.8)', () => {
  it('the list: the old columns by name, with the stamp, the live members on each price, the set-up state and whether a change is open; an inactive or unknown sign-in is refused', async () => {
    await onASeed(async () => {
      const answer = await read<PlanListRow[]>(plansRoute)
      expect(answer.ok).toBe(true)
      const rows = catalogPlansRouteOutputSchema.parse(answer.data)
      const core = rows.find((row) => row.id === ID.plan)
      expect(core).toMatchObject({ name: 'Core', price_monthly: '40.00', price_yearly: '400.00', stripe_product_id: 'prod_seed', stripe_price_id: MONTHLY, members_monthly: 2, members_yearly: 1, setup: 'ready', price_change_open: false })
      expect(Object.keys(core ?? {}).sort()).toEqual(
        ['id', 'sanity_plan_id', 'name', 'thumbnail_url', 'sessions_included', 'addons_included', 'stripe_product_id', 'stripe_price_id', 'active', 'created_at', 'updated_at', 'price_monthly', 'price_yearly', 'level', 'is_unlimited', 'stripe_price_id_yearly', 'stamp', 'members_monthly', 'members_yearly', 'setup', 'price_change_open'].sort()
      )
      expect(core?.stamp).toMatch(/^fields#[0-9a-f]{32}$/)
      expect((await read(plansRoute, GONE)).ok).toBe(false)
      expect((await read(plansRoute, 'nobody@example.com')).ok).toBe(false)
      expect((await read(settingsRoute, GONE)).ok).toBe(false)
    })
  })

  it('the customer channel (for the website, no route yet): plans on sale only, no Stripe ids, counts or stamp', async () => {
    await onASeed(async () => {
      await db.query("INSERT INTO membership_plans (name, level, sessions_included, price_monthly, active) VALUES ('Hidden', 'core', 2, '10.00', false)")
      const rows = await listPlans(db, { channel: 'customer' })
      expect(rows.map((row) => row['name'])).not.toContain('Hidden')
      for (const row of rows) for (const field of Object.keys(row)) expect(field).not.toMatch(/stripe|stamp|members_/)
    })
  })

  it('the settings: the waiting period, or the default (6) with no row, as before', async () => {
    await onASeed(async () => {
      expect((await read(settingsRoute)).data).toEqual({ addonCreditWaitMonths: 3 })
      await db.query('RESET ROLE')
      await db.query('DELETE FROM membership_settings')
      await db.query('SET ROLE paddock_worker')
      expect((await read(settingsRoute)).data).toEqual({ addonCreditWaitMonths: 6 })
    }, (seedDb) => seedDb.query('INSERT INTO membership_settings (id, addon_credit_wait_months) VALUES (true, 3)').then(() => undefined))
  })
})

describe('membership settings (GB19)', () => {
  const settings = (seedDb: Db) => seedDb.query('INSERT INTO membership_settings (id, addon_credit_wait_months) VALUES (true, 12)').then(() => undefined)
  async function readQuote(months: number | string, email = JO) {
    const request = new Request(`https://worker.test/api/v1/staff/membership-settings/quote?addonCreditWaitMonths=${months}`, { headers: { authorization: `Bearer ${ADMIN_TEST_KEY}`, 'x-staff-email': email } })
    const response = await quoteRoute(request, { params: Promise.resolve({}) })
    return (await response.json()) as { ok: boolean; data?: { herdFlagsToChange: number; becomeHerd: number; leaveHerd: number; message: string }; error?: { message: string } }
  }

  it('the quote counts who becomes or stops being a Herd member, as the refresh would, and changes nothing', async () => {
    await onASeed(async () => {
      // Mo (monthly since 10 January) is Herd at 6 months; at 12 she would not be. Pat (since 15 September) is not Herd
      // either way. Ivy's membership has ended, but the refresh sets every membership with no override, ended ones
      // too (refresh_herd_flags), so the count does as well: at 6 months she becomes Herd, at 12 not.
      await db.query('UPDATE customer_memberships SET is_herd = false WHERE id = $1', [ID.membership])
      const at6 = await readQuote(6)
      expect(at6.data).toMatchObject({ becomeHerd: 2, leaveHerd: 0, herdFlagsToChange: 2, message: herdChangeWords(6, 2, 0) })
      expect(at6.data?.message).toBe('With 6 months: 2 members become Herd members (add-on credits usable at once).')
      // At 12 months Mo stays out, and Ivy (since June 2025) is still in.
      const at12 = await readQuote(12)
      expect(at12.data).toMatchObject({ becomeHerd: 1, leaveHerd: 0, message: 'With 12 months: 1 member becomes a Herd member (add-on credits usable at once).' })
      // At 60, nobody (Yan pays yearly, so is Herd whatever the period).
      expect((await readQuote(60)).data?.message).toBe("With 60 months, no member's Herd status changes.")
      expect((await one<{ is_herd: boolean }>('SELECT is_herd FROM customer_memberships WHERE id = $1', [ID.membership])).is_herd).toBe(false)
      expect((await readQuote(61)).error?.message).toBe(W.setMembershipSettings.waitingPeriodMustWholeNumberMonths)
      // W57a (W57 review L11): an empty value is no value: refused in the old words, never read as 0 months.
      for (const empty of ['', '%20']) {
        const answer = await readQuote(empty)
        expect([answer.ok, answer.error?.message], JSON.stringify(empty)).toEqual([false, W.setMembershipSettings.waitingPeriodMustWholeNumberMonths])
      }
      expect((await readQuote(0)).ok).toBe(true)
    }, settings)
  })

  it('saved with the count shown: one transaction, the period and the refresh together, a row with both counts; refused when the count has changed or is missing', async () => {
    await onASeed(async () => {
      await db.query('UPDATE customer_memberships SET is_herd = false WHERE id = $1', [ID.membership])
      const missing = await press(setSettingsRoute, {}, { addonCreditWaitMonths: 6 })
      expect(missing.reason).toBe('count_missing')
      const stale = await press(setSettingsRoute, {}, { addonCreditWaitMonths: 6, herdFlagsToChange: 0 })
      expect([stale.reason, stale.error?.message]).toEqual(['changed_since', MEMBERSHIP_SETTINGS_NEW_WORDS.countChanged(0, 2)])
      expect((await one<{ m: number }>('SELECT addon_credit_wait_months AS m FROM membership_settings')).m).toBe(12)
      const saved = await press(setSettingsRoute, {}, { addonCreditWaitMonths: 6, herdFlagsToChange: 2 })
      expect(saved.data).toEqual({ addonCreditWaitMonths: 6, herdFlagsChanged: 2 })
      expect((await one<{ is_herd: boolean }>('SELECT is_herd FROM customer_memberships WHERE id = $1', [ID.membership])).is_herd).toBe(true)
      const rows = await audited('membership_settings.set')
      expect(rows.map((row) => [row.actor_id, row.details['before'], row.details['after'], row.details['herdFlagsShown'], row.details['herdFlagsChanged']])).toEqual([[ID.staff, { addon_credit_wait_months: 12 }, { addon_credit_wait_months: 6 }, 2, 2]])
      // Saved again with the count it now shows (0): saved, and nothing changes.
      expect((await press(setSettingsRoute, {}, { addonCreditWaitMonths: 6, herdFlagsToChange: 0 })).data).toEqual({ addonCreditWaitMonths: 6, herdFlagsChanged: 0 })
    }, settings)
  })

  it('GB19: the period and the Herd refresh are one transaction: a refresh that fails takes the period back with it, and nothing is recorded', async () => {
    await onASeed(async () => {
      await db.query('UPDATE customer_memberships SET is_herd = false WHERE id = $1', [ID.membership])
      await whileFailing(db, { table: 'customer_memberships', event: 'UPDATE', when: 'true' }, async () => {
        const answer = await press(setSettingsRoute, {}, { addonCreditWaitMonths: 6, herdFlagsToChange: 2 })
        expect(answer.ok).toBe(false)
      })
      expect((await one<{ m: number }>('SELECT addon_credit_wait_months AS m FROM membership_settings')).m).toBe(12)
      expect((await one<{ is_herd: boolean }>('SELECT is_herd FROM customer_memberships WHERE id = $1', [ID.membership])).is_herd).toBe(false)
      expect(await audited('membership_settings.set')).toEqual([])
    }, settings)
  })

  it('Manage pricing, the old check and the missing row, in the old words, before anything is written', async () => {
    await onASeed(async () => {
      expect((await press(setSettingsRoute, {}, { addonCreditWaitMonths: 6, herdFlagsToChange: 0 }, FRAN)).error?.message).toBe(NO_PRICING)
      for (const bad of [-1, 61, 1.5, '6']) expect((await press(setSettingsRoute, {}, { addonCreditWaitMonths: bad, herdFlagsToChange: 0 })).error?.message).toBe(W.setMembershipSettings.waitingPeriodMustWholeNumberMonths)
      expect((await press(setSettingsRoute, {}, { addonCreditWaitMonths: 6, herdFlagsToChange: 0 })).error?.message).toBe(W.setMembershipSettings.membershipSettingsRowMissingInsertIt)
      expect(await audited('membership_settings.set')).toEqual([])
    })
  })
})

describe("a plan's details, with no price change", () => {
  it('saved in one transaction with `plan.details_set`; no Stripe call; the stamp of the row the dialog opened on', async () => {
    await onASeed(async (stripe) => {
      const saved = await saveCore({ name: ' Core Plus ', level: 'all_access', sessionsIncluded: 6, addonsIncluded: 2 })
      expect(saved.ok).toBe(true)
      expect(saved.data).toMatchObject({ plan: { name: 'Core Plus', level: 'all_access', sessions_included: 6, addons_included: 2, price_monthly: '40.00' }, priceChange: null })
      expect(stripe.calls).toEqual([])
      expect((await audited('plan.details_set')).map((row) => [row.details['before'], row.details['after']])).toEqual([
        [{ name: 'Core', level: 'core', is_unlimited: false, sessions_included: 4, addons_included: 0 }, { name: 'Core Plus', level: 'all_access', is_unlimited: false, sessions_included: 6, addons_included: 2 }],
      ])
      expect(await changeStates()).toEqual([])
      // Unlimited: the sessions sent are saved as 0, as before.
      expect((await saveCore({ isUnlimited: true, sessionsIncluded: 9 })).data).toMatchObject({ plan: { is_unlimited: true, sessions_included: 0 } })
    })
  })

  it('W54a: a press from a page loaded before someone else changed the plan is refused `changed_since`, and nothing is written', async () => {
    await onASeed(async () => {
      const stamp = (await corePlan()).stamp
      expect((await saveCore({ name: 'First' })).ok).toBe(true)
      const stale = await press(detailsRoute, { planId: ID.plan }, { ...coreDetails, name: 'Second', stamp })
      expect([stale.reason, stale.error?.message]).toEqual(['changed_since', CHANGED_SINCE_WORDS])
      expect((await plan()).name).toBe('First')
      // An on or off sale press doesn't move the stamp: it sends back none of the dialog's columns.
      const before = (await corePlan()).stamp
      expect((await press(activeRoute, { planId: ID.plan }, { active: false })).ok).toBe(true)
      expect((await corePlan()).stamp).toBe(before)
    })
  })

  it('every refusal in the old words, in the old order, before anything is written', async () => {
    await onASeed(async () => {
      const D = W.setMembershipPlanDetails
      for (const [body, words] of [
        [{ name: '  ' }, D.nameRequired],
        [{ level: 'gold' }, D.levelMustEitherCoreOrAll],
        [{ sessionsIncluded: -2 }, D.sessionsIncludedMustNonNegativeWhole],
        [{ sessionsIncluded: 0 }, D.sessionsIncludedMustPositiveWholeNumber],
        [{ addonsIncluded: 1.5 }, D.addOnsIncludedMustNonNegative],
        [{ isUnlimited: 'yes', sessionsIncluded: 4 }, NEW.isUnlimitedTrueOrFalse],
        [{ priceMonthly: -1 }, D.monthlyPriceMustNonNegativeNumber],
        [{ priceYearly: null }, D.yearlyPriceMustNonNegativeNumber],
        [{ priceMonthly: 39.995 }, 'priceMonthly must be pounds and pence: no more than two decimal places, and less than £100,000,000.'],
      ] as const) {
        expect((await saveCore(body)).error?.message, JSON.stringify(body)).toBe(words)
      }
      expect((await press(detailsRoute, { planId: UNKNOWN }, { ...coreDetails, stamp: 'x' })).error?.message).toBe(D.membershipPlanNotFound)
      expect((await saveCore({ name: 'Nope' }, FRAN)).error?.message).toBe(NO_PRICING)
      expect((await saveCore({ name: 'Nope' }, GONE)).ok).toBe(false)
      expect(await audited('plan.details_set')).toEqual([])
    })
  })
})

describe("a plan's price (G-plan 4.4; GB1, GB2; Q53)", () => {
  it("Core's monthly price from £40 to £45: the record first, one new Stripe price under the record's key, the price and its id together, Mo and Pat moved once each with no proration, Yan (yearly) untouched; the old price archived by reconcile past its window (W57a)", async () => {
    await onASeed(async (stripe) => {
      const before = await corePlan()
      expect([before.members_monthly, before.members_yearly]).toEqual([2, 1])
      const saved = await saveCore({ priceMonthly: 45, membersToMove: 2 })
      expect(saved.ok).toBe(true)
      const change = (await audited(PLAN_CHANGE_ACTION))[0]?.details as Row
      const changeId = String(change['changeId'])
      // The record: written by D1, before any Stripe call (its key, the count staff confirmed, old and new).
      expect(change).toMatchObject({ state: 'started', planId: ID.plan, productId: 'prod_seed', membersToMove: 2, prices: { monthly: { from: '40.00', to: '45.00', oldPriceId: MONTHLY } } })
      expect(await changeStates()).toEqual(['started', 'done'])
      // S1: one price, its key and metadata from the record.
      expect(madePrices(stripe)).toHaveLength(1)
      const made = madePrices(stripe)[0]
      expect(made?.idempotencyKey).toBe(`${changeId}:monthly`)
      expect(made?.params).toMatchObject({ product: 'prod_seed', unit_amount: 4500, currency: 'gbp', recurring: { interval: 'month' }, metadata: { change_id: changeId, plan_id: ID.plan, frequency: 'monthly' } })
      // D2: the price and its id together.
      const newPrice = String((await plan()).stripe_price_id)
      expect(await plan()).toMatchObject({ price_monthly: '45.00', price_yearly: '400.00', stripe_price_id_yearly: YEARLY })
      expect(newPrice).not.toBe(MONTHLY)
      // W57a (W57 review S2): the old price is not archived by the press (an order that read it may still be on its way).
      expect(stripe.price(MONTHLY)?.['active']).toBe(true)
      const sendsOf = () => stripe.calls.map((call) => call.method).filter((method) => method === 'prices.create' || method === 'prices.update' || method === 'subscriptions.update')
      expect(sendsOf()).toEqual(['prices.create', 'subscriptions.update', 'subscriptions.update'])
      // The moves: Mo and Pat, once each, the one item, no proration; Yan pays yearly and is not touched.
      expect(moves(stripe).map((params) => [params.id, params.items, params.proration_behavior]).sort()).toEqual([
        ['sub_mo', [{ id: 'si_sub_mo', price: newPrice }], 'none'],
        ['sub_pat', [{ id: 'si_sub_pat', price: newPrice }], 'none'],
      ])
      expect(await priceOf(stripe, 'sub_yan')).toBe(YEARLY)
      expect(await priceOf(stripe, 'sub_ivy')).toBe(MONTHLY)
      // Each member's move is a recorded step (closed done) and a `membership.price_moved` row.
      expect((await audited(PRICE_MOVED_ACTION)).map((row) => [row.entity_id, row.details['fromPriceId'], row.details['toPriceId'], row.details['changeId']]).sort()).toEqual(
        [[ID.membership, MONTHLY, newPrice, changeId], [PAT_MEMBERSHIP, MONTHLY, newPrice, changeId]].sort()
      )
      expect((await priceSteps()).map((row) => row.details['state']).sort()).toEqual(['done', 'done', 'left', 'left'])
      // What staff are told (Q53).
      expect(saved.data).toMatchObject({ priceChange: { state: 'done', membersToMove: 2, moved: 2, toMove: 0 } })
      expect((saved.data as { priceChange: { message: string } }).priceChange.message).toBe(`${planMoveWords({ monthly: { members: 2, price: 45 } })} ${NEW.priceChanged(2, 0)}`)
      expect((saved.data as { priceChange: { message: string } }).priceChange.message).toContain('2 members on this plan will pay £45.00 a month from their next renewal. Price changed. 2 moved, 0 still to move.')
      expect((await stuckList(db)).steps).toEqual([])
      // Waiting inside its window, the archive step isn't listed.
      expect((await stuckList(db)).plans).toEqual([])
      await invariants(stripe)
      // S2: past its window, with no pending order naming it, reconcile archives the old price (read first, once).
      pastTheWindow()
      await reconcileNow(stripe)
      expect(stripe.price(MONTHLY)?.['active']).toBe(false)
      expect(sendsOf()).toEqual(['prices.create', 'subscriptions.update', 'subscriptions.update', 'prices.update'])
      expect((await stuckList(db)).plans).toEqual([])
      await invariants(stripe)
    })
  })

  it('the record first: when Stripe is asked to make the new price, the change is already recorded (committed), with the key Stripe is sent', async () => {
    await onASeed(async (stripe) => {
      const seen: Array<{ states: unknown[]; key: unknown }> = []
      const real = stripe.prices.create.bind(stripe.prices)
      stripe.prices.create = (async (params: never, options?: { idempotencyKey?: string }) => {
        // Read on another statement of the same database, outside the press's transaction: what is committed.
        seen.push({ states: (await audited(PLAN_CHANGE_ACTION)).map((row) => [row.details['state'], `${String(row.details['changeId'])}:monthly`]), key: options?.idempotencyKey })
        return real(params, options as never)
      }) as typeof stripe.prices.create
      expect((await saveCore({ priceMonthly: 45, membersToMove: 2 })).ok).toBe(true)
      expect(seen).toHaveLength(1)
      expect(seen[0]?.states).toEqual([['started', seen[0]?.key]])
    })
  })

  it('Q53: the count is required, and must still be right; nothing is written or sent otherwise', async () => {
    await onASeed(async (stripe) => {
      const missing = await saveCore({ priceMonthly: 45 })
      expect([missing.reason, missing.error?.message]).toEqual(['count_missing', NEW.confirmCountMissing])
      const wrong = await saveCore({ priceMonthly: 45, membersToMove: 3 })
      expect([wrong.reason, wrong.error?.message]).toEqual(['changed_since', NEW.countChanged(3, 2)])
      expect(await changeStates()).toEqual([])
      expect(stripe.calls).toEqual([])
      expect((await plan()).price_monthly).toBe('40.00')
      // Both prices: the count is both frequencies' members.
      expect((await saveCore({ priceMonthly: 45, priceYearly: 450, membersToMove: 2 })).reason).toBe('changed_since')
      expect((await saveCore({ priceMonthly: 45, priceYearly: 450, membersToMove: 3 })).ok).toBe(true)
      await invariants(stripe)
    })
  })

  it('W58 item 0: an off-sale plan with members on the changing price: refused before anything is made (Stripe would refuse every move); with nobody on it, allowed', async () => {
    await onASeed(async (stripe) => {
      await db.query('UPDATE membership_plans SET active = false WHERE id = $1', [ID.plan])
      const before = await plan()
      const refused = await saveCore({ priceMonthly: 45, membersToMove: 2, name: 'Core renamed' })
      expect([refused.status, refused.reason, refused.error?.message]).toEqual([409, 'off_sale_with_members', NEW.offSaleWithMembers(2)])
      expect(await plan()).toEqual(before)
      expect(await changeStates()).toEqual([])
      expect(await audited('plan.details_set')).toEqual([])
      expect(stripe.calls).toEqual([])
      // The price-only press too.
      expect((await press(detailsRoute, { planId: ID.plan }, { monthlyPrice: 45, membersToMove: 2 })).reason).toBe('off_sale_with_members')
      // Only the yearly price changes and Yan is the one yearly member: still refused, naming him.
      expect((await saveCore({ priceYearly: 450, membersToMove: 1 })).error?.message).toBe(NEW.offSaleWithMembers(1))
      // Nobody on the plan: the change goes ahead (new members pay it once it is back on sale).
      await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE plan_id = $1", [ID.plan])
      expect((await saveCore({ priceMonthly: 45, membersToMove: 0 })).ok).toBe(true)
      expect((await plan()).price_monthly).toBe('45.00')
    })
  })

  it('updateCatalogItemPrice for a plan (a price-only press): its old checks and words, the count required, then the same change', async () => {
    await onASeed(async (stripe) => {
      const P = W.updateCatalogItemPrice
      expect((await press(detailsRoute, { planId: ID.plan }, {})).error?.message).toBe(P.atLeastOnePriceFieldMust)
      expect((await press(detailsRoute, { planId: ID.plan }, { monthlyPrice: -5 })).error?.message).toBe(P.mustNonNegativeNumber('monthlyPrice'))
      expect((await press(detailsRoute, { planId: ID.plan }, { yearlyPrice: null })).error?.message).toBe(P.mustNonNegativeNumber('yearlyPrice'))
      expect((await press(detailsRoute, { planId: UNKNOWN }, { monthlyPrice: 45 })).error?.message).toBe(CATALOG_ADMIN_WORDS.updateCatalogItemPrice.itemNotFound)
      expect((await press(detailsRoute, { planId: ID.plan }, { monthlyPrice: 45 })).reason).toBe('count_missing')
      const saved = await press(detailsRoute, { planId: ID.plan }, { monthlyPrice: 45, membersToMove: 2 })
      expect(saved.data).toMatchObject({ pricesUpdated: { price_monthly: 45 }, priceChange: { state: 'done', moved: 2, toMove: 0 } })
      expect(await audited('plan.details_set')).toEqual([])
      await invariants(stripe)
    })
  })

  it('GB2: Stripe refuses the new price: the record failed, the plan keeps its price and its (active) Stripe price, nobody is moved; the details the press carried are saved', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('prices.create', refused())
      const answer = await saveCore({ name: 'Core Plus', priceMonthly: 45, membersToMove: 2 })
      expect([answer.reason, answer.error?.message]).toEqual(['stripe_refused', NEW.priceRefused('Stripe refused this change.')])
      expect(await plan()).toMatchObject({ price_monthly: '40.00', stripe_price_id: MONTHLY, name: 'Core Plus' })
      expect(stripe.price(MONTHLY)?.['active']).toBe(true)
      expect(await changeStates()).toEqual(['started', 'failed'])
      expect(moves(stripe)).toEqual([])
      await invariants(stripe)
    })
  })

  it('no clear answer from Stripe, and Stripe made it after all: held; reconcile past the window finds it by the record\'s id and finishes (one price per change), then moves everyone', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('prices.create', { kind: 'lost_response' })
      const answer = await saveCore({ priceMonthly: 45, membersToMove: 2 })
      expect(answer.data).toMatchObject({ priceChange: { state: 'held', message: NEW.priceHeld } })
      expect(await changeStates()).toEqual(['started', 'held'])
      expect((await plan()).stripe_price_id).toBe(MONTHLY)
      // Listed while held, and another change is refused.
      expect((await stuckList(db)).plans?.map((line) => [line.what, line.words])).toEqual([['price_change', PLAN_STUCK_WORDS.priceHeld('Core')]])
      expect((await corePlan()).price_change_open).toBe(true)
      expect((await saveCore({ priceMonthly: 50, membersToMove: 2 })).reason).toBe('price_change_open')
      // Inside the window, reconcile leaves it to the press.
      await reconcileNow(stripe)
      expect(await changeStates()).toEqual(['started', 'held'])
      pastTheWindow()
      await reconcileNow(stripe)
      expect(await changeStates()).toEqual(['started', 'held', 'done'])
      expect(madePrices(stripe)).toHaveLength(1)
      const newPrice = String((await plan()).stripe_price_id)
      expect(newPrice).not.toBe(MONTHLY)
      expect(await priceOf(stripe, 'sub_mo')).toBe(newPrice)
      expect(await priceOf(stripe, 'sub_pat')).toBe(newPrice)
      // W57a (S2): the old price is archived by a later run, past its archive step's own window.
      expect(stripe.price(MONTHLY)?.['active']).toBe(true)
      expect((await stuckList(db)).plans).toEqual([])
      pastTheWindow()
      await reconcileNow(stripe)
      expect(stripe.price(MONTHLY)?.['active']).toBe(false)
      expect((await stuckList(db)).plans).toEqual([])
      await invariants(stripe)
    })
  })

  it('no clear answer, and Stripe never made it: reconcile past the window finds nothing and fails the change (never makes a price itself); the plan keeps its price', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('prices.create', { kind: 'unreachable' })
      expect((await saveCore({ priceMonthly: 45, membersToMove: 2 })).data).toMatchObject({ priceChange: { state: 'held' } })
      pastTheWindow()
      await reconcileNow(stripe)
      expect(await changeStates()).toEqual(['started', 'held', 'failed'])
      expect(madePrices(stripe)).toHaveLength(1)
      expect(await plan()).toMatchObject({ price_monthly: '40.00', stripe_price_id: MONTHLY })
      expect(moves(stripe)).toEqual([])
      // A new change can be made now.
      expect((await saveCore({ priceMonthly: 45, membersToMove: 2 })).data).toMatchObject({ priceChange: { state: 'done' } })
      await invariants(stripe)
    })
  })

  it("a member's move refused for good: listed for a person with Mark sorted; the others moved; refused again by reconcile, never sent after that", async () => {
    await onASeed(async (stripe) => {
      // The first update is Mo's (id order: the seed's membership comes first) or Pat's: whichever, one is refused.
      stripe.failNext('subscriptions.update', refused())
      const answer = await saveCore({ priceMonthly: 45, membersToMove: 2 })
      expect(answer.data).toMatchObject({ priceChange: { state: 'done', moved: 1, toMove: 1 } })
      expect((answer.data as { priceChange: { message: string } }).priceChange.message).toContain('1 moved, 1 still to move.')
      pastTheWindow()
      stripe.failNext('subscriptions.update', refused())
      await reconcileNow(stripe)
      const listed = (await stuckList(db)).steps.filter((step) => step.step === 'price')
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ what: 'plan_price', state: 'refused', close: { kind: 'left_step' } })
      expect(listed[0]?.words).toBe(LEFT_STEP_WORDS.price.refused(listed[0]?.subscriptionId ?? ''))
      const sends = moves(stripe).length
      pastTheWindow()
      await reconcileNow(stripe)
      expect(moves(stripe)).toHaveLength(sends)
      await invariants(stripe)
      // A person moves it by hand in Stripe, then Mark sorted.
      const sorted = await sortLeftStep(db, listed[0]?.stepId ?? '', 'moved by hand in Stripe', by)
      expect(sorted.closed).toBe(true)
      expect((await stuckList(db)).steps).toEqual([])
    })
  })

  it("W58b items 2 and 3: moves refused for good; the plan taken off sale says to put it back on sale first; the member whose membership then ends has the move closed by the next run (done, nothing sent, Stripe not asked)", async () => {
    await onASeed(async (stripe) => {
      const priceLines = async () => (await stuckList(db)).steps.filter((step) => step.step === 'price')
      for (let i = 0; i < 2; i += 1) stripe.failNext('subscriptions.update', refused())
      expect((await saveCore({ priceMonthly: 45, membersToMove: 2 })).data).toMatchObject({ priceChange: { state: 'done', moved: 0, toMove: 2 } })
      pastTheWindow()
      for (let i = 0; i < 2; i += 1) stripe.failNext('subscriptions.update', refused())
      await reconcileNow(stripe)
      expect((await priceLines()).map((line) => [line.subscriptionId, line.state, line.words]).sort()).toEqual([
        ['sub_mo', 'refused', LEFT_STEP_WORDS.price.refused('sub_mo')],
        ['sub_pat', 'refused', LEFT_STEP_WORDS.price.refused('sub_pat')],
      ])
      // Item 3: the plan is taken off sale. A move by hand would be refused too, so the line says what to do first.
      await db.query('UPDATE membership_plans SET active = false WHERE id = $1', [ID.plan])
      expect((await priceLines()).map((line) => line.words).sort()).toEqual([LEFT_STEP_WORDS.price.refusedOffSale('sub_mo'), LEFT_STEP_WORDS.price.refusedOffSale('sub_pat')])
      expect(LEFT_STEP_WORDS.price.refusedOffSale('sub_mo')).toContain('Put the plan back on sale first, then move the subscription')
      // Item 2: Pat's membership ends here. The next run closes Pat's move itself, as a left move is closed; nothing is
      // sent and Stripe isn't asked about Pat at all.
      const patStep = (await priceLines()).find((line) => line.subscriptionId === 'sub_pat')?.stepId ?? ''
      await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1", [PAT_MEMBERSHIP])
      const before = stripe.calls.length
      pastTheWindow()
      const run = await reconcileNow(stripe)
      expect(stripe.calls.slice(before).filter((call) => JSON.stringify(call.params ?? null).includes('sub_pat'))).toEqual([])
      expect(run.items.filter((item) => item.id === patStep).map((item) => [item.kind, item.outcome])).toEqual([['step', 'finalised']])
      expect((await priceLines()).map((line) => line.subscriptionId)).toEqual(['sub_mo'])
      const patEnds = (await priceSteps()).filter((row) => row.details['stepId'] === patStep && row.details['state'] === 'done')
      expect(patEnds.map((row) => [row.details['sent'], row.details['detail']])).toEqual([[false, ENDED_HERE_REFUSED_DETAIL]])
      // A second run finds nothing more to close.
      pastTheWindow()
      expect((await reconcileNow(stripe)).items.filter((item) => item.id === patStep)).toEqual([])
      // Back on sale: Mo's line in the plain refused words again.
      await db.query('UPDATE membership_plans SET active = true WHERE id = $1', [ID.plan])
      expect((await priceLines()).map((line) => line.words)).toEqual([LEFT_STEP_WORDS.price.refused('sub_mo')])
    })
  })

  it('W58b item 2: the 20-minute check that finds a refused move as the newest wish, with the membership ended, closes it too (nothing read or sent), and the later check covers both', async () => {
    await onASeed(async (stripe) => {
      // Mo and Pat moved to £45; Mo's membership ends; Pat's move to £50 is refused for good.
      await saveCore({ priceMonthly: 45, membersToMove: 2 })
      await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1", [ID.membership])
      stripe.failNext('subscriptions.update', refused())
      expect((await saveCore({ priceMonthly: 50, membersToMove: 1 })).data).toMatchObject({ priceChange: { state: 'done', moved: 0, toMove: 1 } })
      pastTheWindow()
      stripe.failNext('subscriptions.update', refused())
      await reconcileNow(stripe)
      const refusedStep = (await stuckList(db)).steps.find((step) => step.subscriptionId === 'sub_pat')?.stepId ?? ''
      expect(refusedStep).not.toBe('')
      // Pat's membership ends; Pat's first (done) move is due its check, and the refused one is the newest wish.
      await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1", [PAT_MEMBERSHIP])
      vi.setSystemTime(Date.now() + 30 * 60_000)
      const due = (await checksDue(db)).find((one) => one.subscriptionId === 'sub_pat' && one.kind === 'price')
      expect(due).toBeDefined()
      const before = stripe.calls.length
      const checked = await checkAfterClosing(db, stripe, due as CheckDue, by, undefined)
      expect(checked.kind).toBe('wait')
      expect(stripe.calls.slice(before)).toEqual([])
      const ends = (await priceSteps()).filter((row) => row.details['stepId'] === refusedStep && row.details['state'] === 'done')
      expect(ends.map((row) => [row.details['sent'], row.details['detail']])).toEqual([[false, ENDED_HERE_REFUSED_DETAIL]])
      expect((await stuckList(db)).steps.filter((step) => step.subscriptionId === 'sub_pat')).toEqual([])
      // Past the new closing's own window, one check covers both closings: the membership has ended, so nothing is read.
      vi.setSystemTime(Date.now() + 30 * 60_000)
      await reconcileNow(stripe)
      expect(stripe.calls.slice(before).filter((call) => JSON.stringify(call.params ?? null).includes('sub_pat'))).toEqual([])
      expect(await checksDue(db).then((list) => list.filter((one) => one.subscriptionId === 'sub_pat'))).toEqual([])
    })
  })

  it("a member's move with no clear answer: left, and reconcile sends it again past the window (one move per subscription per change)", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', { kind: 'unreachable' })
      expect((await saveCore({ priceMonthly: 45, membersToMove: 2 })).data).toMatchObject({ priceChange: { moved: 1, toMove: 1 } })
      pastTheWindow()
      await reconcileNow(stripe)
      const newPrice = String((await plan()).stripe_price_id)
      expect([await priceOf(stripe, 'sub_mo'), await priceOf(stripe, 'sub_pat')]).toEqual([newPrice, newPrice])
      await invariants(stripe)
    })
  })

  it('a subscription that ends before its step is sent: the step closes with no Stripe call', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
      await saveCore({ priceMonthly: 45, membersToMove: 2 })
      const leftOpen = (await stuckList(db)).steps.filter((step) => step.step === 'price')
      expect(leftOpen).toHaveLength(1)
      await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE stripe_subscription_id = $1", [leftOpen[0]?.subscriptionId])
      const callsBefore = stripe.calls.length
      pastTheWindow()
      await reconcileNow(stripe)
      expect(stripe.calls.slice(callsBefore).filter((call) => (call.params as { id?: string }).id === leftOpen[0]?.subscriptionId)).toEqual([])
      expect((await stuckList(db)).steps).toEqual([])
    })
  })

  it('a second price change while one is still open (its record held, or its moves still being sent by its press) is refused in words', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', { kind: 'unreachable' })
      await saveCore({ priceMonthly: 45, membersToMove: 2 })
      // The change is done, but one move is still inside its press's window.
      const second = await saveCore({ priceMonthly: 50, membersToMove: 2 })
      expect([second.reason, second.error?.message]).toEqual(['price_change_open', NEW.changeStillOpen])
      pastTheWindow()
      expect((await saveCore({ priceMonthly: 50, membersToMove: 2 })).ok).toBe(true)
      await reconcileNow(stripe)
      await invariants(stripe)
    })
  })

  it('a plan never set up in Stripe: the product is made first under the record\'s key, then the prices, all written in D2', async () => {
    const OFF_PEAK = '10000000-0000-4000-8000-0000000057c1'
    await onASeed(
      async (stripe) => {
        const rows = await planRows()
        expect(rows.find((row) => row.id === OFF_PEAK)?.setup).toBe('not_set_up')
        const stamp = rows.find((row) => row.id === OFF_PEAK)?.stamp
        const saved = await press(detailsRoute, { planId: OFF_PEAK }, { level: 'core', isUnlimited: false, sessionsIncluded: 2, addonsIncluded: 0, priceMonthly: 30, priceYearly: 300, membersToMove: 0, stamp })
        expect(saved.ok).toBe(true)
        const changeId = String((await audited(PLAN_CHANGE_ACTION))[0]?.details['changeId'])
        expect(stripe.calls.filter((call) => call.method === 'products.create').map((call) => call.idempotencyKey)).toEqual([`${changeId}:product`])
        expect(await plan(OFF_PEAK)).toMatchObject({ price_monthly: '30.00', price_yearly: '300.00', active: false })
        expect((await plan(OFF_PEAK)).stripe_product_id).toMatch(/^prod_fake_/)
        await invariants(stripe)
      },
      (seedDb) => seedDb.query("INSERT INTO membership_plans (id, name, level, sessions_included, price_monthly, price_yearly, active) VALUES ($1, 'Off Peak', 'core', 2, '28.00', '280.00', false)", [OFF_PEAK]).then(() => undefined)
    )
  })
})

describe('a crash at each step (G-plan 4.9 item 6), then reconcile: one Stripe price per change, every member moved once or listed', () => {
  /** D1's record, written as D1 writes it, with nothing after it: the press died there. */
  async function startedOnly(): Promise<PriceChange> {
    const change: PriceChange = { changeId: crypto.randomUUID(), planId: ID.plan, productId: 'prod_seed', productName: 'Core', productActive: true, prices: { monthly: { from: '40.00', to: '45.00', oldPriceId: MONTHLY } }, membersToMove: 2 }
    await db.transaction((tx) => audit.recordAll(tx, [changeStartedEntry(by, change, 'key-1')]))
    return change
  }

  it('after D1: nothing made in Stripe, so the change fails; the plan keeps its price', async () => {
    await onASeed(async (stripe) => {
      await startedOnly()
      pastTheWindow()
      await reconcileNow(stripe)
      expect(await changeStates()).toEqual(['started', 'failed'])
      expect(madePrices(stripe)).toEqual([])
      expect((await plan()).stripe_price_id).toBe(MONTHLY)
      await invariants(stripe)
    })
  })

  it('after the new price (before D2): reconcile finds it and finishes, with no second price', async () => {
    await onASeed(async (stripe) => {
      const change = await startedOnly()
      const made = await makeChangePrices(stripe, change, undefined)
      expect(made.kind).toBe('made')
      pastTheWindow()
      await reconcileNow(stripe)
      expect(madePrices(stripe)).toHaveLength(1)
      expect(await changeStates()).toEqual(['started', 'done'])
      await invariants(stripe)
    })
  })

  it('D2 itself fails (the write fails): the change stays started with its price made; reconcile finishes it', async () => {
    await onASeed(async (stripe) => {
      // Only D2's write fails (the one that names a new Stripe price): D1's write of the details goes through.
      await whileFailing(db, { table: 'membership_plans', event: 'UPDATE', when: 'NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id' }, async () => {
        const answer = await saveCore({ priceMonthly: 45, membersToMove: 2 })
        expect(answer.ok).toBe(false)
      })
      expect(await changeStates()).toEqual(['started'])
      // GB2: the price and its id are one write, so neither moved; and the old price is still live (archived only after D2).
      expect(await plan()).toMatchObject({ stripe_price_id: MONTHLY, price_monthly: '40.00' })
      await invariants(stripe)
      pastTheWindow()
      await reconcileNow(stripe)
      expect(madePrices(stripe)).toHaveLength(1)
      expect(await changeStates()).toEqual(['started', 'done'])
      expect(await priceOf(stripe, 'sub_mo')).toBe((await plan()).stripe_price_id)
      await invariants(stripe)
    })
  })

  it('after D2 (before the old price is archived and anyone is moved): the plan steps and moves are left, and reconcile sends them', async () => {
    await onASeed(async (stripe) => {
      const change = await startedOnly()
      const made = await makeChangePrices(stripe, change, undefined)
      if (made.kind !== 'made') throw new Error('not made')
      await applyPriceChange(db, change, made.value, by)
      expect(stripe.price(MONTHLY)?.['active']).toBe(true)
      expect(moves(stripe)).toEqual([])
      pastTheWindow()
      await reconcileNow(stripe)
      expect(stripe.price(MONTHLY)?.['active']).toBe(false)
      expect([await priceOf(stripe, 'sub_mo'), await priceOf(stripe, 'sub_pat')]).toEqual([made.value.priceIds.monthly, made.value.priceIds.monthly])
      await invariants(stripe)
    })
  })

  it('between member steps: the rest left, sent by reconcile once each', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.retrieve', { kind: 'none' })
      stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
      expect((await saveCore({ priceMonthly: 45, membersToMove: 2 })).data).toMatchObject({ priceChange: { moved: 1, toMove: 1 } })
      pastTheWindow()
      await reconcileNow(stripe)
      await invariants(stripe)
      expect(moves(stripe)).toHaveLength(2)
    })
  })

  it('a D2 run twice (the press and reconcile both finishing) writes once', async () => {
    await onASeed(async (stripe) => {
      const change = await startedOnly()
      const made = await makeChangePrices(stripe, change, undefined)
      if (made.kind !== 'made') throw new Error('not made')
      expect(await applyPriceChange(db, change, made.value, by)).not.toBeNull()
      expect(await applyPriceChange(db, change, made.value, by)).toBeNull()
      expect((await priceSteps()).filter((row) => row.details['state'] === 'left')).toHaveLength(2)
      expect(await openChanges(db)).toEqual([])
    })
  })
})

describe('making a plan (GB20)', () => {
  const weekender = { name: ' Weekender ', level: 'core', sessionsIncluded: 2, addonsIncluded: 1, isUnlimited: false, priceMonthly: 25, priceYearly: 250 }

  it('the row off sale with its record, the product and both prices under keys from the plan, then on sale with the ids in one transaction', async () => {
    await onASeed(async (stripe) => {
      const made = await press<Row>(createRoute, {}, weekender)
      expect(made.ok).toBe(true)
      const id = String(made.data?.['id'])
      expect(made.data).toMatchObject({ name: 'Weekender', active: true, price_monthly: '25.00', price_yearly: '250.00' })
      expect(stripe.calls.map((call) => [call.method, call.idempotencyKey])).toEqual([
        ['products.create', `${id}:plan-product`],
        ['prices.create', `${id}:plan-monthly`],
        ['prices.create', `${id}:plan-yearly`],
      ])
      expect((await audited('plan.created')).map((row) => row.details['state'])).toEqual(['started', 'done'])
      expect((await planRows()).find((row) => row.id === id)?.setup).toBe('ready')
      await invariants(stripe)
    })
  })

  it('a repeated press under its key makes one plan', async () => {
    await onASeed(async (stripe) => {
      const key = crypto.randomUUID()
      const first = await press<Row>(createRoute, {}, weekender, JO, key)
      const again = await press<Row>(createRoute, {}, weekender, JO, key)
      expect(again.replayed).toBe(true)
      expect(again.data?.['id']).toBe(first.data?.['id'])
      expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM membership_plans WHERE name = 'Weekender'")).n).toBe(1)
      expect(stripe.calls.filter((call) => call.method === 'products.create')).toHaveLength(1)
    })
  })

  it('Stripe refuses: the record failed, the row left off sale with no Stripe ids and off every list, Stripe\'s reason; anything made is tidied', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('prices.create', { kind: 'none' })
      stripe.failNext('prices.create', refused())
      const answer = await press(createRoute, {}, weekender)
      expect([answer.reason, answer.error?.message]).toEqual(['stripe_refused', NEW.createRefused('Stripe refused this change.')])
      const row = await one<{ id: string; active: boolean; stripe_product_id: string | null }>("SELECT id, active, stripe_product_id FROM membership_plans WHERE name = 'Weekender'")
      expect(row).toMatchObject({ active: false, stripe_product_id: null })
      expect((await planRows()).map((plan) => plan.id)).not.toContain(row.id)
      expect((await audited('plan.created')).map((one) => one.details['state'])).toEqual(['started', 'failed'])
      // The product and the monthly price it made are archived as plan steps (nothing names them).
      const product = stripe.calls.find((call) => call.method === 'products.create')
      expect(product).toBeDefined()
      expect(stripe.calls.some((call) => call.method === 'products.update' && (call.params as { active?: boolean }).active === false)).toBe(true)
      expect(stripe.calls.some((call) => call.method === 'prices.update' && (call.params as { active?: boolean }).active === false)).toBe(true)
      // On sale is refused for it: it was never set up.
      expect((await press(activeRoute, { planId: row.id }, { active: true })).error?.message).toBe(NEW.noStripeProduct)
    })
  })

  it('no clear answer: the plan answered off sale with the words; listed; reconcile past the window finds what was made and finishes it under the same keys (one product)', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('prices.create', { kind: 'none' })
      stripe.failNext('prices.create', { kind: 'lost_response' })
      const answer = await press<Row>(createRoute, {}, weekender)
      expect(answer.data).toMatchObject({ active: false, create: { state: 'held', message: NEW.createHeld } })
      const id = String(answer.data?.['id'])
      expect((await planRows()).find((row) => row.id === id)?.setup).toBe('being_set_up')
      expect((await press(activeRoute, { planId: id }, { active: true })).error?.message).toBe(NEW.stillBeingSetUp)
      expect((await press(detailsRoute, { planId: id }, { level: 'core', isUnlimited: false, sessionsIncluded: 2, addonsIncluded: 1, priceMonthly: 25, priceYearly: 250, stamp: (await planRows()).find((row) => row.id === id)?.stamp })).reason).toBe('still_being_set_up')
      expect((await stuckList(db)).plans?.map((line) => line.what)).toEqual(['plan_create'])
      pastTheWindow()
      await reconcileNow(stripe)
      expect(await plan(id)).toMatchObject({ active: true })
      expect(stripe.calls.filter((call) => call.method === 'products.create')).toHaveLength(1)
      expect(stripe.calls.filter((call) => call.method === 'prices.create').length).toBeLessThanOrEqual(3)
      expect(new Set([(await plan(id)).stripe_price_id, (await plan(id)).stripe_price_id_yearly]).size).toBe(2)
      expect((await audited('plan.created')).map((row) => row.details['state'])).toEqual(['started', 'held', 'done'])
      await invariants(stripe)
    })
  })

  it('the old refusals in the old words; Manage pricing', async () => {
    await onASeed(async (stripe) => {
      const C = W.createMembershipPlan
      for (const [body, words] of [
        [{ name: '   ' }, C.nameRequired],
        [{ level: 'gold' }, C.levelMustEitherCoreOrAll],
        [{ sessionsIncluded: -1 }, C.sessionsIncludedMustNonNegativeWhole],
        [{ sessionsIncluded: 0 }, C.sessionsIncludedMustPositiveWholeNumber],
        [{ addonsIncluded: 0.5 }, C.addOnsIncludedMustNonNegative],
        [{ isUnlimited: 'yes' }, C.isunlimitedMustTrueOrFalse],
        [{ priceMonthly: null, priceYearly: null }, C.atLeastOnePriceMustProvided],
        [{ priceMonthly: -1 }, C.monthlyPriceMustNonNegativeNumber],
        // A number that isn't one (NaN, Infinity) would reach the Worker as JSON null, which is "no price" here: the
        // staff app's createMembershipPlan sends it as its text, refused in the old words (staff-app-helpers.test.ts).
        [{ priceYearly: 'NaN' }, C.yearlyPriceMustNonNegativeNumber],
      ] as const) {
        expect((await press(createRoute, {}, { ...weekender, ...body })).error?.message, JSON.stringify(body)).toBe(words)
      }
      expect((await press(createRoute, {}, weekender, FRAN)).error?.message).toBe(NO_PRICING)
      expect(stripe.calls).toEqual([])
      expect(await audited('plan.created')).toEqual([])
    })
  })
})

describe('on and off sale', () => {
  it("off: the row first, then Stripe's product as a step, sent; live members untouched; a subscription on the off-sale product's price is refused (the fake's cautious reading, checked in test mode); on: Stripe first, then the row", async () => {
    await onASeed(async (stripe) => {
      const off = await press(activeRoute, { planId: ID.plan }, { active: false })
      expect(off.data).toEqual({ id: ID.plan, active: false })
      expect(stripe.product('prod_seed')?.['active']).toBe(false)
      expect((await plan()).active).toBe(false)
      expect(moves(stripe)).toEqual([])
      expect(await priceOf(stripe, 'sub_mo')).toBe(MONTHLY)
      // A price with its product named (as prices the Worker makes are), on the off-sale product.
      const made = await stripe.prices.create({ product: 'prod_seed', unit_amount: 4000, currency: 'gbp', recurring: { interval: 'month' } })
      await expect(stripe.subscriptions.create({ customer: 'cus_member', items: [{ price: made.id }] })).rejects.toThrow('is not active')
      const on = await press(activeRoute, { planId: ID.plan }, { active: true })
      expect(on.data).toEqual({ id: ID.plan, active: true })
      const methods = stripe.calls.map((call) => call.method).filter((method) => method.startsWith('products.'))
      expect(methods).toEqual(['products.retrieve', 'products.update', 'products.retrieve', 'products.update'])
      expect(stripe.product('prod_seed')?.['active']).toBe(true)
      expect((await audited('plan.active_set')).map((row) => [row.details['before'], row.details['after']])).toEqual([
        [{ id: ID.plan, active: true }, { id: ID.plan, active: false }],
        [{ id: ID.plan, active: false }, { id: ID.plan, active: true }],
      ])
    })
  })

  it('on: Stripe refuses, or gives no clear answer: nothing changes here; an unknown plan in the old words; Manage pricing', async () => {
    await onASeed(async (stripe) => {
      await press(activeRoute, { planId: ID.plan }, { active: false })
      stripe.failNext('products.update', refused())
      expect((await press(activeRoute, { planId: ID.plan }, { active: true })).error?.message).toBe(NEW.onRefused('Stripe refused this change.'))
      expect((await plan()).active).toBe(false)
      stripe.failNext('products.retrieve', { kind: 'unreachable' })
      expect((await press(activeRoute, { planId: ID.plan }, { active: true })).error?.message).toBe(NEW.onUnclear)
      expect((await plan()).active).toBe(false)
      expect((await press(activeRoute, { planId: UNKNOWN }, { active: true })).error?.message).toBe(CATALOG_ADMIN_WORDS.toggleItemActive.itemNotFound)
      expect((await press(activeRoute, { planId: ID.plan }, { active: true }, FRAN)).error?.message).toBe(NO_PRICING)
    })
  })

  it("off with no clear answer from Stripe: the row is off, the step left and listed past the window, then sent by reconcile; on is refused while the off step's press may still be sending it", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('products.retrieve', { kind: 'unreachable' })
      expect((await press(activeRoute, { planId: ID.plan }, { active: false })).data).toEqual({ id: ID.plan, active: false })
      expect(stripe.product('prod_seed')?.['active']).toBe(true)
      expect((await press(activeRoute, { planId: ID.plan }, { active: true })).error?.message).toBe(NEW.offStillBeingSent)
      pastTheWindow()
      expect((await stuckList(db)).plans?.map((line) => [line.what, line.words])).toEqual([['product_off', PLAN_STUCK_WORDS.productLeft('Core', false)]])
      await reconcileNow(stripe)
      expect(stripe.product('prod_seed')?.['active']).toBe(false)
      expect((await stuckList(db)).plans).toEqual([])
    })
  })

  it('a product put back on sale in Stripe behind the plan\'s back is put right by the check 20 minutes after the step closed', async () => {
    await onASeed(async (stripe) => {
      await press(activeRoute, { planId: ID.plan }, { active: false })
      await stripe.products.update('prod_seed', { active: true })
      vi.setSystemTime(Date.now() + 21 * 60_000)
      await reconcileNow(stripe)
      expect((await audited(PLAN_STEP_ACTION)).some((row) => row.details['state'] === 'checked' && row.details['outcome'] === 'left_again')).toBe(true)
      pastTheWindow()
      await reconcileNow(stripe)
      expect(stripe.product('prod_seed')?.['active']).toBe(false)
    })
  })

  it("Q61 (Wayne, 23 Nov; W66a): on is refused while the plan has no price, before Stripe is asked anything; off never is; one price, either, is enough", async () => {
    await onASeed(async (stripe) => {
      expect((await press(activeRoute, { planId: ID.plan }, { active: false })).data).toEqual({ id: ID.plan, active: false })
      const product = stripe.product('prod_seed')?.['active']
      expect(product).toBe(false)
      await db.query('UPDATE membership_plans SET price_monthly = NULL, price_yearly = NULL WHERE id = $1', [ID.plan])
      const auditedBefore = (await audited('plan.active_set')).length
      const callsBefore = stripe.calls.length
      const refusedOn = await press(activeRoute, { planId: ID.plan }, { active: true })
      expect([refusedOn.status, refusedOn.reason, refusedOn.error?.message]).toEqual([409, 'price_not_set', 'Set its price first.'])
      expect((await plan()).active).toBe(false)
      expect(stripe.calls).toHaveLength(callsBefore)
      expect(await audited('plan.active_set')).toHaveLength(auditedBefore)
      expect((await press(activeRoute, { planId: ID.plan }, { active: false })).data).toEqual({ id: ID.plan, active: false })
      // A yearly price alone, then a monthly alone: on sale.
      for (const sql of ['UPDATE membership_plans SET price_yearly = 400 WHERE id = $1', 'UPDATE membership_plans SET price_yearly = NULL, price_monthly = 40 WHERE id = $1']) {
        await db.query(sql, [ID.plan])
        pastTheWindow()
        await reconcileNow(stripe)
        expect((await press(activeRoute, { planId: ID.plan }, { active: true })).data).toEqual({ id: ID.plan, active: true })
        expect(stripe.product('prod_seed')?.['active']).toBe(true)
        expect((await press(activeRoute, { planId: ID.plan }, { active: false })).data).toEqual({ id: ID.plan, active: false })
      }
    })
  })

  it('W58c (W58 review FL4): off is refused while a price change on the plan is still moving its members; nothing written; allowed once they have moved', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', { kind: 'unreachable' })
      expect((await saveCore({ priceMonthly: 45, membersToMove: 2 })).data).toMatchObject({ priceChange: { moved: 1, toMove: 1 } })
      const auditedBefore = (await audited('plan.active_set')).length
      const productCallsBefore = stripe.calls.filter((call) => call.method.startsWith('products.')).length
      const refusedOff = await press(activeRoute, { planId: ID.plan }, { active: false })
      expect([refusedOff.reason, refusedOff.error?.message]).toEqual(['price_change_open', NEW.offWhileChangeOpen])
      expect((await plan()).active).toBe(true)
      expect(stripe.product('prod_seed')?.['active']).toBe(true)
      expect(await audited('plan.active_set')).toHaveLength(auditedBefore)
      expect(stripe.calls.filter((call) => call.method.startsWith('products.'))).toHaveLength(productCallsBefore)
      // The move goes out, then the plan comes off sale with every member on the new price.
      pastTheWindow()
      await reconcileNow(stripe)
      const newPrice = String((await plan()).stripe_price_id)
      expect([await priceOf(stripe, 'sub_mo'), await priceOf(stripe, 'sub_pat')]).toEqual([newPrice, newPrice])
      expect((await press(activeRoute, { planId: ID.plan }, { active: false })).data).toEqual({ id: ID.plan, active: false })
      expect(stripe.product('prod_seed')?.['active']).toBe(false)
      await invariants(stripe)
    })
  })

  it('a plan step Stripe refuses for good is listed with Mark sorted, and closed by hand', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('products.update', refused())
      await press(activeRoute, { planId: ID.plan }, { active: false })
      const line = (await stuckList(db)).plans?.[0]
      expect(line).toMatchObject({ what: 'product_off', state: 'refused', words: PLAN_STUCK_WORDS.productRefused('Core', false), close: { kind: 'plan_step' } })
      expect(stuckListOutputSchema.parse(await stuckList(db)).plans).toHaveLength(1)
      const closed = await closeStuckItem(db, { kind: 'plan_step', orderId: line?.close?.orderId ?? '', reason: 'archived the product by hand' }, { actor: { type: 'staff', id: ID.staff }, requestId: 'close-1' })
      expect(closed).toMatchObject({ closed: true, kind: 'plan_step', message: LEFT_STEP_WORDS.sorted })
      expect((await stuckList(db)).plans).toEqual([])
    })
  })
})

describe('the `plan_changes` switch (lead call L3)', () => {
  it('off: making a plan, its details or price, and on or off sale answer the switched-off words before anything is read; the reads and the settings still work; reconcile still finishes a held change', async () => {
    await onASeed(
      async (stripe) => {
        for (const [handler, params, body] of [
          [createRoute, {}, { name: 'X', level: 'core', sessionsIncluded: 1, addonsIncluded: 0, isUnlimited: false, priceMonthly: 1, priceYearly: null }],
          [detailsRoute, { planId: ID.plan }, { ...coreDetails, name: 'Y' }],
          [activeRoute, { planId: ID.plan }, { active: false }],
        ] as const) {
          const answer = await press(handler, params, body)
          expect([answer.error?.code, answer.error?.message]).toEqual(['MEMBERSHIP_PATH_OFF', MEMBERSHIP_PATH_OFF_MESSAGE])
        }
        // Even a press with nothing wrong in it, and one from staff without Manage pricing: nothing is read first.
        expect((await press(detailsRoute, { planId: UNKNOWN }, {}, FRAN)).error?.code).toBe('MEMBERSHIP_PATH_OFF')
        expect(stripe.calls).toEqual([])
        expect((await db.query("SELECT 1 FROM audit_log WHERE action LIKE 'plan.%'")).length).toBe(0)
        expect((await read(plansRoute)).ok).toBe(true)
        expect((await read(settingsRoute)).ok).toBe(true)
        // A change held before the switch went off: reconcile still finishes it.
        const change: PriceChange = { changeId: crypto.randomUUID(), planId: ID.plan, productId: 'prod_seed', productName: 'Core', productActive: true, prices: { monthly: { from: '40.00', to: '45.00', oldPriceId: MONTHLY } }, membersToMove: 2 }
        await db.transaction((tx) => audit.recordAll(tx, [changeStartedEntry(by, change, 'k')]))
        await makeChangePrices(stripe, change, undefined)
        pastTheWindow()
        await reconcileNow(stripe)
        expect(await changeStates()).toEqual(['started', 'done'])
        expect(await priceOf(stripe, 'sub_mo')).toBe((await plan()).stripe_price_id)
      },
      undefined,
      'membership_changes'
    )
  })
})

describe('an order\'s T2 and a price change take turns (brief item 3; invariant 11)', () => {
  it('a subscription made on the price a change has since replaced is given its own move step by T2; one made on the new price is not', async () => {
    await onASeed(async (stripe) => {
      await saveCore({ priceMonthly: 45, membersToMove: 2 })
      const newPrice = String((await plan()).stripe_price_id)
      // A new member whose order read the plan before D2: their subscription is on the old price.
      stripe.addCustomer('cus_new')
      await insert(db, 'customers', { id: '10000000-0000-4000-8000-0000000057d1', first_name: 'New', last_name: 'Member', email: 'new@example.com', date_of_birth: '1990-01-01', stripe_customer_id: 'cus_new' })
      await insert(db, 'customer_memberships', { id: '10000000-0000-4000-8000-0000000057d2', customer_id: '10000000-0000-4000-8000-0000000057d1', plan_id: ID.plan, start_date: '2026-11-21', subscription_status: 'active', billing_frequency: 'monthly', stripe_subscription_id: 'sub_new' })
      stripe.addSubscription('sub_new', 'cus_new', MONTHLY)
      const prices = await one<{ stripe_price_id: string; stripe_price_id_yearly: string }>('SELECT stripe_price_id, stripe_price_id_yearly FROM membership_plans WHERE id = $1', [ID.plan])
      const step = await db.transaction((tx) => followPlanPrice(tx, { planId: ID.plan, membershipId: '10000000-0000-4000-8000-0000000057d2', subscriptionId: 'sub_new', frequency: 'monthly', madeOn: MONTHLY, orderId: 'order-1' }, prices, by))
      expect(step?.want).toEqual({ price: newPrice, interval: 'month' })
      const none = await db.transaction((tx) => followPlanPrice(tx, { planId: ID.plan, membershipId: '10000000-0000-4000-8000-0000000057d2', subscriptionId: 'sub_new', frequency: 'monthly', madeOn: newPrice, orderId: 'order-2' }, prices, by))
      expect(none).toBeNull()
      pastTheWindow()
      await reconcileNow(stripe)
      expect(await priceOf(stripe, 'sub_new')).toBe(newPrice)
      // A subscription started the moment after D2 uses the new price: the plan already names it, and it is active.
      expect(stripe.price(newPrice)?.['active']).toBe(true)
      await invariants(stripe)
    })
  })
})

describe("an order's T2 through the real order route, with the old price archived only after it (brief item 3; invariant 11; W57a: W57 review S2)", () => {
  const ORDER_KINDS = `${ALL_KINDS_ON},plan_changes`
  /** Only the archive steps' own window passed (moved back 20 minutes): the order and the moves stay inside theirs. */
  const AGE_ARCHIVE_STEPS_SQL = "UPDATE audit_log SET at = at - interval '20 minutes' WHERE action = 'plan.stripe_step' AND details->>'kind' = 'archive_price'"
  async function archiveStepsPastTheirWindow(): Promise<void> {
    await db.query('RESET ROLE')
    await db.query(AGE_ARCHIVE_STEPS_SQL)
    await db.query('SET ROLE paddock_worker')
  }
  /** Staff change Core's monthly price on the plans page while a membership sale is on its way; then a run past the archive step's window. */
  async function priceChangedMidSale(stripe: FakeStripe): Promise<void> {
    const saved = await saveCore({ priceMonthly: 45, membersToMove: 2 })
    expect(saved.data, JSON.stringify(saved)).toMatchObject({ priceChange: { state: 'done' } })
    // The press doesn't archive the old price, and a run past the step's window leaves it active: a pending order names it.
    await archiveStepsPastTheirWindow()
    await reconcileNow(stripe)
    expect(stripe.price(MONTHLY)?.['active']).toBe(true)
    expect((await stuckList(db)).plans).toEqual([])
  }
  /** After the sale: the subscription on the old price, the new member's own move left by T2, then both sent past the window. */
  async function afterTheSale(stripe: FakeStripe, subscriptionId: string): Promise<void> {
    const newPrice = String((await plan()).stripe_price_id)
    expect(newPrice).not.toBe(MONTHLY)
    // Made on the price the order was quoted at (T1's), still active, which D2 had since replaced.
    expect(await priceOf(stripe, subscriptionId)).toBe(MONTHLY)
    const left = (await priceSteps()).filter((row) => row.details['state'] === 'left' && row.details['subscriptionId'] === subscriptionId)
    expect(left.map((row) => [row.details['want'], row.details['leftBy']])).toEqual([[{ price: newPrice, interval: 'month' }, 'order']])
    expect((await audited(PRICE_MOVED_ACTION)).some((row) => row.details['subscriptionId'] === subscriptionId && row.details['fromPriceId'] === MONTHLY)).toBe(true)
    pastTheWindow()
    await reconcileNow(stripe)
    expect(await priceOf(stripe, subscriptionId)).toBe(newPrice)
    // The old price archived only now, after the subscription was made on it.
    expect(stripe.price(MONTHLY)?.['active']).toBe(false)
    const methods = stripe.calls.map((call) => `${call.method}:${String((call.params as { id?: string }).id ?? '')}`)
    expect(methods.findIndex((one) => one.startsWith('subscriptions.create'))).toBeLessThan(methods.indexOf(`prices.update:${MONTHLY}`))
    expect((await stuckList(db)).plans).toEqual([])
    await invariants(stripe)
  }

  it('saved card: the change pressed between T1 and the subscription (the whole press, then a run): the order completes on the old price, T2 leaves the member their move, and the old price is archived only after', async () => {
    await onASeed(async (stripe) => {
      let pressed = false
      const make = stripe.subscriptions.create.bind(stripe.subscriptions)
      stripe.subscriptions.create = (async (params: never, options?: never) => {
        if (!pressed) {
          pressed = true
          await priceChangedMidSale(stripe)
        }
        return make(params, options)
      }) as typeof stripe.subscriptions.create
      const input = await withQuotedCardFigure(orderInput({ customerId: ID.customer, membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', payment: { method: 'card' } }))
      const placed = await postOrder(input, { orderSwitch: ORDER_KINDS })
      expect(placed.body.ok, JSON.stringify(placed.body)).toBe(true)
      expect(pressed).toBe(true)
      await afterTheSale(stripe, stripe.subscriptionsMade.at(-1) as string)
    })
  })

  it('card reader: the change pressed after T1 and before the tap: the tap is kept, finalise makes the subscription on the old price (nothing refunded), T2 leaves the member their move, and the old price is archived only after', async () => {
    await onASeed(async (stripe) => {
      const input = await withQuotedCardFigure(orderInput({ customerId: ID.customer, membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', payment: { method: 'reader', readerSaveCard: true } }))
      const order = await postOrder(input, { orderSwitch: ORDER_KINDS })
      expect(order.body.ok, JSON.stringify(order.body)).toBe(true)
      const data = order.body.ok ? order.body.data : null
      await priceChangedMidSale(stripe)
      vi.setSystemTime(Date.now() + 5000)
      stripe.completeReaderPayment(data?.pendingReaderPayment?.paymentIntentId as string, { generatedCard: 'pm_tapped_mid_change' })
      vi.stubEnv('ORDER_SWITCH', ORDER_KINDS)
      const finalised = await postReaderStep('finalise', data?.orderId as string)
      expect(finalised.body, JSON.stringify(finalised.body)).toMatchObject({ ok: true, data: { finalised: true } })
      expect(stripe.refundsSent).toEqual([])
      await afterTheSale(stripe, stripe.subscriptionsMade.at(-1) as string)
    })
  })
})

describe('Manage pricing on each write', () => {
  it('details, price, create, on and off sale, settings: refused for staff without it, before anything is read or sent', async () => {
    await onASeed(async (stripe) => {
      expect((await saveCore({ name: 'x' }, FRAN)).error?.message).toBe(NO_PRICING)
      expect((await press(detailsRoute, { planId: ID.plan }, { monthlyPrice: 45, membersToMove: 2 }, FRAN)).error?.message).toBe(NO_PRICING)
      expect((await press(createRoute, {}, { name: 'x' }, FRAN)).error?.message).toBe(NO_PRICING)
      expect((await press(activeRoute, { planId: ID.plan }, { active: false }, FRAN)).error?.message).toBe(NO_PRICING)
      expect((await press(setSettingsRoute, {}, { addonCreditWaitMonths: 6, herdFlagsToChange: 0 }, FRAN)).error?.message).toBe(NO_PRICING)
      expect(stripe.calls).toEqual([])
      expect((await db.query("SELECT 1 FROM audit_log WHERE action LIKE 'plan.%' OR action = 'membership_settings.set'")).length).toBe(0)
    })
  })
})

describe('the step machinery for a member\'s move (memberships/left.ts, kind `price`)', () => {
  it("a subscription with more than one item can't be told which to move: refused for good, in the legacy route's words", async () => {
    await onASeed(async (stripe) => {
      // The fake models one item; the retrieve is what the step reads, so it is the read that is given a second.
      const original = stripe.subscriptions.retrieve.bind(stripe.subscriptions)
      stripe.subscriptions.retrieve = (async (id: string, params?: unknown, options?: unknown) => {
        const answer = await original(id, params as never, options as never)
        if (id === 'sub_pat') (answer as unknown as { items: { data: unknown[] } }).items.data.push({ id: 'si_extra', price: { id: 'price_extra' } })
        return answer
      }) as typeof stripe.subscriptions.retrieve
      await saveCore({ priceMonthly: 45, membersToMove: 2 })
      pastTheWindow()
      await reconcileNow(stripe)
      const listed = (await stuckList(db)).steps.find((step) => step.subscriptionId === 'sub_pat')
      expect(listed?.state).toBe('refused')
      const refusedRow = (await priceSteps()).find((row) => row.details['state'] === 'refused')
      expect(refusedRow?.details['detail']).toBe('Expected one subscription item, found 2.')
    })
  })
})

describe('W57a (W57 review S1): a move never changes how often a subscription renews', () => {
  const updatesOf = (stripe: FakeStripe, subscriptionId: string) => moves(stripe).filter((params) => params.id === subscriptionId)

  it("a yearly subscription on a row that says monthly: the monthly change refuses Pat's move for good (nothing sent), listed in words with Mark sorted; Mo is moved; a run never sends it", async () => {
    await onASeed(
      async (stripe) => {
        const saved = await saveCore({ priceMonthly: 45, membersToMove: 2 })
        expect(saved.data).toMatchObject({ priceChange: { state: 'done', moved: 1, toMove: 1 } })
        expect(updatesOf(stripe, 'sub_pat')).toEqual([])
        expect(updatesOf(stripe, 'sub_mo')).toHaveLength(1)
        pastTheWindow()
        await reconcileNow(stripe)
        expect(updatesOf(stripe, 'sub_pat')).toEqual([])
        expect(await priceOf(stripe, 'sub_pat')).toBe(YEARLY)
        const listed = (await stuckList(db)).steps.filter((step) => step.subscriptionId === 'sub_pat')
        expect(listed).toHaveLength(1)
        expect(listed[0]).toMatchObject({ step: 'price', what: 'plan_price', state: 'refused', close: { kind: 'left_step' } })
        expect(listed[0]?.words).toBe(PRICE_MOVE_INTERVAL_WORDS.stuck('sub_pat', 'year', 'month'))
        const refusedRow = (await priceSteps()).find((row) => row.details['state'] === 'refused')
        expect(refusedRow?.details['detail']).toBe("This member's subscription renews every year in Stripe but their membership says monthly, so it was not moved. Check which is right, move it in Stripe by hand, then press Mark sorted.")
        expect(refusedRow?.details['wrongInterval']).toEqual({ stripe: 'year', membership: 'month' })
        pastTheWindow()
        await reconcileNow(stripe)
        expect(updatesOf(stripe, 'sub_pat')).toEqual([])
        await invariants(stripe)
        expect((await sortLeftStep(db, listed[0]?.stepId ?? '', 'Pat is yearly: row corrected by hand', by)).closed).toBe(true)
        expect((await stuckList(db)).steps).toEqual([])
      },
      (_seedDb, stripe) => stripe.addSubscription('sub_pat', 'cus_pat', YEARLY)
    )
  })

  it("and the reverse: a monthly subscription on a row that says yearly: the yearly change refuses Yan's move for good, nothing sent", async () => {
    await onASeed(
      async (stripe) => {
        const saved = await saveCore({ priceYearly: 450, membersToMove: 1 })
        expect(saved.data).toMatchObject({ priceChange: { state: 'done', moved: 0, toMove: 1 } })
        pastTheWindow()
        await reconcileNow(stripe)
        expect(updatesOf(stripe, 'sub_yan')).toEqual([])
        expect(await priceOf(stripe, 'sub_yan')).toBe(MONTHLY)
        const listed = (await stuckList(db)).steps.filter((step) => step.subscriptionId === 'sub_yan')
        expect(listed.map((step) => [step.state, step.words])).toEqual([['refused', PRICE_MOVE_INTERVAL_WORDS.stuck('sub_yan', 'month', 'year')]])
        expect((await priceSteps()).find((row) => row.details['state'] === 'refused')?.details['detail']).toBe(
          "This member's subscription renews every month in Stripe but their membership says yearly, so it was not moved. Check which is right, move it in Stripe by hand, then press Mark sorted."
        )
        await invariants(stripe)
      },
      (_seedDb, stripe) => stripe.addSubscription('sub_yan', 'cus_yan', MONTHLY)
    )
  })

  it("the 20-minute check: a moved subscription later put on a yearly price in Stripe is left again refused, for a person, in the same words; nothing is sent", async () => {
    await onASeed(async (stripe) => {
      await saveCore({ priceMonthly: 45, membersToMove: 2 })
      expect(updatesOf(stripe, 'sub_mo')).toHaveLength(1)
      // Someone puts Mo's subscription on the yearly price in Stripe by hand.
      stripe.addSubscription('sub_mo', 'cus_member', YEARLY)
      vi.setSystemTime(Date.now() + 21 * 60_000)
      await reconcileNow(stripe)
      const listed = (await stuckList(db)).steps.filter((step) => step.subscriptionId === 'sub_mo')
      expect(listed.map((step) => [step.state, step.words])).toEqual([['refused', PRICE_MOVE_INTERVAL_WORDS.stuck('sub_mo', 'year', 'month')]])
      pastTheWindow()
      await reconcileNow(stripe)
      expect(updatesOf(stripe, 'sub_mo')).toHaveLength(1)
      expect(await priceOf(stripe, 'sub_mo')).toBe(YEARLY)
    })
  })
})

describe("W57a (W57 review S3): the edit dialog's press kept after no answer, sent again after the page reloads", () => {
  type Body = Record<string, unknown>
  type Helper = {
    pressToSend: (kept: { key: string; body: Body } | null, fromForm: () => Body, newKey: () => string) => { key: string; body: Body }
    keptAfter: (press: { key: string; body: Body }, noAnswer: boolean) => { key: string; body: Body } | null
  }
  const helper = async (): Promise<Helper> => (await import(/* @vite-ignore */ path.join(staffAppDir(), 'frontend/utils/membershipPlans.ts'))) as Helper

  it('the first press got as far as D1 and no answer came back; the list reloads with a new stamp; pressing again sends the kept key and body, which the Worker accepts (the same answer); the form read again under that key would be refused', async () => {
    const { pressToSend, keptAfter } = await helper()
    await onASeed(async (stripe) => {
      // The dialog's form, as it reads the row it opened on (its stamp).
      const fromForm = async (): Promise<Body> => ({ ...coreDetails, name: 'Core Plus', priceMonthly: 45, membersToMove: 2, stamp: (await corePlan()).stamp })
      const stampBefore = (await corePlan()).stamp
      const formBody = await fromForm()
      const firstPress = pressToSend(null, () => formBody, () => crypto.randomUUID())
      expect(firstPress.body).toBe(formBody)
      const answered = await press(detailsRoute, { planId: ID.plan }, firstPress.body, JO, firstPress.key)
      expect(answered.ok).toBe(true)
      // The answer is lost on its way back to the staff app: the dialog keeps the press, and the page reloads.
      const kept = keptAfter(firstPress, true)
      expect(kept).toEqual(firstPress)
      const stampAfter = (await corePlan()).stamp
      expect(stampAfter).not.toBe(stampBefore)
      // Pressing again: the kept press, exactly as it was (the old stamp), never the form read again.
      const again = pressToSend(kept, () => ({ shouldNot: 'be read' }), () => 'a-new-key-that-must-not-be-used')
      expect(again).toEqual(firstPress)
      const second = await press(detailsRoute, { planId: ID.plan }, again.body, JO, again.key)
      expect(second.ok).toBe(true)
      expect(second.replayed).toBe(true)
      expect(second.data).toEqual(answered.data)
      // W57's way (the form read again: the new stamp, under the same key) is refused as a changed press.
      const reread = await press(detailsRoute, { planId: ID.plan }, await fromForm(), JO, firstPress.key)
      expect(reread.ok).toBe(false)
      // One change, one Stripe price.
      expect(madePrices(stripe)).toHaveLength(1)
      expect(keptAfter(firstPress, false)).toBeNull()
    })
  })
})

describe('W57a (W57 review L3): on and off pressed at once', () => {
  it("an off press made while an on press is at Stripe stands: the on press is refused in words and writes nothing; the row stays off, and the 20-minute check puts Stripe's product back off", async () => {
    await onASeed(async (stripe) => {
      expect((await press(activeRoute, { planId: ID.plan }, { active: false })).data).toEqual({ id: ID.plan, active: false })
      const update = stripe.products.update.bind(stripe.products)
      let offMeanwhile: AdminAnswer<unknown> | null = null
      stripe.products.update = (async (id: string, params: { active?: boolean }, options?: never) => {
        // The on press's send: before it lands, someone presses off again.
        if (params.active === true && !offMeanwhile) offMeanwhile = await press(activeRoute, { planId: ID.plan }, { active: false })
        return update(id, params as never, options)
      }) as typeof stripe.products.update
      const on = await press(activeRoute, { planId: ID.plan }, { active: true })
      expect(offMeanwhile).toMatchObject({ ok: true, data: { id: ID.plan, active: false } })
      expect([on.reason, on.error?.message]).toEqual(['off_pressed_meanwhile', NEW.offPressedMeanwhile])
      expect((await plan()).active).toBe(false)
      expect((await audited('plan.active_set')).map((row) => row.details['after'])).toEqual([
        { id: ID.plan, active: false },
        { id: ID.plan, active: false },
      ])
      // The on press's send landed last: Stripe shows the product on. The off press's step closed done; its check puts it right.
      expect(stripe.product('prod_seed')?.['active']).toBe(true)
      vi.setSystemTime(Date.now() + 21 * 60_000)
      await reconcileNow(stripe)
      pastTheWindow()
      await reconcileNow(stripe)
      expect(stripe.product('prod_seed')?.['active']).toBe(false)
      // A later on press works as before.
      stripe.products.update = update
      expect((await press(activeRoute, { planId: ID.plan }, { active: true })).data).toEqual({ id: ID.plan, active: true })
    })
  })
})
