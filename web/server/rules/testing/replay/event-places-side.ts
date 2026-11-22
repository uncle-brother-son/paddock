import { REFUND_WATCH_ROW, refundsKeptProblem, refundWatchProblems } from './refunds-kept'
import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'
import { replayStripe } from './stripe-binding'
import { type CancelParams, EVENT_PLACE_ACTIONS, eventPlacesAsTheDialogPresses, settleHeldEventRefund } from '../sweep/event-places-presses'

/*
 * W30 (E-plan 4.13 item 3): step E's side of the replay for event places, as order-refund-side.ts is for order
 * refunds. The old cancelEventPlaces's and getEventCancellationQuote's params go to the staff app's thin wrappers,
 * which call the Worker's routes, and their answers come back in the old functions' shapes. Every other call (the
 * order being placed, the whole-event cancel, which is W31's) still runs through the frozen copies of the old
 * functions, so the seed state is exactly what each golden file recorded.
 * A test file using this mocks @/server/db/connection to the replay database and @/server/stripe/client to the
 * replay's fake, and sets STAFF_API_KEY, as booking-side.ts's users do.
 */

// W64: the presses moved to the sweep folder (H-plan 3.3 step 3); re-exported for the old replay's files.
export * from '../sweep/event-places-presses'

export interface EventPlacesSideOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
}

/**
 * The new side: cancelEventPlaces and getEventCancellationQuote through the staff app's wrappers and the Worker's
 * routes, everything else through the old functions (the frozen copies), on the same database and the same fake Stripe.
 */
export function newEventPlacesSide({ adjust, calls }: EventPlacesSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    replayStripe.current = stripe
    const dialog = eventPlacesAsTheDialogPresses()
    return {
      name: 'new',
      async call(action, params) {
        if (!EVENT_PLACE_ACTIONS.has(action)) {
          calls?.push({ action, side: 'old' })
          return old.call(action, params)
        }
        calls?.push({ action, side: 'new' })
        // A refund still held from an earlier step is settled first, as staff would find it on the Orders page.
        await settleHeldEventRefund(db, (params as CancelParams | null)?.eventBookingId)
        // The clock moves between presses, as the old side's moves with each statement (harness.ts, tick).
        vi.setSystemTime(Date.now() + 1)
        const answer = action === 'cancelEventPlaces' ? await dialog.cancel(db, params) : await dialog.quote(db, params)
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}

// --- What is set aside before the two recordings are compared, and checked on its own

type AuditRow = Row & { action?: unknown; entity_type?: unknown; details?: Record<string, unknown> | null }

/**
 * The old code's own notes about a card refund on an event booking: a refund held for the next press, a refusal
 * counted into the key, and the two key rows of its overlapping-press guard (`card_refund_recorded` on every card
 * refund it recorded, `card_refund_unallocated` when its recording failed).
 */
const OLD_EVENT_REFUND_NOTES: ReadonlySet<string> = new Set(['card_refund_held', 'event_booking.card_refund_refused', 'event_booking.card_refund_recorded', 'event_booking.card_refund_unallocated'])

/** The Worker's rows for an event place cancel: the claim, its finish and refusal mark, the cancel's own row. W31: and the whole event's own row. */
// W32a: with the watch on each card refund a finished claim keeps.
const WORKER_EVENT_ROWS: ReadonlySet<string> = new Set(['event_booking.refund_claimed', 'event_booking.refund_finished', 'event_booking.refund_refused', 'event_booking.cancel_places', 'event.cancel', REFUND_WATCH_ROW])

const auditRows = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]

/** The rows each side wrote for the refund machinery itself: the old code's notes (golden), the Worker's rows (new). */
export function eventPlacesAuditRows(recording: Recording, side: 'golden' | 'new'): AuditRow[] {
  return auditRows(recording).filter((row) => {
    const action = String(row.action)
    if (side === 'golden') return OLD_EVENT_REFUND_NOTES.has(action) && row['entity_type'] === 'event_booking'
    return WORKER_EVENT_ROWS.has(action) || (action === 'order.reconcile' && row['entity_type'] === 'refund_claim')
  })
}

type StripeCall = Recording['stripeCalls'][number]

/** The PaymentIntents the Worker's event booking claims in a recording planned to refund. */
function claimIntents(recording: Recording): Set<string> {
  const intents = new Set<string>()
  for (const row of auditRows(recording)) {
    if (row.action !== 'event_booking.refund_claimed' || row.details?.['worker'] !== true) continue
    const plan = row.details['plan'] as { card?: Array<{ paymentIntentId: string }> } | undefined
    for (const part of plan?.card ?? []) intents.add(part.paymentIntentId)
  }
  return intents
}

const isClaimLook = (call: StripeCall, intents: ReadonlySet<string>): boolean =>
  call.method === 'refunds.list' && call.idempotencyKey === null && intents.has(String((call.params as { payment_intent?: unknown } | null)?.payment_intent))

/**
 * Reconcile's looks for a held event claim (set aside by `comparableEventPlaces`): each a refunds.list of the claim's
 * PaymentIntent, with no key (a read). Answers the problems found. Reconcile sending anything shows in the comparison.
 */
export function eventClaimLookProblems(recording: Recording): string[] {
  const intents = claimIntents(recording)
  return recording.stripeCalls
    .filter((call) => isClaimLook(call, intents))
    .filter((call) => Object.keys((call.params ?? {}) as object).sort().join(',') !== 'limit,payment_intent')
    .map((call) => JSON.stringify(call))
}

/** The fields W30 adds to the answers, which no golden file has: set aside from the comparison and checked on their own. */
const NEW_QUOTE_FIELDS = ['cashAmount', 'refundOwed'] as const
const NEW_BOOKING_FIELDS = ['order_id', 'refund_owed_amount'] as const

/** An answer with W30's added fields taken off (a quote's cash and money owed; the booking's order and money owed). */
function withoutNewFields(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const answer = { ...(result as Record<string, unknown>) }
  if (answer['ok'] === true && 'wholeBooking' in answer) for (const field of NEW_QUOTE_FIELDS) delete answer[field]
  const booking = answer['booking']
  if (booking && typeof booking === 'object') {
    const rest = { ...(booking as Record<string, unknown>) }
    for (const field of NEW_BOOKING_FIELDS) delete rest[field]
    answer['booking'] = rest
  }
  return answer
}

/**
 * What W30's added answer fields must say: a quote's cash is a number from £0 up to the places' value, and its money
 * owed a number from £0; a booking names an order (or none) and its money owed as pounds and pence.
 */
export function eventNewFieldProblems(recording: Recording): string[] {
  const problems: string[] = []
  for (const [index, result] of recording.results.entries()) {
    if (!result || typeof result !== 'object') continue
    const answer = result as Record<string, unknown>
    if (answer['ok'] === true && 'wholeBooking' in answer) {
      const cash = answer['cashAmount']
      const owed = answer['refundOwed']
      if (typeof cash !== 'number' || cash < 0 || cash > Number(answer['value'])) problems.push(`results[${index}].cashAmount: ${String(cash)}`)
      if (typeof owed !== 'number' || owed < 0) problems.push(`results[${index}].refundOwed: ${String(owed)}`)
    }
    const booking = answer['booking'] as Record<string, unknown> | null | undefined
    if (booking && typeof booking === 'object') {
      if (!(booking['order_id'] === null || /^orders#\d+$/.test(String(booking['order_id'])))) problems.push(`results[${index}].booking.order_id: ${String(booking['order_id'])}`)
      if (!/^\d+\.\d\d$/.test(String(booking['refund_owed_amount']))) problems.push(`results[${index}].booking.refund_owed_amount: ${String(booking['refund_owed_amount'])}`)
    }
  }
  return problems
}

/**
 * A recording as the event places replay compares it: each side's own machinery rows set aside (the old notes, the
 * Worker's claims and cancel rows: eventPlacesAuditRows), the audit rows' own labels left out (they shift when rows
 * are set aside); the stored answers set aside (api_idempotency: only the new side has them); on the new side,
 * reconcile's looks for a held claim and W30's added answer fields set aside; store credit notes' random refs
 * unnumbered, and the remaining gone ids renumbered by where they are first met. Everything else is compared exactly,
 * and what was set aside is checked on its own (eventPlacesRowProblems, eventPlacesStoredAnswerProblems,
 * eventClaimLookProblems, eventNewFieldProblems).
 */
export function comparableEventPlaces(recording: Recording, side: 'golden' | 'new'): Recording {
  const aside = new Set(eventPlacesAuditRows(recording, side))
  const tables = { ...recording.tables }
  delete tables['api_idempotency']
  const audit = tables['audit_log']
  if (audit) {
    const added = (audit.added as AuditRow[])
      .filter((row) => !aside.has(row))
      .map((row) => {
        const rest: AuditRow = { ...row }
        delete rest['id']
        return rest
      })
    if (added.length === 0 && audit.changed.length === 0 && audit.removed.length === 0) delete tables['audit_log']
    else tables['audit_log'] = { added, changed: audit.changed, removed: audit.removed, tied: 0 }
  }
  const intents = side === 'new' ? claimIntents(recording) : new Set<string>()
  const stripeCalls = recording.stripeCalls.filter((call) => !isClaimLook(call, intents))
  const results = side === 'new' ? recording.results.map(withoutNewFields) : recording.results
  const text = JSON.stringify({ ...recording, results, stripeCalls, tables }).replace(/\[ref gone#\d+\]/g, '[ref gone]')
  return withCanonicalGoneNumbers(JSON.parse(text) as Recording)
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const sameKeys = (details: Record<string, unknown> | null | undefined, keys: readonly string[]): boolean => JSON.stringify(Object.keys(details ?? {}).sort()) === JSON.stringify([...keys].sort())

/**
 * What each of the Worker's own rows must say, exactly (the fields, and the sums between them). Answers the problems
 * found, empty when every row is right.
 */
export function eventPlacesRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const all = auditRows(recording)
  for (const row of eventPlacesAuditRows(recording, 'new')) {
    const d = row.details ?? {}
    const n = (key: string) => Number(d[key])
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    const onEventBooking = row['entity_type'] === 'event_booking' && /^event_bookings#\d+$/.test(String(row['entity_id'])) && typeof row['request_id'] === 'string'
    if (row.action === 'event_booking.refund_claimed') {
      const plan = (d['plan'] ?? {}) as { card?: Array<{ orderId?: unknown; paymentIntentId?: unknown; amount: number; lines?: Array<{ lineId?: unknown; amount: number }> }>; storeCredit?: number; cash?: number; ownOrderId?: unknown }
      const cash = Number(plan.cash ?? 0) > 0
      if (!sameKeys(d, ['kind', 'orderId', 'amount', 'method', 'reason', 'worker', 'plan', 'livemode', 'cancel', ...(cash ? ['handedOverBy'] : [])])) wrong('fields')
      if (d['kind'] !== 'cancel_places' || d['worker'] !== true || !/^orders#\d+$/.test(String(d['orderId']))) wrong('kind')
      if (!['card', 'credit', 'cash'].includes(String(d['method']))) wrong('method')
      const parts = plan.card ?? []
      // One card part at most, on the order that paid for the booking, on its event line alone.
      if (parts.length > 1) wrong('more than one card part')
      const part = parts[0]
      const cancel = (d['cancel'] ?? {}) as { eventId?: unknown; lineId?: unknown; places?: Array<{ id?: unknown; value: number; unitPrice: number }>; bookingCancelled?: unknown; afterCutoff?: unknown; wholeEvent?: unknown; eventCancelled?: unknown }
      if (part && (part.orderId !== d['orderId'] || typeof part.paymentIntentId !== 'string' || (part.lines ?? []).length !== 1 || part.lines?.[0]?.lineId !== cancel.lineId || part.lines?.[0]?.amount !== part.amount)) wrong('the card part')
      if (round2((part?.amount ?? 0) + Number(plan.storeCredit) + Number(plan.cash)) !== n('amount')) wrong('the plan is not what was claimed')
      if (part && d['method'] !== 'card') wrong('a card part only for the card')
      if (cash && (d['method'] !== 'cash' || part)) wrong('cash only for cash, never beside a card part')
      if ((part !== undefined) !== (typeof d['livemode'] === 'boolean')) wrong("the key's mode exactly with a card part")
      if (plan.ownOrderId !== d['orderId']) wrong("the store credit's order")
      // What R1 cancelled: the places' values are what was claimed.
      // W31: `wholeEvent` and `eventCancelled` are there only when true: a whole-event cancel is always on a cancelled
      // event, always the whole booking, and never recorded as after the cut-off.
      const whole = 'wholeEvent' in cancel
      const onCancelled = 'eventCancelled' in cancel
      if (!sameKeys(cancel as Record<string, unknown>, ['eventId', 'lineId', 'places', 'bookingCancelled', 'afterCutoff', ...(whole ? ['wholeEvent'] : []), ...(onCancelled ? ['eventCancelled'] : [])]) || typeof cancel.bookingCancelled !== 'boolean' || typeof cancel.afterCutoff !== 'boolean') wrong("the cancel's record")
      if ((whole && cancel.wholeEvent !== true) || (onCancelled && cancel.eventCancelled !== true)) wrong("the cancel's whole-event marks are only ever true")
      if (whole && (!onCancelled || cancel.afterCutoff !== false || cancel.bookingCancelled !== true || d['method'] === 'cash')) wrong('a whole-event cancel is the whole booking, on a cancelled event, with no cut-off rule, never in cash')
      const places = cancel.places ?? []
      if (places.length === 0 || round2(places.reduce((total, place) => total + place.value, 0)) !== n('amount')) wrong('the places are not worth what was claimed')
      if (!places.every((place) => /^event_attendees#\d+$/.test(String(place.id)))) wrong('a place')
      if (!onEventBooking) wrong('entity or request id')
    } else if (row.action === 'event_booking.refund_finished') {
      const claim = all.find((other) => other['id'] === d['claimId'])
      const c = (claim?.details ?? {}) as Record<string, unknown>
      if (!sameKeys(d, ['claimId', 'outcome', 'cardRefunded', 'storeCreditRefunded', 'owed', ...('cash' in d ? ['cash'] : []), ...('refused' in d ? ['refused'] : []), ...('refunds' in d ? ['refunds'] : []), ...('by' in d ? ['by'] : [])])) wrong('fields')
      // W32: the card refunds' ids and statuses, kept for the refund watch (refunds-kept.ts).
      const kept = refundsKeptProblem(d, c)
      if (kept) wrong(kept)
      if (claim?.action !== 'event_booking.refund_claimed') wrong('no claim')
      if ('refused' in d && (typeof d['refused'] !== 'string' || d['refused'] === '' || d['outcome'] !== 'owed')) wrong('refused without money owed')
      const accounted = round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed') + Number(d['cash'] ?? 0))
      if (d['outcome'] === 'put_back') {
        if (accounted !== 0) wrong('a put-back moves nothing')
      } else if (accounted !== Number(c['amount'])) wrong('what went, to store credit, in cash and owed is not what was claimed')
      if (d['outcome'] !== 'put_back' && (d['outcome'] === 'owed') !== n('owed') > 0) wrong('owed exactly when something is')
      // Only the plan's own store credit is ever given: card money that never went is owed, never store credit on top.
      const planned = Number(((c['plan'] ?? {}) as { storeCredit?: number }).storeCredit ?? 0)
      if (d['outcome'] !== 'put_back' && n('storeCreditRefunded') !== round2(planned)) wrong("store credit given is not the plan's own")
      if (!onEventBooking) wrong('entity or request id')
    } else if (row.action === 'event_booking.refund_refused') {
      const claim = all.find((other) => other['id'] === d['claimId'])
      const plan = ((claim?.details ?? {})['plan'] ?? {}) as { card?: Array<{ orderId?: string; amount: number }> }
      if (!sameKeys(d, ['claimId', 'orderId', 'amount', 'detail'])) wrong('fields')
      if (claim?.details?.['worker'] !== true || !(plan.card ?? []).some((part) => part.orderId === d['orderId'] && part.amount === n('amount'))) wrong('not the card part of a Worker claim')
      if (typeof d['detail'] !== 'string' || !d['detail'].startsWith('Failed to refund payment: ')) wrong("Stripe's reason")
      const finished = all.find((other) => other.action === 'event_booking.refund_finished' && other.details?.['claimId'] === d['claimId'])
      if (finished && finished.details?.['outcome'] !== 'put_back' && !(Number(finished.details?.['owed']) >= n('amount'))) wrong('a refused part that did not end owed')
      if (!onEventBooking) wrong('entity or request id')
    } else if (row.action === 'event_booking.cancel_places') {
      const cash = 'cashRefunded' in d
      const whole = 'wholeEvent' in d
      if (!sameKeys(d, ['attendeeIds', 'places', 'value', 'bookingCancelled', 'refund', 'reason', 'afterCutoff', 'amount', 'cardRefunded', 'storeCreditRefunded', 'owed', ...(whole ? ['wholeEvent'] : []), ...(cash ? ['cashRefunded', 'handedOverBy'] : [])])) wrong('fields')
      // W31: a whole-event cancel's row says so, is never after the cut-off or in cash, and always carries a reason.
      if (whole && (d['wholeEvent'] !== true || d['afterCutoff'] !== false || cash || !['card', 'credit'].includes(String(d['refund'])) || typeof d['reason'] !== 'string' || d['reason'] === '')) wrong('a whole-event cancel')
      if (!['card', 'credit', 'cash', 'none'].includes(String(d['refund']))) wrong('the refund choice')
      if (round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed') + Number(d['cashRefunded'] ?? 0)) !== n('amount')) wrong('the parts are not the amount')
      // A cancel that gives money back gives exactly what the places were worth; one that gives none claims none.
      if (n('amount') !== 0 && n('amount') !== n('value')) wrong('the amount is not what the places were worth')
      if (d['refund'] === 'none' && n('amount') !== 0) wrong('No refund that gave something')
      if (!Array.isArray(d['attendeeIds']) || (d['attendeeIds'] as unknown[]).length !== n('places') || n('places') < 1) wrong('the places')
      // A cancel that stands with money back is written with its claim's finish; an undone one never has a row.
      if (!onEventBooking) wrong('entity or request id')
    } else if (row.action === 'event.cancel') {
      // W31: the whole event's own row, written once, by a staff member, with why and what was still to cancel.
      if (!sameKeys(d, ['reason', 'bookings', 'places', 'value'])) wrong('fields')
      if (typeof d['reason'] !== 'string' || d['reason'] === '' || !(n('bookings') >= 0) || !(n('places') >= n('bookings')) || !(n('value') >= 0)) wrong("the event cancel's figures")
      if (row['entity_type'] !== 'event' || typeof row['entity_id'] !== 'string' || row['entity_id'] === '' || typeof row['request_id'] !== 'string' || row['actor_type'] !== 'staff') wrong('entity, actor or request id')
      if (all.filter((other) => other.action === 'event.cancel' && other['entity_id'] === row['entity_id']).length !== 1) wrong('an event cancelled more than once')
    } else if (row.action === 'order.reconcile' && row['entity_type'] === 'refund_claim') {
      const finished = d['outcome'] === 'finalised' && sameKeys(d, ['outcome', 'detail'])
      const leftOnce = d['outcome'] === 'left' && d['reason'] === 'finish_failed' && sameKeys(d, ['outcome', 'reason', 'detail'])
      if (!finished && !leftOnce) wrong('a held claim reconcile finished')
    } else if (row.action === REFUND_WATCH_ROW) {
      // W32a: held to one rule, with the refunds the finished rows keep (below).
    } else {
      wrong('an unexpected row')
    }
  }
  problems.push(...refundWatchProblems(all, 'event_booking', 'event_booking.refund_finished'))
  // Every claim that isn't put back has exactly one cancel row beside its finish, and a put-back has none.
  for (const claim of all.filter((row) => row.action === 'event_booking.refund_claimed')) {
    const finished = all.filter((row) => row.action === 'event_booking.refund_finished' && row.details?.['claimId'] === claim['id'])
    if (finished.length > 1) problems.push(`event_booking.refund_claimed: finished ${finished.length} times`)
  }
  const stood = all.filter((row) => row.action === 'event_booking.refund_finished' && row.details?.['outcome'] !== 'put_back').length
  const withMoney = all.filter((row) => row.action === 'event_booking.cancel_places' && Number(row.details?.['amount']) > 0).length
  if (stood !== withMoney) problems.push(`event_booking.cancel_places: ${withMoney} cancels with money back for ${stood} claims that stood`)
  return problems
}

/** The stored answers the new side wrote: each a finished press of the event booking's cancel route on the Worker. */
export function eventPlacesStoredAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const route = /^POST \/api\/v1\/staff\/event-bookings\/[^/]+\/cancel$/
  return rows.filter((row) => row['status'] !== 'done' || !route.test(String(row['endpoint']))).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}
