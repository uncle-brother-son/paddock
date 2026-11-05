import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
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
