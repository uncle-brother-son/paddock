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
/** Every old step G function now a thin call to the Worker. */
export const STEP_G_ACTIONS_MOVED: ReadonlySet<string> = new Set([...W49_ACTIONS, ...W54_ACTIONS])

/** The two that add something: their dialogs keep a press key, and their wrappers answer a refusal as data. */
const CREATES: ReadonlySet<string> = new Set(['createStaff', 'createPromoCode'])
/** The moved reads GB14's recording makes with `call`, which stops at the first throw. */
const READS: ReadonlySet<string> = new Set(['getStaff', 'getPromoCodes', 'getPromoCodeRedemptions'])

type CreateAnswer = { created?: boolean; message?: string; noAnswer?: boolean } | null

/**
 * A create as its dialog presses it (NewStaffDialog, PromoCodeDialog): each press has a key; a press that got no
 * answer keeps it for the next press; any other answer starts a new one. The wrapper answers a refusal as data
 * (`created: false`, so the dialog can tell it from no answer); the dialog shows its words where it showed the old
 * function's thrown error, so the replay reads it as that throw.
 */
export function createAsTheDialogPresses(action: string): (db: Db, params: unknown) => Promise<unknown> {
  let held: string | null = null
  return async (db, params) => {
    const idempotencyKey = held ?? crypto.randomUUID()
    const answer = (await throughStaffApp(action)(db, { ...(params as object), idempotencyKey })) as CreateAnswer
    held = answer?.noAnswer ? idempotencyKey : null
    if (answer && answer.created === false) throw new Error(String(answer.message))
    return answer
  }
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
  if (action === 'getPromoCodes' && Array.isArray(answer)) {
    return answer.map((row: unknown, i) => {
      if (!isRecord(row) || !('stamp' in row)) return row
      const { stamp, ...rest } = row
      found?.push({ action, where: `[${i}].stamp`, stamp })
      return rest
    })
  }
  return answer
}

/** What each stamp set aside must be: text that isn't empty, in the stamp's own form. Answers the problems found. */
export function answeredStampProblems(found: readonly AnsweredStamp[]): string[] {
  // A row's stamp, or a set of rows' (each row's id and stamp, in id order).
  const one = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z#[0-9a-f]{32}'
  const form = new RegExp(`^(${one}|[0-9a-f-]{36}@${one}(,[0-9a-f-]{36}@${one})*)$`)
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
}

/**
 * The new side: the moved step G functions through the staff app's wrappers and the Worker's routes, everything
 * else through the old functions (the frozen copies), on the same database. A switch or a setting sends no key of
 * its own: each wrapper makes one for its call (lead call L12). W54a: an edit that sends a whole row back is
 * pressed with the stamp its screen's read gave just before (asTheScreenPresses), and the stamps in the answers are
 * set aside (withoutStamps).
 */
export function newAdminSide({ adjust, calls, refusedReadsAsAnswers, stamps, pressWithoutReading }: AdminSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    const creates = new Map([...CREATES].map((action) => [action, createAsTheDialogPresses(action)] as const))
    return {
      name: 'new',
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
          const sent = pressWithoutReading ? params : await asTheScreenPresses(action, db, params)
          answer = await (creates.get(action) ?? throughStaffApp(action))(db, sent)
        } catch (err) {
          if (!refusedReadsAsAnswers || !READS.has(action)) throw err
          answer = { thrown: err instanceof Error ? err.message : String(err) }
        }
        answer = withoutStamps(action, answer, stamps)
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
])

/** Each moved write route, and the one audit action a press of it answered with a success writes. */
export const STEP_G_WRITE_ROUTES: ReadonlyArray<{ route: RegExp; action: string; entityType: string }> = [
  { route: /^POST \/api\/v1\/staff\/staff$/, action: 'staff.created', entityType: 'staff' },
  { route: /^POST \/api\/v1\/staff\/staff\/[^/]+\/role$/, action: 'staff.role_set', entityType: 'staff' },
  { route: /^POST \/api\/v1\/staff\/staff\/[^/]+\/permissions$/, action: 'staff.permission_set', entityType: 'staff' },
  { route: /^POST \/api\/v1\/staff\/pricing\/bands\/[^/]+\/price$/, action: 'pricing.band_price_set', entityType: 'session_band' },
  { route: /^POST \/api\/v1\/staff\/pricing\/band-rules\/[^/]+$/, action: 'pricing.band_rules_set', entityType: 'band_rules_day' },
  { route: /^POST \/api\/v1\/staff\/pricing\/member-band-terms$/, action: 'pricing.member_term_set', entityType: 'membership_band_term' },
  { route: /^POST \/api\/v1\/staff\/postage\/settings$/, action: 'postage.set', entityType: 'postage_settings' },
  { route: /^POST \/api\/v1\/staff\/promo-codes$/, action: 'promo.created', entityType: 'promo_code' },
  { route: /^POST \/api\/v1\/staff\/promo-codes\/[^/]+$/, action: 'promo.updated', entityType: 'promo_code' },
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
    const expected = STEP_G_WRITE_ROUTES.find((one) => one.action === row.action)
    if (row['entity_type'] !== expected?.entityType || typeof row['entity_id'] !== 'string' || row['entity_id'] === '') wrong('entity')
    if (!('before' in d) || !('after' in d)) wrong('before and after')
    if (typeof d['key'] !== 'string' || d['key'] === '') wrong('the key')
    const created = row.action === 'staff.created' || row.action === 'promo.created'
    // A create has nothing before it; an edit has the row as it was. A member term's first save has nothing before it either.
    if (created ? d['before'] !== null : row.action !== 'pricing.member_term_set' && d['before'] === null) wrong('what was there before')
    if (d['after'] === null || d['after'] === undefined) wrong('what is there after')
    if (row.action === 'staff.permission_set' && !['can_issue_refunds', 'can_manage_pricing', 'active'].includes(String(d['field']))) wrong('which switch')
    if (row.action === 'pricing.band_rules_set' && (!Number.isInteger(d['dayOfWeek']) || !Number.isInteger(d['rebandedSessions']) || !Array.isArray(d['before']) || !Array.isArray(d['after']))) wrong('the day, the count and the windows')
    // A staff row keeps the role and the three switches, and never a name or an email.
    if (String(row.action).startsWith('staff.')) {
      for (const state of [d['before'], d['after']]) {
        if (state !== null && (!isObject(state) || Object.keys(state).sort().join() !== 'active,can_issue_refunds,can_manage_pricing,role')) wrong('what is kept of a staff member')
      }
    }
  }
  for (const { route, action } of STEP_G_WRITE_ROUTES) {
    const presses = stored.filter((row) => route.test(String(row['endpoint'])) && row['http_status'] === 200).length
    const written = rows.filter((row) => row.action === action).length
    if (written !== presses) problems.push(`${action}: ${written} rows for ${presses} presses answered with a success`)
  }
  return problems
}

/** The stored answers the new side wrote: each a finished press of one of the moved write routes. */
export function adminStoredAnswerProblems(recording: Recording): string[] {
  const rows = (recording.tables['api_idempotency']?.added ?? []) as Row[]
  return rows.filter((row) => row['status'] !== 'done' || !STEP_G_WRITE_ROUTES.some(({ route }) => route.test(String(row['endpoint'])))).map((row) => `${String(row['endpoint'])}: ${String(row['status'])}`)
}
