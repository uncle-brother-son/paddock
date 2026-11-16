// Ported in W39 from the staff app's getCustomers.ts and getCustomerDetail.ts (F-plan 1.7, 4.6; brief W39 item 2; bug
// FB16). Read-only. Named fields, where the old detail read `cm.*` and `csp.*`: every field the screens' types name,
// so the screens get exactly what they read, and customers.test.ts holds the lists to the saved schema so a new
// column is a decision, not a leak. Money and dates as the database's own text, moments as ISO text.
import 'server-only'
import type {
  CustomerBookingHistoryRow,
  CustomerDetailOutput,
  CustomerEventBookingRow,
  CustomerListInput,
  CustomerListRow,
  CustomerMembershipRow,
  CustomerSessionPassRow,
  StoreCreditTransactionRow,
} from '@/contracts'
import type { Queryable } from '@/server/db'
import { PAYMENT_DATE_FACTS_COLUMNS_SQL, PAYMENT_DATE_FACTS_JOIN_SQL, paymentDateStatus, type PaymentDateFacts } from '@/server/rules/memberships/payment-date-status'

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value))

/** A row as the contract gives it: each moment as ISO text (null stays null). */
function withTimes<T extends object>(row: T, times: readonly string[]): T {
  const out = { ...row } as Record<string, unknown>
  for (const name of times) if (out[name] !== null && out[name] !== undefined) out[name] = iso(out[name])
  return out as T
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// --- getCustomers

/**
 * What the Customers page, the customer picker and New Order's payment step read of a customer. Never the Stripe
 * ids, the website login or the consents. `has_saved_card` in place of the saved payment method's id.
 */
export const CUSTOMER_LIST_FIELDS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'phone',
  'date_of_birth',
  'created_at',
  'updated_at',
  'has_saved_card',
  'saved_card_last4',
  'saved_card_brand',
  'store_credit_balance',
  'address_line1',
  'address_line2',
  'city',
  'postcode',
  'country',
] as const

const LIST_AS: Readonly<Record<string, string>> = {
  date_of_birth: 'date_of_birth::text AS date_of_birth',
  has_saved_card: '(saved_payment_method_id IS NOT NULL) AS has_saved_card',
  store_credit_balance: 'store_credit_balance::text AS store_credit_balance',
}
const LIST_SELECT = `SELECT ${CUSTOMER_LIST_FIELDS.map((field) => LIST_AS[field] ?? field).join(', ')} FROM customers`
/** The newest first; customers made in the same moment in id order, so the list doesn't shuffle between reads. */
const LIST_ORDER = 'ORDER BY created_at DESC, id LIMIT 200'
const LIST_BY_ID_SQL = `${LIST_SELECT} WHERE id = $1::uuid`
const LIST_NEWEST_SQL = `${LIST_SELECT} ${LIST_ORDER}`
const WORD_MATCHES = (n: number): string => `(first_name ILIKE $${n} OR last_name ILIKE $${n} OR email ILIKE $${n} OR phone ILIKE $${n})`

const LIST_TIMES = ['created_at', 'updated_at'] as const

/**
 * getCustomers, as before: one known customer by id (none when there is no such customer); or a search; or the
 * newest 200. A search is trimmed and split on spaces: every word must be somewhere in the first name, the last
 * name, the email or the phone, in any case ("Wayne Holland", "Holland Wayne" and "wayne hol" all find the same
 * customer), or the whole search is somewhere in "first last". Up to 200, newest first.
 */
export async function listCustomers(db: Queryable, input: CustomerListInput): Promise<CustomerListRow[]> {
  const search = input.search?.trim()
  const customerId = input.customerId
  let rows: CustomerListRow[]
  if (customerId) {
    // An id that isn't one names no customer (the old function passed it to the database, which threw its own words).
    rows = UUID.test(customerId) ? await db.query<CustomerListRow>(LIST_BY_ID_SQL, [customerId]) : []
  } else if (search) {
    const words = search.split(/\s+/).filter((word) => word.length > 0)
    const params = [...words.map((word) => `%${word}%`), `%${search}%`]
    const everyWord = words.map((_, index) => WORD_MATCHES(index + 1)).join(' AND ')
    // Only placeholders are built here: every typed value is bound.
    const statement = `${LIST_SELECT} WHERE (${everyWord} OR ((first_name || ' ' || last_name) ILIKE $${params.length})) ${LIST_ORDER}`
    rows = await db.query<CustomerListRow>(statement, params)
  } else {
    rows = await db.query<CustomerListRow>(LIST_NEWEST_SQL)
  }
  return rows.map((row) => withTimes(row, LIST_TIMES))
}

// --- getCustomerDetail

/**
 * What the profile reads of customer_memberships, by name. The old read was `cm.*`; this is every column but the one
 * W36's contract leaves out (CUSTOMER_COLUMNS_NOT_SENT).
 */
export const CUSTOMER_MEMBERSHIP_COLUMNS = [
  'id',
  'customer_id',
  'plan_id',
  'stripe_subscription_id',
  'subscription_status',
  'start_date',
  'next_renewal_date',
  'addon_credits_remaining',
  'bonus_addon_credits',
  'created_at',
  'updated_at',
  'billing_frequency',
  'cancel_effective_date',
  'is_herd',
  'herd_override',
] as const

/** What the profile reads of customer_session_passes, by name (the old read was `csp.*`), likewise. */
export const CUSTOMER_PASS_COLUMNS = ['id', 'customer_id', 'pass_type_id', 'purchase_date', 'sessions_remaining', 'expiry_date', 'created_at', 'updated_at'] as const

/**
 * The one column of each table the old `*` brought along and the profile is not sent (W36's contract, held by
 * w36-contracts.test.ts): the order line that sold the membership or the pass. No screen's type names it.
 */
export const CUSTOMER_COLUMNS_NOT_SENT = ['order_line_item_id'] as const

const DATES: ReadonlySet<string> = new Set(['start_date', 'next_renewal_date', 'cancel_effective_date', 'purchase_date', 'expiry_date'])
const columns = (alias: string, names: readonly string[]): string => names.map((name) => (DATES.has(name) ? `${alias}.${name}::text AS ${name}` : `${alias}.${name}`)).join(', ')

/**
 * The membership rows, newest first, each with its plan, its current credit period and the payment date button's
 * facts. W40 takes this over with the Subscriptions list (brief W39 item 2: not changed here).
 */
const MEMBERSHIPS_SQL = `
SELECT ${columns('cm', CUSTOMER_MEMBERSHIP_COLUMNS)},
       mp.name AS plan_name, mp.is_unlimited AS plan_is_unlimited,
       mcc.period_end::text AS current_period_end, mcc.credits_allocated AS current_period_credits_allocated,
       mcc.credits_remaining AS current_period_credits_remaining,
       ${PAYMENT_DATE_FACTS_COLUMNS_SQL}
FROM customer_memberships cm
JOIN membership_plans mp ON mp.id = cm.plan_id
JOIN customers c ON c.id = cm.customer_id
LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
${PAYMENT_DATE_FACTS_JOIN_SQL}
WHERE cm.customer_id = $1::uuid
ORDER BY cm.created_at DESC, cm.id`

const PASSES_SQL = `
SELECT ${columns('csp', CUSTOMER_PASS_COLUMNS)}, spt.name AS pass_type_name, spt.level AS pass_type_level
FROM customer_session_passes csp
JOIN session_pass_types spt ON spt.id = csp.pass_type_id
WHERE csp.customer_id = $1::uuid
ORDER BY csp.created_at DESC, csp.id`

const BOOKINGS_SQL = `
SELECT b.id, b.status, b.party_size, b.price_paid::text AS price_paid, b.checked_in_at, b.created_at, b.payment_due_by,
       s.start_time, s.end_time, st.name AS service_type_name
FROM bookings b
JOIN sessions s ON s.id = b.session_id
JOIN service_types st ON st.id = s.service_type_id
WHERE b.customer_id = $1::uuid
ORDER BY s.start_time DESC, b.id`

const BALANCE_SQL = 'SELECT store_credit_balance::text AS store_credit_balance FROM customers WHERE id = $1::uuid'

const STORE_CREDIT_SQL = `
SELECT id, amount::text AS amount, balance_after::text AS balance_after, reason, note, order_id, booking_id, created_at
FROM store_credit_transactions
WHERE customer_id = $1::uuid
ORDER BY created_at DESC, id
LIMIT 100`

/** An attendee's extra waiver is outstanding: not signed, or signed on an older version (shared/eventAttendance). */
const EXTRA_WAIVER_OUTSTANDING_SQL = `(e.has_extra_waiver AND (NOT ea.event_waiver_accepted
    OR ea.event_waiver_version IS DISTINCT FROM e.extra_waiver_version))`

const EVENT_BOOKINGS_SQL = `
SELECT eb.id, eb.event_id, e.name AS event_name, e.starts_at AS event_starts_at, eb.places, eb.status,
       eb.price_paid::text AS price_paid, eb.created_at,
       count(ea.id) FILTER (WHERE ea.cancelled_at IS NULL)::int AS attendee_count,
       count(ea.checked_in_at) FILTER (WHERE ea.cancelled_at IS NULL)::int AS checked_in_count,
       count(ea.id) FILTER (WHERE ea.cancelled_at IS NULL
                              AND (NOT ea.waiver_accepted OR ${EXTRA_WAIVER_OUTSTANDING_SQL}))::int AS waivers_outstanding,
       count(ea.id)::int AS places_total,
       count(ea.cancelled_at)::int AS cancelled_places,
       COALESCE(sum(ea.refunded_amount), 0)::text AS refunded_amount,
       COALESCE(sum(ea.card_refunded_amount), 0)::text AS card_refunded_amount,
       e.cancelled_at AS event_cancelled_at
FROM event_bookings eb
JOIN events e ON e.id = eb.event_id
LEFT JOIN event_attendees ea ON ea.event_booking_id = eb.id
WHERE eb.customer_id = $1::uuid
GROUP BY eb.id, e.id
ORDER BY e.starts_at DESC NULLS LAST, eb.created_at DESC, eb.id`

type MembershipFacts = Omit<CustomerMembershipRow, 'payment_date_changed_at' | 'payment_date_change_blocked' | 'payment_date_change_needs_override'> & PaymentDateFacts

/** A membership row as the profile reads it: the facts turned into the button's refusal, and left out. */
function membershipRow(row: MembershipFacts): CustomerMembershipRow {
  const kept: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(row)) if (!name.startsWith('pdc_')) kept[name] = value
  return withTimes({ ...(kept as Omit<MembershipFacts, keyof PaymentDateFacts> & Pick<PaymentDateFacts, 'billing_frequency' | 'subscription_status' | 'stripe_subscription_id'>), ...paymentDateStatus(row) }, ['created_at', 'updated_at'])
}

/**
 * getCustomerDetail, as before: the customer's memberships (each with why "Change payment date" is refused), session
 * passes, booking history (latest session first), store credit balance and last 100 movements, and event bookings
 * (latest event first). A customer that doesn't exist has empty lists and a balance of '0'.
 */
export async function getCustomerDetail(db: Queryable, customerId: string): Promise<CustomerDetailOutput> {
  const [memberships, sessionPasses, bookingHistory, balance, storeCreditHistory, eventBookings] = await Promise.all([
    db.query<MembershipFacts>(MEMBERSHIPS_SQL, [customerId]),
    db.query<CustomerSessionPassRow>(PASSES_SQL, [customerId]),
    db.query<CustomerBookingHistoryRow>(BOOKINGS_SQL, [customerId]),
    db.query<{ store_credit_balance: string }>(BALANCE_SQL, [customerId]),
    db.query<StoreCreditTransactionRow>(STORE_CREDIT_SQL, [customerId]),
    db.query<CustomerEventBookingRow>(EVENT_BOOKINGS_SQL, [customerId]),
  ])
  return {
    memberships: memberships.map(membershipRow),
    sessionPasses: sessionPasses.map((row) => withTimes(row, ['created_at', 'updated_at'])),
    bookingHistory: bookingHistory.map((row) => withTimes(row, ['checked_in_at', 'created_at', 'payment_due_by', 'start_time', 'end_time'])),
    storeCreditBalance: balance[0]?.store_credit_balance ?? '0',
    storeCreditHistory: storeCreditHistory.map((row) => withTimes(row, ['created_at'])),
    eventBookings: eventBookings.map((row) => withTimes(row, ['event_starts_at', 'created_at', 'event_cancelled_at'])),
  }
}
