// W54 (G-plan 1.7, 4.1, 4.3, 4.6; bug GB8; W48 review S1 and L1): the Pricing page's four setters on the Worker.
// Ported from the staff app's setBandPrice.ts, setBandRules.ts, setMembershipBandTerm.ts and setPostageSettings.ts
// (frozen at W48 in testing/legacy-admin), with their words (./admin-failure-messages.ts). Each is one transaction
// under its row's lock, with an audit row of who and the row before and after (admin/write.ts); Manage pricing, in
// the old words. No Stripe: a band price, a window, a member term and postage are read live by every quote.
import 'server-only'
import type { AdminAction, AdminSetBandPriceOutput, BandRulesRouteOutput, MemberBandTermRouteInput, MemberBandTermRouteOutput, PostageSettingsRouteInput, PostageSettingsRouteOutput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import type { ApiError } from '@/server/http/errors'
import { EVERY_ROW, isUuid, lockAdminRows, SETTINGS_ROW } from '@/server/rules/admin/locks'
import { adminRefusal, requireAdminPermission } from '@/server/rules/admin/refusal'
import { NO_ROW_STAMP, rowsStamp, rowStampSql, type StampedRow } from '@/server/rules/admin/stamp'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWriteOptions } from '@/server/rules/admin/write'
import { LONDON_WALL_CLOCK_NOW_SQL } from '@/server/rules/time/london-day-sql'
import { PRICING_ADMIN_NEW_WORDS, PRICING_ADMIN_WORDS } from './admin-failure-messages'
import { DAY_WINDOW_STAMPS_SQL, MEMBER_TERM_STAMP_SQL, POSTAGE_STAMP_SQL } from './stamps'

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const bandGone = (action: AdminAction): ApiError => adminRefusal('NOT_FOUND', action, 'band_not_found', PRICING_ADMIN_NEW_WORDS.bandNoLongerExists)

// --- A band's price

interface BandRow {
  id: string
  code: string
  name: string
  price: string
}

/**
 * setBandPrice (`POST pricing/bands/:bandId/price`). Manage pricing; a price that isn't a number of 0 or more is
 * refused in the old words; then under the band's lock: a band that isn't there is refused (brief W54 item 11: the
 * old function answered `updated: false` with no words, and the page showed nothing), the price, and a
 * `pricing.band_price_set` audit row. It changes what the next quote reads, and no booking already made.
 *
 * W54a: no stamp here, on purpose. The press carries one value, the price staff typed, and writes only that: a
 * page loaded before someone else's change can't put anything of theirs back with it. (Two people setting one
 * band's price take turns on the band's lock, and the later press is the price: both are on record.)
 */
export async function setBandPrice(db: Db, bandId: string, price: unknown, options: AdminWriteOptions): Promise<AdminSetBandPriceOutput> {
  const action = 'pricing.band_price_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  if (!isAmount(price)) throw adminRefusal('VALIDATION', action, 'invalid_price', PRICING_ADMIN_WORDS.setBandPrice.priceMustValidNonNegativeAmount, { field: 'price' })
  return adminWrite<BandRow, BandRow, AdminSetBandPriceOutput>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'session_band', id: bandId },
      locks: [{ table: 'session_bands', ids: [bandId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        if (!held.session_bands?.length) throw bandGone(action)
        const [row] = await tx.query<BandRow>('SELECT id, code, name, price::text AS price FROM session_bands WHERE id = $1::uuid', [bandId])
        if (!row) throw bandGone(action)
        return row
      },
      async change(tx) {
        const [band] = await tx.query<BandRow>('UPDATE session_bands SET price = $1, updated_at = now() WHERE id = $2::uuid RETURNING id, code, name, price::text AS price', [price, bandId])
        if (!band) throw new Error('The band was held but not updated.')
        return { after: band, answer: { updated: true, band } }
      },
    },
    options
  )
}

// --- A day's band windows

interface Window {
  bandId: string
  from: number
  to: number
}
interface WindowRow {
  id: string
  band_id: string
  from_time: string
  to_time: string
}

/** "HH:MM" or "HH:MM:SS" as minutes since midnight, as the old function read it; anything else is not a time. */
function toMinutes(time: unknown): number {
  if (typeof time !== 'string') return Number.NaN
  const [h, m] = time.split(':')
  const hours = Number.parseInt(h ?? '', 10)
  const minutes = Number.parseInt(m ?? '0', 10)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return Number.NaN
  return hours * 60 + minutes
}

/** Minutes since midnight as "HH:MM:SS" (1440 is "24:00:00", which a `time` column holds). */
function toTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
}

/** The day from the route's path, as the number it names; text that isn't a number is not a day. */
const dayNumber = (day: unknown): number => (typeof day === 'number' ? day : typeof day === 'string' && /^-?\d+(\.\d+)?$/.test(day.trim()) ? Number(day) : Number.NaN)

/**
 * The old function's checks, in its order and words: the day, at least one window, each window's times, then (sorted
 * by start) the first starts at 00:00, each starts where the one before ends, the last ends at 24:00. Half-open
 * [from, to), as band_for_session_start reads them.
 */
function checkedWindows(action: AdminAction, day: number, rules: unknown): Window[] {
  const words = PRICING_ADMIN_WORDS.setBandRules
  const refuse = (reason: string, message: string) => adminRefusal('VALIDATION', action, reason, message)
  if (!Number.isInteger(day) || day < 0 || day > 6) throw refuse('invalid_day', words.dayWeekMustWholeNumberFrom)
  if (!Array.isArray(rules) || rules.length === 0) throw refuse('no_windows', words.atLeastOneBandWindowRequired)
  const parsed = (rules as unknown[]).map((rule) => {
    const one = (rule ?? {}) as { bandId?: unknown; fromTime?: unknown; toTime?: unknown }
    const from = toMinutes(one.fromTime)
    const to = toMinutes(one.toTime)
    if (Number.isNaN(from) || Number.isNaN(to)) throw refuse('invalid_time', words.windowTimesMustValidHhMm)
    if (to <= from) throw refuse('window_ends_before_it_starts', words.eachWindowMustEndAfterIt)
    if (from < 0 || to > 24 * 60) throw refuse('window_outside_the_day', words.windowTimesMustFallWithinDay)
    return { bandId: typeof one.bandId === 'string' ? one.bandId.toLowerCase() : '', from, to }
  })
  parsed.sort((a, b) => a.from - b.from)
  if (parsed[0]?.from !== 0) throw refuse('day_not_covered', words.firstWindowMustStartAt00)
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i]?.from !== parsed[i - 1]?.to) throw refuse('gap_or_overlap', words.windowsHaveGapOrOverlapEvery)
  }
  if (parsed[parsed.length - 1]?.to !== 24 * 60) throw refuse('day_not_covered', words.lastWindowMustEndAt24)
  return parsed
}

const DAY_WINDOWS_SQL = 'SELECT id, band_id, from_time::text AS from_time, to_time::text AS to_time FROM band_rules WHERE day_of_week = $1 ORDER BY from_time, id'
// W54a: each new window comes back with its own stamp, so the answer can carry the day's new one (admin/stamp.ts).
const INSERT_WINDOW_SQL = `
INSERT INTO band_rules (band_id, day_of_week, from_time, to_time)
VALUES ($1::uuid, $2, $3::time, $4::time)
RETURNING id, band_id, from_time::text AS from_time, to_time::text AS to_time, ${rowStampSql('band_rules')} AS stamp`

/**
 * The sessions reassign_session_bands would give another band, by its own conditions, under the windows as they now are.
 *
 * W51 (W50 review L3): "from now" is London's wall clock now, in the stored form. A session's start is London
 * wall-clock digits labelled UTC, so it is compared with the same kind of moment, never with the real now(): in
 * summer the real now() is an hour behind the wall, and a save at 10:30 on the wall would re-band a session that
 * started at 10:00. The database function's own default is the same moment since migration 032, and the Worker
 * passes it as well (REBAND_SQL), so the two agree whichever the database has.
 */
export const SESSIONS_TO_REBAND_SQL = `
SELECT s.id
  FROM sessions s
 WHERE s.type = 'public'
   AND s.band_overridden = false
   AND s.start_time >= ${LONDON_WALL_CLOCK_NOW_SQL}
   AND s.band_id IS DISTINCT FROM band_for_session_start(s.start_time)
 ORDER BY s.id`
/** The database's own re-band, from London's wall clock now (W51: it was `reassign_session_bands(now())`). */
export const REBAND_SQL = `SELECT reassign_session_bands(${LONDON_WALL_CLOCK_NOW_SQL}) AS n`

/**
 * setBandRules (`POST pricing/band-rules/:dayOfWeek`): one day's band windows replaced. Manage pricing; the old
 * checks in the old order and words; then ONE transaction (GB8):
 *  1. the band guard: every band's row, locked in id order (admin/locks.ts, EVERY_ROW). A day's windows may name any
 *     band and the day's own rows are deleted and made again, so there is no row of the day two saves could queue on:
 *     they queue here, and a band price change takes its turn with them;
 *  1a. W54a: a day whose windows have changed since the page read them is refused (`changed_since`). A save
 *     replaces the whole day as the page shows it, so a page loaded before someone else's save would put the day
 *     back as it was. The press sends the day's stamp as the config read answered it; under the guard nothing else
 *     can be writing the day's windows, so the stamp read here is the one the write replaces;
 *  2. every band named must still exist (the old words);
 *  3. the day's windows deleted and the new ones inserted. Nobody ever sees the day with no band or half cut: a
 *     reader sees the old windows until this commits, then the new ones. The old function did this as separate
 *     statements with a best-effort put-back, which could leave a day with no windows at all;
 *  4. the sessions the new windows re-band are locked first, in id order (W48 review L1), then re-banded by the
 *     database's own reassign_session_bands, as before: every future public session whose band was not set by hand.
 *     A bare multi-row update locks rows in the order its scan meets them; Block Day (or another save) locking the
 *     same sessions in id order could otherwise deadlock with it and fail a press;
 *  5. a `pricing.band_rules_set` audit row: who, the day, its windows before and after, how many sessions were re-banded.
 * A failure anywhere rolls all of it back: there is nothing to put back.
 */
export async function setBandRules(db: Db, dayOfWeek: unknown, rules: unknown, stamp: unknown, options: AdminWriteOptions): Promise<BandRulesRouteOutput> {
  const action = 'pricing.band_rules_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const day = dayNumber(dayOfWeek)
  const windows = checkedWindows(action, day, rules)
  return adminWrite<WindowRow[], WindowRow[], BandRulesRouteOutput>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'band_rules_day', id: String(day) },
      locks: [{ table: 'session_bands', ids: EVERY_ROW }],
      unchangedSince: { seen: stamp, now: async (tx) => rowsStamp(await tx.query<StampedRow>(DAY_WINDOW_STAMPS_SQL, [day])) },
      before: (tx) => tx.query<WindowRow>(DAY_WINDOWS_SQL, [day]),
      async change(tx, _before, held) {
        const bands = new Set(held.session_bands ?? [])
        if (windows.some((window) => !bands.has(window.bandId))) throw adminRefusal('NOT_FOUND', action, 'band_not_found', PRICING_ADMIN_WORDS.setBandRules.oneSelectedBandsNoLongerExists)

        await tx.query('DELETE FROM band_rules WHERE day_of_week = $1', [day])
        const inserted: WindowRow[] = []
        const stamped: StampedRow[] = []
        for (const window of windows) {
          const [row] = await tx.query<WindowRow & { stamp: string }>(INSERT_WINDOW_SQL, [window.bandId, day, toTimeString(window.from), toTimeString(window.to)])
          if (!row) throw new Error('A band window was not written.')
          const { stamp: rowStamp, ...written } = row
          inserted.push(written)
          stamped.push({ id: written.id, stamp: rowStamp })
        }

        const rebandedSessions = await rebandSessions(tx)
        return { after: inserted, answer: { saved: true, rebandedSessions, rules: inserted, stamp: rowsStamp(stamped) }, details: { dayOfWeek: day, rebandedSessions } }
      },
    },
    options
  )
}

/**
 * Step 4 above: lock the sessions about to change band, in id order, then let the database's own function change
 * them. The function is the rule (the nightly job and a session's own trigger read the same windows), so it is
 * called, not copied; the lock before it is what keeps its multi-row update from deadlocking.
 */
async function rebandSessions(tx: Tx): Promise<number> {
  const toChange = await tx.query<{ id: string }>(SESSIONS_TO_REBAND_SQL)
  await lockAdminRows(tx, [{ table: 'sessions', ids: toChange.map((row) => row.id) }])
  const [row] = await tx.query<{ n: number | string | null }>(REBAND_SQL)
  return Number(row?.n ?? 0)
}

// --- A membership level's terms in a band

interface TermRow {
  id: string
  membership_level: string
  band_id: string
  credit_eligible: boolean
  discount_percent: string
}
const LEVELS: readonly string[] = ['core', 'all_access']
const TERM_COLUMNS = 'id, membership_level, band_id, credit_eligible, discount_percent::text AS discount_percent'
const UPSERT_TERM_SQL = `
INSERT INTO membership_band_terms (membership_level, band_id, credit_eligible, discount_percent, updated_at)
VALUES ($1, $2::uuid, $3, $4, now())
ON CONFLICT (membership_level, band_id)
DO UPDATE SET credit_eligible = EXCLUDED.credit_eligible, discount_percent = EXCLUDED.discount_percent, updated_at = now()
RETURNING ${TERM_COLUMNS}, ${rowStampSql('membership_band_terms')} AS stamp`

/**
 * setMembershipBandTerm (`POST pricing/member-band-terms`): one membership level's terms in one band (whether the
 * account holder's seat can use a credit there, and the member discount). Manage pricing; the old checks and words;
 * a level that isn't Core or All-Access and a band that isn't there are refused in plain words (the old function
 * showed the database's own errors: W48 "For the Worker step" 8); then under the band's lock, which a term's first
 * save (no row yet) and its later ones share: the term written, and a `pricing.member_term_set` audit row.
 *
 * W54a: the credit switch and the discount are saved together, so a term that has changed since the page read it
 * is refused (`changed_since`): a page loaded before someone else's change would put their half back. The press
 * sends the term's stamp as the config read answered it, or NO_ROW_STAMP for a term with no row yet (refused if
 * someone has saved one since). Decided under the band's lock, which every save of a term in that band holds.
 */
export async function setMembershipBandTerm(db: Db, input: MemberBandTermRouteInput, options: AdminWriteOptions): Promise<MemberBandTermRouteOutput> {
  const action = 'pricing.member_term_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const words = PRICING_ADMIN_WORDS.setMembershipBandTerm
  const level = typeof input.membershipLevel === 'string' ? input.membershipLevel.trim() : ''
  const { bandId, discountPercent } = input
  if (!level) throw adminRefusal('VALIDATION', action, 'level_required', words.membershipLevelRequired, { field: 'membershipLevel' })
  if (typeof discountPercent !== 'number' || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw adminRefusal('VALIDATION', action, 'invalid_discount', words.discountPercentMustBetween0And, { field: 'discountPercent' })
  }
  if (!LEVELS.includes(level)) throw adminRefusal('VALIDATION', action, 'invalid_level', PRICING_ADMIN_NEW_WORDS.membershipLevelNotOne, { field: 'membershipLevel' })
  if (!isUuid(bandId)) throw bandGone(action)
  return adminWrite<TermRow | null, TermRow, MemberBandTermRouteOutput>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'membership_band_term', id: `${level}:${bandId}` },
      locks: [{ table: 'session_bands', ids: [bandId] }],
      unchangedSince: {
        seen: input.stamp,
        now: async (tx) => (await tx.query<{ stamp: string }>(MEMBER_TERM_STAMP_SQL, [level, bandId]))[0]?.stamp ?? NO_ROW_STAMP,
      },
      async before(tx, held) {
        if (!held.session_bands?.length) throw bandGone(action)
        // eslint-disable-next-line no-restricted-syntax -- the column list is a literal in this file; both values go in as parameters
        const [row] = await tx.query<TermRow>(`SELECT ${TERM_COLUMNS} FROM membership_band_terms WHERE membership_level = $1 AND band_id = $2::uuid`, [level, bandId])
        return row ?? null
      },
      async change(tx) {
        const [written] = await tx.query<TermRow & { stamp: string }>(UPSERT_TERM_SQL, [level, bandId, input.creditEligible === true, discountPercent])
        if (!written) throw new Error('The member band term was not written.')
        const { stamp, ...term } = written
        return { after: term, answer: { saved: true, term, stamp }, entityId: term.id }
      },
    },
    options
  )
}

// --- Postage

interface PostageRow {
  standard_price: string
  express_price: string
  free_shipping_threshold: string
}
const POSTAGE_COLUMNS = 'standard_price::text AS standard_price, express_price::text AS express_price, free_shipping_threshold::text AS free_shipping_threshold'

/**
 * setPostageSettings (`POST postage/settings`). Manage pricing; the old checks and words; then under the settings
 * row's lock (W48 review S1: the one-row table's id is a boolean, which the helper can now lock), so two saves at
 * once take turns and the second's audit row says what the first left: the three figures, and a `postage.set` audit
 * row. A table with no row (never set up) is refused in the old words.
 *
 * W54a: the three figures are saved together, so settings that have changed since the page read them are refused
 * (`changed_since`). Taking turns on the lock was not enough: the second save still wrote its own page's figures
 * over the first's (standard put up from £4.95 to £5.50 by one person; another, whose page still showed £4.95,
 * changes only express and saves: standard is £4.95 again). The press sends the row's stamp as the read answered it.
 */
export async function setPostageSettings(db: Db, input: PostageSettingsRouteInput, options: AdminWriteOptions): Promise<PostageSettingsRouteOutput> {
  const action = 'postage.set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const words = PRICING_ADMIN_WORDS.setPostageSettings
  const { standardPrice, expressPrice, freeShippingThreshold } = input
  if (!isAmount(standardPrice)) throw adminRefusal('VALIDATION', action, 'invalid_standard_price', words.standardPriceMustNonNegativeNumber, { field: 'standardPrice' })
  if (!isAmount(expressPrice)) throw adminRefusal('VALIDATION', action, 'invalid_express_price', words.expressPriceMustNonNegativeNumber, { field: 'expressPrice' })
  if (!isAmount(freeShippingThreshold)) throw adminRefusal('VALIDATION', action, 'invalid_free_shipping_threshold', words.freeShippingThresholdMustNonNegative, { field: 'freeShippingThreshold' })
  return adminWrite<PostageRow, PostageRow, PostageSettingsRouteOutput>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'postage_settings', id: 'postage_settings' },
      locks: [{ table: 'postage_settings', ids: SETTINGS_ROW }],
      unchangedSince: {
        seen: input.stamp,
        now: async (tx) => (await tx.query<{ stamp: string }>(POSTAGE_STAMP_SQL))[0]?.stamp ?? NO_ROW_STAMP,
      },
      async before(tx) {
        // eslint-disable-next-line no-restricted-syntax -- the column list is a literal in this file
        const [row] = await tx.query<PostageRow>(`SELECT ${POSTAGE_COLUMNS} FROM postage_settings WHERE id = true`)
        if (!row) throw adminRefusal('CONFLICT', action, 'postage_not_set_up', words.postageSettingsHaveNotBeenConfigured)
        return row
      },
      async change(tx) {
        const [written] = await tx.query<PostageRow & { stamp: string }>(
          // eslint-disable-next-line no-restricted-syntax -- the column list and the stamp are literals in this file; the three figures go in as parameters
          `UPDATE postage_settings SET standard_price = $1, express_price = $2, free_shipping_threshold = $3, updated_at = now() WHERE id = true RETURNING ${POSTAGE_COLUMNS}, ${rowStampSql('postage_settings')} AS stamp`,
          [standardPrice, expressPrice, freeShippingThreshold]
        )
        if (!written) throw new Error('The postage settings were held but not updated.')
        const { stamp, ...row } = written
        const answer = { standardPrice: Number.parseFloat(row.standard_price), expressPrice: Number.parseFloat(row.express_price), freeShippingThreshold: Number.parseFloat(row.free_shipping_threshold), stamp }
        return { after: row, answer }
      },
    },
    options
  )
}
