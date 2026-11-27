import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as meRoute } from '@/app/api/v1/customer/me/route'
import { POST as createRoute } from '@/app/api/v1/customer/sign-in/create/route'
import { POST as linkRoute } from '@/app/api/v1/customer/sign-in/link/route'
import { CUSTOMER_SIGN_IN_REASONS, customerListOutputSchema, customerMeOutputSchema, customerSignInLinkOutputSchema, customerSignInRefusalDetailsSchema } from '@/contracts'
import { listCustomers } from '@/server/rules/customers/read'
import type { Db } from '@/server/db'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { ID, seed } from '@/server/rules/testing/replay/scenarios'
import { FakeStripe } from '@/server/stripe/fake'
import { SIGN_IN_REASONS, SIGN_IN_WORDS } from './sign-in-words'

// Brief W85a items 2-4 (backend log 9, 25): the website's sign-in routes, through the routes as the website calls them,
// on the live schema (its unique rules on the email and the login, and migration 036's optional date of birth). The
// login's token is stood in for here as "<auth user id>|<email>", as if checked: how a real token is checked (and its
// email confirmed) is server/auth/customer.test.ts's. The race with a staff create is sign-in-postgres.test.ts's.

vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/auth/customer', async (importOriginal) => {
  const login = (token: string) => {
    const [authUserId = '', email = ''] = token.split('|')
    return { authUserId, email }
  }
  return {
    ...(await importOriginal<typeof import('@/server/auth/customer')>()),
    defaultSignInVerifier: () => async (token: string) => login(token),
    defaultTokenVerifier: () => async (token: string) => ({ authUserId: login(token).authUserId }),
  }
})

let n = 0
/** A new Supabase login (a row in the stand-in auth.users), with its token. */
async function newLogin(email: string): Promise<{ id: string; token: string }> {
  n += 1
  const id = `44000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  await database.pg.exec(`RESET ROLE; INSERT INTO auth.users (id) VALUES ('${id}'); SET ROLE paddock_worker;`)
  return { id, token: `${id}|${email}` }
}

type ErrorBody = { code: string; message: string; field?: string; details?: { reason?: string; message?: string } }
type Answer = { status: number; body: { ok: boolean; data?: Record<string, unknown>; error?: ErrorBody } }
type Handler = (request: Request) => Promise<Response>

async function call(handler: unknown, method: 'GET' | 'POST', path: string, token: string | null, body?: unknown): Promise<Answer> {
  const response = await (handler as Handler)(
    new Request(`https://worker.test/api/v1/customer/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  )
  return { status: response.status, body: (await response.json()) as Answer['body'] }
}
const link = (token: string | null, body: unknown = {}) => call(linkRoute, 'POST', 'sign-in/link', token, body)
const create = (token: string | null, body: unknown) => call(createRoute, 'POST', 'sign-in/create', token, body)
const me = (token: string | null) => call(meRoute, 'GET', 'me', token)

function refused(answer: Answer, status: number, code: string, reason: string, message: string): void {
  expect(answer.status).toBe(status)
  expect(answer.body.error).toMatchObject({ code, message, details: { reason, message } })
  expect(customerSignInRefusalDetailsSchema.safeParse(answer.body.error?.details).success).toBe(true)
}

const customersOf = (email: string) =>
  db.query<{ id: string; first_name: string; last_name: string; email: string; phone: string | null; date_of_birth: string | null; auth_user_id: string | null }>(
    'SELECT id, first_name, last_name, email, phone, date_of_birth::text AS date_of_birth, auth_user_id::text AS auth_user_id FROM customers WHERE lower(email) = lower($1) ORDER BY created_at, id',
    [email]
  )
const auditOf = (customerId: string) =>
  db.query<{ action: string; actor_type: string; actor_id: string | null; details: Record<string, unknown> }>(
    'SELECT action, actor_type, actor_id, details FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY at, ctid',
    ['customer', customerId]
  )
const staffMade = (email: string, row: Record<string, unknown> = {}) =>
  insert(db, 'customers', { first_name: 'Staff', last_name: 'Made', email, date_of_birth: '1985-05-05', phone: '07700 900001', ...row })

let database: TestDatabase
let db: Db
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
  await seed(db, new FakeStripe())
}, 120_000)
afterAll(() => database.stop())

describe('the words (W85a)', () => {
  it("the contract's reasons are the rule's, and every word is plain and says what to do", () => {
    expect([...CUSTOMER_SIGN_IN_REASONS]).toEqual([...SIGN_IN_REASONS])
    expect(SIGN_IN_WORDS.emailLinkedElsewhere).toBe('This email is linked to another sign-in. Please contact us.')
    for (const words of [SIGN_IN_WORDS.emailLinkedElsewhere, SIGN_IN_WORDS.emailNotConfirmed, SIGN_IN_WORDS.noEmail, SIGN_IN_WORDS.firstNameRequired, SIGN_IN_WORDS.lastNameRequired]) {
      expect(words).toMatch(/^[A-Z].*\.$/)
      expect(words).not.toMatch(/Stripe|staff|Supabase|token|auth_user/i)
    }
  })
})

describe('link on sign-in (POST /api/v1/customer/sign-in/link)', () => {
  it('no customer has the email: needs details, and nothing is written', async () => {
    const login = await newLogin('nobody.yet@example.com')
    const answer = await link(login.token)
    expect(answer.status).toBe(200)
    expect(answer.body.data).toEqual({ status: 'needs_details' })
    expect(customerSignInLinkOutputSchema.safeParse(answer.body.data).success).toBe(true)
    expect(await customersOf('nobody.yet@example.com')).toEqual([])
    const who = await me(login.token)
    expect([who.status, who.body.error?.code]).toEqual([403, 'CUSTOMER_NOT_LINKED'])
  })

  it('one customer with the email and no login: linked at once (their store credit, passes and membership are theirs on the site), with its audit row', async () => {
    const id = await staffMade('pat.linked@example.com', { store_credit_balance: '12.50' })
    const login = await newLogin('pat.linked@example.com')
    const answer = await link(login.token)
    expect(answer.status).toBe(200)
    expect(answer.body.data).toEqual({ status: 'linked', customer: { firstName: 'Staff', email: 'pat.linked@example.com' }, change: 'linked' })
    expect((await customersOf('pat.linked@example.com'))[0]).toMatchObject({ id, auth_user_id: login.id, first_name: 'Staff', date_of_birth: '1985-05-05' })
    expect(await auditOf(id)).toEqual([{ action: 'customer.login_linked', actor_type: 'customer', actor_id: id, details: { authUserId: login.id, how: 'sign_in' } }])
    expect((await me(login.token)).body.data).toMatchObject({ firstName: 'Staff', sections: ['dashboard', 'store_credit', 'details', 'preferences'] })
  })

  it('the match is in any case: a customer stored in capitals (imported) is the login of the same address in small letters', async () => {
    const id = await staffMade('Imported.Member@Example.COM')
    const login = await newLogin('imported.member@example.com')
    const answer = await link(login.token)
    expect(answer.body.data).toMatchObject({ status: 'linked', change: 'linked', customer: { email: 'Imported.Member@Example.COM' } })
    expect((await customersOf('imported.member@example.com')).map((row) => [row.id, row.auth_user_id])).toEqual([[id, login.id]])
  })

  it('called twice: the second answers linked with nothing done, and there is still one audit row', async () => {
    const id = await staffMade('twice@example.com')
    const login = await newLogin('twice@example.com')
    expect((await link(login.token)).body.data).toMatchObject({ status: 'linked', change: 'linked' })
    expect((await link(login.token)).body.data).toEqual({ status: 'linked', customer: { firstName: 'Staff', email: 'twice@example.com' }, change: 'none' })
    expect((await auditOf(id)).map((row) => row.action)).toEqual(['customer.login_linked'])
  })

  it("a linked login whose email has changed since (in Supabase) is still found by its login: link and create answer linked, and no customer is made for the new email", async () => {
    const id = await staffMade('changed.before@example.com')
    const login = await newLogin('changed.before@example.com')
    expect((await link(login.token)).body.data).toMatchObject({ change: 'linked' })
    const changed = `${login.id}|changed.after@example.com`
    expect((await link(changed)).body.data).toEqual({ status: 'linked', customer: { firstName: 'Staff', email: 'changed.before@example.com' }, change: 'none' })
    expect((await create(changed, { firstName: 'New', lastName: 'Email' })).body.data).toMatchObject({ change: 'none', customer: { firstName: 'Staff' } })
    expect(await customersOf('changed.after@example.com')).toEqual([])
    expect((await customersOf('changed.before@example.com')).map((row) => [row.id, row.auth_user_id])).toEqual([[id, login.id]])
  })

  it("the customer is already linked to a different login: refused in the site's words, nothing changes, and it is logged for staff", async () => {
    const id = await staffMade('taken@example.com')
    const first = await newLogin('taken@example.com')
    expect((await link(first.token)).body.data).toMatchObject({ change: 'linked' })
    const second = await newLogin('taken@example.com')
    const answer = await link(second.token)
    refused(answer, 409, 'CONFLICT', 'email_linked_elsewhere', 'This email is linked to another sign-in. Please contact us.')
    expect((await customersOf('taken@example.com')).map((row) => row.auth_user_id)).toEqual([first.id])
    expect((await auditOf(id)).map((row) => [row.action, row.actor_type, row.actor_id, row.details])).toEqual([
      ['customer.login_linked', 'customer', id, { authUserId: first.id, how: 'sign_in' }],
      ['customer.sign_in_refused', 'customer', null, { reason: 'email_linked_elsewhere', refusedAuthUserId: second.id, linkedAuthUserId: first.id }],
    ])
    // The turned-away login has no customer; the first still has theirs.
    expect((await me(second.token)).body.error?.code).toBe('CUSTOMER_NOT_LINKED')
    expect((await me(first.token)).status).toBe(200)
  })

  it('the email is the token\'s, never the body\'s: an email sent in the body is not read', async () => {
    const sam = (await customersOf('sam@example.com'))[0]
    const login = await newLogin('someone.else@example.com')
    const answer = await link(login.token, { email: 'sam@example.com' })
    expect(answer.body.data).toEqual({ status: 'needs_details' })
    expect((await customersOf('sam@example.com'))[0]?.auth_user_id).toBe(sam?.auth_user_id ?? null)
    expect(sam?.id).toBe(ID.customer)
  })

  it('no sign-in: refused before anything is read', async () => {
    const answer = await link(null)
    expect(answer.status).toBe(401)
    expect(answer.body.error?.code).toBe('UNAUTHORISED')
  })
})

describe('create on sign-up (POST /api/v1/customer/sign-in/create)', () => {
  it('makes the customer from the names, the phone if given and the token\'s email; no date of birth; linked in the same transaction with two audit rows', async () => {
    const login = await newLogin('new.person@example.com')
    expect((await link(login.token)).body.data).toEqual({ status: 'needs_details' })
    const answer = await create(login.token, { firstName: '  Nia ', lastName: ' New ', phone: ' 07700 900222 ' })
    expect(answer.status).toBe(200)
    expect(answer.body.data).toEqual({ status: 'linked', customer: { firstName: 'Nia', email: 'new.person@example.com' }, change: 'created' })
    const [row] = await customersOf('new.person@example.com')
    expect(row).toMatchObject({ first_name: 'Nia', last_name: 'New', email: 'new.person@example.com', phone: '07700 900222', date_of_birth: null, auth_user_id: login.id })
    expect(await auditOf(row?.id as string)).toEqual([
      { action: 'customer.created', actor_type: 'customer', actor_id: row?.id, details: { channel: 'customer', marketingConsent: false } },
      { action: 'customer.login_linked', actor_type: 'customer', actor_id: row?.id, details: { authUserId: login.id, how: 'sign_up' } },
    ])
    const who = await me(login.token)
    expect(customerMeOutputSchema.safeParse(who.body.data).success).toBe(true)
    expect(who.body.data).toEqual({ firstName: 'Nia', email: 'new.person@example.com', sections: ['dashboard', 'details', 'preferences'] })
  })

  it("staff's customer list (getCustomers: the Customers page, the picker, New Order) shows a website customer with no date of birth as null, within its contract", async () => {
    const login = await newLogin('list.nodob@example.com')
    await create(login.token, { firstName: 'Lis', lastName: 'Ted' })
    const rows = await listCustomers(db, { search: 'list.nodob' })
    expect(rows.map((row) => [row.email, row.date_of_birth])).toEqual([['list.nodob@example.com', null]])
    expect(customerListOutputSchema.safeParse(rows).success).toBe(true)
  })

  // W85 (Wayne, 30 Nov): the popup's "Email me with news and offers" tick, so nobody who ticks it is lost.
  const consentOf = async (email: string) =>
    (await db.query<{ marketing_consent: boolean }>('SELECT marketing_consent FROM customers WHERE lower(email) = lower($1)', [email])).map((row) => row.marketing_consent)

  it('W85: the news and offers tick is saved on the new customer and in its audit row; left out, or anything but true, is no', async () => {
    const ticked = await newLogin('ticked@example.com')
    expect((await create(ticked.token, { firstName: 'Tick', lastName: 'Ed', marketingConsent: true })).body.data).toMatchObject({ change: 'created' })
    expect(await consentOf('ticked@example.com')).toEqual([true])
    const [row] = await customersOf('ticked@example.com')
    expect((await auditOf(row?.id as string))[0]?.details).toEqual({ channel: 'customer', marketingConsent: true })

    const unticked = await newLogin('unticked@example.com')
    await create(unticked.token, { firstName: 'Un', lastName: 'Ticked', marketingConsent: false })
    expect(await consentOf('unticked@example.com')).toEqual([false])
    const silent = await newLogin('silent@example.com')
    await create(silent.token, { firstName: 'Sil', lastName: 'Ent' })
    expect(await consentOf('silent@example.com')).toEqual([false])
    // Not a boolean: refused by the contract, and nothing is made.
    const odd = await newLogin('odd.consent@example.com')
    expect((await create(odd.token, { firstName: 'Odd', lastName: 'One', marketingConsent: 'yes' })).status).toBe(400)
    expect(await consentOf('odd.consent@example.com')).toEqual([])
  })

  it("W85: a customer found instead of made (staff made one meanwhile) keeps their own consent, as they keep their details", async () => {
    await staffMade('consent.kept@example.com')
    const login = await newLogin('consent.kept@example.com')
    expect((await create(login.token, { firstName: 'Web', lastName: 'Name', marketingConsent: true })).body.data).toMatchObject({ change: 'linked' })
    expect(await consentOf('consent.kept@example.com')).toEqual([false])
  })

  it('no phone: stored as none', async () => {
    const login = await newLogin('no.phone@example.com')
    expect((await create(login.token, { firstName: 'No', lastName: 'Phone' })).body.data).toMatchObject({ change: 'created' })
    expect((await customersOf('no.phone@example.com'))[0]?.phone).toBeNull()
  })

  it('called twice: the second answers linked with nothing done, and there is one customer', async () => {
    const login = await newLogin('create.twice@example.com')
    expect((await create(login.token, { firstName: 'Cee', lastName: 'Twice' })).body.data).toMatchObject({ change: 'created' })
    const again = await create(login.token, { firstName: 'Other', lastName: 'Name' })
    expect(again.body.data).toEqual({ status: 'linked', customer: { firstName: 'Cee', email: 'create.twice@example.com' }, change: 'none' })
    expect((await customersOf('create.twice@example.com')).map((row) => row.first_name)).toEqual(['Cee'])
    // W85a review (a)3: a second call answers linked whatever it sends, an empty body or names too long.
    expect((await create(login.token, {})).body.data).toMatchObject({ status: 'linked', change: 'none' })
    expect((await create(login.token, { firstName: 'x'.repeat(500), lastName: '' })).body.data).toMatchObject({ status: 'linked', change: 'none' })
  })

  it('W85a review (a)3: a staff customer of the email and an empty body: create still ends in the link (the names are only asked for a new customer)', async () => {
    const id = await staffMade('empty.body@example.com')
    const login = await newLogin('empty.body@example.com')
    expect((await create(login.token, {})).body.data).toEqual({ status: 'linked', customer: { firstName: 'Staff', email: 'empty.body@example.com' }, change: 'linked' })
    expect((await customersOf('empty.body@example.com')).map((row) => [row.id, row.auth_user_id])).toEqual([[id, login.id]])
  })

  it('a customer of the email made by staff between link and create: create ends in the link, and their own details are kept', async () => {
    const login = await newLogin('meanwhile@example.com')
    expect((await link(login.token)).body.data).toEqual({ status: 'needs_details' })
    const id = await staffMade('meanwhile@example.com')
    const answer = await create(login.token, { firstName: 'Web', lastName: 'Name', phone: '0000' })
    expect(answer.body.data).toEqual({ status: 'linked', customer: { firstName: 'Staff', email: 'meanwhile@example.com' }, change: 'linked' })
    expect(await customersOf('meanwhile@example.com')).toEqual([
      { id, first_name: 'Staff', last_name: 'Made', email: 'meanwhile@example.com', phone: '07700 900001', date_of_birth: '1985-05-05', auth_user_id: login.id },
    ])
    expect((await auditOf(id)).map((row) => row.details)).toEqual([{ authUserId: login.id, how: 'sign_up' }])
  })

  it('the email linked to another login: refused as link refuses, logged, and nothing is made', async () => {
    await staffMade('create.taken@example.com')
    const first = await newLogin('create.taken@example.com')
    await link(first.token)
    const second = await newLogin('create.taken@example.com')
    refused(await create(second.token, { firstName: 'Second', lastName: 'Login' }), 409, 'CONFLICT', 'email_linked_elsewhere', SIGN_IN_WORDS.emailLinkedElsewhere)
    expect((await customersOf('create.taken@example.com')).map((row) => row.auth_user_id)).toEqual([first.id])
  })

  it("the email is the token's: an email in the body is not read, and makes no customer of its own", async () => {
    const login = await newLogin('token.email@example.com')
    const answer = await create(login.token, { firstName: 'Tee', lastName: 'Oken', email: 'body.email@example.com' })
    expect(answer.body.data).toMatchObject({ change: 'created', customer: { email: 'token.email@example.com' } })
    expect(await customersOf('body.email@example.com')).toEqual([])
  })

  it('its checks, each with a field and nothing written: a first name, a last name, the lengths the staff form allows', async () => {
    const login = await newLogin('checks@example.com')
    const cases: Array<[Record<string, unknown>, string, string, string]> = [
      [{ firstName: '  ', lastName: 'Last' }, 'first_name_required', SIGN_IN_WORDS.firstNameRequired, 'firstName'],
      [{ firstName: 'First', lastName: '' }, 'last_name_required', SIGN_IN_WORDS.lastNameRequired, 'lastName'],
      [{ firstName: 'x'.repeat(101), lastName: 'Last' }, 'too_long', 'First name can be at most 100 characters.', 'firstName'],
      [{ firstName: 'First', lastName: 'y'.repeat(101) }, 'too_long', 'Last name can be at most 100 characters.', 'lastName'],
      [{ firstName: 'First', lastName: 'Last', phone: '1'.repeat(31) }, 'too_long', 'Phone number can be at most 30 characters.', 'phone'],
    ]
    for (const [body, reason, message, field] of cases) {
      const answer = await create(login.token, body)
      refused(answer, 400, 'VALIDATION', reason, message)
      expect(answer.body.error?.field).toBe(field)
    }
    // W85a review (a)2: a name left out (or null) is the rule's refusal, with its reason, not zod's.
    refused(await create(login.token, { lastName: 'Last' }), 400, 'VALIDATION', 'first_name_required', SIGN_IN_WORDS.firstNameRequired)
    refused(await create(login.token, { firstName: 'First', lastName: null }), 400, 'VALIDATION', 'last_name_required', SIGN_IN_WORDS.lastNameRequired)
    refused(await create(login.token, {}), 400, 'VALIDATION', 'first_name_required', SIGN_IN_WORDS.firstNameRequired)
    expect(await customersOf('checks@example.com')).toEqual([])
  })
})

describe('who am I (GET /api/v1/customer/me): which account sections show (backend log 25)', () => {
  /** A new customer, signed up, with its token. */
  async function signedUp(email: string): Promise<{ id: string; token: string }> {
    const login = await newLogin(email)
    await create(login.token, { firstName: 'Sec', lastName: 'Tions' })
    const [row] = await customersOf(email)
    return { id: row?.id as string, token: login.token }
  }
  const sections = async (token: string) => ((await me(token)).body.data as { sections: string[] }).sections

  it('always Dashboard, Personal info and Preferences, in the menu order, and nothing else for a new customer', async () => {
    const { token } = await signedUp('sections.new@example.com')
    expect(await sections(token)).toEqual(['dashboard', 'details', 'preferences'])
  })

  it('Bookings after their first session booking (a cancelled one too: their history is there)', async () => {
    const { id, token } = await signedUp('sections.booking@example.com')
    await insert(db, 'bookings', { session_id: ID.session, customer_id: id, status: 'cancelled', price_paid: '20.00', cancelled_at: '2026-11-01 10:00:00+00' })
    expect(await sections(token)).toEqual(['dashboard', 'bookings', 'details', 'preferences'])
  })

  it('Events after their first event booking', async () => {
    const { id, token } = await signedUp('sections.event@example.com')
    await insert(db, 'event_bookings', { event_id: ID.event, customer_id: id, places: 1, status: 'confirmed' })
    expect(await sections(token)).toEqual(['dashboard', 'events', 'details', 'preferences'])
  })

  it('Orders after their first order', async () => {
    const { id, token } = await signedUp('sections.order@example.com')
    await insert(db, 'orders', { customer_id: id, order_total: '5.00', payment_status: 'paid' })
    expect(await sections(token)).toEqual(['dashboard', 'orders', 'details', 'preferences'])
  })

  it('Membership once they have had one, and it stays after it ends', async () => {
    const { id, token } = await signedUp('sections.member@example.com')
    await insert(db, 'customer_memberships', { customer_id: id, plan_id: ID.plan, start_date: '2025-01-01', subscription_status: 'cancelled', billing_frequency: 'monthly' })
    expect(await sections(token)).toEqual(['dashboard', 'membership', 'details', 'preferences'])
  })

  it('Passes once they have had one, and it stays when it is used up and expired', async () => {
    const { id, token } = await signedUp('sections.pass@example.com')
    await insert(db, 'customer_session_passes', { customer_id: id, pass_type_id: ID.passType, sessions_remaining: 0, expiry_date: '2025-01-01', purchase_date: '2024-01-01' })
    expect(await sections(token)).toEqual(['dashboard', 'passes', 'details', 'preferences'])
  })

  it('Store credit once they have had any, and it stays when it is spent (a balance with no ledger row counts too)', async () => {
    const spent = await signedUp('sections.credit.spent@example.com')
    await insert(db, 'store_credit_transactions', { customer_id: spent.id, amount: '10.00', balance_after: '10.00', reason: 'manual_adjustment' })
    await insert(db, 'store_credit_transactions', { customer_id: spent.id, amount: '-10.00', balance_after: '0.00', reason: 'redemption' })
    expect(await sections(spent.token)).toEqual(['dashboard', 'store_credit', 'details', 'preferences'])
    const imported = await signedUp('sections.credit.imported@example.com')
    await db.query('UPDATE customers SET store_credit_balance = 3 WHERE id = $1', [imported.id])
    expect(await sections(imported.token)).toEqual(['dashboard', 'store_credit', 'details', 'preferences'])
  })

  it('all of them at once, in the menu order', async () => {
    const { id, token } = await signedUp('sections.all@example.com')
    await insert(db, 'store_credit_transactions', { customer_id: id, amount: '1.00', balance_after: '1.00', reason: 'manual_adjustment' })
    await insert(db, 'customer_session_passes', { customer_id: id, pass_type_id: ID.passType, sessions_remaining: 5, expiry_date: '2027-01-01' })
    await insert(db, 'customer_memberships', { customer_id: id, plan_id: ID.plan, start_date: '2026-01-01', subscription_status: 'active', billing_frequency: 'monthly' })
    await insert(db, 'orders', { customer_id: id, order_total: '5.00', payment_status: 'paid' })
    await insert(db, 'event_bookings', { event_id: ID.event, customer_id: id, places: 1, status: 'confirmed' })
    await insert(db, 'bookings', { session_id: ID.session, customer_id: id, status: 'confirmed', price_paid: '20.00' })
    expect(await sections(token)).toEqual(['dashboard', 'bookings', 'events', 'orders', 'membership', 'passes', 'store_credit', 'details', 'preferences'])
  })

  it('a login with no customer yet is told so (the site then calls link); no sign-in is refused', async () => {
    const login = await newLogin('me.unlinked@example.com')
    expect((await me(login.token)).body.error?.code).toBe('CUSTOMER_NOT_LINKED')
    expect((await me(null)).status).toBe(401)
  })
})
