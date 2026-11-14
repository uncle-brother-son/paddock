import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Brief W27a item 3 (W27 review L6). The rules of an order's and an event booking's claim (one card part at most, on
// the claim's own order; the sums; the order's lock before the look for an open claim) are kept in the two writers of
// refunds/claims.ts. pipeline.ts exports `writeClaimRow`, which writes a claim's row with none of them, so a later
// slice calling `writeClaimRow(tx, ORDER_CLAIMS, …)` itself would skip them all. This is a text search, as W16's
// removal test (server/removed-order-code.test.ts): no app file outside refunds/claims.ts may pass ORDER_CLAIMS or
// EVENT_BOOKING_CLAIMS to writeClaimRow. Test files may (the race test's control does, to show what goes wrong).

const workerDir = path.resolve(__dirname, '../../..')
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])
const TESTING_DIR = path.join(workerDir, 'server/rules/testing')
/** The one file that may: it holds the two writers. */
const CLAIMS_FILE = path.join(workerDir, 'server/rules/refunds/claims.ts')
/** Where writeClaimRow and the subjects are defined, so it names them all without calling it. */
const PIPELINE_FILE = path.join(workerDir, 'server/rules/refunds/pipeline.ts')

function sourceFiles(root: string, dirs: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith('.d.ts')) found.push(full)
    }
  }
  for (const dir of dirs) walk(path.join(root, dir))
  return found
}

/** The code without its comments, so a comment naming the rule doesn't count. */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

const isTest = (file: string): boolean => /\.test\.(ts|tsx)$/.test(file) || file.startsWith(TESTING_DIR + path.sep)

/** The Worker's app code: everything that can run in the Worker, tests and the test tree left out. */
const appFiles = sourceFiles(workerDir, ['app', 'server', 'lib', 'contracts', 'scripts', 'components', 'features'])
  .concat(['custom-worker.ts', 'middleware.ts'].map((file) => path.join(workerDir, file)).filter((file) => existsSync(file)))
  .filter((file) => !isTest(file))

const STEP_E_SUBJECT = /\b(ORDER_CLAIMS|EVENT_BOOKING_CLAIMS)\b/
const NAMES_WRITER = /\bwriteClaimRow\b/

/** The text between the brackets of each `writeClaimRow(…)` call in the code (also `writeClaimRow<Details>(…)`); not its own definition. */
function writeClaimRowCalls(code: string): string[] {
  const calls: string[] = []
  for (const match of code.matchAll(/(?<!\bfunction\s+)\bwriteClaimRow\s*(?:<[^()]*>)?\s*\(/g)) {
    const start = (match.index ?? 0) + match[0].length
    let depth = 1
    let end = start
    while (end < code.length && depth > 0) {
      if (code[end] === '(') depth += 1
      if (code[end] === ')') depth -= 1
      end += 1
    }
    calls.push(code.slice(start, end - 1))
  }
  return calls
}

/**
 * Why this code breaks the rule, or null. Two ways to pass a step E subject to writeClaimRow: in the call itself, or
 * under another name (`const on = ORDER_CLAIMS`), which a file can only do if it names both. `definesThem` is
 * pipeline.ts, which names all three because it defines them: only its calls are read.
 */
function breach(code: string, definesThem = false): string | null {
  const direct = writeClaimRowCalls(code).find((args) => STEP_E_SUBJECT.test(args))
  if (direct !== undefined) return `calls writeClaimRow(${direct.replace(/\s+/g, ' ').trim().slice(0, 80)})`
  if (!definesThem && NAMES_WRITER.test(code) && STEP_E_SUBJECT.test(code)) return `names writeClaimRow and ${STEP_E_SUBJECT.exec(code)?.[1]}`
  return null
}

const shown = (file: string) => path.relative(workerDir, file).split(path.sep).join('/')
const read = (file: string) => withoutComments(readFileSync(file, 'utf8'))

describe("W27a: an order's or an event booking's claim is only ever written by refunds/claims.ts", () => {
  it('no app file outside refunds/claims.ts passes ORDER_CLAIMS or EVENT_BOOKING_CLAIMS to writeClaimRow', () => {
    const breaches = appFiles
      .filter((file) => file !== CLAIMS_FILE)
      .map((file) => ({ file: shown(file), why: breach(read(file), file === PIPELINE_FILE) }))
      .filter(({ why }) => why !== null)
    expect(breaches).toEqual([])
  })

  it('refunds/claims.ts is where they are written: one call for each subject, which this search finds', () => {
    const calls = writeClaimRowCalls(read(CLAIMS_FILE))
    expect(calls.map((args) => STEP_E_SUBJECT.exec(args)?.[1]).sort()).toEqual(['EVENT_BOOKING_CLAIMS', 'ORDER_CLAIMS'])
    expect(breach(read(CLAIMS_FILE))).toMatch(/^calls writeClaimRow\(tx, ORDER_CLAIMS, orderId/)
  })

  it("today's other users are found and are clean: pipeline.ts defines it and never calls it; bookings/refunds.ts calls it for a booking only", () => {
    const users = appFiles.filter((file) => NAMES_WRITER.test(read(file))).map(shown).sort()
    expect(users).toEqual(['server/rules/bookings/refunds.ts', 'server/rules/refunds/claims.ts', 'server/rules/refunds/pipeline.ts'])
    expect(writeClaimRowCalls(read(PIPELINE_FILE))).toEqual([])
    const booking = writeClaimRowCalls(read(path.join(workerDir, 'server/rules/bookings/refunds.ts')))
    expect(booking).toHaveLength(1)
    expect(booking[0]).toMatch(/^tx, BOOKING_CLAIMS,/)
  })

  it('the search itself would catch one (each way of doing it is found; what is allowed is not)', () => {
    expect(breach('const row = await writeClaimRow(tx, ORDER_CLAIMS, orderId, details, by)')).toContain('calls writeClaimRow(tx, ORDER_CLAIMS')
    expect(breach('await writeClaimRow<EventBookingClaimDetails>(\n  tx,\n  EVENT_BOOKING_CLAIMS,\n  id,\n  details,\n  by\n)')).toContain('EVENT_BOOKING_CLAIMS')
    expect(breach('await pipeline.writeClaimRow(tx, pipeline.ORDER_CLAIMS, orderId, details, by)')).toContain('ORDER_CLAIMS')
    expect(breach('await writeClaimRow(tx, pick(kind, (k) => (k ? ORDER_CLAIMS : BOOKING_CLAIMS)), id, details, by)')).toContain('ORDER_CLAIMS')
    // Under another name.
    expect(breach('const on = ORDER_CLAIMS\nawait writeClaimRow(tx, on, orderId, details, by)')).toBe('names writeClaimRow and ORDER_CLAIMS')
    expect(breach("import { EVENT_BOOKING_CLAIMS, writeClaimRow } from './pipeline'")).toBe('names writeClaimRow and EVENT_BOOKING_CLAIMS')
    // In the file that defines them, only a call counts.
    expect(breach("export const ORDER_CLAIMS = subject('order')\nexport async function writeClaimRow<Details>(tx: Tx, on: ClaimSubject) {}", true)).toBeNull()
    expect(breach("export const ORDER_CLAIMS = subject('order')\nconst unchecked = (tx: Tx) => writeClaimRow(tx, ORDER_CLAIMS, id, details, by)", true)).toContain('calls writeClaimRow(tx, ORDER_CLAIMS')
    // Allowed: a booking's claim; the subjects used for anything else; a comment.
    expect(breach('const row = await writeClaimRow(tx, BOOKING_CLAIMS, bookingId, details, options)')).toBeNull()
    expect(breach('const row = await readClaimRow<OrderClaimDetails>(db, ORDER_CLAIMS, claimId)\nexport const DUE = claimsDueSql(EVENT_BOOKING_CLAIMS)')).toBeNull()
    expect(breach(withoutComments('// never writeClaimRow(tx, ORDER_CLAIMS, …) here\nconst a = 1'))).toBeNull()
    // A test file isn't app code.
    expect(isTest(path.join(workerDir, 'server/rules/refunds/claims-postgres.test.ts'))).toBe(true)
    expect(isTest(path.join(workerDir, 'server/rules/testing/replay/harness.ts'))).toBe(true)
    expect(isTest(CLAIMS_FILE)).toBe(false)
  })

  it('scans the app code (a wrong folder would pass with nothing to scan)', () => {
    expect(appFiles.length).toBeGreaterThan(150)
    expect(appFiles).toContain(CLAIMS_FILE)
    expect(appFiles).toContain(PIPELINE_FILE)
    expect(appFiles.some((file) => isTest(file))).toBe(false)
  })
})
