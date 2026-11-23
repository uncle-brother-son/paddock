import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as historyRoute } from '@/app/api/v1/staff/memberships/[membershipId]/credit-adjustments/route'
import { POST as creditsRoute } from '@/app/api/v1/staff/memberships/[membershipId]/credits/route'
import { POST as herdRoute } from '@/app/api/v1/staff/memberships/[membershipId]/herd/route'
import type { Db } from '@/server/db'
import { ISSUE_REFUNDS_NEEDED_MESSAGE } from '@/server/rules/bookings/failure-messages'
import { insert } from '@/server/rules/testing/database'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, seed, W36_ID, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { HERD_RULE_SQL } from './credits'
import { HERD_NOT_FOUND_MESSAGE, MEMBERSHIP_CREDIT_DIALOG_WORDS, MEMBERSHIP_CREDIT_NEW_WORDS, MEMBERSHIP_CREDIT_WORDS } from './failure-messages'

vi.setConfig({ testTimeout: 30_000 })

// Brief W37 items 2, 3 and 7: the credits, credit history and Herd routes on the replay's live schema (its triggers
// and constraints included): every refusal with its words, the boundaries (below used, below zero), a repeated press,
// a record that fails, and Herd on, off and cleared, with each audit row.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const KEY = 'test-staff-api-key'
const NO_REFUNDS = 'front.desk@example.com'
const INACTIVE = 'gone@example.com'
const NO_REFUNDS_ID = '10000000-0000-4000-8000-000000000f01'

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

/** The seed (Mo's Core membership: 4 session credits allocated this period, none used; 2 add-on credits; Herd by the rule), and two more staff. */
async function seeded(work: () => Promise<void>, prepare?: (seedDb: Db) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w37 credits',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await insert(seedDb, 'staff', { id: NO_REFUNDS_ID, first_name: 'Fran', last_name: 'Desk', email: NO_REFUNDS, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        await insert(seedDb, 'staff', { first_name: 'Gone', last_name: 'Away', email: INACTIVE, role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: false })
        await prepare?.(seedDb)
      },
      run: work,
    },
    workerSide()
  )
}

type ErrorBody = { code: string; message: string; field?: string; details?: { reason?: string; message?: string; action?: string } }
type Answer = { status: number; replayed: boolean; body: { ok: boolean; data?: Record<string, unknown>; error?: ErrorBody } }

async function send(route: 'credits' | 'herd', membershipId: string, body: unknown, { email = REPLAY_USER.email, key = crypto.randomUUID() as string | null, staffKey = KEY as string | null } = {}): Promise<Answer> {
  const handler = route === 'credits' ? creditsRoute : herdRoute
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  const response = await handler(
    new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/${route}`, {
      method: 'POST',
      headers: { ...(staffKey ? { authorization: `Bearer ${staffKey}` } : {}), 'x-staff-email': email, ...(key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ membershipId }) }
  )
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', body: (await response.json()) as Answer['body'] }
}
const adjust = (body: unknown, options?: Parameters<typeof send>[3], membershipId: string = ID.membership) => send('credits', membershipId, body, options)
const herd = (value: unknown, options?: Parameters<typeof send>[3], membershipId: string = ID.membership) => send('herd', membershipId, { herd: value }, options)

async function history(membershipId: string, { email = REPLAY_USER.email } = {}): Promise<{ status: number; body: { ok: boolean; data?: Array<Record<string, unknown>>; error?: ErrorBody } }> {
  const response = await historyRoute(new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/credit-adjustments`, { headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email } }), {
    params: Promise.resolve({ membershipId }),
  })
  return { status: response.status, body: (await response.json()) as { ok: boolean; data?: Array<Record<string, unknown>>; error?: ErrorBody } }
}

const refusal = (answer: Answer) => `${answer.status} ${answer.body.error?.code} ${answer.body.error?.details?.reason}: ${answer.body.error?.message}`
const GOOD = { creditType: 'session', amount: 1, reason: 'Goodwill after a cold sauna' }

interface State {
  allocated: number
  addon: number
  isHerd: boolean
  override: boolean | null
  adjustments: Array<{ credit_type: string; amount: number; reason: string; staff_id: string | null }>
  audit: Array<{ action: string; actor_id: string; details: Record<string, unknown> }>
}
async function state(membershipId: string = ID.membership): Promise<State> {
  const [membership] = await db.query<{ addon: number; is_herd: boolean; herd_override: boolean | null }>('SELECT addon_credits_remaining AS addon, is_herd, herd_override FROM customer_memberships WHERE id = $1', [membershipId])
  const [period] = await db.query<{ allocated: number }>('SELECT credits_allocated AS allocated FROM membership_current_credits WHERE membership_id = $1', [membershipId])
  const adjustments = await db.query<State['adjustments'][number]>('SELECT credit_type, amount, reason, staff_id::text AS staff_id FROM membership_credit_adjustments WHERE membership_id = $1 ORDER BY created_at, id', [membershipId])
  const audit = await db.query<State['audit'][number]>(`SELECT action, actor_id, details FROM audit_log WHERE entity_type = 'membership' AND entity_id = $1 ORDER BY at, ctid`, [membershipId])
  return { allocated: period?.allocated ?? -1, addon: membership?.addon ?? -1, isHerd: membership?.is_herd ?? false, override: membership?.herd_override ?? null, adjustments, audit }
}
const UNTOUCHED: State = { allocated: 4, addon: 2, isHerd: true, override: null, adjustments: [], audit: [] }

/** A booking of Mo's paid with a session credit of this period (as New Order writes one), on a day of its own. */
async function creditBooking(day: number): Promise<void> {
  const start = `2026-11-${String(day).padStart(2, '0')} 10:00:00+00`
  const end = `2026-11-${String(day).padStart(2, '0')} 11:00:00+00`
  const session = await insert(db, 'sessions', { service_type_id: ID.serviceType, start_time: start, end_time: end, type: 'public', capacity: 10, band_id: ID.band })
  await insert(db, 'bookings', { session_id: session, customer_id: ID.member, party_size: 1, status: 'confirmed', price_paid: '0', redemption_source: 'membership_credit', start_time: start, end_time: end, redeemed_membership_id: ID.membership, credit_period_id: ID.creditPeriod })
}

describe('the credits route: who may', () => {
  it('no key, a wrong key, no staff record and an inactive account are refused before anything else; nothing changes', async () => {
    await seeded(async () => {
      expect(refusal(await adjust(GOOD, { staffKey: null }))).toBe('401 UNAUTHORISED undefined: The staff app could not be authorised.')
      expect(refusal(await adjust(GOOD, { staffKey: 'wrong' }))).toBe('401 UNAUTHORISED undefined: The staff app could not be authorised.')
      expect(refusal(await adjust(GOOD, { email: 'nobody@example.com' }))).toBe(
        "401 UNAUTHORISED undefined: No staff record matches the logged-in user's email (nobody@example.com). Ask an admin to add you as staff before performing this action."
      )
      expect(refusal(await adjust(GOOD, { email: INACTIVE }))).toBe('403 FORBIDDEN undefined: This staff account is inactive. Ask an admin to reactivate it.')
      // And so is the same from a bad request: who is asking comes first.
      expect((await adjust({ creditType: 'session', amount: 0, reason: '' }, { email: INACTIVE })).status).toBe(403)
      expect(await state()).toEqual(UNTOUCHED)
    })
  })

  it('without Issue refunds: refused in the old words as `permission_denied`, for both kinds, before the amount is looked at', async () => {
    await seeded(async () => {
      for (const body of [GOOD, { ...GOOD, creditType: 'addon' }, { creditType: 'session', amount: 0, reason: '' }]) {
        const answer = await adjust(body, { email: NO_REFUNDS })
        expect(refusal(answer)).toBe(`403 FORBIDDEN permission_denied: ${MEMBERSHIP_CREDIT_WORDS.permissionDenied}`)
        expect(answer.body.error?.details).toEqual({ reason: 'permission_denied', message: 'Needs the Issue refunds permission to adjust membership credits.', action: 'credits' })
      }
      expect(await state()).toEqual(UNTOUCHED)
    })
  })

  it('a press with no key is refused (every write needs one)', async () => {
    await seeded(async () => {
      const answer = await adjust(GOOD, { key: null })
      expect(answer.status).toBe(400)
      expect(answer.body.error).toMatchObject({ code: 'VALIDATION', field: 'Idempotency-Key' })
      expect(await state()).toEqual(UNTOUCHED)
    })
  })
})

describe('the credits route: every refusal, with its words, and nothing changed', () => {
  it('the amount, then the credit type, then the reason: each refused in that order', async () => {
    await seeded(async () => {
      const amountWords = `400 VALIDATION amount_invalid: ${MEMBERSHIP_CREDIT_WORDS.amountInvalid}`
      for (const amount of [0, 1.5, -0.5, '2', null, true, Number.NaN]) {
        // A bad amount is refused whatever else is wrong with the press.
        for (const rest of [{ creditType: 'session', reason: 'Goodwill' }, { creditType: 'bonus', reason: '' }]) {
          const answer = await adjust({ ...rest, amount })
          expect(refusal(answer), JSON.stringify(amount)).toBe(amountWords)
          expect(answer.body.error?.field).toBe('amount')
        }
      }
      expect(refusal(await adjust({ creditType: 'session', reason: 'Goodwill' }))).toBe(amountWords)
      expect(amountWords).toContain('Amount must be a non-zero whole number.')

      for (const creditType of ['bonus', 'Session', '', 'add-on']) {
        const answer = await adjust({ creditType, amount: 1, reason: '' })
        expect(refusal(answer), creditType).toBe(`400 VALIDATION credit_type_invalid: ${MEMBERSHIP_CREDIT_NEW_WORDS.creditTypeInvalid}`)
        expect(answer.body.error?.field).toBe('creditType')
      }
      // A credit type that isn't text never reaches the rule: the contract refuses it.
      expect((await adjust({ creditType: 7, amount: 1, reason: 'Goodwill' })).body.error).toMatchObject({ code: 'VALIDATION', field: 'creditType' })

      for (const creditType of ['session', 'addon']) {
        for (const reason of ['', '   ', '\n\t', null, undefined]) {
          const answer = await adjust({ creditType, amount: 1, ...(reason !== undefined ? { reason } : {}) })
          expect(refusal(answer), `${creditType} ${JSON.stringify(reason)}`).toBe(`400 VALIDATION reason_required: ${MEMBERSHIP_CREDIT_DIALOG_WORDS.reasonRequired}`)
          expect(answer.body.error?.details).toEqual({ reason: 'reason_required', message: 'A reason is required for the audit trail', action: 'credits' })
          expect(answer.body.error?.field).toBe('reason')
        }
      }
      expect(await state()).toEqual(UNTOUCHED)
    })
  })

  it('an unknown membership (either kind), and an id that is not one', async () => {
    await seeded(async () => {
      for (const creditType of ['session', 'addon']) {
        expect(refusal(await adjust({ ...GOOD, creditType }, undefined, W36_ID.unknown))).toBe(`404 NOT_FOUND membership_not_found: ${MEMBERSHIP_CREDIT_WORDS.notFound}`)
      }
      expect((await adjust(GOOD, undefined, 'not-an-id')).body.error).toMatchObject({ code: 'VALIDATION', field: 'membershipId' })
      expect(await state()).toEqual(UNTOUCHED)
    })
  })

  it('session credits on an unlimited plan; add-on credits there still move', async () => {
    await seeded(
      async () => {
        expect(refusal(await adjust(GOOD))).toBe(`409 CONFLICT unlimited: ${MEMBERSHIP_CREDIT_WORDS.unlimited}`)
        expect((await state()).allocated).toBe(4)
        expect((await adjust({ ...GOOD, creditType: 'addon' })).body).toMatchObject({ ok: true, data: { addon_credits_remaining: 3 } })
      },
      (seedDb) => seedDb.query('UPDATE membership_plans SET is_unlimited = true WHERE id = $1', [ID.plan]).then(() => undefined)
    )
  })

  it("session credits with no period covering today (none at all; only last month's; only next month's); add-on credits there still move", async () => {
    for (const prepare of [
      'DELETE FROM membership_credit_periods WHERE membership_id = $1',
      "UPDATE membership_credit_periods SET period_start = '2026-10-10', period_end = '2026-11-09' WHERE membership_id = $1",
      "UPDATE membership_credit_periods SET period_start = '2026-11-11', period_end = '2026-12-10' WHERE membership_id = $1",
    ]) {
      await seeded(
        async () => {
          expect(refusal(await adjust(GOOD)), prepare).toBe(`409 CONFLICT no_current_period: ${MEMBERSHIP_CREDIT_WORDS.noCurrentPeriod}`)
          expect((await db.query<{ n: number }>('SELECT COALESCE(sum(credits_allocated), 0)::int AS n FROM membership_credit_periods WHERE membership_id = $1', [ID.membership]))[0]?.n).toBe(prepare.startsWith('DELETE') ? 0 : 4)
          expect((await state()).adjustments).toEqual([])
          expect((await adjust({ ...GOOD, creditType: 'addon' })).body).toMatchObject({ ok: true, data: { addon_credits_remaining: 3 } })
        },
        // Test data only: each statement is a literal above.
        (seedDb) => seedDb.query(prepare, [ID.membership]).then(() => undefined)
      )
    }
  })

  it('below what is used (FB7): with 2 of 4 used, down to 2 goes through, and one more is refused; a cancelled credit booking is not counted as used', async () => {
    await seeded(async () => {
      await creditBooking(13)
      await creditBooking(14)
      expect(refusal(await adjust({ ...GOOD, amount: -3 }))).toBe('409 CONFLICT below_used: Adjustment rejected: the period would be left with 1 allocated credit(s), below the 2 already used.')
      expect((await state()).allocated).toBe(4)
      const exact = await adjust({ ...GOOD, amount: -2 })
      expect(exact.body).toEqual({ ok: true, data: { period: { period_id: ID.creditPeriod, credits_allocated: 2, credits_used: 2, period_start: '2026-11-10', period_end: '2026-12-09' } }, requestId: expect.any(String) })
      expect(refusal(await adjust({ ...GOOD, amount: -1 }))).toBe(`409 CONFLICT below_used: ${MEMBERSHIP_CREDIT_WORDS.belowUsed(1, 2)}`)
      // One of the two bookings is cancelled: 1 used, so 2 allocated can come down to 1.
      await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = (SELECT id FROM bookings WHERE credit_period_id = $1 ORDER BY start_time LIMIT 1)", [ID.creditPeriod])
      expect((await adjust({ ...GOOD, amount: -1 })).body.data).toMatchObject({ period: { credits_allocated: 1, credits_used: 1 } })
      expect(refusal(await adjust({ ...GOOD, amount: -1 }))).toBe(`409 CONFLICT below_used: ${MEMBERSHIP_CREDIT_WORDS.belowUsed(0, 1)}`)
      const after = await state()
      expect(after.allocated).toBe(1)
      expect(after.adjustments.map((row) => row.amount)).toEqual([-2, -1])
    })
  })

  it('add-on credits below zero (FB10): with 2, down to 0 goes through, and one more is refused', async () => {
    await seeded(async () => {
      expect(refusal(await adjust({ ...GOOD, creditType: 'addon', amount: -5 }))).toBe('409 CONFLICT addon_below_zero: Adjustment rejected: the membership would be left with minus 3 add-on credit(s), below zero.')
      expect(refusal(await adjust({ ...GOOD, creditType: 'addon', amount: -3 }))).toBe(`409 CONFLICT addon_below_zero: ${MEMBERSHIP_CREDIT_NEW_WORDS.addonBelowZero(-1)}`)
      expect(await state()).toEqual(UNTOUCHED)
      expect((await adjust({ ...GOOD, creditType: 'addon', amount: -2 })).body.data).toEqual({ addon_credits_remaining: 0 })
      expect(refusal(await adjust({ ...GOOD, creditType: 'addon', amount: -1 }))).toBe(`409 CONFLICT addon_below_zero: ${MEMBERSHIP_CREDIT_NEW_WORDS.addonBelowZero(-1)}`)
      expect((await state()).addon).toBe(0)
      // Session credits have no such floor of their own: with none used, the allocation can come down to 0.
      expect((await adjust({ ...GOOD, amount: -4 })).body.data).toMatchObject({ period: { credits_allocated: 0, credits_used: 0 } })
    })
  })
})

describe('the credits route: what a press that goes through writes', () => {
  it('session credits up and down: the allocation moved from what is there, the record with who and why (trimmed), and one audit row each with before and after', async () => {
    await seeded(async () => {
      const up = await adjust({ creditType: 'session', amount: 2, reason: '  Goodwill after a cold sauna  ' })
      expect(up.status).toBe(200)
      expect(up.body.data).toEqual({ period: { period_id: ID.creditPeriod, credits_allocated: 6, credits_used: 0, period_start: '2026-11-10', period_end: '2026-12-09' } })
      const down = await adjust({ creditType: 'session', amount: -1, reason: 'Added one too many' }, { email: REPLAY_USER.email })
      expect(down.body.data).toMatchObject({ period: { credits_allocated: 5 } })
      const after = await state()
      expect(after.allocated).toBe(5)
      expect(after.addon).toBe(2)
      expect(after.adjustments).toEqual([
        { credit_type: 'session', amount: 2, reason: 'Goodwill after a cold sauna', staff_id: ID.staff },
        { credit_type: 'session', amount: -1, reason: 'Added one too many', staff_id: ID.staff },
      ])
      expect(after.audit).toEqual([
        { action: 'membership.credits_adjusted', actor_id: ID.staff, details: { creditType: 'session', amount: 2, reason: 'Goodwill after a cold sauna', before: 4, after: 6, periodId: ID.creditPeriod, used: 0, adjustmentId: expect.any(String) } },
        { action: 'membership.credits_adjusted', actor_id: ID.staff, details: { creditType: 'session', amount: -1, reason: 'Added one too many', before: 6, after: 5, periodId: ID.creditPeriod, used: 0, adjustmentId: expect.any(String) } },
      ])
      // Each audit row names its own adjustment row.
      const ids = (await db.query<{ id: string }>('SELECT id::text AS id FROM membership_credit_adjustments WHERE membership_id = $1 ORDER BY created_at, id', [ID.membership])).map((row) => row.id)
      expect(after.audit.map((row) => row.details['adjustmentId'])).toEqual(ids)
    })
  })

  it('add-on credits up and down: the balance moved from what is there, the record and its audit row; the period is not touched', async () => {
    await seeded(async () => {
      expect((await adjust({ creditType: 'addon', amount: 3, reason: 'Goodwill' })).body.data).toEqual({ addon_credits_remaining: 5 })
      expect((await adjust({ creditType: 'addon', amount: -1, reason: 'One too many' })).body.data).toEqual({ addon_credits_remaining: 4 })
      const after = await state()
      expect(after.addon).toBe(4)
      expect(after.allocated).toBe(4)
      expect(after.adjustments).toEqual([
        { credit_type: 'addon', amount: 3, reason: 'Goodwill', staff_id: ID.staff },
        { credit_type: 'addon', amount: -1, reason: 'One too many', staff_id: ID.staff },
      ])
      expect(after.audit.map((row) => row.details)).toEqual([
        { creditType: 'addon', amount: 3, reason: 'Goodwill', before: 2, after: 5, adjustmentId: expect.any(String) },
        { creditType: 'addon', amount: -1, reason: 'One too many', before: 5, after: 4, adjustmentId: expect.any(String) },
      ])
    })
  })

  it("only the period covering today moves: last month's and next month's are left as they were", async () => {
    await seeded(
      async () => {
        expect((await adjust({ ...GOOD, amount: 2 })).body.data).toMatchObject({ period: { period_id: ID.creditPeriod, credits_allocated: 6 } })
        expect(await db.query('SELECT period_start::text AS period_start, credits_allocated FROM membership_credit_periods WHERE membership_id = $1 ORDER BY period_start', [ID.membership])).toEqual([
          { period_start: '2026-10-10', credits_allocated: 4 },
          { period_start: '2026-11-10', credits_allocated: 6 },
          { period_start: '2026-12-10', credits_allocated: 4 },
        ])
      },
      async (seedDb) => {
        await insert(seedDb, 'membership_credit_periods', { membership_id: ID.membership, period_start: '2026-10-10', period_end: '2026-11-09', credits_allocated: 4 })
        await insert(seedDb, 'membership_credit_periods', { membership_id: ID.membership, period_start: '2026-12-10', period_end: '2027-01-09', credits_allocated: 4 })
      }
    )
  })

  it('no upper limit (lead call L14): +500 session credits and +500 add-on credits go through', async () => {
    await seeded(async () => {
      expect((await adjust({ ...GOOD, amount: 500 })).body.data).toMatchObject({ period: { credits_allocated: 504 } })
      expect((await adjust({ ...GOOD, creditType: 'addon', amount: 500 })).body.data).toEqual({ addon_credits_remaining: 502 })
    })
  })
})

describe('the credits route: a repeated press (FB9) and a record that fails (FB8)', () => {
  it('the same press sent twice under one key changes once: the second gets the first answer back, for both kinds', async () => {
    await seeded(async () => {
      for (const [creditType, data] of [
        ['session', { period: { period_id: ID.creditPeriod, credits_allocated: 6, credits_used: 0, period_start: '2026-11-10', period_end: '2026-12-09' } }],
        ['addon', { addon_credits_remaining: 4 }],
      ] as const) {
        const key = crypto.randomUUID()
        const first = await adjust({ ...GOOD, creditType, amount: 2 }, { key })
        const again = await adjust({ ...GOOD, creditType, amount: 2 }, { key })
        expect(first.body.data).toEqual(data)
        expect(first.replayed).toBe(false)
        expect(again.replayed).toBe(true)
        expect(again.body).toEqual(first.body)
        // The same key from another staff member is another press: keys are each staff member's own.
      }
      const after = await state()
      expect(after.allocated).toBe(6)
      expect(after.addon).toBe(4)
      expect(after.adjustments).toHaveLength(2)
      expect(after.audit).toHaveLength(2)
    })
  })

  it('a changed press under a used key is refused (IDEMPOTENCY_MISMATCH) and changes nothing more; a refusal is stored too', async () => {
    await seeded(async () => {
      const key = crypto.randomUUID()
      expect((await adjust({ ...GOOD, amount: 2 }, { key })).status).toBe(200)
      const changed = await adjust({ ...GOOD, amount: 3 }, { key })
      expect(changed.status).toBe(422)
      expect(changed.body.error?.code).toBe('IDEMPOTENCY_MISMATCH')
      expect((await state()).allocated).toBe(6)
      // A refusal under a key is that key's answer from then on, even once the press would go through.
      const refusedKey = crypto.randomUUID()
      expect(refusal(await adjust({ ...GOOD, amount: -7 }, { key: refusedKey }))).toContain('below_used')
      await db.query('UPDATE membership_credit_periods SET credits_allocated = 20 WHERE id = $1', [ID.creditPeriod])
      const again = await adjust({ ...GOOD, amount: -7 }, { key: refusedKey })
      expect(again.replayed).toBe(true)
      expect(refusal(again)).toContain('below_used')
      expect((await state()).allocated).toBe(20)
    })
  })

  it('FB8: when the record (or the audit row) fails, nothing has moved; the same key answers the same; a new press then adds once, with its record', async () => {
    for (const failing of [
      { table: 'membership_credit_adjustments', event: 'INSERT', when: 'true' },
      { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'membership.credits_adjusted'` },
    ] as const) {
      await seeded(async () => {
        for (const creditType of ['session', 'addon']) {
          const key = crypto.randomUUID()
          const failed = await whileFailing(db, failing, () => adjust({ ...GOOD, creditType, amount: 2 }, { key }))
          expect(failed.status, failing.table).toBe(500)
          expect(failed.body.error?.code).toBe('INTERNAL')
          expect(await state()).toEqual(UNTOUCHED)
          // The fault has cleared, but the key still answers what its press was told: it is never run again.
          const again = await adjust({ ...GOOD, creditType, amount: 2 }, { key })
          expect(again.status).toBe(500)
          expect(again.replayed).toBe(true)
          expect(await state()).toEqual(UNTOUCHED)
        }
        expect((await adjust({ ...GOOD, amount: 2 })).body.data).toMatchObject({ period: { credits_allocated: 6 } })
        expect((await adjust({ ...GOOD, creditType: 'addon', amount: 2 })).body.data).toEqual({ addon_credits_remaining: 4 })
        const after = await state()
        expect([after.allocated, after.addon, after.adjustments.length, after.audit.length]).toEqual([6, 4, 2, 2])
      })
    }
  })
})

describe('the credit history route', () => {
  it('lists every adjustment of the membership, newest first, with who made it; an adjustment whose staff member is unknown still lists; another membership has none', async () => {
    await seeded(async () => {
      expect((await history(ID.membership)).body).toMatchObject({ ok: true, data: [] })
      await adjust({ creditType: 'session', amount: 2, reason: 'First' })
      vi.setSystemTime(Date.now() + 1000)
      await adjust({ creditType: 'addon', amount: -1, reason: 'Second' })
      vi.setSystemTime(Date.now() + 1000)
      await db.query(`INSERT INTO membership_credit_adjustments (membership_id, staff_id, amount, credit_type, reason) VALUES ($1, NULL, 1, 'session', 'From before staff were recorded')`, [ID.membership])
      const listed = await history(ID.membership)
      expect(listed.status).toBe(200)
      expect(listed.body.data?.map((row) => [row['reason'], row['credit_type'], row['amount'], row['staff_id'], row['staff_first_name'], row['staff_last_name'], row['staff_email'], row['staff_role']])).toEqual([
        ['From before staff were recorded', 'session', 1, null, null, null, null, null],
        ['Second', 'addon', -1, ID.staff, 'Jo', 'Staff', 'jo@example.com', 'admin'],
        ['First', 'session', 2, ID.staff, 'Jo', 'Staff', 'jo@example.com', 'admin'],
      ])
      for (const row of listed.body.data ?? []) {
        expect(Object.keys(row).sort()).toEqual(['amount', 'created_at', 'credit_type', 'id', 'membership_id', 'reason', 'staff_email', 'staff_first_name', 'staff_id', 'staff_last_name', 'staff_role'])
        expect(row['membership_id']).toBe(ID.membership)
        expect(typeof row['created_at']).toBe('string')
        expect(Number.isNaN(Date.parse(String(row['created_at'])))).toBe(false)
      }
      expect((await history(ID.exhausted)).body.data).toEqual([])
      expect((await history(W36_ID.unknown)).body.data).toEqual([])
    })
  })

  it('any active staff member may read it (no Issue refunds needed); an inactive account and someone with no staff record may not (FB16); a bad id is refused', async () => {
    await seeded(async () => {
      expect((await history(ID.membership, { email: NO_REFUNDS })).status).toBe(200)
      expect((await history(ID.membership, { email: INACTIVE })).body.error).toMatchObject({ code: 'FORBIDDEN', message: 'This staff account is inactive. Ask an admin to reactivate it.' })
      expect((await history(ID.membership, { email: 'nobody@example.com' })).body.error?.code).toBe('UNAUTHORISED')
      expect((await history('not-an-id')).body.error).toMatchObject({ code: 'VALIDATION', field: 'membershipId' })
    })
  })
})

describe('the Herd route', () => {
  it('who may: Issue refunds (the old words, as `permission_denied`); never an inactive account or someone with no staff record; a press needs a key', async () => {
    await seeded(async () => {
      for (const value of [true, false, null]) {
        const answer = await herd(value, { email: NO_REFUNDS })
        expect(refusal(answer)).toBe(`403 FORBIDDEN permission_denied: ${ISSUE_REFUNDS_NEEDED_MESSAGE}`)
        expect(answer.body.error?.details).toEqual({ reason: 'permission_denied', message: 'Needs Issue refunds permission — this action moves money back to the customer.', action: 'herd' })
      }
      expect(refusal(await herd(true, { email: INACTIVE }))).toBe('403 FORBIDDEN undefined: This staff account is inactive. Ask an admin to reactivate it.')
      expect((await herd(true, { email: 'nobody@example.com' })).body.error?.code).toBe('UNAUTHORISED')
      expect((await herd(true, { key: null })).body.error).toMatchObject({ code: 'VALIDATION', field: 'Idempotency-Key' })
      expect(await state()).toEqual(UNTOUCHED)
    })
  })

  it('an unknown membership is `not_found`, for on, off and cleared; anything but true, false or null is refused', async () => {
    await seeded(async () => {
      for (const value of [true, false, null]) {
        const answer = await herd(value, undefined, W36_ID.unknown)
        expect(refusal(answer)).toBe(`404 NOT_FOUND not_found: ${HERD_NOT_FOUND_MESSAGE}`)
        expect(answer.body.error?.details?.action).toBe('herd')
      }
      for (const value of ['yes', 1, undefined]) {
        const answer = await send('herd', ID.membership, value === undefined ? {} : { herd: value })
        expect(answer.body.error, JSON.stringify(value)).toMatchObject({ code: 'VALIDATION', field: 'herd' })
      }
      expect((await herd(true, undefined, 'not-an-id')).body.error).toMatchObject({ code: 'VALIDATION', field: 'membershipId' })
      expect(await state()).toEqual(UNTOUCHED)
      expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'membership.herd_set'"))[0]?.n).toBe(0)
    })
  })

  it('off, on, then cleared (a member since January: Herd by the rule): the flag and the override each time, the answer in the old shape, and an audit row of who, before and after (FB11)', async () => {
    await seeded(async () => {
      const off = await herd(false)
      expect(off.body.data).toEqual({ membership: { id: ID.membership, plan_name: 'Core', subscription_status: 'active', is_herd: false, herd_override: false, addon_credits_remaining: 2 } })
      const on = await herd(true)
      expect(on.body.data).toMatchObject({ membership: { is_herd: true, herd_override: true } })
      const cleared = await herd(null)
      expect(cleared.body.data).toMatchObject({ membership: { is_herd: true, herd_override: null, addon_credits_remaining: 2 } })
      const after = await state()
      expect([after.isHerd, after.override]).toEqual([true, null])
      expect(after.audit).toEqual([
        { action: 'membership.herd_set', actor_id: ID.staff, details: { herd: false, before: { isHerd: true, override: null }, after: { isHerd: false, override: false } } },
        { action: 'membership.herd_set', actor_id: ID.staff, details: { herd: true, before: { isHerd: false, override: false }, after: { isHerd: true, override: true } } },
        { action: 'membership.herd_set', actor_id: ID.staff, details: { herd: null, before: { isHerd: true, override: true }, after: { isHerd: true, override: null } } },
      ])
      // Herd moves no credits and writes no adjustment.
      expect([after.allocated, after.addon, after.adjustments.length]).toEqual([4, 2, 0])
    })
  })

  it('on for a member of ten days, then cleared: the rule takes Herd away again; the same press again under its key writes nothing more', async () => {
    await seeded(
      async () => {
        const key = crypto.randomUUID()
        const on = await herd(true, { key })
        expect(on.body.data).toMatchObject({ membership: { is_herd: true, herd_override: true } })
        const again = await herd(true, { key })
        expect(again.replayed).toBe(true)
        expect(again.body).toEqual(on.body)
        expect((await herd(null)).body.data).toMatchObject({ membership: { is_herd: false, herd_override: null } })
        expect((await state()).audit.map((row) => row.details['herd'])).toEqual([true, null])
      },
      (seedDb) => seedDb.query("UPDATE customer_memberships SET start_date = '2026-11-01', is_herd = false WHERE id = $1", [ID.membership]).then(() => undefined)
    )
  })

  it('FB11: when the audit row fails, the Herd change is not kept (set or cleared)', async () => {
    await seeded(async () => {
      const failing = { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'membership.herd_set'` } as const
      for (const value of [false, null]) {
        const failed = await whileFailing(db, failing, () => herd(value))
        expect(failed.status).toBe(500)
        expect(await state()).toEqual(UNTOUCHED)
      }
    })
  })
})

describe('the automatic Herd rule for one membership (brief W37 item 3)', () => {
  /** The saved live function's own text. */
  const refreshHerdFlags = (): string => {
    const catalog = JSON.parse(readFileSync(path.resolve(__dirname, '../testing/live-catalog.json'), 'utf8')) as { functions: Array<{ name: string; definition: string }> }
    return catalog.functions.find((fn) => fn.name === 'refresh_herd_flags')?.definition ?? ''
  }
  const squeezed = (sql: string) => sql.replace(/\s+/g, ' ').trim()

  it("is the database's refresh_herd_flags() expression, word for word (a migration that changes the rule fails here)", () => {
    const saved = squeezed(refreshHerdFlags())
    expect(saved).not.toBe('')
    // The function names the rule twice (what to set, and which rows differ from it): both are this expression.
    expect(saved.split(squeezed(HERD_RULE_SQL)).length - 1).toBe(2)
    expect(saved).toContain('wait_months := coalesce(wait_months, 6);')
    expect(saved).toContain('select addon_credit_wait_months into wait_months from public.membership_settings where id;')
  })

  const CASES = [
    { name: 'yearly, started last week', billing_frequency: 'yearly', start_date: '2026-11-03', herd: true },
    { name: 'monthly, started 6 months ago to the day', billing_frequency: 'monthly', start_date: '2026-05-10', herd: true },
    { name: 'monthly, started 6 months less a day ago', billing_frequency: 'monthly', start_date: '2026-05-11', herd: false },
    { name: 'monthly, started last week', billing_frequency: 'monthly', start_date: '2026-11-03', herd: false },
    { name: 'no billing frequency, started long ago', billing_frequency: null, start_date: '2025-01-01', herd: true },
  ] as const

  it('clearing gives each membership exactly what refresh_herd_flags() gives it, whichever way its flag was left: yearly, old and new monthly, and the day the wait ends; with the wait at 6 months, at 1 and at 0', async () => {
    for (const wait of [6, 1, 0]) {
      await seeded(async () => {
        await db.query('DELETE FROM membership_settings')
        await db.query('INSERT INTO membership_settings (addon_credit_wait_months) VALUES ($1)', [wait])
        for (const one of CASES) {
          const customer = await insert(db, 'customers', { first_name: 'Herd', last_name: 'Case', email: `herd-${wait}-${CASES.indexOf(one)}@example.com`, date_of_birth: '1990-01-01' })
          const membership = await insert(db, 'customer_memberships', { customer_id: customer, plan_id: ID.plan, start_date: one.start_date, subscription_status: 'active', billing_frequency: one.billing_frequency, is_herd: false })
          const byWorker: boolean[] = []
          for (const left of [true, false]) {
            expect((await herd(left, undefined, membership)).status).toBe(200)
            const cleared = await herd(null, undefined, membership)
            byWorker.push((cleared.body.data as { membership: { is_herd: boolean; herd_override: boolean | null } }).membership.is_herd)
            expect((cleared.body.data as { membership: { herd_override: boolean | null } }).membership.herd_override).toBeNull()
          }
          // The database's own answer, from the opposite flag, so it has to decide.
          await db.query('UPDATE customer_memberships SET is_herd = NOT is_herd WHERE id = $1', [membership])
          await db.query('SELECT public.refresh_herd_flags()')
          const byDatabase = (await state(membership)).isHerd
          expect(byWorker, `${one.name}, wait ${wait}`).toEqual([byDatabase, byDatabase])
          if (wait === 6) expect(byDatabase, one.name).toBe(one.herd)
          if (wait === 0) expect(byDatabase, one.name).toBe(true)
        }
      })
    }
  })

  it('with no settings row the wait is 6 months, as the function has it', async () => {
    await seeded(async () => {
      await db.query('DELETE FROM membership_settings')
      await db.query("UPDATE customer_memberships SET start_date = '2026-05-11', is_herd = true WHERE id = $1", [ID.membership])
      expect((await herd(null)).body.data).toMatchObject({ membership: { is_herd: false } })
      await db.query("UPDATE customer_memberships SET start_date = '2026-05-10' WHERE id = $1", [ID.membership])
      expect((await herd(null)).body.data).toMatchObject({ membership: { is_herd: true } })
    })
  })

  const seenFromRefresh: string[] = []
  it('a membership with no billing frequency that has not waited long enough is not Herd (the rule itself gives no answer there, and is_herd cannot be empty)', async () => {
    await seeded(async () => {
      await db.query("UPDATE customer_memberships SET billing_frequency = NULL, start_date = '2026-11-03', is_herd = true, herd_override = true WHERE id = $1", [ID.membership])
      expect((await herd(null)).body.data).toMatchObject({ membership: { is_herd: false, herd_override: null } })
      // What the database's own function does with such a row, written down as it is today (W37 report, "Noticed").
      seenFromRefresh.push(
        await db.query('SELECT public.refresh_herd_flags()').then(
          () => 'ran',
          (err: unknown) => (err instanceof Error ? err.message : String(err))
        )
      )
    })
    // It fails for the whole table: the rule gives NULL for this row, and is_herd can't hold it. Live has no such
    // membership today as far as the builder knows (every order writes a billing frequency); the lead can count them.
    // W37a: migration 026 (written, not applied) wraps the function's rule in coalesce(…, false) as the Worker's is,
    // so once the lead has applied it and refreshed the saved schema the function simply runs (migration-026.test.ts).
    const fixedBy026 = squeezed(refreshHerdFlags()).includes(`coalesce(${squeezed(HERD_RULE_SQL)}, false)`)
    expect(seenFromRefresh).toEqual([fixedBy026 ? 'ran' : 'null value in column "is_herd" of relation "customer_memberships" violates not-null constraint'])
  })

  it("clearing one membership's override leaves every other membership as it was, stale flags included (the old function ran the rule over them all)", async () => {
    await seeded(async () => {
      const customer = await insert(db, 'customers', { first_name: 'Other', last_name: 'Member', email: 'other.member@example.com', date_of_birth: '1990-01-01' })
      // A flag the hourly job hasn't caught up with yet: a new monthly member still marked Herd.
      const other = await insert(db, 'customer_memberships', { customer_id: customer, plan_id: ID.plan, start_date: '2026-11-03', subscription_status: 'active', billing_frequency: 'monthly', is_herd: true })
      const [before] = await db.query<{ updated_at: unknown }>('SELECT updated_at FROM customer_memberships WHERE id = $1', [other])
      await herd(false)
      await herd(null)
      const [after] = await db.query<{ is_herd: boolean; updated_at: unknown }>('SELECT is_herd, updated_at FROM customer_memberships WHERE id = $1', [other])
      expect(after?.is_herd).toBe(true)
      expect(String(after?.updated_at)).toBe(String(before?.updated_at))
      expect((await state(other)).audit).toEqual([])
    })
  })
})
