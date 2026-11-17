import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { CARD_FLOW_PAID_NOT_FINISHED_MESSAGE } from '@/server/rules/bookings/failure-messages'
import { PAYMENT_DATE_NEW_WORDS, PAYMENT_DATE_REFUSALS } from '@/server/rules/memberships/failure-messages'
import { insert } from '@/server/rules/testing/database'
import { staffAppDir } from '../staff-app-dir'
import { compareRecordings, type AllowedDifference, type Recording } from './compare'
import { readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { isW41Scenario, pinned, Q10, Q10_WORDS, W41_DECISION_SCENARIOS, W41_DIFFERENCES } from './payment-date-differences'
import { MEMBERSHIP_KINDS_ON } from './membership-side'
import { comparablePaymentDates, newPaymentDateSide, PAYMENT_DATE_KINDS_ON, paymentDateRowProblems, paymentDateStoredAnswerProblems, W41_ACTIONS } from './payment-date-side'
import { ID, scenarios } from './scenarios'

// W41 (brief item 8): the payment date family through the staff app's thin wrappers and the Worker's routes, as the
// dialog presses them: the quote first, then the press with the figure it showed and a key.

vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal())
})

const compareSides = (golden: Recording, recording: Recording, named: Parameters<typeof compareRecordings>[2]) => compareRecordings(comparablePaymentDates(golden), comparablePaymentDates(recording), named)
const families = scenarios.filter((scenario) => isW41Scenario(scenario.name))
const named = (name: string) => W41_DIFFERENCES.get(name) ?? []

describe("step F's side of the replay: the payment date change (W41)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())
  const golden = (name: string) => readGolden(name) as Recording
  const scenario = (name: string): Scenario => {
    const found = scenarios.find((one) => one.name === name)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const problems = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it('matches its golden file, with its named differences only; its audit rows, its stored answers and the invariants (one charge for one change, a done record with its one order) are right', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const recording = await replay(environment, one, newPaymentDateSide({ calls }))
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => W41_ACTIONS.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      if (process.env.W41_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W41_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), rows: paymentDateRowProblems(recording), stored: paymentDateStoredAnswerProblems(recording), results: recording.results, stripe: recording.stripeCalls.map((call) => [call.method, call.idempotencyKey]) })}\n`
        )
        return
      }
      expect(paymentDateRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(paymentDateStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
    })
  })

  it('the family is whole: every payment date scenario W36 recorded is replayed here (37 of the action and its refusals, FB1, two of FB2, FB3 and FB4), and every named difference is for a scenario that exists', () => {
    expect(families.length).toBe(42)
    expect(families.filter((one) => /^w36-payment-date-/.test(one.name)).length).toBe(37)
    expect(families.filter((one) => /^w36-fb[1-4]-payment-date-/.test(one.name)).map((one) => one.name.slice(4, 7)).sort()).toEqual(['fb1', 'fb2', 'fb2', 'fb3', 'fb4'])
    expect([...W41_DIFFERENCES.keys()].every((name) => families.some((one) => one.name === name))).toBe(true)
    // 23 match their golden files exactly (every refusal the old code already gave in these words); 19 have named
    // differences (W41's 18, and W41a's: the overdue renewal's words are now the renewal day's).
    expect(W41_DIFFERENCES.size).toBe(19)
    expect(families.filter((one) => !W41_DIFFERENCES.has(one.name)).length).toBe(23)
  })

  it('FB1, FB2, FB3 and FB4 (Q18) are each named, with their decision, on their own scenarios; the sentences pinned are the rule\'s own and the staff app\'s', () => {
    const NAMES: Record<string, RegExp> = { FB1: /^Bug FB1 is closed/, FB2: /^Bug FB2 is closed/, FB3: /^(Bug FB3 is closed|The date move refused and the charge refunded)/, FB4_Q18: /^Bug FB4 is closed \(Q18\)/ }
    const DECISIONS: Record<string, RegExp> = { FB1: /^Bug FB1 \(F-plan section 3\)/, FB2: /^Bug FB2 \(F-plan section 3\)/, FB3: /^Bug FB3 \(F-plan section 3\)/, FB4_Q18: /^Bug FB4 \(F-plan section 3\); Wayne's Q18/ }
    for (const [what, names] of Object.entries(W41_DECISION_SCENARIOS)) {
      for (const name of names) {
        const [own] = named(name)
        expect(own?.name, name).toMatch(NAMES[what] as RegExp)
        expect(own?.decision, name).toMatch(DECISIONS[what] as RegExp)
      }
    }
    expect(Object.keys(W41_DECISION_SCENARIOS)).toEqual(['FB1', 'FB2', 'FB3', 'FB4_Q18'])
    // Every w36-fb1 to fb4 scenario is one of them.
    expect(families.filter((one) => /^w36-fb/.test(one.name)).every((one) => Object.values(W41_DECISION_SCENARIOS).some((names) => (names as readonly string[]).includes(one.name)))).toBe(true)
    // The sentences pinned in the differences are the rule's own.
    const pins = readFileSync(path.resolve(__dirname, 'payment-date-differences.ts'), 'utf8')
    for (const words of [CARD_FLOW_PAID_NOT_FINISHED_MESSAGE, PAYMENT_DATE_REFUSALS.inProgress, PAYMENT_DATE_NEW_WORDS.figureChanged(21.94, 24.68), PAYMENT_DATE_NEW_WORDS.refundHeld('This subscription cannot be updated right now.'), PAYMENT_DATE_NEW_WORDS.renewalDueToday]) {
      expect(pins, words).toContain(JSON.stringify(words))
    }
    // And the staff app's no-answer words, in its wrapper's module and its dialog.
    const noAnswer = /".results\[0\].message", ("The change didn't get an answer[^\n]*"),?\]/.exec(pins)?.[1]
    expect(noAnswer).toBeDefined()
    const words = JSON.parse(noAnswer as string) as string
    expect(readFileSync(path.join(staffAppDir(), 'backend/paddock/shared/accountWorker.ts'), 'utf8')).toContain(words)
    expect(readFileSync(path.join(staffAppDir(), 'frontend/components/ChangePaymentDateDialog.tsx'), 'utf8')).toContain(words)
    expect(Q10_WORDS).toBe(PAYMENT_DATE_NEW_WORDS.orderStillProcessing)
  })

  // Q10 has no recording of its own (the old code had no such guard), so it is named against the plain change's.
  const PLAIN = 'w36-payment-date-change-17-days-on'
  const withCardOrderOnHold = (): Scenario => {
    const plain = scenario(PLAIN)
    return {
      ...plain,
      async seed(db, stripe) {
        await plain.seed?.(db, stripe)
        await insert(db, 'orders', { customer_id: ID.member, order_total: '20.00', payment_status: 'pending', order_source: 'staff_created', payment_method: 'card', reader_payment: { method: 'card', flow: 'checkout', expected_amount: 20 } })
      },
    }
  }
  const Q10_DIFFERENCE = pinned(
    "Q10 on a payment date change: the customer has a card order on hold, so the press is refused with the order's own words. Nothing is asked of Stripe, nothing is written, and the two quotes before it answer as ever",
    Q10,
    [
      ['.results[2].changed', false],
      ['.results[2].message', Q10_WORDS],
      ['.results[2].newRenewalDate', (value) => value === undefined],
      ['.results[2].extraDays', (value) => value === undefined],
      ['.results[2].amountCharged', (value) => value === undefined],
      ['.results[2].paymentIntentId', (value) => value === undefined],
      ['.results[2].orderId', (value) => value === undefined],
      ['.stripeCalls[0]', (value) => value === undefined],
      ['.stripeCalls[1]', (value) => value === undefined],
      ['.stripeCalls[2]', (value) => value === undefined],
      ['.tables.customer_memberships', (value) => value === undefined],
      ['.tables.membership_payment_date_changes', (value) => value === undefined],
      ['.tables.order_line_items', (value) => value === undefined],
      ['.tables.orders', (value) => value === undefined],
    ]
  )

  it('Q10 (lead call L8) is named: the plain change with a card order on hold for the customer is refused in the order\'s words, and differs from its golden file by that one named difference; without the order on hold the same allowance is unused, and fails', async () => {
    const held = await replay(environment, withCardOrderOnHold(), newPaymentDateSide())
    expect(held.results[2]).toEqual({ changed: false, message: Q10_WORDS })
    expect(held.stripeCalls).toEqual([])
    expect(paymentDateRowProblems(held)).toEqual([])
    expect(Q10_DIFFERENCE.decision).toMatch(/^Wayne's Q10 \(W03-decisions\), lead call L8/)
    expect(problems(PLAIN, held, [Q10_DIFFERENCE])).toEqual([])
    // Not named: every path of it is reported.
    expect(problems(PLAIN, held, named(PLAIN)).length).toBeGreaterThan(10)
    // With nothing on hold the press goes through: Q10's allowance is not needed, and an unused allowance fails.
    const plain = await replay(environment, scenario(PLAIN), newPaymentDateSide())
    expect(problems(PLAIN, plain)).toEqual([])
    expect(problems(PLAIN, plain, [...named(PLAIN), Q10_DIFFERENCE])).toEqual([`(allowed difference not seen: ${Q10_DIFFERENCE.name})`])
  })

  it('an unused allowance fails, on a scenario that matches its golden file exactly and on one with named differences; a pinned difference refuses any other value', async () => {
    const exact = 'w36-payment-date-refused-yearly'
    expect(W41_DIFFERENCES.has(exact)).toBe(false)
    const yearly = await replay(environment, scenario(exact), newPaymentDateSide())
    expect(problems(exact, yearly)).toEqual([])
    const [borrowed] = named('w36-fb4-payment-date-the-figure-changes-between-the-quote-and-the-press')
    expect(problems(exact, yearly, [borrowed as AllowedDifference])).toEqual([`(allowed difference not seen: ${(borrowed as AllowedDifference).name})`])

    // FB4's scenario with the old outcome put back in the answer (the press said to have gone through): not allowed.
    const fb4 = 'w36-fb4-payment-date-the-figure-changes-between-the-quote-and-the-press'
    const right = await replay(environment, scenario(fb4), newPaymentDateSide())
    expect(problems(fb4, right)).toEqual([])
    const wrong = await replay(
      environment,
      scenario(fb4),
      newPaymentDateSide({ adjust: (action, answer) => (action === 'changeMembershipPaymentDate' ? { ...(answer as object), amountNow: 99.99 } : answer) })
    )
    expect(problems(fb4, wrong)).toContain('.results[1].amountNow')
    // A key that is not the record's own is not allowed either: the pin holds the exact key.
    const plainKeys = named(PLAIN)[0] as AllowedDifference
    expect(plainKeys.actual?.('membership_payment_date_changes#1:charge', null, '.stripeCalls[1].idempotencyKey', { expected: golden(PLAIN), actual: golden(PLAIN) })).toBe(true)
    expect(plainKeys.actual?.('some-other-key', null, '.stripeCalls[1].idempotencyKey', { expected: golden(PLAIN), actual: golden(PLAIN) })).toBe(false)
    expect(plainKeys.actual?.(null, null, '.stripeCalls[1].idempotencyKey', { expected: golden(PLAIN), actual: golden(PLAIN) })).toBe(false)
  })

  it('with `payment_date_changes` off (W41a: its own kind; `membership_changes` still on, as live is today) the press answers "switched off" and nothing is read or sent; the quote still answers', async () => {
    expect(PAYMENT_DATE_KINDS_ON.split(',')).toContain('payment_date_changes')
    expect(MEMBERSHIP_KINDS_ON.split(',')).toContain('membership_changes')
    expect(MEMBERSHIP_KINDS_ON.split(',')).not.toContain('payment_date_changes')
    const off = await replay(environment, scenario(PLAIN), newPaymentDateSide({ orderSwitch: MEMBERSHIP_KINDS_ON }))
    expect(off.results[2]).toEqual({ changed: false, message: 'This is switched off in the booking system. Tell a manager.' })
    expect(off.results[1]).toMatchObject({ amount: 21.94, extraDays: 17 })
    expect(off.stripeCalls).toEqual([])
    expect(off.tables['membership_payment_date_changes']).toBeUndefined()
  })
})
