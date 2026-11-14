import { describe, expect, it } from 'vitest'
import { BOOKING_LOCK_SQL } from '@/server/rules/bookings/locks'
import { LOCK_ORDER, ORDER_LOCK_SQL } from './locks'

// Brief W28 item 7 (W27 "Noticed" 1; W27's planted bug N2): lockForOrder's and lockForBooking's statements, read as
// they are written, as claims-postgres.test.ts reads lockForRefund's. Each lateral subquery must name the one before
// it. Postgres runs a lateral only once what it refers to has run, and that reference is the only thing that fixes the
// order the locks are taken in: without it the planner may take a later row first. It usually doesn't, so no race test
// would notice a missing name until the day it did.

/** Each table a lock statement takes, as LOCK_ORDER names it. */
const NAMED: Readonly<Record<string, (typeof LOCK_ORDER)[number]>> = {
  orders: 'order',
  bookings: 'booking',
  customers: 'customer',
  promo_codes: 'promo_code',
  sessions: 'session',
  membership_credit_periods: 'credit_period',
  customer_session_passes: 'session_pass',
  customer_memberships: 'membership',
  product_variants: 'product_variants',
  events: 'event',
  event_bookings: 'event_booking',
  gift_cards: 'gift_card',
}

interface Lateral {
  alias: string
  table: string
  lock: string
  body: string
}

/** The statement's first row (its FROM) and every lateral after it, in the order written. */
function read(sql: string): { first: Lateral; laterals: Lateral[] } {
  const from = /\nFROM \(SELECT [\w, ]+ FROM (\w+) WHERE id = \$1::uuid (FOR (?:NO KEY )?UPDATE)\) (\w+)\n/.exec(sql)
  if (!from) throw new Error('The statement has no locked first row.')
  const laterals = [...sql.matchAll(/JOIN LATERAL \(([\s\S]*?)\) (\w+) ON true/g)].map((match) => ({
    body: match[1] ?? '',
    alias: match[2] ?? '',
    table: /FROM (\w+)\s+WHERE/.exec(match[1] ?? '')?.[1] ?? '',
    lock: /FOR (?:NO KEY )?UPDATE/.exec(match[1] ?? '')?.[0] ?? '',
  }))
  return { first: { alias: from[3] ?? '', table: from[1] ?? '', lock: from[2] ?? '', body: '' }, laterals }
}

/** The problems with a statement's lock order: empty when every lateral names the one before it, in LOCK_ORDER's order. */
function problems(sql: string, sets: readonly string[]): string[] {
  const { first, laterals } = read(sql)
  const found: string[] = []
  const all = [first, ...laterals]
  // In LOCK_ORDER's order, strictly: each table's place is after the one before it.
  const places = all.map((row) => LOCK_ORDER.indexOf(NAMED[row.table] as (typeof LOCK_ORDER)[number]))
  if (places.some((place) => place < 0)) found.push(`a table LOCK_ORDER doesn't name: ${all.map((row) => row.table).join(', ')}`)
  for (let i = 1; i < places.length; i += 1) {
    if ((places[i] as number) <= (places[i - 1] as number)) found.push(`${all[i]?.table} is locked after ${all[i - 1]?.table}, against LOCK_ORDER`)
  }
  for (const [index, lateral] of laterals.entries()) {
    const before = all[index] as Lateral
    const where = lateral.body.slice(lateral.body.indexOf('WHERE'))
    if (!new RegExp(`\\b${before.alias}\\.(id|ids|customer_id|session_id)\\b`).test(where)) found.push(`${lateral.alias} (${lateral.table}) doesn't name ${before.alias} (${before.table}), the lock before it`)
    if (!lateral.lock) found.push(`${lateral.alias} (${lateral.table}) takes no lock`)
  }
  // A set of rows is taken in id order: sorted inside the lateral, before it locks.
  for (const alias of sets) {
    const lateral = laterals.find((one) => one.alias === alias)
    if (!lateral || !/ORDER BY id\s+FOR NO KEY UPDATE/.test(lateral.body)) found.push(`${alias} isn't sorted by id before it locks`)
  }
  return found
}

describe("lockForOrder's statement (W06 to W09)", () => {
  it('locks the customer, the promo code, the session, the credit period, the pass, the memberships, the variants, the event and the gift card, in LOCK_ORDER', () => {
    const { first, laterals } = read(ORDER_LOCK_SQL)
    expect([first.alias, first.table, first.lock]).toEqual(['c', 'customers', 'FOR NO KEY UPDATE'])
    expect(laterals.map(({ alias, table, lock }) => [alias, table, lock])).toEqual([
      // The promo code is the one row locked FOR UPDATE (W09: its only claim is an insert that points at it).
      ['pc', 'promo_codes', 'FOR UPDATE'],
      ['s', 'sessions', 'FOR NO KEY UPDATE'],
      ['p', 'membership_credit_periods', 'FOR NO KEY UPDATE'],
      ['sp', 'customer_session_passes', 'FOR NO KEY UPDATE'],
      ['m', 'customer_memberships', 'FOR NO KEY UPDATE'],
      ['v', 'product_variants', 'FOR NO KEY UPDATE'],
      ['e', 'events', 'FOR NO KEY UPDATE'],
      ['g', 'gift_cards', 'FOR NO KEY UPDATE'],
    ])
  })

  it('each lock waits for the one before it: every lateral names the one before, and each set is sorted before it locks', () => {
    expect(problems(ORDER_LOCK_SQL, ['m', 'v'])).toEqual([])
  })
})

describe("lockForBooking's statement (W17)", () => {
  it('locks the booking, its customer, the sessions, the credit periods, the pass, the memberships and the gift card, in LOCK_ORDER', () => {
    const { first, laterals } = read(BOOKING_LOCK_SQL)
    expect([first.alias, first.table, first.lock]).toEqual(['b', 'bookings', 'FOR NO KEY UPDATE'])
    expect(laterals.map(({ alias, table, lock }) => [alias, table, lock])).toEqual([
      ['c', 'customers', 'FOR NO KEY UPDATE'],
      ['s', 'sessions', 'FOR NO KEY UPDATE'],
      ['p', 'membership_credit_periods', 'FOR NO KEY UPDATE'],
      ['sp', 'customer_session_passes', 'FOR NO KEY UPDATE'],
      ['m', 'customer_memberships', 'FOR NO KEY UPDATE'],
      ['g', 'gift_cards', 'FOR NO KEY UPDATE'],
    ])
  })

  it('each lock waits for the one before it: every lateral names the one before, and each set is sorted before it locks', () => {
    expect(problems(BOOKING_LOCK_SQL, ['s', 'p', 'm'])).toEqual([])
  })
})

describe('the reading itself catches what it is for', () => {
  const without = (sql: string, text: string): string => {
    if (!sql.includes(text)) throw new Error(`The statement no longer has: ${text}`)
    return sql.replace(text, '')
  }

  it('a lateral that stops naming the one before it is caught, in each statement', () => {
    expect(problems(without(ORDER_LOCK_SQL, ' AND (pc.id IS NULL OR pc.id IS NOT NULL)'), ['m', 'v'])).toEqual(["s (sessions) doesn't name pc (promo_codes), the lock before it"])
    expect(problems(without(ORDER_LOCK_SQL, ' AND (e.id IS NULL OR e.id IS NOT NULL)'), ['m', 'v'])).toEqual(["g (gift_cards) doesn't name e (events), the lock before it"])
    expect(problems(without(BOOKING_LOCK_SQL, ' AND (s.ids IS NULL OR s.ids IS NOT NULL)'), ['s', 'p', 'm'])).toEqual(["p (membership_credit_periods) doesn't name s (sessions), the lock before it"])
    expect(problems(without(BOOKING_LOCK_SQL, ' AND (m.ids IS NULL OR m.ids IS NOT NULL)'), ['s', 'p', 'm'])).toEqual(["g (gift_cards) doesn't name m (customer_memberships), the lock before it"])
  })

  it('a lateral naming an alias two steps back is caught: it must be the one straight before', () => {
    const skipped = ORDER_LOCK_SQL.replace('(sp.id IS NULL OR sp.id IS NOT NULL)', '(p.id IS NULL OR p.id IS NOT NULL)')
    expect(problems(skipped, ['m', 'v'])).toEqual(["m (customer_memberships) doesn't name sp (customer_session_passes), the lock before it"])
  })

  it('a set that is no longer sorted before it locks is caught', () => {
    const unsorted = BOOKING_LOCK_SQL.replace(/WHERE id = ANY\(\$6::uuid\[\]\) AND \(sp\.id IS NULL OR sp\.id IS NOT NULL\)\n\s+ORDER BY id/, 'WHERE id = ANY($6::uuid[]) AND (sp.id IS NULL OR sp.id IS NOT NULL)')
    expect(unsorted).not.toBe(BOOKING_LOCK_SQL)
    expect(problems(unsorted, ['s', 'p', 'm'])).toEqual(["m isn't sorted by id before it locks"])
  })
})
