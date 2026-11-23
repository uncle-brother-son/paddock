import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DbTimeoutError, type Db, type SqlParam, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { cancelMembership, type CancelOptions } from './cancel'
import { MEMBERSHIP_CANCEL_NEW_WORDS, PAYMENT_DATE_NEW_WORDS, PAYMENT_DATE_REFUSALS } from './failure-messages'
import { changePaymentDate, finishPaymentDateChange, londonDateOfSeconds, paymentDateQuote, readPaymentDateChange, type PaymentDateOptions } from './payment-date'

// Brief W41 item 9 (F-plan 4.12 item 7; R4's form) on real Postgres 17.6, each press on its own connection: two
// payment date presses on one membership at the same instant, a press against a cancel, and a cancel against a press.
// Each race holds the first press's first transaction open, after its writes, until Postgres reports the second as
// waiting on a row the first holds, so none can pass by timing. Where the first is a payment date press, its first
// Stripe call is held too until the second has answered: its record is then still pending, as it is in production
// while Stripe is being asked (Postgres doesn't queue a new lock request behind a woken waiter).

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
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w41-race@example.com', can_issue_refunds: true })
  plan = await fixtures.plan(first, { level: 'core', sessions_included: 4, price_monthly: '40.00' })
})
afterAll(() => pg.stop())

interface Member {
  membership: string
  subscription: string
  stripeCustomer: string
  newDate: string
  amount: number
}

/** A monthly member with a saved card, on a Stripe subscription the fake holds, renewing on the day Stripe says; and a new date ten days later with its figure. */
async function member(stripe: FakeStripe): Promise<Member> {
  members += 1
  const subscription = `sub_w41_${members}`
  const stripeCustomer = `cus_w41_${members}`
  const customer = await fixtures.customer(first, { stripe_customer_id: stripeCustomer, saved_payment_method_id: `pm_w41_${members}`, saved_card_last4: '4242', saved_card_brand: 'visa' })
  const membership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', subscription_status: 'active', stripe_subscription_id: subscription })
  stripe.addCustomer(stripeCustomer)
  stripe.addPrice('price_w41', 4000, 'month')
  stripe.addSubscription(subscription, stripeCustomer, 'price_w41')
  const renews = londonDateOfSeconds(stripe.subscriptionSettings(subscription)?.periodEnd as number)
  await first.query("UPDATE customer_memberships SET start_date = (now() AT TIME ZONE 'Europe/London')::date - 200, next_renewal_date = $1::date WHERE id = $2", [renews, membership])
  const newDate = (await first.query<{ d: string }>("SELECT ($1::date + 10)::text AS d", [renews]))[0]?.d as string
  const quote = await paymentDateQuote(first, membership, newDate)
  return { membership, subscription, stripeCustomer, newDate, amount: quote.amount as number }
}

const pressOptions = (stripe: FakeStripe): PaymentDateOptions => ({ actor: { type: 'staff', id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe })
const cancelOptions = (stripe: FakeStripe): CancelOptions => ({ actor: { channel: 'staff', id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe })
const press = (db: Db, stripe: FakeStripe, m: Member) => changePaymentDate(db, m.membership, { newRenewalDate: m.newDate, confirmed: { amount: m.amount } }, pressOptions(stripe))

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

/** The fake as a press reaches it, its first `subscriptions.retrieve` held until `release`: the press's record stays pending meanwhile. */
function heldAtStripe(stripe: FakeStripe): { stripe: FakeStripe; release(): void } {
  const gate = deferred()
  let held = false
  const real = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const subscriptions = {
    ...real,
    retrieve: async (...args: unknown[]) => {
      if (!held) {
        held = true
        await gate.promise
      }
      return (real['retrieve'] as (...a: unknown[]) => Promise<unknown>)(...args)
    },
  }
  return { stripe: new Proxy(stripe, { get: (target, prop) => (prop === 'subscriptions' ? subscriptions : Reflect.get(target, prop)) }), release: () => gate.resolve() }
}

/**
 * Runs `held` with its first transaction kept open, starts `waiter`, checks Postgres reports it waiting on a row of
 * `table`, lets the first commit, waits for the waiter's answer, then calls `afterWaiter` (which lets the first's
 * Stripe call go) and waits for the first.
 */
async function race<A, B>(held: (db: Db) => Promise<A>, waiter: (db: Db) => Promise<B>, table: string, afterWaiter: () => void = () => {}): Promise<{ held: Outcome<A>; waiter: Outcome<B> }> {
  const holding = heldOpen(first)
  const heldWork = outcome(held(holding.db))
  const holder = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
  let settled = false
  const waiting = outcome(waiter(second)).finally(() => {
    settled = true
  })
  const blocked = await blockedBy(holder)
  expect(settled).toBe(false)
  expect(await waitingOn(pg, blocked)).toEqual([table])
  holding.finish()
  const waiterAnswer = await waiting
  afterWaiter()
  return { held: await heldWork, waiter: waiterAnswer }
}

const rowsOf = (membership: string) => third.query<{ status: string; order_id: string | null }>('SELECT status, order_id FROM membership_payment_date_changes WHERE membership_id = $1 ORDER BY created_at, id', [membership])
const facts = async (membership: string) => (await third.query<{ renews: string; ends: string | null }>('SELECT next_renewal_date::text AS renews, cancel_effective_date::text AS ends FROM customer_memberships WHERE id = $1', [membership]))[0]
const paid = async (stripe: FakeStripe, customer: string) => (await stripe.paymentIntents.list({ customer, limit: 100 })).data.filter((intent) => intent.status === 'succeeded')

describe('two payment date presses at once (R4): one record per membership, taken under the locks; one charge', () => {
  it('the second waits for the first\'s P1, then finds its pending record and is refused; the part-month charge is taken once and one order is written', async () => {
    for (let round = 0; round < 5; round += 1) {
      const stripe = new FakeStripe({ idTag: `w41a${round}` })
      const m = await member(stripe)
      const firstStripe = heldAtStripe(stripe)
      const result = await race(
        (db) => press(db, firstStripe.stripe, m),
        (db) => press(db, stripe, m),
        // The customer's row is the first lock P1 takes.
        'customers',
        () => firstStripe.release()
      )
      expect(result.waiter).toEqual({ refused: 'refused', message: PAYMENT_DATE_REFUSALS.inProgress })
      expect(result.held).toMatchObject({ answered: { newRenewalDate: m.newDate, amountCharged: m.amount } })
      expect((await rowsOf(m.membership)).map((row) => row.status)).toEqual(['done'])
      expect(await paid(stripe, m.stripeCustomer)).toHaveLength(1)
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(1)
      expect((await facts(m.membership))?.renews).toBe(m.newDate)
      expect((await third.query('SELECT 1 FROM orders o JOIN membership_payment_date_changes p ON p.order_id = o.id WHERE p.membership_id = $1', [m.membership])).length).toBe(1)
    }
  })
})

describe('a payment date press against a cancel, and a cancel against a press: never both', () => {
  it("a cancel that arrives while a press's P1 is open waits for it, then is refused with the payment-date words while the record is pending; the press goes through", async () => {
    for (let round = 0; round < 5; round += 1) {
      const stripe = new FakeStripe({ idTag: `w41b${round}` })
      const m = await member(stripe)
      const firstStripe = heldAtStripe(stripe)
      const result = await race(
        (db) => press(db, firstStripe.stripe, m),
        (db) => cancelMembership(db, m.membership, cancelOptions(stripe)),
        'customer_memberships',
        () => firstStripe.release()
      )
      expect(result.waiter).toEqual({ refused: 'payment_date_changing', message: MEMBERSHIP_CANCEL_NEW_WORDS.paymentDateChanging })
      expect(result.held).toMatchObject({ answered: { newRenewalDate: m.newDate } })
      expect(await facts(m.membership)).toEqual({ renews: m.newDate, ends: null })
      // The cancel sent nothing to Stripe.
      expect(stripe.calls.filter((call) => call.method === 'subscriptions.update').map((call) => Object.keys(call.params as object).sort())).toEqual([['id', 'proration_behavior', 'trial_end']])
      expect(stripe.subscriptionSettings(m.subscription)?.cancelAt).toBeNull()
    }
  })

  it("a press that arrives while a cancel's M1 is open waits for it, then is refused (a cancellation is scheduled): nothing is charged and no record is written", async () => {
    for (let round = 0; round < 5; round += 1) {
      const stripe = new FakeStripe({ idTag: `w41c${round}` })
      const m = await member(stripe)
      const before = (await facts(m.membership))?.renews
      const result = await race(
        (db) => cancelMembership(db, m.membership, cancelOptions(stripe)),
        (db) => press(db, stripe, m),
        // The press holds the customer's row by then and waits on the membership's, which the cancel holds.
        'customer_memberships'
      )
      expect(result.held).toMatchObject({ answered: { stripeUpdated: true } })
      expect(result.waiter).toEqual({ refused: 'refused', message: PAYMENT_DATE_REFUSALS.cancelScheduled })
      expect(await rowsOf(m.membership)).toEqual([])
      expect(await paid(stripe, m.stripeCustomer)).toEqual([])
      expect((await facts(m.membership))?.renews).toBe(before)
      expect((await facts(m.membership))?.ends).not.toBeNull()
    }
  })

  it('the control: without the locks the same two presses each write a pending record (what the old insert could do between its check and its write)', async () => {
    const stripe = new FakeStripe({ idTag: 'w41d' })
    const m = await member(stripe)
    // Two transactions that each look for a pending record and, finding none, write one, with no lock taken first.
    const look = 'SELECT 1 FROM membership_payment_date_changes WHERE membership_id = $1::uuid AND status = \'pending\''
    const write = "INSERT INTO membership_payment_date_changes (membership_id, old_renewal_date, new_renewal_date, extra_days, amount_charged, status) VALUES ($1::uuid, $2::date, $3::date, 10, 12.90, 'pending')"
    const renews = (await facts(m.membership))?.renews as string
    const gate = deferred()
    // W43 (W42b report, Noticed 1): transaction two starts only once transaction one has looked. Started together,
    // two could look, write and commit before one's look, which then found two's record and wrote none (a timing
    // failure of the control, not of the code).
    const looked = deferred()
    const one = first.transaction(async (tx) => {
      const found = await tx.query(look, [m.membership])
      looked.resolve()
      await gate.promise
      if (found.length === 0) await tx.query(write, [m.membership, renews, m.newDate])
    })
    await looked.promise
    const two = second.transaction(async (tx) => {
      const found = await tx.query(look, [m.membership])
      if (found.length === 0) await tx.query(write, [m.membership, renews, m.newDate])
    })
    await two
    gate.resolve()
    await one
    expect((await rowsOf(m.membership)).map((row) => row.status)).toEqual(['pending', 'pending'])
  })
})

// Brief W70c item 4 (W70b "Noticed" 4): P2 (finishPaymentDateChange) is run once more after a deadlock, as a plan price
// change's D2 is (catalog/plans-postgres.test.ts). By then the card is charged and the date moved in Stripe, so without it
// the press was held for reconcile.
describe('W70c: P2 after a deadlock', () => {
  /** A client that counts its transactions; `refuse` is asked about each that has written P2's order, before its commit. */
  function counting(db: Db, refuse: () => Error | null = () => null): { db: Db; opened(): number; p2s(): number } {
    let transactions = 0
    let p2s = 0
    const counted = new Proxy(db, {
      get(inner, property, receiver) {
        if (property !== 'transaction') return Reflect.get(inner, property, receiver) as unknown
        return <R>(fn: (tx: Tx) => Promise<R>) => {
          transactions += 1
          let wroteOrder = false
          return inner.transaction(async (tx) => {
            const watched = new Proxy(tx, {
              get(own, name, self) {
                if (name !== 'query') return Reflect.get(own, name, self) as unknown
                return (sql: string, params?: readonly SqlParam[]) => {
                  if (sql.trim().startsWith('INSERT INTO orders')) {
                    wroteOrder = true
                    p2s += 1
                  }
                  return own.query(sql, params)
                }
              },
            })
            const answer = await fn(watched)
            const refused = wroteOrder ? refuse() : null
            if (refused) throw refused
            return answer
          })
        }
      },
    })
    return { db: counted, opened: () => transactions, p2s: () => p2s }
  }
  const deadlock = () => new DbTimeoutError('The database took too long to respond.', '40P01: deadlock detected')
  const orders = async (m: Member) =>
    (await third.query<{ n: number }>('SELECT count(*)::int AS n FROM orders o JOIN order_line_items l ON l.order_id = o.id WHERE l.membership_plan_id = $1 AND o.customer_id = (SELECT customer_id FROM customer_memberships WHERE id = $2)', [plan, m.membership]))[0]?.n
  const doneRows = async (m: Member) =>
    (await third.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'membership.payment_date_changed' AND entity_id = $1 AND details->>'state' = 'done'", [m.membership]))[0]?.n
  /** The change is done once: one charge, one order with its line, the new date, one `done` row. */
  async function doneOnce(stripe: FakeStripe, m: Member): Promise<void> {
    expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(1)
    expect(await paid(stripe, m.stripeCustomer)).toHaveLength(1)
    expect((await rowsOf(m.membership)).map((row) => [row.status, row.order_id !== null])).toEqual([['done', true]])
    expect(await orders(m)).toBe(1)
    expect(await doneRows(m)).toBe(1)
    expect((await facts(m.membership))?.renews).toBe(m.newDate)
  }

  it('a real deadlock (another session holds the plan its order line names, then wants the member): Postgres ends P2, it is run once more and the press is done; charged once', async () => {
    await pg.admin.unsafe('GRANT SET ON PARAMETER deadlock_timeout TO paddock_worker')
    const stripe = new FakeStripe({ idTag: 'w70c1' })
    const m = await member(stripe)
    const counted = counting(first)
    const charged = deferred()
    const planHeld = deferred()
    const charge = stripe.paymentIntents.create
    Object.assign(stripe.paymentIntents, {
      create: async (...args: Parameters<typeof charge>) => {
        const answer = await charge(...args)
        charged.resolve()
        await planHeld.promise
        return answer
      },
    })
    const pressed = outcome(press(counted.db, stripe, m))
    await charged.promise
    await second.transaction(async (tx) => {
      // This session waits far longer before it looks for a deadlock, so P2 is the one Postgres ends.
      await tx.query("SET LOCAL deadlock_timeout = '10s'")
      await tx.query('SELECT id FROM membership_plans WHERE id = $1::uuid FOR UPDATE', [plan])
      const holder = Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid)
      planHeld.resolve()
      // P2 holds the member, and waits for the plan to write its order line.
      await blockedBy(holder)
      await tx.query('SELECT id FROM customer_memberships WHERE id = $1::uuid FOR UPDATE', [m.membership])
    })
    expect(await pressed).toMatchObject({ answered: { newRenewalDate: m.newDate, amountCharged: m.amount } })
    // P1, P2 ended as the deadlock, and P2 again.
    expect([counted.opened(), counted.p2s()]).toEqual([3, 2])
    await doneOnce(stripe, m)
  })

  it('a second deadlock: the press is held with nothing of P2 written, and finished later with no second charge', async () => {
    const stripe = new FakeStripe({ idTag: 'w70c2' })
    const m = await member(stripe)
    const before = (await facts(m.membership))?.renews
    const twice = counting(first, deadlock)
    expect(await outcome(press(twice.db, stripe, m))).toEqual({ refused: 'finalise_failed', message: PAYMENT_DATE_NEW_WORDS.paidNotFinished })
    expect(twice.p2s()).toBe(2)
    expect((await rowsOf(m.membership)).map((row) => [row.status, row.order_id])).toEqual([['pending', null]])
    expect([await orders(m), await doneRows(m), (await facts(m.membership))?.renews]).toEqual([0, 0, before])

    // Finished later (as reconcile does): one deadlock, then done.
    const change = await heldChange(m)
    let left = 1
    const once = counting(first, () => (left-- > 0 ? deadlock() : null))
    expect(await finishPaymentDateChange(once.db, change, change.paymentIntentId as string, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID() }, 'reconcile')).toMatchObject({ finished: true, already: false })
    expect([once.opened(), once.p2s()]).toEqual([2, 2])
    await doneOnce(stripe, m)
  })

  it('anything but a deadlock is not run again, nor is a deadlock inside a transaction that belongs to the caller', async () => {
    const stripe = new FakeStripe({ idTag: 'w70c3' })
    const m = await member(stripe)
    const cancelled = counting(first, () => new DbTimeoutError('The database took too long to respond.', '57014: canceling statement due to statement timeout'))
    expect(await outcome(press(cancelled.db, stripe, m))).toMatchObject({ refused: 'finalise_failed' })
    expect(cancelled.p2s()).toBe(1)

    const change = await heldChange(m)
    const by = { actor: { type: 'system' as const, id: null }, requestId: crypto.randomUUID() }
    // Joined to the caller's transaction: the deadlock has ended that one, so there is nothing left to run again in.
    let joined = 0
    const own = second.transaction.bind(second)
    const inCallers = second.transaction(async () => {
      Object.assign(second, {
        transaction: () => {
          joined += 1
          return Promise.reject(deadlock())
        },
      })
      try {
        return await finishPaymentDateChange(second, change, change.paymentIntentId as string, by, 'reconcile')
      } finally {
        Object.assign(second, { transaction: own })
      }
    })
    await expect(inCallers).rejects.toThrow('took too long')
    expect(joined).toBe(1)
    expect((await rowsOf(m.membership)).map((row) => row.status)).toEqual(['pending'])
  })

  /** The member's pending change, with its record and its payment, as reconcile reads it. */
  async function heldChange(m: Member): Promise<Parameters<typeof finishPaymentDateChange>[1]> {
    const id = (await third.query<{ id: string }>("SELECT id FROM membership_payment_date_changes WHERE membership_id = $1 AND status = 'pending'", [m.membership]))[0]?.id as string
    const change = await readPaymentDateChange(third, id)
    if (!change?.started || !change.paymentIntentId) throw new Error('The change has no record or no payment.')
    return { ...change, started: change.started }
  }
})
