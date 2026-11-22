import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

/*
 * W64 (H-plan 3.3 step 1) and W65. W65 deleted the old code: the five frozen folders, the golden files, the replay
 * files the sweep doesn't use, and the old code's own guards. Two rules stay, read from every source file in the Worker:
 *
 * 1. Nothing reaches what W65 deleted: no import of a deleted module (a module that isn't there is matched with or
 *    without its extension), no import of an old-side name, and no string that names a frozen folder or the golden files.
 * 2. Each group W65 deleted is gone, and nothing reaches it.
 *
 * "Reach" is read with the TypeScript parser, comments ignored: every module a file names (import, export from,
 * import(), vi.mock, vi.doMock, vi.importActual, require), resolved to its file, and every string that names a frozen
 * folder or `replay/golden`. The compiler refuses an import of a deleted file too; this also catches a path a test
 * reads (path.join to a frozen folder) and an import vitest alone would only fail at run time.
 */

const WORKER = path.resolve(__dirname, '../../..')
const TESTING = 'server/rules/testing/'
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler', 'public', '.vercel', '.turbo'])
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs)$/
const rel = (file: string): string => path.relative(WORKER, file).split(path.sep).join('/')
/** A module as it is named, with or without its extension (a deleted one resolves without it). */
const base = (module: string): string => module.replace(/\.(ts|tsx|mts|cts|js|mjs)$/, '')

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

/** The five frozen folders. Their names are put together here, so no string in this file names one. */
const OLD_PREFIX = ['legacy', ''].join('-')
const FROZEN = ['order', 'booking', 'refund', 'account', 'admin'].map((name) => `${OLD_PREFIX}${name}`)
const [ORDER_COPY = '', , , , ADMIN_COPY = ''] = FROZEN
/** A string that names a frozen folder or the golden files: a path a file reads. */
const NAMES_OLD_FOLDER = new RegExp(`(^|[/'"\\s])(${FROZEN.join('|')})(/|$)|replay/golden`)
/** The names that meant the old side, or a frozen folder by its path (replay/harness.ts's, which W65 deleted). */
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
  const start = spec.startsWith('@/') ? path.join(WORKER, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null
  if (!start) return spec
  for (const candidate of [start, `${start}.ts`, `${start}.tsx`, `${start}.js`, path.join(start, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return rel(candidate)
  }
  // A folder (a frozen copy's root, say) or a file that isn't there: as a path, so a reach into a folder still shows.
  return rel(start)
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

// --- What W65 deleted, group by group

/** The replay files W65 kept: the scenarios, the comparison, the fake's binding and the W05 invariants, which the sweep uses. */
export const REPLAY_KEPT: readonly string[] = ['scenarios.ts', 'w48-scenarios.ts', 'compare.ts', 'stripe-binding.ts', 'invariants.ts'].map((name) => `${TESTING}replay/${name}`)

/** The old code's own guards: they read the frozen copies to hold them frozen, or held the Worker's words to the old functions'. */
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

const inReplay = (module: string): boolean => module.startsWith(`${TESTING}replay/`)
const isGolden = (module: string): boolean => module.startsWith(`${TESTING}replay/golden`)

/** Each group W65 deleted: what it held (a module, with or without its extension), and the folder it was, if one. */
export const W65_GROUPS: ReadonlyArray<{ name: string; holds: (module: string) => boolean; folder?: string }> = [
  ...FROZEN.map((folder) => ({
    name: `${TESTING}${folder}/`,
    holds: (module: string) => module.startsWith(`${TESTING}${folder}/`) || module === `${TESTING}${folder}`,
    folder: `${TESTING}${folder}`,
  })),
  { name: `${TESTING}replay/golden/`, holds: isGolden, folder: `${TESTING}replay/golden` },
  {
    name: `${TESTING}replay/ (the old side, the parity tests, the differences, the old-side sweeps; all but REPLAY_KEPT)`,
    holds: (module: string) => inReplay(module) && !isGolden(module) && !REPLAY_KEPT.map(base).includes(base(module)),
  },
  { name: "the old code's own guards (OLD_CODE_GUARDS)", holds: (module: string) => OLD_CODE_GUARDS.map(base).includes(base(module)) },
]

/** Whether `module` is something W65 deleted. */
const deleted = (module: string): boolean => W65_GROUPS.some((group) => group.holds(module))

/** Rule 1's findings for one file: what it reaches of the deleted code. */
export function oldCodeReached(file: string, reach: Reach): string[] {
  return [
    ...reach.modules.filter(deleted).map((module) => `${file} imports ${module}`),
    ...reach.names.filter((name) => OLD_NAMES.has(name)).map((name) => `${file} imports ${name}`),
    ...reach.paths.map((text) => `${file} names ${JSON.stringify(text)}`),
  ]
}

/** The one file that names the old folders without reaching them: this test (it names what it looks for). */
export const NAMES_ONLY: readonly string[] = [`${TESTING}old-code-reach.test.ts`]

// Every source file of the Worker is parsed: under a full run's load that takes longer than the default 5 seconds.
vi.setConfig({ testTimeout: 120_000 })

describe('nothing reaches the old code W65 deleted (W64 step 1; W65)', () => {
  const files = sourceFiles().map((file) => ({ file, name: rel(file) }))

  it('rule 1: no file imports a deleted module or an old-side name, or names a frozen folder or the golden files', () => {
    const found = files.filter(({ name }) => !NAMES_ONLY.includes(name)).flatMap(({ file, name }) => oldCodeReached(name, reachOf(file)))
    expect(found).toEqual([])
    expect(files.length).toBeGreaterThan(300)
  })

  it("ESLint's config names no frozen folder (W65 took its ignore lines out with the folders)", () => {
    const config = readFileSync(path.join(WORKER, 'eslint.config.mjs'), 'utf8')
    expect(config.split('\n').filter((line) => NAMES_OLD_FOLDER.test(line))).toEqual([])
  })

  it('W64a item 7: the nine words tests that read the old code read only the pinned words', () => {
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
    }
  })

  it.each(W65_GROUPS.map((group) => group.name))('rule 2: %s is gone, and nothing reaches it', (groupName) => {
    const group = W65_GROUPS.find((one) => one.name === groupName) as (typeof W65_GROUPS)[number]
    if (group.folder) expect(existsSync(path.join(WORKER, group.folder)), group.folder).toBe(false)
    expect(files.filter(({ name }) => group.holds(name)).map(({ name }) => name)).toEqual([])
    const folders = FROZEN.filter((folder) => groupName === `${TESTING}${folder}/`)
    const reachers = files
      .filter(({ name }) => !NAMES_ONLY.includes(name))
      .flatMap(({ file, name }) => {
        const reach = reachOf(file)
        const byModule = reach.modules.filter((module) => group.holds(module)).map((module) => `${name} imports ${module}`)
        const byPath = reach.paths.filter((text) => folders.some((folder) => text.includes(folder)) || (groupName.includes('golden') && text.includes('replay/golden'))).map((text) => `${name} names ${JSON.stringify(text)}`)
        return [...byModule, ...byPath]
      })
    expect(reachers).toEqual([])
  })

  it('the replay folder holds exactly the five files W65 kept, and none of the ten old guards is left', () => {
    const replayDir = path.join(WORKER, TESTING, 'replay')
    expect(readdirSync(replayDir).map((name) => `${TESTING}replay/${name}`).sort()).toEqual([...REPLAY_KEPT].sort())
    expect(OLD_CODE_GUARDS.filter((guard) => existsSync(path.join(WORKER, guard)))).toEqual([])
  })

  it('the check catches a rule test that imports a deleted module, or reads a frozen folder, and passes a comment', () => {
    const planted = (text: string) => oldCodeReached('planted', reachOf(path.join(WORKER, 'server/rules/bookings/planted.test.ts'), text))
    expect(planted("import { oldSide, replay } from '@/server/rules/testing/replay/harness'\n")).toEqual([
      'planted imports server/rules/testing/replay/harness',
      'planted imports oldSide',
    ])
    expect(planted("import { newBookingSide } from '@/server/rules/testing/replay/booking-side'\n")).toEqual(['planted imports server/rules/testing/replay/booking-side'])
    expect(planted("import { frozenWords } from '../testing/frozen-words'\n")).toEqual(['planted imports server/rules/testing/frozen-words'])
    expect(planted(`const dir = path.join(__dirname, '../testing/${ADMIN_COPY}/backend/paddock')\n`)).toEqual([`planted names "../testing/${ADMIN_COPY}/backend/paddock"`])
    expect(planted(`const old = await import('../testing/${ORDER_COPY}/backend/paddock/createOrder')\n`)).toEqual([
      `planted imports server/rules/testing/${ORDER_COPY}/backend/paddock/createOrder`,
      `planted names "../testing/${ORDER_COPY}/backend/paddock/createOrder"`,
    ])
    expect(planted("const file = path.join(__dirname, '../testing/replay/golden/w06-cash.json')\n")).toEqual(['planted names "../testing/replay/golden/w06-cash.json"'])
    // The five kept replay files and the sweep are not deleted: importing them is no finding.
    expect(planted("import { seed } from '@/server/rules/testing/replay/scenarios'\nimport { replay } from '@/server/rules/testing/sweep/run'\n")).toEqual([])
    expect(planted(`// sets up as ${ORDER_COPY}/ and replay/harness's oldSide once did\nimport { workerSide } from '@/server/rules/testing/sweep/worker'\n`)).toEqual([])
  })
})
