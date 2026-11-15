import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W33 item 3 (Wayne's Q43; W30 report "Noticed" 1): migration 024 is written but NOT applied to live; the lead
// applies it after W33's review, before the W33 Worker is pushed. The saved schema (live-catalog.json,
// live-schema.sql) was given its one changed line by hand, so every test already runs against the function live will
// have. This file holds the two to each other on real Postgres 17.6, as migration-023.test.ts does for 023: the saved
// schema with 024 taken back out, then 024 applied, must be the saved schema again, to the last character. Once the
// lead has applied 024 and refreshed the snapshot from live (testing/README.md), this still passes, and stays as the
// migration's own test.

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/024_event_cancellation_quote_no_cutoff_uses_start.sql')
const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')

const NEW_LINE = "    'before_cutoff', COALESCE(v_now_london < (COALESCE(b.refund_cutoff_at, b.starts_at) AT TIME ZONE 'UTC'), true),"
const OLD_LINE = "    'before_cutoff', b.refund_cutoff_at IS NOT NULL AND v_now_london < (b.refund_cutoff_at AT TIME ZONE 'UTC'),"

interface Catalog {
  functions: Array<{ name: string; identity: string; definition: string }>
}

const EVENT = '24000000-0000-4000-8000-000000000001'
const CUSTOMER = '24000000-0000-4000-8000-000000000002'
const BOOKING = '24000000-0000-4000-8000-000000000003'

describe('migration 024 (brief W33 item 3): event_cancellation_quote answers before_cutoff by Q43', () => {
  let pg: RealPostgres
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const definition = (from: Catalog): string => from.functions.find((fn) => fn.name === 'event_cancellation_quote')?.definition ?? ''
  const statements = (sql: string): string =>
    sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')

  /** The function's answer for one confirmed booking on an event with this cut-off and start (hours from now; null: none). */
  const beforeCutoff = async (cutoffHours: number | null, startHours: number | null): Promise<{ before_cutoff: unknown; event_started: unknown }> => {
    // The event's times are London wall-clock digits labelled UTC, as live stores them.
    const at = (hours: number | null) => (hours === null ? 'NULL' : `((now() AT TIME ZONE 'Europe/London') + interval '${hours} hours') AT TIME ZONE 'UTC'`)
    await pg.admin.unsafe('BEGIN')
    try {
      await pg.admin.unsafe(`
        SET LOCAL session_replication_role = replica;
        INSERT INTO customers (id, first_name, last_name, email, date_of_birth) VALUES ('${CUSTOMER}', 'Ada', 'Test', 'ada-024@example.com', '1990-01-01');
        INSERT INTO events (id, name, starts_at, refund_cutoff_at) VALUES ('${EVENT}', 'Solstice', ${at(startHours)}, ${at(cutoffHours)});
        INSERT INTO event_bookings (id, event_id, customer_id, places, status) VALUES ('${BOOKING}', '${EVENT}', '${CUSTOMER}', 1, 'confirmed');
        INSERT INTO event_attendees (event_booking_id, attendee_type, name, price_level, unit_price) VALUES ('${BOOKING}', 'account_holder', 'Ada Test', 'public', 40);
      `)
      const row = (await pg.admin.unsafe(`SELECT public.event_cancellation_quote('${BOOKING}'::uuid, NULL::uuid[]) AS quote`))[0]
      const quote = (typeof row?.['quote'] === 'string' ? JSON.parse(row['quote'] as string) : row?.['quote']) as { ok: boolean; before_cutoff: unknown; event_started: unknown }
      expect(quote.ok).toBe(true)
      return { before_cutoff: quote.before_cutoff, event_started: quote.event_started }
    } finally {
      await pg.admin.unsafe('ROLLBACK')
    }
  }

  beforeAll(async () => {
    pg = await startRealPostgres()
  }, 120_000)
  afterAll(() => pg.stop())

  it('the file exists, says it is not applied by W33, is one CREATE OR REPLACE FUNCTION and writes no row', () => {
    const sql = readFileSync(MIGRATION, 'utf8')
    expect(sql).toContain('NOT APPLIED by W33')
    const body = statements(sql)
    expect(body.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1)
    expect(body).toContain('public.event_cancellation_quote(p_event_booking_id uuid, p_attendee_ids uuid[] DEFAULT NULL::uuid[])')
    expect(body).toContain(NEW_LINE)
    expect(body).not.toContain(OLD_LINE)
    expect(body).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|INSERT|ALTER|DROP|GRANT|REVOKE)\b/i)
  })

  it('the saved schema with 024 taken out and applied again is the saved schema, exactly; applying it twice changes nothing', async () => {
    const saved = await catalog()
    const migration = readFileSync(MIGRATION, 'utf8')
    expect(definition(saved)).toContain(NEW_LINE)
    // 024's "Down", as the migration file gives it: the one line put back.
    const down = statements(migration).replace(NEW_LINE, OLD_LINE)
    expect(down).toContain(OLD_LINE)
    await pg.admin.unsafe(down)
    const without = await catalog()
    // Taken out for real: live's function today.
    expect(definition(without)).toContain(OLD_LINE)
    expect(definition(without)).not.toContain(NEW_LINE)
    expect(definition(without)).toBe(definition(saved).replace(NEW_LINE, OLD_LINE))
    expect((await beforeCutoff(null, 24 * 21)).before_cutoff).toBe(false)

    await pg.admin.unsafe(migration)
    expect(await catalog()).toEqual(saved)
    await pg.admin.unsafe(migration)
    expect(await catalog()).toEqual(saved)
  })

  it('Q43: with no cut-off the start is the cut-off; with one it is the cut-off; with neither it counts as before', async () => {
    // No cut-off: before the start, and not once it has started.
    expect(await beforeCutoff(null, 24 * 21)).toEqual({ before_cutoff: true, event_started: false })
    expect(await beforeCutoff(null, 1)).toEqual({ before_cutoff: true, event_started: false })
    expect(await beforeCutoff(null, -1)).toEqual({ before_cutoff: false, event_started: true })
    // A cut-off: it decides (unchanged by 024). It can never be after the start (events_cutoff_before_start), so a
    // started event is always past its cut-off.
    expect(await beforeCutoff(48, 24 * 21)).toEqual({ before_cutoff: true, event_started: false })
    expect(await beforeCutoff(-1, 24 * 21)).toEqual({ before_cutoff: false, event_started: false })
    expect(await beforeCutoff(-48, -1)).toEqual({ before_cutoff: false, event_started: true })
    // Neither a cut-off nor a start: before (the brief's "a null start counting as before").
    expect(await beforeCutoff(null, null)).toEqual({ before_cutoff: true, event_started: false })
  })

  it('nothing else of the function changed: its signature, STABLE, and every other line', async () => {
    const now = definition(await catalog())
    expect(now).toContain('RETURNS jsonb')
    expect(now).toContain('STABLE')
    expect(now.split('\n').filter((line) => line.includes('before_cutoff'))).toEqual([NEW_LINE])
  })
})
