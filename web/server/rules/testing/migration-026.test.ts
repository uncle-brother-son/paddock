import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HERD_RULE_SQL } from '@/server/rules/memberships/credits'
import { fixtures } from './database'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W37a item 3 (W37 report "Noticed" 1): migration 026 is written but NOT applied to live, and the saved schema
// (live-catalog.json, live-schema.sql) is left as live is today: the lead applies 026 and refreshes the snapshot from
// live then. This file holds the migration on real Postgres either way. It starts from the function as it was before
// 026 (kept here, word for word), so it reads the same before and after the refresh: 026 changes that one function
// and nothing else, twice over changes nothing, the rule inside it is still the Worker's HERD_RULE_SQL, and the hourly
// refresh is no longer stopped by a membership with no billing frequency.

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/026_refresh_herd_flags_never_null.sql')
const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')
const FUNCTION = 'refresh_herd_flags'

/** The function as live has it before 026 (live-catalog.json at W37), and 026's "Down". */
const BEFORE_026 = `CREATE OR REPLACE FUNCTION public.refresh_herd_flags()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  wait_months integer;
  changed integer;
begin
  select addon_credit_wait_months into wait_months from public.membership_settings where id;
  wait_months := coalesce(wait_months, 6);
  update public.customer_memberships cm
     set is_herd = (cm.billing_frequency = 'yearly'
                    or cm.start_date <= (now() at time zone 'Europe/London')::date - (wait_months || ' months')::interval),
         updated_at = now()
   where cm.herd_override is null
     and cm.is_herd is distinct from (cm.billing_frequency = 'yearly'
                    or cm.start_date <= (now() at time zone 'Europe/London')::date - (wait_months || ' months')::interval);
  get diagnostics changed = row_count;
  return changed;
end $function$
`

interface Catalog {
  functions: Array<{ name: string; identity: string; definition: string }>
  [key: string]: unknown
}

const squeezed = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const count = (text: string, part: string) => text.split(part).length - 1

describe('migration 026 (brief W37a item 3): the hourly Herd refresh is never stopped by one membership', () => {
  let pg: RealPostgres
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const definition = (from: Catalog) => from.functions.find((fn) => fn.name === FUNCTION)?.definition ?? ''
  const without = (from: Catalog): Catalog => ({ ...from, functions: from.functions.filter((fn) => fn.name !== FUNCTION) })
  const migration = () => readFileSync(MIGRATION, 'utf8')
  const refresh = () =>
    pg.admin.unsafe('SELECT public.refresh_herd_flags() AS changed').then(
      (rows) => `ran: ${String(rows[0]?.['changed'])}`,
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    )
  const flags = async (ids: string[]) => {
    const rows = await pg.admin.unsafe<{ id: string; is_herd: boolean }[]>(`SELECT id, is_herd FROM customer_memberships WHERE id IN (${ids.map((id) => `'${id}'`).join(', ')})`)
    return ids.map((id) => rows.find((row) => row.id === id)?.is_herd)
  }

  beforeAll(async () => {
    pg = await startRealPostgres()
  }, 120_000)
  afterAll(() => pg.stop())

  it('the file exists, says it is not applied by W37a, and is one statement: the function replaced (no table, row, grant or other function touched)', () => {
    const sql = migration()
    expect(sql).toContain('NOT APPLIED by W37a')
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim()
    expect(statements.startsWith('CREATE OR REPLACE FUNCTION public.refresh_herd_flags()')).toBe(true)
    expect(statements.endsWith('end $function$;')).toBe(true)
    expect(statements.match(/CREATE OR REPLACE FUNCTION/gi)).toHaveLength(1)
    expect(statements.match(/\$function\$/g)).toHaveLength(2)
    expect(statements).not.toMatch(/\b(ALTER|DROP|DELETE|TRUNCATE|INSERT|GRANT|REVOKE)\b/i)
  })

  it('from the function as it was, 026 changes that one function and nothing else: the rule wrapped in coalesce(…, false) in both places; applied twice it changes nothing; its Down puts the old one back', async () => {
    const saved = await catalog()
    await pg.admin.unsafe(BEFORE_026)
    const before = await catalog()
    expect(definition(before)).toBe(BEFORE_026)
    expect(without(before)).toEqual(without(saved))

    await pg.admin.unsafe(migration())
    const applied = await catalog()
    expect(without(applied)).toEqual(without(before))
    // Exactly the old text with the two wrappers: nothing else in the function moved.
    const rule = `(cm.billing_frequency = 'yearly'\n                    or cm.start_date <= (now() at time zone 'Europe/London')::date - (wait_months || ' months')::interval)`
    expect(count(BEFORE_026, rule)).toBe(2)
    expect(definition(applied)).toBe(BEFORE_026.split(rule).join(`coalesce(${rule}, false)`))
    // The rule inside is still the Worker's single-membership rule (credits.ts), which credits.test.ts also holds.
    expect(count(squeezed(definition(applied)), `coalesce(${squeezed(HERD_RULE_SQL)}, false)`)).toBe(2)
    // Before the lead refreshes the snapshot the saved schema has the old function; after, exactly this one.
    expect([BEFORE_026, definition(applied)]).toContain(definition(saved))
    if (definition(saved) !== BEFORE_026) expect(applied).toEqual(saved)

    await pg.admin.unsafe(migration())
    expect(await catalog()).toEqual(applied)
    await pg.admin.unsafe(BEFORE_026)
    expect(await catalog()).toEqual(before)
  })

  it('one membership with no billing frequency, inside the wait: the old function fails and refreshes nobody; with 026 it runs, that membership is not Herd, and everyone else is refreshed', async () => {
    const db = pg.connect()
    const plan = await fixtures.plan(db)
    const today = "(now() AT TIME ZONE 'Europe/London')::date"
    const member = async (billing: string | null, startedSql: string, isHerd: boolean, override: boolean | null = null): Promise<string> => {
      const customer = await fixtures.customer(db)
      const rows = await pg.admin.unsafe<{ id: string }[]>(
        `INSERT INTO customer_memberships (customer_id, plan_id, start_date, subscription_status, billing_frequency, is_herd, herd_override)
         VALUES ('${customer}', '${plan}', ${startedSql}, 'active', ${billing === null ? 'NULL' : `'${billing}'`}, ${String(isHerd)}, ${override === null ? 'NULL' : String(override)}) RETURNING id`
      )
      return rows[0]?.id as string
    }
    // Each flag starts wrong, so the refresh has to decide it.
    const odd = await member(null, `${today} - 7`, true)
    const sixMonths = await member('monthly', `(${today} - interval '6 months')::date`, false)
    const dayShort = await member('monthly', `(${today} - interval '6 months')::date + 1`, true)
    const yearly = await member('yearly', `${today} - 7`, false)
    const noFrequencyOld = await member(null, `(${today} - interval '2 years')::date`, false)
    const overridden = await member(null, `${today} - 7`, true, true)
    const all = [odd, sixMonths, dayShort, yearly, noFrequencyOld, overridden]
    const asLeft = [true, false, true, false, false, true]

    await pg.admin.unsafe(BEFORE_026)
    expect(await refresh()).toBe('null value in column "is_herd" of relation "customer_memberships" violates not-null constraint')
    expect(await flags(all)).toEqual(asLeft)

    await pg.admin.unsafe(migration())
    expect(await refresh()).toBe('ran: 5')
    expect(await flags(all)).toEqual([false, true, false, true, true, true])
    // Nothing left to change on the next run.
    expect(await refresh()).toBe('ran: 0')

    // Without the odd row the old function and the new one decide every membership the same way.
    await pg.admin.unsafe(`DELETE FROM customer_memberships WHERE id = '${odd}'`)
    const rest = all.filter((id) => id !== odd)
    const byNew = await flags(rest)
    await pg.admin.unsafe(`UPDATE customer_memberships SET is_herd = NOT is_herd WHERE id IN (${rest.map((id) => `'${id}'`).join(', ')}) AND herd_override IS NULL`)
    await pg.admin.unsafe(BEFORE_026)
    expect(await refresh()).toBe('ran: 4')
    expect(await flags(rest)).toEqual(byNew)
  })
})
