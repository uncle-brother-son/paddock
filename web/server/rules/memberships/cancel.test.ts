import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as customerRoute } from '@/app/api/v1/staff/customers/[customerId]/route'
import { POST as cancelRoute } from '@/app/api/v1/staff/memberships/[membershipId]/cancel/route'
import { POST as undoRoute } from '@/app/api/v1/staff/memberships/[membershipId]/undo-cancel/route'
import { GET as listRoute } from '@/app/api/v1/staff/memberships/route'
import { membershipListRowSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { closeStuckItem } from '@/server/rules/orders/close-stuck'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { insert } from '@/server/rules/testing/database'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ID, MO_SUBSCRIPTION, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import type { StripeClient } from '@/server/stripe/client'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { CANCEL_PUT_BACK_ACTION, CANCEL_SCHEDULED_ACTION, CANCEL_UNDONE_ACTION, cancelMembership, membershipEnd, undoMembershipCancel, type CancelOptions } from './cancel'
import { LEFT_STEP_WORDS, MEMBERSHIP_CANCEL_DIALOG_WORDS, MEMBERSHIP_CANCEL_NEW_WORDS, MEMBERSHIP_CANCEL_WORDS, MEMBERSHIP_PATH_OFF_MESSAGE } from './failure-messages'
import { CHECK_AFTER_MINUTES, CHECK_UNREAD_HOURS, STEP_CHECK_ACTION, STEP_LEFT_ACTION } from './left'
import { CUSTOMER_MEMBERSHIP_COLUMNS, MEMBERSHIP_LIST_COLUMNS } from './list'

// Brief W40 items 4, 5, 8 and 10 (F-plan 4.3; bugs FB5, FB6, FB20, FB22; Q33; W35 rows 9 and 10; W36 review S1, L1):
// a membership's cancel and undo, and the membership reads, through the Worker's routes on the replay's live schema
// with the fake Stripe. What must hold: the database changes first, in one transaction with its audit row and its
// Stripe step; Stripe is asked only for the membership's own subscription, with no proration; a refusal by Stripe
// puts the database back; no clear answer leaves the step for reconcile, which reads before it sends; two changes to
// one membership take turns; and nothing here ever charges or refunds.

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
const NO_REFUNDS = 'front.desk@example.com'
const INACTIVE = 'gone@example.com'
const MEMBER_STRIPE_CUSTOMER = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
/** 10 December 2026, 00:00 in London: when Mo's membership (started 10 January, renewing on the 10th) ends if cancelled today. */
const ENDS = 1796860800
const WINDOW_MS = 15 * 60_000
const pastTheWindow = () => vi.setSystemTime(Date.now() + WINDOW_MS + 60_000)

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

type Prepare = (seedDb: Db, stripe: FakeStripe) => Promise<void> | void

/** The replay's seed with Mo's membership as live ones are (a Stripe subscription, its next payment on 10 December), two more staff, then `prepare`, then `work`. */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>, prepare?: Prepare): Promise<void> {
  await replay(
    environment,
    {
      name: 'w40 cancel',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
        stripe.addSubscription(MO_SUBSCRIPTION, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
        await insert(seedDb, 'staff', { first_name: 'Fran', last_name: 'Desk', email: NO_REFUNDS, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        await insert(seedDb, 'staff', { first_name: 'Gone', last_name: 'Away', email: INACTIVE, role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: false })
        await prepare?.(seedDb, stripe)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        // The harness's old side switches every kind off for its own calls; these presses run with the kind on.
        vi.stubEnv('ORDER_SWITCH', 'membership_changes')
        try {
          await work(stripe)
        } finally {
          replayStripe.current = null
        }
      },
    },
    oldSide
  )
}

type ErrorBody = { code: string; message: string; details?: { reason?: string; message?: string; action?: string; kinds?: string[] } }
type Answer = { status: number; replayed: boolean; data?: Record<string, unknown>; error?: ErrorBody }

async function press(route: 'cancel' | 'undo-cancel', { membershipId = ID.membership as string, email = REPLAY_USER.email, key = crypto.randomUUID() as string | null } = {}): Promise<Answer> {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  const response = await (route === 'cancel' ? cancelRoute : undoRoute)(
    new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, ...(key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ membershipId }) }
  )
  const body = (await response.json()) as { data?: Record<string, unknown>; error?: ErrorBody }
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', ...body }
}
const refusalOf = (answer: Answer) => [answer.status, answer.error?.code, answer.error?.details?.reason, answer.error?.details?.message]

const lastDay = async (membershipId: string = ID.membership) =>
  (await db.query<{ ends: string | null }>('SELECT cancel_effective_date::text AS ends FROM customer_memberships WHERE id = $1', [membershipId]))[0]?.ends ?? null
type AuditRow = { action: string; actor_type: string; actor_id: string | null; entity_type: string; entity_id: string; details: Record<string, unknown> }
const audited = (action: string) => db.query<AuditRow>('SELECT action, actor_type, actor_id, entity_type, entity_id, details FROM audit_log WHERE action = $1 ORDER BY at', [action])
const cancelRows = async () => [...(await audited(CANCEL_SCHEDULED_ACTION)), ...(await audited(CANCEL_UNDONE_ACTION)), ...(await audited(CANCEL_PUT_BACK_ACTION))]
const stepStates = async () => (await audited(STEP_LEFT_ACTION)).map((row) => [row.details['stepId'], row.details['state']] as [string, string])
const statesOf = async (stepId: string) => (await stepStates()).filter(([id]) => id === stepId).map(([, state]) => state).sort()
const paramsOf = (call: { params: unknown } | undefined): Record<string, unknown> => (call?.params ?? {}) as Record<string, unknown>
const updates = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.update')
const listed = async () => (await stuckList(db)).steps
/** W46 (W40b "Noticed" 2): the list's line for a wish a run could not leave again: still being tried, so no close. */
const notLeftAgainLine = (stepId: string) => ({ stepId, membershipId: ID.membership, subscriptionId: MO_SUBSCRIPTION, step: 'cancel_at', what: 'cancel_date', lastDay: '2026-12-09', customerId: ID.member, customerName: 'Mo Member', state: 'left', at: expect.any(String), words: LEFT_STEP_WORDS.notLeftAgain(MO_SUBSCRIPTION) })
const reconcileNow = (stripe: FakeStripe, requestId: string = crypto.randomUUID()) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId, maxItems: 50, budgetMs: 60_000 })
const no = () => ({ kind: 'error' as const, error: fakeStripeErrors.invalid('subscription_update_refused', 'This subscription cannot be updated right now.') })
const noAnswer = () => ({ kind: 'error' as const, error: fakeStripeErrors.server() })
const set = (sql: string): Prepare => async (seedDb) => void (await seedDb.query(sql, [ID.membership]))
/** What Stripe's webhook does for a customer.subscription.updated event (app/api/stripe/webhook/dispatch.ts): the database's own function. */
const webhook = (cancelAt: number | null) =>
  db.query('SELECT membership_sync_cancel_at_period_end($1, false, $2::timestamptz, $3::timestamptz)', [MO_SUBSCRIPTION, cancelAt === null ? null : new Date(cancelAt * 1000).toISOString(), new Date(ENDS * 1000).toISOString()])

/**
 * The fake as the route reaches it, with `gap` run once just before its first `subscriptions.retrieve`: what happens
 * between a press's M1 and its Stripe step (another press, a webhook).
 */
function withGapBeforeStripe(stripe: FakeStripe, gap: () => Promise<unknown>): StripeClient {
  let fired = false
  const real = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const subscriptions = {
    ...real,
    retrieve: async (...args: unknown[]) => {
      if (!fired) {
        fired = true
        await gap()
      }
      return (real['retrieve'] as (...a: unknown[]) => Promise<unknown>)(...args)
    },
  }
  return new Proxy(stripe, { get: (target, prop) => (prop === 'subscriptions' ? subscriptions : Reflect.get(target, prop)) }) as unknown as StripeClient
}

describe('the end date (Q33, FB6): monthly, the later of start + 2 months, clamped, and the next renewal; yearly, the next renewal', () => {
  const monthly = (startDate: string, nextRenewalDate: string) => membershipEnd({ startDate, nextRenewalDate, billingFrequency: 'monthly' })
  const midnight = (isoDate: string, utcHour: number) => Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)), utcHour) / 1000

  it('after the minimum term the end is the next renewal; inside it, start + 2 months; the last day of access is the day before; Stripe is sent London midnight', () => {
    expect(monthly('2026-01-10', '2026-12-10')).toEqual({ endDate: '2026-12-10', cancelEffectiveDate: '2026-12-09', cancelAt: ENDS })
    expect(monthly('2026-10-25', '2026-11-25')).toEqual({ endDate: '2026-12-25', cancelEffectiveDate: '2026-12-24', cancelAt: midnight('2026-12-25', 0) })
    // The second payment has been taken: the minimum term's end is the next renewal itself.
    expect(monthly('2026-10-10', '2026-12-10').endDate).toBe('2026-12-10')
    // In summer, London midnight is 23:00 UTC the day before.
    expect(monthly('2026-05-15', '2026-06-15')).toEqual({ endDate: '2026-07-15', cancelEffectiveDate: '2026-07-14', cancelAt: midnight('2026-07-14', 23) })
    // The first of a month: the last day is the last of the month before.
    expect(monthly('2026-01-01', '2026-03-01').cancelEffectiveDate).toBe('2026-02-28')
  })

  it('yearly: the next renewal, with no minimum term; anything that is not yearly is monthly, as the old code took it', () => {
    expect(membershipEnd({ startDate: '2026-11-01', nextRenewalDate: '2027-11-01', billingFrequency: 'yearly' })).toEqual({ endDate: '2027-11-01', cancelEffectiveDate: '2027-10-31', cancelAt: midnight('2027-11-01', 0) })
    expect(membershipEnd({ startDate: '2026-10-25', nextRenewalDate: '2026-11-25', billingFrequency: null }).endDate).toBe('2026-12-25')
  })

  it('FB6: a start on a day the end month does not have ends on that month\'s last day, where the old sum rolled over (31 July: 1 October; 31 December: 3 March)', () => {
    // 31 July + 2 months: 30 September (September has 30 days). The old sum gave 1 October.
    expect(monthly('2026-07-31', '2026-08-31')).toEqual({ endDate: '2026-09-30', cancelEffectiveDate: '2026-09-29', cancelAt: midnight('2026-09-29', 23) })
    // 29, 30 and 31 December 2026 + 2 months: 28 February 2027. The old sum gave 1, 2 and 3 March.
    for (const day of ['29', '30', '31']) {
      expect(monthly(`2026-12-${day}`, `2027-01-${day}`), day).toEqual({ endDate: '2027-02-28', cancelEffectiveDate: '2027-02-27', cancelAt: midnight('2027-02-28', 0) })
    }
    // A leap year: 29 December 2027 lands on 29 February 2028 itself; 30 and 31 December are clamped to it.
    for (const day of ['29', '30', '31']) expect(monthly(`2027-12-${day}`, `2028-01-${day}`).endDate, day).toBe('2028-02-29')
    // 28 December is never clamped.
    expect(monthly('2026-12-28', '2027-01-28').endDate).toBe('2027-02-28')
    expect(monthly('2027-12-28', '2028-01-28').endDate).toBe('2028-02-28')
    // Once the renewal is past the minimum term, the renewal wins as ever.
    expect(monthly('2026-12-31', '2027-03-31').endDate).toBe('2027-03-31')
  })
})

describe('cancel and undo: the database first, then Stripe (F-plan 4.3)', () => {
  it('cancels a monthly membership after its minimum term: one transaction writes the last day, the audit row with the cancel_at it will send and the Stripe step; then Stripe is read and sent the date with no proration (L1); the step is done', async () => {
    await onASeed(async (stripe) => {
      const answer = await press('cancel')
      expect(answer.status).toBe(200)
      expect(answer.data).toEqual({ membership: { id: ID.membership, cancel_effective_date: '2026-12-09', billing_frequency: 'monthly' }, endDate: '2026-12-10', stripeUpdated: true })
      expect(await lastDay()).toBe('2026-12-09')
      const [[stepId]] = (await stepStates()) as [[string, string]]
      expect(await statesOf(stepId)).toEqual(['done', 'left'])
      expect(stripe.calls).toEqual([
        { method: 'subscriptions.retrieve', params: { id: MO_SUBSCRIPTION }, idempotencyKey: null },
        { method: 'subscriptions.update', params: { id: MO_SUBSCRIPTION, cancel_at: ENDS, proration_behavior: 'none' }, idempotencyKey: `${stepId}:cancel-at` },
      ])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await cancelRows()).toEqual([
        {
          action: CANCEL_SCHEDULED_ACTION,
          actor_type: 'staff',
          actor_id: ID.staff,
          entity_type: 'membership',
          entity_id: ID.membership,
          details: { channel: 'staff', cancelAt: ENDS, endDate: '2026-12-10', cancelEffectiveDate: { before: null, after: '2026-12-09' }, subscriptionId: MO_SUBSCRIPTION, stepId },
        },
      ])
      // The membership stays active, with its credits, until then; nothing is listed; nothing was charged or refunded.
      expect(await db.query('SELECT subscription_status, addon_credits_remaining FROM customer_memberships WHERE id = $1', [ID.membership])).toEqual([{ subscription_status: 'active', addon_credits_remaining: 2 }])
      expect(await listed()).toEqual([])
      expect(stripe.netPence).toBe(0)
    })
  })

  it('inside the minimum term the end is start + 2 months, not the next renewal; yearly ends at the next renewal', async () => {
    await onASeed(
      async (stripe) => {
        const answer = await press('cancel')
        expect(answer.data).toMatchObject({ membership: { cancel_effective_date: '2026-12-24' }, endDate: '2026-12-25', stripeUpdated: true })
        expect(updates(stripe)[0]?.params).toMatchObject({ cancel_at: Date.UTC(2026, 11, 25) / 1000, proration_behavior: 'none' })
      },
      set("UPDATE customer_memberships SET start_date = '2026-10-25', next_renewal_date = '2026-11-25' WHERE id = $1")
    )
    await onASeed(
      async (stripe) => {
        const answer = await press('cancel')
        expect(answer.data).toMatchObject({ membership: { cancel_effective_date: '2027-10-31', billing_frequency: 'yearly' }, endDate: '2027-11-01', stripeUpdated: true })
        expect(updates(stripe)[0]?.params).toMatchObject({ cancel_at: Date.UTC(2027, 10, 1) / 1000 })
      },
      set("UPDATE customer_memberships SET billing_frequency = 'yearly', start_date = '2026-11-01', next_renewal_date = '2027-11-01' WHERE id = $1")
    )
  })

  it('FB6 through the route: started 31 December, cancelled in January, the last day is 27 February and Stripe is sent 28 February (the old code: 3 March, and a part-month charge of about £3.87 on a £40 plan)', async () => {
    await onASeed(
      async (stripe) => {
        vi.setSystemTime(new Date('2027-01-15T10:00:00.000Z'))
        const answer = await press('cancel')
        expect(answer.data).toMatchObject({ membership: { cancel_effective_date: '2027-02-27' }, endDate: '2027-02-28' })
        expect(updates(stripe)[0]?.params).toEqual({ id: MO_SUBSCRIPTION, cancel_at: Date.UTC(2027, 1, 28) / 1000, proration_behavior: 'none' })
      },
      set("UPDATE customer_memberships SET start_date = '2026-12-31', next_renewal_date = '2027-01-31' WHERE id = $1")
    )
  })

  it('undo clears the date in one transaction with its audit row and step, then clears cancel_at in Stripe; a cancel can then be scheduled again', async () => {
    await onASeed(async (stripe) => {
      await press('cancel')
      const undone = await press('undo-cancel')
      expect(undone.status).toBe(200)
      // The old undo answered the row alone.
      expect(undone.data).toEqual({ membership: { id: ID.membership, cancel_effective_date: null, billing_frequency: 'monthly' } })
      expect(await lastDay()).toBeNull()
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      expect(updates(stripe).map((call) => call.params)).toEqual([
        { id: MO_SUBSCRIPTION, cancel_at: ENDS, proration_behavior: 'none' },
        { id: MO_SUBSCRIPTION, cancel_at: '', proration_behavior: 'none' },
      ])
      const [undo] = await audited(CANCEL_UNDONE_ACTION)
      expect(undo).toMatchObject({ actor_type: 'staff', actor_id: ID.staff, entity_id: ID.membership, details: { channel: 'staff', cancelAt: null, cancelEffectiveDate: { before: '2026-12-09', after: null }, subscriptionId: MO_SUBSCRIPTION } })
      expect(undo?.details).not.toHaveProperty('endDate')
      expect((await stepStates()).map(([, state]) => state).sort()).toEqual(['done', 'done', 'left', 'left'])
      expect(await listed()).toEqual([])
      expect((await press('cancel')).data).toMatchObject({ membership: { cancel_effective_date: '2026-12-09' }, stripeUpdated: true })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
    })
  })

  it('a membership with no subscription: M1 only, as before. Nothing is asked of Stripe and no step is left', async () => {
    await onASeed(
      async (stripe) => {
        expect((await press('cancel')).data).toEqual({ membership: { id: ID.membership, cancel_effective_date: '2026-12-09', billing_frequency: 'monthly' }, endDate: '2026-12-10', stripeUpdated: false })
        expect((await audited(CANCEL_SCHEDULED_ACTION))[0]?.details).toMatchObject({ subscriptionId: null, stepId: null, cancelAt: ENDS })
        expect((await press('undo-cancel')).data).toEqual({ membership: { id: ID.membership, cancel_effective_date: null, billing_frequency: 'monthly' } })
        expect(stripe.calls).toEqual([])
        expect(await stepStates()).toEqual([])
      },
      set('UPDATE customer_memberships SET stripe_subscription_id = NULL WHERE id = $1')
    )
  })

  it("W35 row 9: a subscription that names no order. The subscription is found from the membership's own row, never by its order: Stripe is asked for that id alone, and never to list or search", async () => {
    await onASeed(async (stripe) => {
      // As the old createOrder made them: no metadata.order_id on the subscription, and no order line on the membership.
      const subscription = (await stripe.subscriptions.retrieve(MO_SUBSCRIPTION)) as unknown as { metadata?: Record<string, string> | null }
      expect(subscription.metadata?.['order_id']).toBeUndefined()
      expect(await db.query('SELECT order_line_item_id FROM customer_memberships WHERE id = $1', [ID.membership])).toEqual([{ order_line_item_id: null }])
      const before = stripe.calls.length
      expect((await press('cancel')).data).toMatchObject({ stripeUpdated: true })
      expect((await press('undo-cancel')).status).toBe(200)
      const made = stripe.calls.slice(before)
      expect(made.map((call) => call.method)).toEqual(['subscriptions.retrieve', 'subscriptions.update', 'subscriptions.retrieve', 'subscriptions.update'])
      expect(made.every((call) => paramsOf(call)['id'] === MO_SUBSCRIPTION)).toBe(true)
    })
  })

  it('a repeated press under the same key gets the first answer: one change, one audit row, one send', async () => {
    await onASeed(async (stripe) => {
      const key = crypto.randomUUID()
      const first = await press('cancel', { key })
      const second = await press('cancel', { key })
      expect(second.status).toBe(200)
      expect(second.replayed).toBe(true)
      expect(second.data).toEqual(first.data)
      expect(await audited(CANCEL_SCHEDULED_ACTION)).toHaveLength(1)
      expect(updates(stripe)).toHaveLength(1)
      // A press with no key is refused before anything.
      expect((await press('undo-cancel', { key: null })).status).toBe(400)
      expect(await lastDay()).toBe('2026-12-09')
    })
  })
})

describe('every refusal, with its words, and nothing changed', () => {
  const unchanged = async (stripe: FakeStripe, date: string | null = null) => {
    expect(await lastDay()).toBe(date)
    expect(await cancelRows()).toEqual([])
    expect(await stepStates()).toEqual([])
    expect(stripe.calls).toEqual([])
  }

  it('FB20: Issue refunds comes from the signed-in staff member, in the old words; no staff record and an inactive account are refused before anything', async () => {
    await onASeed(async (stripe) => {
      for (const route of ['cancel', 'undo-cancel'] as const) {
        expect(refusalOf(await press(route, { email: NO_REFUNDS }))).toEqual([403, 'FORBIDDEN', 'permission_denied', MEMBERSHIP_CANCEL_WORDS.permissionDenied])
        expect(MEMBERSHIP_CANCEL_WORDS.permissionDenied).toBe('Needs the Issue refunds permission to cancel or re-activate a membership.')
        const stranger = await press(route, { email: 'nobody@example.com' })
        expect([stranger.status, stranger.error?.code]).toEqual([401, 'UNAUTHORISED'])
        const inactive = await press(route, { email: INACTIVE })
        expect([inactive.status, inactive.error?.code]).toEqual([403, 'FORBIDDEN'])
      }
      // The permission is asked before the membership is read: an unknown one is still "permission".
      expect(refusalOf(await press('cancel', { email: NO_REFUNDS, membershipId: crypto.randomUUID() }))[2]).toBe('permission_denied')
      await unchanged(stripe)
    })
  })

  it('not found, for both; a membership id that is not an id is refused by the route', async () => {
    await onASeed(async (stripe) => {
      for (const route of ['cancel', 'undo-cancel'] as const) {
        expect(refusalOf(await press(route, { membershipId: crypto.randomUUID() }))).toEqual([404, 'NOT_FOUND', 'membership_not_found', 'Membership not found'])
        expect((await press(route, { membershipId: 'not-an-id' })).status).toBe(400)
      }
      await unchanged(stripe)
    })
  })

  it('FB5: cancel is refused on a membership that is cancelled, failing a payment or paused (not active), and on one already scheduled to cancel, with the words the dialog already holds', async () => {
    for (const status of ['cancelled', 'past_due', 'paused']) {
      await onASeed(
        async (stripe) => {
          expect(refusalOf(await press('cancel')), status).toEqual([409, 'CONFLICT', 'not_active', 'This membership is not currently active.'])
          expect(refusalOf(await press('undo-cancel')), status).toEqual([409, 'CONFLICT', 'not_active', 'This membership is not currently active.'])
          await unchanged(stripe)
        },
        async (seedDb) => void (await seedDb.query('UPDATE customer_memberships SET subscription_status = $1 WHERE id = $2', [status, ID.membership]))
      )
    }
    await onASeed(
      async (stripe) => {
        expect(refusalOf(await press('cancel'))).toEqual([409, 'CONFLICT', 'already_cancelling', 'This membership is already scheduled to cancel.'])
        await unchanged(stripe, '2026-12-09')
      },
      set("UPDATE customer_memberships SET cancel_effective_date = '2026-12-09' WHERE id = $1")
    )
    expect(MEMBERSHIP_CANCEL_DIALOG_WORDS).toMatchObject({ not_active: 'This membership is not currently active.', already_cancelling: 'This membership is already scheduled to cancel.', not_cancelling: 'This membership has no pending cancellation to undo.' })
  })

  it('FB5: undo is refused with no cancel scheduled, and once the last day has passed (the old route cleared the date of a membership that had ended: running again, with credits, for no payment); the last day itself can still be undone', async () => {
    await onASeed(async (stripe) => {
      expect(refusalOf(await press('undo-cancel'))).toEqual([409, 'CONFLICT', 'not_cancelling', 'This membership has no pending cancellation to undo.'])
      await unchanged(stripe)
    })
    // Today is 10 November 2026 in London. The last day was yesterday: no longer pending.
    await onASeed(
      async (stripe) => {
        expect(refusalOf(await press('undo-cancel'))).toEqual([409, 'CONFLICT', 'not_cancelling', 'This membership has no pending cancellation to undo.'])
        await unchanged(stripe, '2026-11-09')
      },
      set("UPDATE customer_memberships SET cancel_effective_date = '2026-11-09', stripe_subscription_id = NULL WHERE id = $1")
    )
    // The last day is today: still the member's, so still to come.
    await onASeed(
      async () => {
        expect((await press('undo-cancel')).status).toBe(200)
        expect(await lastDay()).toBeNull()
      },
      set("UPDATE customer_memberships SET cancel_effective_date = '2026-11-10' WHERE id = $1")
    )
  })

  it('FB22: a membership with no next renewal date is refused in plain words, never a fault (the old route: "Cannot read properties of null")', async () => {
    await onASeed(
      async (stripe) => {
        const answer = await press('cancel')
        expect(refusalOf(answer)).toEqual([409, 'CONFLICT', 'no_renewal_date', "This membership has no next payment date, so the day it would end can't be worked out. Nothing was changed. Tell a manager."])
        await unchanged(stripe)
      },
      set('UPDATE customer_memberships SET next_renewal_date = NULL WHERE id = $1')
    )
  })

  // W40a (Wayne, 16 Nov; W40 review L1). Mo pays £40 a month and renews on 10 December. On the morning of the 10th,
  // before Stripe has taken the payment, the end would be the 10th itself: a last day of the 9th (yesterday) and a
  // cancel_at already past, which Stripe either refuses or takes as "end now", with no payment taken.
  const RENEWAL_DUE = "Today's payment for this membership hasn't gone through yet, so it can't be cancelled until it has. Try again after the payment (the membership will then end at its next renewal)."

  it('W40a: a cancel on the renewal day, before the payment has moved the date on, is refused before anything is written, in its own words; so is one whose renewal is overdue; undo is unaffected', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(new Date('2026-12-10T10:00:00.000Z'))
      expect(refusalOf(await press('cancel'))).toEqual([409, 'CONFLICT', 'renewal_due_today', RENEWAL_DUE])
      expect(MEMBERSHIP_CANCEL_NEW_WORDS.renewalDueToday).toBe(RENEWAL_DUE)
      await unchanged(stripe)
      // Just after midnight in London on the day itself, and days later with the payment still not through.
      vi.setSystemTime(new Date('2026-12-10T00:00:30.000Z'))
      expect(refusalOf(await press('cancel'))[2]).toBe('renewal_due_today')
      vi.setSystemTime(new Date('2026-12-13T10:00:00.000Z'))
      expect(refusalOf(await press('cancel'))[2]).toBe('renewal_due_today')
      await unchanged(stripe)
    })
    // In summer London's day starts at 23:00 UTC: 14 July 23:30 UTC is already the 15th there.
    await onASeed(
      async (stripe) => {
        vi.setSystemTime(new Date('2027-07-14T22:59:00.000Z'))
        expect((await press('cancel')).status).toBe(200)
        expect((await press('undo-cancel')).status).toBe(200)
        const calls = stripe.calls.length
        vi.setSystemTime(new Date('2027-07-14T23:30:00.000Z'))
        expect(refusalOf(await press('cancel'))[2]).toBe('renewal_due_today')
        expect(stripe.calls).toHaveLength(calls)
        expect(await lastDay()).toBeNull()
      },
      set("UPDATE customer_memberships SET next_renewal_date = '2027-07-15' WHERE id = $1")
    )
    // Undo on the renewal day: a cancel scheduled for later (inside the minimum term) can still be undone.
    await onASeed(
      async (stripe) => {
        expect((await press('cancel')).data).toMatchObject({ endDate: '2026-12-25' })
        vi.setSystemTime(new Date('2026-11-25T10:00:00.000Z'))
        expect((await press('undo-cancel')).status).toBe(200)
        expect(await lastDay()).toBeNull()
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      },
      set("UPDATE customer_memberships SET start_date = '2026-10-25', next_renewal_date = '2026-11-25' WHERE id = $1")
    )
  })

  it("W40a: the day after, once Stripe's payment has moved the date on (the webhook's own function), the cancel is taken and ends at the new next renewal", async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(new Date('2026-12-10T10:00:00.000Z'))
      expect(refusalOf(await press('cancel'))[2]).toBe('renewal_due_today')
      // invoice.paid at 14:00: the webhook calls membership_mark_paid with the new period's end, 10 January.
      vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
      await db.query('SELECT membership_mark_paid($1, $2::timestamptz)', [MO_SUBSCRIPTION, '2027-01-10T00:00:00.000Z'])
      vi.setSystemTime(new Date('2026-12-11T10:00:00.000Z'))
      const answer = await press('cancel')
      expect(answer.data).toEqual({ membership: { id: ID.membership, cancel_effective_date: '2027-01-09', billing_frequency: 'monthly' }, endDate: '2027-01-10', stripeUpdated: true })
      expect(updates(stripe).map((call) => call.params)).toEqual([{ id: MO_SUBSCRIPTION, cancel_at: Date.UTC(2027, 0, 10) / 1000, proration_behavior: 'none' }])
      // The same afternoon as the payment it is taken too.
    })
    await onASeed(async () => {
      vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
      await db.query('SELECT membership_mark_paid($1, $2::timestamptz)', [MO_SUBSCRIPTION, '2027-01-10T00:00:00.000Z'])
      expect((await press('cancel')).data).toMatchObject({ endDate: '2027-01-10', stripeUpdated: true })
    })
  })

  it('W40a: at 23:50 the night before the renewal the cancel is taken: the membership ends at midnight, ten minutes on, with the cancel_at still to come', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(new Date('2026-12-09T23:50:00.000Z'))
      const answer = await press('cancel')
      expect(answer.data).toEqual({ membership: { id: ID.membership, cancel_effective_date: '2026-12-09', billing_frequency: 'monthly' }, endDate: '2026-12-10', stripeUpdated: true })
      expect(updates(stripe).map((call) => call.params)).toEqual([{ id: MO_SUBSCRIPTION, cancel_at: ENDS, proration_behavior: 'none' }])
      expect(ENDS * 1000 - Date.now()).toBeGreaterThan(0)
      expect(ENDS * 1000 - Date.now()).toBeLessThanOrEqual(10 * 60_000)
    })
  })

  it('a cancel is refused while a payment date change is in progress on the membership; a finished or failed one is not in its way', async () => {
    const change = (status: string): Prepare => async (seedDb) =>
      void (await insert(seedDb, 'membership_payment_date_changes', { membership_id: ID.membership, old_renewal_date: '2026-12-10', new_renewal_date: '2026-12-15', extra_days: 5, amount_charged: '6.50', staff_id: ID.staff, status }))
    await onASeed(async (stripe) => {
      expect(refusalOf(await press('cancel'))).toEqual([409, 'CONFLICT', 'payment_date_changing', 'A payment date change is already in progress for this membership.'])
      await unchanged(stripe)
    }, change('pending'))
    await onASeed(async () => {
      expect((await press('cancel')).status).toBe(200)
    }, change('failed'))
  })

  it('the switch: with `membership_changes` off both routes answer "switched off" before anything is read, even for staff with no permission and a membership that does not exist', async () => {
    await onASeed(async (stripe) => {
      for (const value of [undefined, '', 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels']) {
        if (value === undefined) delete process.env.ORDER_SWITCH
        else vi.stubEnv('ORDER_SWITCH', value)
        for (const route of ['cancel', 'undo-cancel'] as const) {
          const off = await press(route)
          expect([off.status, off.error?.code, off.error?.message, off.error?.details?.kinds], String(value)).toEqual([501, 'MEMBERSHIP_PATH_OFF', MEMBERSHIP_PATH_OFF_MESSAGE, ['membership_changes']])
          expect((await press(route, { email: NO_REFUNDS, membershipId: crypto.randomUUID() })).error?.code).toBe('MEMBERSHIP_PATH_OFF')
        }
      }
      await unchanged(stripe)
      // On beside the other kinds, it goes.
      vi.stubEnv('ORDER_SWITCH', 'no_stripe,membership_changes')
      expect((await press('cancel')).status).toBe(200)
    })
  })
})

describe('Stripe refuses: M1 is put back in one transaction, and staff see Stripe\'s reason', () => {
  it('a cancel Stripe refuses: the last day is cleared again, the step is closed as undone, a put-back row says why, nothing is listed, and the press is refused with Stripe\'s own words', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      const answer = await press('cancel')
      expect(refusalOf(answer)).toEqual([409, 'CONFLICT', 'stripe_refused', 'This subscription cannot be updated right now.'])
      expect(answer.error?.details?.action).toBe('cancel')
      expect(await lastDay()).toBeNull()
      const [scheduled] = await audited(CANCEL_SCHEDULED_ACTION)
      const stepId = String(scheduled?.details['stepId'])
      expect(await statesOf(stepId)).toEqual(['left', 'undone'])
      expect((await audited(CANCEL_PUT_BACK_ACTION)).map((row) => row.details)).toEqual([
        { was: 'cancel', stripeSaid: 'This subscription cannot be updated right now.', stepId, cancelEffectiveDate: { before: '2026-12-09', after: null }, restored: true },
      ])
      expect(await listed()).toEqual([])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      // Nothing is left for reconcile, and a new press is not "still being sent".
      pastTheWindow()
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect((await press('cancel')).data).toMatchObject({ stripeUpdated: true })
    })
  })

  it("an undo Stripe refuses: the last day is put back as it was. An undo of a subscription Stripe has already ended is refused the same way, in words that say so; and one Stripe can't find", async () => {
    await onASeed(async (stripe) => {
      await press('cancel')
      stripe.failNext('subscriptions.update', no())
      expect(refusalOf(await press('undo-cancel'))).toEqual([409, 'CONFLICT', 'stripe_refused', 'This subscription cannot be updated right now.'])
      expect(await lastDay()).toBe('2026-12-09')
      expect((await audited(CANCEL_PUT_BACK_ACTION))[0]?.details).toMatchObject({ was: 'undo_cancel', cancelEffectiveDate: { before: null, after: '2026-12-09' }, restored: true })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await listed()).toEqual([])

      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(refusalOf(await press('undo-cancel'))).toEqual([409, 'CONFLICT', 'stripe_refused', `Subscription ${MO_SUBSCRIPTION} has already ended in Stripe, so its cancellation can't be undone there.`])
      expect(await lastDay()).toBe('2026-12-09')
    })
    await onASeed(
      async () => {
        expect(refusalOf(await press('cancel'))).toEqual([409, 'CONFLICT', 'stripe_refused', "Stripe can't find subscription sub_gone with the key in use."])
        expect(await lastDay()).toBeNull()
      },
      set("UPDATE customer_memberships SET stripe_subscription_id = 'sub_gone' WHERE id = $1")
    )
  })

  it("a refused press whose step had replaced one still open leaves that wish again: the cancel Stripe never confirmed is still sent once the undo has been put back", async () => {
    await onASeed(async (stripe) => {
      // Cancel: the date reached Stripe but the answer was lost, so its step A (10 December) is left.
      stripe.failNext('subscriptions.update', { kind: 'lost_response' })
      const cancelled = await press('cancel')
      const a = (cancelled.data?.['left'] as { stepId: string }).stepId
      // Past the window, staff press Undo: its step B replaces A, and Stripe refuses it for good.
      pastTheWindow()
      stripe.failNext('subscriptions.update', no())
      expect(refusalOf(await press('undo-cancel'))[2]).toBe('stripe_refused')
      // The membership says cancelled again, and A's wish is left again as a new step, B closed as replaced by it.
      expect(await lastDay()).toBe('2026-12-09')
      const [putBack] = await audited(CANCEL_PUT_BACK_ACTION)
      const again = String(putBack?.details['leftAgain'])
      const b = String(putBack?.details['stepId'])
      expect(await statesOf(a)).toEqual(['left', 'replaced'])
      expect(await statesOf(b)).toEqual(['left', 'replaced'])
      expect(await statesOf(again)).toEqual(['left'])
      expect((await listed()).map((line) => [line.stepId, line.state, line.what, line.lastDay])).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
      // The automatic check takes it once it is past its own window, and finds Stripe showing it: Stripe and the membership agree.
      pastTheWindow()
      expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: Stripe already showed it` }])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await listed()).toEqual([])
    })
  })
})

describe('no clear answer: the step is left, and reconcile reads first and sends only if still needed', () => {
  it('a cancel with no answer from Stripe: saved, answered with `left` and its words, listed with what it is and when; reconcile leaves it inside the window, then sends it', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      const answer = await press('cancel')
      expect(answer.status).toBe(200)
      const left = answer.data?.['left'] as { stepId: string; message: string }
      expect(answer.data).toEqual({ membership: { id: ID.membership, cancel_effective_date: '2026-12-09', billing_frequency: 'monthly' }, endDate: '2026-12-10', stripeUpdated: false, left: { stepId: left.stepId, message: MEMBERSHIP_CANCEL_NEW_WORDS.left } })
      expect(await lastDay()).toBe('2026-12-09')
      expect(await statesOf(left.stepId)).toEqual(['left'])
      // Item 6: the stuck list's line says what it is (a cancel date, and the last day it sets), when it was left, and the S2 words.
      expect(await listed()).toEqual([
        {
          stepId: left.stepId,
          membershipId: ID.membership,
          subscriptionId: MO_SUBSCRIPTION,
          step: 'cancel_at',
          what: 'cancel_date',
          lastDay: '2026-12-09',
          customerId: ID.member,
          customerName: 'Mo Member',
          state: 'left',
          at: expect.stringMatching(/^2026-11-10T09:/),
          words: LEFT_STEP_WORDS.cancel_at.left(MO_SUBSCRIPTION),
        },
      ])
      expect((await reconcileNow(stripe)).items).toEqual([])
      pastTheWindow()
      const run = await reconcileNow(stripe, 'run-1')
      expect(run.items).toEqual([{ kind: 'step', id: left.stepId, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
      expect(updates(stripe).at(-1)).toMatchObject({ params: { cancel_at: ENDS, proration_behavior: 'none' }, idempotencyKey: `${left.stepId}:cancel-at:run-1` })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await listed()).toEqual([])
      expect(stripe.netPence).toBe(0)
    })
  })

  it('the other way: the send took effect and its answer was lost. Reconcile reads Stripe, finds it done, and sends nothing', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', { kind: 'lost_response' })
      const answer = await press('cancel')
      const left = answer.data?.['left'] as { stepId: string }
      expect(answer.data).toMatchObject({ stripeUpdated: false, left: { message: MEMBERSHIP_CANCEL_NEW_WORDS.left } })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      pastTheWindow()
      expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: left.stepId, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: Stripe already showed it` }])
      expect(updates(stripe)).toHaveLength(1)
      expect(await listed()).toEqual([])
    })
  })

  it('an undo with no answer, on the read this time: left as a cancel date to clear, and reconcile clears it; one Stripe then refuses is a line for a person', async () => {
    await onASeed(async (stripe) => {
      await press('cancel')
      stripe.failNext('subscriptions.retrieve', noAnswer())
      const answer = await press('undo-cancel')
      const left = answer.data?.['left'] as { stepId: string }
      expect(answer.data).toEqual({ membership: { id: ID.membership, cancel_effective_date: null, billing_frequency: 'monthly' }, left: { stepId: left.stepId, message: MEMBERSHIP_CANCEL_NEW_WORDS.left } })
      expect((await listed()).map((line) => [line.what, line.lastDay, line.state])).toEqual([['clear_cancel_date', undefined, 'left']])
      pastTheWindow()
      stripe.failNext('subscriptions.update', no())
      expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ id: left.stepId, outcome: 'left', reason: 'step_refused' })])
      expect((await listed()).map((line) => [line.what, line.state, line.words, line.close])).toEqual([['clear_cancel_date', 'refused', LEFT_STEP_WORDS.undo.refused(MO_SUBSCRIPTION), { kind: 'left_step', orderId: left.stepId }]])
    })
  })

  it('a press that dies after M1 (the Stripe step never starts) leaves the same: the change is saved with its step, the press gets no answer, and reconcile finishes it', async () => {
    await onASeed(async (stripe) => {
      const dying: CancelOptions = {
        actor: { channel: 'staff', id: ID.staff, canIssueRefunds: true },
        requestId: 'req-dies',
        startedAt: Date.now(),
        stripe: () => {
          throw new Error('the Worker stopped here')
        },
      }
      await expect(cancelMembership(db, ID.membership, dying)).rejects.toThrow('the Worker stopped here')
      expect(await lastDay()).toBe('2026-12-09')
      expect(await audited(CANCEL_SCHEDULED_ACTION)).toHaveLength(1)
      expect((await listed()).map((line) => [line.what, line.state])).toEqual([['cancel_date', 'left']])
      expect(stripe.calls).toEqual([])
      // Staff pressing again inside the window are told it is still being sent, not charged or changed twice.
      expect(refusalOf(await press('cancel'))[2]).toBe('already_cancelling')
      expect(refusalOf(await press('undo-cancel'))[2]).toBe('still_sending')
      pastTheWindow()
      expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ kind: 'step', outcome: 'finalised' })])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await listed()).toEqual([])
    })
  })

  it("a `done` row that can't be written doesn't fail the press: Stripe is changed, the answer says so, and reconcile closes the step later without sending", async () => {
    await onASeed(async (stripe) => {
      const answer = await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: `NEW.action = '${STEP_LEFT_ACTION}' AND NEW.details->>'state' = 'done'` }, () => press('cancel'))
      expect(answer.data).toMatchObject({ stripeUpdated: true })
      expect(await listed()).toHaveLength(1)
      pastTheWindow()
      expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ outcome: 'finalised', detail: expect.stringContaining('Stripe already showed it') })])
      expect(updates(stripe)).toHaveLength(1)
    })
  })
})

describe('two changes to one membership take turns (W36 review S1)', () => {
  it('a second press while the first\'s step is still inside its window is refused with "still being sent", and changes nothing; once the window has passed it goes, and replaces the step', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      const first = await press('cancel')
      const a = (first.data?.['left'] as { stepId: string }).stepId
      const calls = stripe.calls.length
      const second = await press('undo-cancel')
      expect(refusalOf(second)).toEqual([409, 'CONFLICT', 'still_sending', 'The last change to this membership is still being sent to Stripe. Try again in 15 minutes.'])
      expect(await lastDay()).toBe('2026-12-09')
      expect(await audited(CANCEL_UNDONE_ACTION)).toEqual([])
      expect(stripe.calls).toHaveLength(calls)
      expect((await listed()).map((line) => line.stepId)).toEqual([a])

      pastTheWindow()
      const third = await press('undo-cancel')
      expect(third.status).toBe(200)
      expect(await statesOf(a)).toEqual(['left', 'replaced'])
      expect(await lastDay()).toBeNull()
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      expect(await listed()).toEqual([])
      // Reconcile has nothing of A's to send.
      expect((await reconcileNow(stripe)).items).toEqual([])
    })
  })

  it("two presses racing, the second between the first's M1 and its Stripe step: the second is refused and sends nothing, the first finishes, and Stripe and the membership agree. In the other order (the second after the first has finished) both go, one after the other", async () => {
    await onASeed(async (stripe) => {
      let second: Answer | undefined
      // Another tab presses Undo once the first press's M1 has committed, before its read of Stripe.
      replayStripe.current = withGapBeforeStripe(stripe, async () => {
        const mine = replayStripe.current
        replayStripe.current = stripe
        second = await press('undo-cancel')
        replayStripe.current = mine
      })
      const first = await press('cancel')
      replayStripe.current = stripe
      expect(first.data).toMatchObject({ stripeUpdated: true })
      expect(second ? refusalOf(second) : null).toEqual([409, 'CONFLICT', 'still_sending', MEMBERSHIP_CANCEL_NEW_WORDS.stillSending])
      expect(updates(stripe).map((call) => paramsOf(call)['cancel_at'])).toEqual([ENDS])
      expect(await lastDay()).toBe('2026-12-09')
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await listed()).toEqual([])

      // The other order: the first press has finished (its step is done), so the undo goes at once.
      expect((await press('undo-cancel')).status).toBe(200)
      expect(updates(stripe).map((call) => paramsOf(call)['cancel_at'])).toEqual([ENDS, ''])
      expect(await lastDay()).toBeNull()
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      expect(await listed()).toEqual([])
    })
  })
})

// Brief W40a item 1 (W40 review S1, proofs P1 and P2, turned round) and item 2 (L2). Mo pays £40 a month and renews
// on 10 December. Before W40a each of these ended with every step closed, nothing listed, and Stripe on the older
// wish: a member staff cancelled kept being charged £40 a month.
describe('W40a: a stale send is never the last word with nothing listed (W40 review S1, L2)', () => {
  /**
   * The fake as a reconcile run reaches it. On the run's first `subscriptions.update` (its send of the replaced step
   * B), `beforeFirst` runs first (staff press meanwhile); `firstLands` false makes that send time out without landing
   * (it lands later, by hand). `beforeSecond` runs before the run's second update (its resend of the newest step).
   */
  function racing(stripe: FakeStripe, beforeFirst: () => Promise<void>, firstLands: boolean, beforeSecond?: () => Promise<void>): FakeStripe {
    let n = 0
    const real = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const subscriptions = {
      ...real,
      update: async (...args: unknown[]) => {
        n += 1
        if (n === 1) {
          await beforeFirst()
          if (!firstLands) throw fakeStripeErrors.server()
        }
        if (n === 2) await beforeSecond?.()
        return (real['update'] as (...a: unknown[]) => Promise<unknown>)(...args)
      },
    }
    return new Proxy(stripe, { get: (target, prop) => (prop === 'subscriptions' ? subscriptions : Reflect.get(target, prop)) }) as unknown as FakeStripe
  }
  /** Mo's cancel A reached Stripe with its answer lost; past its window, Undo B got no answer at all (B left, Stripe still 10 December). */
  async function cancelThenUnclearUndo(stripe: FakeStripe): Promise<string> {
    stripe.failNext('subscriptions.update', { kind: 'lost_response' })
    await press('cancel')
    expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
    pastTheWindow()
    stripe.failNext('subscriptions.update', noAnswer())
    const undo = await press('undo-cancel')
    expect(await lastDay()).toBeNull()
    return (undo.data?.['left'] as { stepId: string }).stepId
  }
  /** Staff press Cancel again (C): its press reads Stripe, which still shows 10 December, so C is done with nothing sent. */
  async function pressC(): Promise<void> {
    const answer = await press('cancel')
    expect(answer.status).toBe(200)
    expect(answer.data).toMatchObject({ stripeUpdated: true })
    expect(answer.data?.['left']).toBeUndefined()
  }
  const lastStepOf = async (action: string) => String((await db.query<{ step: string }>("SELECT details->>'stepId' AS step FROM audit_log WHERE action = $1 ORDER BY at DESC LIMIT 1", [action]))[0]?.step)
  const leftRowOf = async (stepId: string) => (await audited(STEP_LEFT_ACTION)).find((row) => row.details['stepId'] === stepId && row.details['state'] === 'left')
  const lines = async () => (await listed()).map((line) => [line.stepId, line.state, line.what, line.lastDay])

  it("P1 turned round: the run's clear (B) lands after Cancel (C) was marked done, and the run's resend of C gets no answer. C's wish is left again as a new step: listed, a new press waits, and past its window it is sent, so Stripe and the membership agree on 9 December", async () => {
    await onASeed(async (stripe) => {
      const b = await cancelThenUnclearUndo(stripe)
      pastTheWindow()
      const run = await reconcileNow(racing(stripe, pressC, true, async () => stripe.failNext('subscriptions.update', noAnswer())), 'run-1')
      const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
      const [line] = await listed()
      const again = String(line?.stepId)
      expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'settled_elsewhere', detail: `replaced by step ${c}, already done: no clear answer (An error occurred with our API.): its wish left again as step ${again}` }])
      // The membership says it ends, Stripe has no end date (B's stale clear was the last word) ...
      expect(await lastDay()).toBe('2026-12-09')
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      expect(await statesOf(b)).toEqual(['left', 'replaced'])
      expect(await statesOf(c)).toEqual(['done', 'left'])
      // ... and it is listed: the newest wish, as a new step the automatic check left, naming the step it stands for.
      expect(again).not.toBe(c)
      expect(await lines()).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
      expect(line?.words).toBe(LEFT_STEP_WORDS.cancel_at.left(MO_SUBSCRIPTION))
      expect(await leftRowOf(again)).toMatchObject({ actor_type: 'system', entity_id: ID.membership, details: { kind: 'cancel_at', subscriptionId: MO_SUBSCRIPTION, want: { cancelAt: ENDS }, leftAgainFor: c } })
      // Inside its window a new press waits, and a run leaves it alone.
      expect(refusalOf(await press('undo-cancel'))).toEqual([409, 'CONFLICT', 'still_sending', MEMBERSHIP_CANCEL_NEW_WORDS.stillSending])
      expect((await reconcileNow(stripe)).items).toEqual([])
      // Stripe's event for B's clear: the webhook copies "no end" onto the membership. The step is still listed.
      await webhook(null)
      expect(await lastDay()).toBeNull()
      expect(await lines()).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
      // Past the window the run reads Stripe, finds no end date, and sends the cancel again; its event puts the last day back.
      pastTheWindow()
      expect((await reconcileNow(stripe, 'run-2')).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
      expect(updates(stripe).at(-1)).toMatchObject({ params: { cancel_at: ENDS, proration_behavior: 'none' }, idempotencyKey: `${again}:cancel-at:run-2` })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      await webhook(ENDS)
      expect(await lastDay()).toBe('2026-12-09')
      expect(await listed()).toEqual([])
      expect(stripe.netPence).toBe(0)
    })
  })

  it("P2 turned round (W40's Noticed 2): the run's clear (B) times out and lands after C's press and the run's re-read. Stripe shows C's wish at the time, but C's wish is left again all the same; past the window the late clear is found and the cancel sent again", async () => {
    await onASeed(async (stripe) => {
      const b = await cancelThenUnclearUndo(stripe)
      pastTheWindow()
      const run = await reconcileNow(racing(stripe, pressC, false), 'run-1')
      const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
      const again = String((await listed())[0]?.stepId)
      expect(run.items).toEqual([
        { kind: 'step', id: b, outcome: 'settled_elsewhere', detail: `replaced by step ${c}, already done: Stripe shows it, but this run's send of the replaced step got no clear answer and may still land: its wish left again as step ${again}` },
      ])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await statesOf(c)).toEqual(['done', 'left'])
      expect(await statesOf(b)).toEqual(['left', 'replaced'])
      expect(await lines()).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
      expect((await leftRowOf(again))?.details).toMatchObject({ leftAgainFor: c, want: { cancelAt: ENDS } })
      // B's request lands in Stripe now, after everything above, and its event reaches the webhook.
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
      await webhook(null)
      expect(await lastDay()).toBeNull()
      expect(await lines()).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
      pastTheWindow()
      expect((await reconcileNow(stripe, 'run-2')).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      await webhook(ENDS)
      expect(await lastDay()).toBe('2026-12-09')
      expect(await listed()).toEqual([])
    })
  })

  it("P2 when no late send comes: the step left again costs one read. Past the window the run finds Stripe already showing the wish, sends nothing, and the line clears", async () => {
    await onASeed(async (stripe) => {
      await cancelThenUnclearUndo(stripe)
      pastTheWindow()
      await reconcileNow(racing(stripe, pressC, false), 'run-1')
      const again = String((await listed())[0]?.stepId)
      const sent = updates(stripe).length
      pastTheWindow()
      expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: Stripe already showed it` }])
      expect(updates(stripe)).toHaveLength(sent)
      expect(await listed()).toEqual([])
      expect(await lastDay()).toBe('2026-12-09')
    })
  })

  it("the same late send when the press that replaced B got no answer either (C still open): the run finds Stripe showing C's wish but leaves C open, so the late clear is found past C's window and the cancel sent again", async () => {
    await onASeed(async (stripe) => {
      const b = await cancelThenUnclearUndo(stripe)
      pastTheWindow()
      let c = ''
      const pressCWithNoAnswer = async () => {
        stripe.failNext('subscriptions.retrieve', noAnswer())
        c = (((await press('cancel')).data?.['left'] ?? {}) as { stepId: string }).stepId
      }
      const run = await reconcileNow(racing(stripe, pressCWithNoAnswer, false), 'run-1')
      expect(c).not.toBe('')
      expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'settled_elsewhere', detail: `replaced by step ${c}: Stripe shows it, left open (this run's send of the replaced step got no clear answer and may still land)` }])
      // W40b: left open, with the mark that a stale send may still land.
      expect(await statesOf(c)).toEqual(['left', 'stale_send'])
      expect(await lines()).toEqual([[c, 'left', 'cancel_date', '2026-12-09']])
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
      await webhook(null)
      pastTheWindow()
      expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: c, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      await webhook(ENDS)
      expect(await lastDay()).toBe('2026-12-09')
      expect(await listed()).toEqual([])
    })
  })

  it("a later press is the newest, even after one its own press closed: Cancel (C) is done, then Undo (D) is done, both while the run's clear (B) is on its way. The run settles D, never C: the cancel is not sent again, and nothing is left", async () => {
    await onASeed(async (stripe) => {
      const b = await cancelThenUnclearUndo(stripe)
      pastTheWindow()
      const cThenD = async () => {
        await pressC()
        expect((await press('undo-cancel')).status).toBe(200)
      }
      const before = updates(stripe).length
      const run = await reconcileNow(racing(stripe, cThenD, true), 'run-1')
      const d = await lastStepOf(CANCEL_UNDONE_ACTION)
      expect(d).not.toBe(b)
      expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'settled_elsewhere', detail: `replaced by step ${d}, already done: Stripe shows it` }])
      // Sent since the run began: D's clear (its press) and B's clear (the run). Never C's 10 December again.
      expect(updates(stripe).slice(before).map((call) => paramsOf(call)['cancel_at'])).toEqual(['', ''])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      expect(await lastDay()).toBeNull()
      expect(await listed()).toEqual([])
    })
  })

  it("a wish is left again only while its step is still the newest: Undo (D) is pressed while the run's resend of C is on its way. C's cancel is not left again over D, and Stripe and the membership agree on no end date", async () => {
    await onASeed(async (stripe) => {
      const b = await cancelThenUnclearUndo(stripe)
      pastTheWindow()
      const dThenNoAnswer = async () => {
        // Stripe has no end date by now (B's clear landed), so D's press finds its wish shown and sends nothing.
        expect((await press('undo-cancel')).status).toBe(200)
        stripe.failNext('subscriptions.update', noAnswer())
      }
      const run = await reconcileNow(racing(stripe, pressC, true, dThenNoAnswer), 'run-1')
      const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
      expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'settled_elsewhere', detail: `replaced by step ${c}, already done: no clear answer (An error occurred with our API.): not left again (a newer change has been made since)` }])
      expect(await listed()).toEqual([])
      expect((await audited(STEP_LEFT_ACTION)).filter((row) => 'leftAgainFor' in row.details)).toEqual([])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      expect(await lastDay()).toBeNull()
    })
  })

  // L2. Cancel A reached Stripe with its answer lost. Undo B replaces A, and its press hangs at Stripe. A run that
  // had taken A settles B instead, and Stripe refuses it: B is recorded as refused, so it no longer makes a new press
  // wait. Staff press Cancel (C), which replaces B and is done. Then B's own press is refused by Stripe and put back.
  it("L2: a refused press whose step a newer press has replaced meanwhile does not leave the older wish again: the newer press's step stands, and nothing of A's comes back", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', { kind: 'lost_response' })
      const a = ((await press('cancel')).data?.['left'] as { stepId: string }).stepId
      pastTheWindow()
      let reachedStripe: () => void = () => {}
      const atStripe = new Promise<void>((resolve) => (reachedStripe = resolve))
      let letGo: () => void = () => {}
      const held = new Promise<void>((resolve) => (letGo = resolve))
      let pressB: Promise<Answer> | undefined
      // The run's read for A: staff press Undo meanwhile. Its M1 commits, and its press then waits at Stripe.
      const undoMeanwhile = async () => {
        replayStripe.current = withGapBeforeStripe(stripe, async () => {
          reachedStripe()
          await held
        })
        pressB = press('undo-cancel')
        await atStripe
        replayStripe.current = stripe
        // The run's send of B is refused by Stripe for good.
        stripe.failNext('subscriptions.update', no())
      }
      const run = await reconcileNow(withGapBeforeStripe(stripe, undoMeanwhile) as unknown as FakeStripe, 'run-1')
      const b = await lastStepOf(CANCEL_UNDONE_ACTION)
      expect(run.items).toEqual([{ kind: 'step', id: a, outcome: 'settled_elsewhere', detail: `replaced by step ${b}: refused (This subscription cannot be updated right now.)` }])
      expect(await statesOf(b)).toEqual(['left', 'refused'])
      // B is refused, so Cancel goes ahead: C replaces B, finds Stripe showing 10 December, and is done.
      await pressC()
      const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
      expect(await statesOf(b)).toEqual(['left', 'refused', 'replaced'])
      // Now B's own press hears from Stripe: refused. It is put back, but the date is C's by now and stays.
      stripe.failNext('subscriptions.update', no())
      letGo()
      const undone = await (pressB as Promise<Answer>)
      expect(refusalOf(undone)).toEqual([409, 'CONFLICT', 'stripe_refused', 'This subscription cannot be updated right now.'])
      const [putBack] = await audited(CANCEL_PUT_BACK_ACTION)
      expect(putBack?.details).toEqual({ was: 'undo_cancel', stripeSaid: 'This subscription cannot be updated right now.', stepId: b, cancelEffectiveDate: { before: null, after: '2026-12-09' }, restored: false })
      // Nothing was left again, and no step is ended twice: A and B replaced, C done.
      expect(await statesOf(a)).toEqual(['left', 'replaced'])
      expect(await statesOf(b)).toEqual(['left', 'refused', 'replaced'])
      expect(await statesOf(c)).toEqual(['done', 'left'])
      expect((await stepStates()).filter(([, state]) => state === 'left')).toHaveLength(3)
      expect(await listed()).toEqual([])
      expect(await lastDay()).toBe('2026-12-09')
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      pastTheWindow()
      expect((await reconcileNow(stripe)).items).toEqual([])
    })
  })

  // Brief W40b. The two gaps W40a left (its "Noticed" 1 and 2). Mo pays £40 a month and renews on 10 December.
  describe('W40b: a press that finishes after the run, and a wish the database would not take', () => {
    /** A press that commits its M1 and then waits at Stripe until `finish` is called: a press still in flight. */
    function heldPress(stripe: FakeStripe, route: 'cancel' | 'undo-cancel') {
      let reachedStripe: () => void = () => {}
      const atStripe = new Promise<void>((resolve) => (reachedStripe = resolve))
      let letGo: () => void = () => {}
      const held = new Promise<void>((resolve) => (letGo = resolve))
      let pending: Promise<Answer> | undefined
      return {
        async start() {
          replayStripe.current = withGapBeforeStripe(stripe, async () => {
            reachedStripe()
            await held
          })
          pending = press(route)
          await atStripe
          replayStripe.current = stripe
        },
        async finish(): Promise<Answer> {
          letGo()
          return pending as Promise<Answer>
        },
      }
    }
    /** The database as a run reaches it, with `gap` run once just before the run's first transaction (its look under the lock). */
    function withGapBeforeFirstTransaction(gap: () => Promise<unknown>): Db {
      let fired = false
      return new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown
          if (prop !== 'transaction') return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
          return async (...args: unknown[]) => {
            if (!fired) {
              fired = true
              await gap()
            }
            return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
          }
        },
      })
    }
    const LEFT_OPEN = "Stripe shows it, left open (this run's send of the replaced step got no clear answer and may still land)"
    const reconcileRows = async () => (await audited('order.reconcile')).filter((row) => row.entity_type === 'membership_step').map((row) => [row.entity_id, row.details])
    const failing = (when: string) => ({ table: 'audit_log', event: 'INSERT' as const, when: `NEW.action = '${STEP_LEFT_ACTION}' AND ${when}` })

    it("item 1: Cancel (C) is still at Stripe when the run's clear (B) times out. The run marks C; C's press then finishes, finds the mark and leaves its wish again instead of closing C as done. B lands after that: it is found past the window and the cancel sent again, so Stripe and the membership agree on 9 December", async () => {
      await onASeed(async (stripe) => {
        const b = await cancelThenUnclearUndo(stripe)
        pastTheWindow()
        const pressOfC = heldPress(stripe, 'cancel')
        const run = await reconcileNow(racing(stripe, pressOfC.start, false), 'run-1')
        const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
        expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'settled_elsewhere', detail: `replaced by step ${c}: ${LEFT_OPEN}` }])
        expect(await statesOf(c)).toEqual(['left', 'stale_send'])
        expect((await audited(STEP_LEFT_ACTION)).find((row) => row.details['state'] === 'stale_send')).toMatchObject({ actor_type: 'system', entity_id: ID.membership, details: { stepId: c, staleStep: b, want: { cancelAt: ENDS } } })
        // C's press hears from Stripe (10 December is still there, so nothing is sent) and ends.
        const answer = await pressOfC.finish()
        expect(answer.status).toBe(200)
        expect(answer.data).toMatchObject({ stripeUpdated: true })
        const again = String((await listed())[0]?.stepId)
        expect(again).not.toBe(c)
        expect(await statesOf(c)).toEqual(['left', 'replaced', 'stale_send'])
        expect(await lines()).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
        expect(await leftRowOf(again)).toMatchObject({ actor_type: 'staff', details: { kind: 'cancel_at', subscriptionId: MO_SUBSCRIPTION, want: { cancelAt: ENDS }, leftAgainFor: c } })
        // B's request lands in Stripe now, after C's press has ended, and its event reaches the webhook.
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
        await webhook(null)
        expect(await lastDay()).toBeNull()
        // Inside the window a new press waits and a run leaves the step alone.
        expect(refusalOf(await press('cancel'))).toEqual([409, 'CONFLICT', 'still_sending', MEMBERSHIP_CANCEL_NEW_WORDS.stillSending])
        expect((await reconcileNow(stripe)).items).toEqual([])
        pastTheWindow()
        expect((await reconcileNow(stripe, 'run-2')).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
        await webhook(ENDS)
        expect(await lastDay()).toBe('2026-12-09')
        expect(await listed()).toEqual([])
        expect(stripe.netPence).toBe(0)
      })
    })

    it("item 1, the other order: B lands before C's press hears from Stripe. The press sends its cancel over it and still leaves the wish again; past the window that costs one read, nothing is sent, and the line clears", async () => {
      await onASeed(async (stripe) => {
        await cancelThenUnclearUndo(stripe)
        pastTheWindow()
        const pressOfC = heldPress(stripe, 'cancel')
        await reconcileNow(racing(stripe, pressOfC.start, false), 'run-1')
        const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
        await webhook(null)
        const before = updates(stripe).length
        expect((await pressOfC.finish()).data).toMatchObject({ stripeUpdated: true })
        expect(updates(stripe).slice(before).map((call) => paramsOf(call)['cancel_at'])).toEqual([ENDS])
        await webhook(ENDS)
        const again = String((await listed())[0]?.stepId)
        expect(await statesOf(c)).toEqual(['left', 'replaced', 'stale_send'])
        expect((await leftRowOf(again))?.details).toMatchObject({ leftAgainFor: c })
        pastTheWindow()
        expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: Stripe already showed it` }])
        expect(updates(stripe)).toHaveLength(before + 1)
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
        expect(await lastDay()).toBe('2026-12-09')
        expect(await listed()).toEqual([])
      })
    })

    it("item 1, the wishes the other way round: the run's cancel (B) times out while Undo (C) is at Stripe, and lands after C's press has ended. The undo is left again, and past the window the end date is cleared: no end in both places", async () => {
      await onASeed(async (stripe) => {
        stripe.failNext('subscriptions.update', noAnswer())
        const b = ((await press('cancel')).data?.['left'] as { stepId: string }).stepId
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
        pastTheWindow()
        const pressOfC = heldPress(stripe, 'undo-cancel')
        const run = await reconcileNow(racing(stripe, pressOfC.start, false), 'run-1')
        const c = await lastStepOf(CANCEL_UNDONE_ACTION)
        expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'settled_elsewhere', detail: `replaced by step ${c}: ${LEFT_OPEN}` }])
        expect((await pressOfC.finish()).status).toBe(200)
        const again = String((await listed())[0]?.stepId)
        expect(await statesOf(c)).toEqual(['left', 'replaced', 'stale_send'])
        expect(await lines()).toEqual([[again, 'left', 'clear_cancel_date', undefined]])
        // B's cancel lands late: Stripe ends the subscription on 10 December, and the webhook says so on the membership.
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
        await webhook(ENDS)
        expect(await lastDay()).toBe('2026-12-09')
        pastTheWindow()
        expect((await reconcileNow(stripe, 'run-2')).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
        expect(updates(stripe).at(-1)).toMatchObject({ params: { cancel_at: '', proration_behavior: 'none' } })
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
        await webhook(null)
        expect(await lastDay()).toBeNull()
        expect(await listed()).toEqual([])
      })
    })

    it("item 1: C's press ends between the run's read of C (open) and the run's look under the lock. The run finds C done there and leaves its wish again itself: no mark on a closed step, and nothing closed with a late send still to land", async () => {
      await onASeed(async (stripe) => {
        const b = await cancelThenUnclearUndo(stripe)
        pastTheWindow()
        const pressOfC = heldPress(stripe, 'cancel')
        const run = await reconcile(withGapBeforeFirstTransaction(pressOfC.finish), racing(stripe, pressOfC.start, false), { actor: { type: 'system', id: null }, requestId: 'run-1', maxItems: 50, budgetMs: 60_000 })
        const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
        const again = String((await listed())[0]?.stepId)
        expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'settled_elsewhere', detail: `replaced by step ${c}, already done: this run's send of the replaced step got no clear answer and may still land: its wish left again as step ${again}` }])
        expect(await statesOf(c)).toEqual(['done', 'left'])
        expect(await lines()).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
        expect((await leftRowOf(again))?.details).toMatchObject({ leftAgainFor: c })
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
        await webhook(null)
        pastTheWindow()
        expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
        await webhook(ENDS)
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
        expect(await lastDay()).toBe('2026-12-09')
      })
    })

    it("item 1: a press with no mark on its step ends as before: the step is done, and nothing is left again", async () => {
      await onASeed(async (stripe) => {
        expect((await press('cancel')).data).toMatchObject({ stripeUpdated: true })
        const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
        expect(await statesOf(c)).toEqual(['done', 'left'])
        expect(await listed()).toEqual([])
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      })
    })

    it("item 2: the transaction that leaves C's wish again fails. The run reports the item as left with its own reason, and its audit row names the step; C's wish is listed as not left again yet (W46), with no close. The next run leaves the wish again; the late clear is then found and the cancel sent again", async () => {
      await onASeed(async (stripe) => {
        const b = await cancelThenUnclearUndo(stripe)
        pastTheWindow()
        const run = await whileFailing(db, failing("NEW.details->>'leftAgainFor' IS NOT NULL"), () => reconcileNow(racing(stripe, pressC, false), 'run-1'))
        const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
        const detail = expect.stringMatching(new RegExp(`^replaced by step ${c}, already done: Stripe shows it, but this run's send of the replaced step got no clear answer and may still land: not left again yet \\(.*connection lost.*\\)$`))
        expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'left', reason: 'step_not_left_again', detail }])
        expect(run.left).toBe(1)
        expect(await reconcileRows()).toEqual([[b, { outcome: 'left', reason: 'step_not_left_again', detail, leaveAgain: c }]])
        // W46 (W40b "Noticed" 2): listed until a run settles it. Before W46 nothing was listed here.
        expect(await listed()).toEqual([notLeftAgainLine(c)])
        expect(await statesOf(c)).toEqual(['done', 'left'])
        // The next run, a moment later: no Stripe call, the wish left again.
        const calls = stripe.calls.length
        const next = await reconcileNow(stripe, 'run-2')
        const again = String((await listed())[0]?.stepId)
        expect(next.items).toEqual([{ kind: 'step', id: c, outcome: 'settled_elsewhere', detail: `step ${c}: its wish left again as step ${again}` }])
        expect(next.left).toBe(0)
        expect(stripe.calls).toHaveLength(calls)
        expect(await lines()).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
        expect(await leftRowOf(again)).toMatchObject({ actor_type: 'system', details: { leftAgainFor: c, want: { cancelAt: ENDS } } })
        expect((await reconcileRows()).at(-1)).toEqual([c, { outcome: 'settled_elsewhere', detail: `step ${c}: its wish left again as step ${again}`, leaveAgain: c }])
        // Settled: not tried a third time.
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect((await audited(STEP_LEFT_ACTION)).filter((row) => row.details['leftAgainFor'] === c)).toHaveLength(1)
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
        await webhook(null)
        pastTheWindow()
        expect((await reconcileNow(stripe, 'run-4')).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
        await webhook(ENDS)
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
        expect(await lastDay()).toBe('2026-12-09')
        expect(await listed()).toEqual([])
      })
    })

    it("item 2: it fails on the next run too. That run reports it again, and the one after leaves the wish again", async () => {
      await onASeed(async (stripe) => {
        await cancelThenUnclearUndo(stripe)
        pastTheWindow()
        const fails = failing("NEW.details->>'leftAgainFor' IS NOT NULL")
        await whileFailing(db, fails, () => reconcileNow(racing(stripe, pressC, false), 'run-1'))
        const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
        const second = await whileFailing(db, fails, () => reconcileNow(stripe, 'run-2'))
        expect(second.items).toEqual([{ kind: 'step', id: c, outcome: 'left', reason: 'step_not_left_again', detail: expect.stringMatching(new RegExp(`^step ${c}: not left again yet \\(.*connection lost.*\\)$`)) }])
        // W46: still listed, once, after two runs that could not leave it again.
        expect(await listed()).toEqual([notLeftAgainLine(c)])
        const third = await reconcileNow(stripe, 'run-3')
        const again = String((await listed())[0]?.stepId)
        expect(third.items).toEqual([{ kind: 'step', id: c, outcome: 'settled_elsewhere', detail: `step ${c}: its wish left again as step ${again}` }])
        expect((await reconcileNow(stripe)).items).toEqual([])
      })
    })

    it("item 2: only while the step it stands for is still the newest. Staff press Undo (D) between the two runs: the next run leaves nothing again, says why, and does not try a third time", async () => {
      await onASeed(async (stripe) => {
        await cancelThenUnclearUndo(stripe)
        pastTheWindow()
        await whileFailing(db, failing("NEW.details->>'leftAgainFor' IS NOT NULL"), () => reconcileNow(racing(stripe, pressC, false), 'run-1'))
        const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
        expect(await listed()).toEqual([notLeftAgainLine(c)])
        expect((await press('undo-cancel')).status).toBe(200)
        const next = await reconcileNow(stripe, 'run-2')
        expect(next.items).toEqual([{ kind: 'step', id: c, outcome: 'settled_elsewhere', detail: `step ${c}: not left again (a newer change has been made since)` }])
        expect((await audited(STEP_LEFT_ACTION)).filter((row) => 'leftAgainFor' in row.details)).toEqual([])
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(await listed()).toEqual([])
      })
    })

    it("items 1 and 2 together: the mark itself can't be written. The run reports it; C's press ends as done meanwhile; the next run finds C done and leaves its wish again, so the late clear is still found", async () => {
      await onASeed(async (stripe) => {
        const b = await cancelThenUnclearUndo(stripe)
        pastTheWindow()
        const pressOfC = heldPress(stripe, 'cancel')
        const run = await whileFailing(db, failing("NEW.details->>'state' = 'stale_send'"), () => reconcileNow(racing(stripe, pressOfC.start, false), 'run-1'))
        const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
        expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'left', reason: 'step_not_left_again', detail: expect.stringMatching(new RegExp(`^replaced by step ${c}: this run's send of the replaced step got no clear answer and may still land: not marked yet \\(.*connection lost.*\\)$`)) }])
        expect((await reconcileRows()).at(-1)?.[1]).toMatchObject({ leaveAgain: c })
        // W46: while C's step is open it is on the list as itself, once (not twice).
        expect((await listed()).map((line) => [line.stepId, line.words])).toEqual([[c, LEFT_STEP_WORDS.cancel_at.left(MO_SUBSCRIPTION)]])
        await pressOfC.finish()
        expect(await statesOf(c)).toEqual(['done', 'left'])
        // W46: closed by its press with its mark never written: listed as not left again yet, until the next run.
        expect(await listed()).toEqual([notLeftAgainLine(c)])
        const next = await reconcileNow(stripe, 'run-2')
        const again = String((await listed())[0]?.stepId)
        expect(next.items).toEqual([{ kind: 'step', id: c, outcome: 'settled_elsewhere', detail: `step ${c}: its wish left again as step ${again}` }])
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
        await webhook(null)
        pastTheWindow()
        expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
        await webhook(ENDS)
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
        expect(await lastDay()).toBe('2026-12-09')
      })
    })

    // Brief W40c. The net under W40a and W40b: every step that closes is checked once more against Stripe, 20 minutes
    // later, by one read set against the newest wish. Mo pays £40 a month and renews on 10 December.
    describe('W40c: one check read after every membership step closes', () => {
      const CHECK_MS = CHECK_AFTER_MINUTES * 60_000
      /** Every closing so far is now older than the check waits. */
      const pastTheCheck = () => vi.setSystemTime(Date.now() + CHECK_MS + 60_000)
      const checkRows = async () => (await audited(STEP_CHECK_ACTION)).map((row) => row.details)
      const leftAgainRows = async () => (await audited(STEP_LEFT_ACTION)).filter((row) => 'leftAgainFor' in row.details)
      const methods = (stripe: FakeStripe, from: number) => stripe.calls.slice(from).map((call) => call.method)
      const disagreed = (newest: string, shown: number | null) =>
        `cancel_at on subscription ${MO_SUBSCRIPTION}: checked after closing: step ${newest}: Stripe shows cancel_at ${shown ?? 'none'}, not its wish: left again`
      const runOn = (runDb: Db, stripe: FakeStripe) => reconcile(runDb, stripe, { actor: { type: 'system', id: null }, requestId: 'run-1', maxItems: 50, budgetMs: 60_000 })
      /** The database as a run reaches it, refusing every statement and transaction `fails` picks (null: a transaction). */
      function dbFailing(fails: (sql: string | null) => boolean): Db {
        return new Proxy(db, {
          get(target, prop) {
            const value = Reflect.get(target, prop) as unknown
            if (typeof value !== 'function') return value
            const real = value as (...args: unknown[]) => unknown
            if (prop !== 'query' && prop !== 'transaction') return real.bind(target)
            return async (...args: unknown[]) => {
              if (fails(prop === 'query' ? String(args[0]) : null)) throw new Error('connection lost')
              return real.apply(target, args)
            }
          },
        })
      }

      /**
       * Where each of W40b's open paths ends: every step closed, nothing listed, and Stripe on an older wish than the
       * newest step's (`wish`: 10 December, or null for no end). From here: the check reads Stripe once, leaves the
       * newest wish again and lists it; a new press waits; the next run past the window sends it; Stripe and the
       * membership agree; and the step the check left is checked itself, with one read and nothing else.
       */
      async function caughtByTheCheck(stripe: FakeStripe, newest: string, wish: number | null): Promise<void> {
        const stale = wish === null ? ENDS : null
        const line = wish === null ? ['left', 'clear_cancel_date', undefined] : ['left', 'cancel_date', '2026-12-09']
        expect(await listed()).toEqual([])
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(stale)
        expect(await checkRows()).toEqual([])
        // Inside 20 minutes of the last closing nothing is read.
        const calls = stripe.calls.length
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(stripe.calls).toHaveLength(calls)
        pastTheCheck()
        const run = await reconcileNow(stripe, 'check-1')
        const again = String((await listed())[0]?.stepId)
        expect(run.items).toEqual([{ kind: 'step', id: again, outcome: 'left', reason: 'step_check_disagreed', detail: disagreed(newest, stale) }])
        expect(run.left).toBe(1)
        // One read, and nothing sent by the check itself.
        expect(methods(stripe, calls)).toEqual(['subscriptions.retrieve'])
        const [row] = await checkRows()
        expect(row).toMatchObject({ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', outcome: 'left_again', wish: newest, leftAgain: again })
        expect(row?.['steps']).toContain(newest)
        expect(await checkRows()).toHaveLength(1)
        // Listed, as the newest wish, naming the step it stands for.
        expect(await lines()).toEqual([[again, ...line]])
        // W58b (the W45 audit's row 30): an undo's line in the undo's own words.
        expect((await listed())[0]?.words).toBe(wish === null ? LEFT_STEP_WORDS.undo.left(MO_SUBSCRIPTION) : LEFT_STEP_WORDS.cancel_at.left(MO_SUBSCRIPTION))
        expect(await leftRowOf(again)).toMatchObject({ actor_type: 'system', entity_id: ID.membership, details: { kind: 'cancel_at', subscriptionId: MO_SUBSCRIPTION, want: { cancelAt: wish }, leftAgainFor: newest } })
        // A new press waits, and a run inside the window leaves the step alone.
        expect(refusalOf(await press(wish === null ? 'undo-cancel' : 'cancel'))).toEqual([409, 'CONFLICT', 'still_sending', MEMBERSHIP_CANCEL_NEW_WORDS.stillSending])
        expect((await reconcileNow(stripe)).items).toEqual([])
        // Past the window the run sends the newest wish, and Stripe's event puts the membership right.
        pastTheWindow()
        expect((await reconcileNow(stripe, 'check-2')).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
        expect(updates(stripe).at(-1)).toMatchObject({ params: { cancel_at: wish ?? '', proration_behavior: 'none' }, idempotencyKey: `${again}:cancel-at:check-2` })
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(wish)
        await webhook(wish)
        expect(await lastDay()).toBe(wish === null ? null : '2026-12-09')
        expect(await listed()).toEqual([])
        // The step the check left is checked in its turn: one read, a `checked` row, and then nothing more, ever.
        pastTheCheck()
        const before = stripe.calls.length
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(methods(stripe, before)).toEqual(['subscriptions.retrieve'])
        expect((await checkRows()).at(-1)).toEqual({ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: [again], outcome: 'checked', wish: again, detail: `step ${again}: Stripe shows it` })
        pastTheCheck()
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(stripe.calls).toHaveLength(before + 1)
        expect(await checkRows()).toHaveLength(2)
        expect(await leftAgainRows()).toHaveLength(1)
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(wish)
        expect(stripe.netPence).toBe(0)
      }

      it("W40b's path 1: a press made just after the run has looked. The run's clear (B) gets no answer and B stays open; Cancel (C) replaces it and is done; B then lands. Mo would have been charged £40 on 10 December: the check finds no end date, leaves the cancel again, and it is sent", async () => {
        await onASeed(async (stripe) => {
          const b = await cancelThenUnclearUndo(stripe)
          pastTheWindow()
          stripe.failNext('subscriptions.update', noAnswer())
          expect((await reconcileNow(stripe, 'run-1')).items).toMatchObject([{ kind: 'step', id: b, outcome: 'left', reason: 'step_left' }])
          await pressC()
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          expect(await statesOf(b)).toEqual(['left', 'replaced'])
          expect(await statesOf(c)).toEqual(['done', 'left'])
          // B's request lands in Stripe now, after everything, and its event reaches the webhook.
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
          await webhook(null)
          expect(await lastDay()).toBeNull()
          await caughtByTheCheck(stripe, c, ENDS)
        })
      })

      it("W40b's path 2: a newer press between the run's look and its write. Undo (D) is pressed while the run's resend of C is on its way, so C's wish is not left again; the resend then lands after D. Mo would have lost the membership staff had just restored: the check finds 10 December, leaves the undo again, and the end date is cleared", async () => {
        await onASeed(async (stripe) => {
          await cancelThenUnclearUndo(stripe)
          pastTheWindow()
          const dThenNoAnswer = async () => {
            expect((await press('undo-cancel')).status).toBe(200)
            stripe.failNext('subscriptions.update', noAnswer())
          }
          await reconcileNow(racing(stripe, pressC, true, dThenNoAnswer), 'run-1')
          const d = await lastStepOf(CANCEL_UNDONE_ACTION)
          expect(await statesOf(d)).toEqual(['done', 'left'])
          expect(await leftAgainRows()).toEqual([])
          // The run's resend of C's cancel lands in Stripe now, after D.
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
          await webhook(ENDS)
          expect(await lastDay()).toBe('2026-12-09')
          await caughtByTheCheck(stripe, d, null)
        })
      })

      it("W40b's path 3: the run's own send of the newest step's wish is the unclear one. Its clear of B lands, its resend of open step C gets no answer, C's press ends as done, Undo (D) is done, and the resend of C's cancel lands after D. The check leaves the undo again and the end date is cleared", async () => {
        await onASeed(async (stripe) => {
          const b = await cancelThenUnclearUndo(stripe)
          pastTheWindow()
          const pressOfC = heldPress(stripe, 'cancel')
          const run = await reconcileNow(racing(stripe, pressOfC.start, true, async () => stripe.failNext('subscriptions.update', noAnswer())), 'run-1')
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'settled_elsewhere', detail: `replaced by step ${c}, which got no clear answer (An error occurred with our API.)` }])
          // The first send was clear, so nothing is marked: C's press ends as done.
          expect(await statesOf(c)).toEqual(['left'])
          expect((await pressOfC.finish()).data).toMatchObject({ stripeUpdated: true })
          expect(await statesOf(c)).toEqual(['done', 'left'])
          expect((await press('undo-cancel')).status).toBe(200)
          const d = await lastStepOf(CANCEL_UNDONE_ACTION)
          expect(await statesOf(d)).toEqual(['done', 'left'])
          expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
          // The run's resend of C's cancel lands in Stripe now, after D.
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
          await webhook(ENDS)
          await caughtByTheCheck(stripe, d, null)
        })
      })

      it("W40b's path 4: the database fails on the run's read between its send and its look for a newer step. The item is only reported as unexpected, with C already done; B's clear then lands. The check leaves the cancel again and it is sent", async () => {
        await onASeed(async (stripe) => {
          const b = await cancelThenUnclearUndo(stripe)
          pastTheWindow()
          let armed = false
          const failsOnce = dbFailing((sql) => {
            if (!armed || sql === null || !sql.includes("details->>'replacedBy' IS NOT NULL")) return false
            armed = false
            return true
          })
          const pressCThenFail = async () => {
            await pressC()
            armed = true
          }
          const run = await runOn(failsOnce, racing(stripe, pressCThenFail, false))
          expect(run.items).toEqual([{ kind: 'step', id: b, outcome: 'left', reason: 'unexpected', detail: 'connection lost' }])
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          expect(await statesOf(c)).toEqual(['done', 'left'])
          expect(await leftAgainRows()).toEqual([])
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
          await webhook(null)
          await caughtByTheCheck(stripe, c, ENDS)
        })
      })

      it("W40b's path 5: the run can't write its own audit row for a wish it could not leave again, so the run fails as a whole and no later run knows to try. B's clear then lands. The check leaves the cancel again and it is sent", async () => {
        await onASeed(async (stripe) => {
          await cancelThenUnclearUndo(stripe)
          pastTheWindow()
          const fails = { table: 'audit_log', event: 'INSERT' as const, when: `(NEW.action = '${STEP_LEFT_ACTION}' AND NEW.details->>'leftAgainFor' IS NOT NULL) OR NEW.action = 'order.reconcile'` }
          await expect(whileFailing(db, fails, () => reconcileNow(racing(stripe, pressC, false), 'run-1'))).rejects.toThrow(/connection lost/)
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          expect(await statesOf(c)).toEqual(['done', 'left'])
          expect(await reconcileRows()).toEqual([])
          expect(await leftAgainRows()).toEqual([])
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
          await webhook(null)
          await caughtByTheCheck(stripe, c, ENDS)
        })
      })

      it("W40b's path 6: the run is stopped between its send and its look (everything after the send fails). C is done meanwhile and B's clear then lands. The check leaves the cancel again and it is sent", async () => {
        await onASeed(async (stripe) => {
          await cancelThenUnclearUndo(stripe)
          pastTheWindow()
          let dead = false
          const pressCThenDie = async () => {
            await pressC()
            dead = true
          }
          await expect(runOn(dbFailing(() => dead), racing(stripe, pressCThenDie, false))).rejects.toThrow(/connection lost/)
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          expect(await statesOf(c)).toEqual(['done', 'left'])
          expect(await reconcileRows()).toEqual([])
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
          await webhook(null)
          await caughtByTheCheck(stripe, c, ENDS)
        })
      })

      it('a step closed cleanly gets one read and nothing else: not before 20 minutes, then one read, one `checked` row, nothing listed, nothing sent, and never read again', async () => {
        await onASeed(async (stripe) => {
          expect((await press('cancel')).data).toMatchObject({ stripeUpdated: true })
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          const calls = stripe.calls.length
          // Past the press's window, but not yet past the check's margin: nothing.
          pastTheWindow()
          expect((await reconcileNow(stripe)).items).toEqual([])
          expect(stripe.calls).toHaveLength(calls)
          expect(await checkRows()).toEqual([])
          pastTheCheck()
          const run = await reconcileNow(stripe, 'check-1')
          expect(run).toMatchObject({ checked: 0, finalised: 0, left: 0, deferred: 0, items: [] })
          expect(stripe.calls.slice(calls)).toEqual([{ method: 'subscriptions.retrieve', params: { id: MO_SUBSCRIPTION }, idempotencyKey: null }])
          expect(await audited(STEP_CHECK_ACTION)).toEqual([
            {
              action: STEP_CHECK_ACTION,
              actor_type: 'system',
              actor_id: null,
              entity_type: 'membership',
              entity_id: ID.membership,
              details: { subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: [c], outcome: 'checked', wish: c, detail: `step ${c}: Stripe shows it` },
            },
          ])
          // The run writes no row of its own for a quiet check, and no step is left.
          expect(await reconcileRows()).toEqual([])
          expect(await statesOf(c)).toEqual(['done', 'left'])
          expect(await listed()).toEqual([])
          for (let i = 0; i < 2; i++) {
            pastTheCheck()
            expect((await reconcileNow(stripe)).items).toEqual([])
          }
          expect(stripe.calls).toHaveLength(calls + 1)
          expect(await checkRows()).toHaveLength(1)
          expect(await lastDay()).toBe('2026-12-09')
        })
      })

      it('two closings, one read: a second step that closed inside the last 20 minutes holds the check back, and one read then covers both', async () => {
        await onASeed(async (stripe) => {
          await press('cancel')
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          pastTheCheck()
          expect((await press('undo-cancel')).status).toBe(200)
          const d = await lastStepOf(CANCEL_UNDONE_ACTION)
          const calls = stripe.calls.length
          // C's closing is due, but D (the newest) closed a moment ago: its own check is due soon, and covers both.
          expect((await reconcileNow(stripe)).items).toEqual([])
          expect(stripe.calls).toHaveLength(calls)
          expect(await checkRows()).toEqual([])
          pastTheCheck()
          expect((await reconcileNow(stripe)).items).toEqual([])
          expect(methods(stripe, calls)).toEqual(['subscriptions.retrieve'])
          const rows = await checkRows()
          expect(rows).toEqual([{ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: expect.any(Array), outcome: 'checked', wish: d, detail: `step ${d}: Stripe shows it` }])
          expect([...(rows[0]?.['steps'] as string[])].sort()).toEqual([c, d].sort())
        })
      })

      it('the newest step still open: nothing is read for the steps closed before it. It is listed already, the run sends it, and it is checked itself when it closes', async () => {
        await onASeed(async (stripe) => {
          await press('cancel')
          const a = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          pastTheWindow()
          stripe.failNext('subscriptions.update', noAnswer())
          const b = ((await press('undo-cancel')).data?.['left'] as { stepId: string }).stepId
          pastTheCheck()
          const calls = stripe.calls.length
          expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: b, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
          // The step's own read and send; none for the check.
          expect(methods(stripe, calls)).toEqual(['subscriptions.retrieve', 'subscriptions.update'])
          expect(await checkRows()).toEqual([{ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: [a], outcome: 'open', wish: b, detail: `the newest step ${b} is still open: listed, and checked when it closes` }])
          pastTheCheck()
          expect((await reconcileNow(stripe)).items).toEqual([])
          expect(methods(stripe, calls)).toEqual(['subscriptions.retrieve', 'subscriptions.update', 'subscriptions.retrieve'])
          expect((await checkRows()).at(-1)).toMatchObject({ steps: [b], outcome: 'checked', wish: b })
        })
      })

      it("a check that can't read Stripe writes nothing and tries again every run; a clear read then ends it", async () => {
        await onASeed(async (stripe) => {
          await press('cancel')
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          pastTheCheck()
          const calls = stripe.calls.length
          for (let i = 1; i <= 3; i++) {
            stripe.failNext('subscriptions.retrieve', noAnswer())
            expect((await reconcileNow(stripe)).items).toEqual([])
            expect(methods(stripe, calls)).toEqual(Array(i).fill('subscriptions.retrieve'))
            expect(await checkRows()).toEqual([])
            expect(await listed()).toEqual([])
          }
          expect((await reconcileNow(stripe)).items).toEqual([])
          expect(await checkRows()).toEqual([{ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: [c], outcome: 'checked', wish: c, detail: `step ${c}: Stripe shows it` }])
          expect(await leftAgainRows()).toEqual([])
        })
      })

      it('W40d (L4): after 2 hours with no clear read the wish is left again, so it is listed in plain words; every run then reads Stripe for it, and the first clear read takes it off the list', async () => {
        await onASeed(async (stripe) => {
          expect(CHECK_UNREAD_HOURS).toBe(2)
          await press('cancel')
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          // 1 hour 55 minutes on: still only tried again.
          vi.setSystemTime(Date.now() + 115 * 60_000)
          stripe.failNext('subscriptions.retrieve', noAnswer())
          expect((await reconcileNow(stripe)).items).toEqual([])
          expect(await listed()).toEqual([])
          expect(await checkRows()).toEqual([])
          vi.setSystemTime(Date.now() + 6 * 60_000)
          stripe.failNext('subscriptions.retrieve', noAnswer())
          const run = await reconcileNow(stripe, 'check-1')
          const again = String((await listed())[0]?.stepId)
          const detail = `step ${c}: no clear read of Stripe in 2 hours (not read (An error occurred with our API.)): left again`
          expect(run.items).toEqual([{ kind: 'step', id: again, outcome: 'left', reason: 'step_check_unread', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: checked after closing: ${detail}` }])
          expect(await checkRows()).toEqual([{ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: [c], outcome: 'unread', wish: c, leftAgain: again, detail }])
          expect(await lines()).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
          expect((await listed())[0]?.words).toBe(LEFT_STEP_WORDS.cancel_at.left(MO_SUBSCRIPTION))
          expect((await leftRowOf(again))?.details).toMatchObject({ leftAgainFor: c, want: { cancelAt: ENDS } })
          // Still no answer past its window: it stays listed, as any open step.
          pastTheWindow()
          stripe.failNext('subscriptions.retrieve', noAnswer())
          expect((await reconcileNow(stripe)).items).toMatchObject([{ kind: 'step', id: again, outcome: 'left', reason: 'step_left' }])
          expect(await lines()).toEqual([[again, 'left', 'cancel_date', '2026-12-09']])
          const sent = updates(stripe).length
          expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: Stripe already showed it` }])
          expect(updates(stripe)).toHaveLength(sent)
          expect(await listed()).toEqual([])
        })
      })

      it("two runs at once don't leave the wish twice: the second run's check, at Stripe for its read while the first does the whole check, finds the closings covered under the lock and writes nothing", async () => {
        await onASeed(async (stripe) => {
          await press('cancel')
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          // A late clear has landed over the cancel.
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
          pastTheCheck()
          let inner: Awaited<ReturnType<typeof reconcileNow>> | undefined
          const outer = await reconcileNow(withGapBeforeStripe(stripe, async () => void (inner = await reconcileNow(stripe, 'run-b'))) as unknown as FakeStripe, 'run-a')
          const again = String((await listed())[0]?.stepId)
          expect(inner?.items).toEqual([{ kind: 'step', id: again, outcome: 'left', reason: 'step_check_disagreed', detail: disagreed(c, null) }])
          expect(outer.items).toEqual([])
          expect(await leftAgainRows()).toHaveLength(1)
          expect(await checkRows()).toHaveLength(1)
          expect(await listed()).toHaveLength(1)
          expect((await stepStates()).filter(([, state]) => state === 'left')).toHaveLength(2)
        })
      })

      it("only while it is still the newest: staff press Undo (D) between the check's read and its write. Nothing is left again over D and no row is written; the next check reads for D, one read for both", async () => {
        await onASeed(async (stripe) => {
          await press('cancel')
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          // A late clear has landed over the cancel; its event has not reached the webhook yet.
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
          pastTheCheck()
          // The check has read "no end date" for C when D is pressed: its write comes after D.
          const real = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
          let fired = false
          const subscriptions = {
            ...real,
            retrieve: async (...args: unknown[]) => {
              const seen = await (real['retrieve'] as (...a: unknown[]) => Promise<unknown>)(...args)
              if (!fired) {
                fired = true
                expect((await press('undo-cancel')).status).toBe(200)
              }
              return seen
            },
          }
          const pressDAfterTheRead = new Proxy(stripe, { get: (target, prop) => (prop === 'subscriptions' ? subscriptions : Reflect.get(target, prop)) }) as unknown as FakeStripe
          expect((await reconcileNow(pressDAfterTheRead, 'check-1')).items).toEqual([])
          const d = await lastStepOf(CANCEL_UNDONE_ACTION)
          expect(await statesOf(d)).toEqual(['done', 'left'])
          expect(await leftAgainRows()).toEqual([])
          expect(await checkRows()).toEqual([])
          expect(await listed()).toEqual([])
          expect(await lastDay()).toBeNull()
          pastTheCheck()
          const calls = stripe.calls.length
          expect((await reconcileNow(stripe)).items).toEqual([])
          expect(methods(stripe, calls)).toEqual(['subscriptions.retrieve'])
          const rows = await checkRows()
          expect(rows).toMatchObject([{ outcome: 'checked', wish: d }])
          expect([...(rows[0]?.['steps'] as string[])].sort()).toEqual([c, d].sort())
          expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
        })
      })

      it("a press Stripe refused and put back is not the newest wish: Undo (D) is refused, so the cancel (C) before it stands. A late clear over it is found, and the cancel is left again and sent", async () => {
        await onASeed(async (stripe) => {
          await press('cancel')
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          stripe.failNext('subscriptions.update', no())
          expect((await press('undo-cancel')).status).toBe(409)
          const d = await lastStepOf(CANCEL_UNDONE_ACTION)
          expect(await statesOf(d)).toEqual(['left', 'undone'])
          expect(await lastDay()).toBe('2026-12-09')
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
          pastTheCheck()
          const run = await reconcileNow(stripe, 'check-1')
          const again = String((await listed())[0]?.stepId)
          expect(run.items).toEqual([{ kind: 'step', id: again, outcome: 'left', reason: 'step_check_disagreed', detail: disagreed(c, null) }])
          expect((await leftRowOf(again))?.details).toMatchObject({ leftAgainFor: c, want: { cancelAt: ENDS } })
          const [row] = await checkRows()
          expect(row).toMatchObject({ outcome: 'left_again', wish: c, leftAgain: again })
          expect([...(row?.['steps'] as string[])].sort()).toEqual([c, d].sort())
          pastTheWindow()
          expect((await reconcileNow(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
          expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
        })
      })

      it("the newest wish, not the membership's row: the webhook has copied a late clear onto the membership, which then agrees with Stripe, and the check still finds the cancel missing", async () => {
        await onASeed(async (stripe) => {
          await press('cancel')
          const c = await lastStepOf(CANCEL_SCHEDULED_ACTION)
          stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
          await webhook(null)
          // The membership and Stripe agree on "no end date"; the newest wish is 10 December.
          expect(await lastDay()).toBeNull()
          pastTheCheck()
          expect((await reconcileNow(stripe)).items).toMatchObject([{ kind: 'step', outcome: 'left', reason: 'step_check_disagreed' }])
          expect((await checkRows())[0]).toMatchObject({ outcome: 'left_again', wish: c })
        })
      })
    })
  })
})

// Brief W46 item 3 (G-plan 2.1; W45a "Noticed" 8, the W45 audit's S1 fix 3). The check after closing also sets the
// membership's own row against Stripe. Before W46 a row that disagreed with Stripe while Stripe showed the newest wish
// left nothing ("With the row changed and Stripe right, it leaves nothing"): the member read as ending, or not, on a
// day Stripe didn't have, and nothing listed it.
describe("W46: the check sets the membership's own last day against Stripe's, and lists a mismatch for a person", () => {
  const pastTheCheck = () => vi.setSystemTime(Date.now() + CHECK_AFTER_MINUTES * 60_000 + 60_000)
  const checkRows = async () => (await audited(STEP_CHECK_ACTION)).map((row) => row.details)
  const sends = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.update').length
  const setRow = (day: string | null) => db.query('UPDATE customer_memberships SET cancel_effective_date = $1::date WHERE id = $2', [day, ID.membership])
  const lastStepOf = async (action: string) => String((await db.query<{ step: string }>("SELECT details->>'stepId' AS step FROM audit_log WHERE action = $1 ORDER BY at DESC LIMIT 1", [action]))[0]?.step)

  it.each([
    ['the row has no last day, Stripe ends the subscription on 10 December (the wish)', 'cancel', null, { row: null, stripe: '2026-12-09' }],
    ['the row says 20 December, Stripe ends it on 10 December (the wish)', 'cancel', '2026-12-20', { row: '2026-12-20', stripe: '2026-12-09' }],
    ['the row says 9 December, Stripe has no end (the wish: an undo)', 'undo', '2026-12-09', { row: '2026-12-09', stripe: null }],
  ] as const)('%s: one read, no send; the wish is left again as a refused step with both days, listed with its own words and Mark sorted; the row is not changed; no later run reads, sends or lists again', async (_name, wish, rowDay, mismatch) => {
    await onASeed(async (stripe) => {
      expect((await press('cancel')).status).toBe(200)
      if (wish === 'undo') expect((await press('undo-cancel')).status).toBe(200)
      const newest = await lastStepOf(wish === 'cancel' ? CANCEL_SCHEDULED_ACTION : CANCEL_UNDONE_ACTION)
      // Stripe shows the wish. Something else has changed the membership's row.
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt ?? null).toBe(wish === 'cancel' ? ENDS : null)
      await setRow(rowDay)
      // Not before the 20 minutes.
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await listed()).toEqual([])
      pastTheCheck()
      const calls = stripe.calls.length
      const sent = sends(stripe)
      const run = await reconcileNow(stripe)
      const [line] = await listed()
      const again = String(line?.stepId)
      const message = `The membership's last day is ${mismatch.row ?? 'not set'}, but subscription ${MO_SUBSCRIPTION} in Stripe gives ${mismatch.stripe ?? 'no end'}. Nothing was sent or changed.`
      expect(run.items).toEqual([
        { kind: 'step', id: again, outcome: 'left', reason: 'step_check_row_differs', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: checked after closing: step ${newest}: Stripe shows it. ${message} Left for a person` },
      ])
      // One read of Stripe, and nothing sent.
      expect(stripe.calls.slice(calls).map((call) => call.method)).toEqual(['subscriptions.retrieve'])
      expect(sends(stripe)).toBe(sent)
      expect((await checkRows()).at(-1)).toMatchObject({ outcome: 'row_differs', wish: newest, leftAgain: again })
      // Listed for a person: refused, with both days in its words, and Mark sorted.
      expect(await listed()).toHaveLength(1)
      expect(line).toMatchObject({
        state: 'refused',
        what: wish === 'cancel' ? 'cancel_date' : 'clear_cancel_date',
        words: LEFT_STEP_WORDS.rowDiffers(MO_SUBSCRIPTION, mismatch.row, mismatch.stripe),
        close: { kind: 'left_step', orderId: again },
      })
      expect(line?.words).not.toBe(LEFT_STEP_WORDS.cancel_at.refused(MO_SUBSCRIPTION))
      const refusedRow = (await audited(STEP_LEFT_ACTION)).find((row) => row.details['stepId'] === again && row.details['state'] === 'refused')
      expect(refusedRow?.details).toMatchObject({ detail: message, mismatch, want: { cancelAt: wish === 'cancel' ? ENDS : null } })
      // The row is as it was found, and Stripe as it was.
      expect(await lastDay()).toBe(rowDay)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt ?? null).toBe(wish === 'cancel' ? ENDS : null)
      // Later runs: the refused step is never sent, and nothing more is read or listed.
      for (let round = 0; round < 3; round++) {
        pastTheCheck()
        const before = stripe.calls.length
        // A refused step is not due: the run has no item for it at all.
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(stripe.calls).toHaveLength(before)
        expect((await listed()).map((one) => one.stepId)).toEqual([again])
      }
      expect(sends(stripe)).toBe(sent)
    })
  })

  it('the row and Stripe agree: one `checked` row and nothing listed, as before W46 (with an end, and with none)', async () => {
    await onASeed(async (stripe) => {
      expect((await press('cancel')).status).toBe(200)
      pastTheCheck()
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await checkRows()).toMatchObject([{ outcome: 'checked' }])
      expect(await listed()).toEqual([])
      expect((await press('undo-cancel')).status).toBe(200)
      pastTheCheck()
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect((await checkRows()).map((row) => row['outcome'])).toEqual(['checked', 'checked'])
      expect(await listed()).toEqual([])
    })
  })

  it("the person puts the membership right with the app's own button (Undo cancellation): the mismatch line goes, Stripe is sent nothing it already shows, and the next check finds the two agree", async () => {
    await onASeed(async (stripe) => {
      expect((await press('cancel')).status).toBe(200)
      expect((await press('undo-cancel')).status).toBe(200)
      await setRow('2026-12-09')
      pastTheCheck()
      await reconcileNow(stripe)
      expect((await listed()).map((line) => line.state)).toEqual(['refused'])
      // The row says the membership ends on 9 December and Stripe has no end. Staff press Undo cancellation.
      const sent = sends(stripe)
      expect((await press('undo-cancel')).status).toBe(200)
      expect(sends(stripe)).toBe(sent)
      expect(await lastDay()).toBeNull()
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt ?? null).toBeNull()
      expect(await listed()).toEqual([])
      pastTheCheck()
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect((await checkRows()).at(-1)).toMatchObject({ outcome: 'checked' })
      expect(await listed()).toEqual([])
    })
  })

  it('Mark sorted on the mismatch line closes it: its `checked` row is written at once, and it is never read, sent or listed again', async () => {
    await onASeed(async (stripe) => {
      expect((await press('cancel')).status).toBe(200)
      await setRow(null)
      pastTheCheck()
      await reconcileNow(stripe)
      const [line] = await listed()
      const again = String(line?.stepId)
      const calls = stripe.calls.length
      const sorted = await closeStuckItem(db, { kind: 'left_step', orderId: again, reason: 'the membership was put right by hand' }, { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID() })
      expect(sorted).toMatchObject({ closed: true })
      expect(await listed()).toEqual([])
      expect((await checkRows()).at(-1)).toEqual({ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: [again], outcome: 'checked', wish: again, detail: `step ${again} was marked sorted by a person: not held to Stripe` })
      for (let round = 0; round < 3; round++) {
        pastTheCheck()
        expect((await reconcileNow(stripe)).items).toEqual([])
      }
      expect(stripe.calls).toHaveLength(calls)
      expect(await listed()).toEqual([])
    })
  })

  it('a membership that has ended in the database is not compared (it keeps the day it ended on)', async () => {
    await onASeed(async (stripe) => {
      expect((await press('cancel')).status).toBe(200)
      // The row ended some other way, on another day; Stripe still shows the wish on a running subscription.
      await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled', cancel_effective_date = '2026-11-30' WHERE id = $1", [ID.membership])
      pastTheCheck()
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await checkRows()).toMatchObject([{ outcome: 'checked' }])
      expect(await listed()).toEqual([])
    })
  })

  it("the row changes between the check's read and its lock (the webhook lands): nothing is written, and the next run reads again and finds the two agree", async () => {
    await onASeed(async (stripe) => {
      expect((await press('cancel')).status).toBe(200)
      await setRow(null)
      pastTheCheck()
      // The webhook's write lands after the check has read Stripe and the row, just before the check's own
      // transaction (the first one the run opens).
      let landed = false
      const landing: Db = new Proxy(db, {
        get: (target, prop) =>
          prop === 'transaction'
            ? async (work: Parameters<Db['transaction']>[0]) => {
                if (!landed) {
                  landed = true
                  await webhook(ENDS)
                }
                return target.transaction(work)
              }
            : Reflect.get(target, prop),
      })
      expect((await reconcile(landing, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })).items).toEqual([])
      expect(landed).toBe(true)
      expect(await checkRows()).toEqual([])
      expect(await listed()).toEqual([])
      expect(await lastDay()).toBe('2026-12-09')
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await checkRows()).toMatchObject([{ outcome: 'checked' }])
      expect(await listed()).toEqual([])
    })
  })

  it("Stripe ends the subscription with its period (set in Stripe's dashboard, cancel_at_period_end): the row is set against the period's end, as the webhook writes it", async () => {
    await onASeed(async (stripe) => {
      expect((await press('cancel')).status).toBe(200)
      expect((await press('undo-cancel')).status).toBe(200)
      // The undo's wish is "no cancel_at", which Stripe shows; someone ticks "cancel at period end" in the dashboard.
      // The fake's period ends on 10 December at 09:00, so the last day that gives is 9 December.
      const endsWithPeriod = { ...stripe, subscriptions: { ...stripe.subscriptions, retrieve: async (...args: Parameters<FakeStripe['subscriptions']['retrieve']>) => ({ ...(await stripe.subscriptions.retrieve(...args)), cancel_at_period_end: true }) } } as unknown as FakeStripe
      pastTheCheck()
      const run = await reconcileNow(endsWithPeriod)
      expect(run.items).toMatchObject([{ kind: 'step', outcome: 'left', reason: 'step_check_row_differs' }])
      expect((await listed())[0]?.words).toBe(LEFT_STEP_WORDS.rowDiffers(MO_SUBSCRIPTION, null, '2026-12-09'))
    })
  })
})

describe('the webhook stays (F-plan 4.3)', () => {
  it("an unrelated subscription event between M1 and the Stripe step: the webhook clears the date for a moment (Stripe doesn't show the cancel yet), the Stripe step goes, and its own event puts the date back", async () => {
    await onASeed(async (stripe) => {
      const seen: Array<string | null> = []
      replayStripe.current = withGapBeforeStripe(stripe, async () => {
        seen.push(await lastDay())
        // Any other change to the subscription (its card, say): Stripe's event still shows no cancel date.
        await webhook(null)
        seen.push(await lastDay())
      })
      const answer = await press('cancel')
      replayStripe.current = stripe
      expect(seen).toEqual(['2026-12-09', null])
      // The press is unharmed: Stripe has the date, and the step is done.
      expect(answer.data).toMatchObject({ membership: { cancel_effective_date: '2026-12-09' }, stripeUpdated: true })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await lastDay()).toBeNull()
      // The Stripe step's own event arrives a moment later, and the webhook writes the date back from it.
      await webhook(ENDS)
      expect(await lastDay()).toBe('2026-12-09')
      expect(await listed()).toEqual([])
    })
  })

  it('the same event before a step Stripe then refuses: the put-back finds the date already as Stripe has it and leaves it alone', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      replayStripe.current = withGapBeforeStripe(stripe, () => webhook(null))
      const answer = await press('cancel')
      replayStripe.current = stripe
      expect(refusalOf(answer)[2]).toBe('stripe_refused')
      expect(await lastDay()).toBeNull()
      expect((await audited(CANCEL_PUT_BACK_ACTION))[0]?.details).toMatchObject({ restored: false, cancelEffectiveDate: { before: '2026-12-09', after: null } })
    })
  })

  it('once cancelled in both places, the webhook finds nothing to change', async () => {
    await onASeed(async () => {
      await press('cancel')
      expect(await webhook(ENDS)).toEqual([{ membership_sync_cancel_at_period_end: expect.objectContaining({ action: 'unchanged', cancel_effective_date: '2026-12-09' }) }])
    })
  })
})

describe('the channel (brief W40 item 4): the rule takes it; only the staff routes exist', () => {
  const options = (actor: CancelOptions['actor'], stripe: FakeStripe): CancelOptions => ({ actor, requestId: crypto.randomUUID(), startedAt: Date.now(), stripe: () => stripe })

  it("a customer may cancel and undo their own membership with no Issue refunds; someone else's is not found; the audit rows say who and by which channel", async () => {
    await onASeed(async (stripe) => {
      const owner = { channel: 'customer' as const, id: ID.member }
      const other = { channel: 'customer' as const, id: ID.customer }
      const refused = await cancelMembership(db, ID.membership, options(other, stripe)).catch((err: unknown) => err)
      expect(refused).toBeInstanceOf(ApiError)
      expect((refused as ApiError).details).toMatchObject({ reason: 'membership_not_found', action: 'cancel' })
      expect(await lastDay()).toBeNull()

      expect(await cancelMembership(db, ID.membership, options(owner, stripe))).toMatchObject({ membership: { cancel_effective_date: '2026-12-09' }, stripeUpdated: true })
      expect((await audited(CANCEL_SCHEDULED_ACTION))[0]).toMatchObject({ actor_type: 'customer', actor_id: ID.member, details: { channel: 'customer' } })
      expect(((await undoMembershipCancel(db, ID.membership, options(other, stripe)).catch((err: unknown) => err)) as ApiError).details).toMatchObject({ reason: 'membership_not_found' })
      expect(await undoMembershipCancel(db, ID.membership, options(owner, stripe))).toEqual({ membership: { id: ID.membership, cancel_effective_date: null, billing_frequency: 'monthly' } })
      expect((await audited(STEP_LEFT_ACTION)).every((row) => row.actor_type === 'customer' && row.actor_id === ID.member)).toBe(true)
    })
  })

  it('staff without Issue refunds are refused by the rule itself, whatever the route did', async () => {
    await onASeed(async (stripe) => {
      const refused = await cancelMembership(db, ID.membership, options({ channel: 'staff', id: ID.staff, canIssueRefunds: false }, stripe)).catch((err: unknown) => err)
      expect((refused as ApiError).details).toMatchObject({ reason: 'permission_denied', message: MEMBERSHIP_CANCEL_WORDS.permissionDenied })
      expect(stripe.calls).toEqual([])
    })
  })
})

describe('the membership reads (brief W40 item 5; W35 row 10)', () => {
  async function get<T>(handler: typeof listRoute, url: string, params: Record<string, string> = {}, email = REPLAY_USER.email): Promise<{ status: number; data?: T; error?: ErrorBody }> {
    const response = await (handler as (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>)(
      new Request(`https://worker.test${url}`, { headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email } }),
      { params: Promise.resolve(params) }
    )
    return { status: response.status, ...((await response.json()) as { data?: T; error?: ErrorBody }) }
  }
  type Row = Record<string, unknown>
  const list = (search?: string, email?: string) => get<Row[]>(listRoute, `/api/v1/staff/memberships${search === undefined ? '' : `?search=${encodeURIComponent(search)}`}`, {}, email)
  const profile = (customerId: string) => get<{ memberships: Row[] }>(customerRoute as unknown as typeof listRoute, `/api/v1/staff/customers/${customerId}`, { customerId })
  /** Mo's membership sold on an order line, as the Worker's orders record it. */
  const sold: Prepare = async (seedDb) => {
    const order = await insert(seedDb, 'orders', { customer_id: ID.member, order_total: '40.00', payment_status: 'paid', payment_method: 'card', order_source: 'staff_created' })
    const line = await insert(seedDb, 'order_line_items', { order_id: order, item_type: 'membership', membership_plan_id: ID.plan, quantity: 1, unit_price: '40.00', line_total: '40.00' })
    await seedDb.query('UPDATE customer_memberships SET order_line_item_id = $1 WHERE id = $2', [line, ID.membership])
  }

  it("the Subscriptions list: the old list's fields by name, with `refunded`; never the Stripe subscription's id or the order line", async () => {
    await onASeed(async () => {
      const answer = await list()
      expect(answer.status).toBe(200)
      const mo = answer.data?.find((row) => row['id'] === ID.membership)
      expect(Object.keys(mo ?? {}).sort()).toEqual(
        [...MEMBERSHIP_LIST_COLUMNS, 'first_name', 'last_name', 'email', 'plan_name', 'plan_is_unlimited', 'current_period_end', 'current_period_credits_allocated', 'current_period_credits_remaining', 'refunded', 'payment_date_changed_at', 'payment_date_change_blocked', 'payment_date_change_needs_override'].sort()
      )
      expect(Object.keys(mo ?? {}).sort()).toEqual(Object.keys(membershipListRowSchema.shape).sort())
      expect(mo).toMatchObject({
        customer_id: ID.member,
        first_name: 'Mo',
        last_name: 'Member',
        subscription_status: 'active',
        cancel_effective_date: null,
        billing_frequency: 'monthly',
        start_date: '2026-01-10',
        next_renewal_date: '2026-12-10',
        addon_credits_remaining: 2,
        refunded: false,
        payment_date_change_blocked: null,
      })
      expect(typeof mo?.['created_at']).toBe('string')
      expect(mo).not.toHaveProperty('stripe_subscription_id')
      expect(mo).not.toHaveProperty('order_line_item_id')
    })
  })

  it('a search matches every word against the customer, the whole search against "first last", or the whole search against the plan; nothing for no match', async () => {
    await onASeed(async () => {
      const ids = async (search: string) => ((await list(search)).data ?? []).map((row) => row['id'])
      const [plan] = await db.query<{ name: string }>('SELECT name FROM membership_plans WHERE id = $1', [ID.plan])
      for (const search of ['mo', 'Member Mo', 'mo member', '  MEMBER  ', plan?.name ?? '']) expect(await ids(search), search).toContain(ID.membership)
      expect(await ids('nobody-of-that-name')).toEqual([])
      expect(await ids('mo nobody')).toEqual([])
    })
  })

  it("W35 row 10 (L9): `refunded` is worked out from the membership's own order line, on the list and on the profile alike; a cancelled membership that was not refunded is not `refunded`", async () => {
    await onASeed(async () => {
      const both = async () => [(await list()).data?.find((row) => row['id'] === ID.membership)?.['refunded'], (await profile(ID.member)).data?.memberships.find((row) => row['id'] === ID.membership)?.['refunded']]
      expect(await both()).toEqual([false, false])
      // Cancelled by Stripe (a failed payment, say), with no refund: "Cancelled".
      await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1", [ID.membership])
      expect(await both()).toEqual([false, false])
      // Another line of the same order refunded: still not the membership.
      const [line] = await db.query<{ order_line_item_id: string; order_id: string }>('SELECT cm.order_line_item_id, l.order_id FROM customer_memberships cm JOIN order_line_items l ON l.id = cm.order_line_item_id WHERE cm.id = $1', [ID.membership])
      const robe = await insert(db, 'order_line_items', { order_id: line?.order_id, item_type: 'product', product_variant_id: ID.variant, quantity: 1, unit_price: '5.00', line_total: '5.00' })
      await db.query("UPDATE order_line_items SET refunded_at = now(), refund_method = 'card' WHERE id = $1", [robe])
      expect(await both()).toEqual([false, false])
      // The membership's own line refunded: "Refunded".
      await db.query("UPDATE order_line_items SET refunded_at = now(), refund_method = 'card' WHERE id = $1", [line?.order_line_item_id])
      expect(await both()).toEqual([true, true])
    }, sold)
  })

  it("the profile's membership rows come from the same code: the same named columns as before, with `refunded` and the subscription's id", async () => {
    await onASeed(async () => {
      const mo = (await profile(ID.member)).data?.memberships[0]
      expect(Object.keys(mo ?? {}).sort()).toEqual(
        [...CUSTOMER_MEMBERSHIP_COLUMNS, 'plan_name', 'plan_is_unlimited', 'current_period_end', 'current_period_credits_allocated', 'current_period_credits_remaining', 'refunded', 'payment_date_changed_at', 'payment_date_change_blocked', 'payment_date_change_needs_override'].sort()
      )
      expect(mo).toMatchObject({ id: ID.membership, stripe_subscription_id: MO_SUBSCRIPTION, refunded: false, next_renewal_date: '2026-12-10' })
      // A cancel shows on both reads at once, with the payment date button refused for it.
      await press('cancel')
      const listedRow = (await list()).data?.find((row) => row['id'] === ID.membership)
      const profileRow = (await profile(ID.member)).data?.memberships[0]
      expect([listedRow?.['cancel_effective_date'], profileRow?.['cancel_effective_date']]).toEqual(['2026-12-09', '2026-12-09'])
      expect([listedRow?.['payment_date_change_blocked'], profileRow?.['payment_date_change_blocked']]).toEqual(['A cancellation is scheduled on this membership', 'A cancellation is scheduled on this membership'])
    })
  })

  it('FB16: any active staff member may read the list (no Issue refunds needed); an inactive account and someone with no staff record are refused', async () => {
    await onASeed(async () => {
      expect((await list(undefined, NO_REFUNDS)).status).toBe(200)
      expect([(await list(undefined, INACTIVE)).status, (await list(undefined, 'nobody@example.com')).status]).toEqual([403, 401])
    })
  })
})
