import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { throughStaffApp, withSwitch } from './booking-side'
import { replayStripe } from './stripe-binding'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'
import { type AnsweredPaidBy, type AnsweredPlanExtra, type AnsweredRefundOpen, type AnsweredStamp, CREATES, PLAN_KIND_ON, READS, STEP_G_ACTIONS_MOVED, W57_WRITES, asTheScreenPresses, createAsTheDialogPresses, runNightlyJobAsNow, sessionsOf, withTheCountsShown, withTheFiguresShown, withoutPaidByLabel, withoutPlanExtras, withoutRefundOpen, withoutStamps } from '../sweep/admin-presses'

/*
 * W49 + W54 (G-plan 4.9 item 3; brief "Parity and tests"): step G's side of the replay. The old step G functions a
 * slice has moved go to the staff app's thin wrappers, which call the Worker's routes, and their answers come back
 * in the old functions' shapes. Every other call (an order placed to set a scenario up, the functions later slices
 * move) still runs through the frozen copies of the old functions (legacy-admin and the earlier copies), so the seed
 * state is exactly what each golden file recorded.
 *
 * A later slice adds its functions to STEP_G_ACTIONS_MOVED, its audit actions to STEP_G_AUDIT_ROWS and its write
 * routes to STEP_G_WRITE_ROUTES, and replays its own families through newAdminSide.
 * A test file using this mocks @/server/db/connection to the replay database and sets STAFF_API_KEY, as the earlier
 * sides' users do. None of W49's or W54's actions touches Stripe or a switch kind.
 */

// W64: the presses moved to the sweep folder (H-plan 3.3 step 3); re-exported for the old replay's files.
export * from '../sweep/admin-presses'

export interface AdminSideOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
  /** W54a: every stamp set aside from an answer, for the test to check on its own (answeredStampProblems). */
  stamps?: AnsweredStamp[]
  /** W54a: a press exactly as the golden file has it, with no stamp read first: how a test shows what the stamp is for. */
  pressWithoutReading?: boolean
  /**
   * GB14's recording: every read in one scenario, made with `call`, which stops at the first throw. The reads the
   * Worker now refuses answer `{ thrown }` instead, so the scenario runs on to the reads later slices still move.
   */
  refusedReadsAsAnswers?: boolean
  /**
   * W55 + W56: a recording whose press the old code let through and the Worker now refuses (GB10, GB12, GB21, GB23),
   * made with `call`, which stops at the first throw. The refusal answers `{ thrown }`, as `attempt` keeps one (what
   * staff are shown), so the recording runs on and each refusal is pinned to its words.
   */
  refusedPressesAsAnswers?: boolean
  /** W51: every `madeUpTo` the calendar read answered beside its sessions, set aside for the test to check on its own. */
  madeUpTo?: unknown[]
  /** W51: a press exactly as the golden file has it, with no quote read first: how a test shows what the figures are for. */
  pressWithoutFigures?: boolean
  /** W52: every `refund_open` the attendee list answered beside a booking, set aside for the test to check on its own. */
  refundOpen?: AnsweredRefundOpen[]
  /** W53: every `payment_method_label` the order list answered beside an order, set aside for the test to check on its own. */
  paidBy?: AnsweredPaidBy[]
  /** W57: what the plan answers carry beside the old rows (stamps, counts, a price change's outcome), set aside for the test. */
  planExtras?: AnsweredPlanExtra[]
  /** W57: a press exactly as the golden file has it, with no count read first: how a test shows what the count is for. */
  pressWithoutCounts?: boolean
}

/**
 * The new side: the moved step G functions through the staff app's wrappers and the Worker's routes, everything
 * else through the old functions (the frozen copies), on the same database. A switch or a setting sends no key of
 * its own: each wrapper makes one for its call (lead call L12). W54a: an edit that sends a whole row back is
 * pressed with the stamp its screen's read gave just before (asTheScreenPresses), and the stamps in the answers are
 * set aside (withoutStamps).
 */
export function newAdminSide({ adjust, calls, refusedReadsAsAnswers, refusedPressesAsAnswers, stamps, pressWithoutReading, madeUpTo, pressWithoutFigures, refundOpen, paidBy, planExtras, pressWithoutCounts }: AdminSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    // W57: the plan writes reach Stripe: through this replay's fake.
    replayStripe.current = stripe
    const creates = new Map([...CREATES].map((action) => [action, createAsTheDialogPresses(action)] as const))
    return {
      name: 'new',
      // W51 (migration 032): where a scenario recorded the database's nightly job, this side runs the job as it is now.
      nightlyJob: runNightlyJobAsNow,
      async call(action, params) {
        if (!STEP_G_ACTIONS_MOVED.has(action)) {
          calls?.push({ action, side: 'old' })
          return old.call(action, params)
        }
        calls?.push({ action, side: 'new' })
        // The clock moves between presses, as the old side's moves with each statement (harness.ts, tick).
        vi.setSystemTime(Date.now() + 1)
        let answer: unknown
        try {
          const stamped = pressWithoutReading ? params : await asTheScreenPresses(action, db, params)
          const figured = pressWithoutFigures ? stamped : await withTheFiguresShown(action, db, stamped)
          const sent = pressWithoutCounts ? figured : await withTheCountsShown(action, db, figured)
          const press = () => (creates.get(action) ?? throughStaffApp(action))(db, sent)
          // W57: a plan write (and updateCatalogItemPrice, whose plan branch is one) with `plan_changes` on, as live.
          answer = W57_WRITES.has(action) || action === 'updateCatalogItemPrice' ? await withSwitch(PLAN_KIND_ON, press) : await press()
        } catch (err) {
          if (!(refusedReadsAsAnswers && READS.has(action)) && !(refusedPressesAsAnswers && !READS.has(action))) throw err
          answer = { thrown: err instanceof Error ? err.message : String(err) }
        }
        answer = withoutPlanExtras(action, withoutPaidByLabel(action, withoutRefundOpen(action, sessionsOf(action, withoutStamps(action, answer, stamps), madeUpTo), refundOpen), paidBy), planExtras)
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}

// --- What is set aside before the two recordings are compared, and checked on its own

type AuditRow = Row & { action?: unknown; entity_type?: unknown; entity_id?: unknown; details?: Record<string, unknown> | null }

/** The Worker's audit rows for the step G writes moved so far (G-plan 4.6). The old functions wrote none. */
export const STEP_G_AUDIT_ROWS: ReadonlySet<string> = new Set([
  'staff.created',
  'staff.role_set',
  'staff.permission_set',
  'pricing.band_price_set',
  'pricing.band_rules_set',
  'pricing.member_term_set',
  'postage.set',
  'promo.created',
  'promo.updated',
  // W50: the three flags (check-in writes one of two, by which way it was pressed).
  'booking.checked_in',
  'booking.check_in_undone',
  'booking.guest_waiver_set',
  'booking.addon_prepared_set',
  // W51: sessions and the timetable.
  'session.blocked',
  'session.unblocked',
  'session.band_set',
  'session.band_reset',
  'session.start_time_set',
  'session.created',
  'timetable.slot_added',
  'timetable.slot_removed',
  // W52: events (the two catalogue writes, and the three event-day flags).
  'event.details_set',
  'event.active_set',
  'event_attendee.checked_in',
  'event_attendee.check_in_undone',
  'event_attendee.waiver_set',
  // W53: the fulfilled tick.
  'order_line.fulfilled_set',
  // W55 + W56: the catalogue.
  'catalog.active_set',
  'catalog.price_set',
  'catalog.details_set',
  'catalog.tier_created',
  'catalog.tier_range_set',
  'catalog.variant_created',
  'catalog.preset_created',
  'stock.adjusted',
])

/** W52: the three event-day flags' rows. */
export const W52_FLAG_ROWS: ReadonlySet<string> = new Set(['event_attendee.checked_in', 'event_attendee.check_in_undone', 'event_attendee.waiver_set'])

/**
 * W50: the audit rows of a flag (admin/flag.ts): who, the flag as it now is (`after`) and the call's key. A flag is
 * one guarded statement, so it reads no row first and keeps no `before`.
 */
export const STEP_G_FLAG_ROWS: ReadonlySet<string> = new Set(['booking.checked_in', 'booking.check_in_undone', 'booking.guest_waiver_set', 'booking.addon_prepared_set', ...W52_FLAG_ROWS, 'order_line.fulfilled_set'])

/** W55 + W56: each item kind's folder and its audit rows' entity type; the folders whose items have a price route. */
const CATALOG_KINDS: ReadonlyArray<readonly [string, string]> = [
  ['products', 'product'],
  ['addons', 'addon'],
  ['service-types', 'service_type'],
  ['session-pass-types', 'session_pass_type'],
  ['gift-card-types', 'gift_card_type'],
  ['gift-card-presets', 'gift_card_preset'],
]
const PRICED_FOLDERS: ReadonlySet<string> = new Set(['products', 'addons', 'service-types', 'session-pass-types'])

/**
 * Each moved write route, and the one audit action a press of it answered with a success writes. W50: `also` names a
 * second action the same route writes instead (Check In's undo), so the route's presses are counted against both.
 * W51: two routes may write one action for different things (a block of one session, and of a day), so a route's
 * rows are the ones with its action AND its entity type.
 */
export const STEP_G_WRITE_ROUTES: ReadonlyArray<{ route: RegExp; action: string; entityType: string; also?: readonly string[]; oneRowFor?: 'each_attendee_checked_in' }> = [
  // W52: events. Check-in is one press for one attendee or many: it writes one row for EACH attendee it checked in
  // (`oneRowFor`), and none for an attendee it refused.
  { route: /^POST \/api\/v1\/staff\/catalog\/events\/[^/]+\/details$/, action: 'event.details_set', entityType: 'event' },
  { route: /^POST \/api\/v1\/staff\/catalog\/events\/[^/]+\/active$/, action: 'event.active_set', entityType: 'event' },
  { route: /^POST \/api\/v1\/staff\/events\/attendees\/check-in$/, action: 'event_attendee.checked_in', entityType: 'event_attendee', oneRowFor: 'each_attendee_checked_in' },
  { route: /^POST \/api\/v1\/staff\/events\/attendees\/[^/]+\/check-in\/undo$/, action: 'event_attendee.check_in_undone', entityType: 'event_attendee' },
  { route: /^POST \/api\/v1\/staff\/events\/attendees\/[^/]+\/waiver$/, action: 'event_attendee.waiver_set', entityType: 'event_attendee' },
  // W53: the fulfilled tick, on and off.
  { route: /^POST \/api\/v1\/staff\/orders\/lines\/[^/]+\/fulfilled$/, action: 'order_line.fulfilled_set', entityType: 'order_line_item' },
  { route: /^POST \/api\/v1\/staff\/bookings\/[^/]+\/check-in$/, action: 'booking.checked_in', entityType: 'booking', also: ['booking.check_in_undone'] },
  { route: /^POST \/api\/v1\/staff\/bookings\/guests\/[^/]+\/waiver$/, action: 'booking.guest_waiver_set', entityType: 'booking_guest' },
  { route: /^POST \/api\/v1\/staff\/bookings\/addon-lines\/[^/]+\/prepared$/, action: 'booking.addon_prepared_set', entityType: 'addon_order_line' },
  { route: /^POST \/api\/v1\/staff\/staff$/, action: 'staff.created', entityType: 'staff' },
  { route: /^POST \/api\/v1\/staff\/staff\/[^/]+\/role$/, action: 'staff.role_set', entityType: 'staff' },
  { route: /^POST \/api\/v1\/staff\/staff\/[^/]+\/permissions$/, action: 'staff.permission_set', entityType: 'staff' },
  { route: /^POST \/api\/v1\/staff\/pricing\/bands\/[^/]+\/price$/, action: 'pricing.band_price_set', entityType: 'session_band' },
  { route: /^POST \/api\/v1\/staff\/pricing\/band-rules\/[^/]+$/, action: 'pricing.band_rules_set', entityType: 'band_rules_day' },
  { route: /^POST \/api\/v1\/staff\/pricing\/member-band-terms$/, action: 'pricing.member_term_set', entityType: 'membership_band_term' },
  { route: /^POST \/api\/v1\/staff\/postage\/settings$/, action: 'postage.set', entityType: 'postage_settings' },
  { route: /^POST \/api\/v1\/staff\/promo-codes$/, action: 'promo.created', entityType: 'promo_code' },
  { route: /^POST \/api\/v1\/staff\/promo-codes\/[^/]+$/, action: 'promo.updated', entityType: 'promo_code' },
  // W51: one session, then a day (`sessions/days/:date/...`), then the timetable.
  { route: /^POST \/api\/v1\/staff\/sessions\/(?!days\/)[^/]+\/block$/, action: 'session.blocked', entityType: 'session' },
  { route: /^POST \/api\/v1\/staff\/sessions\/(?!days\/)[^/]+\/unblock$/, action: 'session.unblocked', entityType: 'session' },
  { route: /^POST \/api\/v1\/staff\/sessions\/(?!days\/)[^/]+\/band$/, action: 'session.band_set', entityType: 'session' },
  { route: /^POST \/api\/v1\/staff\/sessions\/(?!days\/)[^/]+\/band\/reset$/, action: 'session.band_reset', entityType: 'session' },
  { route: /^POST \/api\/v1\/staff\/sessions\/(?!days\/)[^/]+\/start-time$/, action: 'session.start_time_set', entityType: 'session' },
  { route: /^POST \/api\/v1\/staff\/sessions$/, action: 'session.created', entityType: 'session' },
  { route: /^POST \/api\/v1\/staff\/sessions\/days\/[^/]+\/block$/, action: 'session.blocked', entityType: 'session_day' },
  { route: /^POST \/api\/v1\/staff\/sessions\/days\/[^/]+\/unblock$/, action: 'session.unblocked', entityType: 'session_day' },
  { route: /^POST \/api\/v1\/staff\/sessions\/days\/[^/]+\/band$/, action: 'session.band_set', entityType: 'session_day' },
  { route: /^POST \/api\/v1\/staff\/catalog\/service-types\/[^/]+\/schedule-slots$/, action: 'timetable.slot_added', entityType: 'schedule_slot' },
  { route: /^POST \/api\/v1\/staff\/catalog\/schedule-slots\/[^/]+\/remove$/, action: 'timetable.slot_removed', entityType: 'schedule_slot' },
  // W55 + W56: the catalogue. On and off sale and a price are one action for every kind, told apart by entity type.
  ...CATALOG_KINDS.flatMap(([folder, entityType]) => [
    { route: new RegExp(`^POST /api/v1/staff/catalog/${folder}/[^/]+/active$`), action: 'catalog.active_set', entityType },
    ...(PRICED_FOLDERS.has(folder) ? [{ route: new RegExp(`^POST /api/v1/staff/catalog/${folder}/[^/]+/price$`), action: 'catalog.price_set', entityType }] : []),
  ]),
  { route: /^POST \/api\/v1\/staff\/catalog\/tiers\/[^/]+\/price$/, action: 'catalog.price_set', entityType: 'price_tier' },
  { route: /^POST \/api\/v1\/staff\/catalog\/products\/[^/]+\/fulfilment$/, action: 'catalog.details_set', entityType: 'product' },
  { route: /^POST \/api\/v1\/staff\/catalog\/products\/[^/]+\/variants$/, action: 'catalog.variant_created', entityType: 'product_variant' },
  { route: /^POST \/api\/v1\/staff\/catalog\/variants\/[^/]+\/details$/, action: 'catalog.details_set', entityType: 'product_variant' },
  { route: /^POST \/api\/v1\/staff\/catalog\/variants\/[^/]+\/stock$/, action: 'stock.adjusted', entityType: 'product_variant' },
  { route: /^POST \/api\/v1\/staff\/catalog\/addons\/[^/]+\/sku$/, action: 'catalog.details_set', entityType: 'addon' },
  { route: /^POST \/api\/v1\/staff\/catalog\/service-types\/[^/]+\/details$/, action: 'catalog.details_set', entityType: 'service_type' },
  { route: /^POST \/api\/v1\/staff\/catalog\/service-types\/[^/]+\/tiers$/, action: 'catalog.tier_created', entityType: 'service_type' },
  { route: /^POST \/api\/v1\/staff\/catalog\/tier-groups\/range$/, action: 'catalog.tier_range_set', entityType: 'price_tier' },
  { route: /^POST \/api\/v1\/staff\/catalog\/session-pass-types\/[^/]+\/details$/, action: 'catalog.details_set', entityType: 'session_pass_type' },
  { route: /^POST \/api\/v1\/staff\/catalog\/gift-card-types\/[^/]+\/details$/, action: 'catalog.details_set', entityType: 'gift_card_type' },
  { route: /^POST \/api\/v1\/staff\/catalog\/gift-card-types\/[^/]+\/presets$/, action: 'catalog.preset_created', entityType: 'gift_card_preset' },
  { route: /^POST \/api\/v1\/staff\/catalog\/gift-card-presets\/[^/]+\/price$/, action: 'catalog.price_set', entityType: 'gift_card_preset' },
]

const auditRows = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]
const adminAuditRows = (recording: Recording): AuditRow[] => auditRows(recording).filter((row) => STEP_G_AUDIT_ROWS.has(String(row.action)))

/**
 * A recording as the step G replay compares it: the Worker's own audit rows set aside (the old functions wrote
 * none), the remaining audit rows' own labels left out (they shift when rows are set aside), and the stored answers
 * set aside (api_idempotency: only the new side has them). Everything else is compared exactly, and what was set
 * aside is checked on its own (adminRowProblems, adminStoredAnswerProblems).
 */
export function comparableAdmin(recording: Recording): Recording {
  const aside = new Set(adminAuditRows(recording))
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

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * What each of the Worker's own audit rows must say, and that each change has exactly one: who (a staff member), a
 * request id, the entity, `before` and `after` (the row before and after, as admin/write.ts keeps them) and the
 * press's key; one row for each press of a write route that was answered with a success (a stored answer of 200),
 * and none for a refusal. Answers the problems found, empty when all is right.
 */
export function adminRowProblems(recording: Recording): string[] {
  const problems: string[] = []
  const rows = adminAuditRows(recording)
  const stored = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  for (const row of rows) {
    const d = row.details ?? {}
    const wrong = (why: string) => problems.push(`${String(row.action)}: ${why} (${JSON.stringify(d)})`)
    const byStaff = row['actor_type'] === 'staff' && typeof row['actor_id'] === 'string' && row['actor_id'] !== '' && typeof row['request_id'] === 'string' && row['request_id'] !== ''
    if (!byStaff) wrong('actor or request id')
    // W51: one of the routes that write this action, for this kind of thing (a session, or a day).
    const expected = STEP_G_WRITE_ROUTES.find((one) => (one.action === row.action || (one.also ?? []).includes(String(row.action))) && one.entityType === row['entity_type'])
    if (!expected || typeof row['entity_id'] !== 'string' || row['entity_id'] === '') wrong('entity')
    if (typeof d['key'] !== 'string' || d['key'] === '') wrong('the key')
    if (STEP_G_FLAG_ROWS.has(String(row.action))) {
      // W50: a flag's row. The flag as set, and nothing about the customer: never a name, an email or a date of birth.
      if (!isObject(d['after']) || 'before' in d) wrong('a flag keeps `after` and no `before`')
      const kept = isObject(d['after']) ? Object.keys(d['after']).sort().join() : ''
      // W52: an event attendee's row keeps their waivers and check-in as set, with the versions signed.
      const attendeeKept = 'checked_in_at,event_waiver_accepted_at,event_waiver_method,event_waiver_version,extra_waiver_state,waiver_accepted,waiver_accepted_at,waiver_method,waiver_version'
      const expectedKeys: Record<string, string> = {
        'booking.checked_in': 'checked_in_at',
        'booking.check_in_undone': 'checked_in_at',
        'booking.guest_waiver_set': 'booking_id,waiver_accepted,waiver_accepted_at,waiver_method,waiver_version',
        'booking.addon_prepared_set': 'booking_id,prepared,prepared_at,prepared_by',
        'event_attendee.checked_in': attendeeKept,
        'event_attendee.check_in_undone': attendeeKept,
        'event_attendee.waiver_set': attendeeKept,
        // W53: the line's order and its fulfilment state as set.
        'order_line.fulfilled_set': 'fulfillment_status,order_id',
      }
      if (kept !== expectedKeys[String(row.action)]) wrong('what is kept of the flag')
      if (row.action === 'booking.guest_waiver_set' && typeof d['accepted'] !== 'boolean') wrong('which way the waiver was pressed')
      if (row.action === 'booking.addon_prepared_set' && typeof d['prepared'] !== 'boolean') wrong('which way the tick was pressed')
      if (row.action === 'order_line.fulfilled_set' && typeof d['fulfilled'] !== 'boolean') wrong('which way the tick was pressed')
      if (row.action === 'event_attendee.waiver_set' && (typeof d['accepted'] !== 'boolean' || !['standard', 'extra', 'both'].includes(String(d['which'])))) wrong('which waiver, and which way it was pressed')
      if (row.action === 'event_attendee.checked_in' && typeof d['markWaiversSignedInPerson'] !== 'boolean') wrong('whether the waivers were marked signed at the desk')
      // Never a name or an email: an attendee is named by id only.
      if (W52_FLAG_ROWS.has(String(row.action)) && /"(name|email|date_of_birth)"/.test(JSON.stringify(d))) wrong('a name in an attendee row')
      continue
    }
    if (!('before' in d) || !('after' in d)) wrong('before and after')
    const created =
      row.action === 'staff.created' ||
      row.action === 'promo.created' ||
      row.action === 'session.created' ||
      row.action === 'timetable.slot_added' ||
      // W55 + W56: a new variant, size group or preset has nothing before it.
      row.action === 'catalog.variant_created' ||
      row.action === 'catalog.tier_created' ||
      row.action === 'catalog.preset_created'
    // A create has nothing before it; an edit has the row as it was. A member term's first save has nothing before it either.
    if (created ? d['before'] !== null : row.action !== 'pricing.member_term_set' && d['before'] === null) wrong('what was there before')
    // W51: a weekly slot removed has nothing after it (its row is kept in `before`); everything else has.
    if (row.action === 'timetable.slot_removed' ? d['after'] !== null : d['after'] === null || d['after'] === undefined) wrong('what is there after')
    // W51: a day's row (Block Day, Unblock Day, a day's band) keeps each session before and after, and names the day.
    if (row['entity_type'] === 'session_day' && (!Array.isArray(d['before']) || !Array.isArray(d['after']) || !/^\d{4}-\d{2}-\d{2}$/.test(String(row['entity_id'])))) wrong('the day and its sessions')
    if ((row.action === 'session.blocked' || row.action === 'session.unblocked') && row['entity_type'] === 'session_day' && !Array.isArray(d['sessionIds'])) wrong('which sessions the day press changed')
    // W51a (W51 review L1): every block keeps the clock it read under the session's lock (a recording shows a time
    // as "<time>"; its exact form is held in sessions/admin.test.ts).
    if (row.action === 'session.blocked' && (typeof d['lockedAt'] !== 'string' || d['lockedAt'] === '')) wrong('when the block took its lock')
    // W51a (closed dates): a day's block says whether it recorded the date as closed, and a day's unblock whether it removed one.
    if (row.action === 'session.blocked' && row['entity_type'] === 'session_day' && typeof d['closedDate'] !== 'boolean') wrong('whether the day press closed the date')
    if (row.action === 'session.unblocked' && row['entity_type'] === 'session_day' && typeof d['closedDateRemoved'] !== 'boolean') wrong('whether the day press removed a closed date')
    // A session's row keeps the session's own state, and never a customer's name (the bookings in the way are a refusal's, not a row's).
    if (String(row.action).startsWith('session.') && /first_name|last_name|email/.test(JSON.stringify(d))) wrong('a name in a session row')
    if (row.action === 'staff.permission_set' && !['can_issue_refunds', 'can_manage_pricing', 'active'].includes(String(d['field']))) wrong('which switch')
    if (row.action === 'pricing.band_rules_set' && (!Number.isInteger(d['dayOfWeek']) || !Number.isInteger(d['rebandedSessions']) || !Array.isArray(d['before']) || !Array.isArray(d['after']))) wrong('the day, the count and the windows')
    // A staff row keeps the role and the three switches, and never a name or an email.
    if (String(row.action).startsWith('staff.')) {
      for (const state of [d['before'], d['after']]) {
        if (state !== null && (!isObject(state) || Object.keys(state).sort().join() !== 'active,can_issue_refunds,can_manage_pricing,role')) wrong('what is kept of a staff member')
      }
    }
  }
  for (const { route, action, also, entityType, oneRowFor } of STEP_G_WRITE_ROUTES) {
    const answered = stored.filter((row) => route.test(String(row['endpoint'])) && row['http_status'] === 200)
    const written = rows.filter((row) => (row.action === action || (also ?? []).includes(String(row.action))) && row['entity_type'] === entityType).length
    if (oneRowFor === 'each_attendee_checked_in') {
      // W52: one row for each attendee a check-in press checked in, counted from the presses' stored answers.
      const checkedIn = answered.reduce((total, row) => total + attendeesCheckedIn(row['response']), 0)
      if (written !== checkedIn) problems.push(`${action}: ${written} rows for ${checkedIn} attendees checked in`)
      continue
    }
    const presses = answered.length
    if (written !== presses) problems.push(`${action}: ${written} rows for ${presses} presses answered with a success`)
  }
  return problems
}

/** W52: how many attendees a check-in press's stored answer says it checked in (its `results` that are `updated: true`). */
function attendeesCheckedIn(response: unknown): number {
  const body = typeof response === 'string' ? (JSON.parse(response) as unknown) : response
  const data = isObject(body) && isObject(body['data']) ? body['data'] : body
  const results = isObject(data) && Array.isArray(data['results']) ? (data['results'] as unknown[]) : []
  return results.filter((outcome) => isObject(outcome) && outcome['updated'] === true).length
}

/** The stored answers the new side wrote: each a finished press of one of the moved write routes. */
export function adminStoredAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  const known = (endpoint: string) => STEP_G_WRITE_ROUTES.some(({ route }) => route.test(endpoint)) || W57_WRITE_ROUTES.some((route) => route.test(endpoint))
  return rows.filter((row) => row['status'] !== 'done' || !known(String(row['endpoint']))).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}

/**
 * W57: the plan and settings write routes. A level A press writes several rows of its own (the record, the steps), so
 * they are not in STEP_G_WRITE_ROUTES' one-row-per-press count: plan-admin-replay.test.ts checks those rows. A stored
 * answer from one (updateCatalogItemPrice's plan branch in the catalogue's recordings) is one of the moved writes'.
 */
export const W57_WRITE_ROUTES: readonly RegExp[] = [
  /^POST \/api\/v1\/staff\/catalog\/membership-plans$/,
  /^POST \/api\/v1\/staff\/catalog\/membership-plans\/[^/]+\/(details|active)$/,
  /^POST \/api\/v1\/staff\/membership-settings$/,
]
