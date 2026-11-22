// Ported in W39 from the staff app's createCustomer.ts (F-plan 1.7, 4.6; brief W39 item 1; bugs FB21 and FB23; lead
// call L10). One rule for every channel that makes a customer: the staff app today, the website's sign-up and guest
// checkout later (F-plan 4.9; not routed yet). No Stripe: one transaction holds the duplicate check, the row and its
// audit row. A refusal is a throw, so nothing of it is kept.
import 'server-only'
import type { CreateCustomerInput, CreateCustomerOutput } from '@/contracts'
import { audit } from '@/server/audit'
import { postgresRefusal, type Db } from '@/server/db'
import { accountRefusal } from '@/server/rules/account/refusal'
import { isAtLeastMinimumAge } from '@/server/rules/orders/guest-validation'
import { londonToday } from '@/server/rules/time/london-time'
import { CREATE_CUSTOMER_NEW_WORDS, CREATE_CUSTOMER_WORDS, CUSTOMER_EMAIL_UNIQUE_RULES, CUSTOMER_FIELD_LIMITS } from './failure-messages'

/** Who is making the customer. `staff`: a signed-in staff member. `customer`: the website (nobody is signed in yet). */
export type CustomerChannel = 'staff' | 'customer'

export type CreateCustomerOptions = { requestId: string; now?: () => number } & ({ channel: 'staff'; staffId: string } | { channel: 'customer' })

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
/**
 * W39a (review L1): a control or format character, which nobody can see. A pasted `sam@example.com` with a zero-width
 * space (U+200B) after it passed the pattern above (`\s` doesn't match it, and trim() leaves it), and was stored as an
 * address of its own that no sign-in would ever match: store credit on an account the customer can't reach.
 */
const INVISIBLE_PATTERN = /[\p{Cc}\p{Cf}]/u
/** A byte-order mark. trim() takes one off either end as if it were a space, so it is looked for in the email as sent. */
const BYTE_ORDER_MARK = '\uFEFF'

const trimmed = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '')

/**
 * Whether YYYY-MM-DD names a day the calendar has (FB23). The old function asked only whether JavaScript could read
 * the text, and JavaScript reads 1990-02-30 as 2 March, so the date reached the database and staff saw its words
 * ("date/time field value out of range"). Here the digits must come back unchanged from a real date.
 */
function isRealDate(text: string): boolean {
  const match = DATE_PATTERN.exec(text)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (year < 1) return false
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const duplicate = () => accountRefusal('CONFLICT', 'create_customer', 'duplicate_email', CREATE_CUSTOMER_WORDS.duplicateEmail, { field: 'email' })

/** FB21: an email already on file in any case. `lower()` on both sides, so the database decides what "the same" is. */
const EMAIL_TAKEN_SQL = 'SELECT 1 AS taken FROM customers WHERE lower(email) = lower($1) LIMIT 1'

const INSERT_SQL = `
INSERT INTO customers (first_name, last_name, email, phone, date_of_birth)
VALUES ($1, $2, $3, $4, $5::date)
RETURNING id, first_name, last_name, email, phone, date_of_birth::text AS date_of_birth, created_at, updated_at`

type CreatedRow = Omit<CreateCustomerOutput, 'created_at' | 'updated_at'> & { created_at: Date | string; updated_at: Date | string }
const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : String(value))

/**
 * createCustomer. Every field trimmed and the email lower-cased, then the old checks in the old order with the old
 * words: a first name, a last name, an email that looks like one and holds no invisible character (W39a), a date of
 * birth (YYYY-MM-DD, a day the calendar has: FB23), not in the future, 18 or over on today's London date. Then one
 * transaction:
 *  - FB21: an email already on file in any case is refused with the old duplicate words. The old function relied on
 *    the database's case-sensitive key, so `A@x.com` written by anyone else sat beside `a@x.com`;
 *  - the row, and a `customer.created` audit row with who and the channel (the old function recorded nobody).
 * Two creates of one email at once: both pass the check, the second insert waits on the first's, and the database's
 * unique rule refuses it (the existing key on `email`, or migration 027's on `lower(email)`). That violation is
 * answered as the same duplicate refusal, never as a fault. The route's press key stops a repeated press making two.
 */
export async function createCustomer(db: Db, input: CreateCustomerInput, options: CreateCustomerOptions): Promise<CreateCustomerOutput> {
  const firstName = trimmed(input.firstName)
  const lastName = trimmed(input.lastName)
  const email = trimmed(input.email).toLowerCase()
  const dateOfBirth = trimmed(input.dateOfBirth)
  const phone = trimmed(input.phone) || null

  const invalid = (reason: string, message: string, field: string) => accountRefusal('VALIDATION', 'create_customer', reason, message, { field })
  if (!firstName) throw invalid('first_name_required', CREATE_CUSTOMER_WORDS.firstNameRequired, 'firstName')
  if (!lastName) throw invalid('last_name_required', CREATE_CUSTOMER_WORDS.lastNameRequired, 'lastName')
  if (!email || !EMAIL_PATTERN.test(email)) throw invalid('email_invalid', CREATE_CUSTOMER_WORDS.emailInvalid, 'email')
  // W39a: an invisible character anywhere in the address is refused, never stripped (the spaces, tabs and line ends
  // trim() takes off the ends are still taken off, as before).
  const emailAsSent = typeof input.email === 'string' ? input.email : ''
  if (INVISIBLE_PATTERN.test(email) || emailAsSent.includes(BYTE_ORDER_MARK)) throw invalid('email_invalid', CREATE_CUSTOMER_WORDS.emailInvalid, 'email')
  // W58 (W45 audit row 18, W39 "Noticed" 7): lengths the screens can show and email can carry, checked after the old
  // checks (so their words come first) and before anything is written.
  for (const [value, limit, field] of [
    [firstName, CUSTOMER_FIELD_LIMITS.name, 'firstName'],
    [lastName, CUSTOMER_FIELD_LIMITS.name, 'lastName'],
    [email, CUSTOMER_FIELD_LIMITS.email, 'email'],
    [phone ?? '', CUSTOMER_FIELD_LIMITS.phone, 'phone'],
  ] as const) {
    if (value.length > limit) throw invalid('too_long', CREATE_CUSTOMER_NEW_WORDS.tooLong(field, limit), field)
  }
  if (!isRealDate(dateOfBirth)) throw invalid('date_of_birth_invalid', CREATE_CUSTOMER_WORDS.dateOfBirthInvalid, 'dateOfBirth')
  const now = options.now?.() ?? Date.now()
  // As the old function: the date's own midnight (UTC) against this moment.
  if (Date.parse(dateOfBirth) > now) throw invalid('date_of_birth_in_future', CREATE_CUSTOMER_WORDS.dateOfBirthInFuture, 'dateOfBirth')
  if (!isAtLeastMinimumAge(dateOfBirth, londonToday(new Date(now)))) throw invalid('under_18', CREATE_CUSTOMER_WORDS.under18, 'dateOfBirth')

  try {
    return await db.transaction(async (tx) => {
      const [taken] = await tx.query<{ taken: number }>(EMAIL_TAKEN_SQL, [email])
      if (taken) throw duplicate()
      const [row] = await tx.query<CreatedRow>(INSERT_SQL, [firstName, lastName, email, phone, dateOfBirth])
      if (!row) throw new Error('The customer was not written.')
      await audit.record(tx, {
        actorType: options.channel,
        // On the customer channel nobody is signed in yet: the new customer is who did it.
        actorId: options.channel === 'staff' ? options.staffId : row.id,
        action: 'customer.created',
        entityType: 'customer',
        entityId: row.id,
        requestId: options.requestId,
        details: { channel: options.channel },
      })
      return { ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at) }
    })
  } catch (err) {
    // The transaction has rolled back. Two creates at once: the database's unique rule on the email stopped this one.
    const refused = postgresRefusal(err)
    if (refused?.code === '23505' && CUSTOMER_EMAIL_UNIQUE_RULES.some((name) => refused.constraint === name || refused.message.includes(name))) throw duplicate()
    throw err
  }
}
