import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { throughStaffApp } from './booking-side'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'
import { type AccountPressOptions, W37_ACTIONS, WRITES, accountAsTheScreensPress } from '../sweep/account-presses'

/*
 * W37 (F-plan 4.12 item 3): step F's side of the replay, as booking-side.ts is step D's and order-refund-side.ts step
 * E's. Each slice (W37 to W43) gives its old actions to the Worker: their params go to the staff app's thin wrappers,
 * which call the Worker's routes, and their answers come back in the old functions' shapes. Every other call (an order
 * placed to set a scenario up, the actions later slices move) still runs through the frozen copies of the old
 * functions, so the seed state is exactly what each golden file recorded.
 * A test file using this mocks @/server/db/connection to the replay database and sets STAFF_API_KEY, as
 * booking-side.ts's users do. None of W37's four actions touches Stripe or the switch.
 */

// W64: the presses moved to the sweep folder (H-plan 3.3 step 3); re-exported for the old replay's files.
export * from '../sweep/account-presses'

export interface AccountSideOptions extends AccountPressOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
}

/**
 * The new side: W37's four actions through the staff app's wrappers and the Worker's routes, everything else through
 * the old functions (the frozen copies), on the same database.
 */
export function newAccountSide({ adjust, calls, repeatedPress }: AccountSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    const press = accountAsTheScreensPress({ ...(repeatedPress !== undefined ? { repeatedPress } : {}) })
    return {
      name: 'new',
      async call(action, params) {
        if (!W37_ACTIONS.has(action)) {
          calls?.push({ action, side: 'old' })
          return old.call(action, params)
        }
        calls?.push({ action, side: 'new' })
        // The clock moves between presses, as the old side's moves with each statement (harness.ts, tick).
        vi.setSystemTime(Date.now() + 1)
        const answer = WRITES.has(action) ? await press(db, action, params) : await throughStaffApp(action)(db, params)
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}

// --- What is set aside before the two recordings are compared, and checked on its own

type AuditRow = Row & { action?: unknown; entity_type?: unknown; entity_id?: unknown; details?: Record<string, unknown> | null }

/** The Worker's audit rows for W37's three writes (F-plan 4.11). The old functions wrote none. */
export const W37_AUDIT_ROWS: ReadonlySet<string> = new Set(['membership.credits_adjusted', 'membership.herd_set', 'customer.store_credit_adjusted'])

const auditRows = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]
const accountAuditRows = (recording: Recording): AuditRow[] => auditRows(recording).filter((row) => W37_AUDIT_ROWS.has(String(row.action)))

/**
 * A recording as the account replay compares it: the Worker's own audit rows set aside (the old functions wrote none),
 * the remaining audit rows' own labels left out (they shift when rows are set aside), and the stored answers set aside
 * (api_idempotency: only the new side has them). Everything else is compared exactly, and what was set aside is
 * checked on its own (accountRowProblems, accountStoredAnswerProblems).
 */
export function comparableAccount(recording: Recording): Recording {
  const aside = new Set(accountAuditRows(recording))
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
const round2 = (n: number): number => Math.round(n * 100) / 100
const isBool = (value: unknown): boolean => typeof value === 'boolean'

/**
 * What each of the Worker's own audit rows must say, exactly, and that each change has exactly one: every adjustment
 * row written has its `membership.credits_adjusted` row (and none without), every manual store credit movement its
 * `customer.store_credit_adjusted` row, with the same figures. Answers the problems found, empty when all is right.
 */
export function accountRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const rows = accountAuditRows(recording)
  const adjustments = (recording.tables['membership_credit_adjustments']?.added ?? []) as Row[]
  const movements = ((recording.tables['store_credit_transactions']?.added ?? []) as Row[]).filter((row) => row['reason'] === 'manual_adjustment')
  for (const row of rows) {
    const d = row.details ?? {}
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    const byStaff = row['actor_type'] === 'staff' && typeof row['actor_id'] === 'string' && row['actor_id'] !== '' && typeof row['request_id'] === 'string' && row['request_id'] !== ''
    if (!byStaff) wrong('actor or request id')
    if (row.action === 'membership.credits_adjusted') {
      const session = d['creditType'] === 'session'
      if (!sameKeys(d, ['creditType', 'amount', 'reason', 'before', 'after', 'adjustmentId', ...(session ? ['periodId', 'used'] : [])])) wrong('fields')
      if (!session && d['creditType'] !== 'addon') wrong('the credit type')
      if (!Number.isInteger(d['amount']) || d['amount'] === 0) wrong('the amount')
      if (Number(d['before']) + Number(d['amount']) !== Number(d['after'])) wrong('before and the amount are not after')
      if (session ? Number(d['after']) < Number(d['used']) : Number(d['after']) < 0) wrong(session ? 'left below what is used' : 'left below zero')
      if (typeof d['reason'] !== 'string' || d['reason'].trim() === '') wrong('no reason')
      const adjustment = adjustments.find((one) => one['id'] === d['adjustmentId'])
      if (!adjustment || adjustment['amount'] !== d['amount'] || adjustment['credit_type'] !== d['creditType'] || adjustment['reason'] !== d['reason'] || adjustment['staff_id'] !== row['actor_id'] || adjustment['membership_id'] !== row['entity_id']) {
        wrong('not the adjustment row written with it')
      }
      if (row['entity_type'] !== 'membership') wrong('entity')
    } else if (row.action === 'membership.herd_set') {
      const before = (d['before'] ?? {}) as Record<string, unknown>
      const after = (d['after'] ?? {}) as Record<string, unknown>
      if (!sameKeys(d, ['herd', 'before', 'after']) || !sameKeys(before, ['isHerd', 'override']) || !sameKeys(after, ['isHerd', 'override'])) wrong('fields')
      if (!(d['herd'] === null || isBool(d['herd'])) || !isBool(before['isHerd']) || !isBool(after['isHerd'])) wrong('the values')
      // Set: the flag and the override are both what was pressed. Cleared: no override is left.
      if (d['herd'] === null ? after['override'] !== null : after['override'] !== d['herd'] || after['isHerd'] !== d['herd']) wrong('after is not what was pressed')
      if (row['entity_type'] !== 'membership' || typeof row['entity_id'] !== 'string') wrong('entity')
    } else if (row.action === 'customer.store_credit_adjusted') {
      if (!sameKeys(d, ['mode', 'amount', 'reason', 'balanceBefore', 'balanceAfter', 'transactionId'])) wrong('fields')
      const amount = Number(d['amount'])
      if (!(d['mode'] === 'add' ? amount > 0 : d['mode'] === 'remove' && amount < 0)) wrong('the mode and the sign')
      if (round2(Number(d['balanceBefore']) + amount) !== Number(d['balanceAfter']) || Number(d['balanceAfter']) < 0) wrong('the balance')
      if (typeof d['reason'] !== 'string' || d['reason'].trim().length < 5) wrong('the reason')
      const movement = movements.find((one) => one['id'] === d['transactionId'])
      if (!movement || Number(movement['amount']) !== amount || Number(movement['balance_after']) !== Number(d['balanceAfter']) || movement['note'] !== d['reason'] || movement['staff_id'] !== row['actor_id'] || movement['customer_id'] !== row['entity_id']) {
        wrong('not the store credit movement written with it')
      }
      if (row['entity_type'] !== 'customer') wrong('entity')
    }
  }
  // One audit row for each change, and no change without one (FB8, FB11: the record goes with the change or not at all).
  const of = (action: string) => rows.filter((row) => row.action === action)
  for (const adjustment of adjustments) {
    const found = of('membership.credits_adjusted').filter((row) => row.details?.['adjustmentId'] === adjustment['id']).length
    if (found !== 1) problems.push(`membership_credit_adjustments ${String(adjustment['id'])}: ${found} audit rows`)
  }
  for (const movement of movements) {
    const found = of('customer.store_credit_adjusted').filter((row) => row.details?.['transactionId'] === movement['id']).length
    if (found !== 1) problems.push(`store_credit_transactions ${String(movement['id'])}: ${found} audit rows`)
  }
  if (of('membership.credits_adjusted').length !== adjustments.length) problems.push(`membership.credits_adjusted: ${of('membership.credits_adjusted').length} rows for ${adjustments.length} adjustments`)
  if (of('customer.store_credit_adjusted').length !== movements.length) problems.push(`customer.store_credit_adjusted: ${of('customer.store_credit_adjusted').length} rows for ${movements.length} movements`)
  // Herd has no table of its own: one row for each change the screen was told went through, and none for a refusal.
  const herdAnswers = recording.results.filter((result) => {
    const answer = result as { updated?: unknown; membership?: { herd_override?: unknown } } | null
    return answer !== null && typeof answer === 'object' && !Array.isArray(answer) && answer.updated === true && answer.membership !== undefined && 'herd_override' in answer.membership
  }).length
  if (of('membership.herd_set').length !== herdAnswers) problems.push(`membership.herd_set: ${of('membership.herd_set').length} rows for ${herdAnswers} changes`)
  return problems
}

/** The stored answers the new side wrote: each a finished press of one of W37's three write routes on the Worker. */
export function accountStoredAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const route = /^POST \/api\/v1\/staff\/(memberships\/[^/]+\/(credits|herd)|customers\/[^/]+\/store-credit)$/
  return rows.filter((row) => row['status'] !== 'done' || !route.test(String(row['endpoint']))).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}
