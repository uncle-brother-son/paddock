import type { Db } from '@/server/db'
import { BOOKING_LAPSED } from '@/server/rules/bookings/cancel'
import type { LapseSweepResult } from '@/server/rules/bookings/lapse-sweep'
import { lapseSweepAsTheWorkerRunsIt, REPLAY_SWEEP_REQUEST } from '../sweep/lapse-presses'
import type { FakeStripe } from '@/server/stripe/fake'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'
import { runLapseSweep } from './scenarios'

/*
 * W43 (F-plan 4.12 items 3 and 4; brief W43 item 5): the lapse sweep's side of the replay. W36 recorded the database's
 * own sweep (lapse_sweep_expired_bookings, run as the hourly job runs it) on four seeds. Here the same seeds are swept
 * by the Worker's sweep instead (bookings/lapse-sweep.ts, the kind `lapse_sweep` on), and what it leaves is compared
 * with what the database's left. Every call a scenario makes (the old createOrder that places its booking) still runs
 * through the frozen copies, so the seed state is exactly what each golden file recorded.
 */

// W64: the Worker's sweep as the replay runs it, moved to the sweep folder (H-plan 3.3 step 3); re-exported for the old replay's files.
export { lapseSweepAsTheWorkerRunsIt, REPLAY_SWEEP_REQUEST } from '../sweep/lapse-presses'

export interface LapseSideOptions {
  /** The switch the sweep's run is handed. Default: the kind on. */
  orderSwitch?: string | null
  /** Each run's result, for tests that check what the sweep said it did. */
  runs?: LapseSweepResult[]
  /** Also run the database's own sweep, before the Worker's or after it (both in charge for a while: F-plan 4.8). */
  database?: 'first' | 'after'
}

/** The new side: the Worker's sweep where the scenario recorded the database's; everything else as recorded. */
export function newLapseSide({ orderSwitch = 'lapse_sweep', runs, database }: LapseSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    return {
      name: 'new',
      call: (action, params) => old.call(action, params),
      async lapseSweep(sweepDb) {
        if (database === 'first') await runLapseSweep(sweepDb)
        await lapseSweepAsTheWorkerRunsIt(sweepDb, { orderSwitch, ...(runs ? { runs } : {}) })
        if (database === 'after') await runLapseSweep(sweepDb)
      },
    }
  }
}

// --- What is set aside before the two recordings are compared, and checked on its own

type AuditRow = Row & { action?: unknown; actor_type?: unknown; entity_type?: unknown; entity_id?: unknown; details?: Record<string, unknown> | null }

/** The rows the Worker's sweep writes on a booking (F-plan 4.11). The database's sweep wrote none. */
export const W43_AUDIT_ROWS: ReadonlySet<string> = new Set(['booking.cancel', 'booking.cancel_credit', BOOKING_LAPSED, 'booking.refund_claimed', 'booking.refund_finished'])

const auditRows = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]
const sweepRows = (recording: Recording): AuditRow[] => auditRows(recording).filter((row) => W43_AUDIT_ROWS.has(String(row.action)) && row.actor_type === 'system')

/**
 * A recording as the lapse replay compares it: the sweep's own audit rows set aside (the database's sweep wrote none)
 * and the remaining audit rows' own labels left out (they shift when rows are set aside). Everything else is compared
 * exactly, and what was set aside is checked on its own (lapseRowProblems).
 */
export function comparableLapse(recording: Recording): Recording {
  const aside = new Set(sweepRows(recording))
  const tables = { ...recording.tables }
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
const pennies = (value: unknown): number => Math.round(Number(value) * 100)
const KEPT: ReadonlySet<unknown> = new Set(['inside_24_hours', 'session_started'])

// W43a: `refundOwed` (card refund money left owed on the cancelled booking) and `addonsKept` (paid add-ons removed with nothing back).
const LAPSED_FIELDS = ['back', 'kept', 'paymentDueBy', 'pricePaid', 'refundOwed', 'addonsKept', 'storeCreditRefunded', 'placesReleased']
const LAPSE_RECORD_FIELDS = ['back', 'kept', 'paymentDueBy']

/**
 * What the sweep's own audit rows must say, exactly, and that each lapse has exactly its rows:
 * - every one is the system's (no id) under the run's request id, on a booking;
 * - one `booking.lapsed` for each booking the recording leaves cancelled as `membership_lapsed`, and none besides,
 *   with exactly its eight fields; `kept` says why when nothing came back, and is null when it did; paid add-ons
 *   are kept (`addonsKept`) only when nothing came back;
 * - one cancel row (`booking.cancel_credit` or `booking.cancel`) beside each, carrying `channel: 'system'` and the
 *   same lapse record;
 * - a claim and its finished row only where store credit was given, never with a card part, and the store credit the
 *   lapsed rows name is exactly the store credit rows the recording added.
 * Answers the problems found, empty when all is right.
 */
export function lapseRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const rows = sweepRows(recording)
  const of = (action: string, bookingId?: unknown) => rows.filter((row) => row.action === action && (bookingId === undefined || row.entity_id === bookingId))
  for (const row of rows) {
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(row.details ?? {})})`)
    if (row['actor_id'] !== null || row['request_id'] !== REPLAY_SWEEP_REQUEST) wrong('actor or request id')
    if (row.entity_type !== 'booking' || typeof row.entity_id !== 'string' || row.entity_id === '') wrong('entity')
  }
  const bookings = [...(recording.tables['bookings']?.added ?? []), ...(recording.tables['bookings']?.changed ?? [])] as Row[]
  const lapsedBookings = bookings.filter((booking) => {
    const status = booking['status']
    const reason = booking['cancel_reason']
    const now = (value: unknown) => (Array.isArray(value) ? value[1] : value)
    return now(status) === 'cancelled' && now(reason) === 'membership_lapsed'
  })
  if (of(BOOKING_LAPSED).length !== lapsedBookings.length) problems.push(`${of(BOOKING_LAPSED).length} booking.lapsed rows for ${lapsedBookings.length} bookings cancelled as membership_lapsed`)
  let given = 0
  for (const row of of(BOOKING_LAPSED)) {
    const d = row.details ?? {}
    const wrong = (why: string) => problems.push(`${BOOKING_LAPSED}: ${why} (${JSON.stringify(d)})`)
    if (!sameKeys(d, LAPSED_FIELDS)) wrong('fields')
    if (typeof d['back'] !== 'boolean') wrong('back')
    if (d['back'] === true ? d['kept'] !== null : !KEPT.has(d['kept'])) wrong('kept')
    if (typeof d['paymentDueBy'] !== 'string') wrong('the deadline')
    if (typeof d['pricePaid'] !== 'number' || typeof d['storeCreditRefunded'] !== 'number' || !Number.isInteger(d['placesReleased'])) wrong('the figures')
    if (typeof d['refundOwed'] !== 'number' || d['refundOwed'] < 0 || typeof d['addonsKept'] !== 'number' || d['addonsKept'] < 0) wrong('what was owed or kept')
    if (d['back'] === true && d['addonsKept'] !== 0) wrong('a paid add-on kept although everything came back')
    if (d['back'] === false && d['storeCreditRefunded'] !== 0) wrong('store credit given with nothing back')
    given += pennies(d['storeCreditRefunded'])
    if (!lapsedBookings.some((booking) => booking['id'] === row.entity_id)) wrong('no booking was lapsed with it')
    const cancels = [...of('booking.cancel_credit', row.entity_id), ...of('booking.cancel', row.entity_id)]
    if (cancels.length !== 1) wrong(`${cancels.length} cancel rows beside it`)
    for (const cancel of cancels) {
      const c = cancel.details ?? {}
      const lapse = (c['lapse'] ?? {}) as Record<string, unknown>
      if (c['channel'] !== 'system' || !sameKeys(lapse, LAPSE_RECORD_FIELDS)) wrong('the cancel row is not the system\'s, or its lapse record')
      if (LAPSE_RECORD_FIELDS.some((field) => lapse[field] !== d[field])) wrong('the cancel row\'s lapse record differs')
      if (c['cardRefunded'] !== 0 || c['owed'] !== 0) wrong('the cancel row names card money')
      if (pennies(c['storeCreditRefunded']) !== pennies(d['storeCreditRefunded']) || c['placesReleased'] !== d['placesReleased']) wrong('the cancel row and the lapsed row disagree')
    }
    const claims = of('booking.refund_claimed', row.entity_id)
    const finished = of('booking.refund_finished', row.entity_id)
    const expected = pennies(d['storeCreditRefunded']) > 0 ? 1 : 0
    if (claims.length !== expected || finished.length !== expected) wrong(`${claims.length} claims and ${finished.length} finished rows, for ${expected}`)
    for (const claim of claims) {
      const c = claim.details ?? {}
      const plan = (c['plan'] ?? {}) as Record<string, unknown>
      if (c['channel'] !== 'system' || c['method'] !== 'credit' || c['worker'] !== true || c['livemode'] !== null) wrong('the claim')
      if (!Array.isArray(plan['card']) || plan['card'].length !== 0 || pennies(plan['storeCredit']) !== pennies(d['storeCreditRefunded'])) wrong('the claim\'s plan')
      if (!finished.some((row2) => row2.details?.['claimId'] === claim['id'] && row2.details?.['outcome'] === 'given' && row2.details?.['cardRefunded'] === 0 && row2.details?.['owed'] === 0)) wrong('its finished row')
    }
  }
  for (const action of ['booking.cancel', 'booking.cancel_credit', 'booking.refund_claimed', 'booking.refund_finished']) {
    for (const row of of(action)) if (of(BOOKING_LAPSED, row.entity_id).length === 0) problems.push(`${action}: the system's row with no lapse beside it`)
  }
  const credited = ((recording.tables['store_credit_transactions']?.added ?? []) as Row[]).reduce((total, row) => total + pennies(row['amount']), 0)
  if (credited !== given) problems.push(`store credit rows of ${credited}p for ${given}p named by the lapsed rows`)
  return problems
}
