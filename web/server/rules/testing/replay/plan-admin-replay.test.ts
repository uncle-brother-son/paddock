import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { pathsPinnedBy } from './admin-differences'
import { answeredStampProblems, comparableAdmin, newAdminSide, STEP_G_ACTIONS_MOVED, W57_ACTIONS, type AnsweredPlanExtra, type AnsweredStamp } from './admin-side'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { isW57Scenario, planDifferences, REFUSED_NOW, W57_DECISIONS, W57_DIFFERING, W57_OWN_AUDIT_ACTIONS } from './plan-differences'
import { w48Scenarios } from './w48-scenarios'

// Brief W57 ("Parity and tests"; G-plan 4.9 items 3 and 4): the membership plan and settings families (W48's
// recordings of the old functions) through the staff app's thin functions and the Worker's routes, as the screens
// press them: the edit dialog's stamp and member count read first, the waiting period's Herd count read first, the
// plan writes with `plan_changes` on and the fake Stripe bound. Every difference is named (plan-differences.ts) and
// each recording's raw differences are held to exactly the paths its names pin.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('./stripe-binding')
  return stripeClientMock(await importOriginal())
})

type AuditRow = Row & { action?: unknown; details?: Record<string, unknown> | null }
/** The Worker's own plan rows (the old functions wrote none): set aside before comparing, and checked on their own. */
const ownRows = (recording: Recording): AuditRow[] => ((recording.tables['audit_log']?.added ?? []) as AuditRow[]).filter((row) => W57_OWN_AUDIT_ACTIONS.has(String(row.action)))
function comparablePlans(recording: Recording): Recording {
  const audit = recording.tables['audit_log']
  if (!audit) return comparableAdmin(recording)
  const kept = (audit.added as AuditRow[]).filter((row) => !W57_OWN_AUDIT_ACTIONS.has(String(row.action)))
  return comparableAdmin({ ...recording, tables: { ...recording.tables, audit_log: { ...audit, added: kept } } })
}
const compareSides = (golden: Recording, recording: Recording, named: readonly AllowedDifference[]) => compareRecordings(comparablePlans(golden), comparablePlans(recording), named)

const everyStepGScenario = w48Scenarios()
const families = everyStepGScenario.filter((scenario) => isW57Scenario(scenario.name))

/** Each of the Worker's own rows: who (a staff member, or reconcile), a request id, and the press's key on a press's own record. */
function ownRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  for (const row of ownRows(recording)) {
    const d = row.details ?? {}
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    if (!['staff', 'system'].includes(String(row['actor_type'])) || typeof row['request_id'] !== 'string') wrong('actor or request id')
    if (row.action === 'plan.details_set' && (!('before' in d) || !('after' in d) || typeof d['key'] !== 'string')) wrong('before, after and the key')
    if (row.action === 'plan.price_change' && d['state'] === 'started' && (typeof d['changeId'] !== 'string' || typeof d['membersToMove'] !== 'number')) wrong('the record: its id and the count')
    if (row.action === 'plan.created' && d['state'] === 'started' && typeof d['key'] !== 'string') wrong("the record's key")
    if (row.action === 'membership_settings.set' && (typeof d['herdFlagsShown'] !== 'number' || typeof d['herdFlagsChanged'] !== 'number')) wrong('both counts')
    if (row.action === 'membership.price_moved' && (typeof d['toPriceId'] !== 'string' || typeof d['stepId'] !== 'string')) wrong('the price and the step')
  }
  return problems
}

describe("step G's side of the replay: membership plans and settings (W57)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  const golden = (name: string) => readGolden(name) as Recording
  const named = (name: string): readonly AllowedDifference[] => planDifferences(name)
  const left = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)
  const rawPaths = (name: string, recording: Recording): string[] => left(name, recording, []).sort()
  const pinnedPaths = (name: string): string[] => named(name).flatMap((difference) => [...pathsPinnedBy(difference)]).sort()

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one: Scenario) => {
    it('matches its golden file, with its named differences only; its own rows and stamps are right', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const stamps: AnsweredStamp[] = []
      const planExtras: AnsweredPlanExtra[] = []
      const recording = await replay(environment, one, newAdminSide({ calls, stamps, planExtras, refusedPressesAsAnswers: REFUSED_NOW.has(name) }))
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => STEP_G_ACTIONS_MOVED.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => W57_ACTIONS.has(call.action) || call.action === 'updateCatalogItemPrice')).toBe(true)
      if (process.env.W57_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W57_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), own: ownRows(recording), ownProblems: ownRowProblems(recording), stamps: answeredStampProblems(stamps), planExtras, results: recording.results, stripeCalls: recording.stripeCalls })}\n`
        )
        return
      }
      expect(ownRowProblems(recording), `${name}: the Worker's own rows`).toEqual([])
      expect(answeredStampProblems(stamps), `${name}: the stamps`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
      expect(rawPaths(name, recording)).toEqual(pinnedPaths(name))
    })
  })

  it('the families are whole: every plan and settings recording W48 made is replayed here, and every named difference is for a recording that exists', () => {
    expect(families.length).toBe(26)
    expect(W57_DIFFERING.every((name) => families.some((one) => one.name === name))).toBe(true)
    // 8 match their golden files exactly; 18 have named differences.
    expect(W57_DIFFERING.length).toBe(18)
    expect(families.filter((one) => !W57_DIFFERING.includes(one.name)).map((one) => one.name).sort()).toEqual(
      [
        'w48-plans-read',
        'w48-plan-create-refusals',
        'w48-plan-details-refusals',
        'w48-plan-details-set-without-a-price-change',
        'w48-membership-settings-read',
        'w48-membership-settings-refusals',
        'w48-membership-settings-refused-no-settings-row',
        'w48-gb19-the-waiting-period-changes-members-herd-flags-with-no-record',
      ].sort()
    )
    expect([...REFUSED_NOW].every((name) => W57_DIFFERING.includes(name))).toBe(true)
    expect(Object.keys(W57_DECISIONS).sort()).toEqual(['ACTIVE', 'GB1_GB2', 'GB19', 'GB20', 'GB20_REFUSED', 'GB2_REFUSED', 'NO_ANSWER', 'Q53_COUNT', 'S3'].sort())
  })

  describe('a deliberate difference is caught', () => {
    it('a price a penny out, a member moved who shouldn\'t be, a Stripe call added: each fails its recording', async () => {
      const gb1 = 'w48-gb1-plan-price-change-moves-every-live-member-and-says-nothing'
      const pennyOut = await replay(environment, families.find((one) => one.name === gb1) as Scenario, newAdminSide({ adjust: (action, answer) => (action === 'setMembershipPlanDetails' ? { ...(answer as object), price_monthly: '44.99' } : answer) }))
      expect(left(gb1, pennyOut)).toEqual(['.results[0].price_monthly'])
      // Yan (yearly) moved as well: an extra Stripe call, caught by the pins.
      const yanMoved = await replay(environment, families.find((one) => one.name === gb1) as Scenario, newAdminSide(), {
        async tamper(_db, stripe) {
          await stripe.subscriptions.update('sub_yan', { items: [{ id: 'si_sub_yan', price: 'price_seed_yearly' }], proration_behavior: 'none' })
        },
      })
      expect(rawPaths(gb1, yanMoved)).not.toEqual(pinnedPaths(gb1))
    })

    it('a recording that matches exactly has no allowance, and every differing recording has one for each of its paths', () => {
      expect(planDifferences('w48-plans-read')).toEqual([])
      for (const name of W57_DIFFERING) expect(() => planDifferences(name), name).not.toThrow()
    })
  })
})
