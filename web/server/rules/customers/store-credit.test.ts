import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as storeCreditRoute } from '@/app/api/v1/staff/customers/[customerId]/store-credit/route'
import type { Db } from '@/server/db'
import { ISSUE_REFUNDS_NEEDED_MESSAGE } from '@/server/rules/bookings/failure-messages'
import { insert } from '@/server/rules/testing/database'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, seed, W36_ID, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { STORE_CREDIT_WORDS } from './failure-messages'

vi.setConfig({ testTimeout: 30_000 })

// Brief W37 items 1 and 7: the store credit route on the replay's live schema (the database's own store_credit_apply
// included): every refusal with its words in the old order, add and remove, an overdraw, rounding, a repeated press
// (FB12), and an audit row that fails.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const KEY = 'test-staff-api-key'
const NO_REFUNDS = 'front.desk@example.com'
const INACTIVE = 'gone@example.com'

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

/** The seed (Sam has £30 of store credit), and two more staff. */
async function seeded(work: () => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w37 store credit',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await insert(seedDb, 'staff', { first_name: 'Fran', last_name: 'Desk', email: NO_REFUNDS, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        await insert(seedDb, 'staff', { first_name: 'Gone', last_name: 'Away', email: INACTIVE, role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: false })
      },
      run: work,
    },
    workerSide()
  )
}

type ErrorBody = { code: string; message: string; field?: string; details?: { reason?: string; message?: string; action?: string } }
type Answer = { status: number; replayed: boolean; body: { ok: boolean; data?: Record<string, unknown>; error?: ErrorBody } }

async function press(body: unknown, { email = REPLAY_USER.email, key = crypto.randomUUID() as string | null, customerId = ID.customer as string } = {}): Promise<Answer> {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  const response = await storeCreditRoute(
    new Request(`https://worker.test/api/v1/staff/customers/${customerId}/store-credit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, ...(key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ customerId }) }
  )
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', body: (await response.json()) as Answer['body'] }
}

const refusal = (answer: Answer) => `${answer.status} ${answer.body.error?.code} ${answer.body.error?.details?.reason}: ${answer.body.error?.message}`
const GOOD = { mode: 'add', amount: 20, reason: 'Goodwill for a cold sauna' }

interface State {
  balance: string
  movements: Array<{ amount: string; balance_after: string; reason: string; note: string | null; staff_id: string | null; order_id: string | null; booking_id: string | null; gift_card_id: string | null }>
  audit: Array<{ action: string; actor_id: string; details: Record<string, unknown> }>
}
async function state(customerId: string = ID.customer): Promise<State> {
  const [customer] = await db.query<{ balance: string }>('SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [customerId])
  const movements = await db.query<State['movements'][number]>(
    'SELECT amount::text AS amount, balance_after::text AS balance_after, reason, note, staff_id::text AS staff_id, order_id::text AS order_id, booking_id::text AS booking_id, gift_card_id::text AS gift_card_id FROM store_credit_transactions WHERE customer_id = $1 ORDER BY created_at, id',
    [customerId]
  )
  const audit = await db.query<State['audit'][number]>(`SELECT action, actor_id, details FROM audit_log WHERE entity_type = 'customer' AND entity_id = $1 ORDER BY at, id`, [customerId])
  return { balance: customer?.balance ?? '', movements, audit }
}
const UNTOUCHED: State = { balance: '30.00', movements: [], audit: [] }

describe('the store credit route: who may, and every refusal in the old order', () => {
  it('no staff record and an inactive account are refused before anything else; a press needs a key', async () => {
    await seeded(async () => {
      expect(refusal(await press(GOOD, { email: 'nobody@example.com' }))).toBe(
        "401 UNAUTHORISED undefined: No staff record matches the logged-in user's email (nobody@example.com). Ask an admin to add you as staff before performing this action."
      )
      expect(refusal(await press(GOOD, { email: INACTIVE }))).toBe('403 FORBIDDEN undefined: This staff account is inactive. Ask an admin to reactivate it.')
      expect((await press({ mode: 'give', amount: 0, reason: '' }, { email: INACTIVE })).status).toBe(403)
      expect((await press(GOOD, { key: null })).body.error).toMatchObject({ code: 'VALIDATION', field: 'Idempotency-Key' })
      expect(await state()).toEqual(UNTOUCHED)
    })
  })

  it('the mode, then the amount, then the reason, then Issue refunds: each with the old words, and nothing changed', async () => {
    await seeded(async () => {
      for (const mode of ['give', '', 'Add', 'REMOVE']) {
        // A bad mode is refused whatever else is wrong, and whoever asks.
        for (const email of [REPLAY_USER.email, NO_REFUNDS]) {
          const answer = await press({ mode, amount: 0, reason: '' }, { email })
          expect(refusal(answer), mode).toBe(`400 VALIDATION mode_invalid: ${STORE_CREDIT_WORDS.modeInvalid}`)
          expect(answer.body.error?.details).toEqual({ reason: 'mode_invalid', message: 'Mode must be "add" or "remove".', action: 'store_credit' })
        }
      }
      // A mode that isn't text never reaches the rule: the contract refuses it.
      expect((await press({ mode: 1, amount: 20, reason: 'Goodwill' })).body.error).toMatchObject({ code: 'VALIDATION', field: 'mode' })

      for (const mode of ['add', 'remove']) {
        for (const amount of [0, -5, '20', 0.004, null, undefined, true, Number.NaN]) {
          const answer = await press({ mode, reason: '', ...(amount !== undefined ? { amount } : {}) }, { email: NO_REFUNDS })
          expect(refusal(answer), `${mode} ${JSON.stringify(amount)}`).toBe(`400 VALIDATION amount_invalid: ${STORE_CREDIT_WORDS.amountInvalid}`)
          expect(answer.body.error?.message).toBe('Amount must be greater than 0.')
          expect(answer.body.error?.field).toBe('amount')
        }
        for (const reason of ['', 'ok', 'abcd', '  abcd  ', '    ', '  ab  ', null, undefined, 12345]) {
          const answer = await press({ mode, amount: 20, ...(reason !== undefined ? { reason } : {}) }, { email: NO_REFUNDS })
          expect(refusal(answer), `${mode} ${JSON.stringify(reason)}`).toBe(`400 VALIDATION reason_required: ${STORE_CREDIT_WORDS.reasonRequired}`)
          expect(answer.body.error?.message).toBe('A reason of at least 5 characters is required.')
          expect(answer.body.error?.field).toBe('reason')
        }
        // Everything else right, and no Issue refunds: the old words, as `permission_denied`.
        const denied = await press({ ...GOOD, mode }, { email: NO_REFUNDS })
        expect(refusal(denied)).toBe(`403 FORBIDDEN permission_denied: ${ISSUE_REFUNDS_NEEDED_MESSAGE}`)
        expect(denied.body.error?.details).toEqual({ reason: 'permission_denied', message: 'Needs Issue refunds permission — this action moves money back to the customer.', action: 'store_credit' })
      }
      expect(await state()).toEqual(UNTOUCHED)
    })
  })

  it('an unknown customer (`customer_not_found`), and an id that is not one', async () => {
    await seeded(async () => {
      const gone = await press(GOOD, { customerId: W36_ID.unknown })
      expect(refusal(gone)).toBe(`404 NOT_FOUND customer_not_found: ${STORE_CREDIT_WORDS.customerGone}`)
      expect(gone.body.error?.message).toBe('That customer no longer exists.')
      expect((await press(GOOD, { customerId: 'not-an-id' })).body.error).toMatchObject({ code: 'VALIDATION', field: 'customerId' })
      expect(await state()).toEqual(UNTOUCHED)
      expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'customer.store_credit_adjusted'"))[0]?.n).toBe(0)
    })
  })

  it('an overdraw (`insufficient_store_credit`): £30.01 off £30 is refused; £30 off goes through, to exactly £0; a penny more is then refused', async () => {
    await seeded(async () => {
      const over = await press({ mode: 'remove', amount: 30.01, reason: 'Given by mistake' })
      expect(refusal(over)).toBe(`409 CONFLICT insufficient_store_credit: ${STORE_CREDIT_WORDS.belowZero}`)
      expect(over.body.error?.message).toBe('Removing that much would take the balance below zero — the adjustment was refused.')
      expect(await state()).toEqual(UNTOUCHED)
      expect((await press({ mode: 'remove', amount: 30, reason: 'Given by mistake' })).body.data).toEqual({ appliedAmount: -30, balance: 0, transactionId: expect.any(String) })
      expect(refusal(await press({ mode: 'remove', amount: 0.01, reason: 'Given by mistake' }))).toContain('insufficient_store_credit')
      expect((await state()).balance).toBe('0.00')
    })
  })
})

describe('the store credit route: what a press that goes through writes', () => {
  it('add £20, then remove £10: the balance, the movement (manual_adjustment, the trimmed reason as its note, the staff member, no order or booking) and one audit row each', async () => {
    await seeded(async () => {
      const added = await press({ mode: 'add', amount: 20, reason: '  Goodwill for a cold sauna  ' })
      expect(added.status).toBe(200)
      expect(added.body.data).toEqual({ appliedAmount: 20, balance: 50, transactionId: expect.any(String) })
      const removed = await press({ mode: 'remove', amount: 10, reason: 'Given by mistake' })
      expect(removed.body.data).toEqual({ appliedAmount: -10, balance: 40, transactionId: expect.any(String) })
      const after = await state()
      expect(after.balance).toBe('40.00')
      const blank = { order_id: null, booking_id: null, gift_card_id: null }
      expect(after.movements).toEqual([
        { amount: '20.00', balance_after: '50.00', reason: 'manual_adjustment', note: 'Goodwill for a cold sauna', staff_id: ID.staff, ...blank },
        { amount: '-10.00', balance_after: '40.00', reason: 'manual_adjustment', note: 'Given by mistake', staff_id: ID.staff, ...blank },
      ])
      expect(after.audit).toEqual([
        { action: 'customer.store_credit_adjusted', actor_id: ID.staff, details: { mode: 'add', amount: 20, reason: 'Goodwill for a cold sauna', balanceBefore: 30, balanceAfter: 50, transactionId: added.body.data?.['transactionId'] } },
        { action: 'customer.store_credit_adjusted', actor_id: ID.staff, details: { mode: 'remove', amount: -10, reason: 'Given by mistake', balanceBefore: 50, balanceAfter: 40, transactionId: removed.body.data?.['transactionId'] } },
      ])
      // Each audit row names its own movement.
      const ids = (await db.query<{ id: string }>('SELECT id::text AS id FROM store_credit_transactions WHERE customer_id = $1 ORDER BY created_at, id', [ID.customer])).map((row) => row.id)
      expect(after.audit.map((row) => row.details['transactionId'])).toEqual(ids)
    })
  })

  it('the amount is rounded to the penny, as before: £12.345 adds £12.35 (the old half-penny rule), £0.005 adds a penny, and the audit row has the rounded figures', async () => {
    await seeded(async () => {
      expect((await press({ mode: 'add', amount: 12.345, reason: 'Rounding' })).body.data).toMatchObject({ appliedAmount: Math.round(12.345 * 100) / 100 })
      expect((await press({ mode: 'add', amount: 0.005, reason: 'Rounding' })).body.data).toMatchObject({ appliedAmount: 0.01 })
      const after = await state()
      const first = Math.round(12.345 * 100) / 100
      expect(after.movements.map((row) => row.amount)).toEqual([first.toFixed(2), '0.01'])
      expect(after.balance).toBe((30 + first + 0.01).toFixed(2))
      expect(after.audit.map((row) => [row.details['amount'], row.details['balanceBefore'], row.details['balanceAfter']])).toEqual([
        [first, 30, Number((30 + first).toFixed(2))],
        [0.01, Number((30 + first).toFixed(2)), Number((30 + first + 0.01).toFixed(2))],
      ])
    })
  })

  it('a reason of exactly 5 characters is enough, counted after trimming', async () => {
    await seeded(async () => {
      expect((await press({ mode: 'add', amount: 1, reason: 'abcde' })).status).toBe(200)
      expect((await press({ mode: 'add', amount: 1, reason: '  abcde  ' })).status).toBe(200)
      expect((await state()).movements.map((row) => row.note)).toEqual(['abcde', 'abcde'])
    })
  })

  it('no upper limit (lead call L14): £5,000 goes on', async () => {
    await seeded(async () => {
      expect((await press({ mode: 'add', amount: 5000, reason: 'A large correction' })).body.data).toMatchObject({ balance: 5030 })
    })
  })
})

describe('the store credit route: a repeated press (FB12) and an audit row that fails', () => {
  it('the same £20 sent twice under one key gives £20 once: the second gets the first answer back; a changed press under that key is refused', async () => {
    await seeded(async () => {
      const key = crypto.randomUUID()
      const first = await press(GOOD, { key })
      const again = await press(GOOD, { key })
      expect(first.body.data).toMatchObject({ appliedAmount: 20, balance: 50 })
      expect(first.replayed).toBe(false)
      expect(again.replayed).toBe(true)
      expect(again.body).toEqual(first.body)
      const changed = await press({ ...GOOD, amount: 25 }, { key })
      expect(changed.status).toBe(422)
      expect(changed.body.error?.code).toBe('IDEMPOTENCY_MISMATCH')
      const after = await state()
      expect(after.balance).toBe('50.00')
      expect(after.movements).toHaveLength(1)
      expect(after.audit).toHaveLength(1)
      // The same again under a new key is a new press: £20 more.
      expect((await press(GOOD)).body.data).toMatchObject({ balance: 70 })
    })
  })

  it('when the audit row fails, the balance has not moved and there is no movement; the same key answers the same; a new press then gives once', async () => {
    await seeded(async () => {
      const key = crypto.randomUUID()
      const failed = await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'customer.store_credit_adjusted'` }, () => press(GOOD, { key }))
      expect(failed.status).toBe(500)
      expect(failed.body.error?.code).toBe('INTERNAL')
      expect(await state()).toEqual(UNTOUCHED)
      const again = await press(GOOD, { key })
      expect(again.status).toBe(500)
      expect(again.replayed).toBe(true)
      expect(await state()).toEqual(UNTOUCHED)
      expect((await press(GOOD)).body.data).toMatchObject({ balance: 50 })
      const after = await state()
      expect([after.balance, after.movements.length, after.audit.length]).toEqual(['50.00', 1, 1])
    })
  })

  it("when the movement's own row fails, nothing is kept either", async () => {
    await seeded(async () => {
      const failed = await whileFailing(db, { table: 'store_credit_transactions', event: 'INSERT', when: `NEW.reason = 'manual_adjustment'` }, () => press(GOOD))
      expect(failed.status).toBe(500)
      expect(await state()).toEqual(UNTOUCHED)
    })
  })
})
