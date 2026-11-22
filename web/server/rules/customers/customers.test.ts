import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as detailRoute } from '@/app/api/v1/staff/customers/[customerId]/route'
import { GET as listRoute, POST as createRoute } from '@/app/api/v1/staff/customers/route'
import { customerListRowSchema, customerMembershipRowSchema, customerSessionPassRowSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { insert } from '@/server/rules/testing/database'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { ID, scenarios, seed, W36_ID, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { createCustomer } from './create'
import { CREATE_CUSTOMER_REASONS, CREATE_CUSTOMER_WORDS, CUSTOMER_EMAIL_UNIQUE_RULES } from './failure-messages'
import { CUSTOMER_COLUMNS_NOT_SENT, CUSTOMER_LIST_FIELDS, CUSTOMER_MEMBERSHIP_COLUMNS, CUSTOMER_PASS_COLUMNS, getCustomerDetail, listCustomers } from './read'

vi.setConfig({ testTimeout: 60_000 })

// Brief W39 items 1, 2 and 6: the three customer routes on the replay's live schema. Create: every refusal with the
// old words in the old order; a duplicate in another case (FB21); a date the calendar doesn't have (FB23); the audit
// row with who and the channel; a repeated press. The list, its search and the detail, by named fields. An inactive
// staff member and no staff record on each route (FB16).

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const KEY = 'test-staff-api-key'
const FRONT_DESK = 'front.desk@example.com'
const INACTIVE = 'gone@example.com'
const NOBODY = 'nobody@example.com'
const NO_STAFF_WORDS = `No staff record matches the logged-in user's email (${NOBODY}). Ask an admin to add you as staff before performing this action.`
const INACTIVE_WORDS = 'This staff account is inactive. Ask an admin to reactivate it.'
const DUPLICATE = 'A customer with this email address already exists'

let environment: ReplayEnvironment
let db: Db
let frontDeskId = ''
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

/** The seed (Sam Test and Mo Member; today is 10 November 2026), and two more staff: one without Issue refunds, one inactive. */
async function seeded(work: (context: ScenarioContext) => Promise<void>, prepare?: (seedDb: Db) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w39 customers',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        frontDeskId = await insert(seedDb, 'staff', { first_name: 'Fran', last_name: 'Desk', email: FRONT_DESK, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        await insert(seedDb, 'staff', { first_name: 'Gone', last_name: 'Away', email: INACTIVE, role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: false })
        await prepare?.(seedDb)
      },
      run: work,
    },
    oldSide
  )
}

type ErrorBody = { code: string; message: string; field?: string; details?: { reason?: string; message?: string; action?: string } }
type Answer = { status: number; replayed: boolean; body: { ok: boolean; data?: unknown; error?: ErrorBody } }
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>
interface Who {
  email?: string
  key?: string | null
}

async function send(handler: Handler, method: 'GET' | 'POST', route: string, params: Record<string, string>, body: unknown, { email = REPLAY_USER.email, key = crypto.randomUUID() }: Who = {}): Promise<Answer> {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  const response = await handler(
    new Request(`https://worker.test/api/v1/staff/${route}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, ...(method === 'POST' && key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) }
  )
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', body: (await response.json()) as Answer['body'] }
}

const DEE = { firstName: 'Dee', lastName: 'Dale', email: 'dee@example.com', dateOfBirth: '1992-02-29' }
const create = (fields: Record<string, unknown>, who: Who = {}) => send(createRoute as Handler, 'POST', 'customers', {}, fields, who)
const list = (query: Record<string, string> = {}, who: Who = {}) => send(listRoute as Handler, 'GET', `customers?${new URLSearchParams(query).toString()}`, {}, undefined, who)
const detail = (customerId: string, who: Who = {}) => send(detailRoute as Handler, 'GET', `customers/${customerId}`, { customerId }, undefined, who)
const refusal = (answer: Answer) => `${answer.status} ${answer.body.error?.code} ${answer.body.error?.details?.reason}: ${answer.body.error?.message}`

const customers = () => db.query<{ email: string; first_name: string }>('SELECT email, first_name FROM customers ORDER BY created_at, id')
const emails = async () => (await customers()).map((row) => row.email)
const audit = () =>
  db.query<{ action: string; actor_type: string; actor_id: string; entity_type: string; entity_id: string; details: Record<string, unknown> }>(
    "SELECT action, actor_type, actor_id, entity_type, entity_id, details FROM audit_log WHERE action LIKE 'customer.%' ORDER BY at, id"
  )
const SEEDED = ['sam@example.com', 'mo@example.com']

describe('create: who may, and every refusal with the old words in the old order', () => {
  it('no staff record and an inactive account are refused before anything else; any active staff member may, with or without Issue refunds; a press needs a key', async () => {
    await seeded(async () => {
      expect(refusal(await create(DEE, { email: NOBODY }))).toBe(`401 UNAUTHORISED undefined: ${NO_STAFF_WORDS}`)
      expect(refusal(await create(DEE, { email: INACTIVE }))).toBe(`403 FORBIDDEN undefined: ${INACTIVE_WORDS}`)
      // Refused whatever else is wrong with the press.
      expect((await create({ ...DEE, firstName: '' }, { email: INACTIVE })).status).toBe(403)
      expect((await create(DEE, { key: null })).body.error).toMatchObject({ code: 'VALIDATION', field: 'Idempotency-Key' })
      expect(await emails()).toEqual(SEEDED)
      expect(await audit()).toEqual([])
      const made = await create(DEE, { email: FRONT_DESK })
      expect(made.status).toBe(200)
      expect((await audit()).map((row) => row.actor_id)).toEqual([frontDeskId])
    })
  })

  it('first name, last name, email, date of birth, not in the future, 18 or over: each refused with the old words, its reason and its field, and the first one wrong is the one given', async () => {
    await seeded(async () => {
      const cases: Array<[Record<string, unknown>, string, string, string]> = [
        [{ ...DEE, firstName: '  ' }, 'first_name_required', 'First name is required', 'firstName'],
        [{ ...DEE, firstName: undefined }, 'first_name_required', 'First name is required', 'firstName'],
        [{ ...DEE, firstName: null }, 'first_name_required', 'First name is required', 'firstName'],
        [{ ...DEE, lastName: '' }, 'last_name_required', 'Last name is required', 'lastName'],
        [{ ...DEE, email: 'dee-at-example.com' }, 'email_invalid', 'A valid email address is required', 'email'],
        [{ ...DEE, email: '' }, 'email_invalid', 'A valid email address is required', 'email'],
        [{ ...DEE, email: 'dee @example.com' }, 'email_invalid', 'A valid email address is required', 'email'],
        [{ ...DEE, email: 'dee@example' }, 'email_invalid', 'A valid email address is required', 'email'],
        [{ ...DEE, dateOfBirth: '29/02/1992' }, 'date_of_birth_invalid', 'A valid date of birth is required', 'dateOfBirth'],
        [{ ...DEE, dateOfBirth: '' }, 'date_of_birth_invalid', 'A valid date of birth is required', 'dateOfBirth'],
        [{ ...DEE, dateOfBirth: '1992-2-29' }, 'date_of_birth_invalid', 'A valid date of birth is required', 'dateOfBirth'],
        [{ ...DEE, dateOfBirth: '1992-02-29T00:00:00Z' }, 'date_of_birth_invalid', 'A valid date of birth is required', 'dateOfBirth'],
        [{ ...DEE, dateOfBirth: '2027-01-01' }, 'date_of_birth_in_future', 'Date of birth cannot be in the future', 'dateOfBirth'],
        [{ ...DEE, dateOfBirth: '2026-11-11' }, 'date_of_birth_in_future', 'Date of birth cannot be in the future', 'dateOfBirth'],
        [{ ...DEE, dateOfBirth: '2026-11-10' }, 'under_18', 'Customers must be 18 or over.', 'dateOfBirth'],
        [{ ...DEE, dateOfBirth: '2008-11-11' }, 'under_18', 'Customers must be 18 or over.', 'dateOfBirth'],
        // W58 (W45 audit row 18): the lengths, after the old checks and before the date of birth's.
        [{ ...DEE, firstName: 'A'.repeat(101) }, 'too_long', 'First name can be at most 100 characters.', 'firstName'],
        [{ ...DEE, lastName: 'B'.repeat(101) }, 'too_long', 'Last name can be at most 100 characters.', 'lastName'],
        [{ ...DEE, email: `${'d'.repeat(250)}@example.com` }, 'too_long', 'Email can be at most 254 characters.', 'email'],
        [{ ...DEE, phone: '0'.repeat(31) }, 'too_long', 'Phone can be at most 30 characters.', 'phone'],
        // The first thing wrong is the one given.
        [{ firstName: '', lastName: '', email: 'x', dateOfBirth: 'y' }, 'first_name_required', 'First name is required', 'firstName'],
        [{ ...DEE, lastName: '', email: 'x', dateOfBirth: 'y' }, 'last_name_required', 'Last name is required', 'lastName'],
        [{ ...DEE, email: 'x', dateOfBirth: 'y' }, 'email_invalid', 'A valid email address is required', 'email'],
        // A bad field is refused before the duplicate is looked for.
        [{ ...DEE, email: 'sam@example.com', dateOfBirth: '2008-11-11' }, 'under_18', 'Customers must be 18 or over.', 'dateOfBirth'],
      ]
      for (const [fields, reason, words, field] of cases) {
        const answer = await create(fields)
        expect(refusal(answer), JSON.stringify(fields)).toBe(`400 VALIDATION ${reason}: ${words}`)
        expect(answer.body.error?.field, JSON.stringify(fields)).toBe(field)
        expect(answer.body.error?.details).toEqual({ reason, message: words, action: 'create_customer' })
      }
      // W58: too_long is the one reason the old function didn't have.
      expect(new Set(cases.map(([, reason]) => reason))).toEqual(new Set([...CREATE_CUSTOMER_REASONS.filter((reason) => reason !== 'duplicate_email'), 'too_long']))
      expect(await emails()).toEqual(SEEDED)
      expect(await audit()).toEqual([])
      // 18 today is allowed.
      expect((await create({ ...DEE, dateOfBirth: '2008-11-10' })).status).toBe(200)
    })
  })

  it('W39a (review L1): an email holding a character nobody can see (a zero-width space, a byte-order mark, a control character) is refused with the old email words and nothing is written; a plain address is still taken, with the spaces, tabs and line ends around it trimmed as before', async () => {
    await seeded(async () => {
      const WORDS = 'A valid email address is required'
      const refusedEmails: Array<[string, string]> = [
        ['a zero-width space at the end', 'dee@example.com\u200B'],
        ['a zero-width space in the middle', 'dee\u200B@example.com'],
        ['a zero-width space at the start', '\u200Bdee@example.com'],
        ['a zero-width space at the end, then a space', 'dee@example.com\u200B '],
        ['a byte-order mark at the start', '\uFEFFdee@example.com'],
        ['a byte-order mark at the end', 'dee@example.com\uFEFF'],
        ['a byte-order mark at the start, after a space', ' \uFEFFdee@example.com'],
        ['a byte-order mark in the middle', 'dee@exa\uFEFFmple.com'],
        ['a tab inside', 'dee\t@example.com'],
        ['a null character inside', 'dee\u0000@example.com'],
        ['a soft hyphen inside', 'dee@exam\u00ADple.com'],
        ['a zero-width joiner inside', 'd\u200Dee@example.com'],
        // On an address already on file: refused as not an address, before the duplicate is looked for.
        ['a zero-width space after an address on file', 'sam@example.com\u200B'],
      ]
      for (const [what, email] of refusedEmails) {
        const answer = await create({ ...DEE, email })
        expect(refusal(answer), what).toBe(`400 VALIDATION email_invalid: ${WORDS}`)
        expect(answer.body.error?.field, what).toBe('email')
        expect(answer.body.error?.details, what).toEqual({ reason: 'email_invalid', message: WORDS, action: 'create_customer' })
      }
      expect(await emails()).toEqual(SEEDED)
      expect(await audit()).toEqual([])
      // The rule itself, on the channel the website will use: the same refusal.
      await expect(createCustomer(db, { ...DEE, email: 'web@example.com\u200B' }, { channel: 'customer', requestId: 'w39a-web' })).rejects.toMatchObject({ code: 'VALIDATION', message: WORDS, details: { reason: 'email_invalid' } })
      expect(await emails()).toEqual(SEEDED)
      // A plain address is still taken, and so is one with a tab and a line end after it (trimmed, as before).
      expect((await create(DEE)).body.data).toMatchObject({ email: 'dee@example.com' })
      expect((await create({ ...DEE, email: '\t Dee.Two@Example.com \r\n' })).body.data).toMatchObject({ email: 'dee.two@example.com' })
      expect(await emails()).toEqual([...SEEDED, 'dee@example.com', 'dee.two@example.com'])
      // Stored exactly as answered: no character but the address's own.
      const stored = await db.query<{ email: string; length: number }>("SELECT email, char_length(email) AS length FROM customers WHERE email LIKE 'dee%' ORDER BY email")
      expect(stored.map((row) => [row.email, Number(row.length)])).toEqual([['dee.two@example.com', 19], ['dee@example.com', 15]])
    })
  })

  it('FB23: a date of birth the calendar does not have is refused in our own words, never the database\'s; a real 29 February is taken', async () => {
    await seeded(async () => {
      for (const dateOfBirth of ['1990-02-30', '1990-02-29', '1991-04-31', '1990-13-01', '1990-00-10', '1990-01-00', '1990-01-32', '0000-01-01']) {
        const answer = await create({ ...DEE, dateOfBirth })
        expect(refusal(answer), dateOfBirth).toBe('400 VALIDATION date_of_birth_invalid: A valid date of birth is required')
        expect(JSON.stringify(answer.body)).not.toContain('out of range')
      }
      expect(await emails()).toEqual(SEEDED)
      for (const [email, dateOfBirth] of [
        ['leap@example.com', '1992-02-29'],
        ['century@example.com', '2000-02-29'],
        ['old@example.com', '1900-01-01'],
      ] as const) {
        expect((await create({ ...DEE, email, dateOfBirth })).body.data, dateOfBirth).toMatchObject({ email, date_of_birth: dateOfBirth })
      }
    })
  })

  it('the checks run before the database is touched: no transaction is opened and no statement sent for a bad field', async () => {
    const untouched = { query: vi.fn(), transaction: vi.fn() }
    const options = { channel: 'staff' as const, staffId: ID.staff, requestId: 'w39' }
    for (const fields of [{ ...DEE, firstName: '' }, { ...DEE, email: 'x' }, { ...DEE, dateOfBirth: '1990-02-30' }, { ...DEE, dateOfBirth: '2999-01-01' }]) {
      await expect(createCustomer(untouched as unknown as Db, fields, options)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(untouched.transaction).not.toHaveBeenCalled()
    expect(untouched.query).not.toHaveBeenCalled()
    untouched.transaction.mockRejectedValue(new Error('reached the database'))
    await expect(createCustomer(untouched as unknown as Db, DEE, options)).rejects.toThrow('reached the database')
  })
})

describe('create: what is written', () => {
  it('each field trimmed, the email lower-cased, a blank phone stored as none; the answer is the old function\'s row; one audit row with who and the channel', async () => {
    await seeded(async () => {
      const answer = await create({ firstName: '  Dee ', lastName: ' Dale ', email: '  Dee.Dale@Example.COM ', dateOfBirth: ' 1992-02-29 ', phone: ' 07700 900123 ' })
      expect(answer.status).toBe(200)
      const row = answer.body.data as Record<string, unknown>
      expect(Object.keys(row).sort()).toEqual(['created_at', 'date_of_birth', 'email', 'first_name', 'id', 'last_name', 'phone', 'updated_at'])
      expect(row).toMatchObject({ first_name: 'Dee', last_name: 'Dale', email: 'dee.dale@example.com', phone: '07700 900123', date_of_birth: '1992-02-29' })
      expect(String(row['created_at'])).toMatch(/^2026-11-10T09:\d\d:\d\d\.\d{3}Z$/)
      const second = await create({ ...DEE, email: 'dee.two@example.com', phone: '   ' })
      expect(second.body.data).toMatchObject({ email: 'dee.two@example.com', phone: null })
      // A customer just made has no saved card, in the list.
      expect(((await list({ customerId: String(row['id']) })).body.data as Array<Record<string, unknown>>)[0]).toMatchObject({ email: 'dee.dale@example.com', has_saved_card: false, saved_card_last4: null, store_credit_balance: '0.00' })
      const [stored] = await db.query<Record<string, unknown>>('SELECT auth_user_id, stripe_customer_id, saved_payment_method_id, store_credit_balance::text AS store_credit_balance, country, date_of_birth::text AS date_of_birth FROM customers WHERE id = $1', [String(row['id'])])
      expect(stored).toEqual({ auth_user_id: null, stripe_customer_id: null, saved_payment_method_id: null, store_credit_balance: '0.00', country: 'GB', date_of_birth: '1992-02-29' })
      expect(await audit()).toEqual([
        { action: 'customer.created', actor_type: 'staff', actor_id: ID.staff, entity_type: 'customer', entity_id: row['id'], details: { channel: 'staff' } },
        { action: 'customer.created', actor_type: 'staff', actor_id: ID.staff, entity_type: 'customer', entity_id: (second.body.data as { id: string }).id, details: { channel: 'staff' } },
      ])
    })
  })

  it('FB21: an email already on file is refused with the old duplicate words in any case, typed with spaces, and beside a row another writer added in capitals; nothing is written', async () => {
    await seeded(async () => {
      for (const email of ['sam@example.com', 'SAM@EXAMPLE.COM', ' Sam@Example.com ', 'sAm@eXaMpLe.CoM']) {
        const answer = await create({ ...DEE, email })
        expect(refusal(answer), email).toBe(`409 CONFLICT duplicate_email: ${DUPLICATE}`)
        expect(answer.body.error?.details).toEqual({ reason: 'duplicate_email', message: DUPLICATE, action: 'create_customer' })
        expect(answer.body.error?.field).toBe('email')
      }
      // Another writer's row, in capitals (the database's own key lets it sit beside nothing of ours).
      await insert(db, 'customers', { first_name: 'Cap', last_name: 'Ital', email: 'CAPITAL@Example.com', date_of_birth: '1990-01-01' })
      for (const email of ['capital@example.com', 'Capital@example.com', 'CAPITAL@Example.com']) {
        expect(refusal(await create({ ...DEE, email })), email).toBe(`409 CONFLICT duplicate_email: ${DUPLICATE}`)
      }
      expect(await emails()).toEqual([...SEEDED, 'CAPITAL@Example.com'])
      expect(await audit()).toEqual([])
      expect(DUPLICATE).toBe(CREATE_CUSTOMER_WORDS.duplicateEmail)
    })
  })

  it("the database's own refusal of a second row for the email (either unique rule) is answered as the duplicate refusal, never a fault; any other database refusal stays a fault", async () => {
    const options = { channel: 'staff' as const, staffId: ID.staff, requestId: 'w39' }
    const violating = (constraint: string | undefined, message: string, code = '23505') => {
      const err = Object.assign(new Error(message), { code, ...(constraint ? { constraint_name: constraint } : {}) })
      return { query: vi.fn(), transaction: vi.fn().mockRejectedValue(err) } as unknown as Db
    }
    for (const rule of CUSTOMER_EMAIL_UNIQUE_RULES) {
      await expect(createCustomer(violating(rule, 'duplicate key value violates unique constraint'), DEE, options)).rejects.toMatchObject({ code: 'CONFLICT', message: DUPLICATE, details: { reason: 'duplicate_email' } })
      // A driver that gives the rule only in its words.
      await expect(createCustomer(violating(undefined, `duplicate key value violates unique constraint "${rule}"`), DEE, options)).rejects.toMatchObject({ code: 'CONFLICT', message: DUPLICATE })
    }
    expect([...CUSTOMER_EMAIL_UNIQUE_RULES]).toEqual(['customers_email_key', 'customers_email_lower_key'])
    // Another unique rule, or another kind of refusal, is not a duplicate email.
    await expect(createCustomer(violating('customers_stripe_customer_id_key', 'duplicate key value violates unique constraint "customers_stripe_customer_id_key"'), DEE, options)).rejects.not.toMatchObject({ code: 'CONFLICT' })
    await expect(createCustomer(violating('customers_email_key', 'not a unique violation', '23514'), DEE, options)).rejects.not.toMatchObject({ code: 'CONFLICT' })
  })

  it('a repeated press under its key gets the first answer and makes one customer with one audit row; a changed press under that key is refused; a new key with the same email is a duplicate', async () => {
    await seeded(async () => {
      const key = crypto.randomUUID()
      const first = await create(DEE, { key })
      const again = await create(DEE, { key })
      expect(first.status).toBe(200)
      expect(first.replayed).toBe(false)
      expect(again.replayed).toBe(true)
      expect(again.body.data).toEqual(first.body.data)
      expect(await emails()).toEqual([...SEEDED, 'dee@example.com'])
      expect(await audit()).toHaveLength(1)
      expect((await create({ ...DEE, firstName: 'Dea' }, { key })).body.error?.code).toBe('IDEMPOTENCY_MISMATCH')
      expect(refusal(await create(DEE))).toBe(`409 CONFLICT duplicate_email: ${DUPLICATE}`)
      expect(await emails()).toEqual([...SEEDED, 'dee@example.com'])
      // A refusal is stored against its key too: the same press again gets the same refusal.
      const refusedKey = crypto.randomUUID()
      const refused = await create({ ...DEE, email: 'sam@example.com' }, { key: refusedKey })
      const refusedAgain = await create({ ...DEE, email: 'sam@example.com' }, { key: refusedKey })
      expect(refusal(refusedAgain)).toBe(refusal(refused))
      expect(refusedAgain.replayed).toBe(true)
    })
  })

  it('an audit row that fails leaves no customer: the create answers a fault with nothing written, and the same email can be created afterwards', async () => {
    await seeded(async () => {
      await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'customer.created'" }, async () => {
        const answer = await create(DEE)
        expect(answer.status).toBe(500)
        expect(answer.body.error?.code).toBe('INTERNAL')
      })
      expect(await emails()).toEqual(SEEDED)
      expect((await create(DEE)).status).toBe(200)
    })
  })

  it('the customer channel (the website, not routed yet) writes the same row, and its audit row names the new customer as who did it', async () => {
    await seeded(async () => {
      const made = await createCustomer(db, { ...DEE, email: 'Web@Example.com' }, { channel: 'customer', requestId: 'w39-web' })
      expect(made).toMatchObject({ email: 'web@example.com', first_name: 'Dee' })
      expect(await audit()).toEqual([{ action: 'customer.created', actor_type: 'customer', actor_id: made.id, entity_type: 'customer', entity_id: made.id, details: { channel: 'customer' } }])
      // The same rules: a duplicate in another case, and a date of birth are still asked for.
      await expect(createCustomer(db, { ...DEE, email: 'WEB@example.com' }, { channel: 'customer', requestId: 'w39-web' })).rejects.toMatchObject({ code: 'CONFLICT', message: DUPLICATE })
      await expect(createCustomer(db, { ...DEE, email: 'web2@example.com', dateOfBirth: '' }, { channel: 'customer', requestId: 'w39-web' })).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })
})

describe('the list (getCustomers)', () => {
  const more = async (seedDb: Db) => {
    await insert(seedDb, 'customers', { first_name: 'Wayne', last_name: 'Holland', email: 'wayne.h@example.org', phone: '07700 900555', date_of_birth: '1985-05-05', created_at: '2026-11-09T10:00:00Z' })
    await insert(seedDb, 'customers', { first_name: 'Holly', last_name: 'Wayne', email: 'holly@example.org', date_of_birth: '1985-05-05', created_at: '2026-11-09T11:00:00Z' })
    await insert(seedDb, 'customers', { first_name: 'Mary Ann', last_name: 'Lee', email: 'ma@example.org', date_of_birth: '1985-05-05', created_at: '2026-11-09T12:00:00Z' })
  }
  const names = (answer: Answer) => (answer.body.data as Array<{ first_name: string; last_name: string }>).map((row) => `${row.first_name} ${row.last_name}`)

  it('no staff record and an inactive account are refused (FB16); any active staff member reads it', async () => {
    await seeded(async () => {
      const queries: Array<Record<string, string>> = [{}, { search: 'sam' }, { customerId: ID.customer }]
      for (const query of queries) {
        expect(refusal(await list(query, { email: NOBODY }))).toBe(`401 UNAUTHORISED undefined: ${NO_STAFF_WORDS}`)
        expect(refusal(await list(query, { email: INACTIVE }))).toBe(`403 FORBIDDEN undefined: ${INACTIVE_WORDS}`)
        expect((await list(query, { email: FRONT_DESK })).status).toBe(200)
      }
    })
  })

  it('one customer by id, with exactly the named fields; none for an id nobody has, or one that is not an id', async () => {
    await seeded(async () => {
      const answer = await list({ customerId: ID.customer })
      const rows = answer.body.data as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual([...CUSTOMER_LIST_FIELDS].sort())
      expect(rows[0]).toMatchObject({ id: ID.customer, first_name: 'Sam', last_name: 'Test', email: 'sam@example.com', date_of_birth: '1990-01-01', has_saved_card: true, saved_card_last4: '4242', saved_card_brand: 'visa', store_credit_balance: '30.00', country: 'GB' })
      expect(JSON.stringify(rows[0])).not.toMatch(/cus_|pm_/)
      expect((await list({ customerId: W36_ID.unknown })).body.data).toEqual([])
      expect((await list({ customerId: 'not-an-id' })).body.data).toEqual([])
      // The id wins over a search sent with it, as before.
      expect(names(await list({ customerId: ID.customer, search: 'mo' }))).toEqual(['Sam Test'])
    })
  })

  it('a search: every word must be in a name, the email or the phone, in any case and any order; or the whole search in "first last"; newest first', async () => {
    await seeded(async () => {
      expect(names(await list({ search: 'wayne holland' }))).toEqual(['Wayne Holland'])
      expect(names(await list({ search: 'Holland WAYNE' }))).toEqual(['Wayne Holland'])
      expect(names(await list({ search: 'wayne hol' }))).toEqual(['Holly Wayne', 'Wayne Holland'])
      expect(names(await list({ search: 'wayne' }))).toEqual(['Holly Wayne', 'Wayne Holland'])
      expect(names(await list({ search: '  wayne   ' }))).toEqual(['Holly Wayne', 'Wayne Holland'])
      expect(names(await list({ search: 'holland@' }))).toEqual([])
      expect(names(await list({ search: 'wayne.h@' }))).toEqual(['Wayne Holland'])
      expect(names(await list({ search: '900555' }))).toEqual(['Wayne Holland'])
      expect(names(await list({ search: 'wayne 900555' }))).toEqual(['Wayne Holland'])
      expect(names(await list({ search: 'wayne nobody' }))).toEqual([])
      // A first name of two words, matched as the whole "first last".
      expect(names(await list({ search: 'mary ann lee' }))).toEqual(['Mary Ann Lee'])
      expect(names(await list({ search: 'ann lee' }))).toEqual(['Mary Ann Lee'])
      expect(names(await list({ search: 'example.org' }))).toEqual(['Mary Ann Lee', 'Holly Wayne', 'Wayne Holland'])
      // W58 (W45 audit row 15, W53 "For later" 4): `_` and `%` in a search are plain characters now. The old function
      // let them stand for any text, so "wayne_holland" found Wayne Holland; now nothing holds that text.
      expect(names(await list({ search: 'wayne_holland' }))).toEqual([])
      expect(names(await list({ search: 'ann%lee' }))).toEqual([])
      expect(names(await list({ search: 'wayne_nobody' }))).toEqual([])
      // The whole search against "first last" still decides for a search with the space in it.
      expect(names(await list({ search: 'y ann l' }))).toEqual(['Mary Ann Lee'])
      // Whether a card is saved, and its digits, are each customer's own: Sam has one, Wayne has none.
      const cards = async (query: Record<string, string>) => ((await list(query)).body.data as Array<Record<string, unknown>>).map((row) => [row['first_name'], row['has_saved_card'], row['saved_card_last4'], row['saved_card_brand']])
      expect(await cards({ search: 'sam' })).toEqual([['Sam', true, '4242', 'visa']])
      expect(await cards({ search: 'wayne holland' })).toEqual([['Wayne', false, null, null]])
      const [wayne] = (await list({ search: 'wayne holland' })).body.data as Array<{ id: string }>
      expect(await cards({ customerId: String(wayne?.id) })).toEqual([['Wayne', false, null, null]])
      expect((await cards({})).filter(([, saved]) => saved === false).map(([name]) => name)).toEqual(['Mary Ann', 'Holly', 'Wayne'])
      // Typed text is bound, never built into the statement.
      expect(names(await list({ search: "'; DROP TABLE customers; --" }))).toEqual([])
      expect((await customers()).length).toBe(5)
    }, more)
  })

  it('no search, or only spaces, is everyone, newest first; never more than 200', async () => {
    await seeded(async () => {
      // The seed's two were made at the replay's clock (the same moment: in id order), the three others the day before.
      expect(names(await list())).toEqual(['Sam Test', 'Mo Member', 'Mary Ann Lee', 'Holly Wayne', 'Wayne Holland'])
      expect(names(await list({ search: '   ' }))).toEqual(names(await list()))
      await db.query("INSERT INTO customers (first_name, last_name, email, date_of_birth, created_at) SELECT 'Bulk', n::text, 'bulk' || n || '@example.net', '1990-01-01', '2020-01-01'::timestamptz + n * interval '1 minute' FROM generate_series(1, 210) n")
      const everyone = (await list()).body.data as Array<{ last_name: string }>
      expect(everyone).toHaveLength(200)
      const bulk = (await list({ search: 'bulk' })).body.data as Array<{ last_name: string }>
      expect(bulk).toHaveLength(200)
      expect(bulk[0]?.last_name).toBe('210')
    }, more)
  })

  it('named fields: a column added to customers is not read by the list, and the names are the contract\'s', async () => {
    expect([...CUSTOMER_LIST_FIELDS].sort()).toEqual(Object.keys(customerListRowSchema.shape).sort())
    await seeded(async () => {
      await db.query('RESET ROLE')
      await db.query("ALTER TABLE customers ADD COLUMN w39_secret text DEFAULT 'not for the list'")
      await db.query('SET ROLE paddock_worker')
      for (const rows of [await listCustomers(db, {}), await listCustomers(db, { search: 'sam' }), await listCustomers(db, { customerId: ID.customer })]) {
        expect(rows.length).toBeGreaterThan(0)
        expect(JSON.stringify(rows)).not.toContain('not for the list')
        for (const row of rows) expect(Object.keys(row).sort()).toEqual([...CUSTOMER_LIST_FIELDS].sort())
      }
      await db.query('RESET ROLE')
      await db.query('ALTER TABLE customers DROP COLUMN w39_secret')
      await db.query('SET ROLE paddock_worker')
    })
  })
})

describe('the detail (getCustomerDetail)', () => {
  const detailScenario = scenarios.find((one) => one.name === 'w36-customer-detail')

  it('no staff record and an inactive account are refused (FB16); an id that is not one is refused; a customer nobody has answers empty lists and a balance of 0', async () => {
    await seeded(async () => {
      expect(refusal(await detail(ID.customer, { email: NOBODY }))).toBe(`401 UNAUTHORISED undefined: ${NO_STAFF_WORDS}`)
      expect(refusal(await detail(ID.customer, { email: INACTIVE }))).toBe(`403 FORBIDDEN undefined: ${INACTIVE_WORDS}`)
      expect((await detail(ID.customer, { email: FRONT_DESK })).status).toBe(200)
      expect((await detail('not-an-id')).body.error).toMatchObject({ code: 'VALIDATION', field: 'customerId' })
      expect((await detail(W36_ID.unknown)).body.data).toEqual({ memberships: [], sessionPasses: [], bookingHistory: [], storeCreditBalance: '0', storeCreditHistory: [], eventBookings: [] })
    })
  })

  it("Sam: a pass and £30 of store credit; Mo, on W36's own profile scenario: a membership with its credit period and the payment date refusal, a booking waiting for payment, a store credit movement and an event place", async () => {
    if (!detailScenario) throw new Error('No w36-customer-detail scenario')
    await replay(
      environment,
      {
        name: 'w39 detail',
        seed: detailScenario.seed,
        async run(context) {
          // The scenario's own steps, through the old functions: Mo's credit seat, flagged payment needed; an event place; £15 of store credit.
          await detailScenario.run(context)
          const sam = (await detail(ID.customer)).body.data as Record<string, unknown[]>
          expect(sam['memberships']).toEqual([])
          expect(sam['sessionPasses']).toEqual([
            expect.objectContaining({ id: ID.ownedPass, customer_id: ID.customer, pass_type_id: ID.passType, pass_type_name: 'Five Sessions', pass_type_level: 'all_access', purchase_date: '2026-11-10', expiry_date: '2030-01-01', sessions_remaining: 3 }),
          ])
          expect(Object.keys(sam['sessionPasses']?.[0] ?? {}).sort()).toEqual([...CUSTOMER_PASS_COLUMNS, 'pass_type_level', 'pass_type_name'].sort())
          expect(sam['storeCreditBalance']).toBe('30.00')
          const mo = (await detail(ID.member)).body.data as Record<string, Array<Record<string, unknown>>> & { storeCreditBalance: string }
          expect(mo['memberships']).toHaveLength(1)
          expect(mo['memberships']?.[0]).toMatchObject({
            id: ID.membership,
            plan_name: 'Core',
            plan_is_unlimited: false,
            billing_frequency: 'monthly',
            subscription_status: 'active',
            start_date: '2026-01-10',
            next_renewal_date: '2026-12-10',
            cancel_effective_date: null,
            stripe_subscription_id: 'sub_mo',
            current_period_end: '2026-12-09',
            current_period_credits_allocated: 4,
            current_period_credits_remaining: 3,
            payment_date_changed_at: null,
            payment_date_change_blocked: 'Bookings on this membership are waiting for payment (Payment needed)',
            payment_date_change_needs_override: false,
          })
          expect(Object.keys(mo['memberships']?.[0] ?? {}).some((name) => name.startsWith('pdc_'))).toBe(false)
          expect(Object.keys(mo['memberships']?.[0] ?? {}).sort()).toEqual(
            [...CUSTOMER_MEMBERSHIP_COLUMNS, 'plan_name', 'plan_is_unlimited', 'current_period_end', 'current_period_credits_allocated', 'current_period_credits_remaining', 'refunded', 'payment_date_changed_at', 'payment_date_change_blocked', 'payment_date_change_needs_override'].sort()
          )
          // W40 (W35 row 10): the rows are read by memberships/list.ts now, and say whether the membership was refunded.
          expect(mo['memberships']?.[0]?.['refunded']).toBe(false)
          expect(mo['bookingHistory']).toEqual([expect.objectContaining({ status: 'payment_needed', party_size: 1, price_paid: '0.00', service_type_name: 'Sauna', checked_in_at: null })])
          expect(String(mo['bookingHistory']?.[0]?.['payment_due_by'])).toMatch(/^2026-11-11T/)
          expect(mo.storeCreditBalance).toBe('15.00')
          expect(mo['storeCreditHistory']).toEqual([expect.objectContaining({ amount: '15.00', balance_after: '15.00', reason: 'manual_adjustment', note: 'Goodwill for a cold sauna', order_id: null, booking_id: null })])
          expect(mo['eventBookings']).toEqual([
            expect.objectContaining({ event_id: ID.event, event_name: 'Full Moon Sauna', places: 1, status: 'confirmed', price_paid: '20.00', attendee_count: 1, checked_in_count: 0, waivers_outstanding: 1, places_total: 1, cancelled_places: 0, event_cancelled_at: null }),
          ])
          expect(Number(mo['eventBookings']?.[0]?.['refunded_amount'])).toBe(0)
          expect(Number(mo['eventBookings']?.[0]?.['card_refunded_amount'])).toBe(0)
        },
      },
      oldSide
    )
  })

  /** A copy of one row with some columns given as SQL (test data only: the names come from the catalog and from this file). Triggers and foreign keys are off for the insert. */
  async function copyRow(table: 'bookings' | 'events' | 'event_bookings', id: string, changes: Record<string, string>): Promise<string> {
    const names = (
      await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name <> 'id' AND is_generated = 'NEVER' ORDER BY ordinal_position",
        [table]
      )
    ).map((row) => row.column_name)
    const values = names.map((name) => changes[name] ?? name)
    const statement = `INSERT INTO ${table} (${names.join(', ')}) SELECT ${values.join(', ')} FROM ${table} WHERE id = $1::uuid RETURNING id`
    await db.query('RESET ROLE')
    await db.query('SET session_replication_role = replica')
    try {
      const [row] = await db.query<{ id: string }>(statement, [id])
      if (!row) throw new Error(`No ${table} row ${id} to copy`)
      return row.id
    } finally {
      await db.query('SET session_replication_role = DEFAULT')
      await db.query('SET ROLE paddock_worker')
    }
  }

  it("Mo's event place: a waiver is outstanding when the standard one is unsigned, or the event's extra one is unsigned or signed on an older version; a cancelled place leaves the counts and shows what went back; the latest event and the latest session come first", async () => {
    if (!detailScenario) throw new Error('No w36-customer-detail scenario')
    await replay(
      environment,
      {
        name: 'w39 detail counts',
        seed: detailScenario.seed,
        async run(context) {
          await detailScenario.run(context)
          type Place = { id: string; event_name: string; attendee_count: number; checked_in_count: number; waivers_outstanding: number; places_total: number; cancelled_places: number; refunded_amount: string; card_refunded_amount: string }
          const places = async () => ((await detail(ID.member)).body.data as { eventBookings: Place[] }).eventBookings
          const only = async () => {
            const [place] = await places()
            if (!place) throw new Error('No event booking')
            return place
          }
          const attendee = (set: string) => {
            // Test data only: each `set` is a literal below.
            const statement = `UPDATE event_attendees SET ${set}`
            return db.query(statement)
          }
          // As placed: the standard waiver unsigned.
          expect(await only()).toMatchObject({ attendee_count: 1, checked_in_count: 0, waivers_outstanding: 1, places_total: 1, cancelled_places: 0 })
          // The standard waiver signed, no extra waiver on the event: none outstanding.
          await attendee('waiver_accepted = true')
          expect((await only()).waivers_outstanding).toBe(0)
          // The event asks for its own waiver (version 2): unsigned is outstanding; signed on version 1 is outstanding; signed on version 2 is not.
          await db.query("UPDATE events SET has_extra_waiver = true, extra_waiver_version = '2' WHERE id = $1", [ID.event])
          expect((await only()).waivers_outstanding).toBe(1)
          await attendee("event_waiver_accepted = true, event_waiver_version = '1'")
          expect((await only()).waivers_outstanding).toBe(1)
          await attendee("event_waiver_version = '2'")
          expect((await only()).waivers_outstanding).toBe(0)
          // Checked in.
          await attendee('checked_in_at = now()')
          expect(await only()).toMatchObject({ attendee_count: 1, checked_in_count: 1 })
          // Cancelled, with £20 given back, £5 of it to the card: out of the three counts, in the two totals.
          await attendee('cancelled_at = now(), waiver_accepted = false, refunded_amount = 20, card_refunded_amount = 5')
          const cancelled = await only()
          expect(cancelled).toMatchObject({ attendee_count: 0, checked_in_count: 0, waivers_outstanding: 0, places_total: 1, cancelled_places: 1 })
          expect([Number(cancelled.refunded_amount), Number(cancelled.card_refunded_amount)]).toEqual([20, 5])

          // A later event, with its own place: the latest event first.
          const later = await copyRow('events', ID.event, { name: "'Later Event'", sanity_event_id: 'NULL', starts_at: "starts_at + interval '7 days'", ends_at: "ends_at + interval '7 days'" })
          await copyRow('event_bookings', cancelled.id, { event_id: `'${later}'::uuid` })
          expect((await places()).map((place) => place.event_name)).toEqual(['Later Event', 'Full Moon Sauna'])

          // A second booking, on the other seeded session: the latest session first.
          const [booking] = await db.query<{ id: string; session_id: string }>('SELECT id, session_id FROM bookings WHERE customer_id = $1', [ID.member])
          if (!booking) throw new Error('No booking')
          const other = booking.session_id === ID.session ? ID.peakSession : ID.session
          // Cancelled, so the database's own rule against two live bookings at one time lets it in; the history lists every status.
          const copy = await copyRow('bookings', booking.id, { session_id: `'${other}'::uuid`, status: "'cancelled'" })
          const sessions = await db.query<{ id: string }>('SELECT id FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY start_time DESC', [[booking.session_id, other]])
          const history = ((await detail(ID.member)).body.data as { bookingHistory: Array<{ id: string }> }).bookingHistory
          const bySession = new Map([
            [booking.session_id, booking.id],
            [other, copy],
          ])
          expect(history.map((row) => row.id)).toEqual(sessions.map((session) => bySession.get(session.id)))
          expect(history).toHaveLength(2)
        },
      },
      oldSide
    )
  })

  it('store credit: the last 100 movements, newest first', async () => {
    await seeded(async () => {
      await db.query(
        "INSERT INTO store_credit_transactions (customer_id, amount, balance_after, reason, note, created_at) SELECT $1::uuid, 1, n, 'manual_adjustment', 'Movement ' || n, '2026-01-01'::timestamptz + n * interval '1 hour' FROM generate_series(1, 105) n",
        [ID.customer]
      )
      const history = ((await detail(ID.customer)).body.data as { storeCreditHistory: Array<{ note: string }> }).storeCreditHistory
      expect(history).toHaveLength(100)
      expect(history[0]?.note).toBe('Movement 105')
      expect(history.at(-1)?.note).toBe('Movement 6')
    })
  })

  it("named fields: the membership and pass columns are every column the saved schema has (what the old `*` gave) but the one W36's contract leaves out, and each is the contract's; a column added to either table, or to customers, is not read", async () => {
    const schema = readFileSync(path.resolve(__dirname, '../testing/live-schema.sql'), 'utf8')
    const columnsOf = (table: string): string[] => {
      const body = new RegExp(`CREATE TABLE public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);`).exec(schema)?.[1] ?? ''
      return body.split('\n').map((line) => line.trim().split(' ')[0] ?? '')
    }
    const sent = (table: string) => columnsOf(table).filter((column) => !(CUSTOMER_COLUMNS_NOT_SENT as readonly string[]).includes(column))
    expect([...CUSTOMER_COLUMNS_NOT_SENT]).toEqual(['order_line_item_id'])
    for (const table of ['customer_memberships', 'customer_session_passes']) expect(columnsOf(table), table).toContain('order_line_item_id')
    expect([...CUSTOMER_MEMBERSHIP_COLUMNS]).toEqual(sent('customer_memberships'))
    expect([...CUSTOMER_PASS_COLUMNS]).toEqual(sent('customer_session_passes'))
    expect(Object.keys(customerMembershipRowSchema.shape)).not.toContain('order_line_item_id')
    expect(Object.keys(customerSessionPassRowSchema.shape)).not.toContain('order_line_item_id')
    for (const column of CUSTOMER_MEMBERSHIP_COLUMNS) expect(Object.keys(customerMembershipRowSchema.shape), column).toContain(column)
    for (const column of CUSTOMER_PASS_COLUMNS) expect(Object.keys(customerSessionPassRowSchema.shape), column).toContain(column)
    await seeded(async () => {
      await db.query('RESET ROLE')
      // Test data only: each statement is a literal.
      for (const statement of [
        "ALTER TABLE customer_memberships ADD COLUMN w39_secret text DEFAULT 'not for the profile'",
        "ALTER TABLE customer_session_passes ADD COLUMN w39_secret text DEFAULT 'not for the profile'",
        "ALTER TABLE customers ADD COLUMN w39_secret text DEFAULT 'not for the profile'",
      ]) {
        await db.query(statement)
      }
      await db.query('SET ROLE paddock_worker')
      const mo = await getCustomerDetail(db, ID.member)
      const sam = await getCustomerDetail(db, ID.customer)
      expect(mo.memberships).toHaveLength(1)
      expect(sam.sessionPasses).toHaveLength(1)
      expect(JSON.stringify([mo, sam])).not.toContain('not for the profile')
      await db.query('RESET ROLE')
      for (const statement of ['ALTER TABLE customer_memberships DROP COLUMN w39_secret', 'ALTER TABLE customer_session_passes DROP COLUMN w39_secret', 'ALTER TABLE customers DROP COLUMN w39_secret']) {
        await db.query(statement)
      }
      await db.query('SET ROLE paddock_worker')
    })
  })
})
