import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { compareRecordings, type AllowedDifference, type Recording } from './compare'
import { oldSide, readGolden, replay, startReplay, type ReplayEnvironment } from './harness'
import { sweepInvariants } from './invariants'
import { isOrderRefundScenario, MEMBERSHIP_SCENARIOS, ORDER_CLAIM_KEYS, ORDER_REFUND_DIFFERENCES } from './order-refund-differences'
import { comparableOrderRefund, newOrderRefundSide, orderClaimLookProblems, orderRefundRowProblems, orderRefundStoredAnswerProblems } from './order-refund-side'
import { scenarios } from './scenarios'

// W28 (brief item 8): the order refund golden families through the staff app's thin refundOrder and the Worker's route.
// W29 (brief item 5): the ten membership scenarios replay with them, E3, E4 and E10 as named differences.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('./stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const compareSides = (golden: Recording, recording: Recording, named: Parameters<typeof compareRecordings>[2]) =>
  compareRecordings(comparableOrderRefund(golden, 'golden'), comparableOrderRefund(recording, 'new'), named)

const families = scenarios.filter((scenario) => isOrderRefundScenario(scenario.name))
// W29: the membership scenarios replay too (W28 left them refused); every W27 order refund scenario is built now.
const built = families

describe("step E's side of the replay: order refunds (W28)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  describe.each(built.map((scenario) => [scenario.name, scenario] as const))('%s', (name, scenario) => {
    it('matches its golden file, with its named differences only', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const recording = await replay(environment, scenario, newOrderRefundSide({ calls }))
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => call.action === 'refundOrder').every((call) => call.side === 'new')).toBe(true)
      const named = ORDER_REFUND_DIFFERENCES.get(name) ?? []
      if (process.env.W28_DIFFERENCES_OUT) {
        appendFileSync(process.env.W28_DIFFERENCES_OUT, `${JSON.stringify({ name, differences: compareSides(golden, recording, []), unnamed: compareSides(golden, recording, named), rows: orderRefundRowProblems(recording) })}\n`)
        return
      }
      expect(orderRefundRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(orderRefundStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(orderClaimLookProblems(recording), `${name}: reconcile's looks for a held refund`).toEqual([])
      expect(compareSides(golden, recording, named)).toEqual([])
    })
  })

  it('the families are whole: every W27 order refund scenario is replayed here, the ten membership ones among them (W29), and every named difference is for a scenario that exists', () => {
    expect(families.length).toBe(67)
    expect(built.length).toBe(67)
    expect([...MEMBERSHIP_SCENARIOS].every((name) => built.some((scenario) => scenario.name === name))).toBe(true)
    expect(MEMBERSHIP_SCENARIOS.size).toBe(10)
    expect([...ORDER_REFUND_DIFFERENCES.keys()].every((name) => built.some((scenario) => scenario.name === name))).toBe(true)
    // 19 match their golden files exactly; 19 differ only in the refund's key; 29 have differences of their own.
    expect(built.filter((scenario) => !ORDER_REFUND_DIFFERENCES.has(scenario.name)).length).toBe(19)
    expect([...ORDER_REFUND_DIFFERENCES.values()].filter((named) => named.length === 1 && named[0] === ORDER_CLAIM_KEYS).length).toBe(19)
    // W29: of the ten membership scenarios, three match exactly, three differ only in the key, four are named (E3, E4, E10 twice).
    const membership = [...MEMBERSHIP_SCENARIOS]
    expect(membership.filter((name) => !ORDER_REFUND_DIFFERENCES.has(name)).length).toBe(3)
    expect(membership.filter((name) => (ORDER_REFUND_DIFFERENCES.get(name) ?? []).some((one) => one !== ORDER_CLAIM_KEYS)).sort()).toEqual([
      'w27-e3-membership-and-robe-on-one-card-refunded-to-card',
      'w27-e4-membership-refunded-in-full-after-a-credit-session',
      'w27-order-refund-subscription-cancel-refused-after-the-money-went',
      'w27-order-refund-subscription-cancel-refused-before-any-money-is-taken-back',
    ])
  })

  it("the W05 invariants hold on the new side for every order refund scenario: Stripe's refunds are all on the rows, and no payment is left on no order (the old side breaks three)", async () => {
    const old = await sweepInvariants(environment, built, oldSide)
    // W27's known faults among these scenarios (w05d.test.ts, W27_KNOWN_FAULTS): the old code's, recorded on purpose.
    expect(old.wrong).toEqual([
      'w27-order-refund-died-on-one-line-then-another-line-at-the-same-figures: Stripe refunded £48.00, the rows say £24',
      'w27-order-refund-held-two-days-and-the-look-fails: Stripe refunded £24.00, the rows say £0',
      'w27-e2-order-refund-while-its-reader-payment-is-still-open: pi_fake_0001 is on 0 orders',
    ])
    const fresh = await sweepInvariants(environment, built, newOrderRefundSide())
    // The one line left is the scenario's own doing, not a fault: E2's recording makes the customer "tap" after the
    // refund. On the new side the refund was refused and the reader payment was then cancelled at Stripe (the order
    // undone), and the fake lets a cancelled PaymentIntent be completed all the same (completeReaderPayment works for
    // any intent), which Stripe wouldn't. No refund is unrecorded and nothing was given for an unpaid order.
    expect(fresh.wrong).toEqual(['w27-e2-order-refund-while-its-reader-payment-is-still-open: pi_fake_0001 is on 0 orders'])
  })

  describe('the comparison catches what it is for', () => {
    const scenario = (name: string) => {
      const found = built.find((one) => one.name === name)
      if (!found) throw new Error(`No scenario ${name}`)
      return found
    }
    const keysOnly = 'w27-order-refund-split-card-and-store-credit'

    it('a deliberate difference in what staff are told is caught: a penny more store credit in the answer', async () => {
      const recording = await replay(
        environment,
        scenario(keysOnly),
        newOrderRefundSide({ adjust: (_action, answer) => ({ ...(answer as object), storeCreditRefundedAmount: 10.01 }) })
      )
      const differences = compareSides(readGolden(keysOnly) as Recording, recording, ORDER_REFUND_DIFFERENCES.get(keysOnly) ?? [])
      expect(differences.map((difference) => difference.path)).toEqual(['.results[1].storeCreditRefundedAmount'])
    })

    it('a deliberate difference in the rows is caught: the line left unstamped, a second store credit row, the wrong order status', async () => {
      for (const [tamper, path] of [
        ['UPDATE order_line_items SET refunded_at = NULL', '.tables.order_line_items.added[0].refunded_at'],
        ["UPDATE order_line_items SET refund_method = 'credit'", '.tables.order_line_items.added[0].refund_method'],
        ['UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + 0.01', '.tables.order_line_items.added[0].card_refunded_amount'],
        ["UPDATE orders SET payment_status = 'partially_refunded'", '.tables.orders.added[0].payment_status'],
        ['UPDATE orders SET refund_owed_amount = 0.01', '.tables.orders.added[0].refund_owed_amount'],
        ['UPDATE customers SET store_credit_balance = store_credit_balance + 0.01 WHERE store_credit_balance > 0', '.tables.customers'],
      ] as const) {
        const recording = await replay(environment, scenario(keysOnly), newOrderRefundSide(), {
          async tamper(db) {
            // Test data only: each statement is a literal above.
            await db.query(tamper)
          },
        })
        const differences = compareSides(readGolden(keysOnly) as Recording, recording, ORDER_REFUND_DIFFERENCES.get(keysOnly) ?? [])
        expect(differences.map((difference) => difference.path), tamper).toEqual([path])
      }
    })

    it("a second refund sent to Stripe is caught, and so is one sent under any key but the claim's", async () => {
      // An order with card money left on its payment (£39 paid, £24 back): a second refund can be made at all.
      const withMoneyLeft = 'w27-order-refund-a-second-refund-on-the-same-order'
      const twice = await replay(environment, scenario(withMoneyLeft), newOrderRefundSide(), {
        async tamper(_db, stripe) {
          await stripe.refunds.create({ payment_intent: 'pi_fake_0002', amount: 1 }, { idempotencyKey: 'by-hand' })
        },
      })
      expect(compareSides(readGolden(withMoneyLeft) as Recording, twice, ORDER_REFUND_DIFFERENCES.get(withMoneyLeft) ?? []).map((difference) => difference.path)).toEqual(['.stripeCalls[2]'])
      // A key that isn't `<claimId>:refund:<orderId>` doesn't pass the keys' allowance.
      const recording = await replay(environment, scenario(keysOnly), newOrderRefundSide())
      const wrongKey: Recording = { ...recording, stripeCalls: recording.stripeCalls.map((call) => (call.method === 'refunds.create' ? { ...call, idempotencyKey: 'order-refund:made-up' } : call)) }
      expect(compareSides(readGolden(keysOnly) as Recording, wrongKey, ORDER_REFUND_DIFFERENCES.get(keysOnly) ?? []).map((difference) => difference.path)).toEqual(['.stripeCalls[1].idempotencyKey'])
    })

    it('an unused allowance fails: one nobody needs, on a scenario that matches exactly and on one with named differences', async () => {
      const stale: AllowedDifference = { name: 'An allowance nobody needs', decision: 'none', path: /^\.results\[1\]\.warning$/ }
      for (const name of ['w27-order-refund-product-to-store-credit', keysOnly]) {
        const recording = await replay(environment, scenario(name), newOrderRefundSide())
        const differences = compareSides(readGolden(name) as Recording, recording, [...(ORDER_REFUND_DIFFERENCES.get(name) ?? []), stale])
        expect(differences.map((difference) => difference.path), name).toEqual(['(allowed difference not seen: An allowance nobody needs)'])
      }
      // And the keys' own allowance, given to a scenario that sends no card refund.
      const recording = await replay(environment, scenario('w27-order-refund-product-to-store-credit'), newOrderRefundSide())
      expect(compareSides(readGolden('w27-order-refund-product-to-store-credit') as Recording, recording, [ORDER_CLAIM_KEYS]).map((difference) => difference.path)).toEqual([`(allowed difference not seen: ${ORDER_CLAIM_KEYS.name})`])
    })

    it('W29: the membership allowances catch what they are for: Q41\'s flag undone (an allowance nobody needs), and E10\'s words changed', async () => {
      // E4 / Q41: the future credit booking put back to confirmed (the old outcome): the allowance is no longer needed, which fails.
      const e4 = 'w27-e4-membership-refunded-in-full-after-a-credit-session'
      const unflagged = await replay(environment, scenario(e4), newOrderRefundSide(), {
        async tamper(db) {
          await db.query("UPDATE bookings SET status = 'confirmed', payment_due_by = NULL WHERE status = 'payment_needed'")
        },
      })
      expect(compareSides(readGolden(e4) as Recording, unflagged, ORDER_REFUND_DIFFERENCES.get(e4) ?? []).map((difference) => difference.path)).toEqual([
        expect.stringMatching(/^\(allowed difference not seen: E4 \/ Q41/),
      ])
      // E10: any other warning than the cancel-left words doesn't pass.
      const e10 = 'w27-order-refund-subscription-cancel-refused-after-the-money-went'
      const reworded = await replay(environment, scenario(e10), newOrderRefundSide({ adjust: (_action, answer) => ({ ...(answer as object), warning: 'Something else went wrong.' }) }))
      expect(compareSides(readGolden(e10) as Recording, reworded, ORDER_REFUND_DIFFERENCES.get(e10) ?? []).map((difference) => difference.path)).toEqual(['.results[1].warning'])
    })

    it("an allowance that checks its value refuses the wrong value: E2's refusal with any other reason", async () => {
      const name = 'w27-e2-order-refund-while-its-reader-payment-is-still-open'
      const recording = await replay(
        environment,
        scenario(name),
        newOrderRefundSide({ adjust: (_action, answer) => ({ ...(answer as object), reason: 'something_else' }) })
      )
      const differences = compareSides(readGolden(name) as Recording, recording, ORDER_REFUND_DIFFERENCES.get(name) ?? [])
      expect(differences.map((difference) => difference.path)).toEqual(['.results[1].reason'])
    })
  })
})
