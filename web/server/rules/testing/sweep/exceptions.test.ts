import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WORKER_EXCEPTIONS } from '../replay/invariants'
import { ID, mo, paidSeat, sam, seed } from '../replay/scenarios'
import { sweepDb } from './db-holder'
import { startReplay, type ReplayEnvironment, type Scenario } from './run'
import { SWEEP_SCENARIOS, sweepOne } from './sweep'

// Brief W70a (the W70 audit's L5): the sweep's W05 exceptions name exactly what they let through, the PaymentIntent with
// it, and let it through once. Until then an exception covered its whole scenario and list, so a second breach of the
// same kind (another payment on no order, say) was hidden by the first.
vi.mock('@/server/db/connection', async () => {
  const { sweepDb: holder } = await import('./db-holder')
  return { openRequestDb: () => holder.db, closeRequestDb: () => {} }
})
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('../replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})
vi.setConfig({ testTimeout: 120_000 })

describe("the sweep's exceptions hide nothing but what they name (W70a, L5)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    sweepDb.db = environment.database.db
  })
  afterAll(() => environment.stop())

  it('an exception lets through only what it names: a second payment on no order in the same scenario is a breach, and so is a refund of another payment', async () => {
    const name = 'buy-new-membership-covers-the-seat'
    const scenario = SWEEP_SCENARIOS.find((one) => one.name === name) as Scenario
    const asItIs = await sweepOne(environment, scenario)
    expect([asItIs.problems, asItIs.exceptionsUsed]).toEqual([[], [`chargesNotOnOneOrder/${name}: pi_fake_0001 is on 0 orders`]])
    // The same scenario, with a payment taken that nothing records. Until W70a the scenario's one exception hid it.
    let extra = ''
    const andAnother: Scenario = {
      ...scenario,
      async run(context) {
        await scenario.run(context)
        const taken = await context.stripe.paymentIntents.create({ amount: 700, currency: 'gbp', customer: 'cus_seed', payment_method: 'pm_seed', off_session: true, confirm: true })
        extra = taken.id
      },
    }
    const withAnother = await sweepOne(environment, andAnother)
    expect(withAnother.problems).toEqual([`${name}: ${extra} is on 0 orders`])
    // A listed breach is let through once, and only as it is written.
    const listed = { breaches: ['pi_fake_0001 is on 0 orders', `${extra} is on 0 orders`], why: 'a test' }
    const bothListed = { ...WORKER_EXCEPTIONS, chargesNotOnOneOrder: { [name]: listed } }
    expect((await sweepOne(environment, andAnother, { exceptions: bothListed })).problems).toEqual([])
    // Twice the same: two bookings cancelled by hand with nothing back on £20 each, and the line listed once.
    const twice: Scenario = {
      name: 'two-cancelled-by-hand',
      seed,
      async run({ call, db }) {
        const cash = { method: 'cash', confirmedCashAmount: 20 }
        await call('createOrder', { customerId: ID.customer, booking: paidSeat([sam]), payment: cash })
        await call('createOrder', { customerId: ID.member, booking: paidSeat([mo]), payment: cash })
        await db.query("UPDATE bookings SET status = 'cancelled'")
      },
    }
    const line = 'cancelled with £0.00 back on £20.00 paid'
    const once = { ...WORKER_EXCEPTIONS, cancelledWithoutAllTheMoney: { 'two-cancelled-by-hand': { breaches: [line], why: 'a test' } } }
    expect((await sweepOne(environment, twice, { exceptions: once })).problems).toEqual([`two-cancelled-by-hand: ${line}`])
    const both = { ...WORKER_EXCEPTIONS, cancelledWithoutAllTheMoney: { 'two-cancelled-by-hand': { breaches: [line, line], why: 'a test' } } }
    expect((await sweepOne(environment, twice, { exceptions: both })).problems).toEqual([])
    const compensated = 'w13-card-old-cancel-refused'
    const refunded = SWEEP_SCENARIOS.find((one) => one.name === compensated) as Scenario
    const otherFigures = { ...WORKER_EXCEPTIONS, stripeRefundsNotOnRows: { [compensated]: { breaches: ['Stripe refunded £60.00 of pi_fake_0002, the rows say £0'], why: 'a test' } } }
    expect((await sweepOne(environment, refunded, { exceptions: otherFigures })).problems).toEqual([`${compensated}: Stripe refunded £60.00, the rows say £0`])
  })
})
