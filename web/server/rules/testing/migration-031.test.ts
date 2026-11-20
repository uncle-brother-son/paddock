import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { fixtures, insert } from './database'
import { ANCHOR_031, BEFORE_031_SQL, FAILED, FAILED_ADDED_031, FAILED_AFTER_031, FAILED_BEFORE_031, migration031, PAID, PAID_ADDED_031, PAID_AFTER_031, PAID_BEFORE_031 } from './migration-031'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W47r-d item 1 (W47r-c report "Noticed" 1, fix a) and brief W47r-e item 2 (W47r-d report "Noticed" 2):
// migration 031 is written but NOT applied to live, and the saved schema (live-catalog.json, live-schema.sql) is left
// as live is today: the lead applies 031 after a diff check. This file holds the migration on real Postgres either
// way. It starts from the two functions as they were before 031 (kept word for word in migration-031.ts), so it reads
// the same before and after a refresh of the snapshot: 031 adds six lines to membership_mark_paid and the same test
// and answer to membership_mark_payment_failed (W47r-e) and changes nothing else, twice over changes nothing, its
// Down puts the old ones back, and with it a payment for a membership whose last day has passed writes nothing and a
// failed one does not mark it past due. Mo's case on the replay's clock (last day 9 January, GBP 40 taken on 10
// January; a payment on 8 January) is in memberships/cancelled-here.test.ts; the failed renewal is in
// memberships/cancel-wins.test.ts.

const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')
const DOWN_MARK = '-- Down (the two functions as they were before 031):'
/** The function called as the Worker calls it: the subscription's id and the end of the period Stripe shows. */
const CALL = 'SELECT public.membership_mark_paid($1::text, $2::timestamptz) AS answer'
/** The failed-payment function, as the Worker calls it: the subscription's id. */
const CALL_FAILED = 'SELECT public.membership_mark_payment_failed($1::text) AS answer'
const SIGNATURE = 'public.membership_mark_paid(text, timestamp with time zone)'
const FAILED_SIGNATURE = 'public.membership_mark_payment_failed(text)'
/** The two functions 031 replaces, in the file's order, with what each is before and after and the lines it gains. */
const BOTH = [
  { name: PAID, before: PAID_BEFORE_031, after: PAID_AFTER_031, added: PAID_ADDED_031, firstWrite: '  UPDATE customer_memberships' },
  { name: FAILED, before: FAILED_BEFORE_031, after: FAILED_AFTER_031, added: FAILED_ADDED_031, firstWrite: "  UPDATE customer_memberships SET subscription_status = 'past_due', updated_at = now() WHERE id = m.id;" },
] as const
const NAMES: readonly string[] = [PAID, FAILED]

interface Catalog {
  functions: Array<{ name: string; identity: string; definition: string }>
  [key: string]: unknown
}

/** The file's lines, and where its two statements start and end (each function has comment lines of its own inside). */
const parts = () => {
  const lines = migration031().split('\n')
  const starts = lines.flatMap((line, index) => (line.startsWith('CREATE OR REPLACE FUNCTION') ? [index] : []))
  const ends = lines.flatMap((line, index) => (line === 'END $function$;' ? [index] : []))
  return { lines, starts, ends }
}
/** One of the file's statements (0: membership_mark_paid, 1: membership_mark_payment_failed), as the catalogue gives a function: no closing semicolon, one newline at the end. */
const statement = (which: number): string => {
  const { lines, starts, ends } = parts()
  return `${lines.slice(starts[which], (ends[which] ?? 0) + 1).join('\n').replace(/;$/, '')}\n`
}
/** The Down in the file's footer, with its comment marks taken off: a script that can be run as written. */
const down = (): string => {
  const sql = migration031()
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
  const lines = migration031().split('\n')
  const from = lines.findIndex((line) => line.startsWith(mark))
  const block: string[] = []
  for (const line of lines.slice(from + 1)) {
    if (!line.startsWith('--    ')) break
    block.push(line.replace(/^--/, ''))
  }
  return block.join('\n')
}

describe('migration 031 (brief W47r-d item 1 and brief W47r-e item 2): a payment after the membership\'s last day is not recorded, and a failed one does not mark it past due', () => {
  let pg: RealPostgres
  let db: Db
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const definition = (from: Catalog, name: string = PAID) => from.functions.find((fn) => fn.name === name)?.definition ?? ''
  const without = (from: Catalog): Catalog => ({ ...from, functions: from.functions.filter((fn) => !NAMES.includes(fn.name)) })
  const grants = async () =>
    (await pg.admin.unsafe<{ acl: string | null }[]>(`SELECT proacl::text AS acl FROM pg_proc WHERE oid IN ('${SIGNATURE}'::regprocedure, '${FAILED_SIGNATURE}'::regprocedure) ORDER BY proname`)).map((row) => row.acl)

  beforeAll(async () => {
    pg = await startRealPostgres()
    db = pg.connect()
  }, 120_000)
  afterAll(() => pg.stop())

  it('the file exists, says it is not applied by W47r-d or W47r-e, and is two statements: each function replaced, word for word as expected (no table, row, grant or other function touched)', () => {
    const { lines, starts, ends } = parts()
    expect(migration031()).toContain('NOT APPLIED by W47r-d or W47r-e')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect([starts[0], ends[0], starts[1], ends[1]].map(Number)).toEqual([starts[0], ends[0], starts[1], ends[1]].map(Number).sort((a, b) => a - b))
    // Everything outside the two statements is a comment or an empty line.
    const inside = (index: number) => (index >= Number(starts[0]) && index <= Number(ends[0])) || (index >= Number(starts[1]) && index <= Number(ends[1]))
    expect(lines.filter((line, index) => !inside(index) && line !== '' && !line.startsWith('--'))).toEqual([])
    expect(statement(0)).toBe(PAID_AFTER_031)
    expect(statement(1)).toBe(FAILED_AFTER_031)
    expect(lines[Number(starts[0])]).toContain(`public.${PAID}(`)
    expect(lines[Number(starts[1])]).toContain(`public.${FAILED}(`)
    expect(migration031().match(/^CREATE OR REPLACE FUNCTION/gm)).toHaveLength(2)
    expect(migration031().match(/^(?!--).*\$function\$/gm)).toHaveLength(4)
  })

  it.each(BOTH)("031 is $name as it was with six lines added and none changed or removed: straight after its own answer for a membership that has ended, and before its first write, a membership whose last day is before today (London) is answered `ignored_cancelled`", ({ before: was, after: is, added, firstWrite }) => {
    const before = was.split('\n')
    const after = is.split('\n')
    expect(added).toHaveLength(6)
    // The anchor is the first line that reads so: the end of the function's own "ended" answer.
    const at = before.indexOf(ANCHOR_031)
    expect([...before.slice(0, at + 1), ...added, ...before.slice(at + 1)]).toEqual(after)
    // Take the six lines out again, by their place, and the old function is left, line for line.
    expect(after.slice(at + 1, at + 7)).toEqual(added)
    expect([...after.slice(0, at + 1), ...after.slice(at + 7)]).toEqual(before)
    // The lines sit between the function's own "ended" answer and its first write.
    expect(after.slice(at - 2, at + 1)).toEqual(["  IF m.subscription_status = 'cancelled' THEN", "    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');", '  END IF;'])
    expect(after[at + 7]).toBe(firstWrite)
    expect(after.findIndex((line) => line.includes('UPDATE '))).toBe(at + 7)
    // And before anything that flags a booking (membership_mark_payment_failed's; membership_mark_paid has none).
    expect(after.slice(0, at + 7).filter((line) => line.includes('flag_uncovered_credit_bookings') || line.includes('UPDATE '))).toEqual([])
    // The test is the last day alone, strictly before today by London's date; the answer is the old one, with the day.
    expect(added.slice(0, 3).every((line) => line.startsWith('  -- '))).toBe(true)
    expect(added[3]).toBe("  IF m.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date THEN")
    expect(added[4]).toBe("    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled', 'last_day', m.cancel_effective_date);")
    expect(added[5]).toBe('  END IF; -- 031')
  })

  it('the two functions gain the same test and the same answer (the last three of the six lines); only the comment above them differs', () => {
    expect(FAILED_ADDED_031.slice(3)).toEqual(PAID_ADDED_031.slice(3))
    expect(FAILED_ADDED_031.slice(0, 3)).not.toEqual(PAID_ADDED_031.slice(0, 3))
  })

  it('its header holds the order (the Worker first), the two pre-checks (expect 0), the check after (both functions) and every added line as a diff of each function; its footer the rollback and a Down that is the two functions as they were', () => {
    const sql = migration031()
    const flat = sql.replace(/\n--\s+/g, ' ')
    expect(flat).toContain('Order: the Worker with W47r-c, W47r-d and W47r-e first, then 031.')
    expect(flat).toContain(
      "Pre-checks (read-only). Expect 0 for each: SELECT count(*) FROM public.customer_memberships WHERE subscription_status = 'active' AND cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date; SELECT count(*) FROM public.customer_memberships WHERE subscription_status = 'past_due' AND cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date;"
    )
    expect(flat).toContain(
      "Check after applying (read-only): expect true. SELECT pg_get_functiondef('public.membership_mark_paid(text, timestamp with time zone)'::regprocedure) LIKE '%IF m.cancel_effective_date < (now() AT TIME ZONE ''Europe/London'')::date THEN%' AND pg_get_functiondef('public.membership_mark_payment_failed(text)'::regprocedure) LIKE '%IF m.cancel_effective_date < (now() AT TIME ZONE ''Europe/London'')::date THEN%';"
    )
    // The diffs against live, in the header: each from its first line to the next one's (or to the section after).
    const paidFrom = sql.indexOf('--   --- saved schema (live): membership_mark_paid(text, timestamp with time zone)')
    const failedFrom = sql.indexOf('--   --- saved schema (live): membership_mark_payment_failed(text)')
    const diffsEnd = sql.indexOf("-- What it can and can't do:")
    expect(paidFrom).toBeGreaterThan(-1)
    expect(failedFrom).toBeGreaterThan(paidFrom)
    expect(diffsEnd).toBeGreaterThan(failedFrom)
    expect(sql.match(/^-- {3}--- saved schema \(live\): /gm)).toHaveLength(2)
    for (const [diff, added] of [[sql.slice(paidFrom, failedFrom), PAID_ADDED_031], [sql.slice(failedFrom, diffsEnd), FAILED_ADDED_031]] as const) {
      for (const line of added) expect(diff).toContain(`\n--   +${line}\n`)
      // It adds lines only: no line of the function is taken out.
      expect(diff.split('\n').filter((line) => line.startsWith('--   -') && !line.startsWith('--   ---'))).toEqual([])
      expect(diff.split('\n').filter((line) => line.startsWith('--   +') && !line.startsWith('--   +++'))).toHaveLength(6)
    }
    expect(sql).toContain('No data changes')
    // The pre-checks, the statement, then the rollback and the Down: in that order.
    const order = [sql.indexOf('-- Pre-checks (read-only)'), sql.indexOf('\nCREATE OR REPLACE FUNCTION'), sql.indexOf('-- Rollback: the Down below.'), sql.indexOf(DOWN_MARK)]
    expect(order.every((index) => index > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(`${down()}\n`).toBe(BEFORE_031_SQL)
  })

  it('from the two functions as they were, 031 changes those two and nothing else; applied twice it changes nothing; its Down, run as written, puts the old ones back; the grants are as they were', async () => {
    const saved = await catalog()
    await pg.admin.unsafe(BEFORE_031_SQL)
    const before = await catalog()
    expect(definition(before, PAID)).toBe(PAID_BEFORE_031)
    expect(definition(before, FAILED)).toBe(FAILED_BEFORE_031)
    expect(without(before)).toEqual(without(saved))
    expect(before.functions.length - without(before).functions.length).toBe(2)
    const grantsBefore = await grants()
    expect(grantsBefore).toHaveLength(2)

    await pg.admin.unsafe(migration031())
    const applied = await catalog()
    expect(without(applied)).toEqual(without(before))
    expect(definition(applied, PAID)).toBe(PAID_AFTER_031)
    expect(definition(applied, FAILED)).toBe(FAILED_AFTER_031)
    // Before the lead applies it and the snapshot is refreshed, the saved schema has the old functions; after, these.
    expect([PAID_BEFORE_031, PAID_AFTER_031]).toContain(definition(saved, PAID))
    expect([FAILED_BEFORE_031, FAILED_AFTER_031]).toContain(definition(saved, FAILED))
    expect(definition(saved, PAID) === PAID_BEFORE_031).toBe(definition(saved, FAILED) === FAILED_BEFORE_031)
    if (definition(saved, PAID) !== PAID_BEFORE_031) expect(applied).toEqual(saved)
    expect(await grants()).toEqual(grantsBefore)

    await pg.admin.unsafe(migration031())
    expect(await catalog()).toEqual(applied)
    expect(await grants()).toEqual(grantsBefore)
    await pg.admin.unsafe(down())
    expect(await catalog()).toEqual(before)
    expect(await grants()).toEqual(grantsBefore)
  })

  it("the header's own SQL runs: the check after is false before 031, false with only one of the two functions replaced, and true with both; each pre-check counts what it says (an active membership past its last day; a past-due one past its last day)", async () => {
    const checkAfter = headerSql('-- Check after applying (read-only)')
    const preChecks = headerSql('-- Pre-checks (read-only)')
      .split(';')
      .map((sql) => sql.trim())
      .filter((sql) => sql !== '')
    expect(preChecks).toHaveLength(2)
    const answer = async (sql: string) => Object.values((await pg.admin.unsafe(sql))[0] ?? {})[0]
    const counts = async () => [Number(await answer(preChecks[0] as string)), Number(await answer(preChecks[1] as string))]

    await pg.admin.unsafe(BEFORE_031_SQL)
    expect(await answer(checkAfter)).toBe(false)
    // Half applied (one function only, either one): still false.
    await pg.admin.unsafe(`${PAID_AFTER_031.trimEnd()};`)
    expect(await answer(checkAfter)).toBe(false)
    await pg.admin.unsafe(BEFORE_031_SQL)
    await pg.admin.unsafe(`${FAILED_AFTER_031.trimEnd()};`)
    expect(await answer(checkAfter)).toBe(false)
    await pg.admin.unsafe(BEFORE_031_SQL)
    await pg.admin.unsafe(migration031())
    expect(await answer(checkAfter)).toBe(true)
    await pg.admin.unsafe(BEFORE_031_SQL)
    expect(await answer(checkAfter)).toBe(false)

    const day = async (days: number) => (await db.query<{ d: string }>("SELECT ((now() AT TIME ZONE 'Europe/London')::date + $1::int)::text AS d", [days]))[0]?.d as string
    const [baseline0, baseline1] = await counts()
    const plan = await fixtures.plan(db, { sessions_included: 4 })
    const member = async (row: Record<string, unknown>) => fixtures.membership(db, { customer_id: await fixtures.customer(db), plan_id: plan, billing_frequency: 'monthly', ...row })
    // Counted: the last day was yesterday or earlier, and the row has not been ended.
    await member({ subscription_status: 'active', cancel_effective_date: await day(-1) })
    expect(await counts()).toEqual([Number(baseline0) + 1, baseline1])
    await member({ subscription_status: 'past_due', cancel_effective_date: await day(-30) })
    expect(await counts()).toEqual([Number(baseline0) + 1, Number(baseline1) + 1])
    // Not counted: the last day is today or still to come; no last day; a row that has ended.
    await member({ subscription_status: 'active', cancel_effective_date: await day(0) })
    await member({ subscription_status: 'active', cancel_effective_date: await day(1) })
    await member({ subscription_status: 'past_due', cancel_effective_date: await day(0) })
    await member({ subscription_status: 'active' })
    await member({ subscription_status: 'past_due' })
    await member({ subscription_status: 'cancelled', cancel_effective_date: await day(-1) })
    expect(await counts()).toEqual([Number(baseline0) + 1, Number(baseline1) + 1])
  })

  it('what the function answers and writes, before 031 and with it, for ten memberships (dates counted from today): a payment after the last day was recorded and is now answered `ignored_cancelled` with nothing written (no status, no next payment date, no booking put back, no credit period); on the last day itself, before it, with no last day, and for a row already ended, both answer exactly the same', async () => {
    const day = async (days: number) => (await db.query<{ d: string }>("SELECT ((now() AT TIME ZONE 'Europe/London')::date + $1::int)::text AS d", [days]))[0]?.d as string
    const today = await day(0)
    const yesterday = await day(-1)
    const tomorrow = await day(1)
    /** The end of the period Stripe shows once the payment is taken: 30 days on, at 12:00 UTC (the same date in London). */
    const periodEnd = `${await day(30)}T12:00:00Z`
    const nextPayment = await day(30)
    const plan = await fixtures.plan(db, { sessions_included: 4 })
    const serviceType = await fixtures.serviceType(db)
    const band = await fixtures.band(db)
    let session: { session_id: string; start_time: string; end_time: string } | null = null
    /** One session, ten days on: each member's flagged credit booking is on it. */
    const sessionSlot = async () => {
      if (!session) {
        const date = await day(10)
        const slot = { start_time: `${date} 10:00:00+00`, end_time: `${date} 11:00:00+00` }
        session = { session_id: await fixtures.session(db, { service_type_id: serviceType, band_id: band, capacity: 100, ...slot }), ...slot }
      }
      return session
    }

    const cases: Record<string, Record<string, unknown>> = {
      // What 031 changes: the last day has passed and the row has not been ended.
      activePastLastDay: { subscription_status: 'active', cancel_effective_date: yesterday },
      pastDuePastLastDay: { subscription_status: 'past_due', cancel_effective_date: yesterday },
      activeLongPast: { subscription_status: 'active', cancel_effective_date: await day(-45) },
      // What it leaves exactly as it was.
      activeOnLastDay: { subscription_status: 'active', cancel_effective_date: today },
      pastDueOnLastDay: { subscription_status: 'past_due', cancel_effective_date: today },
      activeLastDayToCome: { subscription_status: 'active', cancel_effective_date: tomorrow },
      activeNoLastDay: { subscription_status: 'active' },
      pastDueNoLastDay: { subscription_status: 'past_due' },
      endedPastLastDay: { subscription_status: 'cancelled', cancel_effective_date: yesterday },
      endedNoLastDay: { subscription_status: 'cancelled' },
    }

    let made = 0
    /** Makes every case's rows anew, calls the function, and reads back what was answered and written. */
    const run = async () => {
      const out: Record<string, { answer: Record<string, unknown>; status: string; lastDay: string | null; renews: string | null; booking: string; periods: number }> = {}
      for (const [name, row] of Object.entries(cases)) {
        const subscription = `sub_031_${name}_${++made}`
        const customer = await fixtures.customer(db)
        // Next payment 5 days ago: a payment that is recorded moves it on; one that isn't leaves it.
        const membership = await fixtures.membership(db, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', stripe_subscription_id: subscription, start_date: await day(-65), next_renewal_date: await day(-5), ...row })
        await insert(db, 'membership_credit_periods', { membership_id: membership, period_start: await day(-65), period_end: await day(-36), credits_allocated: 4 })
        const booking = await fixtures.booking(db, { customer_id: customer, party_size: 1, status: 'payment_needed', redemption_source: 'membership_credit', redeemed_membership_id: membership, ...(await sessionSlot()) })
        const periodsBefore = Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM membership_credit_periods WHERE membership_id = $1', [membership]))[0]?.n)
        const answer = (await db.query<{ answer: Record<string, unknown> | string }>(CALL, [subscription, periodEnd]))[0]?.answer
        const after = (await db.query<{ status: string; last_day: string | null; renews: string | null }>('SELECT subscription_status AS status, cancel_effective_date::text AS last_day, next_renewal_date::text AS renews FROM customer_memberships WHERE id = $1', [membership]))[0]
        const periodsAfter = Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM membership_credit_periods WHERE membership_id = $1', [membership]))[0]?.n)
        out[name] = {
          answer: typeof answer === 'string' ? (JSON.parse(answer) as Record<string, unknown>) : (answer as Record<string, unknown>),
          status: after?.status as string,
          lastDay: after?.last_day ?? null,
          renews: after?.renews ?? null,
          booking: (await db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [booking]))[0]?.status as string,
          periods: periodsAfter - periodsBefore,
        }
      }
      return out
    }

    await pg.admin.unsafe(BEFORE_031_SQL)
    const before = await run()
    await pg.admin.unsafe(migration031())
    const with031 = await run()
    await pg.admin.unsafe(BEFORE_031_SQL)

    const unpaidSince = await day(-5)
    const recorded = (was: string, lastDay: string | null) => ({ answer: expect.objectContaining({ found: true, action: 'reactivated', was, bookings_restored: 1 }), status: 'active', lastDay, renews: nextPayment, booking: 'confirmed', periods: expect.any(Number) })
    const nothingWritten = (status: string, lastDay: string) => ({ answer: { found: true, action: 'ignored_cancelled', last_day: lastDay }, status, lastDay, renews: unpaidSince, booking: 'payment_needed', periods: 0 })
    const ended = (lastDay: string | null) => ({ answer: { found: true, action: 'ignored_cancelled' }, status: 'cancelled', lastDay, renews: unpaidSince, booking: 'payment_needed', periods: 0 })

    // What 031 mends. Before: marked paid, the next payment date moved on, the flagged booking put back.
    expect(before.activePastLastDay).toEqual(recorded('active', yesterday))
    expect(before.pastDuePastLastDay).toEqual(recorded('past_due', yesterday))
    expect(before.activeLongPast).toEqual(recorded('active', await day(-45)))
    // With it: nothing written at all, and the answer carries the last day.
    expect(with031.activePastLastDay).toEqual(nothingWritten('active', yesterday))
    expect(with031.pastDuePastLastDay).toEqual(nothingWritten('past_due', yesterday))
    expect(with031.activeLongPast).toEqual(nothingWritten('active', await day(-45)))

    // What 031 leaves exactly as it was: the last day itself is still a day the member has.
    const same = ['activeOnLastDay', 'pastDueOnLastDay', 'activeLastDayToCome', 'activeNoLastDay', 'pastDueNoLastDay', 'endedPastLastDay', 'endedNoLastDay']
    const stripped = (o: (typeof before)[string]) => JSON.stringify({ ...o, answer: { ...o.answer, periods_created: undefined } })
    expect(Object.keys(cases).filter((name) => stripped(before[name] as (typeof before)[string]) === stripped(with031[name] as (typeof before)[string]))).toEqual(same)
    expect(with031.activeOnLastDay).toEqual(recorded('active', today))
    expect(with031.pastDueOnLastDay).toEqual(recorded('past_due', today))
    expect(with031.activeLastDayToCome).toEqual(recorded('active', tomorrow))
    expect(with031.activeNoLastDay).toEqual(recorded('active', null))
    expect(with031.pastDueNoLastDay).toEqual(recorded('past_due', null))
    expect(with031.endedPastLastDay).toEqual(ended(yesterday))
    expect(with031.endedNoLastDay).toEqual(ended(null))
  })

  it('membership_mark_payment_failed, before 031 and with it, for ten memberships (dates counted from today): a failed payment after the last day marked the row past due and flagged its credit booking, and is now answered `ignored_cancelled` with nothing written (no status, no booking flagged); on the last day itself, before it, with no last day, and for a row already ended, both answer exactly the same', async () => {
    const day = async (days: number) => (await db.query<{ d: string }>("SELECT ((now() AT TIME ZONE 'Europe/London')::date + $1::int)::text AS d", [days]))[0]?.d as string
    const today = await day(0)
    const yesterday = await day(-1)
    const tomorrow = await day(1)
    const plan = await fixtures.plan(db, { sessions_included: 4 })
    const serviceType = await fixtures.serviceType(db)
    const band = await fixtures.band(db)
    // Eleven days on: the bookings table lets no two live bookings on different sessions overlap, and the payment test's session is ten days on.
    const date = await day(11)
    const slot = { start_time: `${date} 10:00:00+00`, end_time: `${date} 11:00:00+00` }
    /** One session: each member's confirmed credit booking is on it, after the day they are paid up to. */
    const session = { session_id: await fixtures.session(db, { service_type_id: serviceType, band_id: band, capacity: 100, ...slot }), ...slot }

    const cases: Record<string, Record<string, unknown>> = {
      // What 031 changes: the last day has passed and the row has not been ended.
      activePastLastDay: { subscription_status: 'active', cancel_effective_date: yesterday },
      pastDuePastLastDay: { subscription_status: 'past_due', cancel_effective_date: yesterday },
      activeLongPast: { subscription_status: 'active', cancel_effective_date: await day(-45) },
      // What it leaves exactly as it was.
      activeOnLastDay: { subscription_status: 'active', cancel_effective_date: today },
      pastDueOnLastDay: { subscription_status: 'past_due', cancel_effective_date: today },
      activeLastDayToCome: { subscription_status: 'active', cancel_effective_date: tomorrow },
      activeNoLastDay: { subscription_status: 'active' },
      pastDueNoLastDay: { subscription_status: 'past_due' },
      endedPastLastDay: { subscription_status: 'cancelled', cancel_effective_date: yesterday },
      endedNoLastDay: { subscription_status: 'cancelled' },
    }

    let made = 0
    /** Makes every case's rows anew, calls the function, and reads back what was answered and written. */
    const run = async () => {
      const out: Record<string, { answer: Record<string, unknown>; status: string; lastDay: string | null; renews: string | null; booking: string }> = {}
      for (const [name, row] of Object.entries(cases)) {
        const subscription = `sub_031_failed_${name}_${++made}`
        const customer = await fixtures.customer(db)
        // The payment was due 5 days ago and has not been made: paid up to the day before that.
        const membership = await fixtures.membership(db, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', stripe_subscription_id: subscription, start_date: await day(-65), next_renewal_date: await day(-5), ...row })
        await insert(db, 'membership_credit_periods', { membership_id: membership, period_start: await day(-65), period_end: await day(-36), credits_allocated: 4 })
        const booking = await fixtures.booking(db, { customer_id: customer, party_size: 1, status: 'confirmed', redemption_source: 'membership_credit', redeemed_membership_id: membership, ...session })
        const answer = (await db.query<{ answer: Record<string, unknown> | string }>(CALL_FAILED, [subscription]))[0]?.answer
        const after = (await db.query<{ status: string; last_day: string | null; renews: string | null }>('SELECT subscription_status AS status, cancel_effective_date::text AS last_day, next_renewal_date::text AS renews FROM customer_memberships WHERE id = $1', [membership]))[0]
        out[name] = {
          answer: typeof answer === 'string' ? (JSON.parse(answer) as Record<string, unknown>) : (answer as Record<string, unknown>),
          status: after?.status as string,
          lastDay: after?.last_day ?? null,
          renews: after?.renews ?? null,
          booking: (await db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [booking]))[0]?.status as string,
        }
      }
      return out
    }

    await pg.admin.unsafe(BEFORE_031_SQL)
    const before = await run()
    await pg.admin.unsafe(migration031())
    const with031 = await run()
    await pg.admin.unsafe(BEFORE_031_SQL)

    const unpaidSince = await day(-5)
    const paidUpTo = await day(-6)
    const markedPastDue = (lastDay: string | null) => ({ answer: { found: true, action: 'past_due', covered_through: paidUpTo, bookings_flagged: 1 }, status: 'past_due', lastDay, renews: unpaidSince, booking: 'payment_needed' })
    const nothingWritten = (status: string, lastDay: string) => ({ answer: { found: true, action: 'ignored_cancelled', last_day: lastDay }, status, lastDay, renews: unpaidSince, booking: 'confirmed' })
    const ended = (lastDay: string | null) => ({ answer: { found: true, action: 'ignored_cancelled' }, status: 'cancelled', lastDay, renews: unpaidSince, booking: 'confirmed' })

    // What 031 mends. Before: marked past due a day (or 45) after its last day, and its credit booking flagged.
    expect(before.activePastLastDay).toEqual(markedPastDue(yesterday))
    expect(before.pastDuePastLastDay).toEqual(markedPastDue(yesterday))
    expect(before.activeLongPast).toEqual(markedPastDue(await day(-45)))
    // With it: nothing written at all, and the answer carries the last day.
    expect(with031.activePastLastDay).toEqual(nothingWritten('active', yesterday))
    expect(with031.pastDuePastLastDay).toEqual(nothingWritten('past_due', yesterday))
    expect(with031.activeLongPast).toEqual(nothingWritten('active', await day(-45)))

    // What 031 leaves exactly as it was: the last day itself is still a day the member has.
    const same = ['activeOnLastDay', 'pastDueOnLastDay', 'activeLastDayToCome', 'activeNoLastDay', 'pastDueNoLastDay', 'endedPastLastDay', 'endedNoLastDay']
    expect(Object.keys(cases).filter((name) => JSON.stringify(before[name]) === JSON.stringify(with031[name]))).toEqual(same)
    expect(with031.activeOnLastDay).toEqual(markedPastDue(today))
    expect(with031.pastDueOnLastDay).toEqual(markedPastDue(today))
    expect(with031.activeLastDayToCome).toEqual(markedPastDue(tomorrow))
    expect(with031.activeNoLastDay).toEqual(markedPastDue(null))
    expect(with031.pastDueNoLastDay).toEqual(markedPastDue(null))
    expect(with031.endedPastLastDay).toEqual(ended(yesterday))
    expect(with031.endedNoLastDay).toEqual(ended(null))
  })
})
