import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { withSwitch } from './booking-side'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'
import { replayStripe } from './stripe-binding'
import { PAYMENT_DATE_KINDS_ON, W41_ACTIONS, paymentDatesAsTheDialogPresses } from '../sweep/payment-date-presses'

/*
 * W41 (F-plan 4.12 item 3; brief W41 item 8): the payment date change's side of the replay, beside membership-side.ts
 * (W40's). The quote and the press go to the staff app's thin wrappers, which call the Worker's routes, and their
 * answers come back in the old functions' shapes. Every other call (an order placed to set a scenario up) still runs
 * through the frozen copies of the old functions, so the seed state is exactly what each golden file recorded.
 * A test file using this mocks @/server/db/connection to the replay database and @/server/stripe/client to the run's
 * fake (stripe-binding.ts), and sets STAFF_API_KEY, as booking-side.ts's users do.
 */

// W64: the presses moved to the sweep folder (H-plan 3.3 step 3); re-exported for the old replay's files.
export * from '../sweep/payment-date-presses'

export interface PaymentDateSideOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
  /** ORDER_SWITCH for the new side's calls (the kind on unless a test says otherwise). */
  orderSwitch?: string
}

/**
 * The new side: the quote and the press through the staff app's wrappers and the Worker's routes, everything else
 * through the old functions (the frozen copies), on the same database and the same fake Stripe.
 */
export function newPaymentDateSide({ adjust, calls, orderSwitch = PAYMENT_DATE_KINDS_ON }: PaymentDateSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    const press = paymentDatesAsTheDialogPresses()
    return {
      name: 'new',
      async call(action, params) {
        if (!W41_ACTIONS.has(action)) {
          calls?.push({ action, side: 'old' })
          return old.call(action, params)
        }
        calls?.push({ action, side: 'new' })
        // The clock moves between presses, as the old side's moves with each statement (harness.ts, tick).
        vi.setSystemTime(Date.now() + 1)
        // The route reaches this run's fake only for its own call: the old side's legacy routes keep their stand-in.
        replayStripe.current = stripe
        try {
          const answer = await withSwitch(orderSwitch, () => press(db, action, params))
          return adjust ? adjust(action, answer) : answer
        } finally {
          replayStripe.current = null
        }
      },
    }
  }
}

// --- What is set aside before the two recordings are compared, and checked on its own

type AuditRow = Row & { action?: unknown; entity_type?: unknown; entity_id?: unknown; details?: Record<string, unknown> | null }

/** The Worker's audit rows for a payment date change (F-plan 4.11), and the watch on its compensation refund (W32). The old code wrote none. */
export const W41_AUDIT_ROWS: ReadonlySet<string> = new Set(['membership.payment_date_changed', 'refund.watch'])

const auditRows = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]
const ownAuditRows = (recording: Recording): AuditRow[] => auditRows(recording).filter((row) => W41_AUDIT_ROWS.has(String(row.action)))

/**
 * A recording as the payment date replay compares it: the Worker's own audit rows set aside (the old code wrote
 * none), the remaining audit rows' own labels left out (they shift when rows are set aside), and the stored answers
 * set aside (api_idempotency: only the new side has them). Everything else is compared exactly, Stripe's calls
 * included, and what was set aside is checked on its own (paymentDateRowProblems, paymentDateStoredAnswerProblems).
 */
export function comparablePaymentDates(recording: Recording): Recording {
  const aside = new Set(ownAuditRows(recording))
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
  return withCanonicalGoneNumbers(JSON.parse(JSON.stringify({ ...recording, tables })) as Recording)
}

const sameKeys = (details: Record<string, unknown> | null | undefined, keys: readonly string[]): boolean => JSON.stringify(Object.keys(details ?? {}).sort()) === JSON.stringify([...keys].sort())

const STARTED_KEYS = ['changeId', 'state', 'channel', 'customerId', 'planId', 'subscriptionId', 'stripeCustomerId', 'paymentMethodId', 'livemode', 'oldRenewalDate', 'newRenewalDate', 'extraDays', 'amount', 'trialEnd', 'description', 'shown', 'override']
const ENDS = ['done', 'failed', 'closed']

/**
 * What each of the Worker's own audit rows must say, exactly: every change has one `started` row with everything its
 * later steps need; at most one ending (`done`, `failed`), which agrees with its record's status; a `done` row names
 * the order and the payment its record holds; a compensation refund's watch names a change that failed after a
 * `refunding` mark. And the invariants of F-plan 4.12 item 5 on the rows a scenario leaves: a charge is taken at most
 * once for one change (one PaymentIntent created per change id, however many sends), and a record that is `done` has
 * exactly one order. Answers the problems found, empty when all is right.
 */
export function paymentDateRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const rows = ownAuditRows(recording).filter((row) => row.action === 'membership.payment_date_changed')
  const watches = ownAuditRows(recording).filter((row) => row.action === 'refund.watch')
  const records = [...((recording.tables['membership_payment_date_changes']?.added ?? []) as Row[])]
  const statesOf = (changeId: unknown) => rows.filter((row) => row.details?.['changeId'] === changeId).map((row) => String(row.details?.['state']))
  for (const row of rows) {
    const d = row.details ?? {}
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    const byStaff = row['actor_type'] === 'staff' && typeof row['actor_id'] === 'string' && row['actor_id'] !== ''
    if (!byStaff && row['actor_type'] !== 'system') wrong('actor')
    if (typeof row['request_id'] !== 'string' || row['request_id'] === '') wrong('request id')
    if (row['entity_type'] !== 'membership' || typeof row['entity_id'] !== 'string' || row['entity_id'] === '') wrong('entity')
    if (typeof d['changeId'] !== 'string' || d['changeId'] === '') wrong('no change id')
    if (d['state'] === 'started') {
      if (!sameKeys(d, STARTED_KEYS)) wrong('fields')
      if (d['channel'] !== 'staff' || typeof d['amount'] !== 'number' || !(d['amount'] > 0) || !Number.isInteger(d['trialEnd']) || !Number.isInteger(d['extraDays'])) wrong('what it will charge and set')
      if (typeof d['shown'] !== 'number' || Math.round(Math.abs(d['shown'] - Number(d['amount'])) * 1000) > 5) wrong('the figure shown is not the figure charged (Q18)')
      if (typeof d['stripeCustomerId'] !== 'string' || typeof d['paymentMethodId'] !== 'string' || typeof d['subscriptionId'] !== 'string') wrong('what Stripe needs')
    } else if (d['state'] === 'done') {
      if (!sameKeys(d, ['changeId', 'state', 'how', 'paymentIntentId', 'orderId', 'amount', 'nextRenewalDate'])) wrong('fields')
    } else if (d['state'] === 'failed') {
      if (typeof d['message'] !== 'string' || d['message'] === '' || !['subscription', 'charge', 'move', 'reconcile'].includes(String(d['at']))) wrong('how it failed')
    } else if (d['state'] === 'held') {
      if (typeof d['reason'] !== 'string' || d['reason'] === '') wrong('what it is waiting on')
    } else if (d['state'] === 'refunding') {
      if (typeof d['paymentIntentId'] !== 'string' || typeof d['stripeSaid'] !== 'string') wrong('what is being refunded and why')
    } else if (d['state'] !== 'closed') wrong('the state')
  }
  const changeIds = [...new Set(rows.map((row) => row.details?.['changeId']))]
  for (const changeId of changeIds) {
    const states = statesOf(changeId)
    if (states.filter((state) => state === 'started').length !== 1) problems.push(`change ${String(changeId)}: ${states.filter((state) => state === 'started').length} \`started\` rows`)
    if (states.filter((state) => ENDS.includes(state)).length > 1) problems.push(`change ${String(changeId)}: ended more than once (${states.join(', ')})`)
    const record = records.find((one) => one['id'] === changeId)
    if (!record) {
      problems.push(`change ${String(changeId)}: audit rows with no record`)
      continue
    }
    const ending = states.find((state) => ENDS.includes(state))
    const expected = ending === 'done' ? 'done' : ending === undefined ? 'pending' : 'failed'
    if (record['status'] !== expected) problems.push(`change ${String(changeId)}: its record is ${String(record['status'])}, its rows say ${expected} (${states.join(', ')})`)
    const done = rows.find((row) => row.details?.['changeId'] === changeId && row.details?.['state'] === 'done')
    if (done && (done.details?.['orderId'] !== record['order_id'] || done.details?.['paymentIntentId'] !== record['stripe_payment_intent_id'])) problems.push(`change ${String(changeId)}: its done row doesn't name its record's order and payment`)
    // The invariant: one charge for one change, however many sends.
    const charges = recording.stripeCalls.filter((call) => call.method === 'paymentIntents.create' && ((call.params as { metadata?: Record<string, unknown> } | null)?.metadata ?? {})['change_id'] === changeId)
    if (new Set(charges.map((call) => call.idempotencyKey)).size > 1 || charges.some((call) => call.idempotencyKey !== `${String(changeId)}:charge`)) problems.push(`change ${String(changeId)}: its charge was sent under more than one key, or not its own`)
  }
  // A record the Worker wrote always has its `started` row; a `done` record has exactly one order, for its payment.
  const orders = (recording.tables['orders']?.added ?? []) as Row[]
  for (const record of records) {
    if (record['status'] === 'done') {
      const own = orders.filter((order) => order['id'] === record['order_id'])
      if (own.length !== 1 || own[0]?.['stripe_payment_intent_id'] !== record['stripe_payment_intent_id'] || own[0]?.['payment_status'] !== 'paid') problems.push(`record ${String(record['id'])}: done without its one paid order`)
    } else if (record['order_id'] !== null) problems.push(`record ${String(record['id'])}: ${String(record['status'])} with an order`)
  }
  // Every charge the new side sent names a change; none is sent with no key (the old recordings hold charges with neither).
  for (const [index, call] of recording.stripeCalls.entries()) {
    if (call.method !== 'paymentIntents.create' && call.method !== 'refunds.create' && call.method !== 'subscriptions.update') continue
    const params = (call.params ?? {}) as { metadata?: Record<string, unknown>; trial_end?: unknown; proration_behavior?: unknown; description?: unknown }
    const isChange = (typeof params.description === 'string' && params.description.startsWith('Payment date change')) || 'trial_end' in params || params.metadata?.['reason'] === 'payment_date_not_moved'
    if (!isChange) continue
    if (typeof call.idempotencyKey !== 'string' || !/^(membership_payment_date_changes#\d+|[0-9a-f-]{36}):(charge|move|refund)(:.+)?$/.test(call.idempotencyKey)) problems.push(`stripeCalls[${index}]: ${call.method} with no key from its record`)
    if ('trial_end' in params && params.proration_behavior !== 'none') problems.push(`stripeCalls[${index}]: the date moved without proration_behavior 'none'`)
    if (call.method !== 'subscriptions.update' && typeof params.metadata?.['change_id'] !== 'string') problems.push(`stripeCalls[${index}]: ${call.method} doesn't name its change`)
  }
  for (const watch of watches) {
    const d = watch.details ?? {}
    if (d['state'] !== 'watching') continue
    const states = statesOf(d['subjectId'])
    if (d['on'] !== 'compensation' || d['step'] !== 'payment-date-refund' || !states.includes('refunding') || !states.includes('failed')) problems.push(`refund.watch: not a failed change's compensation refund (${JSON.stringify(d)})`)
  }
  const refunds = recording.stripeCalls.filter((call) => call.method === 'refunds.create')
  if (watches.filter((watch) => watch.details?.['state'] === 'watching').length > refunds.length) problems.push('more refunds watched than were sent')
  return problems
}

/** The stored answers the new side wrote: each a finished press of the payment date route. */
export function paymentDateStoredAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const route = /^POST \/api\/v1\/staff\/memberships\/[^/]+\/payment-date$/
  return rows.filter((row) => row['status'] !== 'done' || !route.test(String(row['endpoint']))).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}
