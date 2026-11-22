import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { staffAppDir } from './rules/testing/staff-app-dir'

// Brief W61 (G-plan 4.10: "Nothing calls paddockData or paddockBackendApi2. A test in the staff app's check holds
// that (a search of backend/), so step H's removal of both resources can't break a screen."). The staff app has no
// test runner of its own (`retool check` is its typecheck and build), so, like every staff app test, it runs here,
// against the staff app's checkout beside this repo. It reads every file under backend/paddock with its comments taken
// out: a comment saying what a function used to do is not a use. The generated resource types (backend/resources/)
// stay until step H removes the resources and are not code.

const appDir = staffAppDir()
const BACKEND = path.join(appDir, 'backend/paddock')
const OLD_RESOURCES = /\b(paddockData|paddockBackendApi2)\b/g

function backendFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? backendFiles(full) : /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [full] : []
  })
}
/** The code without its comments. */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
/** Each use of the two old resources in some code, as `name` (comments already out). */
const usesIn = (code: string): string[] => [...code.matchAll(OLD_RESOURCES)].map((match) => match[1] ?? '')

const files = backendFiles(BACKEND)

describe("the staff app's backend uses neither old resource (G-plan 4.10)", () => {
  it('no function or shared module names paddockData or paddockBackendApi2', () => {
    const found = files.flatMap((file) => usesIn(withoutComments(readFileSync(file, 'utf8'))).map((name) => `${path.relative(appDir, file)}: ${name}`))
    expect(found).toEqual([])
  })

  it('reads every function and shared module (a wrong folder would pass with nothing to read)', () => {
    expect(existsSync(BACKEND)).toBe(true)
    expect(files.length).toBeGreaterThan(140)
    for (const file of ['createOrder.ts', 'refundOrder.ts', 'typecheckAll.ts', 'shared/callWorker.ts', 'shared/adminWorker.ts']) {
      expect(files, file).toContain(path.join(BACKEND, file))
    }
    // Every function calls the Worker through the one resource that stays: the scan reads real code.
    const callWorker = withoutComments(readFileSync(path.join(BACKEND, 'shared/callWorker.ts'), 'utf8'))
    expect(callWorker).toMatch(/\bpaddockWorkerV1\b/)
  })

  it('the test itself would catch one: a query, a raw request, a bare mention; never a comment', () => {
    const planted = withoutComments(
      [
        "const rows = await paddockData.query('SELECT 1')",
        "await paddockBackendApi2.rawRequest({ path: '/x' })",
        'const db = paddockData',
        '// paddockData was used here before W61',
        '/** paddockBackendApi2 in a block comment */',
        'const paddockDataLike = 1',
      ].join('\n')
    )
    expect(usesIn(planted)).toEqual(['paddockData', 'paddockBackendApi2', 'paddockData'])
  })
})
