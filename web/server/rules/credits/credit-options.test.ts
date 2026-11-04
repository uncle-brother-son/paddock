import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { getCustomerCreditOptions } from './credit-options'

let t: TestDatabase
let corePlan: string, peakSession: string, coreSession: string, corePass: string, allAccessPass: string

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())
const inDays = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(Date.now() + n * 86_400_000))

async function memberWithCredits(remaining: number, row: Record<string, unknown> = {}) {
  const customer = await fixtures.customer(t.db)
  const membership = await fixtures.membership(t.db, { customer_id: customer, plan_id: corePlan, next_renewal_date: inDays(20), addon_credits_remaining: 2, ...row })
  await insert(t.db, 'membership_credit_periods', {
    membership_id: membership,
    period_start: inDays(-5),
    period_end: inDays(25),
    credits_allocated: remaining,
    is_unlimited: false,
  })
  return { customer, membership }
}

beforeAll(async () => {
  t = await startTestDatabase()
  const { db } = t
  const core = await fixtures.band(db)
  const peak = await fixtures.band(db)
  const type = await fixtures.serviceType(db)
  coreSession = await fixtures.session(db, { service_type_id: type, band_id: core })
  peakSession = await fixtures.session(db, { service_type_id: type, band_id: peak, start_time: '2030-06-16 10:00:00+00', end_time: '2030-06-16 11:00:00+00' })
  await insert(db, 'membership_band_terms', { membership_level: 'core', band_id: core, credit_eligible: true, discount_percent: '100' })
  await insert(db, 'membership_band_terms', { membership_level: 'core', band_id: peak, credit_eligible: false, discount_percent: '0' })
  corePlan = await fixtures.plan(db, { name: 'Core plan' })
  corePass = await fixtures.passType(db, { name: 'Core pass', level: 'core' })
  allAccessPass = await fixtures.passType(db, { name: 'All pass', level: 'all_access' })
})

afterAll(() => t.stop())

describe('getCustomerCreditOptions', () => {
  it('a customer with nothing has empty lists', async () => {
    expect(await getCustomerCreditOptions(t.db, await fixtures.customer(t.db))).toEqual({
      membershipsWithSessionCredit: [],
      membershipsWithAddonCredit: [],
      sessionPasses: [],
      sessionPassesNotCoveringSession: 0,
      exhaustedMembership: null,
    })
  })

  it('offers a membership with credit left, without the private columns', async () => {
    const { customer, membership } = await memberWithCredits(3, { stripe_subscription_id: 'sub_1' })

    const options = await getCustomerCreditOptions(t.db, customer)

    expect(options.membershipsWithSessionCredit).toEqual([
      {
        id: membership,
        plan_id: corePlan,
        plan_name: 'Core plan',
        is_unlimited: false,
        credits_remaining: 3,
        period_end: inDays(25),
        addon_credits_remaining: 2,
        next_renewal_date: inDays(20),
        is_herd: false,
        herd_override: null,
      },
    ])
    expect(options.exhaustedMembership).toBeNull()
  })

  it('add-on credits need Herd', async () => {
    const plain = await memberWithCredits(3)
    expect((await getCustomerCreditOptions(t.db, plain.customer)).membershipsWithAddonCredit).toEqual([])

    const herd = await memberWithCredits(3, { is_herd: true })
    expect((await getCustomerCreditOptions(t.db, herd.customer)).membershipsWithAddonCredit).toHaveLength(1)
  })

  it('a membership with nothing left is the exhausted one, with its subscription', async () => {
    const { customer, membership } = await memberWithCredits(0, { stripe_subscription_id: 'sub_2' })

    expect(await getCustomerCreditOptions(t.db, customer)).toMatchObject({
      membershipsWithSessionCredit: [],
      exhaustedMembership: { id: membership, plan_id: corePlan, plan_name: 'Core plan', stripe_subscription_id: 'sub_2' },
    })
  })

  it('a scheduled cancellation counts through its last day and not after', async () => {
    const lastDay = await memberWithCredits(1, { cancel_effective_date: today() })
    expect((await getCustomerCreditOptions(t.db, lastDay.customer)).membershipsWithSessionCredit).toHaveLength(1)

    const gone = await memberWithCredits(1, { cancel_effective_date: inDays(-1) })
    expect((await getCustomerCreditOptions(t.db, gone.customer)).membershipsWithSessionCredit).toEqual([])
  })

  it('a past_due membership is not usable', async () => {
    const { customer } = await memberWithCredits(1, { subscription_status: 'past_due' })
    expect((await getCustomerCreditOptions(t.db, customer)).membershipsWithSessionCredit).toEqual([])
  })

  it('passes come soonest-expiring first; without a session covers_session is null', async () => {
    const customer = await fixtures.customer(t.db)
    const later = await fixtures.pass(t.db, { customer_id: customer, pass_type_id: allAccessPass, expiry_date: inDays(30) })
    const sooner = await fixtures.pass(t.db, { customer_id: customer, pass_type_id: corePass, expiry_date: inDays(10) })

    const options = await getCustomerCreditOptions(t.db, customer)

    expect(options.sessionPasses.map((p) => p.id)).toEqual([sooner, later])
    expect(options.sessionPasses[0]).toEqual({
      id: sooner,
      pass_type_id: corePass,
      pass_type_name: 'Core pass',
      level: 'core',
      sessions_remaining: 5,
      expiry_date: inDays(10),
      covers_session: null,
    })
    expect(options.sessionPassesNotCoveringSession).toBe(0)
  })

  it('a Core pass on Peak is left out and counted; on Core it is offered', async () => {
    const customer = await fixtures.customer(t.db)
    const core = await fixtures.pass(t.db, { customer_id: customer, pass_type_id: corePass })
    const all = await fixtures.pass(t.db, { customer_id: customer, pass_type_id: allAccessPass })

    const peak = await getCustomerCreditOptions(t.db, customer, peakSession)
    expect(peak.sessionPasses.map((p) => p.id)).toEqual([all])
    expect(peak.sessionPassesNotCoveringSession).toBe(1)

    const onCore = await getCustomerCreditOptions(t.db, customer, coreSession)
    expect(onCore.sessionPasses.map((p) => p.id).sort()).toEqual([all, core].sort())
    expect(onCore.sessionPasses[0]?.covers_session).toBe(true)
    expect(onCore.sessionPassesNotCoveringSession).toBe(0)
  })

  it('an expired or used-up pass is not offered; the last day still counts', async () => {
    const customer = await fixtures.customer(t.db)
    await fixtures.pass(t.db, { customer_id: customer, pass_type_id: allAccessPass, expiry_date: inDays(-1) })
    await fixtures.pass(t.db, { customer_id: customer, pass_type_id: allAccessPass, sessions_remaining: 0 })
    const lastDay = await fixtures.pass(t.db, { customer_id: customer, pass_type_id: allAccessPass, expiry_date: today() })

    expect((await getCustomerCreditOptions(t.db, customer)).sessionPasses.map((p) => p.id)).toEqual([lastDay])
  })
})
