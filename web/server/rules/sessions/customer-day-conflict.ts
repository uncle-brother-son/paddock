// Ported from backend/paddock/checkCustomerDayConflict.ts.
import 'server-only'
import type { CustomerDayConflictInput, CustomerDayConflictOutput } from '@/contracts'
import type { Queryable } from '@/server/db'
import { findDuplicateDayBooking } from '@/server/rules/pricing/band-pricing'

/**
 * Pre-payment duplicate-day check: at most one active booking (pending / confirmed /
 * payment_needed) per customer per London calendar day. Purely informational: the
 * bookings_one_per_customer_day trigger remains the atomic backstop at write time.
 */
export async function checkCustomerDayConflict(db: Queryable, input: CustomerDayConflictInput): Promise<CustomerDayConflictOutput> {
  const { customerId, sessionId } = input

  const sessionLookup = await db.query<{ start_time: string }>('SELECT start_time FROM sessions WHERE id = $1', [sessionId])
  const session = sessionLookup[0]
  if (!session) return { conflict: false }

  const existing = await findDuplicateDayBooking(db, customerId, session.start_time)
  if (!existing) return { conflict: false }

  // en-GB writes September as "Sept": the staff app's runtime, Node and workerd all do (a test
  // pins it), so this stays the same call rather than a hand-built string.
  const date = new Date(`${existing.day}T00:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  return { conflict: true, date }
}
