import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

/*
 * W64 (H-plan 3.3 step 1, brief item 1; item 6's proof for W65). Two rules, read from every source file in the Worker:
 *
 * 1. Nothing outside `testing/replay/` and the five frozen folders can reach the old code: no import of `oldSide` or the
 *    other old-side names, no module of a frozen folder, `replay/harness.ts` (the old side; what runs a scenario is
 *    `sweep/run.ts`), a replay `*-side.ts` (each falls back to the old side; what presses the Worker is `sweep/`),
 *    `replay/legacy-routes.ts` or the golden files, and no path that names a frozen folder or the golden files. The
 *    old code's own guards are the one exception, named below: they go with it (W65).
 * 2. For each group W65 would delete, nothing W65 keeps reaches it, by import or by a path it reads. That is the proof
 *    beside each group in the W64 report's list, for Wayne's yes folder by folder.
 *
 * "Reach" is read with the TypeScript parser, comments ignored: every module a file names (import, export from,
 * import(), vi.mock, vi.doMock, vi.importActual, require), resolved to its file, and every string that names a frozen
 * folder or `replay/golden`.
 */

const WORKER = path.resolve(__dirname, '../../..')
const TESTING = 'server/rules/testing/'
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler', 'public', '.vercel', '.turbo'])
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs)$/
const rel = (file: string): string => path.relative(WORKER, file).split(path.sep).join('/')

function sourceFiles(dir: string = WORKER): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full))
    else if (SOURCE.test(name) && !name.endsWith('.d.ts')) found.push(full)
  }
  return found
}

/**
 * The five frozen folders. Their names are put together here, so no string in this file names one: the frozen copies'
 * own guards (frozen-*-code.test.ts, removed-order-code.test.ts) list every file whose strings do, and this one only
 * looks for them.
 */
const OLD_PREFIX = ['legacy', ''].join('-')
const FROZEN = ['order', 'booking', 'refund', 'account', 'admin'].map((name) => `${OLD_PREFIX}${name}`)
const [ORDER_COPY = '', , , , ADMIN_COPY = ''] = FROZEN
/** A string that names a frozen folder or the golden files: a path a file reads. */
const NAMES_OLD_FOLDER = new RegExp(`(^|[/'"\\s])(${FROZEN.join('|')})(/|$)|replay/golden`)
/** The names that mean the old side, or a frozen folder by its path. */
const OLD_NAMES: ReadonlySet<string> = new Set([
  'oldSide',
  'oldFunctionPath',
  'backendDir',
  'legacyOrderDir',
  'legacyBookingDir',
  'legacyRefundDir',
  'legacyAccountDir',
  'legacyAdminDir',
  'LEGACY_ORDER_ACTIONS',
  'LEGACY_BOOKING_ACTIONS',
  'LEGACY_REFUND_ACTIONS',
  'LEGACY_ACCOUNT_ACTIONS',
  'LEGACY_ADMIN_ACTIONS',
  'readGolden',
  'writeGolden',
  'bindLegacyRoutes',
])

export interface Reach {
  /** Every module named, resolved to a file of the Worker (relative, `/`), or as written when it isn't one. */
  modules: string[]
  /** Every name imported by name. */
  names: string[]
  /** Every string that names a frozen folder or the golden files. */
  paths: string[]
}

function resolveModule(from: string, spec: string): string {
  const base = spec.startsWith('@/') ? path.join(WORKER, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null
  if (!base) return spec
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return rel(candidate)
  }
  // A folder (a frozen copy's root, say) or a file that isn't there: as a path, so a reach into a folder still shows.
  return rel(base)
}

/** What `file` reaches, from `source` (its own text unless a test plants another). */
export function reachOf(file: string, source: string = readFileSync(file, 'utf8')): Reach {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const modules: string[] = []
  const names: string[] = []
  const paths: string[] = []
  const named = (node: ts.Node | undefined) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) modules.push(resolveModule(file, node.text))
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      named(node.moduleSpecifier)
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const one of clause.namedBindings.elements) names.push((one.propertyName ?? one.name).text)
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) for (const one of node.exportClause.elements) names.push((one.propertyName ?? one.name).text)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree)
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ['require', 'vi.mock', 'vi.doMock', 'vi.importActual', 'vi.unmock'].includes(callee)) named(node.arguments[0])
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      named(node.argument.literal)
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && NAMES_OLD_FOLDER.test(node.text)) paths.push(node.text)
    if (ts.isTemplateExpression(node)) {
      const text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('')
      if (NAMES_OLD_FOLDER.test(text)) paths.push(text)
    }
    node.forEachChild(visit)
  }
  visit(tree)
  return { modules, names, paths }
}

// --- Rule 1: the old code, and who may reach it until W65

const inFrozenFolder = (file: string): boolean => FROZEN.some((folder) => file.startsWith(`${TESTING}${folder}/`))
const inReplay = (file: string): boolean => file.startsWith(`${TESTING}replay/`)
/** The modules that are the old side, or hold it. */
const isOldSide = (module: string): boolean =>
  inFrozenFolder(module) ||
  FROZEN.some((folder) => module === `${TESTING}${folder}`) ||
  module.startsWith(`${TESTING}replay/golden`) ||
  module === `${TESTING}replay/harness.ts` ||
  module === `${TESTING}replay/legacy-routes.ts` ||
  /^server\/rules\/testing\/replay\/[a-z-]+-side\.ts$/.test(module)

/**
 * The old code's own guards: they read the frozen copies to hold them frozen, or hold the Worker's words to the old
 * functions'. Each goes with the copies at W65 (its group in W65_GROUPS below).
 */
export const OLD_CODE_GUARDS: readonly string[] = [
  `${TESTING}frozen-account-code.test.ts`,
  `${TESTING}frozen-admin-code.test.ts`,
  `${TESTING}frozen-booking-code.test.ts`,
  `${TESTING}frozen-refund-code.test.ts`,
  `${TESTING}removed-account-code.test.ts`,
  `${TESTING}removed-admin-code.test.ts`,
  `${TESTING}removed-booking-code.test.ts`,
  `${TESTING}removed-refund-code.test.ts`,
  'server/removed-order-code.test.ts',
  `${TESTING}frozen-words.ts`,
]

/**
 * W64, LEFT (briefs/W64-report.md, item 1): the tests that held the Worker's words to the old functions' text, read
 * from the frozen copies with the parser. W64a item 7: all nine now read the old words pinned in testing/old-words.json
 * (recorded once from the copies by replay/old-words.test.ts, which W65 deletes with them), and the staff app helpers'
 * tests of the old staff checks moved to replay/old-staff-guards.test.ts. The list is empty: nothing W65 keeps reads the
 * old code.
 */
export const WORDS_HELD_TO_THE_OLD_CODE: readonly string[] = []

/** Rule 1's findings for one file: what it reaches of the old code. */
export function oldCodeReached(file: string, reach: Reach): string[] {
  return [
    ...reach.modules.filter(isOldSide).map((module) => `${file} imports ${module}`),
    ...reach.names.filter((name) => OLD_NAMES.has(name)).map((name) => `${file} imports ${name}`),
    ...reach.paths.map((text) => `${file} names ${JSON.stringify(text)}`),
  ]
}

// --- Rule 2: what W65 deletes, group by group

/** The replay files W65 keeps: the scenarios, the comparison, the fake's binding and the W05 invariants, which the sweep uses. */
export const REPLAY_KEPT: readonly string[] = ['scenarios.ts', 'w48-scenarios.ts', 'compare.ts', 'stripe-binding.ts', 'invariants.ts'].map((name) => `${TESTING}replay/${name}`)

export const W65_GROUPS: ReadonlyArray<{ name: string; holds: (file: string) => boolean }> = [
  ...FROZEN.map((folder) => ({ name: `${TESTING}${folder}/`, holds: (file: string) => file.startsWith(`${TESTING}${folder}/`) })),
  { name: `${TESTING}replay/golden/`, holds: (file: string) => file.startsWith(`${TESTING}replay/golden/`) },
  {
    name: `${TESTING}replay/ (the old side, the parity tests, the differences, the old-side sweeps; all but REPLAY_KEPT)`,
    holds: (file: string) => inReplay(file) && !file.startsWith(`${TESTING}replay/golden/`) && !REPLAY_KEPT.includes(file),
  },
  { name: 'the old code\'s own guards (OLD_CODE_GUARDS)', holds: (file: string) => OLD_CODE_GUARDS.includes(file) },
]

/**
 * Files that name the old folders without reaching them: this test (it names what it looks for), and ESLint's config,
 * whose ignore list names the five frozen folders (W65 takes those lines out with the folders).
 */
export const NAMES_ONLY: readonly string[] = [`${TESTING}old-code-reach.test.ts`, 'eslint.config.mjs']

/** What W65 keeps that still reaches a group it deletes: the words tests W64 left (above), until they are a pinned list. */
const stillReaching = (file: string): boolean => WORDS_HELD_TO_THE_OLD_CODE.includes(file) || NAMES_ONLY.includes(file)

const goes = (file: string): boolean => W65_GROUPS.some((group) => group.holds(file))

// Every source file of the Worker is parsed: under a full run's load that takes longer than the default 5 seconds.
vi.setConfig({ testTimeout: 120_000 })

describe('nothing reaches the old code but the replay and the old code\'s own guards (W64 step 1)', () => {
  const files = sourceFiles().map((file) => ({ file, name: rel(file) }))

  it('rule 1: no file outside testing/replay/, the frozen folders and the old code\'s guards imports the old side, a frozen folder, legacy-routes.ts or the golden files', () => {
    const found = files
      .filter(({ name }) => !inReplay(name) && !inFrozenFolder(name) && !OLD_CODE_GUARDS.includes(name) && !WORDS_HELD_TO_THE_OLD_CODE.includes(name) && !NAMES_ONLY.includes(name))
      .flatMap(({ file, name }) => oldCodeReached(name, reachOf(file)))
    expect(found).toEqual([])
  })

  it("ESLint's config names the frozen folders only in its ignore list", () => {
    const config = readFileSync(path.join(WORKER, 'eslint.config.mjs'), 'utf8')
    const named = config.split('\n').filter((line) => NAMES_OLD_FOLDER.test(line) && !line.trim().startsWith('//'))
    expect(named.map((line) => line.trim())).toEqual(FROZEN.map((folder) => `"server/rules/testing/${folder}/**",`))
  })

  it('W64 left: the words tests named still read the old code, and only them (each one done comes off the list)', () => {
    for (const name of WORDS_HELD_TO_THE_OLD_CODE) expect(oldCodeReached(name, reachOf(path.join(WORKER, name))).length, name).toBeGreaterThan(0)
  })

  it('W64a item 7: the list ends empty, and the nine words tests that were on it read only the pinned words', () => {
    expect(WORDS_HELD_TO_THE_OLD_CODE).toEqual([])
    const nine = [
      'server/rules/admin/words.test.ts',
      'server/rules/bookings/failure-messages.test.ts',
      'server/rules/customers/failure-messages.test.ts',
      'server/rules/events/failure-messages.test.ts',
      'server/rules/gift-cards/failure-messages.test.ts',
      'server/rules/memberships/failure-messages.test.ts',
      'server/rules/memberships/payment-date-status.test.ts',
      'server/rules/refunds/failure-messages.test.ts',
      'server/staff-app-helpers.test.ts',
    ]
    for (const name of nine) {
      const reach = reachOf(path.join(WORKER, name))
      expect(oldCodeReached(name, reach), name).toEqual([])
      expect(reach.modules.some((module) => module.endsWith(`${TESTING}old-words.ts`)), name).toBe(true)
      expect(reach.modules.some((module) => module.endsWith('frozen-words.ts')), name).toBe(false)
    }
  })

  it('the guards named are each a real file, and each reaches the old code (a guard that no longer does is no longer one)', () => {
    for (const guard of OLD_CODE_GUARDS) {
      const file = path.join(WORKER, guard)
      expect(existsSync(file), guard).toBe(true)
      if (guard.endsWith('frozen-words.ts')) continue
      expect(oldCodeReached(guard, reachOf(file)).length, guard).toBeGreaterThan(0)
    }
  })

  it.each(W65_GROUPS.map((group) => group.name))('rule 2: nothing W65 keeps reaches %s', (groupName) => {
    const group = W65_GROUPS.find((one) => one.name === groupName) as (typeof W65_GROUPS)[number]
    // The golden files are JSON, which the source walk leaves out.
    const held = groupName.includes('golden') ? readdirSync(path.join(WORKER, TESTING, 'replay/golden')).length : files.filter(({ name }) => group.holds(name)).length
    expect(held, `${groupName} holds no file`).toBeGreaterThan(0)
    const folders = FROZEN.filter((folder) => groupName === `${TESTING}${folder}/`)
    const reachers = files
      .filter(({ name }) => !goes(name) && !stillReaching(name))
      .flatMap(({ file, name }) => {
        const reach = reachOf(file)
        const byModule = reach.modules.filter((module) => group.holds(module) || folders.some((folder) => module === `${TESTING}${folder}`)).map((module) => `${name} imports ${module}`)
        const byPath = reach.paths.filter((text) => folders.some((folder) => text.includes(folder)) || (groupName.includes('golden') && text.includes('replay/golden'))).map((text) => `${name} names ${JSON.stringify(text)}`)
        return [...byModule, ...byPath]
      })
    expect(reachers).toEqual([])
  })

  it('the check catches a rule test that sets up through the old side, or reads a frozen folder, and passes a comment', () => {
    const planted = (text: string) => oldCodeReached('planted', reachOf(path.join(WORKER, 'server/rules/bookings/planted.test.ts'), text))
    expect(planted("import { oldSide, replay } from '@/server/rules/testing/replay/harness'\n")).toEqual([
      'planted imports server/rules/testing/replay/harness.ts',
      'planted imports oldSide',
    ])
    expect(planted("import { newBookingSide } from '@/server/rules/testing/replay/booking-side'\n")).toEqual(['planted imports server/rules/testing/replay/booking-side.ts'])
    expect(planted(`const dir = path.join(__dirname, '../testing/${ADMIN_COPY}/backend/paddock')\n`)).toEqual([`planted names "../testing/${ADMIN_COPY}/backend/paddock"`])
    expect(planted(`const old = await import('../testing/${ORDER_COPY}/backend/paddock/createOrder')\n`)).toEqual([
      `planted imports server/rules/testing/${ORDER_COPY}/backend/paddock/createOrder.ts`,
      `planted names "../testing/${ORDER_COPY}/backend/paddock/createOrder"`,
    ])
    expect(planted(`// sets up as ${ORDER_COPY}/ and replay/harness's oldSide once did\nimport { workerSide } from '@/server/rules/testing/sweep/worker'\n`)).toEqual([])
  })
})
