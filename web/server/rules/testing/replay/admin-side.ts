import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { throughStaffApp } from './booking-side'
import { withCanonicalGoneNumbers, type Recording, type Row } from './compare'
import { oldSide, type ReplaySide } from './harness'

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

/** W49: the six staff functions. */
export const W49_ACTIONS: ReadonlySet<string> = new Set(['getCurrentStaff', 'getStaff', 'createStaff', 'setStaffRole', 'setStaffPermission', 'setStaffCanManagePricing'])
/** W54: the four pricing setters and the four promo code functions. */
export const W54_ACTIONS: ReadonlySet<string> = new Set(['setBandPrice', 'setBandRules', 'setMembershipBandTerm', 'setPostageSettings', 'getPromoCodes', 'getPromoCodeRedemptions', 'createPromoCode', 'updatePromoCode'])
/** W50: the six booking and Overview reads, and the three flags. */
export const W50_READS: ReadonlySet<string> = new Set(['getBookings', 'getBookingById', 'getBookingDetail', 'getAddonPrepChecklistForRange', 'getWaiverGapsForRange', 'getPaymentAttentionItems'])
export const W50_FLAGS: ReadonlySet<string> = new Set(['setBookingCheckedIn', 'setGuestWaiverStatus', 'setAddonLinePrepared'])
export const W50_ACTIONS: ReadonlySet<string> = new Set([...W50_READS, ...W50_FLAGS])
/** W51: the two calendar reads and the ten session and timetable writes. (generateUpcomingSessions is deleted, not moved: GB24.) */
export const W51_READS: ReadonlySet<string> = new Set(['getSessionsForRange', 'getServiceTypesForSlot'])
export const W51_WRITES: ReadonlySet<string> = new Set([
  'blockSession',
  'blockDay',
  'unblockSession',
  'unblockDay',
  'setSessionBand',
  'resetSessionBand',
  'setSessionStartTime',
  'createOneOffSession',
  'addServiceTypeScheduleSlot',
  'deleteServiceTypeScheduleSlot',
])
export const W51_ACTIONS: ReadonlySet<string> = new Set([...W51_READS, ...W51_WRITES])
/** W52: the three event reads, the two catalogue writes and the three event-day flags. */
export const W52_READS: ReadonlySet<string> = new Set(['getEvents', 'getEventAttendees', 'getTodaysEvents'])
export const W52_WRITES: ReadonlySet<string> = new Set(['setEventActive', 'setEventDetails'])
export const W52_FLAGS: ReadonlySet<string> = new Set(['setEventAttendeeCheckIn', 'setEventAttendeesCheckIn', 'setEventAttendeeWaiver'])
export const W52_ACTIONS: ReadonlySet<string> = new Set([...W52_READS, ...W52_WRITES, ...W52_FLAGS])
/** Every old step G function now a thin call to the Worker. */
export const STEP_G_ACTIONS_MOVED: ReadonlySet<string> = new Set([...W49_ACTIONS, ...W54_ACTIONS, ...W50_ACTIONS, ...W51_ACTIONS, ...W52_ACTIONS])

/** The ones that add something: their dialogs keep a press key, and their wrappers answer a refusal as data. */
const CREATES: ReadonlySet<string> = new Set(['createStaff', 'createPromoCode', 'createOneOffSession', 'addServiceTypeScheduleSlot'])
/**
 * W51: the refusals createOneOffSession answered as data before it was a thin call, with these reasons and no words
 * (its dialog has the words). They still come back so, and the replay reads them as answers, as recorded.
 */
const ONE_OFF_REASONS_ANSWERED: ReadonlySet<string> = new Set(['service_type_not_found', 'service_type_incomplete', 'slot_already_exists'])
/** The moved reads GB14's recording makes with `call`, which stops at the first throw. */
const READS: ReadonlySet<string> = new Set(['getStaff', 'getPromoCodes', 'getPromoCodeRedemptions', ...W50_READS, ...W51_READS, ...W52_READS])

type CreateAnswer = { created?: boolean; reason?: string; message?: string; noAnswer?: boolean } | null

/**
 * A create as its dialog presses it (NewStaffDialog, PromoCodeDialog; W51: CreateOneOffSessionDialog,
 * NewScheduleSlotDialog): each press has a key; a press that got no answer keeps it for the next press; any other
 * answer starts a new one. The wrapper answers a refusal as data (`created: false`, so the dialog can tell it from
 * no answer); the dialog shows its words where it showed the old function's thrown error, so the replay reads it as
 * that throw. W51: a refusal the old function itself answered as data (createOneOffSession's three reasons) stays
 * an answer.
 */
export function createAsTheDialogPresses(action: string): (db: Db, params: unknown) => Promise<unknown> {
  let held: string | null = null
  return async (db, params) => {
    const idempotencyKey = held ?? crypto.randomUUID()
    const answer = (await throughStaffApp(action)(db, { ...(params as object), idempotencyKey })) as CreateAnswer
    held = answer?.noAnswer ? idempotencyKey : null
    const answeredAsData = action === 'createOneOffSession' && typeof answer?.reason === 'string' && ONE_OFF_REASONS_ANSWERED.has(answer.reason)
    if (answer && answer.created === false && !answeredAsData) throw new Error(String(answer.message))
    return answer
  }
}

// --- W51: the figures a two-step press confirms (Q18's rule for counts). The old functions took none.

/**
 * W51. Block Day, Unblock Day and a band change send the figures their dialog showed (`seen`), and the Worker
 * refuses a press whose figures are no longer right. A golden file's params have none (the old functions counted
 * again for themselves), so each press is made as its dialog makes it: the quote first, by the same sign-in, then
 * the press with the figures the quote gave. A quote the Worker refuses (an inactive account, no Manage pricing)
 * gives no figures; the press is then refused the same way, before any figure is looked at, as the recording has
 * it. So a recording never meets `changed_since`: its dialog is always up to date. The rule itself is tested where
 * it can be shown (sessions/admin.test.ts).
 */
const FIGURES_THE_DIALOG_SHOWED: Readonly<Record<string, (db: Db, params: Record<string, unknown>) => Promise<unknown>>> = {
  // BlockDayDialog: the quote when it opens.
  async blockDay(db, params) {
    const shown = (await throughStaffApp('blockDay')(db, { date: params['date'], quote: true })) as { toBlock?: unknown; alreadyBlocked?: unknown }
    return { toBlock: shown.toBlock, alreadyBlocked: shown.alreadyBlocked }
  },
  // UnblockDayDialog: the count when it opens. Only the confirmed call is a press.
  async unblockDay(db, params) {
    if (params['confirmed'] !== true) return undefined
    const shown = (await throughStaffApp('unblockDay')(db, { date: params['date'] })) as { blockedSessions?: unknown; blockedBefore?: unknown; closedDates?: unknown }
    // W51a: whether a closed date goes with the day's block is one of the figures the dialog shows and sends.
    return { blockedSessions: shown.blockedSessions, blockedBefore: shown.blockedBefore, closedDates: shown.closedDates }
  },
  // ChangeSessionBandDialog: "Check Affected", then "Confirm Change". Only the confirmed call is a press.
  async setSessionBand(db, params) {
    if (params['confirmed'] !== true) return undefined
    const first = Object.fromEntries(Object.entries(params).filter(([name]) => name !== 'confirmed'))
    const shown = (await throughStaffApp('setSessionBand')(db, first)) as { sessionsAffected?: unknown; bookingsAffected?: unknown }
    return { sessionsAffected: shown.sessionsAffected, bookingsAffected: shown.bookingsAffected }
  },
}

/** `params` with the figures the dialog would hold, read just before the press. Params that bring their own keep them. */
async function withTheFiguresShown(action: string, db: Db, params: unknown): Promise<unknown> {
  const read = FIGURES_THE_DIALOG_SHOWED[action]
  if (!read || (isRecord(params) && 'seen' in params)) return params
  let seen: unknown
  try {
    seen = await read(db, (params ?? {}) as Record<string, unknown>)
  } catch {
    // The dialog's quote was refused, or failed: it has no figures to send.
    seen = undefined
  }
  return seen === undefined ? params : { ...(params as object), seen }
}

// --- W54a: the stamp (admin/stamp.ts). The old functions had none, so the replay drives it as the screens do.

/** The stamp of a row that isn't there yet (admin/stamp.ts, NO_ROW_STAMP): what a screen that saw no row sends. */
const NO_ROW = 'none'

/**
 * W54a. The four edits that send a whole row back carry the stamp their screen loaded. A golden file's params have
 * none (the old functions took none), so each is pressed as its screen presses it: the screen's own read first, by
 * the same sign-in, then the press with the stamp that read gave. A read the Worker refuses (an inactive account, a
 * sign-in with no staff row) gives no stamp; the press is then refused by the staff check, before a stamp is looked
 * at, as the recording has it. So a recording never meets `changed_since`: its page is always up to date. The rule
 * itself is tested where it can be shown (pricing/ and promo/ admin.test.ts; the races in admin-postgres.test.ts).
 */
const STAMP_THE_SCREEN_LOADED: Readonly<Record<string, (db: Db, params: Record<string, unknown>) => Promise<unknown>>> = {
  // The Promo Codes page: the row's stamp from the list (the switch and the dialog both send it).
  async updatePromoCode(db, params) {
    const rows = (await throughStaffApp('getPromoCodes')(db, {})) as Array<{ id?: unknown; stamp?: unknown }>
    return rows.find((row) => row.id === params['id'])?.stamp
  },
  // The Pricing page: the day's stamp, by day.
  async setBandRules(db, params) {
    const config = (await throughStaffApp('getPricingConfig')(db, {})) as { bandRulesStamps?: unknown[] }
    return config.bandRulesStamps?.[Number(params['dayOfWeek'])]
  },
  // The Pricing page: the term's row. A term with no row yet is saved with the stamp of no row.
  async setMembershipBandTerm(db, params) {
    const config = (await throughStaffApp('getPricingConfig')(db, {})) as { membershipTerms?: Array<{ membership_level?: unknown; band_id?: unknown; stamp?: unknown }> }
    const level = typeof params['membershipLevel'] === 'string' ? params['membershipLevel'].trim() : params['membershipLevel']
    return (config.membershipTerms ?? []).find((term) => term.membership_level === level && term.band_id === params['bandId'])?.stamp ?? NO_ROW
  },
  // The Pricing page's postage boxes.
  async setPostageSettings(db) {
    return ((await throughStaffApp('getPostageSettings')(db, {})) as { stamp?: unknown }).stamp
  },
  // W52. Catalog → Events: the event's stamp from the list (the edit dialog opens on a row of it).
  async setEventDetails(db, params) {
    const rows = (await throughStaffApp('getEvents')(db, {})) as Array<{ id?: unknown; stamp?: unknown }>
    return rows.find((row) => row.id === params['eventId'])?.stamp
  },
}
/** The edits that carry a stamp. */
export const STAMPED_EDITS: ReadonlySet<string> = new Set(Object.keys(STAMP_THE_SCREEN_LOADED))

/** `params` with the stamp the screen would hold, read just before the press. Params that bring a stamp of their own (a test's older page) keep it. */
async function asTheScreenPresses(action: string, db: Db, params: unknown): Promise<unknown> {
  const read = STAMP_THE_SCREEN_LOADED[action]
  if (!read || (isRecord(params) && 'stamp' in params)) return params
  let stamp: unknown
  try {
    stamp = await read(db, (params ?? {}) as Record<string, unknown>)
  } catch {
    // The screen's read was refused, or failed: the screen has no stamp to send.
    stamp = undefined
  }
  return stamp === undefined ? params : { ...(params as object), stamp }
}

/** A stamp the new side answered that the old functions never did: which call, and where in its answer. */
export interface AnsweredStamp {
  action: string
  where: string
  stamp: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * W54a. An answer with its stamps set aside, so it compares with the old function's: a saved edit's new stamp, and
 * the stamp on each row of the promo code list. Each one set aside is noted in `found`, and checked on its own
 * (answeredStampProblems). Nothing else is taken out, and an answer with no stamp is left exactly as it is.
 */
function withoutStamps(action: string, answer: unknown, found: AnsweredStamp[] | undefined): unknown {
  if (STAMPED_EDITS.has(action) && isRecord(answer) && 'stamp' in answer) {
    const { stamp, ...rest } = answer
    found?.push({ action, where: 'stamp', stamp })
    return rest
  }
  // W52: the events list carries a stamp on each row, as the promo code list does.
  if ((action === 'getPromoCodes' || action === 'getEvents') && Array.isArray(answer)) {
    return answer.map((row: unknown, i) => {
      if (!isRecord(row) || !('stamp' in row)) return row
      const { stamp, ...rest } = row
      found?.push({ action, where: `[${i}].stamp`, stamp })
      return rest
    })
  }
  // W52: a saved event edit answers the event's row with its new stamp on it (the page puts the row back in its list).
  if (action === 'setEventDetails' && isRecord(answer) && isRecord(answer['event']) && 'stamp' in answer['event']) {
    const { stamp, ...event } = answer['event']
    found?.push({ action, where: 'event.stamp', stamp })
    return { ...answer, event }
  }
  return answer
}

/** W52: whether a refund on a booking's order is still being checked, as the attendee list now says beside each booking: which call, which booking, and what it said. */
export interface AnsweredRefundOpen {
  eventBookingId: unknown
  refundOpen: unknown
}

/**
 * W52: the attendee list answers `refund_open` on each booking (W35 audit row 18), which the old read never did. It
 * is set aside, so the bookings compare with the recording's, and noted in `found` for the test to check on its own.
 */
function withoutRefundOpen(action: string, answer: unknown, found: AnsweredRefundOpen[] | undefined): unknown {
  if (action !== 'getEventAttendees' || !isRecord(answer) || !Array.isArray(answer['bookings'])) return answer
  return {
    ...answer,
    bookings: (answer['bookings'] as unknown[]).map((booking) => {
      if (!isRecord(booking) || !('refund_open' in booking)) return booking
      const { refund_open, ...rest } = booking
      found?.push({ eventBookingId: booking['id'], refundOpen: refund_open })
      return rest
    }),
  }
}

/** What each stamp set aside must be: text that isn't empty, in the stamp's own form. Answers the problems found. */
export function answeredStampProblems(found: readonly AnsweredStamp[]): string[] {
  // A row's stamp, or a set of rows' (each row's id and stamp, in id order). W52: or the stamp of the columns one
  // edit writes (admin/stamp.ts, fieldsStampSql), which has no moment in front.
  const one = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z#[0-9a-f]{32}'
  const form = new RegExp(`^(${one}|[0-9a-f-]{36}@${one}(,[0-9a-f-]{36}@${one})*|fields#[0-9a-f]{32})$`)
  return found.filter(({ stamp }) => typeof stamp !== 'string' || !form.test(stamp)).map(({ action, where, stamp }) => `${action} ${where}: ${JSON.stringify(stamp)}`)
}

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
  /** W51: every `madeUpTo` the calendar read answered beside its sessions, set aside for the test to check on its own. */
  madeUpTo?: unknown[]
  /** W51: a press exactly as the golden file has it, with no quote read first: how a test shows what the figures are for. */
  pressWithoutFigures?: boolean
  /** W52: every `refund_open` the attendee list answered beside a booking, set aside for the test to check on its own. */
  refundOpen?: AnsweredRefundOpen[]
}

/**
 * W51: the calendar read answers the sessions and the date sessions are made up to; the old function answered the
 * sessions alone. The list is what is compared with the recording; the date is set aside (noted in `found`).
 */
function sessionsOf(action: string, answer: unknown, found: unknown[] | undefined): unknown {
  if (action !== 'getSessionsForRange' || !isRecord(answer) || !('sessions' in answer)) return answer
  found?.push(answer['madeUpTo'])
  return answer['sessions']
}

/** The database's nightly job as the saved schema has it (migration 032), run as the job runs it: the tables' owner. */
async function runNightlyJobAsNow(db: Db): Promise<void> {
  // The clock moves, as it does between presses: what the job makes comes after what was made before it.
  vi.setSystemTime(Date.now() + 1)
  await db.query('RESET ROLE')
  try {
    await db.query('SELECT public.generate_upcoming_sessions()')
  } finally {
    await db.query('SET ROLE paddock_worker')
  }
}

/**
 * The new side: the moved step G functions through the staff app's wrappers and the Worker's routes, everything
 * else through the old functions (the frozen copies), on the same database. A switch or a setting sends no key of
 * its own: each wrapper makes one for its call (lead call L12). W54a: an edit that sends a whole row back is
 * pressed with the stamp its screen's read gave just before (asTheScreenPresses), and the stamps in the answers are
 * set aside (withoutStamps).
 */
export function newAdminSide({ adjust, calls, refusedReadsAsAnswers, stamps, pressWithoutReading, madeUpTo, pressWithoutFigures, refundOpen }: AdminSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
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
          const sent = pressWithoutFigures ? stamped : await withTheFiguresShown(action, db, stamped)
          answer = await (creates.get(action) ?? throughStaffApp(action))(db, sent)
        } catch (err) {
          if (!refusedReadsAsAnswers || !READS.has(action)) throw err
          answer = { thrown: err instanceof Error ? err.message : String(err) }
        }
        answer = withoutRefundOpen(action, sessionsOf(action, withoutStamps(action, answer, stamps), madeUpTo), refundOpen)
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
])

/** W52: the three event-day flags' rows. */
export const W52_FLAG_ROWS: ReadonlySet<string> = new Set(['event_attendee.checked_in', 'event_attendee.check_in_undone', 'event_attendee.waiver_set'])

/**
 * W50: the audit rows of a flag (admin/flag.ts): who, the flag as it now is (`after`) and the call's key. A flag is
 * one guarded statement, so it reads no row first and keeps no `before`.
 */
export const STEP_G_FLAG_ROWS: ReadonlySet<string> = new Set(['booking.checked_in', 'booking.check_in_undone', 'booking.guest_waiver_set', 'booking.addon_prepared_set', ...W52_FLAG_ROWS])

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
      }
      if (kept !== expectedKeys[String(row.action)]) wrong('what is kept of the flag')
      if (row.action === 'booking.guest_waiver_set' && typeof d['accepted'] !== 'boolean') wrong('which way the waiver was pressed')
      if (row.action === 'booking.addon_prepared_set' && typeof d['prepared'] !== 'boolean') wrong('which way the tick was pressed')
      if (row.action === 'event_attendee.waiver_set' && (typeof d['accepted'] !== 'boolean' || !['standard', 'extra', 'both'].includes(String(d['which'])))) wrong('which waiver, and which way it was pressed')
      if (row.action === 'event_attendee.checked_in' && typeof d['markWaiversSignedInPerson'] !== 'boolean') wrong('whether the waivers were marked signed at the desk')
      // Never a name or an email: an attendee is named by id only.
      if (W52_FLAG_ROWS.has(String(row.action)) && /"(name|email|date_of_birth)"/.test(JSON.stringify(d))) wrong('a name in an attendee row')
      continue
    }
    if (!('before' in d) || !('after' in d)) wrong('before and after')
    const created = row.action === 'staff.created' || row.action === 'promo.created' || row.action === 'session.created' || row.action === 'timetable.slot_added'
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
  return rows.filter((row) => row['status'] !== 'done' || !STEP_G_WRITE_ROUTES.some(({ route }) => route.test(String(row['endpoint'])))).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}
