import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { staffAppDir } from './rules/testing/staff-app-dir'

// Brief W63 (H-plan 4.5), replacing W61's two-name search with an allowlist. The staff app may reach exactly one
// Retool resource, "Paddock Worker v1" (`paddockWorkerV1`), and only from its one call in
// backend/paddock/shared/callWorker.ts. Any other resource global, any use of `workflows`, or a second
// `paddockWorkerV1` use anywhere fails. The resource names come from the generated types (backend/resources/**/*.d.ts,
// so a resource added in Retool is caught as soon as `retool pull` brings its type) plus a fixed list of the three old
// resources, so one is still caught after Wayne deletes it in Retool and its type goes. The staff app has no test
// runner of its own (`retool check` is its typecheck and build), so, like every staff app test, it runs here, against
// the staff app's checkout beside this repo. Every .ts/.tsx file under backend/paddock and frontend/ (not node_modules,
// not .d.ts type files) is read with its comments taken out: a comment saying what a function used to do is not a use.

const appDir = staffAppDir()
const BACKEND = path.join(appDir, 'backend/paddock')
const FRONTEND = path.join(appDir, 'frontend')
const RESOURCE_TYPES = path.join(appDir, 'backend/resources')
/** The one place the staff app may reach a resource, relative to the app's folder. */
const CALL_WORKER = 'backend/paddock/shared/callWorker.ts'
const ALLOWED = 'paddockWorkerV1'
/** "Paddock Data", "Paddock Supabase" and "Paddock Backend API": caught by name even once their types are gone. */
const OLD_RESOURCES: readonly string[] = ['paddockData', 'paddockSupabase', 'paddockBackendApi2']
/** Retool workflows are reached through the `workflows` namespace (`workflows.<name>.trigger()`). */
const WORKFLOWS = 'workflows'

/**
 * package.json's `retool.app.resourceReferencesByFile` is Retool's own record of which file used which resource. The
 * CLI only checks its shape (it never writes it) and it was last written on 25 Oct 2026, by Retool's in-app editor:
 * it still names the two old resources the code used then, and not the Worker resource. It may name nothing else.
 * W63's second commit (after Wayne deletes the old resources in Retool) clears those two and empties this list.
 */
const PACKAGE_JSON_OLD_UNTIL_SECOND_COMMIT = ['Paddock Data', 'Paddock Backend API']
const WORKER_DISPLAY_NAME = 'Paddock Worker v1'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full)
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [full] : []
  })
}
function typeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? typeFiles(full) : name.endsWith('.d.ts') ? [full] : []
  })
}
/** The code without its comments. */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

/**
 * The resource globals the generated types declare (`const <name>: ...` inside `declare global`). A workflow's own
 * name is declared inside `namespace workflows { ... }` and is reached only through `workflows`, so those blocks are
 * left out here and `workflows` is caught on its own.
 */
function generatedResourceNames(): string[] {
  const names = typeFiles(RESOURCE_TYPES).flatMap((file) => {
    const text = withoutComments(readFileSync(file, 'utf8')).replace(/namespace\s+\w+\s*\{[^{}]*\}/g, '')
    return [...text.matchAll(/\bconst\s+(\w+)\s*:/g)].map((match) => match[1] ?? '')
  })
  return [...new Set(names)].sort()
}

interface Source {
  /** Relative to the app's folder. */
  file: string
  /** Already without comments. */
  code: string
}

/** Every use the allowlist refuses, as `file: name`, plus one line when `paddockWorkerV1` isn't used exactly once, in callWorker.ts. */
function violations(sources: readonly Source[], resourceNames: readonly string[]): string[] {
  const watched = [...new Set([...resourceNames, ...OLD_RESOURCES, ALLOWED, WORKFLOWS])]
  const pattern = new RegExp(`\\b(${watched.join('|')})\\b`, 'g')
  const refused: string[] = []
  const workerUses: string[] = []
  for (const { file, code } of sources) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1] ?? ''
      if (name === ALLOWED) workerUses.push(file)
      else refused.push(`${file}: ${name}`)
    }
  }
  if (workerUses.length !== 1 || workerUses[0] !== CALL_WORKER) {
    refused.push(`${ALLOWED} must be used once, in ${CALL_WORKER}; used in: ${workerUses.join(', ') || 'nowhere'}`)
  }
  return refused
}

/** The resources package.json's map names that it may not: anything but the Worker resource and the two listed above. */
function packageJsonRefused(map: Record<string, ReadonlyArray<{ displayName: string }>> | undefined): string[] {
  const allowed = new Set([WORKER_DISPLAY_NAME, ...PACKAGE_JSON_OLD_UNTIL_SECOND_COMMIT])
  return Object.entries(map ?? {}).flatMap(([file, refs]) =>
    refs.filter((ref) => !allowed.has(ref.displayName)).map((ref) => `${file}: ${ref.displayName}`)
  )
}

const files = [...sourceFiles(BACKEND), ...sourceFiles(FRONTEND)]
const sources: Source[] = files.map((file) => ({ file: path.relative(appDir, file), code: withoutComments(readFileSync(file, 'utf8')) }))
const resourceNames = generatedResourceNames()

describe('the staff app reaches only the Worker, through callWorker.ts (H-plan 4.5)', () => {
  it('no function, shared module or screen names any resource but paddockWorkerV1, or workflows; paddockWorkerV1 is used once, in shared/callWorker.ts', () => {
    expect(violations(sources, resourceNames)).toEqual([])
  })

  it("package.json's resourceReferencesByFile names no resource but the Worker (and, until W63's second commit, the two old ones it still lists)", () => {
    const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')) as {
      retool?: { app?: { resourceReferencesByFile?: Record<string, Array<{ displayName: string }>> } }
    }
    expect(packageJsonRefused(pkg.retool?.app?.resourceReferencesByFile)).toEqual([])
  })

  it('reads every function, shared module and screen, and the generated resource types (a wrong folder would pass with nothing to read)', () => {
    expect(existsSync(BACKEND)).toBe(true)
    expect(existsSync(FRONTEND)).toBe(true)
    const relative = sources.map((source) => source.file)
    expect(relative.filter((file) => file.startsWith('backend/paddock/')).length).toBeGreaterThan(140)
    expect(relative.filter((file) => file.startsWith('frontend/')).length).toBeGreaterThan(150)
    expect(relative.some((file) => file.includes('node_modules'))).toBe(false)
    for (const file of [
      'backend/paddock/createOrder.ts',
      'backend/paddock/refundOrder.ts',
      CALL_WORKER,
      'backend/paddock/shared/adminWorker.ts',
      'frontend/App.tsx',
      'frontend/pages/SubscriptionsPage.tsx',
    ]) {
      expect(relative, file).toContain(file)
    }
    // The generated types are read: the Worker resource and Retool's built-in ones are there, a workflow's own name is not.
    expect(resourceNames).toContain(ALLOWED)
    for (const name of ['retoolDb', 'retoolStorage', 'retoolEmail']) expect(resourceNames).toContain(name)
    expect(resourceNames).not.toContain('allocateMembershipCredits')
    // The one call is real code, not a comment.
    expect(sources.find((source) => source.file === CALL_WORKER)?.code).toMatch(/\bpaddockWorkerV1\.rawRequest\b/)
  })

  describe('the guard would catch one (plants)', () => {
    const app = (planted: Record<string, string>): Source[] => [
      { file: CALL_WORKER, code: withoutComments('response = await paddockWorkerV1.rawRequest<unknown>({ path })') },
      ...Object.entries(planted).map(([file, code]) => ({ file, code: withoutComments(code) })),
    ]
    const once = `${ALLOWED} must be used once, in ${CALL_WORKER}; used in: `

    it('"Paddock Supabase" by its generated name, in a function or on a screen', () => {
      expect(violations(app({ 'backend/paddock/getX.ts': "const rows = await paddockSupabase.query('SELECT 1')" }), resourceNames)).toEqual([
        'backend/paddock/getX.ts: paddockSupabase',
      ])
      expect(violations(app({ 'frontend/pages/X.tsx': 'const db = paddockSupabase' }), resourceNames)).toEqual(['frontend/pages/X.tsx: paddockSupabase'])
    })

    it('an old resource whose type is gone (after the Retool deletions) is still caught', () => {
      const withoutOld = resourceNames.filter((name) => !OLD_RESOURCES.includes(name))
      expect(withoutOld).not.toContain('paddockData')
      expect(
        violations(
          app({ 'backend/paddock/getY.ts': "await paddockData.query('SELECT 1')\nawait paddockBackendApi2.rawRequest({ path: '/x' })" }),
          withoutOld
        )
      ).toEqual(['backend/paddock/getY.ts: paddockData', 'backend/paddock/getY.ts: paddockBackendApi2'])
    })

    it("any other resource the generated types declare (Retool's database, storage, email, a model provider)", () => {
      const planted = [
        "await retoolDb.query('SELECT 1')",
        "await retoolStorage.getFile('x')",
        'await retoolEmail.send({})',
        'await anthropic.messages.create({})',
      ].join('\n')
      expect(violations(app({ 'backend/paddock/getZ.ts': planted }), resourceNames)).toEqual([
        'backend/paddock/getZ.ts: retoolDb',
        'backend/paddock/getZ.ts: retoolStorage',
        'backend/paddock/getZ.ts: retoolEmail',
        'backend/paddock/getZ.ts: anthropic',
      ])
    })

    it('a workflows call, by its name or its old generated name', () => {
      const planted = ['await workflows.allocateMembershipCredits.trigger({})', 'await workflows.myFirstWorkflowWayneHolland2026090511123Am.trigger()'].join('\n')
      expect(violations(app({ 'backend/paddock/runJob.ts': planted }), resourceNames)).toEqual([
        'backend/paddock/runJob.ts: workflows',
        'backend/paddock/runJob.ts: workflows',
      ])
    })

    it('a second paddockWorkerV1 use: in another function, on a screen, or a second call in callWorker.ts', () => {
      expect(violations(app({ 'backend/paddock/getW.ts': "await paddockWorkerV1.rawRequest({ path: '/x' })" }), resourceNames)).toEqual([
        `${once}${CALL_WORKER}, backend/paddock/getW.ts`,
      ])
      expect(violations(app({ 'frontend/pages/W.tsx': 'const w = paddockWorkerV1' }), resourceNames)).toEqual([`${once}${CALL_WORKER}, frontend/pages/W.tsx`])
      expect(violations(app({ [CALL_WORKER]: "await paddockWorkerV1.rawRequest({ path: '/y' })" }), resourceNames)).toEqual([
        `${once}${CALL_WORKER}, ${CALL_WORKER}`,
      ])
      // Moved out of callWorker.ts: the one use is in the wrong place.
      expect(violations([{ file: 'backend/paddock/shared/other.ts', code: 'paddockWorkerV1.rawRequest({})' }], resourceNames)).toEqual([
        `${once}backend/paddock/shared/other.ts`,
      ])
    })

    it('never a comment, nor a longer name that only starts with one', () => {
      const planted = [
        '// paddockData was used here before W61',
        '/** paddockSupabase in a block comment; workflows.allocateMembershipCredits too */',
        "const url = 'https://example.com' // paddockWorkerV1 in a trailing comment",
        'const paddockDataLike = 1',
        'const myWorkflowsCount = 2',
        'const paddockWorkerV1Shape = 3',
      ].join('\n')
      expect(violations(app({ 'backend/paddock/getV.ts': planted }), resourceNames)).toEqual([])
    })

    it("package.json's map: a resource other than the Worker and the two old ones listed is refused", () => {
      expect(packageJsonRefused(undefined)).toEqual([])
      expect(
        packageJsonRefused({
          '/backend/paddock/shared/callWorker.ts': [{ displayName: 'Paddock Worker v1' }],
          '/backend/paddock/getX.ts': [{ displayName: 'Paddock Data' }, { displayName: 'Paddock Supabase' }],
          '/backend/paddock/getY.ts': [{ displayName: 'Retool Database' }],
        })
      ).toEqual(['/backend/paddock/getX.ts: Paddock Supabase', '/backend/paddock/getY.ts: Retool Database'])
    })
  })
})
