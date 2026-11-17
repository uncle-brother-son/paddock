// New in W40 (F-plan 4.1, 4.3; brief W40 item 5; W35 row 10, lead call L9; bug FB16): the membership reads. The
// Subscriptions list (ported from the staff app's getSubscriptions.ts) and the membership rows of a customer's
// profile (moved here from customers/read.ts, W39) come from the same code: the same columns by name, the same
// payment date facts (payment-date-status.ts), and `refunded`.
//
// `refunded` (L9: no new column): the order line that sold the membership has been refunded
// (order_line_items.refunded_at, stamped by the refund pipeline). The screens show "Refunded" for it in place of
// "Cancelled". A membership with no order line (made before lines were recorded) is never `refunded`.
//
// Read-only. Named fields: never `cm.*`. The Subscriptions list is not sent the Stripe subscription's id or the
// order line (the old list sent neither); the profile is sent the subscription's id, as before.
import 'server-only'
import type { CustomerMembershipRow, MembershipListInput, MembershipListRow } from '@/contracts'
import type { Queryable } from '@/server/db'
import { PAYMENT_DATE_FACTS_COLUMNS_SQL, PAYMENT_DATE_FACTS_JOIN_SQL, paymentDateStatus, type PaymentDateFacts } from './payment-date-status'

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value))

/**
 * What the profile reads of customer_memberships, by name. The old read was `cm.*`; this is every column but the one
 * W36's contract leaves out (customers/read.ts, CUSTOMER_COLUMNS_NOT_SENT).
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

/** What the Subscriptions list reads of customer_memberships, by name: the old list's own columns. */
export const MEMBERSHIP_LIST_COLUMNS = [
  'id',
  'customer_id',
  'subscription_status',
  'cancel_effective_date',
  'billing_frequency',
  'start_date',
  'next_renewal_date',
  'addon_credits_remaining',
  'is_herd',
  'herd_override',
  'created_at',
] as const

const DATES: ReadonlySet<string> = new Set(['start_date', 'next_renewal_date', 'cancel_effective_date'])
const columns = (names: readonly string[]): string => names.map((name) => (DATES.has(name) ? `cm.${name}::text AS ${name}` : `cm.${name}`)).join(', ')

/** W35 row 10 (L9): the membership's own order line has been refunded. */
export const REFUNDED_SQL = 'EXISTS (SELECT 1 FROM order_line_items sold WHERE sold.id = cm.order_line_item_id AND sold.refunded_at IS NOT NULL) AS refunded'

/** What both reads share: the plan, the current credit period, `refunded` and the payment date button's facts. */
const SHARED_COLUMNS_SQL = `
       mp.name AS plan_name, mp.is_unlimited AS plan_is_unlimited,
       mcc.period_end::text AS current_period_end, mcc.credits_allocated AS current_period_credits_allocated,
       mcc.credits_remaining AS current_period_credits_remaining,
       ${REFUNDED_SQL},
       ${PAYMENT_DATE_FACTS_COLUMNS_SQL}`
const FROM_SQL = `
FROM customer_memberships cm
JOIN membership_plans mp ON mp.id = cm.plan_id
JOIN customers c ON c.id = cm.customer_id
LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
${PAYMENT_DATE_FACTS_JOIN_SQL}`

/** A row as it is read: the facts the payment date refusal needs ride along, and are left out of what is sent. */
type Read<Row> = Omit<Row, 'payment_date_changed_at' | 'payment_date_change_blocked' | 'payment_date_change_needs_override'> & PaymentDateFacts

/** A row as it is sent: the facts turned into the button's refusal and left out; `also` are fields read only for the facts. */
function sent<Row extends object>(row: Read<Row>, times: readonly string[], also: readonly string[] = []): Row {
  const kept: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(row)) if (!name.startsWith('pdc_') && !also.includes(name)) kept[name] = value
  for (const name of times) if (kept[name] !== null && kept[name] !== undefined) kept[name] = iso(kept[name])
  return { ...kept, ...paymentDateStatus(row) } as Row
}

// --- A customer's memberships (the profile)

const CUSTOMER_MEMBERSHIPS_SQL = `
SELECT ${columns(CUSTOMER_MEMBERSHIP_COLUMNS)},${SHARED_COLUMNS_SQL}${FROM_SQL}
WHERE cm.customer_id = $1::uuid
ORDER BY cm.created_at DESC, cm.id`

/** The customer's membership rows, newest first, each with why "Change payment date" is refused and whether it was refunded. */
export async function customerMemberships(db: Queryable, customerId: string): Promise<CustomerMembershipRow[]> {
  const rows = await db.query<Read<CustomerMembershipRow>>(CUSTOMER_MEMBERSHIPS_SQL, [customerId])
  return rows.map((row) => sent<CustomerMembershipRow>(row, ['created_at', 'updated_at']))
}

// --- The Subscriptions list (getSubscriptions)

// The subscription's id is read for the payment date facts only (the old list read it for the same, and dropped it).
const LIST_SELECT = `
SELECT ${columns(MEMBERSHIP_LIST_COLUMNS)}, c.first_name, c.last_name, c.email, cm.stripe_subscription_id,${SHARED_COLUMNS_SQL}${FROM_SQL}`
/** The newest first; memberships made in the same moment in id order, so the list doesn't shuffle between reads. */
const LIST_ORDER = 'ORDER BY cm.created_at DESC, cm.id LIMIT 200'
const LIST_NEWEST_SQL = `${LIST_SELECT} ${LIST_ORDER}`
const wordMatches = (n: number): string => `(c.first_name ILIKE $${n} OR c.last_name ILIKE $${n} OR c.email ILIKE $${n} OR c.phone ILIKE $${n})`

type ListRead = Read<MembershipListRow> & { stripe_subscription_id: string | null }

/**
 * getSubscriptions, as before: the newest 200 memberships with their customer and plan, or a search. A search is
 * trimmed and split on spaces: every word must be somewhere in the customer's first name, last name, email or phone,
 * in any case; or the whole search is somewhere in "first last"; or the whole search is somewhere in the plan's name.
 */
export async function listMemberships(db: Queryable, input: MembershipListInput): Promise<MembershipListRow[]> {
  const search = input.search?.trim()
  let rows: ListRead[]
  if (search) {
    const words = search.split(/\s+/).filter((word) => word.length > 0)
    const params = [...words.map((word) => `%${word}%`), `%${search}%`]
    const whole = `$${params.length}`
    const everyWord = words.map((_, index) => wordMatches(index + 1)).join(' AND ')
    // Only placeholders are built here: every typed value is bound.
    const statement = `${LIST_SELECT} WHERE (${everyWord} OR ((c.first_name || ' ' || c.last_name) ILIKE ${whole}) OR (mp.name ILIKE ${whole})) ${LIST_ORDER}`
    rows = await db.query<ListRead>(statement, params)
  } else {
    rows = await db.query<ListRead>(LIST_NEWEST_SQL)
  }
  return rows.map((row) => sent<MembershipListRow>(row, ['created_at'], ['stripe_subscription_id']))
}
