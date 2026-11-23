import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { openSteps, STEP_LEFT_ACTION } from '@/server/rules/memberships/left'
import { placeOrder } from '@/server/rules/orders/place-order'
import { reconcile } from '@/server/rules/orders/reconcile'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { replaceCustomerCard } from './saved-card'

// Brief W42a item 1 (W42 review S1; F-plan 4.12 item 7) on real Postgres 17.6, each press on its own connection: a
// saved-card membership order and a replace of the same customer's card at the same moment, both ways round. The
// order's T1 has read the old card and its subscription is made on it. What must hold: the order's T2 and the
// replace's K1 take turns on the customer's row, so either K1 finds the new membership, or T2 reads the new card; the
// new membership ends on the customer's saved card, never on the one they have just replaced with nothing listed.
// Each held race keeps one side's transaction open, after its writes, until Postgres reports the other waiting on
// the customer's row, so neither can pass by timing.

vi.setConfig({ testTimeout: 60_000 })

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let plan: string
let staffId: string

beforeAll(async () => {
  vi.stubEnv('ORDER_SWITCH', 'no_stripe,saved_card,reader,membership,card_moves')
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  plan = await fixtures.plan(first, { name: 'Core', sessions_included: 4, price_monthly: '40.00', price_yearly: '400.00', stripe_price_id: 'price_race', stripe_price_id_yearly: 'price_race_yearly' })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w42a-race@example.com' })
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await pg.stop()
})

const OLD_CARD = 'pm_old_card'
const NEW_CARD = 'pm_new_card'
const asStaff = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: crypto.randomUUID() })

/** A fake of its own, with the plan's price, and a customer with the old card on file and no membership yet. */
async function stripeAndCustomer(): Promise<{ stripe: FakeStripe; customerId: string; stripeId: string }> {
  const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
  stripe.addPrice('price_race', 4000, 'month')
  const stripeId = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeId)
  const customerId = await fixtures.customer(first, { stripe_customer_id: stripeId, saved_payment_method_id: OLD_CARD })
  return { stripe, customerId, stripeId }
}

const membershipOrder = (customerId: string): PlaceOrderInput => ({ customerId, membershipPlanId: plan, membershipBillingFrequency: 'monthly', payment: { method: 'card' }, confirmed: { toCollect: 0, firstInvoice: 40 } })

/** The customer taps the new card on the reader (a card-save, no payment), and it is saved to them. */
async function replaceCard(db: Db, stripe: FakeStripe, customerId: string, stripeId: string) {
  const intent = await stripe.setupIntents.create({ customer: stripeId, payment_method_types: ['card_present'], usage: 'off_session' })
  stripe.completeReaderSetup(intent.id, { generatedCard: NEW_CARD })
  return replaceCustomerCard(db, stripe, { customerId, setupIntentId: intent.id }, asStaff())
}

/** `db`, with one of its transactions held open after its work is done (every write made, nothing committed) until `finish`: the first for which `holds` says so. */
function heldOpen(db: Db, holds: (tx: Tx) => Promise<boolean>): { db: Db; pid: Promise<number>; finish(): void } {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    announce = resolve
  })
  let held = false
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
      return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> =>
        target.transaction(async (tx) => {
          const result = await work(tx)
          if (!held && (await holds(tx))) {
            held = true
            announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
            await release.promise
          }
          return result
        })
    },
  })
  return { db: proxy, pid, finish: () => release.resolve() }
}

async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

const savedCard = async (customerId: string) => (await third.query<{ card: string | null }>('SELECT saved_payment_method_id AS card FROM customers WHERE id = $1', [customerId]))[0]?.card ?? null
const membershipOf = async (customerId: string) => (await third.query<{ id: string; subscription: string | null }>('SELECT id::text AS id, stripe_subscription_id AS subscription FROM customer_memberships WHERE customer_id = $1', [customerId]))[0] ?? null
const stepRows = async (membershipId: string) =>
  (await third.query<{ details: { state: string; want: { paymentMethod?: string } } }>('SELECT details FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY at, ctid', [STEP_LEFT_ACTION, membershipId])).map((row) => `${row.details.state} ${row.details.want.paymentMethod ?? ''}`)
const cardSends = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.update').map((call) => (call.params as { default_payment_method?: string }).default_payment_method)
const subscriptionCard = (stripe: FakeStripe, subscription: string) => stripe.subscriptionSettings(subscription)?.defaultPaymentMethod ?? null

/** As 16 minutes later: every step row of the membership aged past the press's window (the superuser; the Worker's role can't change audit rows), then one run. */
async function aRunPastTheWindow(stripe: FakeStripe, membershipId: string): Promise<void> {
  await pg.admin.unsafe("UPDATE audit_log SET at = at - interval '16 minutes' WHERE action = $1 AND entity_id = $2", [STEP_LEFT_ACTION, membershipId])
  await reconcile(first, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
}
const openStepsOf = async (membershipId: string) => (await openSteps(third)).filter((step) => step.membershipId === membershipId)

describe('a saved-card membership order and a card replace at the same moment (W42 review S1)', () => {
  it("the replace's K1 is open (the new card written, not committed) when the order reaches T2: T2 waits on the customer's row, then reads the new card, and the new membership is moved to it", async () => {
    const { stripe, customerId, stripeId } = await stripeAndCustomer()
    // The replace starts while the order's subscription is being made (after its T1, which read the old card), and
    // its K1 is held open: it found no membership to move.
    const k1 = heldOpen(second, async () => true)
    let replacing: ReturnType<typeof replaceCard> | null = null
    const subscriptions = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const create = subscriptions['create'] as (...args: unknown[]) => Promise<unknown>
    subscriptions['create'] = async (...args: unknown[]) => {
      if (!replacing) {
        replacing = replaceCard(k1.db, stripe, customerId, stripeId)
        await k1.pid
      }
      return create.apply(stripe.subscriptions, args)
    }
    let orderSettled = false
    const ordering = placeOrder(first, membershipOrder(customerId), { ...asStaff(), stripe: () => stripe }).finally(() => {
      orderSettled = true
    })
    const holder = await k1.pid
    // The order's T2 waits for K1 on the customer's row: it wrote nothing of theirs before taking that lock.
    const blocked = await blockedBy(holder)
    expect(orderSettled).toBe(false)
    expect(await waitingOn(pg, blocked)).toEqual(['customers'])
    expect(await membershipOf(customerId)).toBeNull()
    k1.finish()
    const [order, replaced] = await Promise.all([ordering, replacing as unknown as ReturnType<typeof replaceCard>])

    // K1 found no membership; T2, after it, read the new card and left a step for it; the order's press sent it.
    expect([replaced.membershipsMoved, replaced.membershipsToMove]).toEqual([0, 0])
    expect(order.membershipId).toBeTruthy()
    const membership = await membershipOf(customerId)
    expect(membership?.id).toBe(order.membershipId)
    expect(await savedCard(customerId)).toBe(NEW_CARD)
    expect(stripe.calls.filter((call) => call.method === 'subscriptions.create').map((call) => (call.params as { default_payment_method?: string }).default_payment_method)).toEqual([OLD_CARD])
    expect(await stepRows(membership?.id as string)).toEqual([`left ${NEW_CARD}`, `done ${NEW_CARD}`])
    expect(cardSends(stripe)).toEqual([NEW_CARD])
    expect(subscriptionCard(stripe, membership?.subscription as string)).toBe(NEW_CARD)
    expect(await openStepsOf(membership?.id as string)).toEqual([])
  })

  it("the order's T2 is open (the membership written, not committed) when the replace reaches K1: K1 waits on the customer's row, then finds the new membership and moves it", async () => {
    const { stripe, customerId, stripeId } = await stripeAndCustomer()
    // T2 is the order's transaction that marks it paid: held open after all its writes.
    const t2 = heldOpen(first, async (tx) => (await tx.query('SELECT 1 FROM orders WHERE customer_id = $1::uuid AND payment_status = $2', [customerId, 'paid'])).length > 0)
    const ordering = placeOrder(t2.db, membershipOrder(customerId), { ...asStaff(), stripe: () => stripe })
    const holder = await Promise.race([t2.pid, ordering.then(() => Promise.reject(new Error('The order ended before its T2 could be held.')))])
    let replaceSettled = false
    const replacing = replaceCard(second, stripe, customerId, stripeId).finally(() => {
      replaceSettled = true
    })
    const blocked = await blockedBy(holder)
    expect(replaceSettled).toBe(false)
    expect(await waitingOn(pg, blocked)).toEqual(['customers'])
    // Nothing of the replace is written yet: the old card is still the customer's.
    expect(await savedCard(customerId)).toBe(OLD_CARD)
    t2.finish()
    const [order, replaced] = await Promise.all([ordering, replacing])

    // K1 ran after T2: it found the membership and left its step for the new card.
    expect((replaced.membershipsMoved ?? 0) + (replaced.membershipsToMove ?? 0)).toBe(1)
    const membership = await membershipOf(customerId)
    expect(membership?.id).toBe(order.membershipId)
    expect(await savedCard(customerId)).toBe(NEW_CARD)
    const rows = await stepRows(membership?.id as string)
    expect(rows.filter((row) => row === `left ${OLD_CARD}`)).toHaveLength(1)
    expect(rows).toContain(`left ${NEW_CARD}`)
    // Whichever press sent first after the commit (Postgres doesn't say), a run past the window leaves Stripe on the
    // new card with nothing open: the order's own step (for the card the subscription was made on) is replaced, and
    // if its send did land after the replace's, the replace's step was marked and is sent again here.
    await aRunPastTheWindow(stripe, membership?.id as string)
    expect(subscriptionCard(stripe, membership?.subscription as string)).toBe(NEW_CARD)
    expect(await openStepsOf(membership?.id as string)).toEqual([])
  })

  it('free-running, 12 rounds, the two started together: whichever goes first, after a run past the window the new membership renews on the customer\'s saved card and no step is open', async () => {
    const ends: string[] = []
    for (let round = 0; round < 12; round += 1) {
      const { stripe, customerId, stripeId } = await stripeAndCustomer()
      // Odd rounds start the replace a moment into the order, so both orders of T1 and K1 are met.
      const ordering = placeOrder(first, membershipOrder(customerId), { ...asStaff(), stripe: () => stripe })
      if (round % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 2))
      const [order] = await Promise.all([ordering, replaceCard(second, stripe, customerId, stripeId)])
      const membership = await membershipOf(customerId)
      expect(membership?.id).toBe(order.membershipId)
      expect(await savedCard(customerId)).toBe(NEW_CARD)
      await aRunPastTheWindow(stripe, membership?.id as string)
      ends.push(String(subscriptionCard(stripe, membership?.subscription as string)))
      expect(await openStepsOf(membership?.id as string)).toEqual([])
    }
    expect(ends).toEqual(Array.from({ length: 12 }, () => NEW_CARD))
  })
})

describe("W42b (W42a report, Noticed 1): a T2 that writes a membership takes the customer's lock first, whatever the kind", () => {
  it("card_moves off: another transaction holds the customer's row (as the payment date change does, before the membership's) when a saved-card membership order reaches T2: T2 waits on the customer's row with no membership written, then finishes as it always did, with no step", async () => {
    const { stripe, customerId } = await stripeAndCustomer()
    vi.stubEnv('ORDER_SWITCH', 'no_stripe,saved_card,reader,membership')
    try {
      // The other transaction takes the customer's lock while the order's subscription is being made (after its T1).
      const release = deferred()
      let holding: Promise<void> | null = null
      let announce: (pid: number) => void = () => {}
      const held = new Promise<number>((resolve) => {
        announce = resolve
      })
      const subscriptions = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
      const create = subscriptions['create'] as (...args: unknown[]) => Promise<unknown>
      subscriptions['create'] = async (...args: unknown[]) => {
        if (!holding) {
          holding = second.transaction(async (tx) => {
            await tx.query('SELECT id FROM customers WHERE id = $1::uuid FOR NO KEY UPDATE', [customerId])
            announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
            await release.promise
          })
          await held
        }
        return create.apply(stripe.subscriptions, args)
      }
      let orderSettled = false
      const ordering = placeOrder(first, membershipOrder(customerId), { ...asStaff(), stripe: () => stripe }).finally(() => {
        orderSettled = true
      })
      const blocked = await blockedBy(await held)
      expect(orderSettled).toBe(false)
      expect(await waitingOn(pg, blocked)).toEqual(['customers'])
      // T2 has written nothing of the customer's yet: no membership row to be locked in the other order.
      expect(await membershipOf(customerId)).toBeNull()
      release.resolve()
      const [order] = await Promise.all([ordering, holding as unknown as Promise<void>])
      // The kind is off: the order ends exactly as before W42a. The membership on the card it was made with, no step.
      const membership = await membershipOf(customerId)
      expect(membership?.id).toBe(order.membershipId)
      expect(await savedCard(customerId)).toBe(OLD_CARD)
      expect(await stepRows(membership?.id as string)).toEqual([])
      expect(cardSends(stripe)).toEqual([])
      expect(stripe.calls.filter((call) => call.method === 'customers.update')).toHaveLength(1)
    } finally {
      vi.stubEnv('ORDER_SWITCH', 'no_stripe,saved_card,reader,membership,card_moves')
    }
  })
})
