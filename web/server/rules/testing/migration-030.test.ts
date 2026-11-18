import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { fixtures, insert } from './database'
import {
  BEFORE_030_SQL,
  ENDED,
  ENDED_ADDED_030,
  ENDED_AFTER_030,
  ENDED_ANCHOR_030,
  ENDED_BEFORE_030,
  FAILED,
  FAILED_ADDED_030,
  FAILED_AFTER_030,
  FAILED_ANCHOR_030,
  FAILED_BEFORE_030,
  migration030,
} from './migration-030'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W46a item 1 (W46 report "Noticed" 1 and 2): migration 030 is written but NOT applied to live, and the saved
// schema (live-catalog.json, live-schema.sql) is left as live is today: the lead applies 030 after a diff check. This
// file holds the migration on real Postgres either way. It starts from the two functions as they were before 030
// (kept word for word in migration-030.ts), so it reads the same before and after a refresh of the snapshot: 030 adds
// five lines to each of those two functions and changes nothing else, twice over changes nothing, its Down puts the
// old ones back, and with it a failed renewal flags the credit bookings in the period that payment was for, whatever
// credit period has already been allocated. The edges on the replay's clock (Mo, 10 December) are in
// memberships/covered-through.test.ts.

const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')
const DOWN_MARK = '-- Down (the two functions as they were before 030):'
/** Each function called as the webhook calls it: with the subscription's id. */
const CALL = {
  [FAILED]: 'SELECT public.membership_mark_payment_failed($1::text) AS answer',
  [ENDED]: 'SELECT public.membership_mark_cancelled_by_stripe($1::text) AS answer',
} as const

interface Catalog {
  functions: Array<{ name: string; identity: string; definition: string }>
  [key: string]: unknown
}

/** The file's lines, and where each of its two statements starts and ends (each function has comment lines of its own inside). */
const parts = () => {
  const lines = migration030().split('\n')
  const starts = lines.flatMap((line, index) => (line.startsWith('CREATE OR REPLACE FUNCTION') ? [index] : []))
  const ends = lines.flatMap((line, index) => (line === 'END $function$;' ? [index] : []))
  return { lines, starts, ends }
}
/** The file's statements, each as the catalogue gives a function: no closing semicolon, one newline at the end. */
const statements = (): string[] => {
  const { lines, starts, ends } = parts()
  return starts.map((from, n) => `${lines.slice(from, (ends[n] ?? from) + 1).join('\n').replace(/;$/, '')}\n`)
}
/** The Down in the file's footer, with its comment marks taken off: a script that can be run as written. */
const down = (): string => {
  const sql = migration030()
  return sql
    .slice(sql.indexOf(DOWN_MARK))
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^-- {3}/, '').replace(/^--$/, ''))
    .join('\n')
    .trim()
}
/** A header block's SQL: the lines indented under the line that starts with `mark`, up to the next line that isn't. */
const headerSql = (mark: string): string => {
  const lines = migration030().split('\n')
  const from = lines.findIndex((line) => line.startsWith(mark))
  const block: string[] = []
  for (const line of lines.slice(from + 1)) {
    if (!line.startsWith('--    ')) break
    block.push(line.replace(/^--/, ''))
  }
  return block.join('\n')
}
/** `before` with `added` put in straight after its one line `anchor`. */
const withAdded = (before: string, anchor: string, added: readonly string[]): string => {
  const lines = before.split('\n')
  const at = lines.indexOf(anchor)
  return [...lines.slice(0, at + 1), ...added, ...lines.slice(at + 1)].join('\n')
}

describe('migration 030 (brief W46a item 1; W46 "Noticed" 1 and 2): a failed renewal flags the period it did not pay for', () => {
  let pg: RealPostgres
  let db: Db
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const definitions = (from: Catalog) => ({ [ENDED]: from.functions.find((fn) => fn.name === ENDED)?.definition ?? '', [FAILED]: from.functions.find((fn) => fn.name === FAILED)?.definition ?? '' })
  const without = (from: Catalog): Catalog => ({ ...from, functions: from.functions.filter((fn) => fn.name !== ENDED && fn.name !== FAILED) })
  const BEFORE = { [ENDED]: ENDED_BEFORE_030, [FAILED]: FAILED_BEFORE_030 }
  const AFTER = { [ENDED]: ENDED_AFTER_030, [FAILED]: FAILED_AFTER_030 }
  const grants = async () =>
    (await pg.admin.unsafe<{ name: string; acl: string | null }[]>(`SELECT proname AS name, proacl::text AS acl FROM pg_proc WHERE oid IN ('public.${ENDED}(text)'::regprocedure, 'public.${FAILED}(text)'::regprocedure) ORDER BY proname`)).map((row) => `${row.name}: ${row.acl}`)

  beforeAll(async () => {
    pg = await startRealPostgres()
    db = pg.connect()
  }, 120_000)
  afterAll(() => pg.stop())

  it('the file exists, says it is not applied by W46a, and is two statements: the two functions replaced, word for word as expected (no table, row, grant or other function touched)', () => {
    const { lines, starts, ends } = parts()
    expect(migration030()).toContain('NOT APPLIED by W46a')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect([starts[0], ends[0], starts[1], ends[1]]).toEqual([...[starts[0], ends[0], starts[1], ends[1]]].sort((a, b) => Number(a) - Number(b)))
    // Everything outside the two statements is a comment or an empty line.
    const inside = (index: number) => starts.some((from, n) => index >= from && index <= Number(ends[n]))
    expect(lines.filter((line, index) => !inside(index) && line !== '' && !line.startsWith('--'))).toEqual([])
    expect(statements()).toEqual([ENDED_AFTER_030, FAILED_AFTER_030])
    expect(migration030().match(/^CREATE OR REPLACE FUNCTION/gm)).toHaveLength(2)
    expect(migration030().match(/^(?!--).*\$function\$/gm)).toHaveLength(4)
  })

  it('030 is each function as it was with five lines added and none changed or removed: when the next payment date is today or earlier (London), covered through the day before it; the old sum is still there, untouched, for every other case', () => {
    for (const [before, anchor, added, after] of [
      [FAILED_BEFORE_030, FAILED_ANCHOR_030, FAILED_ADDED_030, FAILED_AFTER_030],
      [ENDED_BEFORE_030, ENDED_ANCHOR_030, ENDED_ADDED_030, ENDED_AFTER_030],
    ] as const) {
      expect(before.split('\n').filter((line) => line === anchor)).toHaveLength(1)
      expect(added).toHaveLength(5)
      expect(withAdded(before, anchor, added)).toBe(after)
      // Take the five lines out again and the old function is left, line for line.
      const lines = after.split('\n')
      const at = lines.indexOf(anchor)
      expect(lines.slice(at + 1, at + 6)).toEqual(added)
      expect([...lines.slice(0, at + 1), ...lines.slice(at + 6)]).toEqual(before.split('\n'))
    }
    // The lines sit between the old sum and its first use: the flagging, and the write of the membership's last day.
    const failed = FAILED_AFTER_030.split('\n')
    expect(failed[failed.lastIndexOf(FAILED_ADDED_030[4] as string) + 1]).toBe('  flagged := public.flag_uncovered_credit_bookings(m.id, covered);')
    const ended = ENDED_AFTER_030.split('\n')
    expect(ended[ended.lastIndexOf(ENDED_ADDED_030[4] as string) + 1]).toBe('  UPDATE customer_memberships')
    // The failure's test is the date alone; an ended subscription's also needs past due and no last day already set.
    expect(FAILED_ADDED_030[2]).toBe("  IF m.next_renewal_date <= (now() AT TIME ZONE 'Europe/London')::date THEN")
    expect(ENDED_ADDED_030[2]).toBe("  IF m.cancel_effective_date IS NULL AND m.subscription_status = 'past_due' AND m.next_renewal_date <= today THEN")
    expect([FAILED_ADDED_030[3], ENDED_ADDED_030[3]]).toEqual(['    covered := m.next_renewal_date - 1;', '    covered := m.next_renewal_date - 1;'])
  })

  it('its header holds the order (either way round), the two pre-checks (expect 0), the check after and every added line as a diff; its footer the rollback and a Down that is the two functions as they were', () => {
    const sql = migration030()
    const flat = sql.replace(/\n--\s+/g, ' ')
    expect(flat).toContain('Order: either way round is safe, and 030 need not wait for the Worker.')
    expect(flat).toContain("Pre-checks (read-only). Expect 0 for each: SELECT count(*) FROM public.customer_memberships WHERE subscription_status = 'past_due';")
    expect(flat).toContain("SELECT count(*) FROM public.customer_memberships WHERE subscription_status = 'cancelled' AND cancel_effective_date > (now() AT TIME ZONE 'Europe/London')::date;")
    expect(flat).toContain(
      "Check after applying (read-only): expect true. SELECT pg_get_functiondef('public.membership_mark_payment_failed(text)'::regprocedure) LIKE '%IF m.next_renewal_date <= (now() AT TIME ZONE ''Europe/London'')::date THEN%' AND pg_get_functiondef('public.membership_mark_cancelled_by_stripe(text)'::regprocedure) LIKE '%IF m.cancel_effective_date IS NULL AND m.subscription_status = ''past_due'' AND m.next_renewal_date <= today THEN%';"
    )
    // The two diffs against live, in the header: from the first diff's first line to the section after them.
    const diffs = sql.slice(sql.indexOf('--   --- saved schema (live): membership_mark_payment_failed(text)'), sql.indexOf("-- What it can and can't do:"))
    expect(diffs.match(/^-- {3}--- saved schema \(live\): /gm)).toHaveLength(2)
    for (const line of [...FAILED_ADDED_030, ...ENDED_ADDED_030]) expect(diffs).toContain(`\n--   +${line}\n`)
    // They add lines only: no line of either function is taken out.
    expect(diffs.split('\n').filter((line) => line.startsWith('--   -') && !line.startsWith('--   ---'))).toEqual([])
    expect(diffs.split('\n').filter((line) => line.startsWith('--   +') && !line.startsWith('--   +++'))).toHaveLength(10)
    expect(sql).toContain('No data changes')
    // The pre-checks, the statements, then the rollback and the Down: in that order.
    const order = [sql.indexOf('-- Pre-checks (read-only)'), sql.indexOf('\nCREATE OR REPLACE FUNCTION'), sql.indexOf('-- Rollback: the Down below.'), sql.indexOf(DOWN_MARK)]
    expect(order.every((index) => index > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(down()).toBe(`${ENDED_BEFORE_030.trimEnd()};\n\n${FAILED_BEFORE_030.trimEnd()};`)
    expect(`${down()}\n`.replace(';\n\n', ';\n')).toBe(BEFORE_030_SQL)
  })

  it('from the functions as they were, 030 changes those two functions and nothing else; applied twice it changes nothing; its Down, run as written, puts the old ones back; the grants are as they were', async () => {
    const saved = await catalog()
    await pg.admin.unsafe(BEFORE_030_SQL)
    const before = await catalog()
    expect(definitions(before)).toEqual(BEFORE)
    expect(without(before)).toEqual(without(saved))
    const grantsBefore = await grants()
    expect(grantsBefore).toHaveLength(2)

    await pg.admin.unsafe(migration030())
    const applied = await catalog()
    expect(without(applied)).toEqual(without(before))
    expect(definitions(applied)).toEqual(AFTER)
    // Before the lead applies it and the snapshot is refreshed, the saved schema has the old functions; after, these.
    expect([BEFORE, AFTER]).toContainEqual(definitions(saved))
    if (definitions(saved)[FAILED] !== FAILED_BEFORE_030) expect(applied).toEqual(saved)
    expect(await grants()).toEqual(grantsBefore)

    await pg.admin.unsafe(migration030())
    expect(await catalog()).toEqual(applied)
    expect(await grants()).toEqual(grantsBefore)
    await pg.admin.unsafe(down())
    expect(await catalog()).toEqual(before)
    expect(await grants()).toEqual(grantsBefore)
  })

  it("the header's own SQL runs: the check after is false before 030 and true with it, and each pre-check counts what it says (a past-due membership; one ended with its last day still to come)", async () => {
    const checkAfter = headerSql('-- Check after applying (read-only)')
    const preChecks = headerSql('-- Pre-checks (read-only)')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '')
    expect(preChecks).toHaveLength(2)
    const answer = async (sql: string) => Object.values((await pg.admin.unsafe(sql))[0] ?? {})[0]
    const counts = async () => [Number(await answer(preChecks[0] as string)), Number(await answer(preChecks[1] as string))]

    await pg.admin.unsafe(BEFORE_030_SQL)
    expect(await answer(checkAfter)).toBe(false)
    await pg.admin.unsafe(migration030())
    expect(await answer(checkAfter)).toBe(true)
    // One function back as it was: the check needs both.
    await pg.admin.unsafe(`${FAILED_BEFORE_030.trimEnd()};`)
    expect(await answer(checkAfter)).toBe(false)
    await pg.admin.unsafe(BEFORE_030_SQL)

    const [baseline0, baseline1] = await counts()
    const plan = await fixtures.plan(db, { sessions_included: 4 })
    const member = async (row: Record<string, unknown>) => fixtures.membership(db, { customer_id: await fixtures.customer(db), plan_id: plan, billing_frequency: 'monthly', ...row })
    await member({ subscription_status: 'past_due' })
    await member({ subscription_status: 'active' })
    expect(await counts()).toEqual([Number(baseline0) + 1, baseline1])
    const tomorrow = (await db.query<{ d: string }>("SELECT ((now() AT TIME ZONE 'Europe/London')::date + 1)::text AS d"))[0]?.d as string
    const today = (await db.query<{ d: string }>("SELECT (now() AT TIME ZONE 'Europe/London')::date::text AS d"))[0]?.d as string
    await member({ subscription_status: 'cancelled', cancel_effective_date: tomorrow })
    // A membership that ended today (a cancel in Stripe's dashboard) or earlier is not counted.
    await member({ subscription_status: 'cancelled', cancel_effective_date: today })
    await member({ subscription_status: 'active', cancel_effective_date: tomorrow })
    expect(await counts()).toEqual([Number(baseline0) + 1, Number(baseline1) + 1])
  })

  it('what the two functions answer, before 030 and with it, for twelve memberships (dates counted from today): with the new credit period already allocated, a failed renewal flagged nothing and Stripe ending the subscription wrote the unpaid month\'s end as the last day; with 030 the member is covered through the day before the payment was due and the booking is flagged; every membership whose next payment date is not today or earlier gets exactly the same answer from both', async () => {
    /** A date `days` from today in London, less `monthsBack` months. */
    const day = async (days: number, monthsBack = 0) =>
      (await db.query<{ d: string }>("SELECT (((now() AT TIME ZONE 'Europe/London')::date - make_interval(months => $1::int))::date + $2::int)::text AS d", [monthsBack, days]))[0]?.d as string
    const today = await day(0)
    const yesterday = await day(-1)
    const tomorrow = await day(1)
    const newPeriodEnd = await day(-1, -1)
    const plan = await fixtures.plan(db, { sessions_included: 4 })
    const serviceType = await fixtures.serviceType(db)
    const band = await fixtures.band(db)
    const sessions = new Map<string, string>()
    /** A session at 10:00 (London's clock) on a day, one a day. */
    const sessionOn = async (date: string) => {
      const slot = { start_time: `${date} 10:00:00+00`, end_time: `${date} 11:00:00+00` }
      if (!sessions.has(date)) sessions.set(date, await fixtures.session(db, { service_type_id: serviceType, band_id: band, capacity: 100, ...slot }))
      return { session_id: sessions.get(date) as string, ...slot }
    }

    interface Case {
      fn: typeof FAILED | typeof ENDED
      row: Record<string, unknown>
      /** Credit periods as [start, end]. */
      periods: Array<[string, string]>
      /** The days of the member's confirmed credit bookings. */
      bookings: string[]
    }
    const paidPeriod: [string, string] = [await day(0, 1), yesterday]
    const unpaidPeriod: [string, string] = [today, newPeriodEnd]
    const dueToday = { subscription_status: 'active', next_renewal_date: today }
    const cases: Record<string, Case> = {
      // The renewal is due today and the day's allocation has run (as it always has on live by the time Stripe tries).
      failedAllocationFirst: { fn: FAILED, row: dueToday, periods: [paidPeriod, unpaidPeriod], bookings: [tomorrow, await day(40)] },
      // The same before the allocation: what the tests had always set up.
      failedAlone: { fn: FAILED, row: dueToday, periods: [paidPeriod], bookings: [tomorrow] },
      // A retry's failure three days on: already past due.
      failedRetry: { fn: FAILED, row: { subscription_status: 'past_due', next_renewal_date: await day(-3) }, periods: [[await day(-3, 1), await day(-4)], [await day(-3), await day(-4, -1)]], bookings: [tomorrow] },
      // A yearly membership: its payment is a year apart, its credit periods a month.
      failedYearly: { fn: FAILED, row: { ...dueToday, billing_frequency: 'yearly' }, periods: [paidPeriod, unpaidPeriod], bookings: [tomorrow] },
      // Not today or earlier: the old sum, from both.
      failedNoRenewalDate: { fn: FAILED, row: { subscription_status: 'active', next_renewal_date: null }, periods: [[await day(-20), await day(10)]], bookings: [tomorrow, await day(20)] },
      failedRenewalTomorrow: { fn: FAILED, row: { subscription_status: 'active', next_renewal_date: tomorrow }, periods: [[await day(1, 1), today], [tomorrow, await day(0, -1)]], bookings: [await day(2)] },
      failedNoPeriods: { fn: FAILED, row: { subscription_status: 'active', next_renewal_date: await day(9) }, periods: [], bookings: [tomorrow] },
      failedAlreadyEnded: { fn: FAILED, row: { subscription_status: 'cancelled', next_renewal_date: today, cancel_effective_date: yesterday }, periods: [paidPeriod, unpaidPeriod], bookings: [tomorrow] },
      // Stripe ends the subscription after every retry failed.
      endedAfterRetries: { fn: ENDED, row: { subscription_status: 'past_due', next_renewal_date: today }, periods: [paidPeriod, unpaidPeriod], bookings: [tomorrow] },
      // Not changed by 030: a last day already set; a membership that isn't past due; a next payment date still to come.
      endedWithLastDaySet: { fn: ENDED, row: { subscription_status: 'past_due', next_renewal_date: today, cancel_effective_date: await day(5) }, periods: [paidPeriod, unpaidPeriod], bookings: [tomorrow, await day(9)] },
      endedWhileActive: { fn: ENDED, row: dueToday, periods: [paidPeriod, unpaidPeriod], bookings: [tomorrow] },
      endedRenewalToCome: { fn: ENDED, row: { subscription_status: 'past_due', next_renewal_date: await day(7) }, periods: [[await day(7, 1), await day(6)]], bookings: [tomorrow, await day(8)] },
    }

    let made = 0
    /** Makes every case's rows anew, calls its function, and reads back what was answered and written. */
    const run = async () => {
      const out: Record<string, { answer: Record<string, unknown>; status: string; lastDay: string | null; bookings: string[] }> = {}
      for (const [name, c] of Object.entries(cases)) {
        const subscription = `sub_030_${name}_${++made}`
        const customer = await fixtures.customer(db)
        const membership = await fixtures.membership(db, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', stripe_subscription_id: subscription, start_date: await day(0, 3), ...c.row })
        for (const [start, end] of c.periods) await insert(db, 'membership_credit_periods', { membership_id: membership, period_start: start, period_end: end, credits_allocated: 4 })
        const bookings: string[] = []
        for (const date of c.bookings) {
          bookings.push(await fixtures.booking(db, { customer_id: customer, party_size: 1, redemption_source: 'membership_credit', redeemed_membership_id: membership, ...(await sessionOn(date)) }))
        }
        const answer = (await db.query<{ answer: Record<string, unknown> | string }>(CALL[c.fn], [subscription]))[0]?.answer
        const row = (await db.query<{ status: string; last_day: string | null }>('SELECT subscription_status AS status, cancel_effective_date::text AS last_day FROM customer_memberships WHERE id = $1', [membership]))[0]
        const statuses: string[] = []
        for (const id of bookings) statuses.push((await db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [id]))[0]?.status as string)
        out[name] = { answer: typeof answer === 'string' ? (JSON.parse(answer) as Record<string, unknown>) : (answer as Record<string, unknown>), status: row?.status as string, lastDay: row?.last_day ?? null, bookings: statuses }
      }
      return out
    }

    await pg.admin.unsafe(BEFORE_030_SQL)
    const before = await run()
    await pg.admin.unsafe(migration030())
    const with030 = await run()
    await pg.admin.unsafe(BEFORE_030_SQL)

    const pastDue = (covered: string, flagged: number) => ({ found: true, action: 'past_due', covered_through: covered, bookings_flagged: flagged })
    const ended = (covered: string, flagged: number) => ({ found: true, action: 'cancelled', covered_through: covered, bookings_flagged: flagged })

    // What 030 mends. Before: covered to the end of the month that was not paid for, nothing flagged.
    expect(before.failedAllocationFirst).toEqual({ answer: pastDue(newPeriodEnd, 1), status: 'past_due', lastDay: null, bookings: ['confirmed', 'payment_needed'] })
    expect(with030.failedAllocationFirst).toEqual({ answer: pastDue(yesterday, 2), status: 'past_due', lastDay: null, bookings: ['payment_needed', 'payment_needed'] })
    expect(before.failedRetry).toEqual({ answer: pastDue(await day(-4, -1), 0), status: 'past_due', lastDay: null, bookings: ['confirmed'] })
    expect(with030.failedRetry).toEqual({ answer: pastDue(await day(-4), 1), status: 'past_due', lastDay: null, bookings: ['payment_needed'] })
    expect(before.failedYearly).toEqual({ answer: pastDue(newPeriodEnd, 0), status: 'past_due', lastDay: null, bookings: ['confirmed'] })
    expect(with030.failedYearly).toEqual({ answer: pastDue(yesterday, 1), status: 'past_due', lastDay: null, bookings: ['payment_needed'] })
    expect(before.endedAfterRetries).toEqual({ answer: ended(newPeriodEnd, 0), status: 'cancelled', lastDay: newPeriodEnd, bookings: ['confirmed'] })
    expect(with030.endedAfterRetries).toEqual({ answer: ended(yesterday, 1), status: 'cancelled', lastDay: yesterday, bookings: ['payment_needed'] })

    // What 030 leaves exactly as it was.
    const same = ['failedAlone', 'failedNoRenewalDate', 'failedRenewalTomorrow', 'failedNoPeriods', 'failedAlreadyEnded', 'endedWithLastDaySet', 'endedWhileActive', 'endedRenewalToCome']
    expect(Object.keys(cases).filter((name) => JSON.stringify(before[name]) === JSON.stringify(with030[name]))).toEqual(same)
    expect(with030.failedAlone).toEqual({ answer: pastDue(yesterday, 1), status: 'past_due', lastDay: null, bookings: ['payment_needed'] })
    expect(with030.failedNoRenewalDate).toEqual({ answer: pastDue(await day(10), 1), status: 'past_due', lastDay: null, bookings: ['confirmed', 'payment_needed'] })
    expect(with030.failedRenewalTomorrow).toEqual({ answer: pastDue(await day(0, -1), 0), status: 'past_due', lastDay: null, bookings: ['confirmed'] })
    expect(with030.failedNoPeriods).toEqual({ answer: pastDue(yesterday, 1), status: 'past_due', lastDay: null, bookings: ['payment_needed'] })
    expect(with030.failedAlreadyEnded).toEqual({ answer: { found: true, action: 'ignored_cancelled' }, status: 'cancelled', lastDay: yesterday, bookings: ['confirmed'] })
    expect(with030.endedWithLastDaySet).toEqual({ answer: ended(await day(5), 1), status: 'cancelled', lastDay: await day(5), bookings: ['confirmed', 'payment_needed'] })
    expect(with030.endedWhileActive).toEqual({ answer: ended(today, 1), status: 'cancelled', lastDay: today, bookings: ['payment_needed'] })
    expect(with030.endedRenewalToCome).toEqual({ answer: ended(await day(6), 1), status: 'cancelled', lastDay: await day(6), bookings: ['confirmed', 'payment_needed'] })
  })
})
