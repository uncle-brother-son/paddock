import { REFUND_WATCH_ROW, refundsKeptProblem, refundWatchProblems } from './refunds-kept'
import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { OrderRefundFigures } from '@/contracts'
import { reconcileClaimNow } from '@/server/rules/orders/reconcile'
import { ORDER_CLAIMS, openClaimOn } from '@/server/rules/refunds/pipeline'
import type { FakeStripe } from '@/server/stripe/fake'
import { BOOKING_KINDS_ON, throughStaffApp, withSwitch } from './booking-side'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'
import { replayStripe } from './stripe-binding'

/*
 * W28 (E-plan 4.13 item 3): step E's side of the replay for order refunds, as booking-side.ts is step D's. The old
 * refundOrder's params go to the staff app's thin wrapper, which calls the Worker's route, and its answer comes back
 * in the old function's shape. Every other call (the order being placed, a reader payment finalised) still runs
 * through the frozen copies of the old functions, so the seed state is exactly what each golden file recorded.
 * A test file using this mocks @/server/db/connection to the replay database and @/server/stripe/client to the
 * replay's fake, and sets STAFF_API_KEY, as booking-side.ts's users do.
 */

/** ORDER_SWITCH as it will be live once Wayne adds `order_refunds` (W27's kind; off with today's secret). */
export const ORDER_REFUND_KINDS_ON = `${BOOKING_KINDS_ON},order_refunds`

type Params = { orderId?: string; lineItemIds?: string[]; refundMethod?: string; restock?: Record<string, boolean> }

/**
 * A refund the Worker held: staff check the Orders page, where reconcile has settled it, before they do anything else
 * to the order. The replay settles it as reconcile does (it never sends a refund) straight after the press, and again
 * before the order's next step.
 */
export async function settleHeldOrderRefund(db: Db, orderId: string | undefined): Promise<void> {
  if (!orderId || !replayStripe.current || !/^[0-9a-f-]{36}$/i.test(orderId)) return
  const held = await openClaimOn(db, ORDER_CLAIMS, orderId)
  if (held) await reconcileClaimNow(db, replayStripe.current, held, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID() })
}

/**
 * refundOrder as the Refund Line Items dialog presses it (brief W28 item 5): it loads the Worker's figures when it
 * opens, shows what the chosen lines give back, and sends that total back as `confirmed` (Q18; the old params had no
 * figure, and the old dialog added up `line_total` itself, E1), with a press key kept after a press that got no answer
 * until the dialog closes (E11), and the switch on. With no figures (an order that doesn't exist) the dialog can't
 * show a total: the press goes with £0, and the Worker refuses the order first.
 */
export function refundOrderAsTheDialogPresses(options: { settleHeld?: boolean } = {}): (db: Db, params: unknown) => Promise<unknown> {
  // The key of a press that got no answer, with the total the dialog is still showing (it stays open with its figures).
  const heldKeys = new Map<string, { key: string; amount: number }>()
  return async (db, params) => {
    const sent = (params ?? {}) as Params
    const orderId = sent.orderId ?? ''
    const held = heldKeys.get(orderId)
    let amount = held?.amount ?? 0
    if (orderId && !held) {
      try {
        const figures = (await withSwitch(ORDER_REFUND_KINDS_ON, () => throughStaffApp('getOrderRefundFigures')(db, { orderId }))) as OrderRefundFigures
        const chosen = new Set(sent.lineItemIds ?? [])
        amount = Math.round(figures.lines.filter((line) => chosen.has(line.lineItemId)).reduce((total, line) => total + line.refundable, 0) * 100) / 100
      } catch {
        // No figures: nothing to show, so £0 is sent and the Worker answers for the order.
      }
    }
    const idempotencyKey = held?.key ?? crypto.randomUUID()
    const answer = (await withSwitch(ORDER_REFUND_KINDS_ON, () => throughStaffApp('refundOrder')(db, { ...sent, confirmed: { amount }, idempotencyKey }))) as { noAnswer?: boolean } | null
    if (answer?.noAnswer) heldKeys.set(orderId, { key: idempotencyKey, amount })
    else heldKeys.delete(orderId)
    if (options.settleHeld !== false) await settleHeldOrderRefund(db, orderId)
    return answer
  }
}

export interface OrderRefundSideOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
}

/**
 * The new side: refundOrder through the staff app's wrapper and the Worker's route, everything else through the old
 * functions (the frozen copies), on the same database and the same fake Stripe.
 */
export function newOrderRefundSide({ adjust, calls }: OrderRefundSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    replayStripe.current = stripe
    const press = refundOrderAsTheDialogPresses()
    return {
      name: 'new',
      async call(action, params) {
        if (action !== 'refundOrder') {
          calls?.push({ action, side: 'old' })
          return old.call(action, params)
        }
        calls?.push({ action, side: 'new' })
        // A refund still held from an earlier step is settled first, as staff would find it on the Orders page.
        await settleHeldOrderRefund(db, (params as Params | null)?.orderId)
        // The clock moves between presses, as the old side's moves with each statement (harness.ts, tick).
        vi.setSystemTime(Date.now() + 1)
        const answer = await press(db, params)
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}

// --- What is set aside before the two recordings are compared, and checked on its own

type AuditRow = Row & { action?: unknown; entity_type?: unknown; details?: Record<string, unknown> | null }

/** The old code's own notes about a card refund on an order: a refund held for the next press, and a refusal counted into the key. */
const OLD_ORDER_REFUND_NOTES: ReadonlySet<string> = new Set(['card_refund_held', 'order.card_refund_refused'])

/** The Worker's rows for an order refund: the claim, its finish and refusal mark, the actions' own rows. */
const WORKER_ORDER_REFUND_ROWS: ReadonlySet<string> = new Set([
  'order.refund_claimed',
  'order.refund_finished',
  'order.refund_refused',
  'order.refund',
  'order.refund_owed',
  'order.owed_arrived',
  // W29: a refunded membership's subscription, recorded as left with the money and closed by its cancel.
  'order.subscription_left',
  // W32a: the watch on each card refund a finished claim keeps.
  REFUND_WATCH_ROW,
])

const auditRows = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]

/** The rows each side wrote for the refund machinery itself: the old code's notes (golden), the Worker's rows (new). */
export function orderRefundAuditRows(recording: Recording, side: 'golden' | 'new'): AuditRow[] {
  return auditRows(recording).filter((row) => {
    const action = String(row.action)
    if (side === 'golden') return OLD_ORDER_REFUND_NOTES.has(action) && row['entity_type'] === 'order'
    return WORKER_ORDER_REFUND_ROWS.has(action) || (action === 'order.reconcile' && row['entity_type'] === 'refund_claim')
  })
}

type StripeCall = Recording['stripeCalls'][number]

/** The PaymentIntents the Worker's order claims in a recording planned to refund. */
function claimIntents(recording: Recording): Set<string> {
  const intents = new Set<string>()
  for (const row of auditRows(recording)) {
    if (row.action !== 'order.refund_claimed' || row.details?.['worker'] !== true) continue
    const plan = row.details['plan'] as { card?: Array<{ paymentIntentId: string }> } | undefined
    for (const part of plan?.card ?? []) intents.add(part.paymentIntentId)
  }
  return intents
}

const isClaimLook = (call: StripeCall, intents: ReadonlySet<string>): boolean =>
  call.method === 'refunds.list' && call.idempotencyKey === null && intents.has(String((call.params as { payment_intent?: unknown } | null)?.payment_intent))

/**
 * Reconcile's looks for a held order claim (set aside by `comparableOrderRefund`): each a refunds.list of the claim's
 * PaymentIntent, with no key (a read). Answers the problems found. Reconcile sending anything shows in the comparison.
 */
export function orderClaimLookProblems(recording: Recording): string[] {
  const intents = claimIntents(recording)
  return recording.stripeCalls
    .filter((call) => isClaimLook(call, intents))
    .filter((call) => Object.keys((call.params ?? {}) as object).sort().join(',') !== 'limit,payment_intent')
    .map((call) => JSON.stringify(call))
}

/**
 * A recording as the order refund replay compares it: each side's own machinery rows set aside (the old notes, the
 * Worker's claims and action rows: orderRefundAuditRows), the audit rows' own labels left out (they shift when rows
 * are set aside); the stored answers set aside (api_idempotency: only the new side has them); on the new side,
 * reconcile's looks for a held claim set aside; store credit notes' random refs unnumbered, and the remaining gone ids
 * renumbered by where they are first met. Everything else is compared exactly, and what was set aside is checked on
 * its own (orderRefundRowProblems, orderRefundStoredAnswerProblems, orderClaimLookProblems).
 */
export function comparableOrderRefund(recording: Recording, side: 'golden' | 'new'): Recording {
  const aside = new Set(orderRefundAuditRows(recording, side))
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
  const text = JSON.stringify({ ...recording, stripeCalls, tables }).replace(/\[ref gone#\d+\]/g, '[ref gone]')
  return withCanonicalGoneNumbers(JSON.parse(text) as Recording)
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const sameKeys = (details: Record<string, unknown> | null | undefined, keys: readonly string[]): boolean => JSON.stringify(Object.keys(details ?? {}).sort()) === JSON.stringify([...keys].sort())

/**
 * What each of the Worker's own rows must say, exactly (the fields, and the sums between them). Answers the problems
 * found, empty when every row is right.
 */
export function orderRefundRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const all = auditRows(recording)
  for (const row of orderRefundAuditRows(recording, 'new')) {
    const d = row.details ?? {}
    const n = (key: string) => Number(d[key])
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    if (row.action === 'order.refund_claimed') {
      const plan = (d['plan'] ?? {}) as { card?: Array<{ orderId?: unknown; paymentIntentId?: unknown; amount: number; lines?: Array<{ lineId?: unknown; amount: number }> }>; storeCredit?: number; cash?: number; ownOrderId?: unknown }
      const cash = Number(plan.cash ?? 0) > 0
      const refund = d['kind'] === 'refund'
      if (!sameKeys(d, ['kind', 'amount', 'method', 'reason', 'worker', 'plan', 'livemode', ...(cash ? ['handedOverBy'] : []), ...(refund ? ['lines'] : [])])) wrong('fields')
      if (!['refund', 'refund_owed'].includes(String(d['kind'])) || d['worker'] !== true || d['reason'] !== null) wrong('kind')
      if (!['card', 'credit', 'cash'].includes(String(d['method']))) wrong('method')
      const parts = plan.card ?? []
      // One card part at most, on the claim's own order, its lines adding up to it.
      if (parts.length > 1) wrong('more than one card part')
      const part = parts[0]
      if (part && (part.orderId !== row['entity_id'] || typeof part.paymentIntentId !== 'string' || round2((part.lines ?? []).reduce((total, line) => total + line.amount, 0)) !== part.amount)) wrong('the card part')
      if (round2((part?.amount ?? 0) + Number(plan.storeCredit) + Number(plan.cash)) !== n('amount')) wrong('the plan is not what was claimed')
      if (part && d['method'] !== 'card') wrong('a card part only for the card')
      if (cash && (d['method'] !== 'cash' || part)) wrong('cash only for cash, never beside a card part')
      if ((part !== undefined) !== (typeof d['livemode'] === 'boolean')) wrong("the key's mode exactly with a card part")
      if (plan.ownOrderId !== row['entity_id']) wrong("the store credit's order")
      if (refund) {
        const lines = Array.isArray(d['lines']) ? (d['lines'] as Array<Record<string, unknown>>) : []
        if (lines.length === 0 || round2(lines.reduce((total, line) => total + Number(line['amount']), 0)) !== n('amount')) wrong("the lines are not what was claimed")
        for (const line of lines) {
          const extra = Object.keys(line).filter((key) => !['id', 'itemType', 'amount', 'method', 'restocked', 'giftCardId', 'pass', 'restock', 'membership'].includes(key))
          if (extra.length > 0 || !['card', 'credit', 'cash'].includes(String(line['method']))) wrong('a line')
          if ((line['itemType'] === 'product') !== (typeof line['restocked'] === 'boolean')) wrong('a restock decision exactly on a product line')
          if ((line['restock'] !== undefined) !== (line['restocked'] === true)) wrong('a restock recorded exactly when restocked')
          // W29: a membership's record only on a membership line, with everything the undo and the cancel need.
          const membership = line['membership'] as Record<string, unknown> | undefined
          if (membership !== undefined) {
            if (line['itemType'] !== 'membership') wrong('a membership recorded on a line that is not one')
            if (!sameKeys(membership, ['id', 'subscriptionId', 'status', 'addonCredits', 'cancelEffectiveDate', 'flaggedBookingIds']) || !Array.isArray(membership['flaggedBookingIds'])) wrong("a membership's record")
          }
        }
      }
      if (row['entity_type'] !== 'order' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'order.refund_finished') {
      const claim = all.find((other) => other['id'] === d['claimId'])
      const c = (claim?.details ?? {}) as Record<string, unknown>
      if (!sameKeys(d, ['claimId', 'outcome', 'cardRefunded', 'storeCreditRefunded', 'owed', ...('cash' in d ? ['cash'] : []), ...('refused' in d ? ['refused'] : []), ...('refunds' in d ? ['refunds'] : []), ...('by' in d ? ['by'] : [])])) wrong('fields')
      // W32: the card refunds' ids and statuses, kept for the refund watch (refunds-kept.ts).
      const kept = refundsKeptProblem(d, c)
      if (kept) wrong(kept)
      if (claim?.action !== 'order.refund_claimed') wrong('no claim')
      if ('refused' in d && (typeof d['refused'] !== 'string' || d['refused'] === '' || d['outcome'] !== 'owed')) wrong('refused without money owed')
      const accounted = round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed') + Number(d['cash'] ?? 0))
      if (d['outcome'] === 'put_back') {
        if (accounted !== 0) wrong('a put-back moves nothing')
      } else if (c['kind'] === 'refund_owed' && d['outcome'] === 'owed' && n('cardRefunded') === 0 && n('storeCreditRefunded') === 0 && !('by' in d) && !('refused' in d)) {
        // Refund the rest's undo: the money is owed again.
        if (n('owed') !== Number(c['amount'])) wrong('an undone Refund the rest owes what it claimed')
      } else if (accounted !== Number(c['amount'])) wrong('what went, to store credit, in cash and owed is not what was claimed')
      if (d['outcome'] !== 'put_back' && (d['outcome'] === 'owed') !== n('owed') > 0) wrong('owed exactly when something is')
      // Only the plan's own store credit is ever given: card money that never went is owed, never store credit on top.
      const planned = Number(((c['plan'] ?? {}) as { storeCredit?: number }).storeCredit ?? 0)
      const undone = d['outcome'] === 'put_back' || (c['kind'] === 'refund_owed' && n('storeCreditRefunded') === 0 && n('cardRefunded') === 0 && d['outcome'] === 'owed' && !('by' in d) && !('refused' in d))
      if (!undone && n('storeCreditRefunded') !== round2(planned)) wrong("store credit given is not the plan's own")
      if (row['entity_type'] !== 'order' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'order.refund_refused') {
      const claim = all.find((other) => other['id'] === d['claimId'])
      const plan = ((claim?.details ?? {})['plan'] ?? {}) as { card?: Array<{ orderId?: string; amount: number }> }
      if (!sameKeys(d, ['claimId', 'orderId', 'amount', 'detail'])) wrong('fields')
      if (claim?.details?.['worker'] !== true || !(plan.card ?? []).some((part) => part.orderId === d['orderId'] && part.amount === n('amount'))) wrong('not the card part of a Worker claim')
      if (typeof d['detail'] !== 'string' || !d['detail'].startsWith('Failed to refund payment: ')) wrong("Stripe's reason")
      const finished = all.find((other) => other.action === 'order.refund_finished' && other.details?.['claimId'] === d['claimId'])
      if (finished && finished.details?.['outcome'] !== 'put_back' && !(Number(finished.details?.['owed']) >= n('amount'))) wrong('a refused part that did not end owed')
      if (row['entity_type'] !== 'order' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'order.refund') {
      const cash = 'cashRefunded' in d
      if (!sameKeys(d, ['lineItemIds', 'restocked', 'amount', 'method', 'cardRefunded', 'storeCreditRefunded', 'owed', ...(cash ? ['cashRefunded', 'handedOverBy'] : [])])) wrong('fields')
      if (round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed') + Number(d['cashRefunded'] ?? 0)) !== n('amount')) wrong('the parts are not the amount')
      if (!Array.isArray(d['lineItemIds']) || (d['lineItemIds'] as unknown[]).length === 0 || !Array.isArray(d['restocked'])) wrong('the lines')
      if (row['entity_type'] !== 'order' || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'order.refund_owed') {
      const cash = 'cashRefunded' in d
      if (!sameKeys(d, ['amount', 'method', 'cardRefunded', 'storeCreditRefunded', 'owed', ...(cash ? ['cashRefunded', 'handedOverBy'] : [])])) wrong('fields')
      if (round2(n('cardRefunded') + n('storeCreditRefunded') + n('owed') + Number(d['cashRefunded'] ?? 0)) !== n('amount')) wrong('the parts are not the amount')
    } else if (row.action === 'order.subscription_left') {
      // W29: only ever for a subscription a finished refund claim's membership line names; `left` with R2, `cancelled` after.
      const claim = all.find((other) => other['id'] === d['claimId'])
      const lines = ((claim?.details ?? {})['lines'] ?? []) as Array<{ membership?: { subscriptionId?: unknown } }>
      const left = d['state'] === 'left'
      if (!sameKeys(d, ['state', 'subscriptionId', 'invoicePaymentIntentId', 'amountPaid', 'found', 'claimId', 'refunded', ...(left ? ['left'] : [])])) wrong('fields')
      if (!left && d['state'] !== 'cancelled') wrong('a state that is neither left nor cancelled')
      if (d['found'] !== 'refund' || d['invoicePaymentIntentId'] !== null || d['amountPaid'] !== 0 || JSON.stringify(d['refunded']) !== '[]') wrong('a refund never refunds a first invoice here')
      if (claim?.action !== 'order.refund_claimed' || !lines.some((line) => line.membership?.subscriptionId === d['subscriptionId'])) wrong("not a subscription of the claim's membership line")
      const finished = all.find((other) => other.action === 'order.refund_finished' && other.details?.['claimId'] === d['claimId'])
      if (!finished || finished.details?.['outcome'] === 'put_back') wrong('a subscription left by a refund that did not stand')
      if (d['state'] === 'cancelled' && !all.some((other) => other.action === 'order.subscription_left' && other.details?.['state'] === 'left' && other.details['subscriptionId'] === d['subscriptionId'] && other.details['claimId'] === d['claimId'])) wrong('cancelled with no left row before it')
      if (row['entity_type'] !== 'order' || row['entity_id'] !== claim?.['entity_id'] || typeof row['request_id'] !== 'string') wrong('entity or request id')
    } else if (row.action === 'order.owed_arrived') {
      if (!sameKeys(d, ['amount', 'reason', 'owedBefore', 'owedAfter']) || !(n('amount') > 0) || typeof d['reason'] !== 'string' || round2(n('owedBefore') - n('amount')) !== n('owedAfter')) wrong('fields')
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
  problems.push(...refundWatchProblems(all, 'order', 'order.refund_finished'))
  return problems
}

/** The stored answers the new side wrote: each a finished press of an order refund route on the Worker. */
export function orderRefundStoredAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const route = /^POST \/api\/v1\/staff\/orders\/[^/]+\/refunds(\/owed|\/owed-arrived)?$/
  return rows.filter((row) => row['status'] !== 'done' || !route.test(String(row['endpoint']))).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}
