import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { withSwitch } from './booking-side'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'
import { replayStripe } from './stripe-binding'
import { MEMBERSHIP_KINDS_ON, W40_ACTIONS, membershipsAsTheDialogPresses } from '../sweep/membership-presses'

/*
 * W40 (F-plan 4.12 item 3; brief W40 item 9): the membership cancel's side of the replay, beside account-side.ts
 * (W37's), gift-card-side.ts (W38's) and customer-side.ts (W39's). The cancel and its undo, the Subscriptions list and
 * the customer's profile go to the staff app's thin wrappers, which call the Worker's routes, and their answers come
 * back in the old functions' shapes. Every other call (an order placed to set a scenario up, the actions later slices
 * move) still runs through the frozen copies of the old functions, so the seed state is exactly what each golden file
 * recorded.
 * A test file using this mocks @/server/db/connection to the replay database and @/server/stripe/client to the run's
 * fake (stripe-binding.ts), and sets STAFF_API_KEY, as booking-side.ts's users do.
 */

// W64: the presses moved to the sweep folder (H-plan 3.3 step 3); re-exported for the old replay's files.
export * from '../sweep/membership-presses'

export interface MembershipSideOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
  /** ORDER_SWITCH for the new side's calls (the kind on unless a test says otherwise). */
  orderSwitch?: string
}

/**
 * The new side: the cancel, its undo and the two reads through the staff app's wrappers and the Worker's routes,
 * everything else through the old functions (the frozen copies), on the same database and the same fake Stripe.
 */
export function newMembershipSide({ adjust, calls, orderSwitch = MEMBERSHIP_KINDS_ON }: MembershipSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    const press = membershipsAsTheDialogPresses()
    return {
      name: 'new',
      async call(action, params) {
        if (!W40_ACTIONS.has(action)) {
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

/** The Worker's audit rows for a cancel and its undo (F-plan 4.3, 4.11). The old code wrote none. */
export const W40_AUDIT_ROWS: ReadonlySet<string> = new Set(['membership.cancel_scheduled', 'membership.cancel_undone', 'membership.cancel_put_back', 'membership.step_left'])

const auditRows = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]
const membershipAuditRows = (recording: Recording): AuditRow[] => auditRows(recording).filter((row) => W40_AUDIT_ROWS.has(String(row.action)))
type Call = Recording['stripeCalls'][number]
const isRead = (call: Call): boolean => call.method === 'subscriptions.retrieve'

/**
 * A recording as the membership replay compares it: the Worker's own audit rows set aside (the old code wrote none),
 * the remaining audit rows' own labels left out (they shift when rows are set aside), the stored answers set aside
 * (api_idempotency: only the new side has them), and Stripe's reads set aside (the Worker reads a subscription before
 * it changes it; the old routes never read). Everything else is compared exactly, and what was set aside is checked
 * on its own (membershipRowProblems, membershipStoredAnswerProblems, stripeReadProblems).
 */
export function comparableMemberships(recording: Recording): Recording {
  const aside = new Set(membershipAuditRows(recording))
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
  return withCanonicalGoneNumbers(JSON.parse(JSON.stringify({ ...recording, tables, stripeCalls: recording.stripeCalls.filter((call) => !isRead(call)) })) as Recording)
}

/**
 * Stripe's reads and sends on the new side: every change to a subscription comes straight after a read of that same
 * subscription (read first, sent only if still needed), nothing is read but a membership's own subscription, and
 * every cancel date is sent with no proration and under a key.
 */
export function stripeReadProblems(recording: Recording): string[] {
  const problems: string[] = []
  const paramsOf = (call: Call | undefined): Record<string, unknown> => (call?.params ?? {}) as Record<string, unknown>
  recording.stripeCalls.forEach((call, index) => {
    const before = recording.stripeCalls[index - 1]
    const params = paramsOf(call)
    if (call.method === 'subscriptions.update' && (!before || !isRead(before) || paramsOf(before)['id'] !== params['id'])) problems.push(`stripeCalls[${index}]: a subscription changed without being read first`)
    if (isRead(call) && (Object.keys(params).join() !== 'id' || call.idempotencyKey !== null)) problems.push(`stripeCalls[${index}]: a read with more than the subscription's id`)
    // The old recordings hold sends with neither, so the comparison can't see one missing: checked here (W36 review L1).
    if (call.method === 'subscriptions.update' && 'cancel_at' in params) {
      if (params['proration_behavior'] !== 'none') problems.push(`stripeCalls[${index}]: a cancel date sent without proration_behavior 'none'`)
      if (typeof call.idempotencyKey !== 'string' || call.idempotencyKey === '') problems.push(`stripeCalls[${index}]: a cancel date sent with no key`)
    }
  })
  return problems
}

const sameKeys = (details: Record<string, unknown> | null | undefined, keys: readonly string[]): boolean => JSON.stringify(Object.keys(details ?? {}).sort()) === JSON.stringify([...keys].sort())
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const dayBefore = (isoDate: string): string => {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y as number, (m as number) - 1, (d as number) - 1)).toISOString().slice(0, 10)
}
/** The London date a moment (in seconds) falls on. */
const londonDate = (seconds: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(seconds * 1000))

const STEP_ENDS = ['done', 'undone', 'replaced', 'sorted']

/**
 * What each of the Worker's own audit rows must say, exactly: a `membership.cancel_scheduled` row carries the
 * cancel_at it will send, which is London midnight on its end date, the day after the last day it wrote; an undo's
 * carries none; with a subscription each has exactly one Stripe step, left in the same press, wanting that cancel_at;
 * a put-back names the step it closed; and a step is never ended twice. One row for each press answered with a
 * success or put back, and none for a refusal. Answers the problems found, empty when all is right.
 */
export function membershipRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const rows = membershipAuditRows(recording)
  const steps = rows.filter((row) => row.action === 'membership.step_left')
  const stepRows = (stepId: unknown) => steps.filter((row) => row.details?.['stepId'] === stepId)
  for (const row of rows) {
    const d = row.details ?? {}
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    const byStaff = row['actor_type'] === 'staff' && typeof row['actor_id'] === 'string' && row['actor_id'] !== '' && typeof row['request_id'] === 'string' && row['request_id'] !== ''
    if (!byStaff && !(row.action === 'membership.step_left' && row['actor_type'] === 'system')) wrong('actor or request id')
    if (row['entity_type'] !== 'membership' || typeof row['entity_id'] !== 'string' || row['entity_id'] === '') wrong('entity')
    if (row.action === 'membership.cancel_scheduled' || row.action === 'membership.cancel_undone') {
      const cancel = row.action === 'membership.cancel_scheduled'
      const dates = (d['cancelEffectiveDate'] ?? {}) as Record<string, unknown>
      if (!sameKeys(d, ['channel', 'cancelAt', 'cancelEffectiveDate', 'subscriptionId', 'stepId', ...(cancel ? ['endDate'] : [])]) || !sameKeys(dates, ['before', 'after'])) wrong('fields')
      if (d['channel'] !== 'staff') wrong('the channel')
      if (cancel) {
        if (!isDate(d['endDate']) || dates['before'] !== null || dates['after'] !== dayBefore(String(d['endDate']))) wrong('the last day is not the day before the end, from no cancel')
        // London midnight at the start of the end date: a second earlier is still the last day.
        if (!Number.isInteger(d['cancelAt']) || londonDate(Number(d['cancelAt'])) !== d['endDate'] || londonDate(Number(d['cancelAt']) - 1) !== dates['after']) wrong('cancel_at is not London midnight on the end date')
      } else if (d['cancelAt'] !== null || !isDate(dates['before']) || dates['after'] !== null) wrong('an undo clears a date that was set, and sends no cancel_at')
      const own = stepRows(d['stepId']).filter((step) => step.details?.['state'] === 'left')
      if (d['subscriptionId'] === null ? d['stepId'] !== null : own.length !== 1) wrong('its Stripe step')
      const [step] = own
      if (step && (step.details?.['kind'] !== 'cancel_at' || step.details?.['subscriptionId'] !== d['subscriptionId'] || (step.details?.['want'] as { cancelAt?: unknown } | undefined)?.cancelAt !== d['cancelAt'] || step['request_id'] !== row['request_id'])) {
        wrong('its step is not for this subscription and this cancel_at, left in the same press')
      }
    } else if (row.action === 'membership.cancel_put_back') {
      const dates = (d['cancelEffectiveDate'] ?? {}) as Record<string, unknown>
      if (!sameKeys(d, ['was', 'stripeSaid', 'stepId', 'cancelEffectiveDate', 'restored', ...('leftAgain' in d ? ['leftAgain'] : [])]) || !sameKeys(dates, ['before', 'after'])) wrong('fields')
      if (d['was'] !== 'cancel' && d['was'] !== 'undo_cancel') wrong('what was put back')
      if (typeof d['stripeSaid'] !== 'string' || d['stripeSaid'].trim() === '') wrong("Stripe's reason")
      if (typeof d['restored'] !== 'boolean') wrong('whether the date went back')
      const ends = stepRows(d['stepId']).map((step) => step.details?.['state'])
      if (!ends.includes('left') || !(ends.includes('undone') || ends.includes('replaced'))) wrong('the step it put back is not closed')
      const press = rows.find((one) => (one.action === 'membership.cancel_scheduled' || one.action === 'membership.cancel_undone') && one.details?.['stepId'] === d['stepId'])
      if (!press || (press.action === 'membership.cancel_scheduled') !== (d['was'] === 'cancel')) wrong('no press it puts back')
    } else {
      if (!['left', 'refused', 'stale_send', ...STEP_ENDS].includes(String(d['state'])) || typeof d['stepId'] !== 'string' || d['kind'] !== 'cancel_at' || typeof d['subscriptionId'] !== 'string') wrong('the step')
      const want = d['want'] as { cancelAt?: unknown } | undefined
      if (!want || !('cancelAt' in want) || !(want.cancelAt === null || Number.isInteger(want.cancelAt))) wrong('what it wants')
    }
  }
  const stepIds = [...new Set(steps.map((row) => row.details?.['stepId']))]
  for (const stepId of stepIds) {
    const states = stepRows(stepId).map((row) => String(row.details?.['state']))
    if (states.filter((state) => state === 'left').length !== 1) problems.push(`step ${String(stepId)}: ${states.filter((state) => state === 'left').length} \`left\` rows`)
    if (states.filter((state) => STEP_ENDS.includes(state)).length > 1) problems.push(`step ${String(stepId)}: ended more than once (${states.join(', ')})`)
    // W40a: or the automatic check left it again, for a step it names (`leftAgainFor`) that a press did leave.
    const standsFor = stepRows(stepId).find((row) => row.details?.['state'] === 'left')?.details?.['leftAgainFor']
    const leftByAPress = (id: unknown) => rows.some((row) => row.action !== 'membership.step_left' && (row.details?.['stepId'] === id || row.details?.['leftAgain'] === id))
    if (!leftByAPress(stepId) && !(typeof standsFor === 'string' && leftByAPress(standsFor))) problems.push(`step ${String(stepId)}: no press left it`)
  }
  // A membership's last day never moves without its row (the old recordings of FB5 hold such a write, so the
  // comparison alone could not see one come back).
  for (const changed of (recording.tables['customer_memberships']?.changed ?? []) as Row[]) {
    if (!('cancel_effective_date' in changed)) continue
    if (!rows.some((row) => row.action !== 'membership.step_left' && row['entity_id'] === changed['id'])) problems.push(`membership ${String(changed['id'])}: its last day changed with no cancel or undo row`)
  }
  // One row for each press the screen was told went through, or that Stripe refused and was put back; none otherwise.
  const answers = recording.results.filter((result): result is { updated: boolean; membership?: unknown; reason?: unknown } => result !== null && typeof result === 'object' && !Array.isArray(result) && 'updated' in result)
  const went = answers.filter((answer) => answer.updated === true && answer.membership !== undefined).length
  const refusedByStripe = answers.filter((answer) => answer.updated === false && answer.reason === 'stripe_refused').length
  const of = (action: string) => rows.filter((row) => row.action === action).length
  const recorded = of('membership.cancel_scheduled') + of('membership.cancel_undone')
  // A press whose answer was lost was still recorded, once: its second press gets the first's answer.
  const lost = answers.filter((answer) => answer.updated === false && answer.reason === 'no_answer').length
  if (recorded < went + refusedByStripe || recorded > went + refusedByStripe + lost) problems.push(`${recorded} cancel and undo rows for ${went} presses that went, ${refusedByStripe} Stripe refused and ${lost} with no answer`)
  if (of('membership.cancel_put_back') !== refusedByStripe) problems.push(`${of('membership.cancel_put_back')} put-back rows for ${refusedByStripe} presses Stripe refused`)
  return problems
}

/** The stored answers the new side wrote: each a finished press of the cancel or the undo route. */
export function membershipStoredAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const route = /^POST \/api\/v1\/staff\/memberships\/[^/]+\/(cancel|undo-cancel)$/
  return rows.filter((row) => row['status'] !== 'done' || !route.test(String(row['endpoint']))).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}
