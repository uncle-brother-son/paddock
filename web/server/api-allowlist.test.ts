import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Brief W70a (the W70 audit's L4): what the Worker answers over HTTP is `app/api/v1/` (the staff, customer and public
// routes, each through defineRoute's sign-in check) and the two webhooks, each with its own signature check. The legacy
// routes outside `v1/` are all gone (the last at W61 and W68a); this holds that none comes back, under `app/api/` or as
// a route file anywhere else in `app/`, and that the old `pages/` router isn't used to add one.

const WEB = path.resolve(__dirname, '..')
const APP = path.join(WEB, 'app')

/** The only route files outside `app/api/v1/`, relative to web/. */
const WEBHOOKS: readonly string[] = ['app/api/sanity/webhook/route.ts', 'app/api/stripe/webhook/route.ts']
/** W74a, W75a, W77a: the only `app/api/v1/` routes that ask for no sign-in (`auth: 'public'`), each a read of what the site shows anyone. */
const PUBLIC_ROUTES: readonly string[] = [
  'app/api/v1/shop/availability/route.ts',
  'app/api/v1/shop/booking-days/route.ts',
  'app/api/v1/shop/booking-quote/route.ts',
  'app/api/v1/shop/event-availability/route.ts',
  'app/api/v1/shop/sessions/route.ts',
]
/** A file Next answers requests with, whatever its extension. */
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : [path.relative(WEB, full).split(path.sep).join('/')]
  })
}

/** Every route file that is neither under `app/api/v1/` nor one of the two webhooks. */
const notAllowed = (files: readonly string[]): string[] =>
  files.filter((file) => ROUTE_FILE.test(path.posix.basename(file)) && !file.startsWith('app/api/v1/') && !WEBHOOKS.includes(file))

/** Whether a route file's text asks for no sign-in. */
const asksNoSignIn = (source: string): boolean => /\bauth\s*:\s*(?:'public'|"public"|`public`)/.test(source)

describe('the only routes are app/api/v1 and the two webhooks (W70a, L4)', () => {
  const files = filesUnder(APP)

  it('W74a: every v1 route is staff or customer, but the public ones listed here, which only read', () => {
    const routes = files.filter((file) => file.startsWith('app/api/v1/') && ROUTE_FILE.test(path.posix.basename(file)))
    const sourceOf = (file: string) => readFileSync(path.join(WEB, file), 'utf8')
    expect(routes.filter((file) => !/^app\/api\/v1\/(staff|customer)\//.test(file))).toEqual(PUBLIC_ROUTES)
    expect(routes.filter((file) => asksNoSignIn(sourceOf(file)))).toEqual(PUBLIC_ROUTES)
    for (const file of PUBLIC_ROUTES) expect(sourceOf(file).match(/export const [A-Z]+/g), file).toEqual(['export const GET'])
    // Every route says who it answers as a literal in its own file, so the check above can't be stepped round.
    expect(routes.filter((file) => !/\bauth\s*:\s*'(staff|staff_sign_in|customer|public)'/.test(sourceOf(file)))).toEqual([])
    expect(['{ auth: "public" }', "{ auth : 'public', input }", "{ auth: 'staff' }"].map(asksNoSignIn)).toEqual([true, true, false])
  })

  it('no other route file, anywhere in app/; both webhooks and the v1 routes are there', () => {
    expect(notAllowed(files)).toEqual([])
    for (const webhook of WEBHOOKS) expect(files).toContain(webhook)
    expect(files.filter((file) => file.startsWith('app/api/v1/') && ROUTE_FILE.test(path.posix.basename(file))).length).toBeGreaterThan(100)
  })

  it('app/api holds v1, stripe/webhook and sanity/webhook, and nothing else but notes', () => {
    const outsideV1 = files.filter((file) => file.startsWith('app/api/') && !file.startsWith('app/api/v1/'))
    expect(outsideV1.filter((file) => !/^app\/api\/(stripe|sanity)\/webhook\//.test(file) && !/(^|\/)README\.md$/.test(file))).toEqual([])
  })

  it('no pages/ router', () => {
    for (const dir of ['pages', 'src/pages', 'src/app']) expect(existsSync(path.join(WEB, dir)), dir).toBe(false)
  })

  it('the check sees one put back, whatever it is called', () => {
    const back = ['app/api/catalog/update-tier-price/route.ts', 'app/api/test/route.js', 'app/api/stripe/webhook/replay/route.ts', 'app/api/sanity/route.tsx', 'app/shop/route.ts', 'app/api/v1x/route.ts', 'app/route.mjs']
    expect(notAllowed(['app/api/v1/staff/orders/route.ts', ...WEBHOOKS, 'app/api/stripe/webhook/dispatch.ts', 'app/page.tsx', ...back])).toEqual(back)
  })
})
