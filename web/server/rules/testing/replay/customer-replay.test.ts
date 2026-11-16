import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { CREATE_CUSTOMER_WORDS } from '@/server/rules/customers/failure-messages'
import { insert } from '../database'
import { staffAppDir } from '../staff-app-dir'
import { throughStaffApp } from './booking-side'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { DATE_OF_BIRTH_WORDS, DECISION_SCENARIOS, FB16_SCENARIO, FB21_ANOTHER_CASE_SCENARIO, INACTIVE_READ_THROWN, isW39Scenario, NO_STAFF_RECORD_WORDS, NOT_SENT_SCENARIOS, W39_DIFFERENCES } from './customer-differences'
import { comparableCustomers, customerRowProblems, customerStoredAnswerProblems, newCustomerSide, READS_ALREADY_SWITCHED, W39_ACTIONS, W39_AUDIT_ROWS } from './customer-side'
import { oldSide, putBackWhenEmpty, readGolden, replay, restoreSchema, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario } from './harness'
import { sweepInvariants } from './invariants'
import { EMAIL_LOWER_INDEX, ID, liftEmailLowerIndex, restoreEmailLowerIndex, scenarios, W36_ID } from './scenarios'

// W39 (brief item 5): the customer golden families through the staff app's thin wrappers and the Worker's routes, as
// the screens press them.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: Parameters<typeof compareRecordings>[2]) => compareRecordings(comparableCustomers(golden), comparableCustomers(recording), named)

const families = scenarios.filter((scenario) => isW39Scenario(scenario.name))
const sideFor = (name: string, options: Parameters<typeof newCustomerSide>[0] = {}) => newCustomerSide({ ...options, refusedReadsAsAnswers: name === FB16_SCENARIO })
const named = (name: string) => W39_DIFFERENCES.get(name) ?? []
const DUPLICATE = 'A customer with this email address already exists'

/**
 * F-plan 4.12 item 5, on the rows a scenario leaves: no two customers share an email address in any case; and a
 * create never happens twice for one press (one `customer.created` row for each press key answered with a success).
 */
async function customerInvariantProblems(db: Db, pressKeys: boolean): Promise<string[]> {
  const problems: string[] = []
  const shared = await db.query<{ email: string; n: string }>('SELECT lower(email) AS email, count(*)::text AS n FROM customers GROUP BY lower(email) HAVING count(*) > 1 ORDER BY 1')
  for (const one of shared) problems.push(`${one.n} customers share ${one.email}`)
  if (pressKeys) {
    const [made] = await db.query<{ rows: string; presses: string }>(
      `SELECT (SELECT count(*) FROM audit_log WHERE action = 'customer.created')::text AS rows,
              (SELECT count(*) FROM api_idempotency WHERE endpoint = 'POST /api/v1/staff/customers' AND http_status = 200)::text AS presses`
    )
    if (made?.rows !== made?.presses) problems.push(`${made?.rows} customers created for ${made?.presses} presses`)
  }
  return problems
}

/** The one recording that leaves two customers on one address: its own set-up puts the second there, as another writer would. */
const ANOTHER_WRITERS_ROW = [`${FB21_ANOTHER_CASE_SCENARIO}: 2 customers share sam@example.com`]

describe("step F's side of the replay: customers (W39)", () => {
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

  const hasEmailLowerIndex = async () => (await environment.database.pg.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", [EMAIL_LOWER_INDEX])).rows.length > 0
  /**
   * Runs `work` with migration 027's index in the schema (`true`: the migration file itself is applied) or out of it
   * (`false`), whatever the saved schema has, and leaves the schema as saved for the tests after. W39a (review S1):
   * a test here that passes only one way round fails today, not on the day the lead refreshes the saved schema.
   */
  async function withEmailLowerIndex(on: boolean, work: () => Promise<void>): Promise<void> {
    const { pg } = environment.database
    await restoreSchema(environment)
    const saved = await hasEmailLowerIndex()
    if (on) await pg.exec(`RESET ROLE; ${readFileSync(path.resolve(__dirname, '../../../../../supabase/migrations/027_customers_email_unique_in_any_case.sql'), 'utf8')}; SET ROLE paddock_worker;`)
    else await pg.exec(`RESET ROLE; DROP INDEX IF EXISTS public.${EMAIL_LOWER_INDEX}; SET ROLE paddock_worker;`)
    try {
      expect(await hasEmailLowerIndex()).toBe(on)
      await work()
      // Whatever a scenario lifted for its own run is back once its rows are gone.
      await restoreSchema(environment)
      expect(await hasEmailLowerIndex()).toBe(on)
    } finally {
      await restoreSchema(environment)
      if (on && !saved) await pg.exec(`RESET ROLE; DROP INDEX IF EXISTS public.${EMAIL_LOWER_INDEX}; SET ROLE paddock_worker;`)
      if (!on && saved) await restoreEmailLowerIndex(environment.database.db)
    }
  }

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it('matches its golden file, with its named differences only; its audit rows and stored answers are right; the invariants hold', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      let invariants: string[] = ['not checked']
      const recording = await replay(environment, one, sideFor(name, { calls }), {
        async tamper(db) {
          invariants = await customerInvariantProblems(db, true)
        },
      })
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => W39_ACTIONS.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => W39_ACTIONS.has(call.action))).toBe(true)
      if (process.env.W39_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W39_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: customerRowProblems(recording), stored: customerStoredAnswerProblems(recording), invariants, audit: recording.tables['audit_log']?.added ?? [], results: recording.results })}\n`
        )
        return
      }
      expect(customerRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(customerStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(invariants.map((problem) => `${name}: ${problem}`), `${name}: the invariants`).toEqual(name === FB21_ANOTHER_CASE_SCENARIO ? ANOTHER_WRITERS_ROW : [])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
    })
  })

  it('the families are whole: every customer scenario W36 recorded is replayed here (8 create, the list, the detail, and the two recordings that carry them beside other reads), and every named difference is for a scenario that exists', () => {
    expect(families.length).toBe(12)
    expect(families.filter((one) => /^w36-(create-customer|fb21-)/.test(one.name)).length).toBe(8)
    expect(families.filter((one) => /^w36-(customers-list-and-search|customer-detail)$/.test(one.name)).length).toBe(2)
    expect(families.filter((one) => /^w36-(membership-reads-carry-the-payment-date-refusal|fb16-)/.test(one.name)).length).toBe(2)
    expect([...W39_DIFFERENCES.keys()].every((name) => families.some((one) => one.name === name))).toBe(true)
    // 7 match their golden files exactly (the list among them). 5 have named differences: the three bugs, and the two
    // profiles with a membership or a pass, whose rows match field for field but for the one column no longer sent.
    expect(families.filter((one) => !W39_DIFFERENCES.has(one.name)).map((one) => one.name)).toEqual([
      'w36-create-customer',
      'w36-create-customer-refused-missing-or-bad-fields',
      'w36-create-customer-under-18-refused',
      'w36-create-customer-duplicate-email-refused',
      'w36-create-customer-refused-inactive-staff',
      FB21_ANOTHER_CASE_SCENARIO,
      'w36-customers-list-and-search',
    ])
    expect(W39_DIFFERENCES.size).toBe(5)
    expect([...NOT_SENT_SCENARIOS]).toEqual(['w36-customer-detail', 'w36-membership-reads-carry-the-payment-date-refusal'])
    for (const name of NOT_SENT_SCENARIOS) {
      const own = named(name)
      expect(own, name).toHaveLength(1)
      expect(own[0]?.name, name).toMatch(/^Named fields: a membership's and a pass's `order_line_item_id`/)
      expect(own[0]?.decision, name).toMatch(/F-plan 4\.6 \(named fields, not `\*`\); W36's contract/)
    }
    // Every recording named for a customer action, or for FB16 or FB21, is in these families.
    expect(scenarios.filter((one) => /^w36-/.test(one.name) && /create-customer|customers-list|customer-detail|fb16|fb21/.test(one.name) && !isW39Scenario(one.name)).map((one) => one.name)).toEqual([])
  })

  it('FB16, FB21 and FB23 are each named, with their decision, on their own scenarios', () => {
    const NAMES: Record<string, RegExp> = { FB16: /^Bug FB16 is closed for the reads moved so far/, FB21: /^Bug FB21 is closed \(who created a customer\)/, FB23: /^Bug FB23 is closed/ }
    const DECISIONS: Record<string, RegExp> = { FB16: /^Bug FB16 \(F-plan section 3\)/, FB21: /^Bug FB21 \(F-plan section 3\)/, FB23: /^Bug FB23 \(W36 report/ }
    for (const [what, names] of Object.entries(DECISION_SCENARIOS)) {
      for (const name of names) {
        const own = named(name)
        expect(own, name).toHaveLength(1)
        expect(own[0]?.name, name).toMatch(NAMES[what] as RegExp)
        expect(own[0]?.decision, name).toMatch(DECISIONS[what] as RegExp)
      }
    }
    expect(Object.keys(DECISION_SCENARIOS)).toEqual(['FB16', 'FB21', 'FB23'])
    // Every w36-fbN scenario of the customer bugs is one of them, or FB21's second (proved on its seed, below).
    expect(families.filter((one) => /^w36-fb/.test(one.name)).map((one) => one.name).sort()).toEqual([...DECISION_SCENARIOS.FB16, ...DECISION_SCENARIOS.FB21, FB21_ANOTHER_CASE_SCENARIO].sort())
    // FB23's sentence pinned in the differences is the rule's own, and the old function's.
    expect(DATE_OF_BIRTH_WORDS).toBe(CREATE_CUSTOMER_WORDS.dateOfBirthInvalid)
  })

  // W39a (review S1): run both ways round. With 027's index in the schema another writer can't add the second
  // address, so this test's own run lifts it, as the recording it borrows its seed from does.
  it.each([
    ["without migration 027's index (live before it)", false],
    ["with migration 027's index in the schema", true],
  ] as const)("FB21 (the same email in another case), %s: on its recording's seed, an address on file only in capitals: the old function adds it again in lower case (two accounts for one person); the Worker refuses it with the old duplicate words", async (_schema, indexOn) => {
    const anotherWriter = async (db: Db) => {
      await insert(db, 'customers', { first_name: 'Dee', last_name: 'First', email: 'DEE@Example.com', date_of_birth: '1990-01-01' })
    }
    const run = (makeSide: Parameters<typeof replay>[2]) => {
      let invariants: string[] = []
      return replay(
        environment,
        {
          name: 'w39 fb21 another case',
          seed: scenario(FB21_ANOTHER_CASE_SCENARIO).seed,
          async run({ attempt, db }) {
            if (await liftEmailLowerIndex(db)) putBackWhenEmpty(restoreEmailLowerIndex)
            await anotherWriter(db)
            await attempt('createCustomer', { firstName: 'Dee', lastName: 'Dale', email: 'dee@example.com', dateOfBirth: '1992-02-29' })
            await attempt('createCustomer', { firstName: 'Dee', lastName: 'Dale', email: ' Dee@EXAMPLE.com ', dateOfBirth: '1992-02-29' })
          },
        },
        makeSide,
        {
          async tamper(db) {
            invariants = await customerInvariantProblems(db, false)
          },
        }
      ).then((recording) => ({ recording, invariants }))
    }
    await withEmailLowerIndex(indexOn, async () => {
      const old = await run(oldSide)
      expect(old.recording.results[0]).toMatchObject({ email: 'dee@example.com', first_name: 'Dee' })
      expect(old.recording.results[1]).toEqual({ thrown: DUPLICATE })
      expect(old.recording.tables['customers']?.added).toHaveLength(2)
      expect(old.invariants).toEqual(['2 customers share dee@example.com'])
      const fresh = await run(newCustomerSide())
      expect(fresh.recording.results).toEqual([{ thrown: DUPLICATE }, { thrown: DUPLICATE }])
      expect(fresh.recording.tables['customers']?.added).toHaveLength(1)
      expect(fresh.invariants).toEqual([])
      expect(customerRowProblems(fresh.recording)).toEqual([])
    })
  })

  it("the invariant breaks, on either side, only where a recording's own set-up adds the second address as another writer would (FB21); the W05 invariants hold on both sides", async () => {
    const broken: string[] = []
    for (const one of families) {
      await replay(environment, one, oldSide, {
        async tamper(db) {
          for (const problem of await customerInvariantProblems(db, false)) broken.push(`${one.name}: ${problem}`)
        },
      })
    }
    expect(broken).toEqual(ANOTHER_WRITERS_ROW)
    const fresh = await sweepInvariants(
      environment,
      families.filter((one) => one.name !== FB16_SCENARIO),
      newCustomerSide()
    )
    expect(fresh.wrong).toEqual([])
    const old = await sweepInvariants(environment, families, oldSide)
    expect(old.wrong).toEqual([])
    if (process.env.W39_DIFFERENCES_OUT) appendFileSync(process.env.W39_DIFFERENCES_OUT, `${JSON.stringify({ oldSideInvariants: broken })}\n`)
  })

  it("FB16, read by read: the old functions answered an inactive account with the customer list and Sam's profile; the wrappers now throw the Worker's refusal for both, searched or by id; the two reads W40 and W41 move still answer", async () => {
    const old = golden(FB16_SCENARIO)
    expect((old.results[0] as unknown[]).length).toBe(1)
    expect(old.results[1]).toMatchObject({ storeCreditBalance: '30.00' })
    const answers: Record<string, unknown> = {}
    await replay(
      environment,
      {
        name: 'w39 fb16',
        seed: scenario(FB16_SCENARIO).seed,
        async run({ db, side }) {
          for (const [action, params] of [
            ['getCustomers', {}],
            ['getCustomers', { search: 'sam' }],
            ['getCustomers', { customerId: ID.customer }],
            ['getCustomerDetail', { customerId: ID.customer }],
            ['getCustomerDetail', { customerId: W36_ID.unknown }],
          ] as const) {
            answers[`${action} ${JSON.stringify(params)}`] = await throughStaffApp(action)(db, params).then(
              (answer) => answer,
              (err: Error) => ({ thrown: err.message })
            )
          }
          // Not W39's: still the old functions, which still answer (W40 and W41 move them).
          answers['getSubscriptions'] = await side.call('getSubscriptions', {})
          answers['getMembershipPaymentDateQuote'] = await side.call('getMembershipPaymentDateQuote', { membershipId: ID.membership })
        },
      },
      oldSide
    )
    const refused = { thrown: INACTIVE_READ_THROWN }
    expect(answers).toEqual({
      'getCustomers {}': refused,
      'getCustomers {"search":"sam"}': refused,
      [`getCustomers {"customerId":"${ID.customer}"}`]: refused,
      [`getCustomerDetail {"customerId":"${ID.customer}"}`]: refused,
      [`getCustomerDetail {"customerId":"${W36_ID.unknown}"}`]: refused,
      getSubscriptions: expect.any(Array),
      getMembershipPaymentDateQuote: expect.objectContaining({ membershipId: ID.membership }),
    })
    // The whole recording replays with that one named difference, through five wrappers (W37's one, W38's two, W39's two).
    expect([...READS_ALREADY_SWITCHED].sort()).toEqual(['getGiftCardRedemptions', 'getGiftCards', 'getMembershipCreditAdjustments'])
  })

  it("with migration 027's index in the schema (brief W39 item 3), every recording still replays: the old side matches its golden file (the one where another writer adds the address in capitals lifts the index for its own run), and the new side matches with the same named differences", async () => {
    await withEmailLowerIndex(true, async () => {
      for (const one of families) {
        const old = await replay(environment, one, oldSide)
        expect(compareRecordings(golden(one.name), old), `${one.name}: the old side`).toEqual([])
        const fresh = await replay(environment, one, sideFor(one.name))
        expect(compareSides(golden(one.name), fresh, named(one.name)), `${one.name}: the new side`).toEqual([])
        // The index is there again once the scenario's rows are gone: lifted only inside the one scenario that needs it.
        await restoreSchema(environment)
        expect(await hasEmailLowerIndex(), one.name).toBe(true)
      }
      // And it bites: another writer's address in capitals is refused beside the one on file.
      await environment.database.db.query("INSERT INTO customers (first_name, last_name, email, date_of_birth) VALUES ('A', 'B', 'case@example.com', '1990-01-01')")
      await expect(environment.database.db.query("INSERT INTO customers (first_name, last_name, email, date_of_birth) VALUES ('A', 'B', 'CASE@example.com', '1990-01-01')")).rejects.toThrow()
    })
  })

  it("the no-answer words are the staff app's own (shared/accountWorker.ts), and the dialog's copy is the same sentence", () => {
    const backend = readFileSync(path.join(staffAppDir(), 'backend/paddock/shared/accountWorker.ts'), 'utf8')
    const words = /CREATE_CUSTOMER_NO_ANSWER_MESSAGE =\n\s+("(?:[^"\\]|\\.)*")/.exec(backend)?.[1]
    expect(words).toBeDefined()
    expect(readFileSync(path.join(staffAppDir(), 'frontend/components/NewCustomerDialog.tsx'), 'utf8')).toContain(words as string)
    expect(words).toContain("it won't add them twice")
    expect(words).toContain('may or may not have been added')
  })

  describe('the press key, as the dialog holds it', () => {
    const dee = { firstName: 'Dee', lastName: 'Dale', email: 'dee@example.com', dateOfBirth: '1992-02-29' }
    /** The actions through the staff app's wrappers with the key given, on the plain seed. */
    async function pressing(work: (press: (action: string, params: Record<string, unknown>) => Promise<unknown>, db: Db) => Promise<void>): Promise<Recording> {
      return replay(
        environment,
        {
          name: 'w39 press keys',
          seed: scenario('w36-create-customer').seed,
          async run({ db, side }) {
            await work((action, params) => side.call(action, params), db)
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

    it('the same press again under its key gets the first answer and makes one customer; a changed press under that key is "check first"; a new key with the same address is the duplicate refusal, as data', async () => {
      const recording = await pressing(async (press) => {
        const key = crypto.randomUUID()
        const first = (await press('createCustomer', { ...dee, idempotencyKey: key })) as Record<string, unknown>
        expect(first).toMatchObject({ email: 'dee@example.com', first_name: 'Dee', date_of_birth: '1992-02-29', phone: null })
        expect('created' in first).toBe(false)
        expect(await press('createCustomer', { ...dee, idempotencyKey: key })).toEqual(first)
        expect(await press('createCustomer', { ...dee, lastName: 'Dales', idempotencyKey: key })).toEqual({
          created: false,
          reason: 'pressed_after_no_answer',
          message: "The last press didn't get an answer, so this can't be sent as a new one. Close this and search for the customer in the customer list before creating them again.",
          noAnswer: true,
        })
        expect(await press('createCustomer', { ...dee, idempotencyKey: crypto.randomUUID() })).toEqual({ created: false, reason: 'duplicate_email', message: DUPLICATE })
        // With no key from the screen each call is its own press.
        expect(await press('createCustomer', { ...dee, email: 'dee.two@example.com' })).toMatchObject({ email: 'dee.two@example.com' })
      })
      expect((recording.tables['customers']?.added as Row[]).map((row) => row['email'])).toEqual(['dee@example.com', 'dee.two@example.com'])
      expect(recording.tables['api_idempotency']?.added).toHaveLength(3)
      expect(customerRowProblems(recording)).toEqual([])
      expect(customerStoredAnswerProblems(recording)).toEqual([])
    })

    it('the reads store no answer and write no audit row', async () => {
      const recording = await pressing(async (press) => {
        expect(await press('getCustomers', { search: 'sam' })).toHaveLength(1)
        expect(await press('getCustomers', { customerId: ID.customer })).toHaveLength(1)
        expect(await press('getCustomerDetail', { customerId: ID.customer })).toMatchObject({ storeCreditBalance: '30.00' })
      })
      expect(recording.tables).toEqual({})
    })
  })

  describe('the comparison catches what it is for', () => {
    const exactCreate = 'w36-create-customer'
    const exactRefusals = 'w36-create-customer-refused-missing-or-bad-fields'
    const exactDuplicate = 'w36-create-customer-duplicate-email-refused'
    const exactList = 'w36-customers-list-and-search'
    const exactDetail = 'w36-customer-detail'
    type Answer = Record<string, unknown>
    const isObject = (answer: unknown): answer is Answer => answer !== null && typeof answer === 'object' && !Array.isArray(answer)
    const without = (row: Answer, field: string): Answer => Object.fromEntries(Object.entries(row).filter(([name]) => name !== field))

    it('a deliberate difference in what staff are told is caught: an email left in capitals, a phone, a list row missing, a field changed, added or dropped, a profile part emptied, a balance, a membership field', async () => {
      const email = await replay(environment, scenario(exactCreate), sideFor(exactCreate, { adjust: (_action, answer) => ({ ...(answer as Answer), email: 'Dee.Dale@Example.COM' }) }))
      expect(paths(exactCreate, email)).toEqual(['.results[0].email', '.results[1].email'])
      const phone = await replay(environment, scenario(exactCreate), sideFor(exactCreate, { adjust: (_action, answer) => ({ ...(answer as Answer), phone: '' }) }))
      expect(paths(exactCreate, phone)).toEqual(['.results[0].phone', '.results[1].phone'])
      const list = await replay(environment, scenario(exactList), sideFor(exactList, { adjust: (_action, answer) => (answer as unknown[]).slice(1) }))
      expect(paths(exactList, list).length).toBeGreaterThan(0)
      const field = await replay(environment, scenario(exactList), sideFor(exactList, { adjust: (_action, answer) => (answer as Answer[]).map((row) => ({ ...row, saved_card_last4: '0000' })) }))
      expect(paths(exactList, field)).toContain('.results[0][0].saved_card_last4')
      const extra = await replay(environment, scenario(exactList), sideFor(exactList, { adjust: (_action, answer) => (answer as Answer[]).map((row) => ({ ...row, stripe_customer_id: 'cus_x' })) }))
      expect(paths(exactList, extra)).toContain('.results[0][0].stripe_customer_id')
      const dropped = await replay(environment, scenario(exactList), sideFor(exactList, { adjust: (_action, answer) => (answer as Answer[]).map((row) => without(row, 'country')) }))
      expect(paths(exactList, dropped)).toContain('.results[0][0].country')
      const detailOnly = (change: (answer: Answer) => Answer) => (action: string, answer: unknown) => (action === 'getCustomerDetail' && isObject(answer) ? change(answer) : answer)
      const passes = await replay(environment, scenario(exactDetail), sideFor(exactDetail, { adjust: detailOnly((answer) => ({ ...answer, sessionPasses: [] })) }))
      expect(paths(exactDetail, passes)).toEqual(['.results[4].sessionPasses[0]'])
      const balance = await replay(environment, scenario(exactDetail), sideFor(exactDetail, { adjust: detailOnly((answer) => ({ ...answer, storeCreditBalance: '15.01' })) }))
      expect(paths(exactDetail, balance)).toContain('.results[3].storeCreditBalance')
      const blocked = await replay(environment, scenario(exactDetail), sideFor(exactDetail, { adjust: detailOnly((answer) => ({ ...answer, memberships: (answer['memberships'] as Answer[]).map((row) => ({ ...row, payment_date_change_blocked: null })) })) }))
      expect(paths(exactDetail, blocked)).toEqual(['.results[3].memberships[0].payment_date_change_blocked'])
      const column = await replay(environment, scenario(exactDetail), sideFor(exactDetail, { adjust: detailOnly((answer) => ({ ...answer, memberships: (answer['memberships'] as Answer[]).map((row) => without(row, 'plan_id')) })) }))
      expect(paths(exactDetail, column)).toEqual(['.results[3].memberships[0].plan_id'])
      // The one column no longer sent is pinned to nothing: sent after all, with any value but the old one, it is caught.
      const sentAfterAll = await replay(environment, scenario(exactDetail), sideFor(exactDetail, { adjust: detailOnly((answer) => ({ ...answer, memberships: (answer['memberships'] as Answer[]).map((row) => ({ ...row, order_line_item_id: 'another-line' })) })) }))
      expect(paths(exactDetail, sentAfterAll)).toEqual(['.results[3].memberships[0].order_line_item_id'])
    })

    it('a deliberate difference in the rows is caught: an email, a name, a phone, a date of birth, a customer too many', async () => {
      for (const [tamper, expected] of [
        ["UPDATE customers SET email = upper(email) WHERE first_name = 'Dee'", '.tables.customers.added[0].email'],
        ["UPDATE customers SET first_name = ' Dee' WHERE first_name = 'Dee'", '.tables.customers.added[0].first_name'],
        ["UPDATE customers SET phone = '' WHERE email = 'dee.two@example.com'", '.tables.customers.added[1].phone'],
        ["UPDATE customers SET date_of_birth = '1992-03-01' WHERE first_name = 'Dee'", '.tables.customers.added[0].date_of_birth'],
        ["INSERT INTO customers (first_name, last_name, email, date_of_birth) VALUES ('X', 'Y', 'x@example.com', '1990-01-01')", '.tables.customers.added[2]'],
      ] as const) {
        const recording = await replay(environment, scenario(exactCreate), sideFor(exactCreate), {
          async tamper(db) {
            // Test data only: each statement is a literal above.
            await db.query(tamper)
          },
        })
        const found = paths(exactCreate, recording)
        expect(found.some((one) => one.startsWith(expected)), `${tamper}: ${found.join(', ')}`).toBe(true)
      }
    })

    it("a missing or wrong audit row is caught by the rows' own check: none for a customer, one too many, another channel, a field more, no staff member, another customer, a customer nobody made here", async () => {
      const audit = (recording: Recording) => (recording.tables['audit_log']?.added ?? []) as Array<Row & { details: Record<string, unknown> }>
      const withAudit = (recording: Recording, rows: Row[]): Recording => ({ ...recording, tables: { ...recording.tables, audit_log: { added: rows, changed: [], removed: [], tied: 0 } } })
      const created = await replay(environment, scenario(exactCreate), sideFor(exactCreate))
      expect(customerRowProblems(created)).toEqual([])
      expect(audit(created).map((row) => row['action'])).toEqual(['customer.created', 'customer.created'])
      expect(audit(created)[0]).toMatchObject({ actor_type: 'staff', actor_id: ID.staff, entity_type: 'customer', entity_id: (created.results[0] as Answer)['id'], details: { channel: 'staff' } })
      const changed = (change: (row: Row & { details: Record<string, unknown> }) => Row) => withAudit(created, audit(created).map((row, index) => (index === 0 ? change(row) : row)))
      expect(customerRowProblems(withAudit(created, [])).length).toBeGreaterThan(0)
      expect(customerRowProblems(withAudit(created, audit(created).slice(1))).length).toBeGreaterThan(0)
      expect(customerRowProblems(withAudit(created, [...audit(created), { ...audit(created)[0], id: 'audit_log#9' } as Row])).length).toBeGreaterThan(0)
      expect(customerRowProblems(changed((row) => ({ ...row, details: { channel: 'customer' } }))).length).toBeGreaterThan(0)
      expect(customerRowProblems(changed((row) => ({ ...row, details: { ...row.details, email: 'dee.dale@example.com' } }))).length).toBeGreaterThan(0)
      expect(customerRowProblems(changed((row) => ({ ...row, details: {} }))).length).toBeGreaterThan(0)
      expect(customerRowProblems(changed((row) => ({ ...row, actor_id: '' }))).length).toBeGreaterThan(0)
      expect(customerRowProblems(changed((row) => ({ ...row, actor_type: 'customer' }))).length).toBeGreaterThan(0)
      expect(customerRowProblems(changed((row) => ({ ...row, entity_id: (created.results[1] as Answer)['id'] as string }))).length).toBeGreaterThan(0)
      expect(customerRowProblems(changed((row) => ({ ...row, entity_id: ID.customer }))).length).toBeGreaterThan(0)
      // A refusal has none.
      const refused = await replay(environment, scenario(exactDuplicate), sideFor(exactDuplicate))
      expect(audit(refused)).toEqual([])
      expect(customerRowProblems(withAudit(refused, audit(created).slice(0, 1))).length).toBeGreaterThan(0)
      // The rows set aside are only W39's own: any other audit row would show in the comparison.
      expect([...W39_AUDIT_ROWS]).toEqual(['customer.created'])
      const stray = withAudit(created, [...audit(created), { ...audit(created)[0], action: 'customer.something_else' } as Row])
      expect(paths(exactCreate, stray).some((one) => one.startsWith('.tables.audit_log'))).toBe(true)
    })

    it('a stored answer that is not a finished press of the create route is caught', async () => {
      const recording = await replay(environment, scenario(exactCreate), sideFor(exactCreate))
      const stored = (recording.tables['api_idempotency']?.added ?? []) as Row[]
      expect(stored).toHaveLength(2)
      const withStored = (rows: Row[]): Recording => ({ ...recording, tables: { ...recording.tables, api_idempotency: { added: rows, changed: [], removed: [], tied: 0 } } })
      expect(customerStoredAnswerProblems(withStored(stored.map((row) => ({ ...row, status: 'in_progress' })))).length).toBe(2)
      expect(customerStoredAnswerProblems(withStored(stored.map((row) => ({ ...row, endpoint: 'POST /api/v1/staff/orders' })))).length).toBe(2)
    })

    it("an unused allowance fails: one nobody needs, on scenarios that match exactly and on a decision's; and each decision's own allowance on a scenario that doesn't need it", async () => {
      const stale: AllowedDifference = { name: 'An allowance nobody needs', decision: 'none', path: /^\.results\[0\]\.warning$/ }
      for (const name of [exactCreate, exactRefusals, exactList, exactDetail, DECISION_SCENARIOS.FB23[0]]) {
        const recording = await replay(environment, scenario(name), sideFor(name))
        expect(paths(name, recording, [...named(name), stale]), name).toEqual(['(allowed difference not seen: An allowance nobody needs)'])
      }
      const recording = await replay(environment, scenario(exactRefusals), sideFor(exactRefusals))
      for (const names of Object.values(DECISION_SCENARIOS)) {
        for (const name of names) {
          const [own] = named(name)
          if (!own) throw new Error(`No named difference for ${name}`)
          expect(paths(exactRefusals, recording, [own]), name).toEqual([`(allowed difference not seen: ${own.name})`])
        }
      }
    })

    it("a pinned difference refuses any other value: FB23 the database's words or any other sentence; FB21 other words, or the customer made after all; FB16 a read that answers, or other words; and an old refusal with other words", async () => {
      const adjusted = (name: string, change: (action: string, answer: unknown, index: number) => unknown) => {
        let index = -1
        return replay(environment, scenario(name), sideFor(name, { adjust: (action, answer) => change(action, answer, (index += 1)) }))
      }
      /** A create's refusal reaches the comparison as a throw, so it is changed where it is thrown. */
      const rethrown = (name: string, words: string) =>
        replay(environment, scenario(name), (db, stripe) => {
          const side = sideFor(name)(db, stripe)
          return {
            name: 'new',
            async call(action, params) {
              try {
                return await side.call(action, params)
              } catch {
                throw new Error(words)
              }
            },
          }
        })
      // FB23: only the rule's own sentence.
      const [impossible] = DECISION_SCENARIOS.FB23
      // (Its allowance has the one pin, so a wrong value is also reported as the allowance not seen.)
      const [fb23] = named(impossible)
      const unseen = `(allowed difference not seen: ${fb23?.name})`
      // The database's own words are what the golden file holds: no difference there, so the allowance goes unused, which fails.
      expect(paths(impossible, await rethrown(impossible, 'date/time field value out of range: "1990-02-30"'))).toEqual([unseen])
      expect(paths(impossible, await rethrown(impossible, 'date/time field value out of range: "1990-02-31"'))).toEqual(['.results[0].thrown', unseen])
      expect(paths(impossible, await rethrown(impossible, 'Date of birth cannot be in the future'))).toEqual(['.results[0].thrown', unseen])
      // FB21: refused in the words every staff route gives, and nobody made.
      const [noRecord] = DECISION_SCENARIOS.FB21
      expect(paths(noRecord, await rethrown(noRecord, 'This staff account is inactive. Ask an admin to reactivate it.'))).toEqual(['.results[0].thrown'])
      const made = await replay(environment, scenario(noRecord), sideFor(noRecord), {
        async tamper(db) {
          await db.query("INSERT INTO customers (first_name, last_name, email, date_of_birth) VALUES ('Dee', 'Dale', 'dee@example.com', '1992-02-29')")
        },
      })
      // A customer put there by hand is what the old recording itself holds, so the comparison can't object to the
      // row: what bites is the answer (a customer made through the route answers with its row, not the refusal) and
      // the rows' own check (a customer the route made has its audit row and its stored answer).
      expect(paths(noRecord, made)).toEqual(['(allowed difference not seen: ' + named(noRecord)[0]?.name + ')'].slice(1))
      const answered = await replay(environment, scenario(noRecord), (db, stripe) => {
        const side = sideFor(noRecord)(db, stripe)
        return { name: 'new', call: (action, params) => side.call(action, params).catch(() => ({ id: 'customers#1', first_name: 'Dee', last_name: 'Dale', email: 'dee@example.com', phone: null, date_of_birth: '1992-02-29', created_at: '<time>', updated_at: '<time>' })) }
      })
      expect(customerRowProblems(answered)).toEqual(['customer customers#1: answered as created, but no such customer was written'])
      expect(NO_STAFF_RECORD_WORDS).toContain('jo@example.com')
      // FB16: each moved read refused, in the wrapper's own throw.
      const [inactive] = DECISION_SCENARIOS.FB16
      expect(paths(inactive, await adjusted(inactive, (_action, answer, index) => (index === 0 ? [] : answer)))).toEqual(['.results[0][0]'])
      expect(paths(inactive, await adjusted(inactive, (_action, answer, index) => (index === 0 ? { thrown: 'Something else' } : answer)))).toEqual(['.results[0]'])
      expect(paths(inactive, await adjusted(inactive, (_action, answer, index) => (index === 1 ? { thrown: 'Something else' } : answer)))).toEqual(['.results[1].thrown'])
      expect(paths(inactive, await adjusted(inactive, (_action, answer, index) => (index === 1 ? { ...(answer as Answer), storeCreditBalance: '31.00' } : answer)))).toEqual(['.results[1].storeCreditBalance'])
      // And an old refusal keeps the old words exactly.
      expect(paths(exactDuplicate, await rethrown(exactDuplicate, 'A customer with this email address already exists.'))).toEqual(['.results[0].thrown', '.results[1].thrown'])
    })
  })
})
