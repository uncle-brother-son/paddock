// New in W85a (backend log 9, 25): the website's sign-in, on the customer channel. A Supabase login (passwordless: an
// emailed code or link) is matched to its customer by its confirmed email the first time it signs in, or makes one;
// and "who am I" says which account sections the site shows. The login (its id and its email) comes from the verified
// token (server/auth/customer.ts, `authenticateSignIn`), never from the request. No money moves here and no Stripe.
import 'server-only'
import type { AccountSection, CustomerMeOutput, CustomerSignInCreateInput, CustomerSignInLinked, CustomerSignInLinkOutput } from '@/contracts'
import { audit } from '@/server/audit'
import { postgresRefusal, type Db, type Queryable, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { CUSTOMER_FIELD_LIMITS } from '@/server/rules/customers/failure-messages'
import { SIGN_IN_WORDS, type SignInReason } from './sign-in-words'

/** The signed-in login: Supabase's user id and its confirmed email, lower-cased. */
export interface Login {
  authUserId: string
  email: string
}

interface CustomerRow {
  id: string
  first_name: string
  email: string
  auth_user_id: string | null
}

const COLUMNS = 'id, first_name, email, auth_user_id::text AS auth_user_id'
/** customers_auth_user_id_key: one customer a login. */
const BY_LOGIN_SQL = `SELECT ${COLUMNS} FROM customers WHERE auth_user_id = $1::uuid`
/**
 * The customer with this email in any case (customers_email_lower_key: at most one), locked, so two sign-ins of one
 * email (or a sign-in and a staff edit) take turns. After waiting, Postgres reads the row as it now is.
 */
const BY_EMAIL_SQL = `SELECT ${COLUMNS} FROM customers WHERE lower(email) = lower($1) FOR UPDATE`
/** Only a customer with no login yet is linked. */
const LINK_SQL = 'UPDATE customers SET auth_user_id = $1::uuid WHERE id = $2::uuid AND auth_user_id IS NULL RETURNING id'
/**
 * The new customer, linked as it is made. ON CONFLICT DO NOTHING (every unique rule: the email as written, the email
 * in any case, the login): a customer of this email made at the same moment (staff, a guest checkout), or this login
 * linked meanwhile, writes nothing and raises nothing, so the transaction carries on and finds that customer. No
 * date of birth (migration 036): it is asked for only when it is needed (the checkout).
 */
const INSERT_SQL = `
INSERT INTO customers (first_name, last_name, email, phone, auth_user_id)
VALUES ($1, $2, $3, $4, $5::uuid)
ON CONFLICT DO NOTHING
RETURNING ${COLUMNS}`

type Match = { kind: 'linked'; row: CustomerRow; change: 'none' | 'linked' } | { kind: 'elsewhere'; row: CustomerRow } | { kind: 'none' }

const answer = (row: CustomerRow, change: CustomerSignInLinked['change']): CustomerSignInLinked => ({
  status: 'linked',
  customer: { firstName: row.first_name, email: row.email },
  change,
})

/**
 * The login's customer, inside the caller's transaction: by its login, else by its email. A customer with the email and
 * no login is linked here (with its audit row); one with another login is `elsewhere` and left as it is.
 */
async function match(tx: Tx, login: Login, requestId: string, how: 'sign_in' | 'sign_up'): Promise<Match> {
  const [mine] = await tx.query<CustomerRow>(BY_LOGIN_SQL, [login.authUserId])
  if (mine) return { kind: 'linked', row: mine, change: 'none' }
  const [byEmail] = await tx.query<CustomerRow>(BY_EMAIL_SQL, [login.email])
  if (!byEmail) return { kind: 'none' }
  // Linked to this login by another call while this one waited for the row.
  if (byEmail.auth_user_id === login.authUserId) return { kind: 'linked', row: byEmail, change: 'none' }
  if (byEmail.auth_user_id !== null) return { kind: 'elsewhere', row: byEmail }
  const [linked] = await tx.query<{ id: string }>(LINK_SQL, [login.authUserId, byEmail.id])
  if (!linked) throw new Error(`Customer ${byEmail.id} was not linked.`)
  await audit.record(tx, {
    actorType: 'customer',
    actorId: byEmail.id,
    action: 'customer.login_linked',
    entityType: 'customer',
    entityId: byEmail.id,
    requestId,
    details: { authUserId: login.authUserId, how },
  })
  return { kind: 'linked', row: { ...byEmail, auth_user_id: login.authUserId }, change: 'linked' }
}

/**
 * The email's customer has another login. Logged for staff: a `customer.sign_in_refused` audit row on that customer,
 * naming the login that was turned away (written in the same transaction, which then commits: nothing else was
 * written), and the request log's detail. The site shows the words.
 */
async function logElsewhere(tx: Tx, row: CustomerRow, login: Login, requestId: string): Promise<ApiError> {
  await audit.record(tx, {
    actorType: 'customer',
    actorId: null,
    action: 'customer.sign_in_refused',
    entityType: 'customer',
    entityId: row.id,
    requestId,
    details: { reason: 'email_linked_elsewhere', refusedAuthUserId: login.authUserId, linkedAuthUserId: row.auth_user_id },
  })
  return refusal('CONFLICT', 'email_linked_elsewhere', SIGN_IN_WORDS.emailLinkedElsewhere, {
    logDetail: `Customer ${row.id} is linked to login ${row.auth_user_id ?? ''}; login ${login.authUserId} with the same email was refused.`,
  })
}

function refusal(code: 'CONFLICT' | 'VALIDATION', reason: SignInReason, message: string, extras: { field?: string; logDetail?: string } = {}): ApiError {
  return new ApiError(code, message, { ...extras, details: { reason, message } })
}

/** A unique rule refused a write: the login linked, or the email taken, by another call at the same moment. */
const isUniqueRace = (err: unknown): boolean => postgresRefusal(err)?.code === '23505'

/**
 * One transaction, run once more if another call at the same moment linked this login or took this email first (the
 * unique rule's refusal ends the transaction; the second run finds what the other call wrote). A refusal of ours is
 * returned out of the transaction, not thrown, so its log row commits; then it is thrown.
 */
async function inTransaction<T>(db: Db, work: (tx: Tx) => Promise<T | ApiError>): Promise<T> {
  let result: T | ApiError
  try {
    result = await db.transaction(work)
  } catch (err) {
    if (!isUniqueRace(err)) throw err
    result = await db.transaction(work)
  }
  if (result instanceof ApiError) throw result
  return result
}

/**
 * POST /api/v1/customer/sign-in/link. The signed-in login's customer: linked already (`none`); one customer with its
 * email in any case and no login, now linked (`linked`), so their credits, passes and store credit are there at once
 * (members imported, customers staff served, past guest checkouts); none (`needs_details`: the site shows Create your
 * account). A customer with the email and another login: refused, CONFLICT `email_linked_elsewhere`, logged for staff.
 * Safe twice: a second call answers `none`.
 */
export function linkSignIn(db: Db, login: Login, requestId: string): Promise<CustomerSignInLinkOutput> {
  return inTransaction<CustomerSignInLinkOutput>(db, async (tx) => {
    const found = await match(tx, login, requestId, 'sign_in')
    if (found.kind === 'linked') return answer(found.row, found.change)
    if (found.kind === 'elsewhere') return logElsewhere(tx, found.row, login, requestId)
    return { status: 'needs_details' }
  })
}

const trimmed = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '')

/**
 * POST /api/v1/customer/sign-in/create (backend log 9: first name, last name, phone optional; no date of birth, no
 * age check). The email is the login's. Checked first (a name each, the staff form's lengths), then one transaction:
 * the login's customer as link finds it (so a second call, or a customer of this email made by staff a moment before,
 * ends in the link and its own details are not written over); else the new customer, linked, with `customer.created`
 * and `customer.login_linked` audit rows. A customer made with this email at the same moment as the insert: the insert
 * writes nothing and the transaction links that customer instead. Never a duplicate.
 */
export function createSignInCustomer(db: Db, login: Login, input: CustomerSignInCreateInput, requestId: string): Promise<CustomerSignInLinked> {
  const firstName = trimmed(input.firstName)
  const lastName = trimmed(input.lastName)
  const phone = trimmed(input.phone) || null
  if (!firstName) throw refusal('VALIDATION', 'first_name_required', SIGN_IN_WORDS.firstNameRequired, { field: 'firstName' })
  if (!lastName) throw refusal('VALIDATION', 'last_name_required', SIGN_IN_WORDS.lastNameRequired, { field: 'lastName' })
  for (const [value, limit, field] of [
    [firstName, CUSTOMER_FIELD_LIMITS.name, 'firstName'],
    [lastName, CUSTOMER_FIELD_LIMITS.name, 'lastName'],
    [phone ?? '', CUSTOMER_FIELD_LIMITS.phone, 'phone'],
  ] as const) {
    if (value.length > limit) throw refusal('VALIDATION', 'too_long', SIGN_IN_WORDS.tooLong(field, limit), { field })
  }

  return inTransaction<CustomerSignInLinked>(db, async (tx) => {
    const found = await match(tx, login, requestId, 'sign_up')
    if (found.kind === 'linked') return answer(found.row, found.change)
    if (found.kind === 'elsewhere') return logElsewhere(tx, found.row, login, requestId)

    const [made] = await tx.query<CustomerRow>(INSERT_SQL, [firstName, lastName, login.email, phone, login.authUserId])
    if (!made) {
      // Made (or this login linked) by another call while this insert waited: that customer, as link would find it.
      const raced = await match(tx, login, requestId, 'sign_up')
      if (raced.kind === 'linked') return answer(raced.row, raced.change)
      if (raced.kind === 'elsewhere') return logElsewhere(tx, raced.row, login, requestId)
      throw new Error('The new customer was neither written nor found.')
    }
    await audit.recordAll(tx, [
      // As the staff create's row on the customer channel: the new customer is who did it.
      { actorType: 'customer', actorId: made.id, action: 'customer.created', entityType: 'customer', entityId: made.id, requestId, details: { channel: 'customer' } },
      { actorType: 'customer', actorId: made.id, action: 'customer.login_linked', entityType: 'customer', entityId: made.id, requestId, details: { authUserId: login.authUserId, how: 'sign_up' } },
    ])
    return answer(made, 'created')
  })
}

/**
 * Which account sections show (backend log 25), from what the customer has ever had: a session booking, an event
 * booking, an order (any state, cancelled included: their history is there); a membership, a pass, store credit (any
 * row of its ledger, or a balance: an imported balance may have no row), which stay once had. One statement.
 */
const ME_SQL = `
SELECT c.first_name, c.email,
  EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = c.id) AS bookings,
  EXISTS (SELECT 1 FROM event_bookings eb WHERE eb.customer_id = c.id) AS events,
  EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) AS orders,
  EXISTS (SELECT 1 FROM customer_memberships m WHERE m.customer_id = c.id) AS membership,
  EXISTS (SELECT 1 FROM customer_session_passes p WHERE p.customer_id = c.id) AS passes,
  (c.store_credit_balance > 0 OR EXISTS (SELECT 1 FROM store_credit_transactions s WHERE s.customer_id = c.id)) AS store_credit
FROM customers c
WHERE c.id = $1::uuid`

type MeRow = { first_name: string; email: string } & Record<'bookings' | 'events' | 'orders' | 'membership' | 'passes' | 'store_credit', boolean>

/** GET /api/v1/customer/me: the signed-in customer's first name and email, and their sections in the menu's order. */
export async function readMe(db: Queryable, customerId: string): Promise<CustomerMeOutput> {
  const [row] = await db.query<MeRow>(ME_SQL, [customerId])
  if (!row) throw new Error(`The signed-in customer ${customerId} was not found.`)
  const sections: AccountSection[] = ['dashboard']
  for (const section of ['bookings', 'events', 'orders', 'membership', 'passes', 'store_credit'] as const) {
    if (row[section]) sections.push(section)
  }
  sections.push('details', 'preferences')
  return { firstName: row.first_name, email: row.email, sections }
}
