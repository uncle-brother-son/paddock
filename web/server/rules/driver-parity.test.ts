import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SqlParam } from '@/server/db'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import retoolJsonbValues from '@/server/rules/testing/retool-driver-jsonb-values.json'
import retoolOrderValues from '@/server/rules/testing/retool-driver-orders-values.json'
import retoolValues from '@/server/rules/testing/retool-driver-values.json'

// The two drivers compared for real. retool-driver-values.json was recorded from the staff app's
// live Retool resource on 4 Nov 2026; here the same query runs through the Worker's driver, and
// every column must come back with the same value in the same JavaScript type.

const probe = readFileSync(path.join(__dirname, 'testing/retool-driver-probe.sql'), 'utf8')
const columns = Object.entries(retoolValues)

describe("the Worker's driver gives what Retool's gives", () => {
  let t: TestDatabase
  let row: Record<string, unknown>

  beforeAll(async () => {
    t = await startTestDatabase()
    const rows = await t.db.query<Record<string, unknown>>(probe)
    row = rows[0] as Record<string, unknown>
  })

  afterAll(() => t.stop())

  it('has the same columns', () => {
    expect(Object.keys(row).sort()).toEqual(Object.keys(retoolValues).sort())
  })

  it.each(columns)('%s', (column, expected) => {
    expect(row[column]).toStrictEqual(expected)
  })
})

// The same check for what the order code reads and binds (W04). Each difference between the two
// drivers is listed below rather than left out, so a port can't meet it by surprise.
describe('the same for the order code', () => {
  const ordersProbe = readFileSync(path.join(__dirname, 'testing/retool-driver-orders-probe.sql'), 'utf8')
  const UUID = '00000000-0000-4000-8000-000000000001'
  let t: TestDatabase
  let row: Record<string, unknown>

  const one = async (sql: string, params: SqlParam[]) => (await t.db.query<{ v: unknown }>(sql, params))[0]

  beforeAll(async () => {
    t = await startTestDatabase()
    const rows = await t.db.query<Record<string, unknown>>(ordersProbe)
    row = rows[0] as Record<string, unknown>
  })

  afterAll(() => t.stop())

  // A numeric[] comes back as text here and as numbers from Retool. No table has one, so only a
  // query that builds one can meet this.
  const DIFFERENT = ['numeric_array']
  const same = Object.entries(retoolOrderValues.reads).filter(([column]) => !DIFFERENT.includes(column))

  it.each(same)('reads %s the same', (column, expected) => {
    expect(row[column]).toStrictEqual(expected)
  })

  it('reads numeric[] as text, where Retool gives numbers', () => {
    expect(retoolOrderValues.reads.numeric_array).toStrictEqual([1.5])
    expect(row['numeric_array']).toStrictEqual(['1.50'])
  })

  it.each([
    ['uuid[]', 'SELECT $1::uuid[] AS v', [[UUID]], retoolOrderValues.params.uuid_array],
    ['an empty array', 'SELECT $1::uuid[] AS v', [[]], retoolOrderValues.params.empty_array],
    ['text[]', 'SELECT $1::text[] AS v', [['a', 'b,c']], retoolOrderValues.params.text_array],
    ['a number into numeric', 'SELECT $1::numeric AS v', [12.5], retoolOrderValues.params.number_to_numeric],
    ['null into jsonb', 'SELECT $1::jsonb AS v', [null], retoolOrderValues.params.null_jsonb],
    ['a Date', 'SELECT $1::timestamptz AS v', [new Date('2026-11-04T10:00:00Z')], retoolOrderValues.params.date_param],
    ['an object into jsonb', 'SELECT jsonb_typeof($1::jsonb) AS v', [{ a: 1 }], retoolOrderValues.params.object_to_jsonb],
  ] as Array<[string, string, SqlParam[], unknown]>)('binds %s the same', async (_, sql, params, expected) => {
    expect(await one(sql, params)).toStrictEqual(expected)
  })

  it('keeps float noise in both, so money must be rounded before it is bound', async () => {
    expect(await one('SELECT $1::numeric AS v', [0.1 + 0.2])).toStrictEqual(retoolOrderValues.params.float_noise)
  })

  it('refuses undefined, where Retool binds null: a port needs `?? null`', async () => {
    await expect(t.db.query('SELECT $1::text AS v', [undefined as unknown as SqlParam])).rejects.toThrow('UNDEFINED_VALUE')
  })
})

// What a value bound to `::jsonb` becomes. retool-driver-jsonb-values.json is each input with what
// the real Retool resource did with it. The old code passes JSON.stringify(x) (createOrder for
// shipping_address and reader_payment, pendingReaderFlows for its snapshot), so that string must
// store an object here too, or reader_payment->>'method' would read null with no error.
describe('values bound to jsonb', () => {
  interface Recorded {
    name: string
    value: unknown
    type?: string | null
    stored?: unknown
    refused?: string
  }
  const STORE = 'SELECT jsonb_typeof(x) AS t, x AS v FROM (SELECT $1::jsonb AS x) s'
  const cases = retoolJsonbValues as Recorded[]
  let t: TestDatabase

  const bind = async (value: unknown) => (await t.db.query<{ t: string | null; v: unknown }>(STORE, [value as SqlParam]))[0]

  beforeAll(async () => {
    t = await startTestDatabase()
  })

  afterAll(() => t.stop())

  // Each difference from Retool, with what this driver does instead. Retool sends a JS array as a
  // Postgres array literal: `{1,2}` isn't JSON, so it refuses, and `{}` is an empty object. Here an
  // array stays an array, which parity_log's diff relies on, and nothing in the old code binds one.
  const ARRAYS: Record<string, unknown> = {
    array_of_numbers: [1, 2],
    array_of_strings: ['a', 'b'],
    array_of_objects: [{ a: 1 }, { b: 2 }],
    empty_array: [],
  }
  // postgres.js sends a boolean as a boolean, and Postgres has no cast from that to jsonb. A port
  // must bind JSON.stringify(x) for a value that could be one, as recordParity does.
  const REFUSED_HERE = ['array_of_booleans', 'boolean']

  const refused = cases.filter((c) => c.refused !== undefined && !(c.name in ARRAYS) && !REFUSED_HERE.includes(c.name))
  const stored = cases.filter((c) => c.refused === undefined && !(c.name in ARRAYS) && !REFUSED_HERE.includes(c.name))

  it.each(stored.map((c) => [c.name, c] as const))('stores %s as Retool does', async (_, c) => {
    expect(await bind(c.value)).toStrictEqual({ t: c.type, v: c.stored })
  })

  it.each(refused.map((c) => [c.name, c] as const))('refuses %s as Retool does', async (_, c) => {
    await expect(bind(c.value)).rejects.toThrow(c.refused)
  })

  it('keeps an object and its JSON.stringify string the same', async () => {
    const value = { method: 'card', lines: [{ amount: 12.5, note: null }], nested: { deep: { ok: true } } }
    expect(await bind(value)).toStrictEqual({ t: 'object', v: value })
    expect(await bind(JSON.stringify(value))).toStrictEqual({ t: 'object', v: value })
  })

  it.each(Object.entries(ARRAYS))('stores %s as an array, where Retool does not', async (name, expected) => {
    const retool = cases.find((c) => c.name === name)
    expect(retool?.type).not.toBe('array')
    expect(await bind(retool?.value)).toStrictEqual({ t: 'array', v: expected })
  })

  it.each(REFUSED_HERE)('refuses %s, where Retool does not always', async (name) => {
    await expect(bind(cases.find((c) => c.name === name)?.value)).rejects.toThrow('cannot cast type boolean to jsonb')
  })

  it('stores a JSON.stringify string of those two', async () => {
    expect(await bind(JSON.stringify([true, false]))).toStrictEqual({ t: 'array', v: [true, false] })
    expect(await bind(JSON.stringify(true))).toStrictEqual({ t: 'boolean', v: true })
  })

  it('treats json the same as jsonb', async () => {
    const json = async (value: SqlParam) => (await t.db.query<{ v: unknown }>('SELECT $1::json AS v', [value]))[0]?.v
    expect(await json({ a: 1 })).toStrictEqual({ a: 1 })
    expect(await json(JSON.stringify({ a: 1 }))).toStrictEqual({ a: 1 })
  })

  it('reads a jsonb string back as a string, so nothing is parsed twice', async () => {
    expect(await bind(JSON.stringify(JSON.stringify({ a: 1 })))).toStrictEqual({ t: 'string', v: '{"a":1}' })
  })
})
