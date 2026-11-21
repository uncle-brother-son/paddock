import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { down033, leadSql033, LEFT_PLAIN_033, migration033, MONEY_COLUMNS_033, NEW_CHECKS_033 } from './migration-033'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W53 item 8 (the W35 audit's row 4; G-plan lead call L7): migration 033 is written but NOT applied to live; the
// lead applies it after W53's review, before the Worker push. The saved schema (live-catalog.json, live-schema.sql)
// carries it already, each object as Postgres 17.6 prints it, so that every test runs against the schema live will
// have. This file holds the two to each other on real Postgres (the saved schema with 033 taken back out, then 033
// applied, is the saved schema again, to the last character of the catalogue) and holds what 033 does: the fourteen
// columns to the penny, the one it leaves, the eight checks, the stop (with nothing changed) on any row that wouldn't
// fit, the lead's pre-check and after-checks as the file gives them, and its Down. Once the lead has applied 033 and
// refreshed the snapshot from live, this still passes, and stays as the migration's own test.

const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')

interface Catalog {
  tables: Array<{ name: string; columns: Array<{ name: string; type: string; notNull: boolean; default: string | null }> }>
  constraints: Array<{ table: string; name: string; definition: string }>
  [key: string]: unknown
}

const UUID = '10000000-0000-4000-8000-0000000000aa'

/**
 * One row in each table 033 touches, written as the tables' owner with foreign keys and triggers off (only the row's
 * own columns matter here). `figure` is the column a test gives a value that wouldn't fit; every other figure is
 * pounds and pence within its line.
 */
const ROW: Readonly<Record<string, (figures: Readonly<Record<string, string>>) => string>> = {
  addon_order_lines: (f) =>
    `INSERT INTO public.addon_order_lines (booking_id, addon_id, quantity, price_at_purchase, sku_at_purchase, refunded_amount, card_refunded_amount)
     VALUES ('${UUID}', '${UUID}', 2, 5.00, 'TOWEL', ${f['refunded_amount'] ?? '4.00'}, ${f['card_refunded_amount'] ?? '3.00'})`,
  event_attendees: (f) =>
    `INSERT INTO public.event_attendees (event_booking_id, attendee_type, name, unit_price, price_level, cancelled_value, refunded_amount, card_refunded_amount)
     VALUES ('${UUID}', 'guest', 'W53 Guest', 40.00, 'public', ${f['cancelled_value'] ?? '40.00'}, ${f['refunded_amount'] ?? '40.00'}, ${f['card_refunded_amount'] ?? '25.00'})`,
  membership_payment_date_changes: (f) =>
    `INSERT INTO public.membership_payment_date_changes (membership_id, old_renewal_date, new_renewal_date, extra_days, amount_charged)
     VALUES ('${UUID}', '2026-11-01', '2026-11-05', 4, ${f['amount_charged'] ?? '5.20'})`,
  membership_plans: (f) => `INSERT INTO public.membership_plans (name, price_monthly, price_yearly) VALUES ('W53 plan', ${f['price_monthly'] ?? '40.00'}, ${f['price_yearly'] ?? '400.00'})`,
  order_line_items: (f) =>
    `INSERT INTO public.order_line_items (order_id, item_type, quantity, unit_price, line_total, card_refunded_amount, discount_amount, system_unit_price)
     VALUES ('${UUID}', 'postage', 1, 10.00, 10.00, ${f['card_refunded_amount'] ?? '0.00'}, ${f['discount_amount'] ?? '1.00'}, ${f['system_unit_price'] ?? '10.00'})`,
  pending_reader_payments: (f) => `INSERT INTO public.pending_reader_payments (flow, record_id, expected_amount) VALUES ('move', '${UUID}', ${f['expected_amount'] ?? '5.00'})`,
  promo_code_redemptions: (f) => `INSERT INTO public.promo_code_redemptions (promo_code_id, order_id, discount_amount) VALUES ('${UUID}', '${UUID}', ${f['discount_amount'] ?? '2.00'})`,
  promo_codes: (f) => `INSERT INTO public.promo_codes (code, discount_type, discount_value, min_spend) VALUES ('W53CODE', 'percentage', 12.345, ${f['min_spend'] ?? '20.00'})`,
}
const TABLES_033 = Object.keys(ROW)

describe('migration 033 (brief W53 item 8): every money column that was plain numeric is numeric(10,2) with a check, and the file stops, changing nothing, on a row that would not fit', () => {
  let pg: RealPostgres
  let saved: Catalog
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const typeOf = (from: Catalog, table: string, column: string): string | undefined => from.tables.find((one) => one.name === table)?.columns.find((one) => one.name === column)?.type
  const types = async (): Promise<string[]> => {
    const now = await catalog()
    return MONEY_COLUMNS_033.map(([table, column]) => `${table}.${column} ${String(typeOf(now, table, column))}`)
  }
  const newChecks = async (): Promise<string[]> => {
    const names = new Set(NEW_CHECKS_033.map(([, name]) => name))
    return (await catalog()).constraints.filter((one) => names.has(one.name)).map((one) => one.name).sort()
  }
  const carries = (from: Catalog): boolean => typeOf(from, 'order_line_items', 'discount_amount') === 'numeric(10,2)'
  const apply = async (): Promise<void> => void (await pg.admin.unsafe(migration033()))
  const takeOut = async (): Promise<void> => void (await pg.admin.unsafe(down033()))
  /** Rows written as the owner with foreign keys and triggers off, as one statement block. */
  const seed = async (sql: string): Promise<void> => void (await pg.admin.unsafe(`SET session_replication_role = replica; ${sql}; SET session_replication_role = DEFAULT;`))
  const clear = async (): Promise<void> => seed(TABLES_033.map((table) => `DELETE FROM public.${table}`).join('; '))
  const one = async <T>(sql: string): Promise<T | undefined> => (await pg.admin.unsafe<T[]>(sql))[0]

  beforeAll(async () => {
    pg = await startRealPostgres()
    // How the saved schema was given 033 (brief W53; as W27 did for 023 and W51 for 032): with W53_CATALOG_OUT set,
    // the file is applied to this throwaway Postgres 17.6 if the saved schema doesn't have it, and the catalogue is
    // written to that path for `npm run schema:test -- --from <path>`. Never run against live.
    if (process.env.W53_CATALOG_OUT) {
      if (!carries(await catalog())) await apply()
      writeFileSync(process.env.W53_CATALOG_OUT, JSON.stringify([{ catalog: await catalog() }]))
    }
    saved = await catalog()
  }, 120_000)
  afterAll(() => pg.stop())

  /** Before each test: the tables empty, and the schema as it is before 033 (the file's own Down). */
  beforeEach(async () => {
    await clear()
    await takeOut()
  })

  it('the file says it is not applied by W53, names the fourteen columns and the one it leaves, and makes its checks of the rows before it touches a table', () => {
    const sql = migration033()
    expect(sql).toContain('NOT APPLIED by W53')
    // Only what isn't a comment is the migration itself.
    const body = sql
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
    for (const [table, column] of MONEY_COLUMNS_033) {
      const alter = new RegExp(`ALTER TABLE public\\.${table}\\b[^;]*ALTER COLUMN ${column} TYPE numeric\\(10,2\\)`)
      expect(body, `${table}.${column}`).toMatch(alter)
    }
    expect((body.match(/TYPE numeric\(10,2\)/g) ?? []).length).toBe(14)
    // The percentage column is never altered, and the header says why.
    expect(body).not.toMatch(/discount_value/)
    expect(sql).toMatch(/promo_codes\.discount_value is pounds for a fixed code and a PERCENTAGE for a percentage code/)
    // The stop comes before the first ALTER, and raises.
    const stop = body.indexOf("RAISE EXCEPTION 'Migration 033 stopped and changed nothing:%'")
    expect(stop).toBeGreaterThan(0)
    expect(stop).toBeLessThan(body.indexOf('ALTER TABLE'))
    for (const [, name] of NEW_CHECKS_033) expect(body, name).toContain(`ADD CONSTRAINT ${name} CHECK`)
    expect(NEW_CHECKS_033).toHaveLength(8)
  })

  it('the saved schema carries 033: the fourteen columns are numeric(10,2), discount_value is still plain numeric, and the eight checks are there', () => {
    expect(carries(saved)).toBe(true)
    for (const [table, column] of MONEY_COLUMNS_033) expect(typeOf(saved, table, column), `${table}.${column}`).toBe('numeric(10,2)')
    expect(typeOf(saved, LEFT_PLAIN_033[0], LEFT_PLAIN_033[1])).toBe('numeric')
    const names = saved.constraints.map((one) => one.name)
    for (const [table, name] of NEW_CHECKS_033) {
      expect(names, name).toContain(name)
      expect(saved.constraints.find((one) => one.name === name)?.table).toBe(table)
    }
  })

  it('taken back out (the file\'s Down) every one of the fourteen is plain numeric again with none of the eight checks; applied, the catalogue is the saved schema again to the last character; applied twice, the same', async () => {
    expect(await types()).toEqual(MONEY_COLUMNS_033.map(([table, column]) => `${table}.${column} numeric`))
    expect(await newChecks()).toEqual([])
    await apply()
    expect(await types()).toEqual(MONEY_COLUMNS_033.map(([table, column]) => `${table}.${column} numeric(10,2)`))
    expect(await newChecks()).toEqual(NEW_CHECKS_033.map(([, name]) => name).sort())
    expect(await catalog()).toEqual(saved)
    await apply()
    expect(await catalog()).toEqual(saved)
  })

  it('rows that are pounds and pence, each within its line, go through: every figure is kept exactly, and the percentage keeps its three decimal places', async () => {
    await seed(TABLES_033.map((table) => ROW[table]?.({}) ?? '').join('; '))
    await apply()
    expect(await one("SELECT refunded_amount::text AS refunded, card_refunded_amount::text AS card FROM public.addon_order_lines")).toEqual({ refunded: '4.00', card: '3.00' })
    expect(await one('SELECT cancelled_value::text AS v, refunded_amount::text AS r, card_refunded_amount::text AS c FROM public.event_attendees')).toEqual({ v: '40.00', r: '40.00', c: '25.00' })
    expect(await one('SELECT amount_charged::text AS a FROM public.membership_payment_date_changes')).toEqual({ a: '5.20' })
    expect(await one('SELECT price_monthly::text AS m, price_yearly::text AS y FROM public.membership_plans')).toEqual({ m: '40.00', y: '400.00' })
    expect(await one('SELECT card_refunded_amount::text AS c, discount_amount::text AS d, system_unit_price::text AS s FROM public.order_line_items')).toEqual({ c: '0.00', d: '1.00', s: '10.00' })
    expect(await one('SELECT expected_amount::text AS e FROM public.pending_reader_payments')).toEqual({ e: '5.00' })
    expect(await one('SELECT discount_amount::text AS d FROM public.promo_code_redemptions')).toEqual({ d: '2.00' })
    // A percentage is not money: 033 leaves it exactly as it was.
    expect(await one('SELECT min_spend::text AS m, discount_value::text AS v FROM public.promo_codes')).toEqual({ m: '20.00', v: '12.345' })
  })

  describe('a row that would not fit stops the file, with the column named, and nothing at all is changed', () => {
    /** After a stop: every column still plain numeric, none of the new checks, and the row's figure exactly as it was. */
    const nothingChanged = async (table: string, column: string, figure: string) => {
      expect(await types()).toEqual(MONEY_COLUMNS_033.map(([t, c]) => `${t}.${c} numeric`))
      expect(await newChecks()).toEqual([])
      expect(await one(`SELECT ${column}::text AS figure FROM public.${table}`)).toEqual({ figure })
    }

    it.each(MONEY_COLUMNS_033.map(([table, column]) => [`${table}.${column}`, table, column] as const))('%s holding a figure with three decimal places', async (name, table, column) => {
      // A figure ALTER ... TYPE numeric(10,2) would round without a word. (0.005 keeps within every line.)
      await seed(ROW[table]?.({ [column]: '0.005' }) ?? '')
      await expect(apply()).rejects.toThrow(new RegExp(`Migration 033 stopped and changed nothing:.* ${name.replace('.', '\\.')} has 1 row\\(s\\) that are not pounds and pence`))
      await nothingChanged(table, column, '0.005')
    })

    it('a figure too large for numeric(10,2)', async () => {
      await seed(ROW['pending_reader_payments']?.({ expected_amount: '100000000' }) ?? '')
      await expect(apply()).rejects.toThrow(/Migration 033 stopped and changed nothing:.* pending_reader_payments\.expected_amount has 1 row\(s\) that are not pounds and pence/)
      await nothingChanged('pending_reader_payments', 'expected_amount', '100000000')
    })

    it.each([
      ['an add-on line refunded more than it cost', 'addon_order_lines', { refunded_amount: '10.01', card_refunded_amount: '0.00' }, 'refunded_amount', '10.01', /addon_order_lines has 1 row\(s\) refunded more than the line cost/],
      ['an add-on line with more back to the card than was refunded', 'addon_order_lines', { refunded_amount: '3.00', card_refunded_amount: '3.01' }, 'card_refunded_amount', '3.01', /addon_order_lines has 1 row\(s\) with more back to the card than was refunded/],
      ['a plan priced below 0', 'membership_plans', { price_monthly: '-1.00' }, 'price_monthly', '-1.00', /membership_plans has 1 row\(s\) with a price below 0/],
      ['an order line with a figure below 0', 'order_line_items', { card_refunded_amount: '-0.01' }, 'card_refunded_amount', '-0.01', /order_line_items has 1 row\(s\) with a figure below 0/],
      ['an order line with a discount larger than the line', 'order_line_items', { discount_amount: '10.01' }, 'discount_amount', '10.01', /order_line_items has 1 row\(s\) with a discount larger than the line/],
      ['a pending payment below 0', 'pending_reader_payments', { expected_amount: '-5.00' }, 'expected_amount', '-5.00', /pending_reader_payments has 1 row\(s\) with an amount below 0/],
    ] as const)('%s (a row that would fail a new check)', async (_what, table, figures, column, figure, words) => {
      await seed(ROW[table]?.(figures) ?? '')
      await expect(apply()).rejects.toThrow(words)
      await nothingChanged(table, column, figure)
    })

    it('two rows that would not fit are both named in the one refusal', async () => {
      await seed(`${ROW['membership_plans']?.({ price_yearly: '399.999' }) ?? ''}; ${ROW['promo_codes']?.({ min_spend: '19.995' }) ?? ''}`)
      await expect(apply()).rejects.toThrow(/membership_plans\.price_yearly has 1 row\(s\).* promo_codes\.min_spend has 1 row\(s\)/)
      await nothingChanged('promo_codes', 'min_spend', '19.995')
    })
  })

  describe('once applied', () => {
    beforeEach(apply)

    it('each of the eight checks refuses what it is for, by name', async () => {
      await seed(TABLES_033.map((table) => ROW[table]?.({}) ?? '').join('; '))
      const refused = async (sql: string, check: string) => expect(pg.admin.unsafe(sql), check).rejects.toThrow(new RegExp(check))
      await refused('UPDATE public.addon_order_lines SET refunded_amount = 10.01', 'addon_order_lines_refunded_within_line_check')
      await refused('UPDATE public.addon_order_lines SET card_refunded_amount = 4.01', 'addon_order_lines_card_within_refunded_check')
      await refused('UPDATE public.membership_plans SET price_monthly = -0.01', 'membership_plans_price_monthly_check')
      await refused('UPDATE public.membership_plans SET price_yearly = -0.01', 'membership_plans_price_yearly_check')
      await refused('UPDATE public.order_line_items SET card_refunded_amount = -0.01', 'order_line_items_card_refunded_amount_check')
      await refused('UPDATE public.order_line_items SET discount_amount = 10.01', 'order_line_items_discount_amount_check')
      await refused('UPDATE public.order_line_items SET discount_amount = -0.01', 'order_line_items_discount_amount_check')
      await refused('UPDATE public.order_line_items SET system_unit_price = -0.01', 'order_line_items_system_unit_price_check')
      await refused('UPDATE public.pending_reader_payments SET expected_amount = -0.01', 'pending_reader_payments_expected_amount_check')
      // What each allows: the whole line back, all of it to the card, a price of nothing, no system price, the whole line discounted.
      await pg.admin.unsafe('UPDATE public.addon_order_lines SET refunded_amount = 10.00, card_refunded_amount = 10.00')
      await pg.admin.unsafe('UPDATE public.membership_plans SET price_monthly = 0, price_yearly = NULL')
      await pg.admin.unsafe('UPDATE public.order_line_items SET discount_amount = 10.00, system_unit_price = NULL')
      await pg.admin.unsafe('UPDATE public.pending_reader_payments SET expected_amount = 0')
    })

    it("not checked against its line, on purpose: an order line's card money back may be more than the line (W47 review L6), and a place's figures are held only at 0 or more", async () => {
      await seed(`${ROW['order_line_items']?.({}) ?? ''}; ${ROW['event_attendees']?.({}) ?? ''}`)
      await pg.admin.unsafe('UPDATE public.order_line_items SET card_refunded_amount = 24.00')
      await pg.admin.unsafe('UPDATE public.event_attendees SET refunded_amount = 40.01, card_refunded_amount = 40.01, cancelled_value = 40.01')
      await expect(pg.admin.unsafe('UPDATE public.event_attendees SET refunded_amount = -0.01')).rejects.toThrow(/event_attendees_refunded_amount_check/)
    })

    it('a figure written with more than two decimal places is held to the penny by the column itself', async () => {
      await seed(ROW['order_line_items']?.({}) ?? '')
      await pg.admin.unsafe('UPDATE public.order_line_items SET discount_amount = 1.005, system_unit_price = 9.994')
      expect(await one('SELECT discount_amount::text AS d, system_unit_price::text AS s FROM public.order_line_items')).toEqual({ d: '1.01', s: '9.99' })
    })

    it("the lead's after-checks, as the file gives them: A the fifteen types, B the one plain numeric column left, C the eight checks valid", async () => {
      const [a, b, c] = leadSql033('-- AFTER APPLYING', '-- Then refresh')
      expect([a, b, c].every((sql) => typeof sql === 'string' && /^SELECT/.test(sql))).toBe(true)
      const typesNow = await pg.admin.unsafe<Array<{ table_name: string; column_name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null }>>(a as string)
      expect(typesNow).toHaveLength(15)
      const left = typesNow.filter((row) => row.numeric_precision === null)
      expect(left.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([LEFT_PLAIN_033.join('.')])
      expect(typesNow.filter((row) => row.numeric_precision !== null).every((row) => row.data_type === 'numeric' && row.numeric_precision === 10 && row.numeric_scale === 2)).toBe(true)
      const plain = await pg.admin.unsafe<Array<{ table_name: string; column_name: string }>>(b as string)
      expect(plain.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([LEFT_PLAIN_033.join('.')])
      const checks = await pg.admin.unsafe<Array<{ conname: string; convalidated: boolean }>>(c as string)
      expect(checks.map((row) => row.conname)).toEqual(NEW_CHECKS_033.map(([, name]) => name).sort())
      expect(checks.every((row) => row.convalidated === true)).toBe(true)
    })

    it("the file's Down puts every column back to plain numeric and takes the eight checks off, keeping every figure", async () => {
      await seed(TABLES_033.map((table) => ROW[table]?.({}) ?? '').join('; '))
      await takeOut()
      expect(await types()).toEqual(MONEY_COLUMNS_033.map(([table, column]) => `${table}.${column} numeric`))
      expect(await newChecks()).toEqual([])
      expect(await one('SELECT refunded_amount::text AS refunded, card_refunded_amount::text AS card FROM public.addon_order_lines')).toEqual({ refunded: '4.00', card: '3.00' })
      expect(await one('SELECT price_monthly::text AS m FROM public.membership_plans')).toEqual({ m: '40.00' })
    })
  })

  describe("the lead's pre-check, as the file gives it (read-only)", () => {
    const preCheck = () => leadSql033('-- PRE-CHECK', '-- 1. Stop')

    it('is two statements that only read, and answers all zeros on rows that fit', async () => {
      const statements = preCheck()
      expect(statements).toHaveLength(2)
      expect(statements.every((sql) => /^SELECT/.test(sql) && !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(sql))).toBe(true)
      await seed(TABLES_033.map((table) => ROW[table]?.({}) ?? '').join('; '))
      const rows = await pg.admin.unsafe<Array<{ tbl: string; bad_decimals: string; bad_refunded_over_line: string; bad_card_over_refunded: string }>>(statements[0] as string)
      expect(rows.map((row) => row.tbl)).toEqual(TABLES_033)
      expect(rows.every((row) => Number(row.bad_decimals) === 0 && Number(row.bad_refunded_over_line) === 0 && Number(row.bad_card_over_refunded) === 0)).toBe(true)
      expect(Number((await pg.admin.unsafe<Array<{ too_large: string }>>(statements[1] as string))[0]?.too_large)).toBe(0)
    })

    it('counts every row the file would stop on: three decimal places in each of the fourteen columns, each check a row would fail, a figure too large', async () => {
      const [fit, large] = preCheck() as [string, string]
      const counted = async () => {
        const rows = await pg.admin.unsafe<Array<{ tbl: string; bad_decimals: string; bad_refunded_over_line: string; bad_card_over_refunded: string }>>(fit)
        return Object.fromEntries(rows.map((row) => [row.tbl, [Number(row.bad_decimals), Number(row.bad_refunded_over_line), Number(row.bad_card_over_refunded)]]))
      }
      for (const [table, column] of MONEY_COLUMNS_033) {
        await clear()
        await seed(ROW[table]?.({ [column]: '0.005' }) ?? '')
        expect((await counted())[table]?.[0], `${table}.${column}`).toBe(1)
      }
      const fails: ReadonlyArray<readonly [string, Record<string, string>, number]> = [
        ['addon_order_lines', { refunded_amount: '10.01', card_refunded_amount: '0.00' }, 1],
        ['addon_order_lines', { refunded_amount: '3.00', card_refunded_amount: '3.01' }, 2],
        ['membership_plans', { price_yearly: '-1.00' }, 1],
        ['order_line_items', { system_unit_price: '-1.00' }, 1],
        ['order_line_items', { discount_amount: '10.01' }, 2],
        ['pending_reader_payments', { expected_amount: '-1.00' }, 1],
      ]
      for (const [table, figures, column] of fails) {
        await clear()
        await seed(ROW[table]?.(figures) ?? '')
        expect((await counted())[table]?.[column], `${table} ${JSON.stringify(figures)}`).toBe(1)
      }
      await clear()
      await seed(ROW['membership_plans']?.({ price_yearly: '100000000' }) ?? '')
      expect(Number((await pg.admin.unsafe<Array<{ too_large: string }>>(large))[0]?.too_large)).toBe(1)
    })
  })
})
