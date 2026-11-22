import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { seatLineLessPaidAddOns, type AllowedDifference, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'
import { ID } from './scenarios'
import { replayStripe } from './stripe-binding'
import { asWorkerFlow, postFlowStep } from '../sweep/flow-presses'

/*
 * W12: the reader flows' side of the replay (flow-replay.test.ts) and its helpers, shared with
 * server/rules/orders/reader-flow.test.ts and the reconcile tests. A test file using it mocks
 * @/server/db/connection to the replay database and @/server/stripe/client with stripeClientMock, and
 * sets STAFF_API_KEY, as order-side.ts's users do.
 */

// W64: the presses moved to the sweep folder (H-plan 3.3 step 3); re-exported for the old replay's files.
export * from '../sweep/flow-presses'

/** Every scenario whose golden file finishes or cancels a reader flow (pending_reader_payments rows written). */
export const FLOW_SCENARIOS: readonly string[] = [
  'add-guest-while-a-reader-move-is-open',
  'addon-with-guest-private-reader-not-ticked',
  'addon-with-guest-private-reader-ticked',
  'addon-with-guest-private-split-reader-not-ticked',
  'addon-with-guest-private-split-reader-ticked',
  'addon-with-guest-public-reader-not-ticked',
  'addon-with-guest-public-reader-ticked',
  'addon-with-guest-public-split-reader-not-ticked',
  'addon-with-guest-public-split-reader-ticked',
  'cancel-while-a-guest-is-on-the-reader',
  'cancel-while-a-reader-move-is-open',
  'move-while-a-guest-is-on-the-reader',
  'part-refund-while-a-reader-move-is-open',
  'q25-higher-tier-on-the-reader-then-refund',
  'q25-higher-tier-on-the-reader-to-store-credit',
  'q25-higher-tier-split-on-the-reader-then-refund',
  'q25-reader-cancelled-puts-it-all-back',
  'q27-part-to-card-higher-tier-on-the-reader-then-to-the-card',
  'q27-part-to-credit-higher-tier-on-the-reader-then-to-store-credit',
  'q27-part-to-credit-higher-tier-on-the-reader-then-to-the-card',
  'q27-reader-cancelled-after-a-part-refund',
  'q28-private-dearer-on-the-reader',
  'q28-private-reader-cancelled-puts-it-all-back',
  'q28-public-dearer-on-the-reader',
  'reader-move-finished-then-remove-guest',
  'refund-the-rest-while-a-reader-move-is-open',
  'remove-guest-while-a-guest-is-on-the-reader',
  'remove-guest-while-a-reader-move-is-open',
  'second-guest-while-a-guest-is-on-the-reader',
  'second-move-while-a-reader-move-is-open',
  'w05l-add-guest-gift-card-and-reader-answer-lost-then-cancel',
  'w05l-move-gift-card-and-reader-answer-lost-then-cancel',
  'w05l-move-gift-card-and-reader-then-cancel',
  'w05l-move-gift-card-and-reader-undone-then-cancel',
  'w05l-settle-gift-card-and-reader-answer-lost-then-cancel',
  'w05l-settle-gift-card-and-reader-then-cancel',
  'w05l-settle-gift-card-and-reader-undone-then-settled',
]

/** The old functions for everything, apart from the flow's finalise and cancel, which go to the new routes. */
export function newFlowSide(): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    replayStripe.current = stripe
    return {
      name: 'new',
      async call(action, params) {
        if (action === 'finaliseReaderPayment' || action === 'cancelReaderPayment') {
          const { pendingId } = params as { pendingId: string }
          const answer = await postFlowStep(action === 'finaliseReaderPayment' ? 'finalise' : 'cancel', pendingId)
          return answer.body.ok ? answer.body.data : { error: answer.body.error }
        }
        const result = (await old.call(action, params)) as { pendingReaderPayment?: { pendingId?: string } } | null
        const pendingId = result?.pendingReaderPayment?.pendingId
        if (pendingId) await asWorkerFlow(db, pendingId)
        return result
      },
    }
  }
}

const STEP_D = 'Brief W12 item 2: the new routes take only flows the Worker started; step D writes these as it starts one'
/** W24 (W20 review later 1): each mark with its one right value, where W12 let any value through on these paths. */
const MARK_VALUES: Readonly<Record<string, (value: unknown) => boolean>> = {
  method: (value) => value === 'reader',
  channel: (value) => value === 'staff',
  request_id: (value) => typeof value === 'string' && value.length > 0,
  stripe_customer_id: (value) => typeof value === 'string' && value.startsWith('cus_'),
  livemode: (value) => value === false,
}
export const WORKER_FLOW_RECORD: AllowedDifference = {
  name: "A flow's record carries what step D's Worker start writes: method, channel, request id, Stripe customer, the key's mode",
  decision: STEP_D,
  path: /^\.tables\.pending_reader_payments\.added\[\d+\]\.snapshot\.(method|channel|request_id|stripe_customer_id|livemode)$/,
  actual: (value, expected, path) => expected === undefined && (MARK_VALUES[path.slice(path.lastIndexOf('.') + 1)]?.(value) ?? false),
}

type AuditRow = Row & { action?: string; entity_type?: string; details?: Record<string, unknown> | null }
/** A value with its objects' keys in order, so two copies of a snapshot compare whatever order their keys came back in. */
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, inner]) => [key, sorted(inner)]))
      : value
const FLOW_ROW = (row: AuditRow): boolean => row.action === 'reader_payment.finalise' || row.action === 'reader_payment.cancel'
const AUDIT_LABEL = /^audit_log#\d+$/

/**
 * W24 (W20 review later 1, in place of W12's whole-table allowances for audit_log and api_idempotency): a recording as
 * the flow replay compares it. The new side's own rows (the flow routes' `reader_payment.finalise` / `.cancel` audit rows
 * and their stored answers) are set aside and checked exactly by flowRowProblems; every other audit row is compared on
 * both sides, without the ids and labels that shift when rows are set aside.
 */
export function flowComparable(recording: Recording, side: 'golden' | 'new'): Recording {
  const tables = { ...recording.tables }
  delete tables['api_idempotency']
  const audit = tables['audit_log']
  if (audit) {
    const added = (audit.added as AuditRow[])
      .filter((row) => side === 'golden' || !FLOW_ROW(row))
      .map((row) => {
        const rest: AuditRow = { ...row }
        delete rest['id']
        const details = rest.details ? Object.fromEntries(Object.entries(rest.details).map(([key, value]) => [key, typeof value === 'string' && AUDIT_LABEL.test(value) ? '<audit row>' : value])) : rest.details
        return { ...rest, details }
      })
    if (added.length === 0 && audit.changed.length === 0 && audit.removed.length === 0) delete tables['audit_log']
    else tables['audit_log'] = { added, changed: audit.changed, removed: audit.removed, tied: 0 }
  }
  return { ...recording, tables }
}

/**
 * W24: the flow routes' own rows, exactly: each finalise or cancel row's fields, and each stored answer a finished press
 * of a flow route. W24a (W24 review, its unread parts): each row is held to its own flow's record in the same recording
 * (which is compared with the golden file to the penny): a finalise row's `collected` is that flow's expected amount on
 * that flow's PaymentIntent, a cancel row's snapshot is that flow's, and each names the flow's kind and booking. Before,
 * any `collected` above £0 passed.
 */
export function flowRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const flows = recording.tables['pending_reader_payments']?.added ?? []
  for (const row of ((recording.tables['audit_log']?.added ?? []) as AuditRow[]).filter(FLOW_ROW)) {
    const d = row.details ?? {}
    const keys = Object.keys(d).sort().join(',')
    const flow = flows.find((candidate) => candidate['id'] === row['entity_id'])
    if (!flow) problems.push(`${String(row.action)}: no flow record ${String(row['entity_id'])}`)
    else {
      if (d['flow'] !== flow['flow'] || d['recordId'] !== flow['record_id']) problems.push(`${String(row.action)}: ${String(d['flow'])} on ${String(d['recordId'])}, the record ${String(flow['flow'])} on ${String(flow['record_id'])}`)
      if (row.action === 'reader_payment.finalise' && (flow['status'] !== 'finalised' || typeof d['collected'] !== 'number' || Math.round(d['collected'] * 100) !== Math.round(Number(flow['expected_amount']) * 100) || d['paymentIntentId'] !== flow['payment_intent_id'])) {
        problems.push(`finalise: collected ${String(d['collected'])} on ${String(d['paymentIntentId'])}, the record ${String(flow['status'])} ${String(flow['expected_amount'])} on ${String(flow['payment_intent_id'])}`)
      }
      if (row.action === 'reader_payment.cancel' && (flow['status'] !== 'cancelled' || JSON.stringify(sorted(d['snapshot'])) !== JSON.stringify(sorted(flow['snapshot'])))) {
        problems.push(`cancel: the record ${String(flow['status'])}, snapshot ${JSON.stringify(d['snapshot'])}, the record's ${JSON.stringify(flow['snapshot'])}`)
      }
    }
    if (row.entity_type !== 'reader_payment') problems.push(`${String(row.action)}: entity ${String(row.entity_type)}`)
    if (row.action === 'reader_payment.finalise' && keys !== 'alreadyRecorded,collected,flow,orderId,paymentIntentId,recordId') problems.push(`finalise: fields ${keys}`)
    if (row.action === 'reader_payment.finalise' && (!(Number(d['collected']) > 0) || typeof d['paymentIntentId'] !== 'string' || typeof d['orderId'] !== 'string')) problems.push(`finalise: ${JSON.stringify(d)}`)
    if (row.action === 'reader_payment.cancel' && keys !== 'flow,problems,recordId,snapshot,why') problems.push(`cancel: fields ${keys}`)
    if (row.action === 'reader_payment.cancel' && (!Array.isArray(d['problems']) || (d['problems'] as unknown[]).length > 0)) problems.push(`cancel: ${JSON.stringify(d)}`)
  }
  for (const row of recording.tables['api_idempotency']?.added ?? []) {
    if (row['status'] !== 'done' || !/^POST \/api\/v1\/staff\/reader-flows\/[^/]+\/(finalise|cancel)$/.test(String(row['endpoint']))) problems.push(`stored answer ${String(row['endpoint'])}: ${String(row['status'])}`)
  }
  return problems
}

/**
 * W20 (W05c Noticed 5): the Worker's finalise of an Add Guest flow writes the seat on the booking line and the paid
 * add-ons on their own lines of the same order, so where a guest and an add-on were paid on the reader the booking line
 * is smaller by the add-on (never below £0). The refund figures' seat money is unchanged (money-left.ts takes the
 * add-ons out of the old, larger line).
 */
const SEAT_ON_THE_BOOKING_LINE: AllowedDifference = {
  name: "An Add Guest flow's order puts only the seat on the booking line; the paid add-ons are on their own lines of the same order",
  decision: 'W05c Noticed 5 (D-plan 2.3); brief W20 item 2; brief W20a item 4 (exact, booking lines only)',
  path: /^\.tables\.order_line_items\.added\[\d+\]\.(unit_price|line_total)$/,
  actual: seatLineLessPaidAddOns,
}

/** The flow scenarios where a guest and a paid add-on were paid together on the reader (W05c's golden families). */
const GUEST_AND_ADDON_ON_THE_READER: ReadonlySet<string> = new Set([
  'addon-with-guest-private-reader-not-ticked',
  'addon-with-guest-private-reader-ticked',
  'addon-with-guest-private-split-reader-not-ticked',
  'addon-with-guest-private-split-reader-ticked',
  'addon-with-guest-public-reader-not-ticked',
  'addon-with-guest-public-reader-ticked',
  'addon-with-guest-public-split-reader-not-ticked',
  'addon-with-guest-public-split-reader-ticked',
])

/**
 * W12's named differences for the flows: the three above, in every scenario (each finishes or cancels one); W20: and
 * the seat on its own booking line, in the scenarios that paid a guest and an add-on together on the reader.
 */
export function flowDifferences(scenario?: string): AllowedDifference[] {
  return [
    WORKER_FLOW_RECORD,
    ...(scenario && GUEST_AND_ADDON_ON_THE_READER.has(scenario) ? [SEAT_ON_THE_BOOKING_LINE] : []),
    ...(scenario && STAFF_UNDOES_WITH_STORE_CREDIT.has(scenario) ? [W58_FLOW_UNDO_NAMES_THE_STAFF] : []),
  ]
}

/** W58 (W26 audit row 6): the flow scenarios a staff member's Cancel undoes, with store credit to give back. */
const STAFF_UNDOES_WITH_STORE_CREDIT: ReadonlySet<string> = new Set([
  'q25-reader-cancelled-puts-it-all-back',
  'w12-move-store-credit-and-reader-cancelled',
  'w12-settle-store-credit-and-reader-cancelled',
])
const W58_FLOW_UNDO_NAMES_THE_STAFF: AllowedDifference = {
  name: "A card flow undone by a staff member's press names them on its store credit reversal (the old undo named nobody)",
  decision: 'Brief W58 (W26 audit row 6, A2)',
  path: /^\.tables\.store_credit_transactions\.added\[\d+\]\.staff_id$/,
  actual: (value, expected) => expected === null && value === ID.staff,
}
