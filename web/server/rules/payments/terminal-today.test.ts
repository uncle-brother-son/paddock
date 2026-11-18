import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { replay, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ID, seed, seedExhaustedMembership } from '@/server/rules/testing/replay/scenarios'
import type { FakeStripe } from '@/server/stripe/fake'
import { saveCustomerCard } from './terminal'

// Brief W36 item 4 (F-plan 4.12 item 1: "today's outcome for each bug that can be recorded"). Two of step F's tracked
// items are in the saved card, which is already the Worker's own code (W11) behind a thin staff app call, so there is
// no old function to record a golden file from and nothing to freeze. This holds what the rule does today instead:
//
// - FB17 (W11 F4): the intent's Stripe customer is never compared with the customer being saved to.
// - Q19: a membership's subscription keeps charging its old card after the customer's card is replaced.
//
// W42 fixes both (F-plan 4.7) in server/rules/customers/saved-card.ts, behind its own switch kind `card_moves`. This
// function is kept exactly as it was, as what the route does with the kind off (a rollback of the moves alone), so
// these two tests stay as they are and now hold that: off, the card is saved as before W42. The fixed behaviour is
// held by customers/saved-card.test.ts, and the two set against each other by testing/replay/saved-card-replay.test.ts.

vi.setConfig({ testTimeout: 60_000 })

const BY = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'req-save-card' }

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  environment = await startReplay()
  db = environment.database.db
})
afterAll(() => environment.stop())

async function onASeed(work: (stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w36 the saved card today',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedExhaustedMembership(seedDb, stripe)
      },
      async run({ stripe }) {
        await work(stripe)
      },
    },
    (_db, stripe) => ({ name: 'test', call: async () => stripe })
  )
}

/** A card-save tap on the reader for `stripeCustomer`, which leaves the reusable card `card`. */
async function tapped(stripe: FakeStripe, stripeCustomer: string, card: string): Promise<string> {
  const intent = await stripe.setupIntents.create({ customer: stripeCustomer, payment_method_types: ['card_present'], usage: 'off_session' })
  stripe.completeReaderSetup(intent.id, { generatedCard: card })
  return intent.id
}

describe('the saved card as it was before W42, which is what `card_moves` off still does (F-plan 4.7)', () => {
  it("FB17 (W11 F4): another customer's card-save is saved to this customer, and nothing refuses it", async () => {
    await onASeed(async (stripe) => {
      // Mo taps her card (Stripe customer cus_member). The save names Sam.
      const setupIntentId = await tapped(stripe, 'cus_member', 'pm_mos_card')
      const saved = await saveCustomerCard(db, stripe, { customerId: ID.customer, setupIntentId }, BY)
      expect(saved).toMatchObject({ id: ID.customer, stripe_customer_id: 'cus_seed', saved_payment_method_id: 'pm_mos_card' })
      // Sam's row now names a card that belongs to Mo's Stripe customer: his next saved-card charge fails at Stripe.
      expect((await db.query<{ card: string }>('SELECT saved_payment_method_id AS card FROM customers WHERE id = $1', [ID.customer]))[0]?.card).toBe('pm_mos_card')
      expect((await db.query<{ card: string }>('SELECT saved_payment_method_id AS card FROM customers WHERE id = $1', [ID.member]))[0]?.card).toBe('pm_member')
      expect((await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'customer.card_saved'")).map((row) => row.details['paymentMethodId'])).toEqual(['pm_mos_card'])
    })
  })

  it("Q19: replacing Sam's card leaves his membership's subscription on its old card, with nothing listed", async () => {
    await onASeed(async (stripe) => {
      const before = stripe.subscriptionSettings('sub_exhausted')
      const setupIntentId = await tapped(stripe, 'cus_seed', 'pm_sams_new_card')
      const saved = await saveCustomerCard(db, stripe, { customerId: ID.customer, setupIntentId }, BY)
      expect(saved.saved_payment_method_id).toBe('pm_sams_new_card')
      // The subscription is as it was, and Stripe was asked nothing about it or about the customer's invoice default.
      expect(stripe.subscriptionSettings('sub_exhausted')).toEqual(before)
      expect(stripe.subscriptionSettings('sub_exhausted')?.defaultPaymentMethod).toBeNull()
      expect(stripe.calls.filter((call) => call.method.startsWith('subscriptions.') || call.method === 'customers.update')).toEqual([])
      expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'membership.step_left'")).toEqual([])
      // The answer says nothing about memberships (W42 adds how many moved and how many are still to move).
      expect(Object.keys(saved).sort()).toEqual(['id', 'saved_card_brand', 'saved_card_last4', 'saved_payment_method_id', 'stripe_customer_id'])
    })
  })
})
