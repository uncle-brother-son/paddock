import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { MEMBERSHIP_CANCEL_DIALOG_WORDS, MEMBERSHIP_CANCEL_NEW_WORDS, MEMBERSHIP_PATH_OFF_MESSAGE } from '@/server/rules/memberships/failure-messages'
import { fakeStripeErrors } from '@/server/stripe/fake'
import { staffAppDir } from '../staff-app-dir'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { oldSide, readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { sweepInvariants } from './invariants'
import {
  ALREADY_CANCELLING_WORDS,
  DECISION_SCENARIOS,
  INACTIVE_WORDS,
  isW40Scenario,
  MEMBERSHIP_CANCEL_NO_ANSWER_MESSAGE,
  NO_RENEWAL_DATE_WORDS,
  NOT_ACTIVE_WORDS,
  NOT_CANCELLING_WORDS,
  RENEWAL_DUE_WORDS,
  W40_DIFFERENCES,
} from './membership-differences'
import { comparableMemberships, membershipRowProblems, membershipStoredAnswerProblems, MEMBERSHIP_KINDS_ON, newMembershipSide, stripeReadProblems, W40_ACTIONS, W40_AUDIT_ROWS } from './membership-side'
import { ID, scenarios } from './scenarios'

// W40 (brief item 9): the membership cancel family and the membership reads through the staff app's thin wrappers and
// the Worker's routes, as the dialog presses them.
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

const paramsOf = (call: { params: unknown } | undefined): Record<string, unknown> => (call?.params ?? {}) as Record<string, unknown>
const compareSides = (golden: Recording, recording: Recording, named: Parameters<typeof compareRecordings>[2]) => compareRecordings(comparableMemberships(golden), comparableMemberships(recording), named)
const families = scenarios.filter((scenario) => isW40Scenario(scenario.name))
const named = (name: string) => W40_DIFFERENCES.get(name) ?? []

/**
 * F-plan 4.12 item 5, on the rows a scenario leaves: a cancel or an undo never happens twice for one press (one
 * `membership.cancel_scheduled` or `.cancel_undone` row for each press key answered with a success or refused by
 * Stripe), and no Stripe step is left open with nothing listed for it (every open step is on the stuck list's read).
 */
async function membershipInvariantProblems(db: Db): Promise<string[]> {
  const problems: string[] = []
  const [counts] = await db.query<{ rows: string; presses: string }>(
    `SELECT (SELECT count(*) FROM audit_log WHERE action IN ('membership.cancel_scheduled', 'membership.cancel_undone'))::text AS rows,
            (SELECT count(*) FROM api_idempotency WHERE endpoint ~ '^POST /api/v1/staff/memberships/[^/]+/(cancel|undo-cancel)$'
               AND (http_status = 200 OR response::text LIKE '%stripe_refused%'))::text AS presses`
  )
  if (counts?.rows !== counts?.presses) problems.push(`${counts?.rows} cancel and undo rows for ${counts?.presses} presses answered with a success or refused by Stripe`)
  return problems
}

describe("step F's side of the replay: membership cancel and the membership reads (W40)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  const scenario = (name: string): Scenario => {
    const found = scenarios.find((one) => one.name === name)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const golden = (name: string) => readGolden(name) as Recording
  const paths = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it('matches its golden file, with its named differences only; its audit rows, stored answers and Stripe reads are right; the invariants hold', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      let invariants: string[] = ['not checked']
      const recording = await replay(environment, one, newMembershipSide({ calls }), {
        async tamper(db) {
          invariants = await membershipInvariantProblems(db)
        },
      })
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => W40_ACTIONS.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => W40_ACTIONS.has(call.action))).toBe(true)
      if (process.env.W40_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W40_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: membershipRowProblems(recording), stored: membershipStoredAnswerProblems(recording), reads: stripeReadProblems(recording), invariants, audit: recording.tables['audit_log']?.added ?? [], results: recording.results, stripeCalls: recording.stripeCalls })}\n`
        )
        return
      }
      expect(membershipRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(membershipStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(stripeReadProblems(recording), `${name}: Stripe's reads`).toEqual([])
      expect(invariants, `${name}: the invariants`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
    })
  })

  it('the families are whole: every cancel, undo, FB5 and FB6 scenario W36 recorded is replayed here (14 cancel, 3 undo, 6 FB5, 2 FB6) with the two recordings of the list, and every named difference is for a scenario that exists', () => {
    expect(families.length).toBe(27)
    expect(families.filter((one) => /^w36-cancel-/.test(one.name)).length).toBe(14)
    expect(families.filter((one) => /^w36-undo-/.test(one.name)).length).toBe(3)
    expect(families.filter((one) => /^w36-fb5-/.test(one.name)).length).toBe(6)
    expect(families.filter((one) => /^w36-fb6-/.test(one.name)).length).toBe(2)
    expect(families.filter((one) => /^w36-(subscriptions-list-and-search|membership-reads-carry-the-payment-date-refusal)$/.test(one.name)).length).toBe(2)
    expect([...W40_DIFFERENCES.keys()].every((name) => families.some((one) => one.name === name))).toBe(true)
    // 4 match their golden files exactly (no membership id, no Issue refunds, an unknown membership, no subscription); 23 have named differences.
    expect(families.filter((one) => !W40_DIFFERENCES.has(one.name)).map((one) => one.name).sort()).toEqual(
      ['w36-cancel-refused-no-membership-id', 'w36-cancel-refused-unknown-membership', 'w36-cancel-refused-without-issue-refunds', 'w36-cancel-with-no-subscription'].sort()
    )
    expect(W40_DIFFERENCES.size).toBe(23)
  })

  it('FB5, FB6 (Q33), FB20 and FB22 are each named, with their decision, on their own scenarios', () => {
    const NAMES: Record<string, RegExp> = { FB5: /^Bug FB5 is closed/, FB6: /^Bug FB6 is closed \(Q33\)/, RENEWAL_DAY: /^The renewal day \(W40a\)/, FB20: /^(No staff record|An inactive account): refused/, FB22: /^Bug FB22 is closed/ }
    const DECISIONS: Record<string, RegExp> = { FB5: /^Bug FB5 \(F-plan section 3\)/, FB6: /^Bug FB6 \(F-plan section 3\); Wayne's Q33, 9 Nov/, RENEWAL_DAY: /^Wayne, 16 Nov \(brief W40a item 3/, FB20: /bug FB20 \(F-plan section 3/, FB22: /^Bug FB22 \(W36 report/ }
    for (const [what, names] of Object.entries(DECISION_SCENARIOS)) {
      for (const name of names) {
        const [own] = named(name)
        expect(own?.name, name).toMatch(NAMES[what] as RegExp)
        expect(own?.decision, name).toMatch(DECISIONS[what] as RegExp)
      }
    }
    expect(Object.keys(DECISION_SCENARIOS)).toEqual(['FB5', 'FB6', 'RENEWAL_DAY', 'FB20', 'FB22'])
    // Every w36-fb5 and w36-fb6 scenario is one of them.
    expect(families.filter((one) => /^w36-fb/.test(one.name)).map((one) => one.name).sort()).toEqual([...DECISION_SCENARIOS.FB5, ...DECISION_SCENARIOS.FB6, ...DECISION_SCENARIOS.RENEWAL_DAY].sort())
    // The sentences pinned in the differences are the rule's own, and the dialog's.
    expect(NO_RENEWAL_DATE_WORDS).toBe(MEMBERSHIP_CANCEL_NEW_WORDS.noRenewalDate)
    expect(RENEWAL_DUE_WORDS).toBe(MEMBERSHIP_CANCEL_NEW_WORDS.renewalDueToday)
    expect([NOT_ACTIVE_WORDS, ALREADY_CANCELLING_WORDS, NOT_CANCELLING_WORDS]).toEqual([MEMBERSHIP_CANCEL_DIALOG_WORDS.not_active, MEMBERSHIP_CANCEL_DIALOG_WORDS.already_cancelling, MEMBERSHIP_CANCEL_DIALOG_WORDS.not_cancelling])
    const dialog = readFileSync(path.join(staffAppDir(), 'frontend/components/CancelMembershipDialog.tsx'), 'utf8')
    for (const words of [NOT_ACTIVE_WORDS, ALREADY_CANCELLING_WORDS, NOT_CANCELLING_WORDS]) expect(dialog).toContain(words)
  })

  it('FB6 in pounds and dates: the old recordings end on 3 March and 1 October; the new side ends the first on 28 February, and Stripe is sent that midnight. W40a: the second, whose renewal (31 August) is overdue on 10 November, is refused, and Stripe is sent nothing', async () => {
    const [december] = DECISION_SCENARIOS.FB6
    const [july] = DECISION_SCENARIOS.RENEWAL_DAY
    const was = (name: string) => [(golden(name).results[0] as { endDate: string }).endDate, paramsOf(golden(name).stripeCalls[0])['cancel_at']]
    expect(was(december)).toEqual(['2027-03-03', Date.UTC(2027, 2, 3) / 1000])
    expect(was(july)).toEqual(['2026-10-01', Date.UTC(2026, 8, 30, 23) / 1000])
    const now = async (name: string) => {
      const recording = await replay(environment, scenario(name), newMembershipSide())
      return [(recording.results[0] as { endDate: string }).endDate, paramsOf(recording.stripeCalls.find((call) => call.method === 'subscriptions.update'))['cancel_at']]
    }
    expect(await now(december)).toEqual(['2027-02-28', Date.UTC(2027, 1, 28) / 1000])
    const refused = await replay(environment, scenario(july), newMembershipSide())
    expect(refused.results[0]).toEqual({ updated: false, reason: 'renewal_due_today', message: RENEWAL_DUE_WORDS })
    expect(refused.stripeCalls).toEqual([])
  })

  it('the W05 invariants hold on both sides for every scenario of the family', async () => {
    const fresh = await sweepInvariants(environment, families, newMembershipSide())
    expect(fresh.wrong).toEqual([])
    const old = await sweepInvariants(environment, families, oldSide)
    expect(old.wrong).toEqual([])
  })

  it("the no-answer words are the staff app's own (shared/accountWorker.ts), and the dialog's copy is the same sentence", () => {
    const backend = readFileSync(path.join(staffAppDir(), 'backend/paddock/shared/accountWorker.ts'), 'utf8')
    const words = /MEMBERSHIP_CANCEL_NO_ANSWER_MESSAGE =\n\s+("(?:[^"\\]|\\.)*")/.exec(backend)?.[1]
    expect(words).toBeDefined()
    expect(JSON.parse(words as string)).toBe(MEMBERSHIP_CANCEL_NO_ANSWER_MESSAGE)
    expect(readFileSync(path.join(staffAppDir(), 'frontend/components/CancelMembershipDialog.tsx'), 'utf8')).toContain(words as string)
    expect(words).toContain("it won't apply twice")
    expect(words).toContain('may or may not have changed')
  })

  describe('the wrapper, as the dialog holds it', () => {
    /** The cancel family's actions through the new side on a scenario's seed, with whatever key the test gives. */
    async function pressing(seedOf: string, work: (press: (params: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<void>, orderSwitch?: string): Promise<Recording> {
      return replay(
        environment,
        {
          name: 'w40 press keys',
          seed: scenario(seedOf).seed,
          async run({ call }) {
            await work(async (params) => (await call('setMembershipCancellation', params)) as Record<string, unknown>)
          },
        },
        newMembershipSide(orderSwitch === undefined ? {} : { orderSwitch })
      )
    }
    const seeded = 'w36-cancel-monthly-after-the-minimum-term'
    const cancelRows = (recording: Recording) => ((recording.tables['audit_log']?.added ?? []) as Row[]).filter((row) => row['action'] === 'membership.cancel_scheduled' || row['action'] === 'membership.cancel_undone')

    it('answers in the old shape; with the switch off every press is refused as data in the Worker\'s "switched off" words and nothing is touched', async () => {
      const on = await pressing(seeded, async (press) => {
        expect(await press({ membershipId: ID.membership, cancel: true })).toEqual({
          updated: true,
          membership: { id: ID.membership, cancel_effective_date: '2026-12-09', billing_frequency: 'monthly' },
          endDate: '2026-12-10',
          stripeUpdated: true,
        })
        expect(await press({ membershipId: ID.membership, cancel: false })).toEqual({ updated: true, membership: { id: ID.membership, cancel_effective_date: null, billing_frequency: 'monthly' } })
      })
      expect(cancelRows(on).map((row) => row['action'])).toEqual(['membership.cancel_scheduled', 'membership.cancel_undone'])
      expect(MEMBERSHIP_KINDS_ON.split(',')).toContain('membership_changes')
      // Today's live value: the kind is off.
      const off = await pressing(
        seeded,
        async (press) => {
          for (const cancel of [true, false]) {
            expect(await press({ membershipId: ID.membership, cancel })).toEqual({ updated: false, reason: 'membership_path_off', message: MEMBERSHIP_PATH_OFF_MESSAGE })
          }
        },
        MEMBERSHIP_KINDS_ON.replace(',membership_changes', '')
      )
      // Nothing but the stored answers themselves (each press's own 501), as every switched-off route leaves.
      expect(Object.keys(off.tables)).toEqual(['api_idempotency'])
      expect(((off.tables['api_idempotency']?.added ?? []) as Row[]).map((one) => one['http_status'])).toEqual([501, 501])
      expect(off.stripeCalls).toEqual([])
    })

    it('a second change inside the first\'s window, while its Stripe step is still open, comes back as data with the "still being sent" words', async () => {
      const recording = await replay(
        environment,
        {
          name: 'w40 still sending',
          seed: scenario(seeded).seed,
          async run({ call, stripe }) {
            stripe.failNext('subscriptions.update', { kind: 'error', error: fakeStripeErrors.server() })
            const first = (await call('setMembershipCancellation', { membershipId: ID.membership, cancel: true })) as Record<string, unknown>
            // Saved, with the Worker's sentence for a step it is still sending.
            expect(first).toMatchObject({ updated: true, stripeUpdated: false, left: { message: MEMBERSHIP_CANCEL_NEW_WORDS.left } })
            expect(await call('setMembershipCancellation', { membershipId: ID.membership, cancel: false })).toEqual({
              updated: false,
              reason: 'still_sending',
              message: 'The last change to this membership is still being sent to Stripe. Try again in 15 minutes.',
            })
          },
        },
        newMembershipSide()
      )
      expect(cancelRows(recording).map((row) => row['action'])).toEqual(['membership.cancel_scheduled'])
      expect(membershipRowProblems(recording)).toEqual([])
    })
  })

  describe('W40a: the renewal day', () => {
    it("a cancel on the day the renewal is due comes back as data with the Worker's words, which the dialog shows as they are (it holds no sentence of its own for this reason); nothing is written or sent", async () => {
      const recording = await replay(
        environment,
        {
          name: 'w40a renewal due today',
          async seed(db, stripe) {
            await scenario('w36-cancel-monthly-after-the-minimum-term').seed(db, stripe)
            // The replay's today is 10 November 2026 in London.
            await db.query("UPDATE customer_memberships SET next_renewal_date = '2026-11-10' WHERE id = $1", [ID.membership])
          },
          async run({ call }) {
            expect(await call('setMembershipCancellation', { membershipId: ID.membership, cancel: true })).toEqual({
              updated: false,
              reason: 'renewal_due_today',
              message: "Today's payment for this membership hasn't gone through yet, so it can't be cancelled until it has. Try again after the payment (the membership will then end at its next renewal).",
            })
          },
        },
        newMembershipSide()
      )
      expect(((recording.tables['audit_log']?.added ?? []) as Row[]).filter((row) => W40_AUDIT_ROWS.has(String(row['action'])))).toEqual([])
      expect(recording.tables['customer_memberships']?.changed ?? []).toEqual([])
      expect(recording.stripeCalls).toEqual([])
      expect(MEMBERSHIP_CANCEL_NEW_WORDS.renewalDueToday).toContain("Today's payment for this membership hasn't gone through yet")
      // The dialog's own sentences are for the four old reasons only: any other reason shows the Worker's words.
      const dialog = readFileSync(path.join(staffAppDir(), 'frontend/components/CancelMembershipDialog.tsx'), 'utf8')
      expect(dialog).not.toContain('renewal_due_today')
      expect(dialog).toContain('(result.reason && FAILURE_MESSAGES[result.reason]) ??\n            result.message ??')
    })
  })

  describe('the comparison catches what it is for', () => {
    const exactCancel = 'w36-cancel-monthly-after-the-minimum-term'
    const exactUndo = 'w36-cancel-then-undo'
    const exactList = 'w36-subscriptions-list-and-search'
    const noSubscription = 'w36-cancel-with-no-subscription'
    type Answer = Record<string, unknown>
    const row = (answer: unknown, change: Answer): Answer => ({ ...(answer as Answer), membership: { ...((answer as Answer)['membership'] as Answer), ...change } })
    const adjusted = (name: string, change: (action: string, answer: Answer, index: number) => unknown) => {
      let index = -1
      return replay(environment, scenario(name), newMembershipSide({ adjust: (action, answer) => (Array.isArray(answer) || answer === null ? answer : change(action, answer as Answer, (index += 1))) }))
    }

    it('a deliberate difference in what staff are told is caught: a last day a day out, an end date, Stripe said to be changed when it was not, a row missing from the list, a field changed or added', async () => {
      expect(paths(exactCancel, await adjusted(exactCancel, (_action, answer) => row(answer, { cancel_effective_date: '2026-12-10' })))).toEqual(['.results[0].membership.cancel_effective_date'])
      expect(paths(exactCancel, await adjusted(exactCancel, (_action, answer) => ({ ...answer, endDate: '2026-12-11' })))).toEqual(['.results[0].endDate'])
      expect(paths(noSubscription, await adjusted(noSubscription, (_action, answer, index) => (index === 0 ? { ...answer, stripeUpdated: true } : answer)))).toEqual(['.results[0].stripeUpdated'])
      expect(paths(exactUndo, await adjusted(exactUndo, (_action, answer, index) => (index === 1 ? row(answer, { cancel_effective_date: '2026-12-09' }) : answer)))).toEqual(['.results[1].membership.cancel_effective_date'])
      const list = await replay(environment, scenario(exactList), newMembershipSide({ adjust: (_action, answer) => (answer as unknown[]).slice(1) }))
      expect(paths(exactList, list).length).toBeGreaterThan(0)
      const field = await replay(environment, scenario(exactList), newMembershipSide({ adjust: (_action, answer) => (answer as Answer[]).map((one) => ({ ...one, next_renewal_date: '2026-12-11' })) }))
      expect(paths(exactList, field)).toContain('.results[0][0].next_renewal_date')
      const extra = await replay(environment, scenario(exactList), newMembershipSide({ adjust: (_action, answer) => (answer as Answer[]).map((one) => ({ ...one, stripe_subscription_id: 'sub_mo' })) }))
      expect(paths(exactList, extra)).toContain('.results[0][0].stripe_subscription_id')
      // `refunded` is pinned to false on these recordings: a row said to be refunded is caught.
      const refunded = await replay(environment, scenario(exactList), newMembershipSide({ adjust: (_action, answer) => (answer as Answer[]).map((one) => ({ ...one, refunded: true })) }))
      expect(paths(exactList, refunded)).toContain('.results[0][0].refunded')
    })

    it('a deliberate difference in the rows is caught: a last day, a status, a credit', async () => {
      for (const [name, tamper, at] of [
        [exactCancel, "UPDATE customer_memberships SET cancel_effective_date = '2026-12-10'", '.tables.customer_memberships.changed[0].cancel_effective_date'],
        [exactCancel, "UPDATE customer_memberships SET subscription_status = 'cancelled'", '.tables.customer_memberships.changed[0].subscription_status'],
        [exactUndo, 'UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining + 1', '.tables.customer_memberships'],
      ] as const) {
        const recording = await replay(environment, scenario(name), newMembershipSide(), {
          async tamper(db) {
            // Test data only: each statement is a literal above.
            await db.query(tamper)
          },
        })
        const found = paths(name, recording)
        expect(found.some((one) => one.startsWith(at)), `${tamper}: ${found.join(', ')}`).toBe(true)
      }
    })

    it("a deliberate difference in what Stripe is sent is caught: another date, a send with proration, a send with no key, a second send, a send with no read before it", async () => {
      const recording = await replay(environment, scenario(exactCancel), newMembershipSide())
      const withCalls = (calls: Recording['stripeCalls']): Recording => ({ ...recording, stripeCalls: calls })
      const [read, send] = recording.stripeCalls as [Recording['stripeCalls'][number], Recording['stripeCalls'][number]]
      expect(recording.stripeCalls.map((call) => call.method)).toEqual(['subscriptions.retrieve', 'subscriptions.update'])
      expect(paths(exactCancel, withCalls([read, { ...send, params: { ...paramsOf(send), cancel_at: 1796860801 } }]))).toEqual(['.stripeCalls[0].params.cancel_at'])
      expect(paths(exactCancel, withCalls([read, { ...send, params: { ...paramsOf(send), proration_behavior: 'create_prorations' } }]))).toEqual(['.stripeCalls[0].params.proration_behavior'])
      // A send with no `proration_behavior`, or with no key, is what the old recording holds, so the comparison has
      // nothing to report there (a pin only bites on a difference): the sends' own check is what catches it.
      const noProration = withCalls([read, { ...send, params: { id: paramsOf(send)['id'], cancel_at: paramsOf(send)['cancel_at'] } }])
      const noKey = withCalls([read, { ...send, idempotencyKey: null }])
      expect(stripeReadProblems(noProration)).toEqual(["stripeCalls[1]: a cancel date sent without proration_behavior 'none'"])
      expect(stripeReadProblems(noKey)).toEqual(['stripeCalls[1]: a cancel date sent with no key'])
      expect(paths(exactCancel, withCalls([read, { ...send, idempotencyKey: 'some-other-key' }]))).toEqual(['.stripeCalls[0].idempotencyKey'])
      expect(paths(exactCancel, withCalls([read, send, read, send]))).toEqual(['.stripeCalls[1]'])
      expect(stripeReadProblems(recording)).toEqual([])
      expect(stripeReadProblems(withCalls([send]))).toEqual(['stripeCalls[0]: a subscription changed without being read first'])
      expect(stripeReadProblems(withCalls([{ ...read, params: { id: 'sub_other' } }, send]))).toHaveLength(1)
    })

    it("a missing or wrong audit row is caught by the rows' own check: none for a change, a cancel_at that is not the end's midnight, a last day that is not the day before, no step, a step for another subscription, a put-back with no closed step, a step ended twice", async () => {
      const audit = (recording: Recording) => (recording.tables['audit_log']?.added ?? []) as Array<Row & { details: Record<string, unknown> }>
      const withAudit = (recording: Recording, rows: Row[]): Recording => ({ ...recording, tables: { ...recording.tables, audit_log: { added: rows, changed: [], removed: [], tied: 0 } } })
      const cancel = await replay(environment, scenario(exactCancel), newMembershipSide())
      expect(membershipRowProblems(cancel)).toEqual([])
      // (The step's rows can share a millisecond on the replay's stopped clock, so their order is not pinned.)
      const kinds = (recording: Recording) => audit(recording).map((one) => `${String(one['action'])} ${String(one.details['state'] ?? '')}`.trim()).sort()
      expect(kinds(cancel)).toEqual(['membership.cancel_scheduled', 'membership.step_left done', 'membership.step_left left'])
      const scheduled = audit(cancel).find((one) => one['action'] === 'membership.cancel_scheduled')
      expect(scheduled?.details).toMatchObject({ channel: 'staff', cancelAt: 1796860800, endDate: '2026-12-10', cancelEffectiveDate: { before: null, after: '2026-12-09' }, subscriptionId: 'sub_mo' })
      expect(scheduled).toMatchObject({ actor_type: 'staff', actor_id: ID.staff, entity_type: 'membership', entity_id: ID.membership })
      const changed = (change: (one: Row & { details: Record<string, unknown> }) => Row) => withAudit(cancel, audit(cancel).map((one) => (one['action'] === 'membership.cancel_scheduled' ? change(one) : one)))
      expect(membershipRowProblems(withAudit(cancel, [])).length).toBeGreaterThan(0)
      expect(membershipRowProblems(withAudit(cancel, audit(cancel).filter((one) => one['action'] !== 'membership.cancel_scheduled'))).length).toBeGreaterThan(0)
      expect(membershipRowProblems(withAudit(cancel, audit(cancel).filter((one) => one['action'] !== 'membership.step_left'))).length).toBeGreaterThan(0)
      expect(membershipRowProblems(changed((one) => ({ ...one, details: { ...one.details, cancelAt: 1796860800 + 3600 } }))).length).toBeGreaterThan(0)
      expect(membershipRowProblems(changed((one) => ({ ...one, details: { ...one.details, cancelEffectiveDate: { before: null, after: '2026-12-10' } } }))).length).toBeGreaterThan(0)
      expect(membershipRowProblems(changed((one) => ({ ...one, details: { ...one.details, subscriptionId: 'sub_other' } }))).length).toBeGreaterThan(0)
      expect(membershipRowProblems(changed((one) => ({ ...one, details: { ...one.details, channel: 'customer' } }))).length).toBeGreaterThan(0)
      expect(membershipRowProblems(changed((one) => ({ ...one, details: { ...one.details, reason: 'x' } }))).length).toBeGreaterThan(0)
      expect(membershipRowProblems(changed((one) => ({ ...one, actor_id: '' }))).length).toBeGreaterThan(0)
      const done = audit(cancel).find((one) => one.details['state'] === 'done') as Row
      expect(membershipRowProblems(withAudit(cancel, [...audit(cancel), { ...done, id: 'audit_log#9' }])).length).toBeGreaterThan(0)
      // Stripe refused: the put-back row needs its step closed.
      const refused = await replay(environment, scenario('w36-cancel-refused-by-stripe'), newMembershipSide())
      expect(membershipRowProblems(refused)).toEqual([])
      expect(kinds(refused)).toEqual(['membership.cancel_put_back', 'membership.cancel_scheduled', 'membership.step_left left', 'membership.step_left undone'])
      expect(membershipRowProblems(withAudit(refused, audit(refused).filter((one) => one.details['state'] !== 'undone'))).length).toBeGreaterThan(0)
      expect(membershipRowProblems(withAudit(refused, audit(refused).filter((one) => one['action'] !== 'membership.cancel_put_back'))).length).toBeGreaterThan(0)
      // The rows set aside are only W40's: any other audit row would show in the comparison.
      expect([...W40_AUDIT_ROWS].sort()).toEqual(['membership.cancel_put_back', 'membership.cancel_scheduled', 'membership.cancel_undone', 'membership.step_left'])
      const stray = withAudit(cancel, [...audit(cancel), { ...(scheduled as Row), action: 'membership.something_else' }])
      expect(paths(exactCancel, stray).some((one) => one.startsWith('.tables.audit_log'))).toBe(true)
    })

    it('a stored answer that is not a finished press of the cancel or the undo route is caught', async () => {
      const recording = await replay(environment, scenario(exactCancel), newMembershipSide())
      const stored = (recording.tables['api_idempotency']?.added ?? []) as Row[]
      expect(stored).toHaveLength(1)
      const withStored = (rows: Row[]): Recording => ({ ...recording, tables: { ...recording.tables, api_idempotency: { added: rows, changed: [], removed: [], tied: 0 } } })
      expect(membershipStoredAnswerProblems(withStored(stored.map((one) => ({ ...one, status: 'in_progress' })))).length).toBe(1)
      expect(membershipStoredAnswerProblems(withStored(stored.map((one) => ({ ...one, endpoint: 'POST /api/v1/staff/orders' })))).length).toBe(1)
    })

    it("an unused allowance fails: one nobody needs, on a scenario that matches exactly and on a decision's; and each decision's own allowance on a scenario that doesn't need it", async () => {
      const stale: AllowedDifference = { name: 'An allowance nobody needs', decision: 'none', path: /^\.results\[0\]\.warning$/ }
      for (const name of [noSubscription, exactCancel, DECISION_SCENARIOS.FB22[0], DECISION_SCENARIOS.FB6[0]]) {
        const recording = await replay(environment, scenario(name), newMembershipSide())
        expect(paths(name, recording, [...named(name), stale]), name).toEqual(['(allowed difference not seen: An allowance nobody needs)'])
      }
      const recording = await replay(environment, scenario(noSubscription), newMembershipSide())
      for (const names of Object.values(DECISION_SCENARIOS)) {
        for (const name of names) {
          const [own] = named(name)
          if (!own) throw new Error(`No named difference for ${name}`)
          expect(paths(noSubscription, recording, [own]), name).toEqual([`(allowed difference not seen: ${own.name})`])
        }
      }
    })

    it('a pinned difference refuses any other value: FB5 a cancel let through after all, another reason or other words; FB6 the old rolled-over date or any other; FB22 a fault; FB20 another reason', async () => {
      // FB5: refused, with the dialog's words, and nothing written.
      const [cancelled, , twice] = DECISION_SCENARIOS.FB5
      expect(paths(cancelled, await adjusted(cancelled, (_action, answer) => ({ ...answer, reason: 'already_cancelling' })))).toEqual(['.results[0].reason'])
      expect(paths(cancelled, await adjusted(cancelled, (_action, answer) => ({ ...answer, message: 'Membership not found' })))).toEqual(['.results[0].message'])
      const written = await replay(environment, scenario(cancelled), newMembershipSide(), {
        async tamper(db) {
          await db.query("UPDATE customer_memberships SET cancel_effective_date = '2026-12-09' WHERE id = $1", [ID.membership])
        },
      })
      // The old recording wrote exactly this date, so the comparison has nothing to report (a pin only bites on a
      // difference): the rows' own check is what refuses a last day written with no audit row.
      expect(membershipRowProblems(written)).toEqual([`membership ${ID.membership}: its last day changed with no cancel or undo row`])
      // A second success is what the old recording holds, so the comparison has nothing to report: the rows' own check
      // counts one cancel row for two presses said to have gone.
      const secondSuccess = await adjusted(twice, (_action, answer, index) => (index === 1 ? { updated: true, membership: { id: ID.membership, cancel_effective_date: '2026-12-09', billing_frequency: 'monthly' }, endDate: '2026-12-10', stripeUpdated: true } : answer))
      expect(membershipRowProblems(secondSuccess)).toEqual(['1 cancel and undo rows for 2 presses that went, 0 Stripe refused and 0 with no answer'])
      // FB6: only the clamped dates.
      const [december] = DECISION_SCENARIOS.FB6
      // (The old rolled-over dates are what the golden file holds, so an answer carrying them shows no difference:
      // "FB6 in pounds and dates" above holds the new side to 28 February itself, and cancel.test.ts the rule.)
      expect(paths(december, await adjusted(december, (_action, answer) => ({ ...answer, endDate: '2027-03-01' })))).toEqual(['.results[0].endDate'])
      expect(paths(december, await adjusted(december, (_action, answer) => row(answer, { cancel_effective_date: '2027-02-28' })))).toEqual(['.results[0].membership.cancel_effective_date'])
      // FB22: plain words and its reason, never a fault's.
      const [noDate] = DECISION_SCENARIOS.FB22
      expect(paths(noDate, await adjusted(noDate, (_action, answer) => ({ ...answer, message: 'Internal server error' })))).toEqual(['.results[0].message'])
      expect(paths(noDate, await adjusted(noDate, (_action, answer) => ({ ...answer, reason: 'internal' })))).toEqual(['.results[0].reason'])
      // FB20: `permission_denied` and the words every staff route gives.
      const [, inactive] = DECISION_SCENARIOS.FB20
      expect(paths(inactive, await adjusted(inactive, (_action, answer) => ({ ...answer, reason: 'something_else' })))).toEqual(['.results[0].reason'])
      expect(paths(inactive, await adjusted(inactive, (_action, answer) => ({ ...answer, message: `${INACTIVE_WORDS}!` })))).toEqual(['.results[0].message'])
    })
  })
})
