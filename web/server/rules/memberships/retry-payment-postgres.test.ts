import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { PAYMENT_RETRY_REFUSALS } from './failure-messages'
import { INVOICE_PAID_AFTER_END_ACTION, listPaidAfterEnd } from './paid-after-end'
import { PAYMENT_RETRY_ACTION, retryPayment, retryPaymentQuote, type RetryPaymentOptions } from './retry-payment'

// Brief W47r ("Two presses at once: one charge"; W41's form) on real Postgres 17.6, each press on its own connection:
// two presses of "Try the payment again now" on one past-due membership at the same instant. The first press's first
// transaction (P1: the locks, the checks, the `started` row) is held open after its writes until Postgres reports the
// second as waiting on a row the first holds, so the race can't pass by timing. The first's send is held too until
// the second has answered: its record is then still open, as it is in production while Stripe is being asked
// (Postgres doesn't queue a new lock request behind a woken waiter).

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let staffId: string
let plan: string
let members = 0

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w47r-race@example.com', can_issue_refunds: true })
  plan = await fixtures.plan(first, { level: 'core', sessions_included: 4, price_monthly: '40.00' })
})
afterAll(() => pg.stop())

interface Member {
  membership: string
  subscription: string
  invoice: string
  paymentIntent: string
  /** The customer's saved card: what the window names and the press sends back (W47r-a). */
  card: string
}

/** A past-due monthly member with a saved card, on a subscription the fake holds whose renewal has just failed: £40 open on its newest invoice. */
async function pastDueMember(stripe: FakeStripe): Promise<Member> {
  members += 1
  const subscription = `sub_w47r_${members}`
  const stripeCustomer = `cus_w47r_${members}`
  const card = `pm_w47r_${members}`
  const customer = await fixtures.customer(first, { stripe_customer_id: stripeCustomer, saved_payment_method_id: card, saved_card_last4: '4242', saved_card_brand: 'visa' })
  const membership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', subscription_status: 'past_due', stripe_subscription_id: subscription })
  stripe.addCustomer(stripeCustomer)
  stripe.addPrice('price_w47r', 4000, 'month')
  stripe.addSubscription(subscription, stripeCustomer, 'price_w47r')
  await stripe.subscriptions.update(subscription, { default_payment_method: card })
  stripe.startRenewal(subscription)
  const failed = stripe.renewalFails(subscription)
  return { membership, subscription, card, ...failed }
}

const options = (stripe: FakeStripe): RetryPaymentOptions => ({ actor: { type: 'staff', id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe })
// W47r-a (S3): what the window showed includes the card.
const press = (db: Db, stripe: FakeStripe, m: Member) => retryPayment(db, m.membership, { confirmed: { invoiceId: m.invoice, amount: 40, paymentMethodId: m.card } }, options(stripe))

type Outcome<T> = { answered: T } | { refused: string; message: string }
async function outcome<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { answered: await work }
  } catch (err) {
    if (err instanceof ApiError) return { refused: String((err.details as { reason?: unknown } | undefined)?.reason ?? err.code), message: err.message }
    throw err
  }
}

/** `db`, with its first transaction held open after its work is done (every write made, nothing committed) until `finish`. */
function heldOpen(db: Db): { db: Db; pid: Promise<number>; finish(): void } {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    announce = resolve
  })
  let count = 0
  const held = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
      return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
        count += 1
        if (count > 1) return target.transaction(work)
        return target.transaction(async (tx) => {
          const result = await work(tx)
          announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
          await release.promise
          return result
        })
      }
    },
  })
  return { db: held, pid, finish: () => release.resolve() }
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

/** The fake as a press reaches it, its `invoices.pay` held until `release`: the press's record stays open meanwhile. */
function heldAtThePay(stripe: FakeStripe): { stripe: FakeStripe; release(): void } {
  const gate = deferred()
  const invoices = {
    ...stripe.invoices,
    pay: async (...args: Parameters<FakeStripe['invoices']['pay']>) => {
      await gate.promise
      return stripe.invoices.pay(...args)
    },
  }
  return { stripe: new Proxy(stripe, { get: (target, prop) => (prop === 'invoices' ? invoices : Reflect.get(target, prop)) }), release: () => gate.resolve() }
}

const states = async (membership: string) =>
  (await third.query<{ state: string }>(`SELECT details->>'state' AS state FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY at, ctid`, [PAYMENT_RETRY_ACTION, membership])).map((row) => row.state)
const status = async (membership: string) => (await third.query<{ status: string }>('SELECT subscription_status AS status FROM customer_memberships WHERE id = $1', [membership]))[0]?.status

describe('two presses of "Try the payment again now" at once: one record, one send, one charge', () => {
  it("the second waits for the first's P1 on the customer's row, then finds its open record and is refused; the invoice is paid once", async () => {
    for (let round = 0; round < 5; round += 1) {
      const stripe = new FakeStripe({ idTag: `w47r${round}` })
      const m = await pastDueMember(stripe)
      const firstStripe = heldAtThePay(stripe)
      const holding = heldOpen(first)
      const heldWork = outcome(press(holding.db, firstStripe.stripe, m))
      const holder = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
      let settled = false
      const waiting = outcome(press(second, stripe, m)).finally(() => {
        settled = true
      })
      const blocked = await blockedBy(holder)
      expect(settled).toBe(false)
      // The customer's row is the first lock P1 takes.
      expect(await waitingOn(pg, blocked)).toEqual(['customers'])
      holding.finish()
      // The second, now through the locks, finds the first's `started` row: refused, with nothing sent.
      expect(await waiting).toEqual({ refused: 'retry_held', message: PAYMENT_RETRY_REFUSALS.retryHeld })
      expect(stripe.calls.filter((call) => call.method === 'invoices.pay')).toHaveLength(0)
      // And the window, asked then, says the same.
      expect(await retryPaymentQuote(third, m.membership, options(stripe))).toMatchObject({ refusal: PAYMENT_RETRY_REFUSALS.retryHeld, reason: 'retry_held' })
      firstStripe.release()
      expect(await heldWork).toMatchObject({ answered: { amountCharged: 40, alreadyPaid: false, membershipUpdated: true, subscriptionStatus: 'active' } })
      expect(await states(m.membership)).toEqual(['started', 'paid'])
      expect(stripe.calls.filter((call) => call.method === 'invoices.pay')).toHaveLength(1)
      expect([...stripe.chargedByIntent]).toEqual([[m.paymentIntent, 4000]])
      expect(stripe.netPence).toBe(4000)
      expect(await status(m.membership)).toBe('active')
    }
  })

  it("two presses one after the other: the second is refused from the membership's own row, which is active again; nothing is taken twice", async () => {
    const stripe = new FakeStripe({ idTag: 'w47rc' })
    const m = await pastDueMember(stripe)
    expect(await outcome(press(first, stripe, m))).toMatchObject({ answered: { amountCharged: 40 } })
    // The membership is active now, so its own row refuses a second press before Stripe is read.
    expect(await outcome(press(second, stripe, m))).toEqual({ refused: 'not_past_due', message: PAYMENT_RETRY_REFUSALS.notPastDue })
    expect(stripe.netPence).toBe(4000)
  })
})

// Brief W47r-b: an invoice paid after its subscription had ended is listed once. Stripe can deliver two notices for
// one invoice at the same moment (and a press can find it as a notice does), each on its own connection. The first's
// transaction is held open after its row is written until Postgres reports the second as waiting on the membership's
// row, so the race can't pass by timing: the second then finds the first's row and writes nothing.
describe('W47r-b: two listings of one invoice at once write one line', () => {
  it("the second waits on the membership's row for the first, then finds the invoice listed", async () => {
    for (let round = 0; round < 5; round += 1) {
      const stripe = new FakeStripe({ idTag: `w47rb${round}` })
      const m = await pastDueMember(stripe)
      const found = { subscriptionId: m.subscription, invoiceId: m.invoice, status: 'canceled', amountPaid: 4000, paidAt: 1_797_000_005, endedAt: 1_797_000_000, livemode: false }
      const by = (requestId: string) => ({ actor: { type: 'system' as const, id: null }, requestId })
      const holding = heldOpen(first)
      const heldWork = listPaidAfterEnd(holding.db, by(`evt_first_${round}`), 'webhook')(found)
      const holder = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
      let settled = false
      const waiting = listPaidAfterEnd(second, by(`evt_second_${round}`), 'retry')(found).finally(() => {
        settled = true
      })
      const blocked = await blockedBy(holder)
      expect(settled).toBe(false)
      expect(await waitingOn(pg, blocked)).toEqual(['customer_memberships'])
      holding.finish()
      expect(await heldWork).toMatchObject({ listed: true, why: 'listed' })
      expect(await waiting).toEqual({ listed: false, why: 'already_listed' })
      const rows = await third.query<{ request_id: string; state: string }>(`SELECT request_id, details->>'state' AS state FROM audit_log WHERE action = $1 AND entity_id = $2`, [INVOICE_PAID_AFTER_END_ACTION, m.invoice])
      expect(rows).toEqual([{ request_id: `evt_first_${round}`, state: 'listed' }])
    }
  })

  // Brief W47r-c: the same line for a renewal taken on a live subscription whose row has ended here. The last day is
  // read after the lock, so the second still waits on the membership's row, and then finds the first's line.
  it("W47r-c: two listings at once of a renewal taken for a row ended here write one line, with its last day; a payment before the last day writes none", async () => {
    for (let round = 0; round < 3; round += 1) {
      const stripe = new FakeStripe({ idTag: `w47rc${round}` })
      const m = await pastDueMember(stripe)
      await third.query("UPDATE customer_memberships SET subscription_status = 'cancelled', cancel_effective_date = '2026-12-09' WHERE stripe_subscription_id = $1", [m.subscription])
      // 10 December 2026, 14:00: the day after the row's last day.
      const paidAt = Date.UTC(2026, 11, 10, 14) / 1000
      const found = { subscriptionId: m.subscription, invoiceId: m.invoice, status: 'active', amountPaid: 4000, paidAt, endedAt: null, livemode: false, cancelledHere: true as const }
      const by = (requestId: string) => ({ actor: { type: 'system' as const, id: null }, requestId })
      // Paid on 8 December, before the last day: owed. Nothing is written, so nothing is there for the two below to find.
      expect(await listPaidAfterEnd(third, by(`evt_before_${round}`), 'webhook')({ ...found, paidAt: Date.UTC(2026, 11, 8, 14) / 1000 })).toEqual({ listed: false, why: 'paid_before_last_day', last_day: '2026-12-09' })
      const holding = heldOpen(first)
      const heldWork = listPaidAfterEnd(holding.db, by(`evt_first_${round}`), 'webhook')(found)
      const holder = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
      let settled = false
      const waiting = listPaidAfterEnd(second, by(`evt_second_${round}`), 'retry')(found).finally(() => {
        settled = true
      })
      const blocked = await blockedBy(holder)
      expect(settled).toBe(false)
      expect(await waitingOn(pg, blocked)).toEqual(['customer_memberships'])
      holding.finish()
      expect(await heldWork).toMatchObject({ listed: true, why: 'listed', last_day: '2026-12-09' })
      expect(await waiting).toEqual({ listed: false, why: 'already_listed' })
      const rows = await third.query<{ request_id: string; state: string; last_day: string | null }>(
        `SELECT request_id, details->>'state' AS state, details->>'lastDay' AS last_day FROM audit_log WHERE action = $1 AND entity_id = $2`,
        [INVOICE_PAID_AFTER_END_ACTION, m.invoice]
      )
      expect(rows).toEqual([{ request_id: `evt_first_${round}`, state: 'listed', last_day: '2026-12-09' }])
    }
  })
})
