import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { staffAppDir } from '../staff-app-dir'
import { CREDITS_NO_ANSWER_MESSAGE, FB_SCENARIOS, isW37Scenario, REPEATED_PRESS_SCENARIOS, W37_DIFFERENCES } from './account-differences'
import { accountRowProblems, accountStoredAnswerProblems, comparableAccount, newAccountSide, W37_ACTIONS, W37_AUDIT_ROWS } from './account-side'
import { throughStaffApp } from './booking-side'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { oldSide, readGolden, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario } from './harness'
import { sweepInvariants } from './invariants'
import { ADDON_CREDITS_CHECK, scenarios } from './scenarios'

// W37 (brief item 6): the credits, Herd and store credit golden families through the staff app's thin wrappers and
// the Worker's routes, as the screens press them.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: Parameters<typeof compareRecordings>[2]) => compareRecordings(comparableAccount(golden), comparableAccount(recording), named)

const families = scenarios.filter((scenario) => isW37Scenario(scenario.name))
const sideFor = (name: string, options: Parameters<typeof newAccountSide>[0] = {}) => newAccountSide({ ...options, repeatedPress: REPEATED_PRESS_SCENARIOS.has(name) })
const named = (name: string) => W37_DIFFERENCES.get(name) ?? []

/**
 * F-plan 4.12 item 5, on the rows a scenario leaves: add-on credits never below zero; a period's allocation never
 * below what is used; and credits and store credit never change twice for one press (one adjustment row, and one
 * manual store credit movement, for each press key whose answer was a success).
 */
async function accountInvariantProblems(db: Db, pressKeys: boolean): Promise<string[]> {
  const problems: string[] = []
  const [below] = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM customer_memberships WHERE addon_credits_remaining < 0')
  if (below?.n !== '0') problems.push(`${below?.n} membership(s) with add-on credits below zero`)
  const [over] = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM membership_credit_periods p
     WHERE NOT p.is_unlimited
       AND p.credits_allocated < (SELECT count(*) FROM bookings b WHERE b.credit_period_id = p.id AND b.redemption_source = 'membership_credit' AND b.status <> 'cancelled')`
  )
  if (over?.n !== '0') problems.push(`${over?.n} credit period(s) with more used than allocated`)
  if (pressKeys) {
    const [credits] = await db.query<{ rows: string; presses: string }>(
      `SELECT (SELECT count(*) FROM membership_credit_adjustments)::text AS rows,
              (SELECT count(*) FROM api_idempotency WHERE endpoint LIKE 'POST /api/v1/staff/memberships/%/credits' AND http_status = 200)::text AS presses`
    )
    if (credits?.rows !== credits?.presses) problems.push(`${credits?.rows} credit adjustments for ${credits?.presses} presses`)
    const [storeCredit] = await db.query<{ rows: string; presses: string }>(
      `SELECT (SELECT count(*) FROM store_credit_transactions WHERE reason = 'manual_adjustment')::text AS rows,
              (SELECT count(*) FROM api_idempotency WHERE endpoint LIKE 'POST /api/v1/staff/customers/%/store-credit' AND http_status = 200)::text AS presses`
    )
    if (storeCredit?.rows !== storeCredit?.presses) problems.push(`${storeCredit?.rows} store credit adjustments for ${storeCredit?.presses} presses`)
  }
  return problems
}

describe("step F's side of the replay: credits, Herd and store credit (W37)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  const scenario = (name: string): Scenario => {
    const found = families.find((one) => one.name === name)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const golden = (name: string) => readGolden(name) as Recording
  const paths = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it('matches its golden file, with its named differences only; its audit rows and stored answers are right; the invariants hold', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      let invariants: string[] = ['not checked']
      const recording = await replay(environment, one, sideFor(name, { calls }), {
        async tamper(db) {
          invariants = await accountInvariantProblems(db, true)
        },
      })
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => W37_ACTIONS.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => W37_ACTIONS.has(call.action))).toBe(true)
      if (process.env.W37_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W37_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: accountRowProblems(recording), stored: accountStoredAnswerProblems(recording), invariants, audit: recording.tables['audit_log']?.added ?? [], results: recording.results })}\n`
        )
        return
      }
      expect(accountRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(accountStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(invariants, `${name}: the invariants`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
    })
  })

  it("the families are whole: every credits, Herd and store credit scenario W36 recorded is replayed here (22 and 11), and every named difference is for a scenario that exists", () => {
    expect(families.length).toBe(33)
    expect(families.filter((one) => /^w36-(credits-|fb(7|8|9|10)-)/.test(one.name)).length).toBe(16)
    expect(families.filter((one) => /^w36-(herd-|fb11-)/.test(one.name)).length).toBe(6)
    expect(families.filter((one) => /^w36-(store-credit-|fb12-)/.test(one.name)).length).toBe(11)
    expect([...W37_DIFFERENCES.keys()].every((name) => families.some((one) => one.name === name))).toBe(true)
    // 13 match their golden files exactly; 20 have named differences (12 who-may and refused-as-data, 8 for the bugs).
    expect(families.filter((one) => !W37_DIFFERENCES.has(one.name)).length).toBe(13)
    expect(W37_DIFFERENCES.size).toBe(20)
    // Every scenario that calls one of the four old functions is in these families: none is left on the old code.
    expect(scenarios.filter((one) => /^w36-/.test(one.name) && !isW37Scenario(one.name) && /credits|herd|store-credit/.test(one.name)).map((one) => one.name)).toEqual([])
  })

  it('bugs FB7 to FB12 are each named, with their decision, on their own scenarios', () => {
    for (const [bug, names] of Object.entries(FB_SCENARIOS)) {
      for (const name of names) {
        const own = named(name)
        expect(own, name).toHaveLength(1)
        expect(own[0]?.name, name).toMatch(new RegExp(`^Bug ${bug} is closed`))
        expect(own[0]?.decision, name).toMatch(new RegExp(`^Bug ${bug} \\(F-plan section 3`))
      }
    }
    expect(Object.keys(FB_SCENARIOS)).toEqual(['FB7', 'FB8', 'FB9', 'FB10', 'FB11', 'FB12'])
    // And every w36-fbN scenario of those six bugs is one of them.
    expect(families.filter((one) => /^w36-fb/.test(one.name)).map((one) => one.name).sort()).toEqual(Object.values(FB_SCENARIOS).flat().sort())
  })

  it('the old side breaks the invariants exactly where the bugs are recorded (FB7: more used than allocated; FB10: below zero), and the W05 invariants hold on both sides', async () => {
    const broken: string[] = []
    for (const one of families) {
      await replay(environment, one, oldSide, {
        async tamper(db) {
          for (const problem of await accountInvariantProblems(db, false)) broken.push(`${one.name}: ${problem}`)
        },
      })
    }
    expect(broken).toEqual([`${FB_SCENARIOS.FB7[1]}: 1 credit period(s) with more used than allocated`, `${FB_SCENARIOS.FB10[0]}: 1 membership(s) with add-on credits below zero`])
    const fresh = await sweepInvariants(environment, families, newAccountSide())
    expect(fresh.wrong).toEqual([])
    const old = await sweepInvariants(environment, families, oldSide)
    expect(old.wrong).toEqual([])
    if (process.env.W37_DIFFERENCES_OUT) appendFileSync(process.env.W37_DIFFERENCES_OUT, `${JSON.stringify({ oldSideInvariants: broken })}\n`)
  })

  it("with migration 025's check in the schema (brief W37 item 4), every recording still replays: the old side matches its golden file (the one that goes below zero lifts the check for its own run), and the new side matches with the same named differences", async () => {
    const { pg } = environment.database
    const migration = readFileSync(path.resolve(__dirname, '../../../../../supabase/migrations/025_customer_memberships_addon_credits_not_below_zero.sql'), 'utf8')
    const hasCheck = async () => (await pg.query('SELECT convalidated FROM pg_constraint WHERE conname = $1', [ADDON_CREDITS_CHECK])).rows as Array<{ convalidated: boolean }>
    const already = (await hasCheck()).length > 0
    await pg.exec(`RESET ROLE; TRUNCATE public.customer_memberships CASCADE; ${migration}; SET ROLE paddock_worker;`)
    try {
      expect(await hasCheck()).toHaveLength(1)
      for (const one of families) {
        const old = await replay(environment, one, oldSide)
        expect(compareRecordings(golden(one.name), old), `${one.name}: the old side`).toEqual([])
        const fresh = await replay(environment, one, sideFor(one.name))
        expect(compareSides(golden(one.name), fresh, named(one.name)), `${one.name}: the new side`).toEqual([])
        // The check is still there after each, lifted only inside the one scenario that needs it.
        expect(await hasCheck(), one.name).toHaveLength(1)
      }
      // And it bites: the old function's own statement is refused.
      await expect(environment.database.db.query('UPDATE customer_memberships SET addon_credits_remaining = -1')).rejects.toThrow()
    } finally {
      // Left as the saved schema has it, for the tests after this one.
      if (!already) await pg.exec(`RESET ROLE; ALTER TABLE public.customer_memberships DROP CONSTRAINT IF EXISTS ${ADDON_CREDITS_CHECK}; SET ROLE paddock_worker;`)
    }
  })

  it("the no-answer words pinned for FB8 are the staff app's own (shared/accountWorker.ts), and the dialog's copy is the same sentence", () => {
    const backend = readFileSync(path.join(staffAppDir(), 'backend/paddock/shared/accountWorker.ts'), 'utf8')
    const dialog = readFileSync(path.join(staffAppDir(), 'frontend/components/MembershipCreditDialog.tsx'), 'utf8')
    for (const source of [backend, dialog]) expect(source).toContain(JSON.stringify(CREDITS_NO_ANSWER_MESSAGE))
    // The store credit dialog's copy of its own sentence, likewise.
    const storeCredit = /STORE_CREDIT_NO_ANSWER_MESSAGE =\n\s+("(?:[^"\\]|\\.)*")/.exec(backend)?.[1]
    expect(storeCredit).toBeDefined()
    expect(readFileSync(path.join(staffAppDir(), 'frontend/components/AdjustStoreCreditDialog.tsx'), 'utf8')).toContain(storeCredit as string)
  })

  describe('the press key, as the screens hold it', () => {
    /** The four actions through the staff app's wrappers with the key given, on a scenario's seed. */
    async function pressing(work: (press: (action: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>, db: Db) => Promise<void>): Promise<Recording> {
      return replay(
        environment,
        {
          name: 'w37 press keys',
          seed: scenario('w36-store-credit-add').seed,
          async run({ db, side }) {
            await work(async (action, params) => (await side.call(action, params)) as Record<string, unknown>, db)
          },
        },
        (db, stripe): ReplaySide => {
          oldSide(db, stripe)
          let tick = 0
          return {
            name: 'new',
            async call(action, params) {
              vi.setSystemTime(Date.now() + (tick += 1))
              return throughStaffApp(action)(db, params)
            },
          }
        }
      )
    }
    const MEMBERSHIP = '10000000-0000-4000-8000-000000000010'
    const CUSTOMER = '10000000-0000-4000-8000-000000000005'

    it('a changed press under the key of an earlier one is not taken as a new one: "check first", and nothing more moves (credits and store credit)', async () => {
      const recording = await pressing(async (press) => {
        const key = crypto.randomUUID()
        const first = await press('adjustMembershipCredits', { membershipId: MEMBERSHIP, creditType: 'session', amount: 2, reason: 'Goodwill', idempotencyKey: key })
        expect(first).toMatchObject({ adjusted: true, period: { credits_allocated: 6 } })
        const changed = await press('adjustMembershipCredits', { membershipId: MEMBERSHIP, creditType: 'session', amount: 3, reason: 'Goodwill', idempotencyKey: key })
        expect(changed).toEqual({ adjusted: false, reason: 'pressed_after_no_answer', message: "The last press didn't get an answer, so this can't be sent as a new one. Close this and check the Adjustment History before adjusting again.", noAnswer: true })
        const creditKey = crypto.randomUUID()
        expect(await press('adjustCustomerStoreCredit', { customerId: CUSTOMER, mode: 'add', amount: 20, reason: 'Goodwill gesture', idempotencyKey: creditKey })).toMatchObject({ ok: true, balance: 50 })
        expect(await press('adjustCustomerStoreCredit', { customerId: CUSTOMER, mode: 'add', amount: 25, reason: 'Goodwill gesture', idempotencyKey: creditKey })).toEqual({
          ok: false,
          reason: 'pressed_after_no_answer',
          message: "The last press didn't get an answer, so this can't be sent as a new one. Close this and check the customer's store credit history before adjusting again.",
          noAnswer: true,
        })
      })
      expect(recording.tables['membership_credit_adjustments']?.added).toHaveLength(1)
      expect(recording.tables['membership_credit_periods']?.changed[0]).toMatchObject({ credits_allocated: [4, 6] })
      expect(recording.tables['store_credit_transactions']?.added).toHaveLength(1)
      expect(recording.tables['customers']?.changed[0]).toMatchObject({ store_credit_balance: ['30.00', '50.00'] })
    })

    it('Herd: the same press again under its key gets the first answer and writes one audit row; a new key writes another', async () => {
      const recording = await pressing(async (press) => {
        const key = crypto.randomUUID()
        const first = await press('setMembershipHerd', { membershipId: MEMBERSHIP, herd: false, idempotencyKey: key })
        expect(first).toMatchObject({ updated: true, membership: { is_herd: false, herd_override: false } })
        expect(await press('setMembershipHerd', { membershipId: MEMBERSHIP, herd: false, idempotencyKey: key })).toEqual(first)
        expect(await press('setMembershipHerd', { membershipId: MEMBERSHIP, herd: null, idempotencyKey: crypto.randomUUID() })).toMatchObject({ updated: true, membership: { is_herd: true, herd_override: null } })
      })
      const herd = ((recording.tables['audit_log']?.added ?? []) as Row[]).filter((row) => row['action'] === 'membership.herd_set')
      expect(herd.map((row) => (row['details'] as { herd: unknown }).herd)).toEqual([false, null])
      expect(recording.tables['api_idempotency']?.added).toHaveLength(2)
    })

    it('each write press stores one answer under its key; the history read stores none', async () => {
      const recording = await replay(environment, scenario('w36-credits-session-up-and-down-with-the-history'), sideFor('w36-credits-session-up-and-down-with-the-history'))
      const stored = (recording.tables['api_idempotency']?.added ?? []) as Row[]
      expect(stored).toHaveLength(2)
      expect(stored.every((row) => /^POST \/api\/v1\/staff\/memberships\/[^/]+\/credits$/.test(String(row['endpoint'])) && row['status'] === 'done' && row['http_status'] === 200)).toBe(true)
      expect(new Set(stored.map((row) => row['key'])).size).toBe(2)
    })
  })

  describe('the comparison catches what it is for', () => {
    const exactCredits = 'w36-credits-session-up-and-down-with-the-history'
    const exactAddon = 'w36-credits-addon-up-and-down'
    const exactHerd = 'w36-herd-off-then-cleared-goes-back-to-the-automatic-rule'
    const exactStoreCredit = 'w36-store-credit-remove'
    type Answer = Record<string, unknown>

    it('a deliberate difference in what staff are told is caught: a credit out, an add-on credit out, a penny of store credit, the Herd flag, a history row missing', async () => {
      const period = await replay(environment, scenario(exactCredits), sideFor(exactCredits, { adjust: (action, answer) => (action === 'adjustMembershipCredits' ? { ...(answer as Answer), period: { ...((answer as Answer)['period'] as Answer), credits_allocated: 99 } } : answer) }))
      expect(paths(exactCredits, period)).toEqual(['.results[1].period.credits_allocated', '.results[2].period.credits_allocated'])
      const addon = await replay(environment, scenario(exactAddon), sideFor(exactAddon, { adjust: (action, answer) => (action === 'adjustMembershipCredits' ? { ...(answer as Answer), addon_credits_remaining: Number((answer as Answer)['addon_credits_remaining']) + 1 } : answer) }))
      expect(paths(exactAddon, addon)).toEqual(['.results[0].addon_credits_remaining', '.results[1].addon_credits_remaining'])
      const penny = await replay(environment, scenario(exactStoreCredit), sideFor(exactStoreCredit, { adjust: (_action, answer) => ({ ...(answer as Answer), balance: 20.01 }) }))
      expect(paths(exactStoreCredit, penny)).toEqual(['.results[0].balance'])
      const herd = await replay(environment, scenario(exactHerd), sideFor(exactHerd, { adjust: (_action, answer) => ({ ...(answer as Answer), membership: { ...((answer as Answer)['membership'] as Answer), is_herd: true } }) }))
      expect(paths(exactHerd, herd)).toEqual(['.results[0].membership.is_herd'])
      const history = await replay(environment, scenario(exactCredits), sideFor(exactCredits, { adjust: (action, answer) => (action === 'getMembershipCreditAdjustments' ? (answer as unknown[]).slice(0, 1) : answer) }))
      expect(paths(exactCredits, history)).toEqual(['.results[3][1]'])
    })

    it('a deliberate difference in the rows is caught: an allocation, an add-on balance, the record, the store credit balance, its movement, and a Herd flag left wrong', async () => {
      for (const [name, tamper, path] of [
        [exactCredits, 'UPDATE membership_credit_periods SET credits_allocated = credits_allocated + 1', '.tables.membership_credit_periods.changed[0].credits_allocated'],
        [exactCredits, "UPDATE membership_credit_adjustments SET reason = 'Another reason' WHERE amount = 2", '.tables.membership_credit_adjustments.added[0].reason'],
        [exactCredits, 'UPDATE membership_credit_adjustments SET amount = 3 WHERE amount = 2', '.tables.membership_credit_adjustments.added[0].amount'],
        [exactCredits, 'UPDATE membership_credit_adjustments SET staff_id = NULL WHERE amount = 2', '.tables.membership_credit_adjustments.added[0].staff_id'],
        [exactAddon, 'UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining + 1', '.tables.customer_memberships.changed[0].addon_credits_remaining'],
        [exactStoreCredit, 'UPDATE customers SET store_credit_balance = store_credit_balance + 0.01 WHERE store_credit_balance = 20', '.tables.customers.changed[0].store_credit_balance'],
        [exactStoreCredit, "UPDATE store_credit_transactions SET amount = amount - 0.01 WHERE reason = 'manual_adjustment'", '.tables.store_credit_transactions.added[0].amount'],
        [exactStoreCredit, "UPDATE store_credit_transactions SET note = 'Another note' WHERE reason = 'manual_adjustment'", '.tables.store_credit_transactions.added[0].note'],
        [exactHerd, 'UPDATE customer_memberships SET is_herd = false, herd_override = false', '.tables.customer_memberships'],
      ] as const) {
        const recording = await replay(environment, scenario(name), sideFor(name), {
          async tamper(db) {
            // Test data only: each statement is a literal above.
            await db.query(tamper)
          },
        })
        const found = paths(name, recording)
        // A changed row's field is reported with its before and after beneath it, so the field's path is a prefix.
        expect(found.some((one) => one.startsWith(path)), `${tamper}: ${found.join(', ')}`).toBe(true)
      }
    })

    it("a missing or wrong audit row is caught by the rows' own check: none for a change, one for a change that never happened, a figure out, another staff member, a Herd change unrecorded", async () => {
      const credits = await replay(environment, scenario(exactCredits), sideFor(exactCredits))
      const audit = (recording: Recording) => (recording.tables['audit_log']?.added ?? []) as Array<Row & { details: Record<string, unknown> }>
      const withAudit = (recording: Recording, rows: Row[]): Recording => ({ ...recording, tables: { ...recording.tables, audit_log: { added: rows, changed: [], removed: [], tied: 0 } } })
      expect(accountRowProblems(credits)).toEqual([])
      expect(audit(credits).map((row) => row['action'])).toEqual(['membership.credits_adjusted', 'membership.credits_adjusted'])
      expect(accountRowProblems(withAudit(credits, audit(credits).slice(1))).length).toBeGreaterThan(0)
      expect(accountRowProblems(withAudit(credits, [...audit(credits), { ...audit(credits)[0], id: 'audit_log#9' } as Row])).length).toBeGreaterThan(0)
      expect(accountRowProblems(withAudit(credits, audit(credits).map((row, index) => (index === 0 ? { ...row, details: { ...row.details, after: 7 } } : row)))).length).toBeGreaterThan(0)
      expect(accountRowProblems(withAudit(credits, audit(credits).map((row, index) => (index === 0 ? { ...row, actor_id: 'someone-else' } : row)))).length).toBeGreaterThan(0)
      expect(accountRowProblems(withAudit(credits, audit(credits).map((row, index) => (index === 0 ? { ...row, details: { ...row.details, reason: 'Another reason' } } : row)))).length).toBeGreaterThan(0)
      const herd = await replay(environment, scenario(exactHerd), sideFor(exactHerd))
      expect(accountRowProblems(herd)).toEqual([])
      expect(accountRowProblems(withAudit(herd, audit(herd).slice(1))).length).toBeGreaterThan(0)
      expect(accountRowProblems(withAudit(herd, audit(herd).map((row, index) => (index === 0 ? { ...row, details: { ...row.details, after: { isHerd: true, override: false } } } : row)))).length).toBeGreaterThan(0)
      const storeCredit = await replay(environment, scenario(exactStoreCredit), sideFor(exactStoreCredit))
      expect(accountRowProblems(storeCredit)).toEqual([])
      expect(accountRowProblems(withAudit(storeCredit, [])).length).toBeGreaterThan(0)
      expect(accountRowProblems(withAudit(storeCredit, audit(storeCredit).map((row) => ({ ...row, details: { ...row.details, balanceAfter: 21 } })))).length).toBeGreaterThan(0)
      // The rows set aside are only the three W37 writes': any other audit row would show in the comparison.
      expect([...W37_AUDIT_ROWS].sort()).toEqual(['customer.store_credit_adjusted', 'membership.credits_adjusted', 'membership.herd_set'])
      const stray = withAudit(storeCredit, [...audit(storeCredit), { ...audit(storeCredit)[0], action: 'customer.something_else' } as Row])
      expect(paths(exactStoreCredit, stray).some((one) => one.startsWith('.tables.audit_log'))).toBe(true)
    })

    it('a stored answer that is not a finished press of one of the three write routes is caught', async () => {
      const recording = await replay(environment, scenario(exactStoreCredit), sideFor(exactStoreCredit))
      const stored = (recording.tables['api_idempotency']?.added ?? []) as Row[]
      expect(stored).toHaveLength(1)
      const withStored = (rows: Row[]): Recording => ({ ...recording, tables: { ...recording.tables, api_idempotency: { added: rows, changed: [], removed: [], tied: 0 } } })
      expect(accountStoredAnswerProblems(withStored(stored.map((row) => ({ ...row, status: 'in_progress' })))).length).toBe(1)
      expect(accountStoredAnswerProblems(withStored(stored.map((row) => ({ ...row, endpoint: 'POST /api/v1/staff/orders' })))).length).toBe(1)
    })

    it('an unused allowance fails: one nobody needs, on scenarios that match exactly and on a bug\'s; and each bug\'s own allowance on a scenario that doesn\'t need it', async () => {
      const stale: AllowedDifference = { name: 'An allowance nobody needs', decision: 'none', path: /^\.results\[0\]\.warning$/ }
      for (const name of [exactCredits, exactStoreCredit, exactHerd, FB_SCENARIOS.FB9[0]]) {
        const recording = await replay(environment, scenario(name), sideFor(name))
        expect(paths(name, recording, [...named(name), stale]), name).toEqual(['(allowed difference not seen: An allowance nobody needs)'])
      }
      const recording = await replay(environment, scenario(exactCredits), sideFor(exactCredits))
      for (const names of Object.values(FB_SCENARIOS)) {
        for (const name of names) {
          const [own] = named(name)
          if (!own) throw new Error(`No named difference for ${name}`)
          expect(paths(exactCredits, recording, [own]), name).toEqual([`(allowed difference not seen: ${own.name})`])
        }
      }
    })

    it('a pinned difference refuses any other value: FB7 a credit out or the booking taken after all; FB8 other words or a change kept; FB9 and FB12 a second go; FB10 another reason; FB11 Herd left on; a refusal with another reason or other words', async () => {
      const adjusted = (name: string, change: (action: string, answer: Answer, index: number) => Answer) => {
        let index = -1
        return replay(environment, scenario(name), sideFor(name, { adjust: (action, answer) => (Array.isArray(answer) || answer === null ? answer : change(action, answer as Answer, (index += 1))) }))
      }
      // FB7: the two answers are pinned to 5 and 7.
      const [both, booking] = FB_SCENARIOS.FB7
      expect(paths(both, await adjusted(both, (_action, answer, index) => (index === 1 ? { ...answer, period: { ...(answer['period'] as Answer), credits_allocated: 8 } } : answer)))).toEqual(['.results[1].period.credits_allocated'])
      // FB7: the booking must be refused, for having no credit.
      const taken = await replay(environment, scenario(booking), sideFor(booking))
      const answered = (change: Answer): Recording => ({ ...taken, results: taken.results.map((answer) => ((answer as Answer | null)?.['reason'] === 'insufficient_membership_credit' ? { ...(answer as Answer), ...change } : answer)) })
      expect(paths(booking, answered({ success: true }))).toEqual(['.results[1].success'])
      expect(paths(booking, answered({ reason: 'session_full' }))).toEqual(['.results[1].reason'])
      // FB7: and a booking that did take the credit shows as more used than allocated (the invariant every scenario is held to).
      let overdrawn: string[] = []
      await replay(environment, scenario(booking), sideFor(booking), {
        async tamper(db) {
          await db.query("UPDATE bookings SET credit_period_id = '10000000-0000-4000-8000-000000000021', redemption_source = 'membership_credit' WHERE id = (SELECT id FROM bookings LIMIT 1)")
          await db.query(
            `INSERT INTO bookings (session_id, customer_id, party_size, status, price_paid, redemption_source, redeemed_membership_id, credit_period_id, start_time, end_time)
             SELECT s.id, '10000000-0000-4000-8000-00000000000f', 1, 'confirmed', 0, 'membership_credit', '10000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000021', s.start_time, s.end_time
             FROM sessions s WHERE s.id = '10000000-0000-4000-8000-000000000004'`
          )
          overdrawn = await accountInvariantProblems(db, true)
        },
      })
      expect(overdrawn).toEqual(['1 credit period(s) with more used than allocated'])
      // FB8: the no-answer words are pinned, and no change may be kept.
      const [record] = FB_SCENARIOS.FB8
      expect(paths(record, await adjusted(record, (_action, answer, index) => (index === 0 ? { ...answer, message: `${CREDITS_NO_ANSWER_MESSAGE} Or try again.` } : answer)))).toEqual(['.results[0].message'])
      const kept = await replay(environment, scenario(record), sideFor(record), {
        async tamper(db) {
          await db.query('UPDATE membership_credit_periods SET credits_allocated = credits_allocated + 2')
        },
      })
      expect(paths(record, kept).some((one) => one.startsWith('.tables.membership_credit_periods'))).toBe(true)
      // FB9 and FB12: the second press must answer what the first did. (The old recording's own figures there, 8
      // allocated and £70, are the golden file's, so the comparison can't object to them: the rules' own tests hold
      // "the same press twice changes once", in credits.test.ts and store-credit.test.ts, and so do the invariants
      // above, which count one change for each press key.)
      const [twice] = FB_SCENARIOS.FB9
      expect(paths(twice, await adjusted(twice, (_action, answer, index) => (index === 1 ? { ...answer, period: { ...(answer['period'] as Answer), credits_allocated: 7 } } : answer)))).toEqual(['.results[1].period.credits_allocated'])
      const [gave] = FB_SCENARIOS.FB12
      expect(paths(gave, await adjusted(gave, (_action, answer, index) => (index === 1 ? { ...answer, balance: 60 } : answer)))).toEqual(['.results[1].balance'])
      // FB10: refused, as `addon_below_zero` and `reason_required` only.
      const [belowZero, noReason] = FB_SCENARIOS.FB10
      expect(paths(belowZero, await adjusted(belowZero, (_action, answer) => ({ ...answer, reason: 'something_else' })))).toEqual(['.results[0].reason'])
      expect(paths(noReason, await adjusted(noReason, (_action, answer, index) => (index === 1 ? { ...answer, reason: 'something_else' } : answer)))).toEqual(['.results[1].reason'])
      // FB11: the member must not be left Herd.
      const [clear] = FB_SCENARIOS.FB11
      expect(paths(clear, await adjusted(clear, (_action, answer, index) => (index === 1 ? { ...answer, membership: { ...(answer['membership'] as Answer), is_herd: true } } : answer)))).toEqual(['.results[1].membership'])
      // A refusal as data: only its own reason and the old words.
      const unlimited = 'w36-credits-session-refused-unlimited-plan'
      expect(paths(unlimited, await adjusted(unlimited, (_action, answer) => ({ ...answer, reason: 'something_else' })))).toEqual(['.results[0].reason'])
      expect(paths(unlimited, await adjusted(unlimited, (_action, answer) => ({ ...answer, message: 'This membership is unlimited.' })))).toEqual(['.results[0].message'])
      const denied = 'w36-store-credit-refused-without-issue-refunds'
      expect(paths(denied, await adjusted(denied, (_action, answer) => ({ ...answer, ok: true })))).toEqual(['.results[0].ok'])
    })
  })
})
