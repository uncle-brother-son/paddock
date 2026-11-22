import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { reconcileClaimNow } from '@/server/rules/orders/reconcile'
import { EVENT_BOOKING_CLAIMS, openClaimSql } from '@/server/rules/refunds/pipeline'
import { compareRecordings, type AllowedDifference, type Recording } from './compare'
import { oldSide, readGolden, replay, startReplay, type ReplayEnvironment } from './harness'
import { EVENT_CLAIM_KEYS, EVENT_PLACES_DIFFERENCES, isEventPlacesScenario } from './event-places-differences'
import { comparableEventPlaces, eventClaimLookProblems, eventNewFieldProblems, eventPlacesRowProblems, eventPlacesStoredAnswerProblems, EVENT_PLACE_ACTIONS, newEventPlacesSide } from './event-places-side'
import { sweepInvariants } from './invariants'
import { scenarios } from './scenarios'

// W30 (brief item 7): the event place golden families through the staff app's thin cancelEventPlaces and
// getEventCancellationQuote and the Worker's routes.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('./stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const compareSides = (golden: Recording, recording: Recording, named: Parameters<typeof compareRecordings>[2]) =>
  compareRecordings(comparableEventPlaces(golden, 'golden'), comparableEventPlaces(recording, 'new'), named)

const families = scenarios.filter((scenario) => isEventPlacesScenario(scenario.name))

describe("step E's side of the replay: event places (W30)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  describe.each(families.map((scenario) => [scenario.name, scenario] as const))('%s', (name, scenario) => {
    it('matches its golden file, with its named differences only', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const recording = await replay(environment, scenario, newEventPlacesSide({ calls }))
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => EVENT_PLACE_ACTIONS.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      const named = EVENT_PLACES_DIFFERENCES.get(name) ?? []
      if (process.env.W30_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W30_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden, recording, []), unnamed: compareSides(golden, recording, named), rows: eventPlacesRowProblems(recording), fields: eventNewFieldProblems(recording), stored: eventPlacesStoredAnswerProblems(recording), looks: eventClaimLookProblems(recording) })}\n`
        )
        return
      }
      expect(eventPlacesRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(eventPlacesStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(eventClaimLookProblems(recording), `${name}: reconcile's looks for a held refund`).toEqual([])
      expect(eventNewFieldProblems(recording), `${name}: the answers' new fields`).toEqual([])
      expect(compareSides(golden, recording, named)).toEqual([])
    })
  })

  it('the families are whole: every event place scenario is replayed here (W27\'s 56, and p3 and p5), and every named difference is for a scenario that exists', () => {
    expect(families.length).toBe(58)
    expect(families.filter((scenario) => scenario.name.startsWith('w27-')).length).toBe(56)
    expect(families.map((scenario) => scenario.name).filter((name) => !name.startsWith('w27-')).sort()).toEqual(['p3-one-event-place-cancelled-twice-at-once', 'p5-held-event-refund-two-days-later'])
    // The whole-event scenarios (cancelEvent, W31) and E7 are not event place scenarios.
    expect(families.some((scenario) => scenario.name.includes('whole-cancel') || scenario.name.startsWith('w27-e7-'))).toBe(false)
    expect([...EVENT_PLACES_DIFFERENCES.keys()].every((name) => families.some((scenario) => scenario.name === name))).toBe(true)
    // 17 match their golden files exactly; 11 differ only in the refund's key; 30 have differences of their own (W58: one reworded).
    expect(families.filter((scenario) => !EVENT_PLACES_DIFFERENCES.has(scenario.name)).length).toBe(17)
    expect([...EVENT_PLACES_DIFFERENCES.values()].filter((named) => named.length === 1 && named[0] === EVENT_CLAIM_KEYS).length).toBe(11)
    expect([...EVENT_PLACES_DIFFERENCES.values()].filter((named) => named.some((one) => one !== EVENT_CLAIM_KEYS)).length).toBe(30)
    // The faults the brief names each have their scenario among the named ones.
    for (const name of [
      'p3-one-event-place-cancelled-twice-at-once',
      'p5-held-event-refund-two-days-later',
      'w27-e8-event-with-no-cut-off-counts-as-after-it',
      'w27-e9-figure-changes-between-the-quote-and-the-press',
      'w27-event-cancel-by-someone-with-no-staff-record',
      'w27-event-cancel-died-on-one-place-then-the-other-at-the-same-figures',
      'w27-event-cancel-changed-by-someone-else-a-place-checked-in-meanwhile',
      'w27-event-cancel-held-two-days-and-the-look-fails',
    ]) {
      expect((EVENT_PLACES_DIFFERENCES.get(name) ?? []).some((one) => one !== EVENT_CLAIM_KEYS), name).toBe(true)
    }
  })

  it("the W05 invariants hold on the new side for every event place scenario: Stripe's refunds are all on the rows and on the places (the old side breaks them in three scenarios); the one line left is a claim still held when its recording ends", async () => {
    const old = await sweepInvariants(environment, families, oldSide)
    // W27's known faults among these scenarios (w05d.test.ts, W27_KNOWN_FAULTS): the old code's, recorded on purpose.
    expect(old.wrong).toEqual([
      'w27-event-cancel-changed-by-someone-else-a-place-checked-in-meanwhile: the places say £0.00 went to the card, Stripe refunded £40.00',
      'w27-event-cancel-died-on-one-place-then-the-other-at-the-same-figures: Stripe refunded £80.00, the rows say £40',
      'w27-event-cancel-died-on-one-place-then-the-other-at-the-same-figures: the places say £40.00 went to the card, Stripe refunded £80.00',
      'w27-event-cancel-held-two-days-and-the-look-fails: Stripe refunded £40.00, the rows say £0',
      'w27-event-cancel-held-two-days-and-the-look-fails: the places say £0.00 went to the card, Stripe refunded £40.00',
    ])
    const fresh = await sweepInvariants(environment, families, newEventPlacesSide())
    // Not a fault: this recording ends inside its own planted failure (the store credit write keeps failing), so R2
    // can't be saved and the claim is still held, with the £50 Stripe refunded not yet on the rows. The next test
    // shows reconcile recording it once the write works.
    expect(fresh.wrong).toEqual([
      'w27-event-cancel-store-credit-fails-after-the-card-part: Stripe refunded £50.00, the rows say £0',
      'w27-event-cancel-store-credit-fails-after-the-card-part: the places say £0.00 went to the card, Stripe refunded £50.00',
    ])
  })

  it('the claim that recording leaves held is finished by reconcile once the store credit can be written: £50 on the places and the line, the £30 of store credit given (the old code never gave it), nothing sent again', async () => {
    const name = 'w27-event-cancel-store-credit-fails-after-the-card-part'
    const scenario = families.find((one) => one.name === name)
    if (!scenario) throw new Error(`No scenario ${name}`)
    let sent = 0
    const recording = await replay(environment, scenario, newEventPlacesSide(), {
      async tamper(db, stripe) {
        // What the automatic check does on its next run, the planted failure over.
        const held = await db.query<{ id: string; entity_id: string }>("SELECT id, entity_id FROM audit_log WHERE action = 'event_booking.refund_claimed'")
        expect(held).toHaveLength(1)
        expect((await db.query<{ id: string }>(openClaimSql(EVENT_BOOKING_CLAIMS), [held[0]?.entity_id as string]))[0]?.id).toBe(held[0]?.id)
        const before = stripe.calls.filter((call) => call.method === 'refunds.create').length
        const item = await reconcileClaimNow(db, stripe, held[0]?.id as string, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID() })
        expect(item.outcome).toBe('finalised')
        sent = stripe.calls.filter((call) => call.method === 'refunds.create').length - before
      },
    })
    expect(sent).toBe(0)
    expect(eventPlacesRowProblems(recording)).toEqual([])
    const places = (recording.tables['event_attendees']?.added ?? []) as Array<Record<string, unknown>>
    expect(places.map((place) => [place['refunded_amount'], place['card_refunded_amount'], place['refund_method']])).toEqual([
      ['40.00', '25.00', 'card'],
      ['40.00', '25.00', 'card'],
    ])
    const line = ((recording.tables['order_line_items']?.added ?? []) as Array<Record<string, unknown>>)[0]
    expect([line?.['card_refunded_amount'], line?.['refund_method'], line?.['refunded_at']]).toEqual(['50.00', 'card', '<set>'])
    const credit = ((recording.tables['store_credit_transactions']?.added ?? []) as Array<Record<string, unknown>>).filter((row) => row['reason'] === 'refund')
    expect(credit.map((row) => row['amount'])).toEqual(['30.00'])
    expect(((recording.tables['orders']?.added ?? []) as Array<Record<string, unknown>>)[0]?.['payment_status']).toBe('refunded')
  })

  describe('the comparison catches what it is for', () => {
    const scenario = (name: string) => {
      const found = families.find((one) => one.name === name)
      if (!found) throw new Error(`No scenario ${name}`)
      return found
    }
    const keysOnly = 'w27-event-cancel-split-card-and-store-credit'
    const exact = 'w27-event-cancel-whole-booking-to-store-credit'
    const named = (name: string) => EVENT_PLACES_DIFFERENCES.get(name) ?? []

    it('a deliberate difference in what staff are told is caught: a penny more store credit in the answer', async () => {
      const recording = await replay(
        environment,
        scenario(keysOnly),
        newEventPlacesSide({ adjust: (action, answer) => (action === 'cancelEventPlaces' ? { ...(answer as object), storeCreditRefundedAmount: 30.01 } : answer) })
      )
      expect(compareSides(readGolden(keysOnly) as Recording, recording, named(keysOnly)).map((difference) => difference.path)).toEqual(['.results[2].storeCreditRefundedAmount'])
    })

    it('a deliberate difference in the rows is caught: a place left uncancelled, the wrong value, method or card money on a place, a place not released, the line unstamped, the wrong order status', async () => {
      for (const [tamper, path] of [
        ['UPDATE event_attendees SET cancelled_at = NULL WHERE id = (SELECT id FROM event_attendees ORDER BY created_at, id LIMIT 1)', '.tables.event_attendees.added[0].cancelled_at'],
        ['UPDATE event_attendees SET cancelled_value = cancelled_value + 0.01 WHERE id = (SELECT id FROM event_attendees ORDER BY created_at, id LIMIT 1)', '.tables.event_attendees.added[0].cancelled_value'],
        ["UPDATE event_attendees SET refund_method = 'credit' WHERE id = (SELECT id FROM event_attendees ORDER BY created_at, id LIMIT 1)", '.tables.event_attendees.added[0].refund_method'],
        ['UPDATE event_attendees SET card_refunded_amount = card_refunded_amount + 0.01 WHERE id = (SELECT id FROM event_attendees ORDER BY created_at, id LIMIT 1)', '.tables.event_attendees.added[0].card_refunded_amount'],
        ['UPDATE event_attendees SET refunded_amount = refunded_amount - 0.01 WHERE id = (SELECT id FROM event_attendees ORDER BY created_at, id LIMIT 1)', '.tables.event_attendees.added[0].refunded_amount'],
        ['UPDATE events SET places_booked = places_booked + 1', '.tables.events'],
        ["UPDATE event_bookings SET status = 'confirmed', places = 1, cancelled_at = NULL, cancelled_by = NULL", '.tables.event_bookings.added[0].places'],
        ['UPDATE order_line_items SET refunded_at = NULL', '.tables.order_line_items.added[0].refunded_at'],
        ['UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + 0.01', '.tables.order_line_items.added[0].card_refunded_amount'],
        ["UPDATE orders SET payment_status = 'partially_refunded'", '.tables.orders.added[0].payment_status'],
        ['UPDATE orders SET refund_owed_amount = 0.01', '.tables.orders.added[0].refund_owed_amount'],
      ] as const) {
        const recording = await replay(environment, scenario(keysOnly), newEventPlacesSide(), {
          async tamper(db) {
            // Test data only: each statement is a literal above.
            await db.query(tamper)
          },
        })
        const paths = compareSides(readGolden(keysOnly) as Recording, recording, named(keysOnly)).map((difference) => difference.path)
        expect(paths, tamper).toContain(path)
      }
    })

    it("a second refund sent to Stripe is caught, and so is one sent under any key but the claim's", async () => {
      // One place of two cancelled: card money is left on the payment, so a second refund can be made at all.
      const withMoneyLeft = 'w27-event-cancel-one-place-to-card'
      const twice = await replay(environment, scenario(withMoneyLeft), newEventPlacesSide(), {
        async tamper(_db, stripe) {
          await stripe.refunds.create({ payment_intent: 'pi_fake_0002', amount: 1 }, { idempotencyKey: 'by-hand' })
        },
      })
      expect(compareSides(readGolden(withMoneyLeft) as Recording, twice, named(withMoneyLeft)).map((difference) => difference.path)).toEqual(['.stripeCalls[2]'])
      const recording = await replay(environment, scenario(keysOnly), newEventPlacesSide())
      const wrongKey: Recording = { ...recording, stripeCalls: recording.stripeCalls.map((call) => (call.method === 'refunds.create' ? { ...call, idempotencyKey: 'event-refund:made-up' } : call)) }
      expect(compareSides(readGolden(keysOnly) as Recording, wrongKey, named(keysOnly)).map((difference) => difference.path)).toEqual(['.stripeCalls[1].idempotencyKey'])
    })

    it('an unused allowance fails: one nobody needs, on a scenario that matches exactly and on one with named differences; and the keys\' own allowance on a scenario that sends no card refund', async () => {
      const stale: AllowedDifference = { name: 'An allowance nobody needs', decision: 'none', path: /^\.results\[1\]\.warning$/ }
      for (const name of [exact, keysOnly, 'w27-e9-figure-changes-between-the-quote-and-the-press']) {
        const recording = await replay(environment, scenario(name), newEventPlacesSide())
        expect(compareSides(readGolden(name) as Recording, recording, [...named(name), stale]).map((difference) => difference.path), name).toEqual(['(allowed difference not seen: An allowance nobody needs)'])
      }
      const recording = await replay(environment, scenario(exact), newEventPlacesSide())
      expect(compareSides(readGolden(exact) as Recording, recording, [EVENT_CLAIM_KEYS]).map((difference) => difference.path)).toEqual([`(allowed difference not seen: ${EVENT_CLAIM_KEYS.name})`])
    })

    it("a pinned difference refuses any other value: E9's refusal with another reason, E8's quote still saying after the cut-off, E12's refusals with another answer", async () => {
      const e9 = 'w27-e9-figure-changes-between-the-quote-and-the-press'
      const reworded = await replay(environment, scenario(e9), newEventPlacesSide({ adjust: (_action, answer) => ((answer as { reason?: string } | null)?.reason === 'figures_changed' ? { ...(answer as object), reason: 'something_else' } : answer) }))
      expect(compareSides(readGolden(e9) as Recording, reworded, named(e9)).map((difference) => difference.path)).toEqual(['.results[3].reason'])

      // E8: the quote's `beforeCutoff` is only allowed to differ as `true`.
      const e8 = 'w27-e8-event-with-no-cut-off-counts-as-after-it'
      const wrongQuote = await replay(environment, scenario(e8), newEventPlacesSide({ adjust: (action, answer) => (action === 'getEventCancellationQuote' ? { ...(answer as object), beforeCutoff: 'yes' } : answer) }))
      expect(compareSides(readGolden(e8) as Recording, wrongQuote, named(e8)).map((difference) => difference.path)).toEqual(['.results[1].beforeCutoff'])

      // E12: the first press (a refund) is only allowed to differ as a refusal given as data. (The second press said
      // ok in the old recording, so an ok there is no difference at all: its other pinned fields hold it.)
      const e12 = 'w27-event-cancel-by-someone-with-no-staff-record'
      const allowedIn = await replay(environment, scenario(e12), newEventPlacesSide({ adjust: (_action, answer) => ((answer as { reason?: string } | null)?.reason === 'permission_denied' ? { ...(answer as object), ok: true } : answer) }))
      expect(compareSides(readGolden(e12) as Recording, allowedIn, named(e12)).map((difference) => difference.path)).toEqual(['.results[1].ok'])
      const reasonChanged = await replay(environment, scenario(e12), newEventPlacesSide({ adjust: (_action, answer) => ((answer as { reason?: string } | null)?.reason === 'permission_denied' ? { ...(answer as object), reason: 'something_else' } : answer) }))
      expect(compareSides(readGolden(e12) as Recording, reasonChanged, named(e12)).map((difference) => difference.path)).toEqual(['.results[1].reason', '.results[2].reason'])
    })
  })
})
