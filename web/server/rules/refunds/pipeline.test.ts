import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import * as bookingRefunds from '@/server/rules/bookings/refunds'
import { refundRefusedDetail as bookingsRefundRefusedDetail } from '@/server/rules/bookings/failure-messages'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { stripeTiming } from '@/server/stripe/deadline'
import { FakeStripe, fakeStripeErrors } from '@/server/stripe/fake'
import { refundRefusedDetail } from './failure-messages'
import {
  BOOKING_CLAIMS,
  cardPartRequest,
  CLAIM_SUBJECTS,
  claimIsFinished,
  claimRefundKey,
  claimRefusal,
  claimsDueSql,
  EVENT_BOOKING_CLAIMS,
  findCardPart,
  heldAnswer,
  listRefunds,
  markRefused,
  openClaimOn,
  openClaimSql,
  ORDER_CLAIMS,
  readClaimRow,
  sendCardPart,
  writeClaimRow,
  type CardPart,
  type ClaimSubject,
} from './pipeline'

// Brief W27 items 1 and 8: the shared refund core's own tests. It was lifted out of bookings/refunds.ts with no change
// in what it does, so these hold each piece to what step D's did (the statements word for word, the key, the request,
// each answer of one send, the mark, the look-up), and show each piece working the same on the two new subjects.
// Step D's own suite (refunds.test.ts, cancel.test.ts, move.test.ts, the replay) is the proof that bookings didn't move.
// Stripe is only ever the fake.

let database: TestDatabase
let db: Db
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
})
afterAll(() => database.stop())
beforeEach(async () => {
  await db.query('DELETE FROM audit_log')
})

const STAFF = '30000000-0000-4000-8000-000000000001'
const by = (requestId = 'w27-pipeline') => ({ actor: { id: STAFF }, requestId })
const details = (extra: Record<string, unknown> = {}) => ({ kind: 'test', amount: 10, worker: true, ...extra })

/** A paid fake PaymentIntent of `pence`, and the part that refunds `amount` of it. */
async function aPart(stripe: FakeStripe, amount = 10, pence = 4000): Promise<CardPart> {
  stripe.addCustomer('cus_w27')
  const intent = await stripe.paymentIntents.create({ amount: pence, currency: 'gbp', customer: 'cus_w27', payment_method: 'pm_w27', off_session: true, confirm: true })
  const orderId = crypto.randomUUID()
  return { orderId, paymentIntentId: intent.id, amount, lines: [{ lineId: crypto.randomUUID(), amount }] }
}
const timing = (left = 30_000) => {
  const now = Date.now()
  return stripeTiming(now - (30_000 - left), () => now)
}
const refundCalls = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')

describe('the subjects (lead call L2): one set of three actions each', () => {
  it("a booking's are step D's, unchanged; an order's and an event booking's follow the same pattern", () => {
    expect(BOOKING_CLAIMS).toEqual({ entityType: 'booking', claimed: 'booking.refund_claimed', finished: 'booking.refund_finished', refused: 'booking.refund_refused' })
    expect(ORDER_CLAIMS).toEqual({ entityType: 'order', claimed: 'order.refund_claimed', finished: 'order.refund_finished', refused: 'order.refund_refused' })
    expect(EVENT_BOOKING_CLAIMS).toEqual({
      entityType: 'event_booking',
      claimed: 'event_booking.refund_claimed',
      finished: 'event_booking.refund_finished',
      refused: 'event_booking.refund_refused',
    })
    expect(CLAIM_SUBJECTS).toEqual([BOOKING_CLAIMS, ORDER_CLAIMS, EVENT_BOOKING_CLAIMS])
    // The names bookings/refunds.ts exports are the booking subject's.
    expect(bookingRefunds.REFUND_CLAIMED).toBe(BOOKING_CLAIMS.claimed)
    expect(bookingRefunds.REFUND_FINISHED).toBe(BOOKING_CLAIMS.finished)
    expect(bookingRefunds.REFUND_REFUSED).toBe(BOOKING_CLAIMS.refused)
  })

  it('no two subjects share an action or an entity type', () => {
    const actions = CLAIM_SUBJECTS.flatMap((on) => [on.claimed, on.finished, on.refused])
    expect(new Set(actions).size).toBe(9)
    expect(new Set(CLAIM_SUBJECTS.map((on) => on.entityType)).size).toBe(3)
  })
})

describe("a booking's statements are word for word what bookings/refunds.ts ran before the lift (W21 to W26b)", () => {
  // Copied from bookings/refunds.ts as it was at Worker 31b0ac4, before W27 touched it.
  const OPEN_CLAIM_ON_BOOKING_SQL_BEFORE = `
SELECT c.id FROM audit_log c
WHERE c.action = 'booking.refund_claimed' AND c.entity_type = 'booking' AND c.entity_id = $1::text AND c.details->>'worker' = 'true'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = 'booking.refund_finished' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
LIMIT 1`
  const CLAIMS_DUE_SQL_BEFORE = `
SELECT c.id FROM audit_log c
WHERE c.action = 'booking.refund_claimed' AND c.entity_type = 'booking' AND c.details->>'worker' = 'true'
  AND c.at < now() - make_interval(mins => $1::int)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = 'booking.refund_finished' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at, c.id`
  const READ_CLAIM_SQL_BEFORE = `SELECT id, entity_id, actor_id, at, details FROM audit_log
       WHERE id = $1::uuid AND action = 'booking.refund_claimed' AND entity_type = 'booking' AND details->>'worker' = 'true'`
  const CLAIM_FINISHED_SQL_BEFORE =
    "SELECT 1 FROM audit_log WHERE action = 'booking.refund_finished' AND entity_type = 'booking' AND entity_id = $1::text AND details->>'claimId' = $2::text LIMIT 1"
  const WRITE_CLAIM_SQL_BEFORE = `INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, request_id, details)
       VALUES (clock_timestamp(), 'staff', $1::text, 'booking.refund_claimed', 'booking', $2::text, $3::text, $4::jsonb)
       RETURNING id, at`
  const CLAIM_REFUSAL_SQL_BEFORE =
    "SELECT details->>'detail' AS detail FROM audit_log WHERE action = 'booking.refund_refused' AND entity_type = 'booking' AND entity_id = $1::text AND details->>'claimId' = $2::text ORDER BY at, id LIMIT 1"

  /** Every statement and its parameters, as the core sends them. */
  function spy(): { seen: Array<{ sql: string; params: unknown[] }>; db: Db } {
    const seen: Array<{ sql: string; params: unknown[] }> = []
    const wrap = <T extends { query: Db['query'] }>(inner: T): T =>
      new Proxy(inner, {
        get(target, property, receiver) {
          if (property === 'query') {
            return (sql: string, params: unknown[] = []) => {
              seen.push({ sql, params })
              return target.query(sql, params as never[])
            }
          }
          if (property === 'transaction') {
            return (work: (tx: unknown) => Promise<unknown>) => (target as unknown as Db).transaction((tx) => work(wrap(tx as unknown as { query: Db['query'] })))
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      })
    return { seen, db: wrap(db) }
  }

  it('the open-claim look and the due list', () => {
    expect(openClaimSql(BOOKING_CLAIMS)).toBe(OPEN_CLAIM_ON_BOOKING_SQL_BEFORE)
    expect(claimsDueSql(BOOKING_CLAIMS)).toBe(CLAIMS_DUE_SQL_BEFORE)
    expect(bookingRefunds.CLAIMS_DUE_SQL).toBe(CLAIMS_DUE_SQL_BEFORE)
  })

  it("each statement bookings/refunds.ts's claim functions run, in order, with the same parameters", async () => {
    const bookingId = crypto.randomUUID()
    const { seen, db: watched } = spy()
    const claim = await watched.transaction((tx) => bookingRefunds.writeClaim(tx, bookingId, details() as never, { actor: { type: 'staff', id: STAFF }, requestId: 'r1' }))
    await bookingRefunds.openRefundClaimOn(watched, bookingId)
    await bookingRefunds.refundClaimOpen(watched, bookingId)
    await bookingRefunds.readClaim(watched, claim.id)
    await bookingRefunds.claimRefusal(watched, claim)
    const ours = seen.filter(({ sql }) => sql.includes('audit_log'))
    expect(ours.map(({ sql }) => sql)).toEqual([WRITE_CLAIM_SQL_BEFORE, OPEN_CLAIM_ON_BOOKING_SQL_BEFORE, OPEN_CLAIM_ON_BOOKING_SQL_BEFORE, READ_CLAIM_SQL_BEFORE, CLAIM_REFUSAL_SQL_BEFORE])
    expect(ours.map(({ params }) => params)).toEqual([[STAFF, bookingId, 'r1', JSON.stringify(details())], [bookingId], [bookingId], [claim.id], [bookingId, claim.id]])
    // The finished look is private to bookings/refunds.ts; the core's own, for a booking, is the statement it ran.
    seen.length = 0
    await claimIsFinished(watched, BOOKING_CLAIMS, { id: claim.id, subjectId: bookingId })
    expect(seen).toEqual([{ sql: CLAIM_FINISHED_SQL_BEFORE, params: [bookingId, claim.id] }])
  })

  it('the words of a refusal are one definition, exported from both places', () => {
    expect(bookingsRefundRefusedDetail).toBe(refundRefusedDetail)
    expect(refundRefusedDetail('Your card was declined.')).toBe('Failed to refund payment: Your card was declined.')
  })

  it('what bookings/refunds.ts exported before, it still exports (the same functions as the core where they were lifted)', () => {
    expect(bookingRefunds.claimRefundKey).toBe(claimRefundKey)
    expect(bookingRefunds.cardPartRequest).toBe(cardPartRequest)
    expect(bookingRefunds.findCardPart).toBe(findCardPart)
    for (const name of [
      'REFUND_CLAIMED',
      'REFUND_FINISHED',
      'REFUND_REFUSED',
      'REFUND_REASON_MAX_LENGTH',
      'CLAIMS_DUE_SQL',
      'refundClaimOpen',
      'openRefundClaimOn',
      'readClaim',
      'writeClaim',
      'claimRefusal',
      'claimRefundKey',
      'cardPartRequest',
      'findCardPart',
      'planRefund',
      'planAddonRefund',
      'finishClaimInTransaction',
      'finishClaim',
      'sendAndFinish',
      'run',
      'partRefund',
      'refundOwed',
      'owedArrived',
      'refundRefusal',
      'PutBackBlocked',
    ]) {
      expect(bookingRefunds, name).toHaveProperty(name)
    }
  })
})

describe('the key and the request of one card part', () => {
  it('<claimId>:refund:<orderId>, with the key and the claim in the metadata, in pence', () => {
    const part: CardPart = { orderId: 'order-1', paymentIntentId: 'pi_1', amount: 12.34, lines: [{ lineId: 'line-1', amount: 12.34 }] }
    expect(claimRefundKey('claim-1', 'order-1')).toBe('claim-1:refund:order-1')
    expect(cardPartRequest('claim-1', part)).toEqual({ payment_intent: 'pi_1', amount: 1234, metadata: { refund_key: 'claim-1:refund:order-1', claim_id: 'claim-1' } })
  })

  it('two parts of one claim, and one order in two claims, never share a key', () => {
    const keys = [claimRefundKey('a', 'x'), claimRefundKey('a', 'y'), claimRefundKey('b', 'x'), claimRefundKey('b', 'y')]
    expect(new Set(keys).size).toBe(4)
  })
})

describe('the claim on audit_log, on each subject', () => {
  it.each(CLAIM_SUBJECTS)('$entityType: written, read back, open until finished, then not', async (on: ClaimSubject) => {
    const subjectId = crypto.randomUUID()
    expect(await openClaimOn(db, on, subjectId)).toBeNull()
    const written = await db.transaction((tx) => writeClaimRow(tx, on, subjectId, details({ plan: { card: [] } }), by('press-1')))
    expect(written).toMatchObject({ subjectId, staffId: STAFF, details: details({ plan: { card: [] } }) })
    const row = (await db.query<Record<string, unknown>>('SELECT * FROM audit_log WHERE id = $1', [written.id]))[0]
    expect(row).toMatchObject({ actor_type: 'staff', actor_id: STAFF, action: on.claimed, entity_type: on.entityType, entity_id: subjectId, request_id: 'press-1' })

    expect(await readClaimRow(db, on, written.id)).toEqual(written)
    expect(await openClaimOn(db, on, subjectId)).toBe(written.id)
    expect(await claimIsFinished(db, on, written)).toBe(false)

    await db.query("INSERT INTO audit_log (actor_type, action, entity_type, entity_id, details) VALUES ('staff', $1, $2, $3, $4::jsonb)", [
      on.finished,
      on.entityType,
      subjectId,
      JSON.stringify({ claimId: written.id, outcome: 'given' }),
    ])
    expect(await claimIsFinished(db, on, written)).toBe(true)
    expect(await openClaimOn(db, on, subjectId)).toBeNull()
  })

  it("a claim is its own subject's: read as another kind of subject it isn't there, and it holds no other subject", async () => {
    const sameId = crypto.randomUUID()
    const order = await db.transaction((tx) => writeClaimRow(tx, ORDER_CLAIMS, sameId, details(), by()))
    // The same id as a booking or an event booking (ids are never shared, but nothing here may rely on that).
    expect(await readClaimRow(db, BOOKING_CLAIMS, order.id)).toBeNull()
    expect(await readClaimRow(db, EVENT_BOOKING_CLAIMS, order.id)).toBeNull()
    expect(await openClaimOn(db, BOOKING_CLAIMS, sameId)).toBeNull()
    expect(await openClaimOn(db, EVENT_BOOKING_CLAIMS, sameId)).toBeNull()
    expect(await openClaimOn(db, ORDER_CLAIMS, sameId)).toBe(order.id)
    // Step D's own reads never see it: a booking's refunds are not held by an order's claim on the same id.
    expect(await bookingRefunds.readClaim(db, order.id)).toBeNull()
    expect(await bookingRefunds.refundClaimOpen(db, sameId)).toBe(false)
  })

  it("another subject's finished row never closes a claim (same claim id in its details, another entity type)", async () => {
    const subjectId = crypto.randomUUID()
    const claim = await db.transaction((tx) => writeClaimRow(tx, ORDER_CLAIMS, subjectId, details(), by()))
    await db.query("INSERT INTO audit_log (actor_type, action, entity_type, entity_id, details) VALUES ('staff', 'booking.refund_finished', 'booking', $1, $2::jsonb)", [
      subjectId,
      JSON.stringify({ claimId: claim.id }),
    ])
    expect(await claimIsFinished(db, ORDER_CLAIMS, claim)).toBe(false)
    expect(await openClaimOn(db, ORDER_CLAIMS, subjectId)).toBe(claim.id)
  })

  it('only a claim the Worker made counts (`worker: true`): an old screen row with the same action is not a claim', async () => {
    const subjectId = crypto.randomUUID()
    const old = (
      await db.query<{ id: string }>("INSERT INTO audit_log (actor_type, action, entity_type, entity_id, details) VALUES ('staff', 'booking.refund_claimed', 'booking', $1, $2::jsonb) RETURNING id", [
        subjectId,
        JSON.stringify({ kind: 'cancel', amount: 20 }),
      ])
    )[0]?.id as string
    expect(await readClaimRow(db, BOOKING_CLAIMS, old)).toBeNull()
    expect(await openClaimOn(db, BOOKING_CLAIMS, subjectId)).toBeNull()
  })

  it.each(CLAIM_SUBJECTS)("$entityType: the due list holds this subject's unfinished claims past the window, oldest first, and no other subject's", async (on: ClaimSubject) => {
    const old = await db.transaction((tx) => writeClaimRow(tx, on, crypto.randomUUID(), details(), by()))
    const older = await db.transaction((tx) => writeClaimRow(tx, on, crypto.randomUUID(), details(), by()))
    const fresh = await db.transaction((tx) => writeClaimRow(tx, on, crypto.randomUUID(), details(), by()))
    const finished = await db.transaction((tx) => writeClaimRow(tx, on, crypto.randomUUID(), details(), by()))
    const others = CLAIM_SUBJECTS.filter((other) => other !== on)
    const elsewhere = await Promise.all(others.map((other) => db.transaction((tx) => writeClaimRow(tx, other, crypto.randomUUID(), details(), by()))))
    await db.query("UPDATE audit_log SET at = now() - interval '20 minutes' WHERE id = ANY($1::uuid[])", [[old.id, finished.id, ...elsewhere.map((claim) => claim.id)]])
    await db.query("UPDATE audit_log SET at = now() - interval '40 minutes' WHERE id = $1", [older.id])
    await db.query("INSERT INTO audit_log (actor_type, action, entity_type, entity_id, details) VALUES ('staff', $1, $2, $3, $4::jsonb)", [
      on.finished,
      on.entityType,
      finished.subjectId,
      JSON.stringify({ claimId: finished.id }),
    ])
    const due = await db.query<{ id: string }>(claimsDueSql(on), [15])
    expect(due.map((row) => row.id)).toEqual([older.id, old.id])
    expect(due.map((row) => row.id)).not.toContain(fresh.id)
  })
})

describe('sending one card part: once, under its key', () => {
  it('Stripe answers with the refund: went, one send, the key and the request from the claim', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    const answer = await sendCardPart(stripe, 'claim-1', part, timing())
    expect(answer).toMatchObject({ outcome: 'went', refund: { amount: 1000, status: 'succeeded' } })
    expect(refundCalls(stripe)).toEqual([{ method: 'refunds.create', params: cardPartRequest('claim-1', part), idempotencyKey: claimRefundKey('claim-1', part.orderId) }])
    expect(stripe.refundedPence).toBe(1000)
  })

  it('a pending refund is a yes (Stripe has it; W32 watches how it ends)', async () => {
    const stripe = new FakeStripe()
    stripe.refundsStayPending = true
    expect(await sendCardPart(stripe, 'claim-1', await aPart(stripe), timing())).toMatchObject({ outcome: 'went', refund: { status: 'pending' } })
  })

  it('a refund answered failed is a refusal, with the status in the old words, and no money moved', async () => {
    const stripe = new FakeStripe()
    stripe.refundsFailAtOnce = true
    expect(await sendCardPart(stripe, 'claim-1', await aPart(stripe), timing())).toEqual({ outcome: 'refused', detail: 'Failed to refund payment: the refund failed' })
    expect(stripe.refundedPence).toBe(0)
    expect(refundCalls(stripe)).toHaveLength(1)
  })

  it('a definite error is a refusal with Stripe\'s reason, sent once', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.') })
    expect(await sendCardPart(stripe, 'claim-1', part, timing())).toEqual({ outcome: 'refused', detail: 'Failed to refund payment: This charge is disputed.' })
    expect(refundCalls(stripe)).toHaveLength(1)
    expect(stripe.refundedPence).toBe(0)
  })

  it('more than the payment has left is Stripe\'s own refusal (the backstop against money going twice)', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe, 50, 4000)
    expect(await sendCardPart(stripe, 'claim-1', part, timing())).toEqual({ outcome: 'refused', detail: 'Failed to refund payment: Refund amount is greater than unrefunded amount on charge.' })
    expect(stripe.refundedPence).toBe(0)
  })

  it.each([
    ['a 401 (the key is wrong)', fakeStripeErrors.authentication],
    ['a 403 (the key lacks the permission)', fakeStripeErrors.permission],
  ])('%s on the first send is a refusal: nothing went', async (_, error) => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    stripe.failNext('refunds.create', { kind: 'error', error: error() })
    expect(await sendCardPart(stripe, 'claim-1', part, timing())).toMatchObject({ outcome: 'refused' })
    expect(refundCalls(stripe)).toHaveLength(1)
  })

  it('an answer lost on the way back: sent once more with the same key and request, and Stripe hands back the first refund', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    stripe.failNext('refunds.create', { kind: 'lost_response' })
    const answer = await sendCardPart(stripe, 'claim-1', part, timing())
    expect(answer.outcome).toBe('went')
    const sent = refundCalls(stripe)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
    // One refund, not two.
    expect(stripe.refundedPence).toBe(1000)
    expect(stripe.refundsSent).toHaveLength(1)
  })

  it('no clear answer twice: unclear, two sends under one key, never a third', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    stripe.failNext('refunds.create', { kind: 'lost_response' })
    stripe.failNext('refunds.create', { kind: 'lost_response' })
    const answer = await sendCardPart(stripe, 'claim-1', part, timing())
    expect(answer.outcome).toBe('unclear')
    const sent = refundCalls(stripe)
    expect(sent).toHaveLength(2)
    expect(new Set(sent.map((call) => call.idempotencyKey))).toEqual(new Set([claimRefundKey('claim-1', part.orderId)]))
    // The money went, once: which is why an unclear part is held and looked for, never refused or sent again.
    expect(stripe.refundsSent).toHaveLength(1)
    expect(stripe.refundedPence).toBe(1000)
  })

  it('unreachable twice: unclear (nothing can be said), and nothing went', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    stripe.failNext('refunds.create', { kind: 'unreachable' })
    stripe.failNext('refunds.create', { kind: 'unreachable' })
    expect((await sendCardPart(stripe, 'claim-1', part, timing())).outcome).toBe('unclear')
    expect(stripe.refundedPence).toBe(0)
  })

  it('no time left before the first send: not_sent, and nothing reached Stripe (W21a: not a refusal)', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    expect(await sendCardPart(stripe, 'claim-1', part, timing(1_000))).toEqual({ outcome: 'not_sent' })
    expect(refundCalls(stripe)).toHaveLength(0)
  })

  it('time runs out between the two sends: unclear, the first send may have gone, and it is not sent again', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    stripe.failNext('refunds.create', { kind: 'lost_response' })
    let now = Date.now()
    const clock = stripeTiming(now, () => now)
    const create = stripe.refunds.create
    stripe.refunds.create = (async (...args: Parameters<typeof create>) => {
      try {
        return await create(...args)
      } finally {
        // The first send took all the time there was.
        now += 29_500
      }
    }) as typeof create
    const answer = await sendCardPart(stripe, 'claim-1', part, clock)
    expect(answer).toMatchObject({ outcome: 'unclear', detail: expect.stringContaining('not sent again') })
    expect(refundCalls(stripe)).toHaveLength(1)
    // It did go: that is why it is held and looked for, never sent again or counted as refused.
    expect(stripe.refundedPence).toBe(1000)
  })
})

describe('the refusal mark (W26a), on each subject', () => {
  it.each(CLAIM_SUBJECTS)("$entityType: marked with the claim, the part and Stripe's reason, and read back; the first mark wins", async (on: ClaimSubject) => {
    const subjectId = crypto.randomUUID()
    const claim = await db.transaction((tx) => writeClaimRow(tx, on, subjectId, details(), by()))
    const part: CardPart = { orderId: crypto.randomUUID(), paymentIntentId: 'pi_x', amount: 10, lines: [] }
    expect(await claimRefusal(db, on, claim)).toBeNull()
    await markRefused(db, on, claim, part, 'Failed to refund payment: This charge is disputed.', 'press-9')
    // A press writes one mark per claim at most (it stops at the first refusal). Should a second ever be written, the
    // earliest is the one read; here it is put a second earlier, because PGlite's clock ticks in whole milliseconds
    // and two rows written back to back can share one.
    await db.query("UPDATE audit_log SET at = at - interval '1 second' WHERE action = $1 AND details->>'claimId' = $2", [on.refused, claim.id])
    await markRefused(db, on, claim, part, 'a later reason', 'press-10')
    const rows = await db.query<Record<string, unknown>>('SELECT actor_id, action, entity_type, entity_id, request_id, details FROM audit_log WHERE action = $1 ORDER BY at, id', [on.refused])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      actor_id: STAFF,
      action: on.refused,
      entity_type: on.entityType,
      entity_id: subjectId,
      request_id: 'press-9',
      details: { claimId: claim.id, orderId: part.orderId, amount: 10, detail: 'Failed to refund payment: This charge is disputed.' },
    })
    expect(await claimRefusal(db, on, claim)).toBe('Failed to refund payment: This charge is disputed.')
    // Another claim on the same subject isn't marked by it, nor the same claim id read as another kind of subject.
    const other = await db.transaction((tx) => writeClaimRow(tx, on, subjectId, details(), by()))
    expect(await claimRefusal(db, on, other)).toBeNull()
    for (const elsewhere of CLAIM_SUBJECTS.filter((one) => one !== on)) expect(await claimRefusal(db, elsewhere, claim)).toBeNull()
  })

  it("a mark that can't be written is tried twice, then passed over: the press carries on", async () => {
    let tries = 0
    const failing = {
      transaction: () => {
        tries += 1
        return Promise.reject(new Error('the database is away'))
      },
    } as unknown as Db
    await expect(markRefused(failing, ORDER_CLAIMS, { id: 'c', subjectId: 's', staffId: null }, { orderId: 'o', paymentIntentId: 'pi', amount: 1, lines: [] }, 'why', 'r')).resolves.toBeUndefined()
    expect(tries).toBe(2)
  })
})

describe('the held answer', () => {
  it('names the claim, the reason and the words; the card money known to have gone, and never any store credit', () => {
    expect(heldAnswer('claim-1', 'refund_unconfirmed', 'Words.')).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, held: { claimId: 'claim-1', reason: 'refund_unconfirmed', message: 'Words.' } })
    expect(heldAnswer('claim-1', 'refund_not_recorded', 'Words.', 25)).toMatchObject({ cardRefundedAmount: 25, storeCreditRefundedAmount: 0 })
  })
})

describe('the Stripe look-up (reconcile and the close by hand): never a send', () => {
  async function sent(stripe: FakeStripe, claimId: string, part: CardPart) {
    const answer = await sendCardPart(stripe, claimId, part, timing())
    if (answer.outcome !== 'went') throw new Error(`not sent: ${answer.outcome}`)
    return answer.refund
  }
  const sends = (stripe: FakeStripe) => refundCalls(stripe).length

  it('a refund naming the claim, of the part\'s amount: went (succeeded or pending)', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    await sent(stripe, 'claim-1', part)
    const before = sends(stripe)
    expect(await findCardPart(stripe, 'claim-1', part, undefined)).toEqual({ kind: 'went' })
    stripe.refundsStayPending = true
    const pending = await aPart(stripe)
    await sent(stripe, 'claim-2', pending)
    expect(await findCardPart(stripe, 'claim-2', pending, undefined)).toEqual({ kind: 'went' })
    expect(sends(stripe)).toBe(before + 1)
  })

  it('none naming the claim: none, even when another claim refunded the same payment', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    expect(await findCardPart(stripe, 'claim-1', part, undefined)).toEqual({ kind: 'none' })
    await sent(stripe, 'claim-other', part)
    expect(await findCardPart(stripe, 'claim-1', part, undefined)).toEqual({ kind: 'none' })
  })

  it('one that failed or was cancelled, and none that went: refused, with the status (W26a), never none', async () => {
    const stripe = new FakeStripe()
    stripe.refundsStayPending = true
    const part = await aPart(stripe)
    const refund = await sent(stripe, 'claim-1', part)
    stripe.settleRefund(refund.id, 'failed')
    expect(await findCardPart(stripe, 'claim-1', part, undefined)).toEqual({ kind: 'refused', detail: 'Failed to refund payment: the refund failed' })
    const cancelled = await aPart(stripe)
    const second = await sent(stripe, 'claim-2', cancelled)
    stripe.settleRefund(second.id, 'canceled')
    expect(await findCardPart(stripe, 'claim-2', cancelled, undefined)).toEqual({ kind: 'refused', detail: 'Failed to refund payment: the refund canceled' })
  })

  it('two live refunds naming the claim: several, left for a person; one of another amount: mismatch', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe, 10)
    const first = await stripe.refunds.create(cardPartRequest('claim-1', part), { idempotencyKey: 'by-hand-1' })
    const second = await stripe.refunds.create(cardPartRequest('claim-1', part), { idempotencyKey: 'by-hand-2' })
    expect(await findCardPart(stripe, 'claim-1', part, undefined)).toEqual({ kind: 'several', ids: expect.arrayContaining([first.id, second.id]) })
    const other = await aPart(stripe, 10)
    const wrong = await stripe.refunds.create({ ...cardPartRequest('claim-2', other), amount: 700 }, { idempotencyKey: 'by-hand-3' })
    expect(await findCardPart(stripe, 'claim-2', other, undefined)).toEqual({ kind: 'mismatch', detail: `${wrong.id} is 700p, the part 1000p` })
  })

  it('Stripe not answering the list: unclear, with its words', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe)
    stripe.failNext('refunds.list', { kind: 'error', error: fakeStripeErrors.server() })
    expect(await findCardPart(stripe, 'claim-1', part, undefined)).toEqual({ kind: 'unclear', detail: 'An error occurred with our API.' })
  })

  it('every page is read: the claim\'s refund is found behind 150 others on the same payment', async () => {
    const stripe = new FakeStripe()
    const part = await aPart(stripe, 1, 100_000)
    await sent(stripe, 'claim-1', part)
    for (let n = 0; n < 150; n += 1) await stripe.refunds.create({ payment_intent: part.paymentIntentId, amount: 100, metadata: { claim_id: `other-${n}` } }, { idempotencyKey: `other-${n}` })
    const before = stripe.calls.filter((call) => call.method === 'refunds.list').length
    expect(await findCardPart(stripe, 'claim-1', part, undefined)).toEqual({ kind: 'went' })
    expect(stripe.calls.filter((call) => call.method === 'refunds.list').length - before).toBe(2)
    const listed = await listRefunds(stripe, part.paymentIntentId, undefined)
    expect(listed.kind === 'listed' ? listed.refunds.length : 0).toBe(151)
  })
})
