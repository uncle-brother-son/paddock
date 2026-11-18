import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtures } from './database'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W45a item 1 (W45 audit S1): migration 029 is written but NOT applied to live, and the saved schema
// (live-catalog.json, live-schema.sql) is left as live is today: the lead applies 029 after a diff check. This file
// holds the migration on real Postgres either way. It starts from the function as it was before 029 (kept here, word
// for word), so it reads the same before and after a refresh of the snapshot: 029 changes one line of that one
// function and nothing else, twice over changes nothing, its Down puts the old one back, and with it an active
// membership past its cancel date no longer makes the allocation fail for anyone else.

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/029_credit_allocation_skips_active_memberships_past_their_cancel_date.sql')
const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')
const FUNCTION = 'allocate_membership_credit_periods'
const CHECK = 'membership_credit_periods_valid'

/** The function as live has it before 029 (live-catalog.json at W45a), and 029's "Down". */
const BEFORE_029 = `CREATE OR REPLACE FUNCTION public.allocate_membership_credit_periods()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  today date := (now() at time zone 'Europe/London')::date;
  inserted integer := 0;
begin
  with eligible as (
    select cm.id as membership_id, cm.start_date, cm.cancel_effective_date,
           p.sessions_included, p.is_unlimited,
           -- whole months elapsed since start (anchored to start day), never negative
           greatest(0,
             (extract(year from age(today, cm.start_date))::int * 12
              + extract(month from age(today, cm.start_date))::int)) as n
    from customer_memberships cm
    join membership_plans p on p.id = cm.plan_id
    where cm.start_date is not null
      and cm.start_date <= today
      and (
        cm.subscription_status = 'active'
        or (cm.subscription_status = 'cancelled' and cm.cancel_effective_date >= today)
      )
  ), periods as (
    select membership_id, sessions_included, is_unlimited, cancel_effective_date,
           (start_date + make_interval(months => n))::date as period_start,
           ((start_date + make_interval(months => n + 1))::date - 1) as period_end
    from eligible
  ), ins as (
    insert into membership_credit_periods
      (membership_id, period_start, period_end, credits_allocated, is_unlimited)
    select membership_id, period_start,
           least(period_end, coalesce(cancel_effective_date, period_end)),
           case when is_unlimited then 0 else coalesce(sessions_included, 0) end,
           is_unlimited
    from periods
    where period_start <= today and period_end >= today
    on conflict (membership_id, period_start) do nothing
    returning 1
  )
  select count(*) into inserted from ins;
  return inserted;
end;
$function$
`

/** The function 029 leaves. */
const AFTER_029 = `CREATE OR REPLACE FUNCTION public.allocate_membership_credit_periods()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  today date := (now() at time zone 'Europe/London')::date;
  inserted integer := 0;
begin
  with eligible as (
    select cm.id as membership_id, cm.start_date, cm.cancel_effective_date,
           p.sessions_included, p.is_unlimited,
           -- whole months elapsed since start (anchored to start day), never negative
           greatest(0,
             (extract(year from age(today, cm.start_date))::int * 12
              + extract(month from age(today, cm.start_date))::int)) as n
    from customer_memberships cm
    join membership_plans p on p.id = cm.plan_id
    where cm.start_date is not null
      and cm.start_date <= today
      and (
        (cm.subscription_status = 'active' and (cm.cancel_effective_date is null or cm.cancel_effective_date >= today))
        or (cm.subscription_status = 'cancelled' and cm.cancel_effective_date >= today)
      )
  ), periods as (
    select membership_id, sessions_included, is_unlimited, cancel_effective_date,
           (start_date + make_interval(months => n))::date as period_start,
           ((start_date + make_interval(months => n + 1))::date - 1) as period_end
    from eligible
  ), ins as (
    insert into membership_credit_periods
      (membership_id, period_start, period_end, credits_allocated, is_unlimited)
    select membership_id, period_start,
           least(period_end, coalesce(cancel_effective_date, period_end)),
           case when is_unlimited then 0 else coalesce(sessions_included, 0) end,
           is_unlimited
    from periods
    where period_start <= today and period_end >= today
    on conflict (membership_id, period_start) do nothing
    returning 1
  )
  select count(*) into inserted from ins;
  return inserted;
end;
$function$
`

/** The one line 029 changes: who is eligible among the active memberships. */
const LINE_BEFORE = "        cm.subscription_status = 'active'"
const LINE_AFTER = "        (cm.subscription_status = 'active' and (cm.cancel_effective_date is null or cm.cancel_effective_date >= today))"

interface Catalog {
  functions: Array<{ name: string; identity: string; definition: string }>
  [key: string]: unknown
}

describe('migration 029 (brief W45a item 1; W45 audit S1): the credit allocation skips an active membership past its cancel date', () => {
  let pg: RealPostgres
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const definition = (from: Catalog) => from.functions.find((fn) => fn.name === FUNCTION)?.definition ?? ''
  const without = (from: Catalog): Catalog => ({ ...from, functions: from.functions.filter((fn) => fn.name !== FUNCTION) })
  const migration = () => readFileSync(MIGRATION, 'utf8')
  /** The file's lines, and where its one statement starts and ends (the function has a comment line of its own inside). */
  const parts = () => {
    const lines = migration().split('\n')
    const from = lines.findIndex((line) => line.startsWith('CREATE OR REPLACE FUNCTION'))
    const to = lines.findIndex((line) => line === '$function$;')
    return { lines, from, to }
  }
  const statement = () => {
    const { lines, from, to } = parts()
    return lines.slice(from, to + 1).join('\n')
  }
  const grants = async () => (await pg.admin.unsafe<{ acl: string | null }[]>("SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'public.allocate_membership_credit_periods()'::regprocedure"))[0]?.acl

  beforeAll(async () => {
    pg = await startRealPostgres()
  }, 120_000)
  afterAll(() => pg.stop())

  it('the file exists, says it is not applied by W45a, and is one statement: the function replaced, word for word as expected (no table, row, grant or other function touched)', () => {
    const { lines, from, to } = parts()
    expect(migration()).toContain('NOT APPLIED by W45a')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    // Everything outside the statement is a comment or an empty line.
    const outside = [...lines.slice(0, from), ...lines.slice(to + 1)]
    expect(outside.filter((line) => line !== '' && !line.startsWith('--'))).toEqual([])
    expect(`${statement().replace(/;$/, '')}\n`).toBe(AFTER_029)
    expect(statement().match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(statement().match(/\$function\$/g)).toHaveLength(2)
  })

  // Brief W46 item 1: the lead applied 029 on live on 18 Nov and the snapshot was refreshed from live's catalogue
  // (briefs/W46-logs/live-catalog-answer-2026-11-18-029.json). The refresh's whole diff was this one line.
  it("W46: the saved schema is live's after 029: both saved files hold the function as 029 leaves it, word for word, and no longer the line it replaced", () => {
    const saved = JSON.parse(readFileSync(path.join(__dirname, 'live-catalog.json'), 'utf8')) as Catalog
    const allocation = saved.functions.filter((fn) => fn.name === FUNCTION)
    expect(allocation).toHaveLength(1)
    expect(`${allocation[0]?.definition.trim()}\n`).toBe(AFTER_029)
    const schema = readFileSync(path.join(__dirname, 'live-schema.sql'), 'utf8')
    expect(schema.split(`\n${LINE_AFTER}\n`)).toHaveLength(2)
    expect(schema).not.toContain(`\n${LINE_BEFORE}\n`)
    expect(schema).toContain(`${AFTER_029.trim()};`)
  })

  it('029 is the function as it was with one line changed: an active membership is eligible only with no cancel date or one of today or later, the test a cancelled one already has', () => {
    const before = BEFORE_029.split('\n')
    const after = AFTER_029.split('\n')
    expect(after).toHaveLength(before.length)
    const changed = before.map((line, index) => [line, after[index]] as const).filter(([was, is]) => was !== is)
    expect(changed).toEqual([[LINE_BEFORE, LINE_AFTER]])
    // The cancelled membership's own test, untouched, on the next line.
    expect(after[after.indexOf(LINE_AFTER) + 1]).toBe("        or (cm.subscription_status = 'cancelled' and cm.cancel_effective_date >= today)")
  })

  it('its header holds the order (either way round), the pre-check (expect 0), the check after and the one changed line; its footer the rollback and a Down that is the function as it was', () => {
    const sql = migration()
    const flat = sql.replace(/\n--\s+/g, ' ')
    expect(flat).toContain('Order: either way round is safe, and 029 need not wait for the Worker.')
    expect(flat).toContain(
      "Pre-check (read-only). Expect 0 (the lead's live check on 18 Nov 2026: 0): SELECT count(*) FROM public.customer_memberships WHERE subscription_status = 'active' AND cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date;"
    )
    expect(flat).toContain(
      "Check after applying (read-only): expect true. SELECT pg_get_functiondef('public.allocate_membership_credit_periods()'::regprocedure) LIKE '%(cm.subscription_status = ''active'' and (cm.cancel_effective_date is null or cm.cancel_effective_date >= today))%';"
    )
    expect(sql).toContain(`--   -${LINE_BEFORE}\n--   +${LINE_AFTER}\n`)
    expect(sql).toContain('No data changes')
    // The pre-check, the statement, then the rollback and the Down: in that order.
    const order = [sql.indexOf('-- Pre-check (read-only)'), sql.indexOf('\nCREATE OR REPLACE FUNCTION'), sql.indexOf('-- Rollback: the Down below.'), sql.indexOf('-- Down (the function as it was before 029):')]
    expect(order.every((index) => index > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    const down = sql
      .slice(sql.indexOf('-- Down (the function as it was before 029):'))
      .split('\n')
      .slice(1)
      .map((line) => line.replace(/^-- {3}/, '').replace(/^--$/, ''))
      .join('\n')
      .trim()
    expect(`${down.replace(/;$/, '')}\n`).toBe(BEFORE_029)
  })

  it('from the function as it was, 029 changes that one function and nothing else; applied twice it changes nothing; its Down puts the old one back; the grants are as they were', async () => {
    const saved = await catalog()
    await pg.admin.unsafe(BEFORE_029)
    const before = await catalog()
    expect(definition(before)).toBe(BEFORE_029)
    expect(without(before)).toEqual(without(saved))
    const grantsBefore = await grants()

    await pg.admin.unsafe(migration())
    const applied = await catalog()
    expect(without(applied)).toEqual(without(before))
    expect(definition(applied)).toBe(AFTER_029)
    // Before the lead applies it and the snapshot is refreshed, the saved schema has the old function; after, this one.
    expect([BEFORE_029, AFTER_029]).toContain(definition(saved))
    if (definition(saved) !== BEFORE_029) expect(applied).toEqual(saved)
    expect(await grants()).toBe(grantsBefore)

    await pg.admin.unsafe(migration())
    expect(await catalog()).toEqual(applied)
    expect(await grants()).toBe(grantsBefore)
    await pg.admin.unsafe(BEFORE_029)
    expect(await catalog()).toEqual(before)
    expect(await grants()).toBe(grantsBefore)
  })

  it("an active membership past its cancel date: before 029 the allocation fails for everyone, and with it another member's renewal and the hourly job; with 029 that membership is left out and everyone else gets their period; every membership not past a cancel date gets the same period from both", async () => {
    const db = pg.connect()
    /** A date `days` from today in London, as the function reads today. */
    const day = async (days: number, monthsBack = 0) =>
      (await db.query<{ d: string }>("SELECT (((now() AT TIME ZONE 'Europe/London')::date - make_interval(months => $1::int))::date + $2::int)::text AS d", [monthsBack, days]))[0]?.d as string
    const today = await day(0)
    const plan = await fixtures.plan(db, { sessions_included: 4 })
    const unlimitedPlan = await fixtures.plan(db, { is_unlimited: true })
    const member = async (name: string, row: Record<string, unknown>) =>
      fixtures.membership(db, { customer_id: await fixtures.customer(db), plan_id: plan, billing_frequency: 'monthly', stripe_subscription_id: `sub_029_${name}`, start_date: await day(0, 3), ...row })
    // Started three months ago to the day, so each one's current period starts today (or a day or two back at a month's end).
    const stale = await member('stale', { subscription_status: 'active', cancel_effective_date: await day(-40) })
    const sam = await member('sam', { subscription_status: 'active' })
    const unlimited = await member('unlimited', { subscription_status: 'active', plan_id: unlimitedPlan })
    const leaving = await member('leaving', { subscription_status: 'active', cancel_effective_date: await day(5) })
    const lastDay = await member('last_day', { subscription_status: 'active', cancel_effective_date: today })
    const cancelledStillIn = await member('cancelled_still_in', { subscription_status: 'cancelled', cancel_effective_date: await day(5) })
    const ended = await member('ended', { subscription_status: 'cancelled', cancel_effective_date: await day(-1) })
    // Ten days into a period that was never allocated, with a cancel date of yesterday: before 029 it is given a
    // period that ended yesterday (no failure); with 029, none.
    const midPeriod = await member('mid_period', { subscription_status: 'active', start_date: await day(-10, 3), cancel_effective_date: await day(-1) })
    const names = new Map([[stale, 'stale'], [sam, 'sam'], [unlimited, 'unlimited'], [leaving, 'leaving'], [lastDay, 'lastDay'], [cancelledStillIn, 'cancelledStillIn'], [ended, 'ended'], [midPeriod, 'midPeriod']])

    type Period = { who: string | undefined; ends: string; credits: number; unlimited: boolean }
    const periods = async (): Promise<Period[]> =>
      (await db.query<{ membership_id: string; ends: string; credits_allocated: number; is_unlimited: boolean }>('SELECT membership_id, period_end::text AS ends, credits_allocated, is_unlimited FROM membership_credit_periods'))
        .map((row) => ({ who: names.get(row.membership_id), ends: row.ends, credits: row.credits_allocated, unlimited: row.is_unlimited }))
        .sort((a, b) => String(a.who).localeCompare(String(b.who)))
    const whoHasOne = async () => (await periods()).map((period) => period.who)
    /** A statement's answer, or the error's message (the test carries on). */
    const attempt = async <T>(sql: string, params: unknown[] = []): Promise<T | string> => {
      try {
        return (await db.query<{ answer: T }>(sql, params as never[]))[0]?.answer as T
      } catch (err) {
        return `failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    const allocate = () => attempt<number>('SELECT public.allocate_membership_credit_periods() AS answer')
    const hourlyJob = () => attempt<{ periods_created: number }>('SELECT public.run_membership_maintenance() AS answer')
    const samRenews = () => attempt<{ action: string; periods_created: number }>('SELECT public.membership_mark_paid($1::text, $2::timestamptz) AS answer', ['sub_029_sam', new Date(Date.now() + 30 * 86_400_000).toISOString()])
    const emptied = () => pg.admin.unsafe('DELETE FROM public.membership_credit_periods')

    // Before 029: one stale membership stops everyone's.
    await pg.admin.unsafe(BEFORE_029)
    expect(await allocate()).toContain(CHECK)
    expect(await hourlyJob()).toContain(CHECK)
    expect(await samRenews()).toContain(CHECK)
    expect(await periods()).toEqual([])

    // With 029: the stale one (and the one past its cancel date mid-period) is left out; the rest get theirs.
    await pg.admin.unsafe(migration())
    expect(await allocate()).toBe(5)
    const capped = await day(5)
    const with029 = await periods()
    expect(with029.map((period) => period.who)).toEqual(['cancelledStillIn', 'lastDay', 'leaving', 'sam', 'unlimited'])
    expect(with029.find((period) => period.who === 'leaving')).toMatchObject({ ends: capped, credits: 4, unlimited: false })
    expect(with029.find((period) => period.who === 'cancelledStillIn')).toMatchObject({ ends: capped, credits: 4 })
    expect(with029.find((period) => period.who === 'lastDay')).toMatchObject({ ends: today, credits: 4 })
    expect(with029.find((period) => period.who === 'unlimited')).toMatchObject({ credits: 0, unlimited: true })
    expect((with029.find((period) => period.who === 'sam')?.ends ?? '') > today).toBe(true)
    // Run again: nothing more. The renewal and the hourly job go through.
    expect(await allocate()).toBe(0)
    expect(await samRenews()).toMatchObject({ action: 'reactivated', periods_created: 0 })
    expect(await hourlyJob()).toMatchObject({ periods_created: 0 })
    expect(await whoHasOne()).toEqual(['cancelledStillIn', 'lastDay', 'leaving', 'sam', 'unlimited'])

    // The one other thing 029 changes: an active membership past its cancel date part way through a period that was
    // never allocated. Before 029 it is given a period ending on its cancel date, already over; with 029, none.
    await emptied()
    await pg.admin.unsafe('UPDATE public.customer_memberships SET cancel_effective_date = NULL WHERE id = $1', [stale])
    await pg.admin.unsafe(BEFORE_029)
    expect(await allocate()).toBe(7)
    const beforeRows = await periods()
    expect(beforeRows.find((period) => period.who === 'midPeriod')).toMatchObject({ ends: await day(-1) })
    await emptied()
    await pg.admin.unsafe(migration())
    expect(await allocate()).toBe(6)
    // Every membership not past a cancel date (the stale one now has none) gets exactly the period it got before 029.
    expect(await periods()).toEqual(beforeRows.filter((period) => period.who !== 'midPeriod'))
    expect((await periods()).map((period) => period.who)).toEqual(['cancelledStillIn', 'lastDay', 'leaving', 'sam', 'stale', 'unlimited'])
    await pg.admin.unsafe(BEFORE_029)
  })
})
