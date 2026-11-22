import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { compareRecordings, type AllowedDifference, type Recording } from './compare'
import { EVENT_CLAIM_KEYS, isEventPlacesScenario } from './event-places-differences'
import { comparableEventPlaces, eventClaimLookProblems, eventNewFieldProblems, eventPlacesRowProblems, eventPlacesStoredAnswerProblems } from './event-places-side'
import { oldSide, readGolden, replay, startReplay, type ReplayEnvironment } from './harness'
import { sweepInvariants } from './invariants'
import { scenarios } from './scenarios'
import { E6_SCENARIO, E7_SCENARIO, isWholeEventScenario, WHOLE_EVENT_DIFFERENCES } from './whole-event-differences'
import { BOOKING_NO_ANSWER_MESSAGE, newWholeEventSide, WHOLE_EVENT_ACTIONS } from './whole-event-side'

// W31 (brief item 7): the whole-event golden family through the staff app's thin cancelEvent and
// getEventCancellationOverview, the Worker's routes, and one press per booking as the dialog makes them.
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

const families = scenarios.filter((scenario) => isWholeEventScenario(scenario.name))

describe("step E's side of the replay: the whole event (W31)", () => {
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
      const recording = await replay(environment, scenario, newWholeEventSide({ calls }))
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => WHOLE_EVENT_ACTIONS.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      const named = WHOLE_EVENT_DIFFERENCES.get(name) ?? []
      if (process.env.W31_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W31_DIFFERENCES_OUT,
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
  it("the family is whole: every whole-event scenario is replayed here (W27's 13, and E7), none is also an event place scenario, and every named difference is for a scenario that exists", () => {
    expect(families.length).toBe(14)
    expect(families.filter((scenario) => scenario.name.startsWith('w27-event-whole-cancel-')).length).toBe(13)
    expect(families.filter((scenario) => scenario.name.startsWith('w27-e7-')).map((scenario) => scenario.name)).toEqual([E7_SCENARIO])
    expect(families.some((scenario) => isEventPlacesScenario(scenario.name))).toBe(false)
    // Every scenario that calls the old cancelEvent or its overview is in this family or W30's (none is left on the old code).
    expect([...WHOLE_EVENT_DIFFERENCES.keys()].every((name) => families.some((scenario) => scenario.name === name))).toBe(true)
    // 6 match their golden files exactly; 4 differ only in the refund's key; 4 have differences of their own (W58: one reworded).
    expect(families.filter((scenario) => !WHOLE_EVENT_DIFFERENCES.has(scenario.name)).length).toBe(6)
    expect([...WHOLE_EVENT_DIFFERENCES.values()].filter((named) => named.length === 1 && named[0] === EVENT_CLAIM_KEYS).length).toBe(4)
    expect([...WHOLE_EVENT_DIFFERENCES.values()].filter((named) => named.some((one) => one !== EVENT_CLAIM_KEYS)).length).toBe(4)
  })

  it('bugs E6 and E7 are each named, with their decision, on their own scenario', () => {
    const own = (name: string) => (WHOLE_EVENT_DIFFERENCES.get(name) ?? []).filter((one) => one !== EVENT_CLAIM_KEYS)
    expect(own(E7_SCENARIO)).toHaveLength(1)
    expect(own(E7_SCENARIO)[0]?.name).toMatch(/^Bug E7 is closed/)
    expect(own(E7_SCENARIO)[0]?.decision).toMatch(/^Bug E7 \(E-plan section 3\)/)
    expect(own(E6_SCENARIO)).toHaveLength(1)
    expect(own(E6_SCENARIO)[0]?.name).toMatch(/^Bug E6 is closed/)
    expect(own(E6_SCENARIO)[0]?.decision).toMatch(/^Bug E6 \(E-plan section 3\)/)
  })

  it('bug E6, in the rows: the event is cancelled by one request that moves no money, then each booking is its own request, with its own stored answer and its own claim (the old function did it all in one call)', async () => {
    const name = 'w27-event-whole-cancel-card-and-cash-bookings-to-card'
    const scenario = families.find((one) => one.name === name)
    if (!scenario) throw new Error(`No scenario ${name}`)
    const recording = await replay(environment, scenario, newWholeEventSide())
    const audit = (recording.tables['audit_log']?.added ?? []) as Array<Record<string, unknown> & { details?: Record<string, unknown> }>
    const of = (action: string) => audit.filter((row) => row['action'] === action)
    expect(of('event.cancel')).toHaveLength(1)
    expect(of('event.cancel')[0]?.details).toEqual({ reason: 'Storm', bookings: 2, places: 3, value: 100 })
    const claims = of('event_booking.refund_claimed')
    expect(claims).toHaveLength(2)
    // Three requests in all: the event's, and one for each booking.
    const requests = new Set([of('event.cancel')[0]?.['request_id'], ...claims.map((row) => row['request_id'])])
    expect(requests.size).toBe(3)
    expect(new Set(claims.map((row) => row['entity_id'])).size).toBe(2)
    for (const claim of claims) expect((claim.details?.['cancel'] as { wholeEvent?: boolean; eventCancelled?: boolean }).wholeEvent).toBe(true)
    // One stored answer for each booking's press, each under its own key; none for the event's cancel (it is safe to run again).
    const stored = (recording.tables['api_idempotency']?.added ?? []) as Array<Record<string, unknown>>
    expect(stored).toHaveLength(2)
    expect(new Set(stored.map((row) => row['endpoint'])).size).toBe(2)
    expect(stored.every((row) => /^POST \/api\/v1\/staff\/event-bookings\/[^/]+\/cancel$/.test(String(row['endpoint'])))).toBe(true)
    // One refund, for the card booking; the cash booking went to store credit (Q42 for a whole event).
    expect(recording.stripeCalls.filter((call) => call.method === 'refunds.create')).toHaveLength(1)
  })

  it("the W05 invariants hold on the new side for every whole-event scenario: Stripe's refunds are all on the rows and on the places (the old side breaks them in the lost-answer recording)", async () => {
    const old = await sweepInvariants(environment, families, oldSide)
    const fresh = await sweepInvariants(environment, families, newWholeEventSide())
    expect(fresh.wrong).toEqual([])
    expect(old.wrong.every((line) => line.startsWith(`${E6_SCENARIO}: `) || line.startsWith(`${E7_SCENARIO}: `))).toBe(true)
    if (process.env.W31_DIFFERENCES_OUT) appendFileSync(process.env.W31_DIFFERENCES_OUT, `${JSON.stringify({ oldSideInvariants: old.wrong })}\n`)
  })

  describe('the comparison catches what it is for', () => {
    const scenario = (name: string) => {
      const found = families.find((one) => one.name === name)
      if (!found) throw new Error(`No scenario ${name}`)
      return found
    }
    const keysOnly = 'w27-event-whole-cancel-card-and-cash-bookings-to-card'
    const exact = 'w27-event-whole-cancel-everything-to-store-credit'
    const named = (name: string) => WHOLE_EVENT_DIFFERENCES.get(name) ?? []
    type Listed = { ok: boolean; results?: Array<Record<string, unknown>> }

    it('a deliberate difference in what staff are told is caught: a penny more store credit in a booking\'s row; a booking left out of the list; the overview a place out', async () => {
      const penny = await replay(
        environment,
        scenario(keysOnly),
        newWholeEventSide({ adjust: (action, answer) => (action === 'cancelEvent' ? { ...(answer as Listed), results: ((answer as Listed).results ?? []).map((row, index) => (index === 1 ? { ...row, storeCreditRefundedAmount: 20.01 } : row)) } : answer) })
      )
      expect(compareSides(readGolden(keysOnly) as Recording, penny, named(keysOnly)).map((difference) => difference.path)).toEqual(['.results[3].results[1].storeCreditRefundedAmount'])
      const short = await replay(
        environment,
        scenario(keysOnly),
        newWholeEventSide({ adjust: (action, answer) => (action === 'cancelEvent' ? { ...(answer as Listed), results: ((answer as Listed).results ?? []).slice(0, 1) } : answer) })
      )
      expect(compareSides(readGolden(keysOnly) as Recording, short, named(keysOnly)).map((difference) => difference.path)).toEqual(['.results[3].results[1]'])
      const overview = await replay(
        environment,
        scenario(keysOnly),
        newWholeEventSide({ adjust: (action, answer) => (action === 'getEventCancellationOverview' ? { ...(answer as object), totalPlaces: 4 } : answer) })
      )
      expect(compareSides(readGolden(keysOnly) as Recording, overview, named(keysOnly)).map((difference) => difference.path)).toEqual(['.results[2].totalPlaces', '.results[4].totalPlaces'])
    })

    it('a deliberate difference in the rows is caught: the event not marked cancelled, another reason or person on it, a booking left confirmed, a place not released, a refund on a place or the line a penny out, store credit a penny out', async () => {
      for (const [tamper, path] of [
        // (The database itself refuses a cancelled event put back on sale: events_on_sale_complete.)
        ['UPDATE events SET cancelled_at = NULL', '.tables.events.changed[0].cancelled_at'],
        ["UPDATE events SET cancel_reason = 'Another reason'", '.tables.events.changed[0].cancel_reason'],
        ['UPDATE events SET cancelled_by = NULL', '.tables.events.changed[0].cancelled_by'],
        ['UPDATE events SET places_booked = places_booked + 1', '.tables.events.changed[0].places_booked'],
        ["UPDATE event_bookings SET status = 'confirmed', places = 1, cancelled_at = NULL, cancelled_by = NULL WHERE id = (SELECT id FROM event_bookings ORDER BY created_at, id LIMIT 1)", '.tables.event_bookings.added[0].status'],
        ['UPDATE event_attendees SET refunded_amount = refunded_amount - 0.01 WHERE id = (SELECT id FROM event_attendees ORDER BY created_at, id LIMIT 1)', '.tables.event_attendees.added[0].refunded_amount'],
        ['UPDATE event_attendees SET refund_after_cutoff = true WHERE id = (SELECT id FROM event_attendees ORDER BY created_at, id LIMIT 1)', '.tables.event_attendees.added[0].refund_after_cutoff'],
        ['UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + 0.01 WHERE card_refunded_amount > 0', '.tables.order_line_items.added[0].card_refunded_amount'],
        ["UPDATE store_credit_transactions SET amount = amount + 0.01 WHERE reason = 'refund'", '.tables.store_credit_transactions.added[0].amount'],
      ] as const) {
        const recording = await replay(environment, scenario(keysOnly), newWholeEventSide(), {
          async tamper(db) {
            // Test data only: each statement is a literal above.
            await db.query(tamper)
          },
        })
        const paths = compareSides(readGolden(keysOnly) as Recording, recording, named(keysOnly)).map((difference) => difference.path)
        // A changed row's field is reported with its before and after beneath it, so the field's path is a prefix.
        expect(paths.some((found) => found.startsWith(path)), `${tamper}: ${paths.join(', ')}`).toBe(true)
      }
    })

    it("a second refund sent to Stripe is caught, and so is one sent under any key but the claim's", async () => {
      const recording = await replay(environment, scenario(keysOnly), newWholeEventSide())
      const twice: Recording = { ...recording, stripeCalls: [...recording.stripeCalls, ...recording.stripeCalls.filter((call) => call.method === 'refunds.create')] }
      expect(compareSides(readGolden(keysOnly) as Recording, twice, named(keysOnly)).map((difference) => difference.path)).toEqual(['.stripeCalls[2]'])
      const wrongKey: Recording = { ...recording, stripeCalls: recording.stripeCalls.map((call) => (call.method === 'refunds.create' ? { ...call, idempotencyKey: 'event-refund:made-up' } : call)) }
      expect(compareSides(readGolden(keysOnly) as Recording, wrongKey, named(keysOnly)).map((difference) => difference.path)).toEqual(['.stripeCalls[1].idempotencyKey'])
    })

    it("an unused allowance fails: one nobody needs, on a scenario that matches exactly, on a keys-only one and on E7's; and the keys' own allowance on a scenario that sends no card refund", async () => {
      const stale: AllowedDifference = { name: 'An allowance nobody needs', decision: 'none', path: /^\.results\[1\]\.warning$/ }
      for (const name of [exact, keysOnly, E7_SCENARIO]) {
        const recording = await replay(environment, scenario(name), newWholeEventSide())
        expect(compareSides(readGolden(name) as Recording, recording, [...named(name), stale]).map((difference) => difference.path), name).toEqual(['(allowed difference not seen: An allowance nobody needs)'])
      }
      const recording = await replay(environment, scenario(exact), newWholeEventSide())
      expect(compareSides(readGolden(exact) as Recording, recording, [EVENT_CLAIM_KEYS]).map((difference) => difference.path)).toEqual([`(allowed difference not seen: ${EVENT_CLAIM_KEYS.name})`])
    })

    it("a pinned difference refuses any other value: E7's order taken after all; E7's refusal with another reason; E6's row with other words, or its retry listing another figure; the permission refusal with another reason", async () => {
      // E7: the reader order refused is only allowed as `event_cancelled`. (The order is New Order's own answer, from
      // the old side of this replay, so it is changed in the recording rather than on the way out of the Worker.)
      const e7 = await replay(environment, scenario(E7_SCENARIO), newWholeEventSide())
      const orderAnswered = (change: Record<string, unknown>): Recording => ({ ...e7, results: e7.results.map((answer) => ((answer as { reason?: string } | null)?.reason === 'event_cancelled' ? { ...(answer as object), ...change } : answer)) })
      expect(compareSides(readGolden(E7_SCENARIO) as Recording, orderAnswered({ reason: 'event_full' }), named(E7_SCENARIO)).map((difference) => difference.path)).toEqual(['.results[2].reason'])
      // E7: and it must be refused: an answer saying the order was placed is not allowed there.
      expect(compareSides(readGolden(E7_SCENARIO) as Recording, orderAnswered({ success: true }), named(E7_SCENARIO)).map((difference) => difference.path)).toEqual(['.results[2].success'])
      // E7: nor is any trace of the order: a PaymentIntent made for it is not allowed.
      const withIntent: Recording = { ...e7, stripeCalls: [{ method: 'paymentIntents.create', params: { amount: 8000 }, idempotencyKey: null }, ...e7.stripeCalls] as Recording['stripeCalls'] }
      expect(compareSides(readGolden(E7_SCENARIO) as Recording, withIntent, named(E7_SCENARIO)).some((difference) => difference.path.startsWith('.stripeCalls['))).toBe(true)
      // E7: the overview must have nothing left to cancel.
      const left = await replay(environment, scenario(E7_SCENARIO), newWholeEventSide({ adjust: (action, answer) => (action === 'getEventCancellationOverview' ? { ...(answer as object), totalPlaces: 2 } : answer) }))
      expect(compareSides(readGolden(E7_SCENARIO) as Recording, left, named(E7_SCENARIO)).map((difference) => difference.path)).toEqual(['.results[3].totalPlaces'])

      // E6: the no-answer row's words are pinned, and the retry must list the £80 that went to the card.
      const listed = (change: (row: Record<string, unknown>) => Record<string, unknown>) =>
        newWholeEventSide({ adjust: (action, answer) => (action === 'cancelEvent' && (answer as Listed).ok ? { ...(answer as Listed), results: ((answer as Listed).results ?? []).map((row, index) => (index === 0 ? change(row) : row)) } : answer) })
      const otherWords = await replay(environment, scenario(E6_SCENARIO), listed((row) => (row['noAnswer'] ? { ...row, message: `${BOOKING_NO_ANSWER_MESSAGE} Or refund it by hand.` } : row)))
      expect(compareSides(readGolden(E6_SCENARIO) as Recording, otherWords, named(E6_SCENARIO)).map((difference) => difference.path)).toEqual(['.results[2].results[0].message'])
      // (£0 there is the old recording's own value, so the comparison can't object to it: the rule's own test holds
      // the £80, "a retry: …the same press sent twice under one key refunds once" in events/cancel-event.test.ts.)
      const anotherFigure = await replay(environment, scenario(E6_SCENARIO), listed((row) => (row['ok'] === true ? { ...row, cardRefundedAmount: 79.99 } : row)))
      expect(compareSides(readGolden(E6_SCENARIO) as Recording, anotherFigure, named(E6_SCENARIO)).map((difference) => difference.path)).toEqual(['.results[3].results[0].cardRefundedAmount'])

      // No Issue refunds: only `permission_denied`, as data.
      const denied = 'w27-event-whole-cancel-refused-without-issue-refunds'
      const reason = await replay(environment, scenario(denied), newWholeEventSide({ adjust: (_action, answer) => ((answer as { reason?: string } | null)?.reason === 'permission_denied' ? { ...(answer as object), reason: 'something_else' } : answer) }))
      expect(compareSides(readGolden(denied) as Recording, reason, named(denied)).map((difference) => difference.path)).toEqual(['.results[1].reason'])
    })
  })
})
