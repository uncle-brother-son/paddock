import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Brief W70a (the W70 audit's S2): under a frozen clock (the replay's), rows written back to back share their `at`, so a
// test reading `audit_log ORDER BY at` got them in whatever order the query's plan gave. Migration 034's index changed
// that order for rows of two entities, and one test that took the last row failed about one run in three. `id` is no
// tie-break (ids are random). So every test's read breaks the tie by `ctid`, the order the rows were written in (nothing
// vacuums a test database), or by something the rows say; and a test that means one row finds it by what it is on and
// what it says, never by its place.

const WEB = path.resolve(__dirname, '../../..')
const SKIPPED: ReadonlySet<string> = new Set(['node_modules', '.next', '.open-next', '.git', 'recordings'])

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return SKIPPED.has(name) ? [] : testFiles(full)
    return name.endsWith('.test.ts') || (full.includes(`${path.sep}testing${path.sep}`) && name.endsWith('.ts')) ? [path.relative(WEB, full).split(path.sep).join('/')] : []
  })
}

/** Each audit read `ORDER BY at` in `text` whose ties nothing breaks (an `id` breaks them at random). */
const loose = (text: string): string[] =>
  text.split('\n').filter((line) => line.includes('audit_log') && /ORDER BY at\b/.test(line) && !/ORDER BY at(?:, ctid\b| DESC, ctid DESC\b|, CASE |, \()/.test(line))

/** Word for word the app's own statements, read by a test (each with a LIMIT 1 of its own, or pinned as text). */
const THE_APPS_OWN: readonly string[] = ['server/rules/refunds/pipeline.test.ts', 'server/rules/testing/audit-order.test.ts']

describe("the tests' audit reads never leave a tie to the plan (W70a, S2)", () => {
  it('every one breaks it', () => {
    const files = ['app', 'lib', 'server'].flatMap((dir) => testFiles(path.join(WEB, dir)))
    expect(files.length).toBeGreaterThan(150)
    const found = files.filter((file) => !THE_APPS_OWN.includes(file)).flatMap((file) => loose(readFileSync(path.join(WEB, file), 'utf8')).map((line) => `${file}: ${line.trim().slice(0, 160)}`))
    expect(found).toEqual([])
  })

  it('the check sees a loose one', () => {
    const read = (order: string) => `const rows = db.query('SELECT details FROM audit_log WHERE action = $1 ${order}', [action])`
    for (const order of ['ORDER BY at', 'ORDER BY at DESC LIMIT 1', 'ORDER BY at, id', 'ORDER BY at DESC, id DESC']) expect(loose(read(order)), order).toHaveLength(1)
    for (const order of ['ORDER BY at, ctid', 'ORDER BY at DESC, ctid DESC LIMIT 1', "ORDER BY at, (details->>'state' = 'left') DESC", 'ORDER BY at, CASE details']) expect(loose(read(order)), order).toEqual([])
  })
})
