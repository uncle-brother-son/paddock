import { execFile } from 'node:child_process'
import * as httpNamespace from 'node:http'
import { get as namedHttpGet } from 'node:http'
import https from 'node:https'
import * as httpsNamespace from 'node:https'
import { get as namedHttpsGet, request as namedHttpsRequest } from 'node:https'
import path from 'node:path'
import { promisify } from 'node:util'
import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { createStripeClient } from '@/server/stripe/client'
import { failIfStripeWasReached, isStripeHost, REAL_STRIPE_MESSAGE, takeStripeAttempts } from './no-real-stripe'

// Brief W11 item 0 (W10a O1): the guard vitest.unit.config.ts loads before every test file. Each test
// here tries to reach Stripe for real, and checks that nothing is sent and the attempt is caught. The
// last one runs a test that swallows the error, in its own vitest, and checks that test fails.

const webDir = path.resolve(__dirname, '../../..')
const FAKE_KEY = 'sk_test_guard_never_sent'

/** A DNS lookup that fails at once: a request carrying it can't reach the network, even past a broken guard. */
const failLookup = (_host: string, _options: unknown, callback: (err: Error) => void) => callback(new Error('lookup refused in the test: nothing sent'))
const noNetwork = { lookup: failLookup as never }
/** Calls `send`; the guard's refusal (thrown) is the answer, else the request's own failure. */
const attempt = (send: () => { on(event: 'error', listener: (err: Error) => void): unknown; end(): unknown }): Promise<string> =>
  new Promise((resolve) => {
    try {
      const req = send()
      req.on('error', (err) => resolve(`not refused by the guard; failed later: ${err.message}`))
      req.end()
    } catch (err) {
      resolve(err instanceof Error ? err.message : String(err))
    }
  })

describe('the guard against real Stripe in tests', () => {
  it('knows the Stripe hosts, and only those', () => {
    for (const host of ['api.stripe.com', 'API.Stripe.com', 'files.stripe.com', 'api.stripe.com:443', 'stripe.com', 'api.stripe.com.', 'm.stripe.network']) {
      expect(isStripeHost(host), host).toBe(true)
    }
    for (const host of ['worker.test', 'replay.test', 'notstripe.com', 'stripe.com.example.org', 'localhost', '127.0.0.1']) {
      expect(isStripeHost(host), host).toBe(false)
    }
  })

  it('fetch to api.stripe.com is refused before it is sent', async () => {
    await expect(fetch('https://api.stripe.com/v1/payment_intents', { method: 'POST' })).rejects.toThrow(REAL_STRIPE_MESSAGE)
    expect(takeStripeAttempts()).toEqual(['POST https://api.stripe.com/v1/payment_intents'])
  })

  it("the Worker's own Stripe client (the SDK's fetch client) is stopped, and the attempt is caught though the SDK hides the error", async () => {
    const stripe = createStripeClient(FAKE_KEY, { timeoutMs: 2_000, networkRetries: 0 })
    const sending = stripe.paymentIntents.create({ amount: 100, currency: 'gbp' }, { idempotencyKey: 'guard-test' })
    // The SDK turns the refusal into its own connection error, as it would a dropped connection.
    await expect(sending).rejects.toBeInstanceOf(Stripe.errors.StripeConnectionError)
    expect(takeStripeAttempts()).toEqual(['POST https://api.stripe.com/v1/payment_intents'])
  })

  // W12 item 0 (W11a, "Still exposed"): these two carry a DNS lookup that fails at once, as the block
  // below does, so a broken guard fails them with nothing looked up or sent. The SDK's own request gets
  // it through its agent (Node passes an agent's `lookup` on to the socket).
  it("the SDK's default Node client (https.request) is stopped too", async () => {
    const stripe = new Stripe(FAKE_KEY, { maxNetworkRetries: 0, timeout: 2_000, httpAgent: new https.Agent({ lookup: failLookup as never }) })
    await expect(stripe.customers.search({ query: "metadata['x']:'y'" })).rejects.toBeInstanceOf(Stripe.errors.StripeConnectionError)
    expect(takeStripeAttempts()).toEqual(['https.request api.stripe.com'])
  })

  it('https.get by host name, and by URL, are stopped', async () => {
    expect(await attempt(() => https.get({ hostname: 'api.stripe.com', path: '/v1/charges', ...noNetwork }))).toContain(REAL_STRIPE_MESSAGE)
    expect(await attempt(() => https.get('https://files.stripe.com/v1/files', noNetwork))).toContain(REAL_STRIPE_MESSAGE)
    expect(takeStripeAttempts()).toEqual(['https.get api.stripe.com', 'https.get files.stripe.com'])
  })

  // W11a (review S2, the review's proof G1): code vitest compiles that imports request or get by name, or
  // the module as a namespace, gets Node's ESM bindings, which only follow the guard's patch after
  // syncBuiltinESMExports(). Every request here carries a DNS lookup that fails at once, so even with the
  // guard broken nothing is looked up or sent (a planted bug proved an unguarded call without one goes
  // out); the test fails on whether the guard refused it first.
  describe('named and namespace imports of node:http and node:https', () => {
    const stripeApi = { hostname: 'api.stripe.com', path: '/v1/payment_intents', method: 'POST', ...noNetwork }

    it('a named import of https.request is refused and recorded', async () => {
      expect(await attempt(() => namedHttpsRequest(stripeApi))).toContain(REAL_STRIPE_MESSAGE)
      expect(takeStripeAttempts()).toEqual(['https.request api.stripe.com'])
    })

    it('a namespace import of https (import * as https) is refused and recorded', async () => {
      expect(await attempt(() => httpsNamespace.request(stripeApi))).toContain(REAL_STRIPE_MESSAGE)
      expect(takeStripeAttempts()).toEqual(['https.request api.stripe.com'])
    })

    it('named and namespace get, on https and http, are refused and recorded', async () => {
      expect(await attempt(() => namedHttpsGet({ hostname: 'api.stripe.com', path: '/v1/charges', ...noNetwork }))).toContain(REAL_STRIPE_MESSAGE)
      expect(await attempt(() => httpsNamespace.get('https://files.stripe.com/v1/files', noNetwork))).toContain(REAL_STRIPE_MESSAGE)
      expect(await attempt(() => namedHttpGet({ hostname: 'api.stripe.com', path: '/v1/charges', ...noNetwork }))).toContain(REAL_STRIPE_MESSAGE)
      expect(await attempt(() => httpNamespace.request({ hostname: 'api.stripe.com', path: '/v1/charges', ...noNetwork }))).toContain(REAL_STRIPE_MESSAGE)
      expect(takeStripeAttempts()).toEqual(['https.get api.stripe.com', 'https.get files.stripe.com', 'http.get api.stripe.com', 'http.request api.stripe.com'])
    })
  })

  it('any other host is left alone: the request goes, and fails on its own', async () => {
    const answer = await fetch('http://127.0.0.1:9/').then(
      () => 'answered',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    )
    expect(answer).not.toContain(REAL_STRIPE_MESSAGE)
    expect(takeStripeAttempts()).toEqual([])
  })

  it('the check after each test throws, naming what was tried, and passes when nothing was', async () => {
    await fetch('https://api.stripe.com/v1/refunds').catch(() => undefined)
    expect(() => failIfStripeWasReached()).toThrow(`${REAL_STRIPE_MESSAGE} (1): GET https://api.stripe.com/v1/refunds`)
    expect(() => failIfStripeWasReached()).not.toThrow()
  })

  it('a test that reaches Stripe and swallows the error still fails, loudly (its own vitest run)', async () => {
    const vitest = path.join(webDir, 'node_modules/vitest/vitest.mjs')
    const fixture = 'server/rules/testing/no-real-stripe.fixture.test.ts'
    const run = promisify(execFile)(process.execPath, [vitest, 'run', '--config', 'vitest.unit.config.ts', fixture], {
      cwd: webDir,
      env: { ...process.env, STRIPE_GUARD_FIXTURE: '1' },
      timeout: 90_000,
    })
    const outcome = await run.then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
      (err: { code?: number; stdout?: string; stderr?: string }) => ({ code: err.code ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` })
    )
    expect(outcome.code).toBe(1)
    expect(outcome.output).toContain(`${REAL_STRIPE_MESSAGE} (1): POST https://api.stripe.com/v1/payment_intents`)
    expect(outcome.output).toMatch(/1 failed/)
  }, 120_000)
})
