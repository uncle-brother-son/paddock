import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W27 item 4 (E-plan 4.2, 4.5, 4.6; lead call L1): migration 023 is written but NOT applied to live; the lead
// applies it after W27's review. The saved schema (live-catalog.json, live-schema.sql) was given its four changes by
// hand, each as Postgres 17.6 prints it, so that every test already runs against the schema live will have. This file
// holds the two to each other on real Postgres: the saved schema with 023 taken back out, then 023 applied, must be
// the saved schema again, to the last character of the catalog. Once the lead has applied 023 and refreshed the
// snapshot from live (testing/README.md), this still passes, and stays as the migration's own test.

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/023_orders_refund_owed_and_cash_refunds.sql')
const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')

/** 023's "Down", as the migration file gives it. */
const DOWN = `
  DROP INDEX IF EXISTS public.audit_log_refund_claims_idx;
  ALTER TABLE public.event_attendees DROP CONSTRAINT event_attendees_refund_method_check;
  ALTER TABLE public.event_attendees ADD CONSTRAINT event_attendees_refund_method_check CHECK (refund_method = ANY (ARRAY['card'::text, 'credit'::text, 'none'::text]));
  ALTER TABLE public.order_line_items DROP CONSTRAINT order_line_items_refund_method_check;
  ALTER TABLE public.order_line_items ADD CONSTRAINT order_line_items_refund_method_check CHECK (refund_method = ANY (ARRAY['card'::text, 'credit'::text]));
  ALTER TABLE public.orders DROP CONSTRAINT orders_refund_owed_amount_check;
  ALTER TABLE public.orders DROP COLUMN refund_owed_amount;
`

interface Catalog {
  tables: Array<{ name: string; columns: Array<{ name: string; type: string; notNull: boolean; default: string | null }> }>
  constraints: Array<{ table: string; name: string; definition: string }>
  indexes: Array<{ name: string; definition: string }>
}

describe('migration 023 (brief W27 item 4): money owed on an order, cash refunds, the claims index', () => {
  let pg: RealPostgres
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const column = (from: Catalog, table: string, name: string) => from.tables.find((t) => t.name === table)?.columns.find((c) => c.name === name)
  const constraint = (from: Catalog, name: string) => from.constraints.find((k) => k.name === name)?.definition
  const refused = async (sql: string): Promise<string> => {
    await pg.admin.unsafe('BEGIN')
    try {
      await pg.admin.unsafe(sql)
      return 'accepted'
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    } finally {
      await pg.admin.unsafe('ROLLBACK')
    }
  }

  beforeAll(async () => {
    pg = await startRealPostgres()
  }, 120_000)
  afterAll(() => pg.stop())

  it('the file exists, says it is not applied by W27, and never names CONCURRENTLY as a statement', () => {
    const sql = readFileSync(MIGRATION, 'utf8')
    expect(sql).toContain('NOT APPLIED by W27')
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(statements).not.toMatch(/CONCURRENTLY/i)
    expect(statements).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE)\b/i)
  })

  it('the saved schema with 023 taken out and applied again is the saved schema, exactly; applying it twice changes nothing', async () => {
    const saved = await catalog()
    await pg.admin.unsafe(DOWN)
    const without = await catalog()
    // Taken out for real: live's schema today (after 022).
    expect(column(without, 'orders', 'refund_owed_amount')).toBeUndefined()
    expect(constraint(without, 'orders_refund_owed_amount_check')).toBeUndefined()
    expect(constraint(without, 'order_line_items_refund_method_check')).toBe("CHECK ((refund_method = ANY (ARRAY['card'::text, 'credit'::text])))")
    expect(constraint(without, 'event_attendees_refund_method_check')).toBe("CHECK ((refund_method = ANY (ARRAY['card'::text, 'credit'::text, 'none'::text])))")
    expect(without.indexes.some((index) => index.name === 'audit_log_refund_claims_idx')).toBe(false)

    const migration = readFileSync(MIGRATION, 'utf8')
    await pg.admin.unsafe(migration)
    const applied = await catalog()
    expect(applied).toEqual(saved)
    await pg.admin.unsafe(migration)
    expect(await catalog()).toEqual(saved)
  })

  it('what it makes: the column (numeric(10,2), NOT NULL, default 0, never negative), cash on both checks, the partial index', async () => {
    const now = await catalog()
    expect(column(now, 'orders', 'refund_owed_amount')).toMatchObject({ type: 'numeric(10,2)', notNull: true, default: '0' })
    expect(column(now, 'bookings', 'refund_owed_amount')).toMatchObject({ type: 'numeric(10,2)', notNull: true, default: '0' })
    expect(constraint(now, 'orders_refund_owed_amount_check')).toBe('CHECK ((refund_owed_amount >= (0)::numeric))')
    expect(constraint(now, 'order_line_items_refund_method_check')).toBe("CHECK ((refund_method = ANY (ARRAY['card'::text, 'credit'::text, 'cash'::text])))")
    expect(constraint(now, 'event_attendees_refund_method_check')).toBe("CHECK ((refund_method = ANY (ARRAY['card'::text, 'credit'::text, 'none'::text, 'cash'::text])))")
    expect(now.indexes.find((index) => index.name === 'audit_log_refund_claims_idx')?.definition).toBe(
      "CREATE INDEX audit_log_refund_claims_idx ON public.audit_log USING btree (action, at) WHERE (action = ANY (ARRAY['booking.refund_claimed'::text, 'order.refund_claimed'::text, 'event_booking.refund_claimed'::text]))"
    )
  })

  it('the checks hold: an order can never owe less than £0, and a refund method outside the list is refused', async () => {
    const customer = "INSERT INTO customers (id, first_name, last_name, email, date_of_birth) VALUES ('20000000-0000-4000-8000-000000000001', 'Ada', 'Test', 'ada@example.com', '1990-01-01');"
    const order = (owed: string) =>
      `${customer} INSERT INTO orders (customer_id, order_total, payment_status, refund_owed_amount) VALUES ('20000000-0000-4000-8000-000000000001', 10, 'paid', ${owed});`
    expect(await refused(order('5'))).toBe('accepted')
    expect(await refused(order('-0.01'))).toMatch(/orders_refund_owed_amount_check/)
    const line = (method: string) =>
      `${customer} INSERT INTO orders (id, customer_id, order_total, payment_status) VALUES ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 10, 'paid');
       INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, refund_method) VALUES ('20000000-0000-4000-8000-000000000002', 'postage', 1, 10, 10, '${method}');`
    expect(await refused(line('cash'))).toBe('accepted')
    expect(await refused(line('credit'))).toBe('accepted')
    expect(await refused(line('cheque'))).toMatch(/order_line_items_refund_method_check/)
  })

  it("the due list's read can use the index: its WHERE implies the index's", async () => {
    // Postgres uses a partial index only when the query's WHERE implies the index's. With the planner told not to scan
    // the table, the claims' read by action must come out as an index scan on it, for each of the three actions.
    await pg.admin.unsafe('BEGIN')
    try {
      await pg.admin.unsafe('SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off')
      for (const action of ['booking.refund_claimed', 'order.refund_claimed', 'event_booking.refund_claimed']) {
        const plan = await pg.admin.unsafe(`EXPLAIN SELECT id FROM audit_log c WHERE c.action = '${action}' AND c.at < now() - make_interval(mins => 15) ORDER BY c.at, c.id`)
        expect(plan.map((row) => String(row['QUERY PLAN'])).join('\n'), action).toContain('audit_log_refund_claims_idx')
      }
      // And not for an action outside it.
      const other = await pg.admin.unsafe("EXPLAIN SELECT id FROM audit_log c WHERE c.action = 'booking.refund_finished'")
      expect(other.map((row) => String(row['QUERY PLAN'])).join('\n')).not.toContain('audit_log_refund_claims_idx')
    } finally {
      await pg.admin.unsafe('ROLLBACK')
    }
  })
})
