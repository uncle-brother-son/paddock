import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { throughStaffApp } from './booking-side'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'

/*
 * W39 (F-plan 4.12 item 3; brief W39 item 5): the customer actions' side of the replay, beside account-side.ts (W37's)
 * and gift-card-side.ts (W38's). createCustomer, getCustomers and getCustomerDetail go to the staff app's thin
 * wrappers, which call the Worker's routes, and their answers come back in the old functions' shapes. Every other call
 * (an order placed to set a scenario up, the actions later slices move) still runs through the frozen copies of the
 * old functions, so the seed state is exactly what each golden file recorded.
 * A test file using this mocks @/server/db/connection to the replay database and sets STAFF_API_KEY. None of the
 * three touches Stripe or the switch.
 */

/** The old customer actions W39 gives to the Worker. */
export const W39_ACTIONS: ReadonlySet<string> = new Set(['createCustomer', 'getCustomers', 'getCustomerDetail'])

/**
 * The reads earlier slices gave to the Worker (W37's credit history, W38's two gift card reads). FB16's recording
 * calls them beside W39's two, so its replay sends all five through the staff app's wrappers.
 */
export const READS_ALREADY_SWITCHED: ReadonlySet<string> = new Set(['getGiftCards', 'getGiftCardRedemptions', 'getMembershipCreditAdjustments'])

type CreateAnswer = { created?: boolean; reason?: string; message?: string; noAnswer?: boolean } | null

/**
 * Create as the New Customer dialog presses it (NewCustomerDialog): each press has a key; a press that got no answer
 * keeps it for the next press; any other answer starts a new one. The wrapper answers a refusal as data
 * (`created: false`, so the dialog can tell it from no answer); the dialog shows its words where it showed the old
 * function's thrown error, so the replay reads it as that throw.
 */
export function createAsTheDialogPresses(): (db: Db, params: unknown) => Promise<unknown> {
  let held: string | null = null
  return async (db, params) => {
    const idempotencyKey = held ?? crypto.randomUUID()
    const answer = (await throughStaffApp('createCustomer')(db, { ...(params as object), idempotencyKey })) as CreateAnswer
    held = answer?.noAnswer ? idempotencyKey : null
    if (answer && answer.created === false) throw new Error(String(answer.message))
    return answer
  }
}

export interface CustomerSideOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
  /**
   * FB16's recording: every read in one scenario, made with `call`, which stops at the first throw. The reads the
   * Worker now refuses answer `{ thrown }` instead, so the scenario runs on to the reads later slices still move.
   */
  refusedReadsAsAnswers?: boolean
}

/**
 * The new side: the three customer actions through the staff app's wrappers and the Worker's routes, everything else
 * through the old functions (the frozen copies), on the same database.
 */
export function newCustomerSide({ adjust, calls, refusedReadsAsAnswers }: CustomerSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    const create = createAsTheDialogPresses()
    return {
      name: 'new',
      async call(action, params) {
        const switched = W39_ACTIONS.has(action) || (refusedReadsAsAnswers === true && READS_ALREADY_SWITCHED.has(action))
        if (!switched) {
          calls?.push({ action, side: 'old' })
          return old.call(action, params)
        }
        calls?.push({ action, side: 'new' })
        // The clock moves between presses, as the old side's moves with each statement (harness.ts, tick).
        vi.setSystemTime(Date.now() + 1)
        let answer: unknown
        try {
          answer = action === 'createCustomer' ? await create(db, params) : await throughStaffApp(action)(db, params)
        } catch (err) {
          if (!refusedReadsAsAnswers || action === 'createCustomer') throw err
          answer = { thrown: err instanceof Error ? err.message : String(err) }
        }
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}

// --- What is set aside before the two recordings are compared, and checked on its own

type AuditRow = Row & { action?: unknown; entity_type?: unknown; entity_id?: unknown; details?: Record<string, unknown> | null }

/** The Worker's audit row for W39's one write (F-plan 4.11). The old function wrote none. */
export const W39_AUDIT_ROWS: ReadonlySet<string> = new Set(['customer.created'])

const auditRows = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]
const customerAuditRows = (recording: Recording): AuditRow[] => auditRows(recording).filter((row) => W39_AUDIT_ROWS.has(String(row.action)))

/**
 * A recording as the customer replay compares it: the Worker's own audit rows set aside (the old function wrote
 * none), the remaining audit rows' own labels left out (they shift when rows are set aside), and the stored answers
 * set aside (api_idempotency: only the new side has them). Everything else is compared exactly, and what was set
 * aside is checked on its own (customerRowProblems, customerStoredAnswerProblems).
 */
export function comparableCustomers(recording: Recording): Recording {
  const aside = new Set(customerAuditRows(recording))
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

const CREATE_ROUTE = 'POST /api/v1/staff/customers'

/**
 * What each `customer.created` row must say, exactly, and that each customer the route made has exactly one: who (a
 * staff member), the channel, and the customer it is for, which must be a customer this recording added. One row for
 * each press answered with a success, and none for a refusal. A customer another writer added (a scenario's own
 * insert) has none. Answers the problems found, empty when all is right.
 */
export function customerRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const rows = customerAuditRows(recording)
  const stored = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const added = (recording.tables['customers']?.added ?? []) as Row[]
  for (const row of rows) {
    const d = row.details ?? {}
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    const byStaff = row['actor_type'] === 'staff' && typeof row['actor_id'] === 'string' && row['actor_id'] !== '' && typeof row['request_id'] === 'string' && row['request_id'] !== ''
    if (!byStaff) wrong('actor or request id')
    if (JSON.stringify(d) !== JSON.stringify({ channel: 'staff' })) wrong('fields')
    if (row['entity_type'] !== 'customer' || !added.some((customer) => customer['id'] === row['entity_id'])) wrong('not a customer made here')
    if (rows.filter((other) => other['entity_id'] === row['entity_id']).length !== 1) wrong('more than one row for the customer')
  }
  const presses = stored.filter((row) => row['endpoint'] === CREATE_ROUTE && row['http_status'] === 200).length
  if (rows.length !== presses) problems.push(`customer.created: ${rows.length} rows for ${presses} presses answered with a success`)
  // Every customer the old shape answered with (a row with an id and an email, not a refusal) was written, and has its audit row.
  for (const result of recording.results) {
    const answer = result as { id?: unknown; email?: unknown; first_name?: unknown } | null
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.id !== 'string' || typeof answer.email !== 'string' || typeof answer.first_name !== 'string') continue
    if (!added.some((customer) => customer['id'] === answer.id)) problems.push(`customer ${answer.id}: answered as created, but no such customer was written`)
    else if (!rows.some((row) => row['entity_id'] === answer.id)) problems.push(`customer ${answer.id}: created with no audit row`)
  }
  return problems
}

/** The stored answers the new side wrote: each a finished press of W39's one write route on the Worker. */
export function customerStoredAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  return rows.filter((row) => row['status'] !== 'done' || row['endpoint'] !== CREATE_ROUTE).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}
