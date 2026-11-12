import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PlaceOrderInput } from '@/contracts'
import { POST as guestsRoute } from '@/app/api/v1/staff/bookings/[bookingId]/guests/route'
import { ApiError } from '@/server/http/errors'
import type { Db, Tx } from '@/server/db'
import { refusalDetails } from '@/server/rules/orders/order-refusal'
import { placeOrder } from '@/server/rules/orders/place-order'
import { finaliseFlowInTransaction, readFlow } from '@/server/rules/orders/reader-flow'
import { reconcile } from '@/server/rules/orders/reconcile'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { addGuestToBooking, type AddGuestOptions } from './add-guest'
import { chargeCardFlow } from './flow'

// Brief W20 on real Postgres 17.6, each Worker client on its own connection: two free private guests at once (the
// party size is part of the locked booking, so the second is priced at the new headcount), Add Guest's add-on credit
// racing an order's (both ways round), two presses with one key (one guest), and the press's C2 racing reconcile's on
// an Add Guest card flow. Each race holds one side open until Postgres reports the other waiting on it, so none can
// pass by timing.

// The route's database for the two-presses race: each request takes the next connection.
const holder = vi.hoisted(() => ({ dbs: [] as unknown[] }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.dbs.shift() as Db,
  closeRequestDb: () => {},
}))

let pg: RealPostgres
let first: Db
let second: Db
let third: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
})
afterAll(() => pg.stop())

let publicType: string
let privateType: string
let band: string
let plan: string
let towel: string
let staffId: string
const STAFF_EMAIL = 'w20-race@example.com'
beforeAll(async () => {
  publicType = await fixtures.serviceType(first)
  privateType = await fixtures.serviceType(first, { name: 'Private Sauna', booking_type: 'private' })
  band = await fixtures.band(first, { price: '20.00' })
  plan = await fixtures.plan(first, { level: 'core', sessions_included: 1 })
  await insert(first, 'membership_band_terms', { membership_level: 'core', band_id: band, credit_eligible: true })
  towel = await insert(first, 'addons', { name: 'Towel', sku: `TOWEL_${crypto.randomUUID().slice(0, 6)}`, base_price: '5.00' })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: STAFF_EMAIL, can_manage_pricing: false })
  // Private prices at the band: £100 for up to three, £150 for four or more.
  await insert(first, 'service_type_price_tiers', { service_type_id: privateType, band_id: band, min_people: 1, max_people: 3, price: '100.00' })
  await insert(first, 'service_type_price_tiers', { service_type_id: privateType, band_id: band, min_people: 4, max_people: 10, price: '150.00' })
})

let day = 0
/** A session on its own day in 2032, so nothing in one test touches another's. */
function nextSlot(): { start_time: string; end_time: string } {
  day += 1
  const start = new Date(Date.UTC(2032, 0, day, 10))
  return { start_time: start.toISOString(), end_time: new Date(start.getTime() + 3_600_000).toISOString() }
}

const options = (stripe?: FakeStripe): AddGuestOptions => ({
  actor: { type: 'staff', id: staffId },
  requestId: 'w20-race',
  canManagePricing: false,
  switchValue: 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows',
  ...(stripe ? { stripe: () => stripe } : {}),
})

/** A booking of `people` paid for (a private one claims the whole session), with its guests. */
async function booked(kind: 'public' | 'private', people: number, customer?: { id: string }): Promise<{ bookingId: string; customerId: string; sessionId: string }> {
  const customerId = customer?.id ?? (await fixtures.customer(first))
  const slot = nextSlot()
  const sessionId = await fixtures.session(first, {
    service_type_id: kind === 'public' ? publicType : privateType,
    type: kind,
    band_id: band,
    capacity: 10,
    total_booked: kind === 'private' ? 10 : people,
    ...slot,
  })
  const bookingId = await fixtures.booking(first, {
    session_id: sessionId,
    customer_id: customerId,
    price_paid: kind === 'private' ? '100' : String(20 * people),
    party_size: people,
    band_id: band,
    redemption_source: 'paid',
    ...slot,
  })
  for (let i = 0; i < people; i += 1) {
    await insert(first, 'booking_guests', {
      booking_id: bookingId,
      guest_type: i === 0 ? 'account_holder' : 'additional_guest',
      guest_name: `Guest ${i + 1}`,
      unit_price: kind === 'private' ? null : '20',
      pay_by: kind === 'private' ? null : 'paid',
    })
  }
  return { bookingId, customerId, sessionId }
}

async function blockedBy(holderPid: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holderPid])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/** The sessions queued behind `holderPid`, once `count` of them are (directly, or behind one already queued). */
async function allBlockedBy(holderPid: number, count: number): Promise<number[]> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>(
      `WITH RECURSIVE queued(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
       ) SELECT pid FROM queued`,
      [holderPid]
    )
    if (rows.length >= count) return rows.map((row) => row.pid)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Fewer than ${count} waited on the holder.`)
}

/** `work` inside a transaction on `db`, held open after it until finished. */
async function holding<T>(db: Db, work: (tx: Tx) => Promise<T>) {
  const release = deferred()
  let announce: (value: { pid: number; result: T }) => void = () => {}
  const ready = new Promise<{ pid: number; result: T }>((resolve) => {
    announce = resolve
  })
  const done = db
    .transaction(async (tx) => {
      const result = await work(tx)
      announce({ pid: (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number, result })
      await release.promise
    })
    .catch((err: unknown) => {
      if (!(err instanceof Refused)) throw err
    })
  const { pid, result } = await Promise.race([ready, done.then(() => Promise.reject(new Error('The holder ended early.')))])
  return {
    pid,
    result,
    async finish() {
      release.resolve()
      await done
    },
  }
}

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ answered: value }),
    (err: unknown) => ({ refused: err instanceof ApiError ? ((err.details as { reason?: string } | undefined)?.reason ?? err.code) : (refusalDetails(err)?.reason ?? String(err)) })
  )
const bookingRow = async (bookingId: string) =>
  (await first.query<{ party_size: number; price_paid: string }>('SELECT party_size, price_paid::text AS price_paid FROM bookings WHERE id = $1', [bookingId]))[0]
const guestCount = async (bookingId: string) => (await first.query<{ n: number }>('SELECT count(*)::int AS n FROM booking_guests WHERE booking_id = $1', [bookingId]))[0]?.n
const credits = async (membershipId: string) => (await first.query<{ n: number }>('SELECT addon_credits_remaining AS n FROM customer_memberships WHERE id = $1', [membershipId]))[0]?.n
const bea = { guestName: 'Bea Guest', guestsOver18Confirmed: true }

describe('two free private guests at once (the old statement guarded the party size)', () => {
  it('both wait on the booking; the first is added free (three people), the second is priced at four (the £50 tier difference) and added nothing', async () => {
    const { bookingId } = await booked('private', 2)
    const gate = await holding(third, (tx) => tx.query('SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE', [bookingId]))
    const a = outcome(addGuestToBooking(first, bookingId, bea, options()))
    const b = outcome(addGuestToBooking(second, bookingId, { ...bea, guestName: 'Cy Guest' }, options()))
    const waiters = await allBlockedBy(gate.pid, 2)
    for (const waiter of waiters) expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    await gate.finish()
    const answers = (await Promise.all([a, b])) as Array<{ answered?: { added: boolean; priceImpact?: { amountDue: number } } }>
    expect(answers.filter((answer) => answer.answered?.added === true)).toHaveLength(1)
    expect(answers.map((answer) => answer.answered?.priceImpact).filter(Boolean)).toEqual([{ amountDue: 50, guestAmount: 50, addonsAmount: 0, creditAvailable: false }])
    expect(await bookingRow(bookingId)).toEqual({ party_size: 3, price_paid: '100.00' })
    expect(await guestCount(bookingId)).toBe(3)
  })
})

describe("Add Guest's add-on credit racing an order's (D-plan 4.11 item 5)", () => {
  /** A Herd member with one add-on credit, a booking of theirs, and a public session for a New Order of theirs. */
  async function memberWithOneCredit() {
    const customerId = await fixtures.customer(first)
    const membershipId = await fixtures.membership(first, { customer_id: customerId, plan_id: plan, is_herd: true, addon_credits_remaining: 1 })
    const { bookingId } = await booked('public', 1, { id: customerId })
    const slot = nextSlot()
    const orderSession = await fixtures.session(first, { service_type_id: publicType, band_id: band, capacity: 10, ...slot })
    const order: PlaceOrderInput = {
      customerId,
      booking: {
        sessionId: orderSession,
        guests: [{ name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01' }],
        redemptionSource: 'paid',
        addons: [{ addonId: towel, quantity: 1, redemptionSource: 'membership_credit', membershipId }],
      },
      payment: { method: 'cash' },
      confirmed: { toCollect: 20 },
    }
    const credit = { addons: [{ addonId: towel, quantity: 1, redemptionSource: 'membership_credit', membershipId }] }
    return { customerId, membershipId, bookingId, order, credit }
  }
  const orderOptions = { actor: { type: 'staff' as const, id: 'w20-race' }, requestId: 'w20-race' }

  it("the order holds it: Add Guest waits on the customer, then finds no credit left and adds nothing", async () => {
    const { membershipId, bookingId, order, credit } = await memberWithOneCredit()
    const placed = await holding(first, () => placeOrder(first, order, orderOptions))
    const add = outcome(addGuestToBooking(second, bookingId, credit, options()))
    const waiter = await blockedBy(placed.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['customers'])
    await placed.finish()
    expect(await add).toEqual({ refused: 'insufficient_addon_membership_credit' })
    expect(await credits(membershipId)).toBe(0)
    expect((await first.query<{ n: number }>('SELECT count(*)::int AS n FROM addon_order_lines WHERE booking_id = $1', [bookingId]))[0]?.n).toBe(0)
  })

  it("Add Guest holds it: the order waits on the customer, then finds no credit left and is refused", async () => {
    const { membershipId, bookingId, order, credit } = await memberWithOneCredit()
    const added = await holding(first, () => addGuestToBooking(first, bookingId, credit, options()))
    expect(added.result).toMatchObject({ added: true })
    const placing = outcome(placeOrder(second, order, orderOptions))
    const waiter = await blockedBy(added.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['customers'])
    await added.finish()
    expect(await placing).toEqual({ refused: 'insufficient_addon_membership_credit' })
    expect(await credits(membershipId)).toBe(0)
  })
})

describe('two presses of one Add Guest, the same key (the dialog keeps it after no answer)', () => {
  it('the second finds the first still running (CONFLICT, which the staff app reads as no answer); one guest, one place, one order', async () => {
    process.env.STAFF_API_KEY = 'w20-race-key'
    const before = process.env.ORDER_SWITCH
    process.env.ORDER_SWITCH = 'booking_changes'
    try {
      const { bookingId, sessionId } = await booked('public', 2)
      const key = crypto.randomUUID()
      const press = (db: Db) => {
        holder.dbs.push(db)
        return guestsRoute(
          new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/guests`, {
            method: 'POST',
            headers: { authorization: 'Bearer w20-race-key', 'x-staff-email': STAFF_EMAIL, 'idempotency-key': key, 'content-type': 'application/json' },
            body: JSON.stringify({ ...bea, payment: { method: 'cash', confirmedCashAmount: 20 }, figures: { amountDue: 20, toCollect: 20 } }),
          }),
          { params: Promise.resolve({ bookingId }) }
        )
      }
      const gate = await holding(third, (tx) => tx.query('SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE', [bookingId]))
      const one = press(first)
      await blockedBy(gate.pid)
      const two = await press(second)
      expect(two.status).toBe(409)
      expect(((await two.json()) as { error: { code: string } }).error.code).toBe('CONFLICT')
      await gate.finish()
      expect((await one).status).toBe(200)
      expect(await guestCount(bookingId)).toBe(3)
      expect((await first.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [sessionId]))[0]?.n).toBe(3)
      // A third press with the key after the first finished gets its stored answer: still one guest.
      expect((await press(second)).status).toBe(200)
      expect(await guestCount(bookingId)).toBe(3)
    } finally {
      if (before === undefined) delete process.env.ORDER_SWITCH
      else process.env.ORDER_SWITCH = before
    }
  })
})

describe("the press's C2 racing reconcile's on an Add Guest card flow", () => {
  it("the press's C2 holds the record; reconcile's waits on it, then finds it finalised: one order, no charge from reconcile", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const stripeCustomer = `cus_${crypto.randomUUID().slice(0, 8)}`
    stripe.addCustomer(stripeCustomer)
    const customerId = await fixtures.customer(first, { stripe_customer_id: stripeCustomer, saved_payment_method_id: 'pm_saved' })
    const { bookingId } = await booked('public', 1, { id: customerId })
    // C1 committed and the press got no clear answer (held); the record is past the window.
    stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
    stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
    const body = { ...bea, payment: { method: 'card' }, figures: { amountDue: 20, toCollect: 20 } }
    expect(await outcome(addGuestToBooking(first, bookingId, body, options(stripe)))).toEqual({ refused: 'payment_unconfirmed' })
    const pendingId = (await first.query<{ id: string }>("SELECT id FROM pending_reader_payments WHERE record_id = $1 AND status = 'pending'", [bookingId]))[0]?.id as string
    await first.query("UPDATE pending_reader_payments SET created_at = created_at - interval '20 minutes' WHERE id = $1", [pendingId])
    const charge = await chargeCardFlow(stripe, (await readFlow(first, pendingId)) as Parameters<typeof chargeCardFlow>[1])
    if (charge.outcome !== 'answered') throw new Error('not charged')
    const press = await holding(first, () => finaliseFlowInTransaction(first, pendingId, charge.paymentIntent, { actor: { type: 'staff', id: staffId }, requestId: 'w20-press' }))
    expect(press.result).toMatchObject({ finalised: true, alreadyFinalised: false })
    const sent = stripe.calls.length
    const run = reconcile(second, stripe, { actor: { type: 'system', id: null }, requestId: 'w20-reconcile', maxItems: 50, budgetMs: 120_000 })
    const waiter = await blockedBy(press.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['pending_reader_payments'])
    await press.finish()
    const result = await run
    expect(result.items.find((item) => item.id === pendingId)).toMatchObject({ outcome: 'settled_elsewhere', detail: 'finalised' })
    expect(stripe.calls.slice(sent).map((call) => call.method)).toEqual(['paymentIntents.list'])
    expect((await first.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE customer_id = $1 AND payment_method = 'card'", [customerId]))[0]?.n).toBe(1)
    expect(await guestCount(bookingId)).toBe(2)
  })
})
