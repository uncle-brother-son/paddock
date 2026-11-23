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
