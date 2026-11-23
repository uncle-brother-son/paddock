import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lapseSweep } from '@/server/rules/bookings/lapse-sweep'
import { fixtures, insert } from './database'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W43 item 3: migration 028 is written but NOT applied to live, and the saved schema (live-catalog.json,
// live-schema.sql) is left as live is today: the lead applies 028 after the review, once `lapse_sweep` is on. This
// file holds the migration on real Postgres either way. It starts from the function as it was before 028 (kept here,
// word for word), so it reads the same before and after a refresh of the snapshot: 028 changes that one function and
// nothing else, twice over changes nothing, its Down puts the old one back, the database's sweep itself is kept, and
// after it the hourly job leaves a due booking for the Worker's sweep.

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/028_hourly_job_stops_calling_the_lapse_sweep.sql')
const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')
const FUNCTION = 'run_membership_maintenance'
const SWEEP = 'lapse_sweep_expired_bookings'

/** The function as live has it before 028 (live-catalog.json at W43), and 028's "Down". */
const BEFORE_028 = `CREATE OR REPLACE FUNCTION public.run_membership_maintenance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE p integer; s integer;
BEGIN
  p := public.allocate_membership_credit_periods();
  s := public.lapse_sweep_expired_bookings();
  RETURN jsonb_build_object('periods_created', p, 'lapsed_bookings_cancelled', s);
END $function$
`

/**
 * W68: the database's own sweep as it was when 028 kept it. Migration 034 drops it, so this file makes it for itself and
 * reads the same before and after 034 is in the saved schema.
 */
const SWEEP_KEPT_BY_028 = `CREATE OR REPLACE FUNCTION public.lapse_sweep_expired_bookings()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n integer := 0; r record;
BEGIN
  FOR r IN
    SELECT b.id, b.session_id, b.party_size
    FROM bookings b
    WHERE b.status = 'payment_needed' AND b.payment_due_by <= now() AND COALESCE(b.price_paid, 0) = 0
    FOR UPDATE OF b
  LOOP
    UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'membership_lapsed', updated_at = now()
    WHERE id = r.id;
    UPDATE sessions SET total_booked = GREATEST(total_booked - r.party_size, 0), updated_at = now()
    WHERE id = r.session_id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$
`

/** The function 028 leaves. */
const AFTER_028 = `CREATE OR REPLACE FUNCTION public.run_membership_maintenance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE p integer;
BEGIN
  p := public.allocate_membership_credit_periods();
  RETURN jsonb_build_object('periods_created', p, 'lapsed_bookings_cancelled', 0);
END $function$
`

interface Catalog {
  functions: Array<{ name: string; identity: string; definition: string }>
  [key: string]: unknown
}

describe("migration 028 (brief W43 item 3): the hourly job stops calling the database's lapse sweep", () => {
  let pg: RealPostgres
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const definition = (from: Catalog, name = FUNCTION) => from.functions.find((fn) => fn.name === name)?.definition ?? ''
  const without = (from: Catalog): Catalog => ({ ...from, functions: from.functions.filter((fn) => fn.name !== FUNCTION) })
  const migration = () => readFileSync(MIGRATION, 'utf8')
  const statements = () =>
    migration()
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim()
  const hourlyJob = async () => (await pg.admin.unsafe<{ answer: { periods_created: number; lapsed_bookings_cancelled: number } }[]>('SELECT public.run_membership_maintenance() AS answer'))[0]?.answer

  beforeAll(async () => {
    pg = await startRealPostgres()
    await pg.admin.unsafe(SWEEP_KEPT_BY_028)
  }, 120_000)
  afterAll(() => pg.stop())

  it('the file exists, says it is not applied by W43, and is one statement: the function replaced (no table, row, grant or other function touched, and the sweep not dropped)', () => {
    const sql = migration()
    expect(sql).toContain('NOT APPLIED by W43')
    expect(statements().startsWith('CREATE OR REPLACE FUNCTION public.run_membership_maintenance()')).toBe(true)
    expect(statements().endsWith('END $function$;')).toBe(true)
    expect(statements().match(/CREATE OR REPLACE FUNCTION/gi)).toHaveLength(1)
    expect(statements().match(/\$function\$/g)).toHaveLength(2)
    expect(statements()).not.toMatch(/\b(ALTER|DROP|DELETE|TRUNCATE|INSERT|UPDATE|GRANT|REVOKE)\b/i)
    expect(statements()).not.toContain(SWEEP)
    // The statement is exactly the function this file expects 028 to leave.
    expect(`${statements().replace(/;$/, '')}\n`).toBe(AFTER_028)
  })

  it("its header holds the order (W43a, review S4: pre-check A before the kind goes on, the kind on, then 028 in the same sitting), both pre-checks, the rollback order (the kind off first, then the Down), and a Down that is the function as it was", () => {
    const sql = migration()
    const at = (text: string): number => {
      const index = sql.indexOf(text)
      expect(index, text).toBeGreaterThan(-1)
      return index
    }
    // The order, as written: off, pre-check A, the kind on, the migration.
    const steps = [
      at('--   1. The Worker released with `lapse_sweep` off'),
      at('--   2. Pre-check A (read-only), BEFORE the kind goes on. Expect 0'),
      at('--   3. The kind ON: add `lapse_sweep` to ORDER_SWITCH'),
      at('--   4. This migration, in the same sitting'),
    ]
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    expect(sql).toMatch(/Steps 2 to 4 in ONE sitting/)
    expect(sql).toContain('Never apply it while the kind is off')
    // Pre-check A, word for word (brief W43a item 4), each line a comment.
    const flat = sql.replace(/\n--\s+/g, ' ')
    expect(flat).toContain(
      "SELECT count(*) FROM bookings b WHERE b.status = 'payment_needed' AND COALESCE(b.price_paid, 0) = 0 AND EXISTS (SELECT 1 FROM addon_order_lines a WHERE a.booking_id = b.id AND a.removed_at IS NULL AND a.redemption_source IS DISTINCT FROM 'membership_credit' AND a.price_at_purchase > 0);"
    )
    // Pre-check B: the Worker's sweep is doing the work.
    expect(sql).toMatch(/Pre-check B \(read-only\), at step 4, with the kind ON/)
    expect(sql).toContain("WHERE status = 'payment_needed' AND payment_due_by <= now() - interval '10 minutes'")
    // The rollback: the kind off first, then the Down.
    expect(flat).toMatch(/Rollback, in this order: \(1\) the kind off FIRST [^;]*; \(2\) the Down below, straight after/)
    expect(sql).not.toMatch(/\(1\) the Down below/)
    const down = sql
      .slice(sql.indexOf('-- Down (the function as it was before 028):'))
      .split('\n')
      .slice(1)
      .map((line) => line.replace(/^-- {3}/, '').replace(/^--$/, ''))
      .join('\n')
      .trim()
    expect(`${down.replace(/;$/, '')}\n`).toBe(BEFORE_028)
  })

  it("from the function as it was, 028 changes that one function and nothing else (the database's sweep is kept, word for word); applied twice it changes nothing; its Down puts the old one back", async () => {
    const saved = await catalog()
    await pg.admin.unsafe(BEFORE_028)
    const before = await catalog()
    expect(definition(before)).toBe(BEFORE_028)
    expect(without(before)).toEqual(without(saved))
    const sweepBefore = definition(before, SWEEP)
    expect(sweepBefore).toBe(SWEEP_KEPT_BY_028)
    expect(sweepBefore).toContain("cancel_reason = 'membership_lapsed'")
    const grants = async () =>
      (await pg.admin.unsafe<{ acl: string | null }[]>("SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'public.run_membership_maintenance()'::regprocedure"))[0]?.acl
    const grantsBefore = await grants()

    await pg.admin.unsafe(migration())
    const applied = await catalog()
    expect(without(applied)).toEqual(without(before))
    expect(definition(applied)).toBe(AFTER_028)
    expect(definition(applied)).not.toContain(SWEEP)
    expect(definition(applied, SWEEP)).toBe(sweepBefore)
    // Before the lead applies it and the snapshot is refreshed, the saved schema has the old function; after, this one.
    expect([BEFORE_028, AFTER_028]).toContain(definition(saved))
    if (definition(saved) !== BEFORE_028) expect(applied).toEqual(saved)
    // The grants are as they were (CREATE OR REPLACE keeps them): who may run the hourly job is unchanged.
    expect(await grants()).toBe(grantsBefore)

    await pg.admin.unsafe(migration())
    expect(await catalog()).toEqual(applied)
    expect(await grants()).toBe(grantsBefore)
    await pg.admin.unsafe(BEFORE_028)
    expect(await catalog()).toEqual(before)
    expect(await grants()).toBe(grantsBefore)
  })

  it("a booking past its deadline with nothing paid: before 028 the hourly job cancels it; with 028 the job leaves it (and still allocates), the database's sweep is still there to call, and the Worker's sweep lapses it", async () => {
    const db = pg.connect()
    const serviceType = await fixtures.serviceType(db)
    // W59 (W47b "Noticed" 1): each booking a day after the last, counted up, never picked at random: two random picks
    // could land on the same session time (unique per service type) and fail the run by chance.
    let made = 0
    const due = async () => {
      const customerId = await fixtures.customer(db)
      made += 1
      const start = new Date(Date.UTC(2032, 7, made, 10, 0))
      const slot = { start_time: start.toISOString(), end_time: new Date(start.getTime() + 3_600_000).toISOString() }
      const sessionId = await fixtures.session(db, { service_type_id: serviceType, total_booked: 1, ...slot })
      const bookingId = await fixtures.booking(db, { session_id: sessionId, customer_id: customerId, status: 'payment_needed', redemption_source: 'membership_credit', payment_due_by: new Date(Date.now() - 60_000).toISOString(), ...slot })
      await insert(db, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Mo Member', unit_price: '20', pay_by: 'membership_credit' })
      return bookingId
    }
    const statusOf = async (bookingId: string) => (await db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId]))[0]?.status

    await pg.admin.unsafe(BEFORE_028)
    const first = await due()
    expect(await hourlyJob()).toMatchObject({ lapsed_bookings_cancelled: 1 })
    expect(await statusOf(first)).toBe('cancelled')

    await pg.admin.unsafe(migration())
    const second = await due()
    const answer = await hourlyJob()
    // The same shape, the periods still allocated (a number), and no booking cancelled.
    expect(Object.keys(answer ?? {}).sort()).toEqual(['lapsed_bookings_cancelled', 'periods_created'])
    expect(typeof answer?.periods_created).toBe('number')
    expect(answer?.lapsed_bookings_cancelled).toBe(0)
    expect(await statusOf(second)).toBe('payment_needed')
    // The Worker's sweep is now the one that lapses it.
    expect(await lapseSweep(db, { requestId: 'migration-028', orderSwitch: 'lapse_sweep' })).toMatchObject({ lapsed: 1, items: [{ bookingId: second, outcome: 'lapsed' }] })
    expect(await statusOf(second)).toBe('cancelled')
    // The database's sweep is kept, and still callable by the owner.
    const third = await due()
    expect((await pg.admin.unsafe<{ n: number }[]>('SELECT public.lapse_sweep_expired_bookings() AS n'))[0]?.n).toBe(1)
    expect(await statusOf(third)).toBe('cancelled')
    await pg.admin.unsafe(BEFORE_028)
  })
})
