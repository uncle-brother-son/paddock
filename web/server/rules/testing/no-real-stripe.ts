// Brief W11 item 0 (W10a O1): no unit test may reach Stripe. vitest.unit.config.ts loads this before
// every test file. In W10a a rule module loaded the real SDK client before the replay's stand-in was in
// place, and a test sent requests to api.stripe.com with the harness's dummy key; nothing stopped it.
//
// Now any request to a Stripe host is refused before it is sent, through fetch (the SDK's fetch client,
// which the Worker uses) or through Node's http and https request and get (the SDK's default client),
// however the code imports them: the default import, a named import (`import { request } from
// 'node:https'`) or a namespace import (`import * as https`). The refusal throws, so nothing reaches the
// network, and it is recorded, so the test that made it fails once it ends, even when the code under
// test swallowed the error (an unclear Stripe answer is held, never thrown). The failure names what was
// tried. Not covered: a library with its own HTTP stack (undici's own fetch and request); nothing in
// the Worker imports one.
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { afterAll, afterEach } from 'vitest'

export const REAL_STRIPE_MESSAGE = 'a test reached real Stripe'

/** Stripe's API, its files and connect hosts, and its network: anything under stripe.com or stripe.network. */
export function isStripeHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '')
  return name === 'stripe.com' || name.endsWith('.stripe.com') || name === 'stripe.network' || name.endsWith('.stripe.network')
}

const attempts: string[] = []

function refuse(what: string): Error {
  attempts.push(what)
  return new Error(`${REAL_STRIPE_MESSAGE}: ${what}. Nothing was sent. Tests use FakeStripe (server/stripe/fake.ts).`)
}

/** What the guard has refused since it was last asked, cleared. Only the guard's own test needs it. */
export function takeStripeAttempts(): string[] {
  return attempts.splice(0)
}

/** Throws if a test reached for Stripe since the last check. Runs after every test. */
export function failIfStripeWasReached(): void {
  const reached = takeStripeAttempts()
  if (reached.length > 0) throw new Error(`${REAL_STRIPE_MESSAGE} (${reached.length}): ${reached.join('; ')}`)
}

// --- fetch

function urlOf(input: unknown): URL | null {
  try {
    if (input instanceof URL) return input
    if (typeof input === 'string') return new URL(input)
    if (input && typeof input === 'object' && 'url' in input && typeof input.url === 'string') return new URL(input.url)
  } catch {
    // Not a URL fetch can send either: let fetch say so.
  }
  return null
}

const realFetch = globalThis.fetch
const guardedFetch: typeof fetch = (input, init) => {
  const url = urlOf(input)
  if (url && isStripeHost(url.hostname)) {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    return Promise.reject(refuse(`${method} ${url.origin}${url.pathname}`))
  }
  return realFetch(input, init)
}
globalThis.fetch = guardedFetch

// --- Node's http and https

/** The host a call to http.request or http.get names: a URL, a string, or an options object. */
function hostOf(args: unknown[]): string | null {
  const [first, second] = args
  if (typeof first === 'string') return urlOf(first)?.host ?? null
  if (first instanceof URL) return first.host
  const options = (first && typeof first === 'object' ? first : second && typeof second === 'object' ? second : null) as {
    host?: unknown
    hostname?: unknown
  } | null
  const host = options?.hostname ?? options?.host
  return typeof host === 'string' ? host : null
}

type Sender = (...args: unknown[]) => unknown

for (const [scheme, module] of [
  ['http', http],
  ['https', https],
] as const) {
  const target = module as unknown as Record<'request' | 'get', Sender>
  for (const name of ['request', 'get'] as const) {
    const original = target[name]
    target[name] = function guarded(this: unknown, ...args: unknown[]) {
      const host = hostOf(args)
      if (host && isStripeHost(host)) throw refuse(`${scheme}.${name} ${host}`)
      return original.apply(this, args)
    }
  }
}
// W11a (review S2): Node keeps a builtin's ESM exports as separate bindings and only copies changes to
// the CommonJS object across when asked. Without this, `import { request } from 'node:https'` and
// `import * as https from 'node:https'` would still reach the unguarded functions.
syncBuiltinESMExports()

afterEach(() => {
  failIfStripeWasReached()
})
// An attempt made in a file's own beforeAll or afterAll fails that file.
afterAll(() => {
  failIfStripeWasReached()
})
