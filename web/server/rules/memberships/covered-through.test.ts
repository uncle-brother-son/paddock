import type Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dispatchStripeEvent, type DispatchResult } from '@/app/api/stripe/webhook/dispatch'
import type { Db } from '@/server/db'
import { lapseSweep } from '@/server/rules/bookings/lapse-sweep'
import { getCustomerCreditOptions } from '@/server/rules/credits/credit-options'
import { insert } from '@/server/rules/testing/database'
import { asOwner, BEFORE_030_SQL, migration030 } from '@/server/rules/testing/migration-030'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { oldSide, replay, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { orderInput, postOrder } from '@/server/rules/testing/replay/order-side'
import { ID, memberCredit, mo, MO_SUBSCRIPTION, paidSeat, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { invoiceEvent, subscriptionUpdatedEvent, webhookRpc } from '@/server/rules/testing/webhook'
import type { FakeStripe } from '@/server/stripe/fake'

// Brief W46a items 2 and 3 (W46 report "Noticed" 1 and 2; its proof, briefs/W46-logs/33-proof-allocation-before-
// payment.test.ts.txt, turned round): with migration 030 a failed renewal flags the credit bookings in the period
// that payment was for, whatever credit period the allocation has already given. Real events through the webhook's
// real handler, the database's own functions on the replay's live schema, the Worker's own order route and lapse
// sweep, and the fake Stripe. 030 is not applied to live by W46a and the saved schema is as live is, so this file
// puts 030 in from the migration file itself, and puts the two functions back as they were (migration-030.ts) where a
// test shows what 030 mends: every test here reads the same before and after the snapshot is refreshed.
//
// Mo pays £40 a month and renews on the 10th. The replay starts on 10 November 2026 with his credit period
// 10 November to 9 December. His next payment is due on 10 December.

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

const MEMBER_STRIPE_CUSTOMER = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
/** 10 December 2026, 00:00 in London: Mo's next payment. */
const RENEWS = Date.UTC(2026, 11, 10) / 1000
/** 10 January 2027: the end of the period his 10 December payment is for. */
const NEXT_END = Date.UTC(2027, 0, 10) / 1000
/** 12 December 2026 and 12 January 2027: his payment date once it is moved two days later. */
const MOVED = Date.UTC(2026, 11, 12) / 1000
const MOVED_NEXT_END = Date.UTC(2027, 0, 12) / 1000
/** The daily credit job. */
const ALLOCATION = new Date('2026-12-10T00:05:00.000Z')
/** When Stripe tries the payment, and it fails. */
const FAILURE = new Date('2026-12-10T14:00:00.000Z')
const SWEEP_ON = `${BOOKING_KINDS_ON},lapse_sweep`
const alex = { name: 'Alex Guest', email: 'alex@example.com' }

const VERSIONS = [
  ['before 030', false],
  ['with 030', true],
] as const

let environment: ReplayEnvironment
let db: Db
/** The two functions as they were before 030, or as 030 leaves them (from the migration file). */
const functions = (with030: boolean) => asOwner(environment.database.pg, with030 ? migration030() : BEFORE_030_SQL)

beforeAll(async () => {
  process.env.STAFF_API_KEY = 'test-staff-api-key'
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
  await functions(true)
})
afterAll(() => {
  replayStripe.current = null
  vi.unstubAllEnvs()
  return environment.stop()
})

/** The replay's seed with Mo's membership as live ones are: a Stripe subscription, its next payment on 10 December. */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>, with030 = true): Promise<void> {
  await functions(with030)
  try {
    await replay(
      environment,
      {
        name: 'w46a covered through',
        async seed(seedDb, stripe) {
          await seed(seedDb, stripe)
          await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
          stripe.addSubscription(MO_SUBSCRIPTION, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
        },
        async run({ stripe }) {
          replayStripe.current = stripe
          try {
            await work(stripe)
          } finally {
            replayStripe.current = null
          }
        },
      },
      oldSide
    )
  } finally {
    await functions(true)
  }
}

let sessionNumber = 0
/** A public session at `hour` o'clock (London's clock) on a day, an hour long. */
async function sessionAt(date: string, hour: number): Promise<{ session_id: string; start_time: string; end_time: string }> {
  const two = (n: number) => String(n).padStart(2, '0')
  const slot = { start_time: `${date} ${two(hour)}:00:00+00`, end_time: `${date} ${two(hour + 1)}:00:00+00` }
  const id = `10000000-0000-4000-8000-0000000a${String(++sessionNumber).padStart(4, '0')}`
  await insert(db, 'sessions', { id, service_type_id: ID.serviceType, type: 'public', capacity: 10, band_id: ID.band, ...slot })
  return { session_id: id, ...slot }
}
/** A confirmed credit booking of Mo's, written straight to the table (what the functions read). Its id. */
async function creditBooking(date: string, hour = 10, row: Record<string, unknown> = {}): Promise<string> {
  return insert(db, 'bookings', { customer_id: ID.member, party_size: 1, status: 'confirmed', price_paid: '0', redemption_source: 'membership_credit', redeemed_membership_id: ID.membership, ...(await sessionAt(date, hour)), ...row })
}
/** Mo's credit seat with Alex as a paid guest (£20 in cash), placed through the Worker's order route. Its id. */
async function creditBookingWithPaidGuest(date: string, hour: number): Promise<string> {
  const { session_id } = await sessionAt(date, hour)
  const answer = await postOrder(orderInput({ customerId: ID.member, booking: { ...paidSeat([mo, alex]), ...memberCredit, sessionId: session_id }, payment: { method: 'cash', confirmedCashAmount: 20 } }))
  if (!answer.body.ok || !answer.body.data.bookingId) throw new Error(`The order failed: ${JSON.stringify(answer.body)}`)
  return answer.body.data.bookingId
}

const handle = (stripe: FakeStripe, event: Stripe.Event): Promise<DispatchResult> => dispatchStripeEvent(event, webhookRpc(db), stripe)
// W46b (W46 review B1): each event says which invoice it is for, and the handlers hold that against the subscription's
// newest invoice. These two are for the newest invoice Stripe has when the event is made: a renewal's own.
const failedEvent = (stripe: FakeStripe, periodStart = RENEWS, periodEnd = NEXT_END) => invoiceEvent('invoice.payment_failed', MO_SUBSCRIPTION, { id: stripe.latestInvoice(MO_SUBSCRIPTION), periodStart, periodEnd })
const paidEvent = (stripe: FakeStripe, periodStart = RENEWS, periodEnd = NEXT_END) => invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: stripe.latestInvoice(MO_SUBSCRIPTION), periodStart, periodEnd, amountPaid: 4000 })
/** A renewal whose charge fails, as Stripe shows it: the period moved on with a new invoice (the draft hour), then past due. */
function renewalFails(stripe: FakeStripe, periodEnd = NEXT_END): void {
  stripe.startRenewal(MO_SUBSCRIPTION, periodEnd)
  stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
}
/** The event Stripe sends when it ends a subscription (after the last retry). The handler takes only its id. */
const endedEvent = () => ({ ...subscriptionUpdatedEvent(MO_SUBSCRIPTION, { cancelAt: null, periodEnd: NEXT_END, status: 'canceled' }), type: 'customer.subscription.deleted' }) as Stripe.Event
const allocate = async () => (await db.query<{ n: number }>('SELECT public.allocate_membership_credit_periods() AS n'))[0]?.n
/** The day's allocation, then Stripe's failed try: the order things happen in on live. */
async function allocationThenFailure(stripe: FakeStripe, periodEnd = NEXT_END): Promise<DispatchResult> {
  vi.setSystemTime(ALLOCATION)
  await allocate()
  vi.setSystemTime(FAILURE)
  renewalFails(stripe, periodEnd)
  return handle(stripe, failedEvent(stripe))
}

const membership = async () =>
  (await db.query<{ status: string; renews: string | null; last_day: string | null }>('SELECT subscription_status AS status, next_renewal_date::text AS renews, cancel_effective_date::text AS last_day FROM customer_memberships WHERE id = $1', [ID.membership]))[0]
const periods = async () =>
  (await db.query<{ p: string }>("SELECT period_start::text || ' to ' || period_end::text AS p FROM membership_credit_periods WHERE membership_id = $1 ORDER BY period_start", [ID.membership])).map((row) => row.p)
/** A booking's status and its payment deadline (London's clock; December, so UTC's too), or null. */
const booking = async (id: string) =>
  (await db.query<{ status: string; due: string | null }>("SELECT status, to_char(payment_due_by AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS due FROM bookings WHERE id = $1", [id]))[0]
const balance = async () => Number((await db.query<{ balance: string }>('SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [ID.member]))[0]?.balance)
const sweep = () => lapseSweep(db, { requestId: 'w46a-lapse-sweep', orderSwitch: SWEEP_ON })

const PAID_PERIOD = '2026-11-10 to 2026-12-09'
const UNPAID_PERIOD = '2026-12-10 to 2027-01-09'
const CONFIRMED = { status: 'confirmed', due: null }
const pastDue = (covered: string, flagged: number) => ({ outcome: 'processed', detail: { found: true, action: 'past_due', covered_through: covered, bookings_flagged: flagged } })

describe("the audit's proof turned round (W46a item 2; W46 \"Noticed\" 1): a failed renewal after the day's credit allocation has run", () => {
  it.each(VERSIONS)(
    '%s: Mo is given 10 December to 9 January at 00:05 and his £40 fails at 14:00. Before 030 he reads as covered to 9 January and his 15 December credit booking stays confirmed; with 030 he is covered through 9 December and the booking is payment needed, due in 72 hours',
    async (_name, with030) => {
      await onASeed(async (stripe) => {
        const fifteenth = await creditBooking('2026-12-15')
        expect(await periods()).toEqual([PAID_PERIOD])
        const result = await allocationThenFailure(stripe)
        expect(await periods()).toEqual([PAID_PERIOD, UNPAID_PERIOD])
        expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10', last_day: null })
        if (with030) {
          expect(result).toEqual(pastDue('2026-12-09', 1))
          expect(await booking(fifteenth)).toEqual({ status: 'payment_needed', due: '2026-12-13 14:00' })
        } else {
          expect(result).toEqual(pastDue('2027-01-09', 0))
          expect(await booking(fifteenth)).toEqual(CONFIRMED)
        }
      }, with030)
    }
  )

  it.each(VERSIONS)('%s: the failure alone, before any allocation that day (00:02): covered through 9 December and the booking flagged, the same from both', async (_name, with030) => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      vi.setSystemTime(new Date('2026-12-10T00:02:00.000Z'))
      renewalFails(stripe)
      expect(await handle(stripe, failedEvent(stripe))).toEqual(pastDue('2026-12-09', 1))
      expect(await booking(fifteenth)).toEqual({ status: 'payment_needed', due: '2026-12-13 00:02' })
      // The allocation after it gives a past-due member nothing.
      vi.setSystemTime(ALLOCATION)
      await allocate()
      expect(await periods()).toEqual([PAID_PERIOD])
    }, with030)
  })
})

describe('with 030: what follows a failed renewal (W46a item 2)', () => {
  it("a retry fails two days on, then the next goes through: the second failure flags nothing more and leaves the booking's deadline where it was; the payment puts the booking back to confirmed, moves the next payment to 10 January, and the month's credit period is there once", async () => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      expect(await allocationThenFailure(stripe)).toEqual(pastDue('2026-12-09', 1))
      vi.setSystemTime(new Date('2026-12-12T14:00:00.000Z'))
      expect(await handle(stripe, failedEvent(stripe))).toEqual(pastDue('2026-12-09', 0))
      expect(await booking(fifteenth)).toEqual({ status: 'payment_needed', due: '2026-12-13 14:00' })
      // 13 December, 09:00, before the deadline: Stripe's retry takes the £40.
      vi.setSystemTime(new Date('2026-12-13T09:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEXT_END })
      expect(await handle(stripe, paidEvent(stripe))).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'past_due', bookings_restored: 1, periods_created: 0 } })
      expect(await booking(fifteenth)).toEqual(CONFIRMED)
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10', last_day: null })
      expect(await periods()).toEqual([PAID_PERIOD, UNPAID_PERIOD])
      // The sweep then finds nothing of his to lapse.
      vi.setSystemTime(new Date('2026-12-13T14:01:00.000Z'))
      expect(await sweep()).toMatchObject({ ran: true, lapsed: 0, items: [] })
      // A month on the same again: the next payment's date moved on, so 030 reads the right one.
      const later = await creditBooking('2027-01-20')
      vi.setSystemTime(new Date('2027-01-10T00:05:00.000Z'))
      await allocate()
      vi.setSystemTime(new Date('2027-01-10T14:00:00.000Z'))
      renewalFails(stripe, Date.UTC(2027, 1, 10) / 1000)
      expect(await handle(stripe, failedEvent(stripe, NEXT_END, Date.UTC(2027, 1, 10) / 1000))).toEqual(pastDue('2027-01-09', 1))
      expect(await booking(later)).toEqual({ status: 'payment_needed', due: '2027-01-13 14:00' })
    })
  })

  it.each(VERSIONS)(
    "%s: every retry fails and Stripe ends the subscription on 31 December. Before 030 Mo's last day is written as 9 January and his bookings on 15 December and 5 January stay confirmed (the month for £0); with 030 his last day is 9 December, both bookings are payment needed since the failure, he has no credit to book with, and the allocation gives him nothing more",
    async (_name, with030) => {
      await onASeed(async (stripe) => {
        const fifteenth = await creditBooking('2026-12-15')
        const fifthOfJanuary = await creditBooking('2027-01-05')
        await allocationThenFailure(stripe)
        vi.setSystemTime(new Date('2026-12-31T09:00:00.000Z'))
        stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
        const result = await handle(stripe, endedEvent())
        if (with030) {
          expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancelled', covered_through: '2026-12-09', bookings_flagged: 0 } })
          expect(await membership()).toEqual({ status: 'cancelled', renews: '2026-12-10', last_day: '2026-12-09' })
          // Flagged at the failure on 10 December, with that day's deadline; not confirmed again by the ending.
          expect(await booking(fifteenth)).toEqual({ status: 'payment_needed', due: '2026-12-13 14:00' })
          expect(await booking(fifthOfJanuary)).toEqual({ status: 'payment_needed', due: '2026-12-13 14:00' })
        } else {
          expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancelled', covered_through: '2027-01-09', bookings_flagged: 0 } })
          expect(await membership()).toEqual({ status: 'cancelled', renews: '2026-12-10', last_day: '2027-01-09' })
          expect(await booking(fifteenth)).toEqual(CONFIRMED)
          expect(await booking(fifthOfJanuary)).toEqual(CONFIRMED)
        }
        // Either way an ended membership has no credit to book with (the read needs it active).
        const options = await getCustomerCreditOptions(db, ID.member)
        expect(options.membershipsWithSessionCredit).toEqual([])
        vi.setSystemTime(new Date('2027-01-10T00:05:00.000Z'))
        await allocate()
        // Before 030 the row reads as ended on 9 January, so nothing new on the 10th either; with 030 it ended a month before.
        expect(await periods()).toEqual([PAID_PERIOD, UNPAID_PERIOD])
      }, with030)
    }
  )

  it("Stripe ends a past-due subscription whose next payment date is still to come: the old sum, as before 030 (the newest credit period's end)", async () => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      // 20 November: past due (a stale event, say), next payment 10 December, credit period to 9 December.
      vi.setSystemTime(new Date('2026-11-20T09:00:00.000Z'))
      await db.query("UPDATE customer_memberships SET subscription_status = 'past_due' WHERE id = $1", [ID.membership])
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(await handle(stripe, endedEvent())).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancelled', covered_through: '2026-12-09', bookings_flagged: 1 } })
      expect(await membership()).toEqual({ status: 'cancelled', renews: '2026-12-10', last_day: '2026-12-09' })
      expect(await booking(fifteenth)).toEqual({ status: 'payment_needed', due: '2026-11-23 09:00' })
    })
  })
})

describe("with 030: today is London's date (W46a item 1)", () => {
  it('in summer, a payment due just after midnight in London (10 July, 00:30: still 9 July in UTC): the allocation at 00:10 gives 10 July to 9 August, the payment fails at 00:40, and Mo is covered through 9 July with his 15 July booking flagged; Stripe ending the subscription that night writes 9 July as his last day', async () => {
    await onASeed(async (stripe) => {
      // Mo's membership as it stands on 9 July 2027: paid to 9 July, the next payment due on the 10th.
      await db.query("UPDATE customer_memberships SET next_renewal_date = '2027-07-10' WHERE id = $1", [ID.membership])
      await insert(db, 'membership_credit_periods', { membership_id: ID.membership, period_start: '2027-06-10', period_end: '2027-07-09', credits_allocated: 4 })
      const fifteenth = await creditBooking('2027-07-15')
      vi.setSystemTime(new Date('2027-07-09T23:10:00.000Z'))
      await allocate()
      expect(await periods()).toEqual([PAID_PERIOD, '2027-06-10 to 2027-07-09', '2027-07-10 to 2027-08-09'])
      vi.setSystemTime(new Date('2027-07-09T23:40:00.000Z'))
      const august = Date.UTC(2027, 7, 9, 23, 30) / 1000
      renewalFails(stripe, august)
      expect(await handle(stripe, failedEvent(stripe, Date.UTC(2027, 6, 9, 23, 30) / 1000, august))).toEqual(pastDue('2027-07-09', 1))
      // The deadline is 72 hours on: 13 July, 00:40 in London (shown here on UTC's clock).
      expect(await booking(fifteenth)).toEqual({ status: 'payment_needed', due: '2027-07-12 23:40' })
      vi.setSystemTime(new Date('2027-07-09T23:50:00.000Z'))
      expect(await handle(stripe, endedEvent())).toMatchObject({ detail: { action: 'cancelled', covered_through: '2027-07-09' } })
      expect(await membership()).toEqual({ status: 'cancelled', renews: '2027-07-10', last_day: '2027-07-09' })
    })
  })
})

describe("with 030: a payment date change's no-charge days, and a yearly membership (W46a item 2)", () => {
  /** 9 December: Mo's payment date is moved from the 10th to the 12th. Stripe shows the no-charge days and sends the £0 invoice. */
  async function dateMoved(stripe: FakeStripe): Promise<void> {
    vi.setSystemTime(new Date('2026-12-09T15:00:00.000Z'))
    // The £0 invoice is the subscription's newest from the change on (W46b).
    stripe.setSubscription(MO_SUBSCRIPTION, { status: 'trialing', periodEnd: MOVED, latestInvoice: 'in_date_change_zero' })
    const zeroInvoice = invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: 'in_date_change_zero', periodStart: Date.UTC(2026, 11, 9) / 1000, periodEnd: MOVED, billingReason: 'subscription_update', amountPaid: 0 })
    expect(await handle(stripe, zeroInvoice)).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'active' } })
    expect((await membership())?.renews).toBe('2026-12-12')
  }
  /** 12 December, 09:00: the first full payment on the new date fails. */
  async function fullPaymentFails(stripe: FakeStripe): Promise<DispatchResult> {
    vi.setSystemTime(ALLOCATION)
    await allocate()
    vi.setSystemTime(new Date('2026-12-12T09:00:00.000Z'))
    renewalFails(stripe, MOVED_NEXT_END)
    return handle(stripe, failedEvent(stripe, MOVED, MOVED_NEXT_END))
  }

  it.each(VERSIONS)(
    '%s: Mo moves his payment date to the 12th (his credit periods still start on the 10th), is given 10 December to 9 January on the 10th, and the £40 fails on the 12th. Before 030 nothing is flagged, as it would be every month from then on; with 030 he is covered through 11 December, the two days the date change paid for, and his 15 December booking is flagged',
    async (_name, with030) => {
      await onASeed(async (stripe) => {
        const eleventh = await creditBooking('2026-12-11')
        const fifteenth = await creditBooking('2026-12-15')
        await dateMoved(stripe)
        const result = await fullPaymentFails(stripe)
        expect(await periods()).toEqual([PAID_PERIOD, UNPAID_PERIOD])
        // 11 December was inside the days he paid for, and is over: never touched.
        expect(await booking(eleventh)).toEqual(CONFIRMED)
        if (with030) {
          expect(result).toEqual(pastDue('2026-12-11', 1))
          expect(await booking(fifteenth)).toEqual({ status: 'payment_needed', due: '2026-12-15 09:00' })
        } else {
          expect(result).toEqual(pastDue('2027-01-09', 0))
          expect(await booking(fifteenth)).toEqual(CONFIRMED)
        }
      }, with030)
    }
  )

  it('the same, then Stripe ends the subscription: his last day is 11 December. And had the retry gone through instead, the next month is read from the new date: a failure on 12 January covers him through 11 January', async () => {
    await onASeed(async (stripe) => {
      await dateMoved(stripe)
      await fullPaymentFails(stripe)
      vi.setSystemTime(new Date('2027-01-02T09:00:00.000Z'))
      expect(await handle(stripe, endedEvent())).toMatchObject({ detail: { action: 'cancelled', covered_through: '2026-12-11' } })
      expect(await membership()).toEqual({ status: 'cancelled', renews: '2026-12-12', last_day: '2026-12-11' })
    })
    await onASeed(async (stripe) => {
      await dateMoved(stripe)
      await fullPaymentFails(stripe)
      vi.setSystemTime(new Date('2026-12-13T09:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: MOVED_NEXT_END })
      expect(await handle(stripe, paidEvent(stripe, MOVED, MOVED_NEXT_END))).toMatchObject({ detail: { action: 'reactivated', was: 'past_due' } })
      expect((await membership())?.renews).toBe('2027-01-12')
      const eleventh = await creditBooking('2027-01-11', 18)
      const twentieth = await creditBooking('2027-01-20')
      vi.setSystemTime(new Date('2027-01-10T00:05:00.000Z'))
      await allocate()
      // While the payment isn't due yet a failure can't come from Stripe. On the 12th it does.
      vi.setSystemTime(new Date('2027-01-12T09:00:00.000Z'))
      const february = Date.UTC(2027, 1, 12) / 1000
      renewalFails(stripe, february)
      expect(await handle(stripe, failedEvent(stripe, MOVED_NEXT_END, february))).toEqual(pastDue('2027-01-11', 1))
      expect(await booking(eleventh)).toEqual(CONFIRMED)
      expect(await booking(twentieth)).toEqual({ status: 'payment_needed', due: '2027-01-15 09:00' })
    })
  })

  it.each(VERSIONS)(
    '%s: a yearly membership (one payment a year, a credit period a month), its year up on 10 December: given 10 December to 9 January at 00:05, and the yearly payment fails. Before 030 nothing is flagged; with 030 covered through 9 December and the booking flagged',
    async (_name, with030) => {
      await onASeed(async (stripe) => {
        await db.query("UPDATE customer_memberships SET billing_frequency = 'yearly', start_date = '2025-12-10' WHERE id = $1", [ID.membership])
        const fifteenth = await creditBooking('2026-12-15')
        const result = await allocationThenFailure(stripe, Date.UTC(2027, 11, 10) / 1000)
        expect(await periods()).toEqual([PAID_PERIOD, UNPAID_PERIOD])
        expect(result).toEqual(with030 ? pastDue('2026-12-09', 1) : pastDue('2027-01-09', 0))
        expect((await booking(fifteenth))?.status).toBe(with030 ? 'payment_needed' : 'confirmed')
      }, with030)
    }
  )
})

describe('with 030: credit bookings on the renewal day itself, and the credit period given for the unpaid month (W46a items 2 and 3)', () => {
  it("bookings on 10 December at 10:00 and on 15 December, and one booked that morning with a credit from the new period: the 10:00 one has started by the time the payment fails and is left; the others are flagged (one later on the renewal day, due at its own start, is in the sweep's test below: a customer has one booking a day). Mo then has no credit to book with, and the Worker's order route refuses him a credit seat; the new period's row is left as it is", async () => {
    await onASeed(async (stripe) => {
      const morning = await creditBooking('2026-12-10', 10)
      const fifteenth = await creditBooking('2026-12-15')
      vi.setSystemTime(ALLOCATION)
      await allocate()
      // 08:00 on the renewal day: active, with the new period's credits, Mo books 20 December through the order route.
      vi.setSystemTime(new Date('2026-12-10T08:00:00.000Z'))
      const twentieth = await sessionAt('2026-12-20', 10)
      const creditSeat = () => postOrder(orderInput({ customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit, sessionId: twentieth.session_id }, payment: {} }))
      const placed = await creditSeat()
      if (!placed.body.ok) throw new Error(`The order failed: ${JSON.stringify(placed.body)}`)
      const fromNewPeriod = placed.body.data.bookingId as string
      const newPeriod = (await db.query<{ id: string }>("SELECT id FROM membership_credit_periods WHERE membership_id = $1 AND period_start = '2026-12-10'", [ID.membership]))[0]?.id
      expect((await db.query<{ p: string | null }>('SELECT credit_period_id AS p FROM bookings WHERE id = $1', [fromNewPeriod]))[0]?.p).toBe(newPeriod)

      vi.setSystemTime(FAILURE)
      renewalFails(stripe)
      expect(await handle(stripe, failedEvent(stripe))).toEqual(pastDue('2026-12-09', 2))
      expect(await booking(morning)).toEqual(CONFIRMED)
      expect(await booking(fifteenth)).toEqual({ status: 'payment_needed', due: '2026-12-13 14:00' })
      expect(await booking(fromNewPeriod)).toEqual({ status: 'payment_needed', due: '2026-12-13 14:00' })

      // After the failure: no credit is offered, and a credit seat is refused, whatever the new period holds.
      expect((await getCustomerCreditOptions(db, ID.member)).membershipsWithSessionCredit).toEqual([])
      const cancelled = await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING id", [fromNewPeriod])
      expect(cancelled).toHaveLength(1)
      const refused = await creditSeat()
      // The Worker reads only a membership that is active: a past-due one is refused as not found.
      expect(refused).toMatchObject({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND', details: { stage: 'booking', reason: 'membership_not_found' } } } })
      expect(await db.query("SELECT id FROM bookings WHERE session_id = $1 AND status <> 'cancelled'", [twentieth.session_id])).toEqual([])
      // The period given for the unpaid month is still there, untouched: it becomes the paid one if a retry goes through.
      expect(await periods()).toEqual([PAID_PERIOD, UNPAID_PERIOD])
      expect((await db.query<{ n: number }>('SELECT credits_allocated AS n FROM membership_credit_periods WHERE id = $1', [newPeriod]))[0]?.n).toBe(4)
    })
  })
})

describe('the lapse sweep then acts on the flagged bookings (W46a item 2; Q48)', () => {
  it.each(VERSIONS)(
    "%s: Mo's credit seat with a paid guest (£20 cash) on 10 December at 18:00 and on 15 December. Before 030 the failure flags nothing and the sweep never has anything to lapse; with 030 both are flagged, the 18:00 one lapses at its start with the £20 kept, the 15 December one lapses on 13 December at 14:00 with the £20 back as store credit, and a payment that goes through after that restores nothing",
    async (_name, with030) => {
      await onASeed(async (stripe) => {
        const evening = await creditBookingWithPaidGuest('2026-12-10', 18)
        const fifteenth = await creditBookingWithPaidGuest('2026-12-15', 10)
        expect(await balance()).toBe(0)
        const result = await allocationThenFailure(stripe)
        const calls = stripe.calls.length
        if (!with030) {
          expect(result).toEqual(pastDue('2027-01-09', 0))
          vi.setSystemTime(new Date('2026-12-13T14:01:00.000Z'))
          expect(await sweep()).toMatchObject({ ran: true, lapsed: 0, items: [] })
          expect([(await booking(evening))?.status, (await booking(fifteenth))?.status]).toEqual(['confirmed', 'confirmed'])
          return
        }
        expect(result).toEqual(pastDue('2026-12-09', 2))
        // The booking later on the renewal day is due at its own start; the other in 72 hours.
        expect(await booking(evening)).toEqual({ status: 'payment_needed', due: '2026-12-10 18:00' })
        // Five minutes after the failure nothing is due yet.
        vi.setSystemTime(new Date('2026-12-10T14:05:00.000Z'))
        expect(await sweep()).toMatchObject({ ran: true, lapsed: 0, items: [] })
        // 18:01: the evening booking's deadline was its own start. Inside 24 hours: nothing back (Q48).
        vi.setSystemTime(new Date('2026-12-10T18:01:00.000Z'))
        expect(await sweep()).toMatchObject({ ran: true, lapsed: 1, storeCreditRefunded: 0, items: [{ bookingId: evening, outcome: 'lapsed', back: false, storeCreditRefunded: 0 }] })
        expect((await booking(evening))?.status).toBe('cancelled')
        expect(await booking(fifteenth)).toEqual({ status: 'payment_needed', due: '2026-12-13 14:00' })
        expect(await balance()).toBe(0)
        // 13 December, 14:01: 72 hours after the failure, 44 hours before the session: the guest's £20 goes back as store credit.
        vi.setSystemTime(new Date('2026-12-13T14:01:00.000Z'))
        expect(await sweep()).toMatchObject({ ran: true, lapsed: 1, storeCreditRefunded: 20, items: [{ bookingId: fifteenth, outcome: 'lapsed', back: true, storeCreditRefunded: 20 }] })
        expect((await booking(fifteenth))?.status).toBe('cancelled')
        expect(await balance()).toBe(20)
        // The sweep never calls Stripe.
        expect(stripe.calls.length).toBe(calls)
        // The next day Stripe's retry takes the £40: Mo is active again, and the lapsed bookings stay lapsed.
        vi.setSystemTime(new Date('2026-12-14T09:00:00.000Z'))
        stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEXT_END })
        expect(await handle(stripe, paidEvent(stripe))).toMatchObject({ detail: { action: 'reactivated', was: 'past_due', bookings_restored: 0 } })
        expect([(await booking(evening))?.status, (await booking(fifteenth))?.status]).toEqual(['cancelled', 'cancelled'])
        // His credits for the month he has now paid for are all there to book again.
        const options = await getCustomerCreditOptions(db, ID.member)
        expect(options.membershipsWithSessionCredit.map((m) => m.credits_remaining)).toEqual([4])
      }, with030)
    }
  )
})

// W46a pinned this as "what 030 does not mend" (its report, "Noticed" 2): the late invoice.paid wrote 10 January, and the
// failure then flagged nothing. W46b (W46 review B1) mends it in the webhook: a payment is recorded only for the
// subscription's newest invoice, and in the draft hour that is the renewal's draft. The review's own proofs, turned
// round, are in latest-invoice.test.ts.
describe('what 030 did not mend, mended by W46b (W46a report, "Noticed" 2; W46 review B1)', () => {
  it("an invoice.paid handled late, in the hour Stripe holds the renewal's invoice as a draft (the subscription still reads active, its period already moved on, its newest invoice the draft), is ignored and writes no date; the failure an hour later finds the payment due on 10 December unpaid: covered through 9 December, the booking flagged", async () => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      vi.setSystemTime(ALLOCATION)
      await allocate()
      // November's invoice.paid, sent again after a failed delivery: made while November's invoice was the newest.
      const novembers = paidEvent(stripe, Date.UTC(2026, 10, 10) / 1000, RENEWS)
      vi.setSystemTime(new Date('2026-12-10T14:10:00.000Z'))
      stripe.startRenewal(MO_SUBSCRIPTION, NEXT_END)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toMatchObject({ status: 'active', periodEnd: NEXT_END })
      const rpc = webhookRpc(db)
      expect(await dispatchStripeEvent(novembers, rpc, stripe)).toEqual({ outcome: 'ignored', detail: { reason: 'not_latest_invoice' } })
      expect(rpc.calls).toEqual([])
      expect((await membership())?.renews).toBe('2026-12-10')
      vi.setSystemTime(new Date('2026-12-10T15:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
      expect(await handle(stripe, failedEvent(stripe))).toEqual(pastDue('2026-12-09', 1))
      expect(await booking(fifteenth)).toMatchObject({ status: 'payment_needed' })
    })
  })
})
