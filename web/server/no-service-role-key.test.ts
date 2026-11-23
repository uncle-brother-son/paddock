import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Brief W66 item 3 (H-plan 5, W66 + W67): after the two webhooks moved onto the Worker's own database connection,
// nothing in the Worker may read the Supabase service-role key, and only four files may load a Supabase client: the
// website's customer sign-in (lib/supabase/client.ts, server.ts, middleware.ts, with the public anon key) and the
// customer token check (server/auth/customer.ts, the anon key too). So Wayne can remove `SUPABASE_SERVICE_ROLE_KEY`
// from Cloudflare and web/.env.local after a day of clean events (W66-3), and nothing can quietly bring it back.
// Every .ts/.tsx/.js/.mjs/.cjs file in web/ is read with its comments taken out (a comment saying what the code used
// to do is not a reader): tests too, apart from this one. Build output, packages and the git folder are not code.
// `wrangler.jsonc` is read whole: a `vars` entry naming the key would hand it to the Worker.
// W66a (the W66 review's F5): `package.json` may not install a Supabase package under another name (`npm:@supabase/…`),
// and `process.env[…]` may only be read by a plain quoted name or a named constant that is one, so a name built from
// parts can't slip past the scan.

const WEB = path.resolve(__dirname, '..')
/** Not the Worker's own code: packages, build output, the git folder, Storybook's static build. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.next', '.open-next', '.wrangler', '.git', 'storybook-static', 'coverage'])
const THIS_FILE = path.relative(WEB, __filename)
const KEY = 'SUPABASE_SERVICE_ROLE_KEY'
/** The only files that may load a Supabase package, relative to web/. */
const SUPABASE_ALLOWED: readonly string[] = ['lib/supabase/client.ts', 'lib/supabase/server.ts', 'lib/supabase/middleware.ts', 'server/auth/customer.ts']

function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : codeFiles(full)
    return /\.(tsx?|mjs|cjs|js)$/.test(name) && !name.endsWith('.d.ts') ? [full] : []
  })
}

/** The code without its comments (block, then line comments not inside a URL or a string's start). */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

/** A Supabase package loaded: `from '@supabase/…'`, `import('@supabase/…')`, `require('@supabase/…')`. */
const LOADS_SUPABASE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"`]@supabase\//

/** The index of every `env[…]` read off process (`process.env[x]`, `process?.env?.[x]`, `process['env'][x]`). */
const ENV_INDEX = /\bprocess(?:\?)?\s*(?:\.\s*env\b|(?:\?\.)?\s*\[\s*['"`]env['"`]\s*\])\s*(?:\?\.)?\s*\[([^\]]*)\]/g
/** A plain quoted name: one literal, with nothing built into it. */
const PLAIN_NAME = /^(?:'[A-Za-z0-9_]+'|"[A-Za-z0-9_]+"|`[A-Za-z0-9_]+`)$/

/** Whether an env index is a plain quoted name, or a constant this file declares as one. */
function plainEnvIndex(index: string, code: string): boolean {
  if (PLAIN_NAME.test(index)) return true
  if (!/^[A-Z][A-Z0-9_]*$/.test(index)) return false
  const declared = [...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${index}\\s*(?::[^=\\n]+)?=\\s*([^\\n;]+)`, 'g'))]
  return declared.length === 1 && /^\s*const\b/.test(declared[0]?.[0] ?? '') && PLAIN_NAME.test((declared[0]?.[1] ?? '').trim())
}

/** Every dependency installed from a Supabase package under another name, as `name: value`. */
function supabaseAliases(packageJson: string): string[] {
  const parsed = JSON.parse(packageJson) as Record<string, unknown>
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions'].flatMap((field) =>
    Object.entries((parsed[field] ?? {}) as Record<string, unknown>)
      .filter(([, value]) => JSON.stringify(value).includes('npm:@supabase/'))
      .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
  )
}

interface Source {
  /** Relative to web/. */
  file: string
  code: string
}

/** Every reader the guard refuses, as `file: what`. */
function serviceRoleViolations(sources: readonly Source[]): string[] {
  const refused: string[] = []
  for (const { file, code } of sources) {
    if (code.includes(KEY)) refused.push(`${file}: names ${KEY}`)
    if (LOADS_SUPABASE.test(code) && !SUPABASE_ALLOWED.includes(file)) refused.push(`${file}: loads a Supabase package`)
    for (const [, index] of code.matchAll(ENV_INDEX)) if (!plainEnvIndex((index ?? '').trim(), code)) refused.push(`${file}: reads process.env[${(index ?? '').trim()}]`)
  }
  return refused
}

function workerSources(): Source[] {
  return codeFiles(WEB)
    .map((full) => path.relative(WEB, full).split(path.sep).join('/'))
    .filter((file) => file !== THIS_FILE)
    .map((file) => ({ file, code: withoutComments(readFileSync(path.join(WEB, file), 'utf8')) }))
}

describe('the Supabase service-role key and Supabase clients (W66 item 3)', () => {
  it('no code in the Worker names SUPABASE_SERVICE_ROLE_KEY, and only the four sign-in files load a Supabase package', () => {
    const sources = workerSources()
    // The scan reached the code (and the two webhooks, which read the key until W66).
    expect(sources.length).toBeGreaterThan(500)
    expect(sources.map((source) => source.file)).toEqual(expect.arrayContaining(['app/api/stripe/webhook/route.ts', 'app/api/sanity/webhook/route.ts', ...SUPABASE_ALLOWED]))
    expect(serviceRoleViolations(sources)).toEqual([])
  })

  it('wrangler.jsonc hands the Worker no service-role key', () => {
    const wrangler = path.join(WEB, 'wrangler.jsonc')
    expect(existsSync(wrangler)).toBe(true)
    expect(readFileSync(wrangler, 'utf8')).not.toContain(KEY)
  })

  it('package.json installs no Supabase package under another name (W66a, F5)', () => {
    const packageJson = readFileSync(path.join(WEB, 'package.json'), 'utf8')
    expect(packageJson).toContain('"@supabase/')
    expect(supabaseAliases(packageJson)).toEqual([])
    expect(supabaseAliases(JSON.stringify({ dependencies: { 'db-client': 'npm:@supabase/supabase-js@2', '@supabase/ssr': '^0.5.0' }, overrides: { x: { y: 'npm:@supabase/ssr' } } }))).toEqual(['db-client: "npm:@supabase/supabase-js@2"', 'x: {"y":"npm:@supabase/ssr"}'])
  })

  it('process.env is read by a plain name only: a name built from parts is caught (W66a, F5)', () => {
    const reads = (code: string) => serviceRoleViolations([{ file: 'server/x.ts', code: withoutComments(code) }])
    // The one such read there is (connection.ts: a constant that is a plain name) passes, and is really reached.
    const connection = withoutComments(readFileSync(path.join(WEB, 'server/db/connection.ts'), 'utf8'))
    expect([...connection.matchAll(ENV_INDEX)].map((match) => match[1])).toEqual(['LOCAL_CONNECTION_STRING'])
    expect(serviceRoleViolations([{ file: 'server/db/connection.ts', code: connection }])).toEqual([])
    for (const plain of ["process.env['ORDER_SWITCH']", 'process.env["ORDER_SWITCH"]', 'process.env[`ORDER_SWITCH`]', "const NAME = 'ORDER_SWITCH'\nprocess.env[NAME]", "const NAME: string = 'ORDER_SWITCH'\nprocess.env[NAME]"]) expect(reads(plain), plain).toEqual([])
    for (const built of [
      "process.env['SUPABASE_' + 'SERVICE_ROLE_KEY']",
      'process.env[`SUPABASE_${part}`]',
      "process.env[['SUPABASE', 'SERVICE'].join('_')]",
      'process.env[name]',
      'process.env?.[name]',
      "process['env'][name]",
      'process.env[NAME]',
      "const NAME = 'SUPABASE_' + 'SERVICE_ROLE_KEY'\nprocess.env[NAME]",
      "let NAME = 'ORDER_SWITCH'\nprocess.env[NAME]",
    ]) expect(reads(built), built).toHaveLength(1)
  })

  it('the four allowed files are still there (a file moved would make the allowance stale)', () => {
    for (const file of SUPABASE_ALLOWED) expect(existsSync(path.join(WEB, file)), file).toBe(true)
  })

  it('scans what it says: a planted reader of the key, a planted client, a dynamic import and a require are each caught; comments and the allowed files are not', () => {
    const planted: Source[] = [
      { file: 'app/api/sanity/webhook/route.ts', code: withoutComments("const key = process.env.SUPABASE_SERVICE_ROLE_KEY!") },
      { file: 'server/rules/catalog/x.ts', code: withoutComments("import { createClient } from '@supabase/supabase-js'") },
      { file: 'server/rules/catalog/y.ts', code: withoutComments("const { createClient } = await import('@supabase/supabase-js')") },
      { file: 'scripts/z.cjs', code: withoutComments("const supabase = require(\"@supabase/ssr\")") },
      { file: 'server/rules/catalog/w.ts', code: withoutComments("// it read SUPABASE_SERVICE_ROLE_KEY and imported '@supabase/supabase-js' until W66") },
      { file: 'server/auth/customer.ts', code: withoutComments("import { createClient } from '@supabase/supabase-js'") },
      { file: 'lib/supabase/server.ts', code: withoutComments("import { createServerClient } from '@supabase/ssr'") },
    ]
    expect(serviceRoleViolations(planted)).toEqual([
      'app/api/sanity/webhook/route.ts: names SUPABASE_SERVICE_ROLE_KEY',
      'server/rules/catalog/x.ts: loads a Supabase package',
      'server/rules/catalog/y.ts: loads a Supabase package',
      'scripts/z.cjs: loads a Supabase package',
    ])
  })
})
