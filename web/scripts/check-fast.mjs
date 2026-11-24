// npm run check:fast (WQ29, WQ30): reads what changed (against origin/main, committed or not), prints the test level and
// runs that level's checks. Level 1 is never run from here: it says so and exits 2. Level 1b runs the quick checks
// (the changed tests among them) and then says one full Worker run is still owed, exiting 2 when they passed. The
// rules: check-fast-level.mjs.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { filesToLint, pickLevel, storiesFor, unitTestsToRun } from './check-fast-level.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(WEB, '..')
const STUDIO = path.join(REPO, 'studio')

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const names = (output) => output.split('\0').filter(Boolean)

const base = git('merge-base', 'origin/main', 'HEAD').trim()
const changedFiles = [
  ...new Set([...names(git('diff', '--name-only', '--no-renames', '-z', base)), ...names(git('ls-files', '--others', '--exclude-standard', '-z'))]),
].sort()

/** Only a script's, package.json's or a migration's text is compared; a picture or a font is there or it isn't. */
const isText = (file) => /\.(ts|tsx|mts|mjs|js|jsx|json|sql)$/.test(file)
const textBefore = (file) => {
  try {
    return git('show', `${base}:${file}`)
  } catch {
    return null
  }
}
const textAfter = (file) => {
  const full = path.join(REPO, file)
  if (!existsSync(full) || !statSync(full).isFile()) return null
  return isText(file) ? readFileSync(full, 'utf8') : ''
}
const changes = changedFiles.map((file) => ({ file, before: isText(file) ? textBefore(file) : null, after: textAfter(file) }))

const { level, reasons } = pickLevel(changes)
if (level === 0) {
  console.log('check:fast: nothing has changed against origin/main.')
  process.exit(0)
}

console.log(`check:fast: ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'} against origin/main.`)
if (level === 1) {
  console.log('\nLEVEL 1 (money or backend), because of:')
  for (const reason of reasons) console.log(`  - ${reason}`)
  console.log('\nNothing was run. Run the full process: web/CLAUDE.md, "Test levels".')
  process.exit(2)
}

if (level === '1b') {
  console.log('\nLEVEL 1b (backend that does not touch money), because of:')
  for (const reason of reasons) console.log(`  - ${reason}`)
  console.log('Its checks: the quick ones below (the changed tests among them), then one full Worker run. No planted bugs.')
} else {
  console.log('\nLEVEL 2 (website and Sanity; a Level 3 fix has the same checks).')
}
const results = []
const run = (label, cwd, command, args) => {
  console.log(`\n--- ${label}`)
  const { status } = spawnSync(command, args, { cwd, stdio: 'inherit' })
  results.push({ label, passed: status === 0 })
}

const lint = filesToLint(changes)
if (lint.web.length > 0) run(`lint: ${lint.web.length} changed in web`, WEB, 'npx', ['eslint', '--max-warnings=0', ...lint.web])
if (lint.studio.length > 0) run(`lint: ${lint.studio.length} changed in studio`, STUDIO, 'npx', ['eslint', '--max-warnings=0', ...lint.studio])

// tsc has no notion of a changed file: a changed type can break a file that didn't change, so the whole folder is read.
if (changedFiles.some((file) => file.startsWith('web/'))) run('tsc: web', WEB, 'npx', ['tsc', '--noEmit'])
if (changedFiles.some((file) => file.startsWith('studio/'))) run('tsc: studio', STUDIO, 'npx', ['tsc', '--noEmit'])

const unitTests = unitTestsToRun(changes)
if (unitTests.length > 0) run(`unit tests: ${unitTests.join(', ')}`, WEB, 'npx', ['vitest', 'run', '--config', 'vitest.unit.config.ts', ...unitTests])
else console.log('\n--- unit tests: no test file changed')

const stories = globSync('{components,features}/**/*.stories.{ts,tsx}', { cwd: WEB })
  .sort()
  .map((file) => ({ file, source: readFileSync(path.join(WEB, file), 'utf8') }))
const storyFiles = storiesFor(changedFiles, stories)
if (storyFiles.length > 0) run(`Storybook: ${storyFiles.join(', ')}`, WEB, 'npx', ['vitest', 'run', '--config', 'vitest.config.ts', ...storyFiles])
else console.log('\n--- Storybook: no changed component has a story')

console.log(`\ncheck:fast, Level ${level}:`)
for (const { label, passed } of results) console.log(`  ${passed ? 'passed' : 'FAILED'}  ${label}`)
if (!results.every(({ passed }) => passed)) process.exit(1)
if (level === '1b') {
  console.log('\nStill owed for Level 1b: one full Worker run, once (web/CLAUDE.md, "Test levels"): caffeinate -i npm run test:unit')
  process.exit(2)
}
process.exit(0)
