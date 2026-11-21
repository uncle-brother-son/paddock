import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { lockCustomerForCardSteps, followSavedCard } from '@/server/rules/customers/card-steps'
import { cancelMembership } from '@/server/rules/memberships/cancel'
import { changePaymentDate, londonDateOfSeconds, paymentDateQuote } from '@/server/rules/memberships/payment-date'
import { holdingAfter, outcomeOf, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { applyPriceChange, changeStartedEntry, followPlanPrice, makeChangePrices, PLAN_PRICES_FOR_SHARE_SQL, type PlanPrices, type PriceChange } from './plan-stripe'
import { setMembershipSettings, setPlanDetails, type PlanPressOptions } from './plans'
import { audit } from '@/server/audit'

// Brief W57 ("Parity and tests": races on real Postgres 17.6, each press on its own connection). Each race holds the
// first press inside its transaction, straight after a chosen statement, until Postgres itself reports the second as
// blocked by it, so none can pass by timing:
//  - a plan price change's D2 against a member's cancel, a payment date change and a card move: they take turns on
//    the membership's row, in LOCK_ORDER (the plan, then the membership; the customer, then the membership), with
//    no deadlock, and each change's own Stripe step is left;
//  - two price presses on one plan at once: the second waits on the plan's row, then is refused while the first is open;
//  - an order's T2 against D2: T2 waits on the plan's row (FOR SHARE), then reads the new price and leaves its own move;
//    and (W57a, L6) T2 first: D2 waits on the plan, then finds the new member live and leaves their move;
//  - the membership settings saved twice at once: the second waits on the settings row, then is refused (its count is old).
let pg: RealPostgres
let first: Db
let second: Db
let staffId = ''
let plan = ''
let members = 0

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  staffId = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w57-race@example.com', can_issue_refunds: true, can_manage_pricing: true })
})
afterAll(() => pg.stop())

const MONTHLY = 'price_w57_monthly'
beforeEach(async () => {
  plan = await fixtures.plan(first, { name: `W57 ${crypto.randomUUID().slice(0, 6)}`, sessions_included: 4, price_monthly: '40.00', price_yearly: '400.00', stripe_product_id: `prod_${crypto.randomUUID().slice(0, 8)}`, stripe_price_id: `${MONTHLY}_${crypto.randomUUID().slice(0, 6)}`, stripe_price_id_yearly: `price_y_${crypto.randomUUID().slice(0, 6)}` })
})

/** A monthly member on the plan, with a saved card, on a subscription the fake holds. */
async function member(stripe: FakeStripe): Promise<{ customer: string; membership: string; subscription: string }> {
  members += 1
  const subscription = `sub_w57_${members}`
  const stripeCustomer = `cus_w57_${members}`
  const customer = await fixtures.customer(first, { stripe_customer_id: stripeCustomer, saved_payment_method_id: `pm_w57_${members}`, saved_card_last4: '4242', saved_card_brand: 'visa' })
  const membership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', subscription_status: 'active', stripe_subscription_id: subscription })
  const [row] = await first.query<{ stripe_price_id: string; stripe_product_id: string }>('SELECT stripe_price_id, stripe_product_id FROM membership_plans WHERE id = $1', [plan])
  stripe.addCustomer(stripeCustomer)
  stripe.addProduct(row?.stripe_product_id as string)
  stripe.addPrice(row?.stripe_price_id as string, 4000, 'month')
  stripe.addSubscription(subscription, stripeCustomer, row?.stripe_price_id as string)
  const renews = londonDateOfSeconds(stripe.subscriptionSettings(subscription)?.periodEnd as number)
  await first.query("UPDATE customer_memberships SET start_date = (now() AT TIME ZONE 'Europe/London')::date - 200, next_renewal_date = $1::date WHERE id = $2", [renews, membership])
  return { customer, membership, subscription }
}

const by = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: crypto.randomUUID() })

/** The plan's change, recorded (D1) and made in Stripe (S1), ready for D2. */
async function changeMade(stripe: FakeStripe, to = '45.00') {
  const [row] = await first.query<{ stripe_price_id: string; stripe_product_id: string }>('SELECT stripe_price_id, stripe_product_id FROM membership_plans WHERE id = $1', [plan])
  const change: PriceChange = { changeId: crypto.randomUUID(), planId: plan, productId: row?.stripe_product_id as string, productName: 'W57', productActive: true, prices: { monthly: { from: '40.00', to, oldPriceId: row?.stripe_price_id as string } }, membersToMove: 1 }
  await first.transaction((tx) => audit.recordAll(tx, [changeStartedEntry(by(), change, 'k')]))
  const made = await makeChangePrices(stripe, change, undefined)
  if (made.kind !== 'made') throw new Error('not made')
  return { change, made: made.value }
}

const D2_PLAN_WRITE = (sql: string) => sql.startsWith('UPDATE membership_plans SET price_monthly')
const stepKinds = async (membership: string) =>
  (await first.query<{ kind: string }>("SELECT details->>'kind' AS kind FROM audit_log WHERE action = 'membership.step_left' AND entity_id = $1 AND details->>'state' = 'left' ORDER BY 1", [membership])).map((row) => row.kind)

describe("a plan price change's D2 takes turns with step F's actions on the same membership", () => {
  it('D2 first, holding the plan and the membership: a cancel waits on the membership, then both are recorded, each with its own step', async () => {
    const stripe = new FakeStripe({ idTag: 'r1' })
    const m = await member(stripe)
    const { change, made } = await changeMade(stripe)
    const held = holdingAfter(first, (sql) => sql.startsWith('SELECT id::text AS id, stripe_subscription_id'))
    const d2 = applyPriceChange(held.db, change, made, by())
    const holder = await held.holding
    const cancel = outcomeOf(cancelMembership(second, m.membership, { actor: { channel: 'staff', id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe }))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['customer_memberships'])
    held.release()
    expect(await d2).not.toBeNull()
    expect('answered' in (await cancel)).toBe(true)
    expect(await stepKinds(m.membership)).toEqual(['cancel_at', 'price'])
  })

  it('the cancel first, holding the membership: D2 waits on it (after the plan), then leaves its move for it; no deadlock', async () => {
    const stripe = new FakeStripe({ idTag: 'r2' })
    const m = await member(stripe)
    const { change, made } = await changeMade(stripe)
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE customer_memberships'))
    const cancel = cancelMembership(held.db, m.membership, { actor: { channel: 'staff', id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe })
    const holder = await held.holding
    const d2 = applyPriceChange(second, change, made, by())
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['customer_memberships'])
    held.release()
    await cancel
    expect(await d2).not.toBeNull()
    expect(await stepKinds(m.membership)).toEqual(['cancel_at', 'price'])
  })

  it('a payment date change first (the customer, then the membership): D2 waits on the membership, then both stand', async () => {
    const stripe = new FakeStripe({ idTag: 'r3' })
    const m = await member(stripe)
    const renews = (await first.query<{ d: string }>('SELECT next_renewal_date::text AS d FROM customer_memberships WHERE id = $1', [m.membership]))[0]?.d as string
    const newDate = (await first.query<{ d: string }>('SELECT ($1::date + 10)::text AS d', [renews]))[0]?.d as string
    const quote = await paymentDateQuote(first, m.membership, newDate)
    const { change, made } = await changeMade(stripe)
    // Held after its record: it holds the customer's row and the membership's (memberships/payment-date.ts).
    const held = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO membership_payment_date_changes'))
    const dateChange = outcomeOf(changePaymentDate(held.db, m.membership, { newRenewalDate: newDate, confirmed: { amount: quote.amount as number } }, { actor: { type: 'staff', id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe }))
    const holder = await held.holding
    const d2 = applyPriceChange(second, change, made, by())
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['customer_memberships'])
    held.release()
    await dateChange
    expect(await d2).not.toBeNull()
    expect(await stepKinds(m.membership)).toContain('price')
  })

  it("a card move (an order's T2 following the saved card: the customer, then the memberships) first: D2 waits on the membership; both steps stand", async () => {
    const stripe = new FakeStripe({ idTag: 'r4' })
    const m = await member(stripe)
    const { change, made } = await changeMade(stripe)
    const held = holdingAfter(first, (sql) => sql.startsWith('SELECT id FROM customer_memberships WHERE customer_id'))
    const move = held.db.transaction(async (tx) => {
      await lockCustomerForCardSteps(tx, m.customer)
      return followSavedCard(tx, m.customer, by())
    })
    const holder = await held.holding
    const d2 = applyPriceChange(second, change, made, by())
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['customer_memberships'])
    held.release()
    expect((await move)?.steps).toHaveLength(1)
    expect(await d2).not.toBeNull()
    expect(await stepKinds(m.membership)).toEqual(['payment_method', 'price'])
  })
})

describe('two price presses on one plan, at once', () => {
  it("the second waits on the plan's row, then is refused while the first's change is open; one change, one Stripe price", async () => {
    const stripe = new FakeStripe({ idTag: 'r5' })
    await member(stripe)
    const options = (): PlanPressOptions => ({ ...pressBy(staffId), startedAt: Date.now(), stripe: () => stripe })
    const held = holdingAfter(first, (sql) => sql.startsWith('SELECT id, name, active, stripe_product_id'))
    const one = outcomeOf(setPlanDetails(held.db, plan, { monthlyPrice: 45, membersToMove: 1 }, options()))
    const holder = await held.holding
    const two = outcomeOf(setPlanDetails(second, plan, { monthlyPrice: 50, membersToMove: 1 }, options()))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['membership_plans'])
    held.release()
    expect('answered' in (await one)).toBe(true)
    expect(await two).toEqual({ refused: 'price_change_open' })
    expect(stripe.calls.filter((call) => call.method === 'prices.create')).toHaveLength(1)
    expect((await first.query<{ p: string }>('SELECT price_monthly::text AS p FROM membership_plans WHERE id = $1', [plan]))[0]?.p).toBe('45.00')
  })
})

describe("an order's T2 against D2", () => {
  it("D2 first: T2's FOR SHARE on the plan waits, then reads the new price and leaves the new member's move", async () => {
    const stripe = new FakeStripe({ idTag: 'r6' })
    const m = await member(stripe)
    const oldPrice = (await first.query<{ p: string }>('SELECT stripe_price_id AS p FROM membership_plans WHERE id = $1', [plan]))[0]?.p as string
    const { change, made } = await changeMade(stripe)
    // D2 held after its plan write.
    const held = holdingAfter(first, D2_PLAN_WRITE)
    const d2 = applyPriceChange(held.db, change, made, by())
    const holder = await held.holding
    // T2's two statements for this membership (finalise-order.ts): the plan FOR SHARE, then (after its writes) the move.
    const t2 = second.transaction(async (tx: Tx) => {
      const [prices] = await tx.query<PlanPrices>(PLAN_PRICES_FOR_SHARE_SQL, [plan])
      return followPlanPrice(tx, { planId: plan, membershipId: m.membership, subscriptionId: m.subscription, frequency: 'monthly', madeOn: oldPrice, orderId: 'order-race' }, prices as PlanPrices, by())
    })
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['membership_plans'])
    held.release()
    await d2
    const step = await t2
    // W57a (S1): with the interval of the member's frequency.
    expect(step?.want).toEqual({ price: made.priceIds.monthly, interval: 'month' })
  })

  // W57a (W57 review L6): the other half the test above was once named for.
  it('T2 first, holding the plan FOR SHARE with the new membership being written: D2 waits on the plan, then finds the member live and leaves their move; T2 leaves none (the plan still had the price it was made on)', async () => {
    const stripe = new FakeStripe({ idTag: 'r7' })
    await member(stripe)
    const oldPrice = (await first.query<{ p: string }>('SELECT stripe_price_id AS p FROM membership_plans WHERE id = $1', [plan]))[0]?.p as string
    const { change, made } = await changeMade(stripe)
    // The new member's row as T1 leaves it (no subscription yet); T2 makes it live on the subscription made on the old price.
    const customer = await fixtures.customer(first, { stripe_customer_id: 'cus_w57_t2_first' })
    const newMembership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', subscription_status: 'active', stripe_subscription_id: null })
    stripe.addCustomer('cus_w57_t2_first')
    stripe.addSubscription('sub_w57_t2_first', 'cus_w57_t2_first', oldPrice)
    // T2 held straight after its plan FOR SHARE.
    const held = holdingAfter(first, (sql) => sql === PLAN_PRICES_FOR_SHARE_SQL)
    const t2 = held.db.transaction(async (tx: Tx) => {
      const [prices] = await tx.query<PlanPrices>(PLAN_PRICES_FOR_SHARE_SQL, [plan])
      await tx.query("UPDATE customer_memberships SET stripe_subscription_id = 'sub_w57_t2_first' WHERE id = $1", [newMembership])
      return followPlanPrice(tx, { planId: plan, membershipId: newMembership, subscriptionId: 'sub_w57_t2_first', frequency: 'monthly', madeOn: oldPrice, orderId: 'order-race-t2-first' }, prices as PlanPrices, by())
    })
    const holder = await held.holding
    const d2 = applyPriceChange(second, change, made, by())
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['membership_plans'])
    held.release()
    expect(await t2).toBeNull()
    const applied = await d2
    expect(applied?.moveSteps.find((step) => step.membershipId === newMembership)?.want).toEqual({ price: made.priceIds.monthly, interval: 'month' })
    expect(await stepKinds(newMembership)).toEqual(['price'])
  })
})

describe('the membership settings saved twice at once', () => {
  it('the second waits on the settings row, then is refused: the count it carries is no longer right; one change, one row', async () => {
    await first.query('DELETE FROM membership_settings')
    await first.query('INSERT INTO membership_settings (id, addon_credit_wait_months) VALUES (true, 60)')
    // One monthly member long enough ago to become Herd at 0 months.
    const customer = await fixtures.customer(first)
    await fixtures.membership(first, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', start_date: '2026-01-01', is_herd: false })
    const toChange = (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM customer_memberships WHERE herd_override IS NULL AND is_herd IS DISTINCT FROM coalesce((billing_frequency = 'yearly' or start_date <= (now() at time zone 'Europe/London')::date), false)"))[0]?.n as number
    expect(toChange).toBeGreaterThan(0)
    await first.query("DELETE FROM audit_log WHERE action = 'membership_settings.set'")
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE membership_settings'))
    const one = outcomeOf(setMembershipSettings(held.db, 0, toChange, pressBy(staffId)))
    const holder = await held.holding
    const two = outcomeOf(setMembershipSettings(second, 0, toChange, pressBy(staffId)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['membership_settings'])
    held.release()
    expect(await one).toEqual({ answered: { addonCreditWaitMonths: 0, herdFlagsChanged: toChange } })
    expect(await two).toEqual({ refused: 'changed_since' })
    expect((await first.query("SELECT 1 FROM audit_log WHERE action = 'membership_settings.set'")).length).toBe(1)
  })
})
