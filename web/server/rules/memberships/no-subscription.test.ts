import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as cancelRoute } from '@/app/api/v1/staff/memberships/[membershipId]/cancel/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { insert } from '@/server/rules/testing/database'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, MO_SUBSCRIPTION, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import type { FakeStripe } from '@/server/stripe/fake'
import { endMembershipWithoutSubscription, MAX_ENDINGS_PER_RUN, MEMBERSHIP_ENDED_ACTION, membershipsToEnd } from './no-subscription'

// Brief W46 item 3 (G-plan 2.1; W45a "Noticed" 8, the W45 audit's S1, way 3): a membership with no Stripe subscription
// is marked cancelled once its last day has passed. Before W46 nothing ever ended one: Cancel set its last day (no
// Stripe step: there is no subscription), and the row read "active" for ever with that day behind it. Through
// reconcile's run on the replay's live schema; the first test cancels through the real route.

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

const KEY = 'test-staff-api-key'
const MEMBER_STRIPE_CUSTOMER = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
/** Credit bookings of Mo's: on his last day (9 December) and after it (15 December). */
const ON_LAST_DAY = '10000000-0000-4000-8000-0000000000a1'
const AFTER_LAST_DAY = '10000000-0000-4000-8000-0000000000a2'

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

/**
 * The replay's seed, where Mo's membership has no Stripe subscription (started 10 January, next payment 10 December),
 * with two credit bookings of his: 9 December and 15 December. Today is 10 November.
 */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w46 no subscription',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = NULL, next_renewal_date = '2026-12-10' WHERE id = $1", [ID.membership])
        for (const [id, day] of [[ON_LAST_DAY, '2026-12-09'], [AFTER_LAST_DAY, '2026-12-15']] as const) {
          const slot = { start_time: `${day} 10:00:00+00`, end_time: `${day} 11:00:00+00` }
          await insert(seedDb, 'sessions', { id, service_type_id: ID.serviceType, type: 'public', capacity: 10, band_id: ID.band, ...slot })
          await insert(seedDb, 'bookings', { session_id: id, customer_id: ID.member, party_size: 1, status: 'confirmed', price_paid: '0', redemption_source: 'membership_credit', redeemed_membership_id: ID.membership, ...slot })
        }
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        vi.stubEnv('ORDER_SWITCH', 'membership_changes')
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

async function pressCancel(): Promise<number> {
  vi.setSystemTime(Date.now() + 1000)
  const membershipId = ID.membership as string
  const response = await cancelRoute(
    new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ membershipId }) }
  )
  return response.status
}

const SYSTEM = { type: 'system' as const, id: null }
const reconcileNow = (stripe: FakeStripe, actor: { type: 'staff' | 'system'; id: string | null } = SYSTEM, requestId: string = crypto.randomUUID()) => reconcile(db, stripe, { actor, requestId, maxItems: 50, budgetMs: 60_000 })
const row = async (membershipId: string = ID.membership) =>
  (await db.query<{ status: string; ends: string | null }>('SELECT subscription_status AS status, cancel_effective_date::text AS ends FROM customer_memberships WHERE id = $1', [membershipId]))[0]
const setRow = (fields: { status?: string; ends?: string | null; subscription?: string | null }, membershipId: string = ID.membership) =>
  db.query('UPDATE customer_memberships SET subscription_status = COALESCE($1, subscription_status), cancel_effective_date = $2::date, stripe_subscription_id = $3 WHERE id = $4', [fields.status ?? null, fields.ends ?? null, fields.subscription ?? null, membershipId])
const booking = async (sessionId: string) => (await db.query<{ status: string; due: boolean }>('SELECT status, payment_due_by IS NOT NULL AS due FROM bookings WHERE session_id = $1', [sessionId]))[0]
const endedRows = () => db.query<{ actor_type: string; actor_id: string | null; entity_type: string; entity_id: string; request_id: string; details: Record<string, unknown> }>('SELECT actor_type, actor_id, entity_type, entity_id, request_id, details FROM audit_log WHERE action = $1 ORDER BY at, ctid', [MEMBERSHIP_ENDED_ACTION])
const runRows = () => db.query<{ entity_id: string; details: Record<string, unknown> }>("SELECT entity_id, details FROM audit_log WHERE action = 'order.reconcile' AND entity_type = 'membership_step' ORDER BY at, ctid")
const memberLevel = async () => (await db.query<{ level: string | null }>('SELECT public.event_member_level($1) AS level', [ID.member]))[0]?.level ?? null
const LAST_DAY_PASSED = new Date('2026-12-10T00:05:00.000Z')
const detailFor = (flagged: number) => `membership ${ID.membership} has no Stripe subscription and its last day (2026-12-09) has passed: marked cancelled${flagged > 0 ? `, ${flagged} credit booking${flagged === 1 ? '' : 's'} after that day now payment needed` : ''}`

describe('W46: a membership with no Stripe subscription is marked cancelled once its last day has passed', () => {
  it("cancelled through the real route (no Stripe step: there is no subscription); on its last day it is still active; the first run after that day marks it cancelled, keeps the day, flags the credit booking after it and leaves the one on it, with one audit row and no Stripe call; the next run finds nothing", async () => {
    await onASeed(async (stripe) => {
      expect(await pressCancel()).toBe(200)
      expect(await row()).toEqual({ status: 'active', ends: '2026-12-09' })
      expect(stripe.calls).toEqual([])
      // Still to come: nothing is due, today or on the last day itself (23:55 on 9 December).
      expect((await reconcileNow(stripe)).items).toEqual([])
      vi.setSystemTime(new Date('2026-12-09T23:55:00.000Z'))
      expect(await membershipsToEnd(db)).toEqual([])
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await row()).toEqual({ status: 'active', ends: '2026-12-09' })
      // 10 December, 00:05: the day after. Before W46 the row stayed active from here on, for ever.
      vi.setSystemTime(LAST_DAY_PASSED)
      expect(await membershipsToEnd(db)).toEqual([ID.membership])
      const run = await reconcileNow(stripe, SYSTEM, 'run-ends-it')
      expect(run.items).toEqual([{ kind: 'step', id: ID.membership, outcome: 'finalised', detail: detailFor(1) }])
      expect(run).toMatchObject({ checked: 1, finalised: 1, left: 0, deferred: 0 })
      expect(await row()).toEqual({ status: 'cancelled', ends: '2026-12-09' })
      expect(await booking(ON_LAST_DAY)).toEqual({ status: 'confirmed', due: false })
      expect(await booking(AFTER_LAST_DAY)).toEqual({ status: 'payment_needed', due: true })
      expect(await endedRows()).toEqual([
        { actor_type: 'system', actor_id: null, entity_type: 'membership', entity_id: ID.membership, request_id: 'run-ends-it', details: { lastDay: '2026-12-09', was: 'active', bookingsFlagged: 1 } },
      ])
      expect(await runRows()).toEqual([{ entity_id: ID.membership, details: { outcome: 'finalised', detail: detailFor(1) } }])
      expect(await memberLevel()).toBeNull()
      // Nothing was asked of Stripe, and nothing is listed.
      expect(stripe.calls).toEqual([])
      expect((await stuckList(db)).steps).toEqual([])
      // The next runs: nothing due, nothing written.
      expect(await membershipsToEnd(db)).toEqual([])
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await endedRows()).toHaveLength(1)
      // The credit allocation and the hourly job run as for any ended membership.
      await db.query('SELECT public.allocate_membership_credit_periods()')
      await db.query('SELECT public.run_membership_maintenance()')
    })
  })

  it("on staff's Resolve now the row is the staff member's", async () => {
    await onASeed(async (stripe) => {
      await setRow({ ends: '2026-12-09' })
      vi.setSystemTime(LAST_DAY_PASSED)
      await reconcileNow(stripe, { type: 'staff', id: ID.staff }, 'resolve-now')
      expect(await endedRows()).toMatchObject([{ actor_type: 'staff', actor_id: ID.staff, request_id: 'resolve-now' }])
      expect(await row()).toEqual({ status: 'cancelled', ends: '2026-12-09' })
    })
  })

  it.each([
    ['it has a subscription (Stripe ends those; the check lists a row that disagrees)', { ends: '2026-12-09', subscription: MO_SUBSCRIPTION }],
    ['it has no last day', { ends: null }],
    ['its last day is today', { ends: '2026-12-10' }],
    ['its last day is still to come', { ends: '2027-01-09' }],
    ['it is past due', { ends: '2026-12-09', status: 'past_due' }],
    ['it is paused', { ends: '2026-12-09', status: 'paused' }],
    ['it has ended already', { ends: '2026-12-09', status: 'cancelled' }],
  ] as const)('left alone: %s', async (_name, fields) => {
    await onASeed(async (stripe) => {
      if ('subscription' in fields) stripe.addSubscription(MO_SUBSCRIPTION, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
      await setRow(fields)
      const before = await row()
      vi.setSystemTime(LAST_DAY_PASSED)
      expect(await membershipsToEnd(db)).toEqual([])
      expect((await reconcileNow(stripe)).items.filter((item) => item.id === ID.membership)).toEqual([])
      expect(await row()).toEqual(before)
      expect(await endedRows()).toEqual([])
      expect(await booking(AFTER_LAST_DAY)).toEqual({ status: 'confirmed', due: false })
    })
  })

  it('a subscription id that is an empty string is no subscription', async () => {
    await onASeed(async (stripe) => {
      await setRow({ ends: '2026-12-09', subscription: '' })
      vi.setSystemTime(LAST_DAY_PASSED)
      expect((await reconcileNow(stripe)).items).toMatchObject([{ id: ID.membership, outcome: 'finalised' }])
      expect((await row())?.status).toBe('cancelled')
    })
  })

  it('looked at again under its lock: one that is given a subscription between the read and the lock is not ended, and nothing is written', async () => {
    await onASeed(async (stripe) => {
      await setRow({ ends: '2026-12-09' })
      vi.setSystemTime(LAST_DAY_PASSED)
      expect(await membershipsToEnd(db)).toEqual([ID.membership])
      await setRow({ ends: '2026-12-09', subscription: MO_SUBSCRIPTION })
      expect(await endMembershipWithoutSubscription(db, ID.membership, { actor: SYSTEM, requestId: 'late' })).toEqual({ ended: false })
      expect(await row()).toEqual({ status: 'active', ends: '2026-12-09' })
      expect(await endedRows()).toEqual([])
      expect(stripe.calls).toEqual([])
    })
  })

  it('ended once: two runs at the same moment write one row between them', async () => {
    await onASeed(async () => {
      await setRow({ ends: '2026-12-09' })
      vi.setSystemTime(LAST_DAY_PASSED)
      const by = { actor: SYSTEM, requestId: 'twice' }
      const both = [await endMembershipWithoutSubscription(db, ID.membership, by), await endMembershipWithoutSubscription(db, ID.membership, by)]
      expect(both).toEqual([{ ended: true, lastDay: '2026-12-09', bookingsFlagged: 1 }, { ended: false }])
      expect(await endedRows()).toHaveLength(1)
    })
  })

  it(`the cap: a run ends at most ${MAX_ENDINGS_PER_RUN}, oldest last day first; the rest go with the next run`, async () => {
    await onASeed(async (stripe) => {
      const ids: string[] = []
      for (let i = 0; i < MAX_ENDINGS_PER_RUN + 2; i++) {
        const id = `10000000-0000-4000-8000-0000000b${String(i).padStart(4, '0')}`
        ids.push(id)
        // The first has the latest last day (8 December), the last the earliest.
        await insert(db, 'customer_memberships', { id, customer_id: ID.customer, plan_id: ID.plan, start_date: '2026-02-10', next_renewal_date: '2026-12-10', subscription_status: 'active', billing_frequency: 'monthly', is_herd: false, addon_credits_remaining: 0, cancel_effective_date: `2026-11-${String(30 - i).padStart(2, '0')}` })
      }
      vi.setSystemTime(LAST_DAY_PASSED)
      const first = await reconcileNow(stripe)
      const oldestFirst = [...ids].reverse()
      expect(first.items.map((item) => item.id)).toEqual(oldestFirst.slice(0, MAX_ENDINGS_PER_RUN))
      expect(first.items.every((item) => item.outcome === 'finalised')).toBe(true)
      const second = await reconcileNow(stripe)
      expect(second.items.map((item) => item.id)).toEqual(oldestFirst.slice(MAX_ENDINGS_PER_RUN))
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await endedRows()).toHaveLength(MAX_ENDINGS_PER_RUN + 2)
      expect(stripe.calls).toEqual([])
    })
  })
})
