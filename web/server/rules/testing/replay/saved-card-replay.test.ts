import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as savedCardRoute } from '@/app/api/v1/staff/customers/[customerId]/saved-card/route'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { compareRecordings, type Recording } from './compare'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario } from './harness'
import { FB17, FB17_SCENARIO, Q19, Q19_SCENARIOS, SAVED_CARD_SCENARIOS, W42_DIFFERENCES, type SavedCardPress } from './saved-card-differences'
import { ID, MO_SUBSCRIPTION, seed } from './scenarios'
import { replayStripe } from './stripe-binding'

// Brief W42 item 6 (F-plan 4.12 items 3 and 4; slice W42's "Parity: the saved-card family from W11; Q19 and F4 named").
// The saved card has been the Worker's own code since W11 (payments/terminal.ts, `saveCustomerCard`), with no old
// function to record a golden file from (W36: payments/terminal-today.test.ts). W42 keeps that code, untouched, as
// what the route does with `card_moves` off. So the parity is run live: each press of the family goes through the
// route twice from the same seed, once with the kind off (W11's code: the recorded side) and once with it on (W42's),
// and the two recordings are compared: the rows written, the Stripe calls in order, and the answer. Only the named
// differences in saved-card-differences.ts are allowed, each pinned to the one value the new code gives there, and an
// allowance nothing needs fails.
//
// The W11 reader scenarios that save a card while taking a payment (`w11-reader-save-card-*` and the two beside them)
// go through the order's own finalise: order-replay.test.ts still holds each to its golden file with `card_moves`
// off, and the last test here holds that they are still on its list. W42a: with the kind on, the order's T2 runs the
// same rule as the replace; order-replay.test.ts runs the three `w11-reader-save-card-*` scenarios again with it on
// and names the one difference (order-differences.ts, W42A_CARD_MOVES_DIFFERENCES).

vi.setConfig({ testTimeout: 120_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal())
})

/**
 * The replay's clock stands still while a route runs, so rows a press writes one after another share a moment and
 * read back in no fixed order. Here it moves on 10 ms before every statement (on both sides alike), so each recording
 * keeps its rows in the order they were written.
 */
function ticking(real: Db): Db {
  const tick = () => vi.setSystemTime(Date.now() + 10)
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, prop) {
        const value = Reflect.get(inner, prop) as unknown
        if (prop === 'query' && typeof value === 'function') {
          return (...args: unknown[]) => {
            tick()
            return (value as (...a: unknown[]) => unknown).apply(inner, args)
          }
        }
        if (prop === 'transaction' && typeof value === 'function') {
          return (work: (tx: object) => unknown) => (value as (w: (tx: object) => unknown) => unknown).call(inner, (tx) => work(wrap(tx)))
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(inner) : value
      },
    })
  return wrap(real)
}

const KEY = 'test-staff-api-key'
const OFF = 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels,membership_changes,payment_date_changes'
const ON = `${OFF},card_moves`

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = ticking(db)
})
afterAll(() => {
  replayStripe.current = null
  vi.unstubAllEnvs()
  return environment.stop()
})

/** The route as the staff app's thin wrapper calls it, answering what staff are shown: the saved row, or the words thrown. */
function routeSide(switchValue: string) {
  return (sideDb: Db, stripe: FakeStripe): ReplaySide => {
    // The old side's globals (the frozen copies' database and routes) are set up as for every replay; nothing here uses them.
    oldSide(sideDb, stripe)
    return {
      name: switchValue === ON ? 'card_moves on' : 'card_moves off',
      async call(_action, params) {
        const press = params as SavedCardPress
        replayStripe.current = stripe
        vi.stubEnv('ORDER_SWITCH', switchValue)
        try {
          let intentId = 'seti_unknown'
          if (press.tap) {
            const intent = await stripe.setupIntents.create({ ...(press.tap.stripeCustomer ? { customer: press.tap.stripeCustomer } : {}), payment_method_types: ['card_present'], usage: 'off_session' })
            stripe.completeReaderSetup(intent.id, press.tap.card ? { generatedCard: press.tap.card } : {})
            intentId = intent.id
          }
          vi.setSystemTime(Date.now() + 1000)
          const response = await savedCardRoute(
            new Request(`https://worker.test/api/v1/staff/customers/${press.customerId}/saved-card`, {
              method: 'POST',
              // A key of its own for every press, a UUID as the staff app sends (a key under 16 characters is refused before the route runs).
              headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
              body: JSON.stringify({ setupIntentId: intentId }),
            }),
            { params: Promise.resolve({ customerId: press.customerId }) }
          )
          const body = (await response.json()) as { data?: unknown; error?: { message: string } }
          return response.ok ? body.data : { thrown: body.error?.message }
        } finally {
          replayStripe.current = null
        }
      },
    }
  }
}

function scenario(name: string): Scenario {
  const presses = SAVED_CARD_SCENARIOS[name]
  if (!presses) throw new Error(`No saved card scenario ${name}`)
  return {
    name,
    async seed(seedDb, stripe) {
      await seed(seedDb, stripe)
      await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
      stripe.addSubscription(MO_SUBSCRIPTION, 'cus_member', 'price_seed_monthly')
    },
    async run({ call }) {
      for (const press of presses) await call('saveCustomerCardOnFile', press)
    },
  }
}

const runs = new Map<string, Promise<{ off: Recording; on: Recording }>>()
const both = (name: string) => {
  if (!runs.has(name)) {
    runs.set(
      name,
      (async () => {
        const off = await replay(environment, scenario(name), routeSide(OFF))
        const on = await replay(environment, scenario(name), routeSide(ON))
        return { off, on }
      })()
    )
  }
  return runs.get(name) as Promise<{ off: Recording; on: Recording }>
}
const differences = async (name: string, allowed = W42_DIFFERENCES.get(name) ?? []) => {
  const { off, on } = await both(name)
  return compareRecordings(off, on, allowed)
}

describe("W42: the saved card family, W11's code (card_moves off) against W42's (on)", () => {
  const names = Object.keys(SAVED_CARD_SCENARIOS)

  it.each(names)('%s: only its named differences', async (name) => {
    const found = await differences(name)
    if (process.env.W42_DUMP) for (const d of await differences(name, [])) appendFileSync(process.env.W42_DUMP, `${JSON.stringify({ name, ...d })}\n`)
    expect(found).toEqual([])
  })

  it('the family covers what W11 took and refused, and names Q19 and F4 / FB17', () => {
    expect(names).toEqual(['w42-card-save-no-membership', 'w42-card-save-one-membership', 'w42-card-save-another-customers-tap', 'w42-card-save-simulated-reader', 'w42-card-save-no-card-on-the-intent', 'w42-card-save-unknown-customer'])
    expect(Q19_SCENARIOS).toEqual(['w42-card-save-no-membership', 'w42-card-save-one-membership'])
    expect(FB17_SCENARIO).toBe('w42-card-save-another-customers-tap')
    for (const name of Q19_SCENARIOS) expect(W42_DIFFERENCES.get(name)?.every((allowance) => allowance.decision === Q19), name).toBe(true)
    expect(W42_DIFFERENCES.get(FB17_SCENARIO)?.map((allowance) => allowance.decision)).toEqual([FB17])
    expect(Q19).toContain('Q19')
    expect(Q19).toContain('Q45')
    expect(FB17).toContain('FB17')
    expect(FB17).toContain('F4')
    // The refusals W11 already made are the same on both sides, to the letter: nothing is allowed there.
    for (const name of names.filter((scenario) => !Q19_SCENARIOS.includes(scenario) && scenario !== FB17_SCENARIO)) expect(W42_DIFFERENCES.get(name), name).toBeUndefined()
  })

  it('what each side did, in a line: off saves the card and stops; on moves the memberships, and refuses the wrong tap', async () => {
    const one = await both('w42-card-save-one-membership')
    expect(one.off.stripeCalls.map((call) => call.method).filter((method) => /^(customers\.update|subscriptions\.)/.test(method))).toEqual([])
    expect(one.on.stripeCalls.map((call) => call.method).filter((method) => /^(customers\.update|subscriptions\.)/.test(method))).toEqual(['subscriptions.retrieve', 'subscriptions.update', 'customers.update'])
    expect(one.on.results[0]).toMatchObject({ saved_payment_method_id: 'pm_mos_new_card', membershipsMoved: 1, membershipsToMove: 0 })
    expect(Object.keys(one.off.results[0] as object).sort()).toEqual(['id', 'saved_card_brand', 'saved_card_last4', 'saved_payment_method_id', 'stripe_customer_id'])
    const wrong = await both(FB17_SCENARIO)
    expect(wrong.off.results[0]).toMatchObject({ saved_payment_method_id: 'pm_sams_card' })
    expect(wrong.on.results[0]).toEqual({ thrown: "This card was tapped for a different customer, so it can't be saved to this one. Nothing was saved. Start again from this customer's own page and ask them to tap their card." })
    expect(wrong.on.tables['customers']?.changed ?? []).toEqual([])
  })

  describe('the comparison bites', () => {
    it('with no allowances, Q19 and FB17 each show as differences', async () => {
      expect((await differences('w42-card-save-one-membership', [])).length).toBeGreaterThan(3)
      expect((await differences(FB17_SCENARIO, [])).length).toBeGreaterThan(0)
    })

    it('an allowance nothing needs fails: Q19 on a refusal that is the same on both sides, and FB17 on a tap that is the customer\'s own', async () => {
      const q19 = W42_DIFFERENCES.get('w42-card-save-one-membership') ?? []
      const fb17 = W42_DIFFERENCES.get(FB17_SCENARIO) ?? []
      const unused = await differences('w42-card-save-simulated-reader', q19)
      expect(unused.map((difference) => difference.path)).toEqual(q19.map((allowance) => `(allowed difference not seen: ${allowance.name})`))
      const alsoUnused = await differences('w42-card-save-one-membership', [...q19, ...fb17])
      expect(alsoUnused.map((difference) => difference.path)).toEqual(fb17.map((allowance) => `(allowed difference not seen: ${allowance.name})`))
    })

    it("a pinned difference takes no other value: a membership not moved, another card sent, the wrong tap saved after all", async () => {
      const { off, on } = await both('w42-card-save-one-membership')
      const allowed = W42_DIFFERENCES.get('w42-card-save-one-membership') ?? []
      const altered = (change: (recording: Recording) => void): Recording => {
        const copy = JSON.parse(JSON.stringify(on)) as Recording
        change(copy)
        return copy
      }
      // The answer says one is still to move.
      const notMoved = compareRecordings(off, altered((r) => Object.assign(r.results[0] as object, { membershipsMoved: 0, membershipsToMove: 1 })), allowed)
      expect(notMoved.map((difference) => difference.path)).toContain('.results[0].membershipsMoved')
      // The subscription is sent some other card.
      const otherCard = compareRecordings(off, altered((r) => {
        const update = r.stripeCalls.find((call) => call.method === 'subscriptions.update')
        ;(update?.params as Record<string, unknown>)['default_payment_method'] = 'pm_some_other_card'
      }), allowed)
      expect(otherCard.some((difference) => /^\.stripeCalls\[\d+\]$/.test(difference.path))).toBe(true)
      // The subscription is sent more than its card.
      const more = compareRecordings(off, altered((r) => {
        const update = r.stripeCalls.find((call) => call.method === 'subscriptions.update')
        ;(update?.params as Record<string, unknown>)['cancel_at'] = 1796860800
      }), allowed)
      expect(more.some((difference) => /^\.stripeCalls\[\d+\]$/.test(difference.path))).toBe(true)
      // FB17: the wrong tap saved after all (the off side's own recording put in the on side's place).
      const wrong = await both(FB17_SCENARIO)
      const saved = compareRecordings(wrong.off, wrong.off, W42_DIFFERENCES.get(FB17_SCENARIO) ?? [])
      expect(saved.map((difference) => difference.path)).toEqual((W42_DIFFERENCES.get(FB17_SCENARIO) ?? []).map((allowance) => `(allowed difference not seen: ${allowance.name})`))
    })
  })

  it("W11's reader scenarios that save a card with a payment are still held to their golden files by order-replay.test.ts", async () => {
    const { W11_KEPT } = await import('./order-differences')
    for (const name of ['w11-reader-save-card-reusable', 'w11-reader-save-card-simulated-reader', 'w11-reader-save-card-with-all-three', 'w11-reader-new-stripe-customer-saves-the-card', 'w11-reader-cancel-finds-it-paid-and-saves-the-card']) {
      expect(W11_KEPT, name).toContain(name)
    }
  })
})
