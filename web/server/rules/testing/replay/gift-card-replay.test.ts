import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { GIFT_CARD_EXTEND_NEW_WORDS } from '@/server/rules/gift-cards/failure-messages'
import { staffAppDir } from '../staff-app-dir'
import { throughStaffApp } from './booking-side'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { DECISION_SCENARIOS, INACTIVE_WORDS, isW38Scenario, NO_STAFF_RECORD_WORDS, REPEATED_PRESS_SCENARIOS, VOIDED_BY_REFUND_WORDS, W38_DIFFERENCES } from './gift-card-differences'
import { comparableGiftCards, giftCardRowProblems, giftCardStoredAnswerProblems, newGiftCardSide, W38_ACTIONS, W38_AUDIT_ROWS } from './gift-card-side'
import { oldSide, readGolden, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario } from './harness'
import { sweepInvariants } from './invariants'
import { ID, scenarios, W36_ID } from './scenarios'

// W38 (brief item 5): the gift card golden families through the staff app's thin wrappers and the Worker's routes, as
// the screens press them.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: Parameters<typeof compareRecordings>[2]) => compareRecordings(comparableGiftCards(golden), comparableGiftCards(recording), named)

const families = scenarios.filter((scenario) => isW38Scenario(scenario.name))
const sideFor = (name: string, options: Parameters<typeof newGiftCardSide>[0] = {}) => newGiftCardSide({ ...options, repeatedPress: REPEATED_PRESS_SCENARIOS.has(name) })
const named = (name: string) => W38_DIFFERENCES.get(name) ?? []

/**
 * F-plan 4.12 item 5, on the rows a scenario leaves: a card voided by a refund, or by a move to store credit, stays
 * unusable (no card that isn't voided has a refunded order line or a `migrated_from_gift_card` movement); and an
 * extension never happens twice for one press (one `gift_card.extended` row for each press key answered with a
 * success).
 */
async function giftCardInvariantProblems(db: Db, pressKeys: boolean): Promise<string[]> {
  const problems: string[] = []
  const [usable] = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM gift_cards gc
     WHERE gc.voided IS NOT TRUE
       AND (EXISTS (SELECT 1 FROM order_line_items oli WHERE oli.gift_card_id = gc.id AND oli.item_type = 'gift_card' AND oli.refunded_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM store_credit_transactions sct WHERE sct.gift_card_id = gc.id AND sct.reason = 'migrated_from_gift_card'))`
  )
  if (usable?.n !== '0') problems.push(`${usable?.n} gift card(s) usable after their order was refunded or their balance was moved to store credit`)
  if (pressKeys) {
    const [extended] = await db.query<{ rows: string; presses: string }>(
      `SELECT (SELECT count(*) FROM audit_log WHERE action = 'gift_card.extended')::text AS rows,
              (SELECT count(*) FROM api_idempotency WHERE endpoint LIKE 'POST /api/v1/staff/gift-cards/%/extend' AND http_status = 200)::text AS presses`
    )
    if (extended?.rows !== extended?.presses) problems.push(`${extended?.rows} extensions for ${extended?.presses} presses`)
  }
  return problems
}

describe("step F's side of the replay: gift cards (W38)", () => {
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
    it('matches its golden file, with its named differences only; its audit rows and stored answers are right; the invariants hold', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      let invariants: string[] = ['not checked']
      const recording = await replay(environment, one, sideFor(name, { calls }), {
        async tamper(db) {
          invariants = await giftCardInvariantProblems(db, true)
        },
      })
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => W38_ACTIONS.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => W38_ACTIONS.has(call.action))).toBe(true)
      if (process.env.W38_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W38_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: giftCardRowProblems(recording), stored: giftCardStoredAnswerProblems(recording), invariants, audit: recording.tables['audit_log']?.added ?? [], results: recording.results })}\n`
        )
        return
      }
      expect(giftCardRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(giftCardStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(invariants, `${name}: the invariants`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
    })
  })

  it('the families are whole: every gift card scenario W36 recorded is replayed here (12 extend, 6 picked up and shipped, 2 reads), and every named difference is for a scenario that exists', () => {
    expect(families.length).toBe(20)
    expect(families.filter((one) => /^w36-(gift-card-extend-|fb(13|14|15)-)/.test(one.name)).length).toBe(12)
    expect(families.filter((one) => /^w36-gift-card-(picked-up|shipped|flags)-/.test(one.name)).length).toBe(6)
    expect(families.filter((one) => /^w36-(gift-cards-list-and-search|gift-card-redemptions)$/.test(one.name)).length).toBe(2)
    expect([...W38_DIFFERENCES.keys()].every((name) => families.some((one) => one.name === name))).toBe(true)
    // 12 match their golden files exactly; 8 have named differences (3 who-may, 5 for Q46, Q47, FB15 and FB24).
    expect(families.filter((one) => !W38_DIFFERENCES.has(one.name)).length).toBe(12)
    expect(W38_DIFFERENCES.size).toBe(8)
    // Every scenario that calls one of the five old functions is in these families, but for FB16's (held below).
    expect(scenarios.filter((one) => /^w36-/.test(one.name) && !isW38Scenario(one.name) && /gift-card/.test(one.name)).map((one) => one.name)).toEqual([])
  })

  it('Q46, Q47, FB15 and FB24 are each named, with their decision, on their own scenarios', () => {
    const NAMES: Record<string, RegExp> = { Q46: /^Wayne's Q46 \(bug FB13 is closed\)/, Q47: /^Wayne's Q47 \(bug FB14/, FB15: /^Bug FB15 is closed/, FB24: /^Bug FB24 is closed/ }
    const DECISIONS: Record<string, RegExp> = { Q46: /^Wayne's Q46, 15 Nov \(bug FB13/, Q47: /^Wayne's Q47, 15 Nov \(bug FB14/, FB15: /^Bug FB15 \(F-plan section 3\)/, FB24: /^Bug FB24 \(W36 report/ }
    for (const [what, names] of Object.entries(DECISION_SCENARIOS)) {
      for (const name of names) {
        const own = named(name)
        expect(own, name).toHaveLength(1)
        expect(own[0]?.name, name).toMatch(NAMES[what] as RegExp)
        expect(own[0]?.decision, name).toMatch(DECISIONS[what] as RegExp)
      }
    }
    expect(Object.keys(DECISION_SCENARIOS)).toEqual(['Q46', 'Q47', 'FB15', 'FB24'])
    // And every w36-fbN scenario of the gift card bugs is one of them.
    expect(families.filter((one) => /^w36-fb/.test(one.name)).map((one) => one.name).sort()).toEqual([...DECISION_SCENARIOS.Q46, DECISION_SCENARIOS.Q47[1], ...DECISION_SCENARIOS.FB15].sort())
    // Q46's sentence pinned in the differences is the rule's own.
    expect(VOIDED_BY_REFUND_WORDS).toBe(GIFT_CARD_EXTEND_NEW_WORDS.voidedByRefund)
  })

  it('the old side breaks the invariant exactly where the bug is recorded (FB13: a refunded card usable again), and the W05 invariants hold on both sides', async () => {
    const broken: string[] = []
    for (const one of families) {
      await replay(environment, one, oldSide, {
        async tamper(db) {
          for (const problem of await giftCardInvariantProblems(db, false)) broken.push(`${one.name}: ${problem}`)
        },
      })
    }
    expect(broken).toEqual([`${DECISION_SCENARIOS.Q46[0]}: 1 gift card(s) usable after their order was refunded or their balance was moved to store credit`])
    const fresh = await sweepInvariants(environment, families, newGiftCardSide())
    expect(fresh.wrong).toEqual([])
    const old = await sweepInvariants(environment, families, oldSide)
    expect(old.wrong).toEqual([])
    if (process.env.W38_DIFFERENCES_OUT) appendFileSync(process.env.W38_DIFFERENCES_OUT, `${JSON.stringify({ oldSideInvariants: broken })}\n`)
  })

  it('FB16: on the recording of "every read answers an inactive staff member", the two gift card reads (and the credit history W37 switched) now refuse, where the old functions answered; a read a later slice moves still answers', async () => {
    const name = 'w36-fb16-every-read-answers-an-inactive-staff-member'
    const old = golden(name)
    // What the old functions gave an inactive account: the whole list, and the card's history.
    expect((old.results[3] as unknown[]).length).toBe(1)
    expect(Array.isArray(old.results[4])).toBe(true)
    const answers: Record<string, unknown> = {}
    await replay(
      environment,
      {
        name: 'w38 fb16',
        seed: scenario(name).seed,
        async run({ db, side }) {
          for (const [action, params] of [
            ['getGiftCards', {}],
            ['getGiftCards', { search: 'seed' }],
            ['getGiftCardRedemptions', { giftCardId: ID.giftCard }],
            ['getMembershipCreditAdjustments', { membershipId: ID.membership }],
          ] as const) {
            answers[`${action} ${JSON.stringify(params)}`] = await throughStaffApp(action)(db, params).then(
              (answer) => answer,
              (err: Error) => ({ thrown: err.message })
            )
          }
          // Not W38's: still the old function, which still answers (W39 moves it).
          answers['getCustomers'] = await side.call('getCustomers', { search: 'sam' })
        },
      },
      oldSide
    )
    const refused = { thrown: `${INACTIVE_WORDS} (FORBIDDEN)` }
    expect(answers).toEqual({
      'getGiftCards {}': refused,
      'getGiftCards {"search":"seed"}': refused,
      [`getGiftCardRedemptions {"giftCardId":"${ID.giftCard}"}`]: refused,
      [`getMembershipCreditAdjustments {"membershipId":"${ID.membership}"}`]: refused,
      getCustomers: expect.any(Array),
    })
  })

  it("the no-answer words are the staff app's own (shared/accountWorker.ts), and the dialog's copy is the same sentence", () => {
    const backend = readFileSync(path.join(staffAppDir(), 'backend/paddock/shared/accountWorker.ts'), 'utf8')
    const extend = /GIFT_CARD_EXTEND_NO_ANSWER_MESSAGE =\n\s+("(?:[^"\\]|\\.)*")/.exec(backend)?.[1]
    expect(extend).toBeDefined()
    expect(readFileSync(path.join(staffAppDir(), 'frontend/components/ExtendGiftCardDialog.tsx'), 'utf8')).toContain(extend as string)
    expect(extend).toContain("it won't add the months twice")
    expect(extend).toContain('may or may not have changed')
  })

  describe('the press key, as the screens hold it', () => {
    /** The actions through the staff app's wrappers with the key given, on a scenario's seed. */
    async function pressing(work: (press: (action: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>, db: Db) => Promise<void>): Promise<Recording> {
      return replay(
        environment,
        {
          name: 'w38 press keys',
          seed: scenario('w36-gift-card-picked-up-and-back').seed,
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
    const extended = (recording: Recording) => ((recording.tables['audit_log']?.added ?? []) as Row[]).filter((row) => row['action'] === 'gift_card.extended')

    it('the same press again under its key gets the first answer and extends once; a changed press under that key is "check first"; a new key extends again', async () => {
      const recording = await pressing(async (press) => {
        const key = crypto.randomUUID()
        const first = await press('extendGiftCardExpiry', { giftCardId: ID.giftCard, extendByMonths: 1, idempotencyKey: key })
        expect(first).toEqual({ updated: true, giftCard: { id: ID.giftCard, expiry_date: '2030-02-01', voided: false } })
        expect(await press('extendGiftCardExpiry', { giftCardId: ID.giftCard, extendByMonths: 1, idempotencyKey: key })).toEqual(first)
        expect(await press('extendGiftCardExpiry', { giftCardId: ID.giftCard, extendByMonths: 2, idempotencyKey: key })).toEqual({
          updated: false,
          reason: 'pressed_after_no_answer',
          message: "The last press didn't get an answer, so this can't be sent as a new one. Close this and check the card's expiry date in the list before extending again.",
          noAnswer: true,
        })
        expect(await press('extendGiftCardExpiry', { giftCardId: ID.giftCard, extendByMonths: 2, idempotencyKey: crypto.randomUUID() })).toMatchObject({ updated: true, giftCard: { expiry_date: '2030-04-01' } })
      })
      expect(recording.tables['gift_cards']?.changed).toEqual([{ id: ID.giftCard, expiry_date: ['2030-01-01', '2030-04-01'] }])
      expect(extended(recording).map((row) => (row['details'] as { months: number }).months)).toEqual([1, 2])
      expect(recording.tables['api_idempotency']?.added).toHaveLength(2)
      expect(giftCardRowProblems(recording)).toEqual([])
    })

    it('picked up and shipped: with no key from the screen each call is its own press, each with its audit row and its stored answer; the reads store none', async () => {
      const recording = await pressing(async (press) => {
        expect(await press('setGiftCardPickedUp', { giftCardId: W36_ID.pickupCard, pickedUp: true })).toMatchObject({ updated: true, giftCard: { picked_up: true, picked_up_by: ID.staff } })
        expect(await press('setGiftCardPickedUp', { giftCardId: W36_ID.pickupCard, pickedUp: true })).toMatchObject({ updated: true, giftCard: { picked_up: true, picked_up_by: ID.staff } })
        expect(await press('setGiftCardShipped', { giftCardId: W36_ID.shippedCard, shipped: true })).toMatchObject({ updated: true, giftCard: { shipped_by: ID.staff } })
        await press('getGiftCards', {})
        await press('getGiftCardRedemptions', { giftCardId: ID.giftCard })
      })
      const stored = (recording.tables['api_idempotency']?.added ?? []) as Row[]
      expect(stored).toHaveLength(3)
      expect(new Set(stored.map((row) => row['key'])).size).toBe(3)
      const audit = ((recording.tables['audit_log']?.added ?? []) as Row[]).map((row) => row['action'])
      expect(audit).toEqual(['gift_card.picked_up', 'gift_card.picked_up', 'gift_card.shipped'])
      expect(giftCardRowProblems(recording)).toEqual([])
      expect(giftCardStoredAnswerProblems(recording)).toEqual([])
    })
  })

  describe('the comparison catches what it is for', () => {
    const exactExtend = 'w36-gift-card-extend-an-active-card'
    const exactUnvoid = 'w36-gift-card-extend-a-voided-card-un-voids-it'
    const exactPickedUp = 'w36-gift-card-picked-up-and-back'
    const exactShipped = 'w36-gift-card-shipped-and-back'
    const exactList = 'w36-gift-cards-list-and-search'
    const exactHistory = 'w36-gift-card-redemptions'
    type Answer = Record<string, unknown>
    const card = (answer: unknown, change: Answer): Answer => ({ ...(answer as Answer), giftCard: { ...((answer as Answer)['giftCard'] as Answer), ...change } })

    it('a deliberate difference in what staff are told is caught: an expiry a day out, a card left voided, a flag, who set it, a list row missing, a field changed or added, a history row missing', async () => {
      const day = await replay(environment, scenario(exactExtend), sideFor(exactExtend, { adjust: (_action, answer) => card(answer, { expiry_date: '2030-07-02' }) }))
      expect(paths(exactExtend, day)).toEqual(['.results[0].giftCard.expiry_date'])
      const voided = await replay(environment, scenario(exactUnvoid), sideFor(exactUnvoid, { adjust: (_action, answer) => card(answer, { voided: true }) }))
      expect(paths(exactUnvoid, voided)).toEqual(['.results[0].giftCard.voided'])
      const flag = await replay(environment, scenario(exactPickedUp), sideFor(exactPickedUp, { adjust: (_action, answer) => card(answer, { picked_up: true }) }))
      expect(paths(exactPickedUp, flag)).toEqual(['.results[1].giftCard.picked_up'])
      const who = await replay(environment, scenario(exactShipped), sideFor(exactShipped, { adjust: (_action, answer) => card(answer, { shipped_by: null }) }))
      expect(paths(exactShipped, who)).toEqual(['.results[0].giftCard.shipped_by'])
      const list = await replay(environment, scenario(exactList), sideFor(exactList, { adjust: (_action, answer) => (answer as unknown[]).slice(1) }))
      expect(paths(exactList, list).length).toBeGreaterThan(0)
      const field = await replay(environment, scenario(exactList), sideFor(exactList, { adjust: (_action, answer) => (answer as Answer[]).map((row) => ({ ...row, purchaser_email: row['purchaser_email'] === null ? null : 'someone@example.com' })) }))
      expect(paths(exactList, field)).toContain('.results[0][1].purchaser_email')
      const extra = await replay(environment, scenario(exactList), sideFor(exactList, { adjust: (_action, answer) => (answer as Answer[]).map((row) => ({ ...row, secret: 'x' })) }))
      expect(paths(exactList, extra)).toContain('.results[0][0].secret')
      const history = await replay(environment, scenario(exactHistory), sideFor(exactHistory, { adjust: (action, answer) => (action === 'getGiftCardRedemptions' ? [] : answer) }))
      expect(paths(exactHistory, history)).toEqual(['.results[2][0]'])
    })

    it('a deliberate difference in the rows is caught: an expiry, a card left voided, a balance, a flag, who', async () => {
      for (const [name, tamper, path] of [
        [exactExtend, 'UPDATE gift_cards SET expiry_date = expiry_date + 1', '.tables.gift_cards.changed[0].expiry_date'],
        [exactUnvoid, 'UPDATE gift_cards SET voided = true', '.tables.gift_cards.changed[0].voided'],
        [exactExtend, 'UPDATE gift_cards SET remaining_balance = remaining_balance + 0.01', '.tables.gift_cards.changed[0].remaining_balance'],
        [exactPickedUp, "UPDATE gift_cards SET picked_up = true WHERE code = 'PICKUP01'", '.tables.gift_cards'],
        [exactShipped, "UPDATE gift_cards SET shipped_by = '10000000-0000-4000-8000-000000000001' WHERE code = 'SHIPPED1'", '.tables.gift_cards'],
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

    it("a missing or wrong audit row is caught by the rows' own check: none for a change, one too many, a date out, another card, no staff member, a field more, a flag unrecorded", async () => {
      const audit = (recording: Recording) => (recording.tables['audit_log']?.added ?? []) as Array<Row & { details: Record<string, unknown> }>
      const withAudit = (recording: Recording, rows: Row[]): Recording => ({ ...recording, tables: { ...recording.tables, audit_log: { added: rows, changed: [], removed: [], tied: 0 } } })
      const extend = await replay(environment, scenario(exactExtend), sideFor(exactExtend))
      expect(giftCardRowProblems(extend)).toEqual([])
      expect(audit(extend).map((row) => row['action'])).toEqual(['gift_card.extended'])
      expect(audit(extend)[0]?.details).toEqual({ months: 6, expiryBefore: '2030-01-01', expiryAfter: '2030-07-01', countedFrom: 'expiry', voidedBefore: false })
      expect(audit(extend)[0]).toMatchObject({ actor_type: 'staff', actor_id: ID.staff, entity_type: 'gift_card', entity_id: ID.giftCard })
      const changed = (change: (row: Row & { details: Record<string, unknown> }) => Row) => withAudit(extend, audit(extend).map(change))
      expect(giftCardRowProblems(withAudit(extend, [])).length).toBeGreaterThan(0)
      expect(giftCardRowProblems(withAudit(extend, [...audit(extend), { ...audit(extend)[0], id: 'audit_log#9' } as Row])).length).toBeGreaterThan(0)
      expect(giftCardRowProblems(changed((row) => ({ ...row, details: { ...row.details, expiryAfter: '2030-07-02' } }))).length).toBeGreaterThan(0)
      expect(giftCardRowProblems(changed((row) => ({ ...row, details: { ...row.details, expiryBefore: '2029-12-31' } }))).length).toBeGreaterThan(0)
      expect(giftCardRowProblems(changed((row) => ({ ...row, details: { ...row.details, months: 0 } }))).length).toBeGreaterThan(0)
      expect(giftCardRowProblems(changed((row) => ({ ...row, details: { ...row.details, countedFrom: 'issue' } }))).length).toBeGreaterThan(0)
      expect(giftCardRowProblems(changed((row) => ({ ...row, details: { ...row.details, code: 'SEEDCARD' } }))).length).toBeGreaterThan(0)
      expect(giftCardRowProblems(changed((row) => ({ ...row, actor_id: '' }))).length).toBeGreaterThan(0)
      expect(giftCardRowProblems(changed((row) => ({ ...row, entity_id: W36_ID.pickupCard }))).length).toBeGreaterThan(0)
      const pickedUp = await replay(environment, scenario(exactPickedUp), sideFor(exactPickedUp))
      expect(giftCardRowProblems(pickedUp)).toEqual([])
      expect(audit(pickedUp).map((row) => (row.details as { pickedUp: boolean }).pickedUp)).toEqual([true, false])
      expect(giftCardRowProblems(withAudit(pickedUp, audit(pickedUp).slice(1))).length).toBeGreaterThan(0)
      expect(giftCardRowProblems(withAudit(pickedUp, audit(pickedUp).map((row, index) => (index === 1 ? { ...row, details: { ...row.details, before: { pickedUp: true, at: null, by: null } } } : row)))).length).toBeGreaterThan(0)
      const shipped = await replay(environment, scenario(exactShipped), sideFor(exactShipped))
      expect(giftCardRowProblems(shipped)).toEqual([])
      expect(giftCardRowProblems(withAudit(shipped, [])).length).toBeGreaterThan(0)
      // The rows set aside are only the three W38 writes': any other audit row would show in the comparison.
      expect([...W38_AUDIT_ROWS].sort()).toEqual(['gift_card.extended', 'gift_card.picked_up', 'gift_card.shipped'])
      const stray = withAudit(extend, [...audit(extend), { ...audit(extend)[0], action: 'gift_card.something_else' } as Row])
      expect(paths(exactExtend, stray).some((one) => one.startsWith('.tables.audit_log'))).toBe(true)
    })

    it('a stored answer that is not a finished press of one of the three write routes is caught', async () => {
      const recording = await replay(environment, scenario(exactExtend), sideFor(exactExtend))
      const stored = (recording.tables['api_idempotency']?.added ?? []) as Row[]
      expect(stored).toHaveLength(1)
      const withStored = (rows: Row[]): Recording => ({ ...recording, tables: { ...recording.tables, api_idempotency: { added: rows, changed: [], removed: [], tied: 0 } } })
      expect(giftCardStoredAnswerProblems(withStored(stored.map((row) => ({ ...row, status: 'in_progress' })))).length).toBe(1)
      expect(giftCardStoredAnswerProblems(withStored(stored.map((row) => ({ ...row, endpoint: 'POST /api/v1/staff/orders' })))).length).toBe(1)
    })

    it("an unused allowance fails: one nobody needs, on scenarios that match exactly and on a decision's; and each decision's own allowance on a scenario that doesn't need it", async () => {
      const stale: AllowedDifference = { name: 'An allowance nobody needs', decision: 'none', path: /^\.results\[0\]\.warning$/ }
      for (const name of [exactExtend, exactPickedUp, exactList, DECISION_SCENARIOS.FB15[0]]) {
        const recording = await replay(environment, scenario(name), sideFor(name))
        expect(paths(name, recording, [...named(name), stale]), name).toEqual(['(allowed difference not seen: An allowance nobody needs)'])
      }
      const recording = await replay(environment, scenario(exactExtend), sideFor(exactExtend))
      for (const names of Object.values(DECISION_SCENARIOS)) {
        for (const name of names) {
          const [own] = named(name)
          if (!own) throw new Error(`No named difference for ${name}`)
          expect(paths(exactExtend, recording, [own]), name).toEqual([`(allowed difference not seen: ${own.name})`])
        }
      }
    })

    it('a pinned difference refuses any other value: Q46 the card reactivated after all, other words, or the card left usable; Q47 another date; FB15 a second month; FB24 a flag cleared; a refusal with another reason or other words', async () => {
      const adjusted = (name: string, change: (action: string, answer: Answer, index: number) => Answer) => {
        let index = -1
        return replay(environment, scenario(name), sideFor(name, { adjust: (action, answer) => (Array.isArray(answer) || answer === null ? answer : change(action, answer as Answer, (index += 1))) }))
      }
      // Q46: refused, as `voided_by_refund`, with the rule's sentence; and the card must stay voided.
      const [refunded] = DECISION_SCENARIOS.Q46
      // (`updated: true` alone is what the golden file holds, so the reason, the words and the card's own row are what bite.)
      expect(paths(refunded, await adjusted(refunded, (_action, answer) => ({ ...answer, reason: 'voided' })))).toEqual(['.results[2].reason'])
      expect(paths(refunded, await adjusted(refunded, (_action, answer) => ({ ...answer, message: 'This gift card is voided.' })))).toEqual(['.results[2].message'])
      let usable: string[] = []
      const unvoided = await replay(environment, scenario(refunded), sideFor(refunded), {
        async tamper(db) {
          await db.query('UPDATE gift_cards SET voided = false WHERE id <> $1', [ID.giftCard])
          usable = await giftCardInvariantProblems(db, true)
        },
      })
      // A card left un-voided is what the old recording itself holds, so the comparison can't object to it: the
      // invariant every scenario is held to is what catches it (and the rule's own tests, in admin.test.ts).
      expect(paths(refunded, unvoided)).toEqual([])
      expect(usable).toEqual(['1 gift card(s) usable after their order was refunded or their balance was moved to store credit'])
      // Q47: the dates are pinned to a month from today.
      const [justExpired, longExpired] = DECISION_SCENARIOS.Q47
      expect(paths(justExpired, await adjusted(justExpired, (_action, answer) => card(answer, { expiry_date: '2026-12-11' })))).toEqual(['.results[0].giftCard.expiry_date'])
      expect(paths(longExpired, await adjusted(longExpired, (_action, answer) => card(answer, { expiry_date: '2026-11-10' })))).toEqual(['.results[0].giftCard.expiry_date'])
      // FB15: the second press must answer what the first did.
      const [twice] = DECISION_SCENARIOS.FB15
      expect(paths(twice, await adjusted(twice, (_action, answer, index) => (index === 1 ? card(answer, { expiry_date: '2030-02-02' }) : answer)))).toEqual(['.results[1].giftCard.expiry_date'])
      // FB24: every press refused, and neither flag cleared.
      const [noRecord] = DECISION_SCENARIOS.FB24
      expect(paths(noRecord, await adjusted(noRecord, (_action, answer, index) => (index === 1 ? { ...answer, reason: 'something_else' } : answer)))).toEqual(['.results[1].reason'])
      expect(paths(noRecord, await adjusted(noRecord, (_action, answer, index) => (index === 3 ? { ...answer, message: INACTIVE_WORDS } : answer)))).toEqual(['.results[3].message'])
      const cleared = await replay(environment, scenario(noRecord), sideFor(noRecord), {
        async tamper(db) {
          await db.query('UPDATE gift_cards SET picked_up = false, picked_up_at = NULL, picked_up_by = NULL WHERE id = $1', [W36_ID.pickupCard])
        },
      })
      expect(paths(noRecord, cleared).some((one) => one.startsWith('.tables.gift_cards'))).toBe(true)
      // A refusal as data: only `permission_denied` and the words every staff route gives.
      const inactive = 'w36-gift-card-extend-refused-inactive-staff'
      expect(paths(inactive, await adjusted(inactive, (_action, answer) => ({ ...answer, reason: 'something_else' })))).toEqual(['.results[0].reason'])
      expect(paths(inactive, await adjusted(inactive, (_action, answer) => ({ ...answer, message: NO_STAFF_RECORD_WORDS })))).toEqual(['.results[0].message'])
      // And the old reasons with no words keep none.
      const months = 'w36-gift-card-extend-refused-months-not-a-whole-number-above-zero'
      expect(paths(months, await adjusted(months, (_action, answer, index) => (index === 0 ? { ...answer, message: 'Enter a whole number of months from 1 to 120.' } : answer)))).toEqual(['.results[0].message'])
    })
  })
})
