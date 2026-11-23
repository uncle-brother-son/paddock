import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as savedCardRoute } from '@/app/api/v1/staff/customers/[customerId]/saved-card/route'
import { POST as setupIntentsRoute } from '@/app/api/v1/staff/terminal/setup-intents/route'
import { MEMBERSHIP_PATH_OFF_MESSAGE } from '@/server/rules/memberships/failure-messages'
import type { Db } from '@/server/db'
import * as terminal from './terminal'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, seed, seedExhaustedMembership } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import type { FakeStripe } from '@/server/stripe/fake'

// Brief W36 item 4 (F-plan 4.12 item 1) held two of the old saved card's bugs here (W11's `saveCustomerCard`, kept by W42 as
// what the route did with `card_moves` off):
//
// - FB17 (W11 F4): the intent's Stripe customer was never compared with the customer being saved to.
// - Q19: a membership's subscription kept charging its old card after the customer's card was replaced.
//
// W68 (H5; the W45 audit's row 50): that function is gone. With the kind off the save is refused, so neither can happen
// whatever the switch says; the same two presses hold that here. The save itself is held by customers/saved-card.test.ts.

vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal())
})

const KEY = 'test-staff-api-key'
/** Live's value with `card_moves` taken out (the emergency stop). */
const MOVES_OFF = 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels,membership_changes,payment_date_changes,lapse_sweep,payment_retries,plan_changes'

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => {
  replayStripe.current = null
  vi.unstubAllEnvs()
  return environment.stop()
})

async function onASeed(work: (stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w36 the saved card with card_moves off',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedExhaustedMembership(seedDb, stripe)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        vi.stubEnv('ORDER_SWITCH', MOVES_OFF)
        try {
          await work(stripe)
        } finally {
          replayStripe.current = null
        }
      },
    },
    workerSide()
  )
}

/** A card-save tap on the reader for `stripeCustomer`, which leaves the reusable card `card`. */
async function tapped(stripe: FakeStripe, stripeCustomer: string, card: string): Promise<string> {
  const intent = await stripe.setupIntents.create({ customer: stripeCustomer, payment_method_types: ['card_present'], usage: 'off_session' })
  stripe.completeReaderSetup(intent.id, { generatedCard: card })
  return intent.id
}

async function save(customerId: string, setupIntentId: string): Promise<{ status: number; error?: { code: string; message: string } }> {
  const response = await savedCardRoute(
    new Request(`https://worker.test/api/v1/staff/customers/${customerId}/saved-card`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ setupIntentId }),
    }),
    { params: Promise.resolve({ customerId }) }
  )
  return { status: response.status, ...((await response.json()) as { error?: { code: string; message: string } }) }
}
const cardOf = async (customerId: string) => (await db.query<{ card: string }>('SELECT saved_payment_method_id AS card FROM customers WHERE id = $1', [customerId]))[0]?.card

describe('the saved card with `card_moves` off (W68, H5): refused, never saved the old way', () => {
  it('W68a (W68 noticed 1): refused before any tap: the setup intent itself answers the switched-off words, whoever the customer is; Stripe is asked nothing and nothing is written; with the kind on it is made', async () => {
    await onASeed(async (stripe) => {
      const setupIntent = async (body: unknown) => {
        const response = await setupIntentsRoute(
          new Request('https://worker.test/api/v1/staff/terminal/setup-intents', {
            method: 'POST',
            headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        )
        return { status: response.status, ...((await response.json()) as { data?: { clientSecret?: string }; error?: { code: string; message: string; details?: unknown } }) }
      }
      const customers = await db.query('SELECT * FROM customers ORDER BY id')
      // One with a Stripe customer, one whose Stripe customer would be made, one that isn't there.
      await db.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.member])
      const before = await db.query('SELECT * FROM customers ORDER BY id')
      expect(before).not.toEqual(customers)
      for (const customerId of [ID.customer, ID.member, '10000000-0000-4000-8000-0000000000ff']) {
        const answer = await setupIntent({ customerId })
        expect([answer.status, answer.error], customerId).toEqual([
          501,
          { code: 'MEMBERSHIP_PATH_OFF', message: MEMBERSHIP_PATH_OFF_MESSAGE, details: { reason: 'membership_path_off', message: MEMBERSHIP_PATH_OFF_MESSAGE, kinds: ['card_moves'] } },
        ])
      }
      expect(stripe.calls).toEqual([])
      expect(await db.query('SELECT * FROM customers ORDER BY id')).toEqual(before)
      vi.stubEnv('ORDER_SWITCH', `${MOVES_OFF},card_moves`)
      const made = await setupIntent({ customerId: ID.customer })
      expect([made.status, typeof made.data?.clientSecret]).toEqual([200, 'string'])
    })
  })

  it("FB17 (W11 F4): another customer's card-save is not saved to this customer", async () => {
    await onASeed(async (stripe) => {
      // Mo taps her card (Stripe customer cus_member). The save names Sam.
      const answer = await save(ID.customer, await tapped(stripe, 'cus_member', 'pm_mos_card'))
      expect([answer.status, answer.error?.code]).toEqual([501, 'MEMBERSHIP_PATH_OFF'])
      expect(await cardOf(ID.customer)).toBe('pm_seed')
      expect(await cardOf(ID.member)).toBe('pm_member')
      expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'customer.card_saved'")).toEqual([])
    })
  })

  it("Q19: Sam's card isn't replaced, so it never differs from the one his membership's subscription renews on; Stripe is asked nothing", async () => {
    await onASeed(async (stripe) => {
      const before = stripe.subscriptionSettings('sub_exhausted')
      const setupIntentId = await tapped(stripe, 'cus_seed', 'pm_sams_new_card')
      const calls = stripe.calls.length
      expect((await save(ID.customer, setupIntentId)).status).toBe(501)
      expect(await cardOf(ID.customer)).toBe('pm_seed')
      expect(stripe.subscriptionSettings('sub_exhausted')).toEqual(before)
      expect(stripe.calls).toHaveLength(calls)
      expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'membership.step_left'")).toEqual([])
    })
  })

  it('the old save is gone from payments/terminal.ts', () => {
    expect(Object.keys(terminal).sort()).toEqual(['DEFAULT_TERMINAL_LOCATION_ID', 'SETUP_NOT_SENT_REASON', 'terminalConnectionToken', 'terminalSetupIntent'])
  })
})
