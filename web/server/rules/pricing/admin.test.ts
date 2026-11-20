import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as postageReadRoute, POST as postageRoute } from '@/app/api/v1/staff/postage/settings/route'
import { POST as bandRulesRoute } from '@/app/api/v1/staff/pricing/band-rules/[dayOfWeek]/route'
import { POST as bandPriceRoute } from '@/app/api/v1/staff/pricing/bands/[bandId]/price/route'
import { GET as configRoute } from '@/app/api/v1/staff/pricing/config/route'
import { POST as memberTermRoute } from '@/app/api/v1/staff/pricing/member-band-terms/route'
import type { Db, SqlParam, Tx } from '@/server/db'
import { ADMIN_TEST_KEY, auditRowsOf, pressRoute, type AdminAnswer } from '@/server/rules/testing/admin-routes'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { setBandRules } from './admin'
import { PRICING_ADMIN_NEW_WORDS, PRICING_ADMIN_WORDS } from './admin-failure-messages'

vi.setConfig({ testTimeout: 60_000 })

// Brief W54 items 4, 5, 8 and 11 (G-plan 5, W54's tests): the Pricing page's four write routes on the live schema.
// Every refusal in the old words, the new words for the two refusals that had none, GB8's one transaction (a failure
// part way leaves the day exactly as it was), the session lock before the re-band, the audit rows. The races, with
// two connections, are in admin-postgres.test.ts.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const JO = 'jo@example.com'
const TIA = 'tia@example.com'
const NO_PRICING = STAFF_ADMIN_WORDS.pricingStaff.youDoNotHavePermissionManage
const INACTIVE = STAFF_ADMIN_WORDS.staffAccess.staffAccountInactiveAskAdminReactivate
const BAND_GONE = PRICING_ADMIN_NEW_WORDS.bandNoLongerExists
const UNKNOWN_ID = '10000000-0000-4000-8000-000000000f4f'
const SATURDAY = 6
// 1 and 8 March 2031 are Saturdays; 29 February 2020 was one.
const SAT = '2031-03-01'

let database: TestDatabase
let db: Db
let jo = ''
let core = ''
let peak = ''
let afternoon = ''
let evening = ''
let byHand = ''
let past = ''
let privateHire = ''

beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())

/**
 * Jo with Manage pricing and Tia without; Core £20 until 17:00 and Peak £25.50 after, every day; a public Sauna on a
 * Saturday at 14:00 (Core) and 18:00 (Peak), one at 14:00 the next Saturday whose band was set by hand, one in the
 * past, and a private hire; Core's term in Peak (no credit, 15% off); postage £4.95, £9.95, free from £50.
 */
beforeEach(async () => {
  await database.pg.exec('RESET ROLE; TRUNCATE audit_log, api_idempotency, sessions, service_types, membership_band_terms, band_rules, session_bands, postage_settings, staff CASCADE; SET ROLE paddock_worker;')
  jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  await insert(db, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: TIA })
  core = await insert(db, 'session_bands', { code: 'core', name: 'Core', price: '20.00' })
  peak = await insert(db, 'session_bands', { code: 'peak', name: 'Peak', price: '25.50' })
  for (let day = 0; day <= 6; day++) {
    await insert(db, 'band_rules', { band_id: core, day_of_week: day, from_time: '00:00', to_time: '17:00' })
    await insert(db, 'band_rules', { band_id: peak, day_of_week: day, from_time: '17:00', to_time: '24:00' })
  }
  const sauna = await insert(db, 'service_types', { name: 'Sauna', booking_type: 'public' })
  const hire = await insert(db, 'service_types', { name: 'Private Hire', booking_type: 'private' })
  const session = (start: string, more: Record<string, unknown> = {}) =>
    insert(db, 'sessions', { service_type_id: sauna, start_time: `${start}:00+00`, end_time: `${start.slice(0, 13)}:59:00+00`, type: 'public', capacity: 10, band_id: core, ...more })
  afternoon = await session(`${SAT} 14:00`)
  evening = await session(`${SAT} 18:00`, { band_id: peak })
  byHand = await session('2031-03-08 14:00', { band_overridden: true })
  past = await session('2020-02-29 14:00')
  privateHire = await session(`${SAT} 15:00`, { service_type_id: hire, type: 'private' })
  await insert(db, 'membership_band_terms', { membership_level: 'core', band_id: peak, credit_eligible: false, discount_percent: '15.00' })
  await db.query("INSERT INTO postage_settings (standard_price, express_price, free_shipping_threshold) VALUES ('4.95', '9.95', '50.00')")
})

const bandOf = async (session: string) => (await db.query<{ band_id: string }>('SELECT band_id FROM sessions WHERE id = $1', [session]))[0]?.band_id
const price = async (band: string) => (await db.query<{ price: string }>('SELECT price::text AS price FROM session_bands WHERE id = $1', [band]))[0]?.price
interface WindowRow {
  id: string
  band_id: string
  from_time: string
  to_time: string
}
const windowsOf = (day: number) => db.query<WindowRow>('SELECT id, band_id, from_time::text AS from_time, to_time::text AS to_time FROM band_rules WHERE day_of_week = $1 ORDER BY from_time', [day])
const refusedWith = (answer: AdminAnswer) => ({ status: answer.status, reason: answer.reason, words: answer.error?.message })
/** One change to Jo's staff row. Test data only: each `set` is a literal in this file. */
// eslint-disable-next-line no-restricted-syntax -- test data only: every `set` is a literal written in this file; the id goes in as a parameter
const joIs = (set: string) => db.query(`UPDATE staff SET ${set} WHERE id = $1`, [jo])

const setPrice = (bandId: string, to: unknown, email = JO, key?: string) => pressRoute<{ updated: boolean; band?: { id: string; code: string; name: string; price: string } }>(bandPriceRoute, 'POST', { email, params: { bandId }, body: { price: to }, ...(key !== undefined ? { key } : {}) })
// W54a: what the Pricing page holds after a load, read by Jo through the page's own two reads. Each save sends back
// the stamp its read answered.
interface ConfigPage {
  bandRules: Array<{ id: string; band_id: string; day_of_week: number; from_time: string; to_time: string }>
  bandRulesStamps: string[]
  membershipTerms: Array<{ id: string; membership_level: string; band_id: string; credit_eligible: boolean; discount_percent: string; stamp: string }>
}
interface PostagePage {
  standardPrice: number
  expressPrice: number
  freeShippingThreshold: number
  stamp: string
}
const configPage = async () => (await pressRoute<ConfigPage>(configRoute, 'GET', { email: JO })).data
const postagePage = async () => (await pressRoute<PostagePage>(postageReadRoute, 'GET', { email: JO })).data
const dayStamp = async (day: unknown) => (await configPage())?.bandRulesStamps[Number(day)]
/** A term's stamp on the page; 'none' (NO_ROW_STAMP) for a term the page has no row for. */
const termStamp = async (level: unknown, bandId: unknown) => {
  const config = await configPage()
  if (!config) return undefined
  return config.membershipTerms.find((one) => one.membership_level === (typeof level === 'string' ? level.trim() : level) && one.band_id === bandId)?.stamp ?? 'none'
}

type RulesSaved = { saved: boolean; rebandedSessions: number; rules: WindowRow[]; stamp: string }
type TermSaved = { saved: boolean; term: Record<string, unknown>; stamp: string }
type PostageSaved = { standardPrice: number; expressPrice: number; freeShippingThreshold: number; stamp: string }
/** Each save exactly as sent: no stamp unless one is given. */
const setRulesAsSent = (day: unknown, rules: unknown, stamp?: unknown, email = JO) => pressRoute<RulesSaved>(bandRulesRoute, 'POST', { email, params: { dayOfWeek: String(day) }, body: stamp === undefined ? { rules } : { rules, stamp } })
const setTermAsSent = (body: unknown, email = JO) => pressRoute<TermSaved>(memberTermRoute, 'POST', { email, body })
const setPostageAsSent = (body: unknown, email = JO) => pressRoute<PostageSaved>(postageRoute, 'POST', { email, body })
/** Each save as the page presses it (W54a): with the stamp from a read made just before, unless the body brings its own. */
const setRules = async (day: unknown, rules: unknown, email = JO) => setRulesAsSent(day, rules, await dayStamp(day), email)
const setTerm = async (body: Record<string, unknown>, email = JO) => setTermAsSent('stamp' in body ? body : { ...body, stamp: await termStamp(body['membershipLevel'], body['bandId']) }, email)
const setPostage = async (body: object, email = JO) => setPostageAsSent('stamp' in body ? body : { ...body, stamp: (await postagePage())?.stamp }, email)

const recut = () => [{ bandId: peak, fromTime: '12:00', toTime: '24:00' }, { bandId: core, fromTime: '00:00', toTime: '12:00' }]
const term = () => ({ membershipLevel: 'core', bandId: peak, creditEligible: false, discountPercent: 20 })
const postage = { standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60 }

describe('who may: Manage pricing, from the signed-in staff member, in the old words', () => {
  /** The four presses, one after another (the test database is one connection). */
  const presses = async (email: string) => [await setPrice(core, 22, email), await setRules(SATURDAY, recut(), email), await setTerm(term(), email), await setPostage(postage, email)]

  it('without Manage pricing each of the four is refused, and nothing is written', async () => {
    for (const refused of await presses(TIA)) expect(refusedWith(refused)).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    expect(await price(core)).toBe('20.00')
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('an inactive account and a sign-in with no staff row are refused by the staff check, in its own words (S3)', async () => {
    await joIs('active = false')
    for (const refused of await presses(JO)) expect([refused.status, refused.error?.message]).toEqual([403, INACTIVE])
    for (const refused of await presses('nobody@example.com')) {
      expect([refused.status, refused.error?.message]).toEqual([401, "No staff record matches the logged-in user's email (nobody@example.com). Ask an admin to add you as staff before performing this action."])
    }
  })

  it('the permission is refused before a bad value is looked at', async () => {
    expect((await setPrice(core, -1, TIA)).reason).toBe('no_pricing_permission')
    expect((await setRules(9, 'all day', TIA)).reason).toBe('no_pricing_permission')
  })
})

describe('POST pricing/bands/:bandId/price (setBandPrice)', () => {
  it('sets the price and records who, with the band before and after', async () => {
    const key = crypto.randomUUID()
    const answer = await setPrice(core, 22.5, JO, key)
    expect(answer.data).toEqual({ updated: true, band: { id: core, code: 'core', name: 'Core', price: '22.50' } })
    expect((await setPrice(peak, 0)).data).toEqual({ updated: true, band: { id: peak, code: 'peak', name: 'Peak', price: '0.00' } })
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.actor_id, row.entity_type, row.entity_id])).toEqual([['pricing.band_price_set', jo, 'session_band', core], ['pricing.band_price_set', jo, 'session_band', peak]])
    expect(rows[0]?.details).toEqual({ before: { id: core, code: 'core', name: 'Core', price: '20.00' }, after: { id: core, code: 'core', name: 'Core', price: '22.50' }, key })
  })

  it('refuses a price that is not a number of 0 or more, in the old words', async () => {
    const words = PRICING_ADMIN_WORDS.setBandPrice.priceMustValidNonNegativeAmount
    // A NaN reaches the Worker as null: JSON has no other way to send it.
    for (const bad of [-1, null, '22', undefined]) expect(refusedWith(await setPrice(core, bad)), String(bad)).toEqual({ status: 400, reason: 'invalid_price', words })
    expect(await price(core)).toBe('20.00')
  })

  it('a band that is not there is refused with words (brief item 11: the old function answered `updated: false` and nothing else)', async () => {
    expect(refusedWith(await setPrice(UNKNOWN_ID, 22))).toEqual({ status: 404, reason: 'band_not_found', words: BAND_GONE })
    expect(refusedWith(await setPrice('not-an-id', 22))).toEqual({ status: 404, reason: 'band_not_found', words: BAND_GONE })
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('the same press again is answered from the first, though the price changed in between', async () => {
    const key = crypto.randomUUID()
    await setPrice(core, 22, JO, key)
    await setPrice(core, 30)
    const again = await setPrice(core, 22, JO, key)
    expect(again.replayed).toBe(true)
    expect(await price(core)).toBe('30.00')
    expect(await auditRowsOf(db)).toHaveLength(2)
  })
})

describe('POST pricing/band-rules/:dayOfWeek (setBandRules, GB8)', () => {
  it("replaces the day's windows (sent in any order), re-bands the future public sessions not set by hand, and records it", async () => {
    const before = await windowsOf(SATURDAY)
    const answer = await setRules(SATURDAY, recut())
    expect(answer.status).toBe(200)
    expect(answer.data?.saved).toBe(true)
    expect(answer.data?.rules.map((row) => [row.band_id, row.from_time, row.to_time])).toEqual([[core, '00:00:00', '12:00:00'], [peak, '12:00:00', '24:00:00']])
    expect((await windowsOf(SATURDAY)).map((row) => [row.band_id, row.from_time, row.to_time])).toEqual([[core, '00:00:00', '12:00:00'], [peak, '12:00:00', '24:00:00']])
    // Saturday 14:00 moves from Core to Peak: one session. 18:00 was Peak already; the one set by hand, the one in the
    // past and the private hire are left alone.
    expect(answer.data?.rebandedSessions).toBe(1)
    expect(await bandOf(afternoon)).toBe(peak)
    expect(await bandOf(evening)).toBe(peak)
    expect(await bandOf(byHand)).toBe(core)
    expect(await bandOf(past)).toBe(core)
    expect(await bandOf(privateHire)).toBe(core)
    // Every other day is untouched.
    expect((await windowsOf(5)).map((row) => row.to_time)).toEqual(['17:00:00', '24:00:00'])

    const [row] = await auditRowsOf(db)
    expect(row).toMatchObject({ action: 'pricing.band_rules_set', actor_id: jo, entity_type: 'band_rules_day', entity_id: '6' })
    expect(row?.details['dayOfWeek']).toBe(6)
    expect(row?.details['rebandedSessions']).toBe(1)
    expect(row?.details.before).toEqual(before)
    expect(row?.details.after).toEqual(answer.data?.rules)
  })

  it('refuses each bad save in the old order and words, and changes nothing', async () => {
    const words = PRICING_ADMIN_WORDS.setBandRules
    const whole = [{ bandId: core, fromTime: '00:00', toTime: '24:00' }]
    const tries: Array<[unknown, unknown, string]> = [
      [7, whole, words.dayWeekMustWholeNumberFrom],
      [2.5, whole, words.dayWeekMustWholeNumberFrom],
      [-1, whole, words.dayWeekMustWholeNumberFrom],
      ['saturday', whole, words.dayWeekMustWholeNumberFrom],
      [SATURDAY, [], words.atLeastOneBandWindowRequired],
      [SATURDAY, 'all day', words.atLeastOneBandWindowRequired],
      [SATURDAY, undefined, words.atLeastOneBandWindowRequired],
      [SATURDAY, [{ bandId: core, fromTime: 'noon', toTime: '24:00' }], words.windowTimesMustValidHhMm],
      [SATURDAY, [{ bandId: core, fromTime: 0, toTime: '24:00' }], words.windowTimesMustValidHhMm],
      [SATURDAY, [{ bandId: core, fromTime: '12:00', toTime: '12:00' }], words.eachWindowMustEndAfterIt],
      [SATURDAY, [{ bandId: core, fromTime: '00:00', toTime: '25:00' }], words.windowTimesMustFallWithinDay],
      [SATURDAY, [{ bandId: core, fromTime: '06:00', toTime: '24:00' }], words.firstWindowMustStartAt00],
      [SATURDAY, [{ bandId: core, fromTime: '00:00', toTime: '12:00' }, { bandId: peak, fromTime: '13:00', toTime: '24:00' }], words.windowsHaveGapOrOverlapEvery],
      [SATURDAY, [{ bandId: core, fromTime: '00:00', toTime: '13:00' }, { bandId: peak, fromTime: '12:00', toTime: '24:00' }], words.windowsHaveGapOrOverlapEvery],
      [SATURDAY, [{ bandId: core, fromTime: '00:00', toTime: '22:00' }], words.lastWindowMustEndAt24],
      [SATURDAY, [{ bandId: UNKNOWN_ID, fromTime: '00:00', toTime: '24:00' }], words.oneSelectedBandsNoLongerExists],
      [SATURDAY, [{ fromTime: '00:00', toTime: '24:00' }], words.oneSelectedBandsNoLongerExists],
    ]
    const before = await windowsOf(SATURDAY)
    for (const [day, rules, sentence] of tries) expect((await setRules(day, rules)).error?.message, JSON.stringify([day, rules])).toBe(sentence)
    expect(await windowsOf(SATURDAY)).toEqual(before)
    expect(await bandOf(afternoon)).toBe(core)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('a save that fails part way changes nothing at all: the day keeps its own windows, no session is re-banded, nothing is recorded (GB8)', async () => {
    const before = await windowsOf(SATURDAY)
    // The second new window's insert fails, after the day's old windows were deleted and the first new one went in.
    await database.pg.exec(
      `RESET ROLE;
       CREATE OR REPLACE FUNCTION public.fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'connection lost'; END $$;
       CREATE TRIGGER fail_write BEFORE INSERT ON public.band_rules FOR EACH ROW WHEN (NEW.from_time = '12:00') EXECUTE FUNCTION public.fail_write();
       SET ROLE paddock_worker;`
    )
    try {
      const failed = await setRules(SATURDAY, recut())
      expect(failed.status).toBe(500)
    } finally {
      await database.pg.exec('RESET ROLE; DROP TRIGGER fail_write ON public.band_rules; SET ROLE paddock_worker;')
    }
    // The same rows, by id: never deleted and put back.
    expect(await windowsOf(SATURDAY)).toEqual(before)
    expect(await bandOf(afternoon)).toBe(core)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('a failure after the windows are in, while re-banding, rolls the windows back too', async () => {
    const before = await windowsOf(SATURDAY)
    await database.pg.exec(
      `RESET ROLE;
       CREATE OR REPLACE FUNCTION public.fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'connection lost'; END $$;
       CREATE TRIGGER fail_write BEFORE UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.fail_write();
       SET ROLE paddock_worker;`
    )
    try {
      expect((await setRules(SATURDAY, recut())).status).toBe(500)
    } finally {
      await database.pg.exec('RESET ROLE; DROP TRIGGER fail_write ON public.sessions; SET ROLE paddock_worker;')
    }
    expect(await windowsOf(SATURDAY)).toEqual(before)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('takes its locks in order: the band guard first, then the windows, then the sessions it re-bands (in id order) before the re-band', async () => {
    const seen: Array<{ sql: string; params: readonly SqlParam[] }> = []
    const watching = <T extends { query: Db['query'] }>(target: T): T =>
      new Proxy(target, {
        get(inner, property, receiver) {
          if (property === 'query') {
            return (sql: string, params: readonly SqlParam[] = []) => {
              seen.push({ sql: sql.trim().replace(/\s+/g, ' '), params })
              return inner.query(sql, params)
            }
          }
          if (property === 'transaction') return <R>(fn: (tx: Tx) => Promise<R>) => (inner as unknown as Db).transaction((tx) => fn(watching(tx)))
          return Reflect.get(inner, property, receiver) as unknown
        },
      })
    // A second session the save re-bands, so the lock has an order to keep.
    const sauna = (await db.query<{ service_type_id: string }>('SELECT service_type_id FROM sessions WHERE id = $1', [afternoon]))[0]?.service_type_id as string
    const second = await insert(db, 'sessions', { service_type_id: sauna, start_time: `${SAT} 13:00:00+00`, end_time: `${SAT} 13:59:00+00`, type: 'public', capacity: 10, band_id: core })
    const by = { actor: { type: 'staff' as const, id: jo, role: 'admin' as const, canManagePricing: true, canIssueRefunds: true }, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() }
    const answer = await setBandRules(watching(db), SATURDAY, recut(), await dayStamp(SATURDAY), by)
    expect(answer.rebandedSessions).toBe(2)

    const at = (starts: string) => seen.findIndex((one) => one.sql.startsWith(starts))
    expect(seen[0]?.sql).toBe('SELECT id FROM session_bands ORDER BY id FOR NO KEY UPDATE')
    const deleted = at('DELETE FROM band_rules')
    // W54a: the day's stamp is read under the band guard, before the day's windows are deleted.
    const stamped = seen.findIndex((one) => one.sql.includes('AS stamp FROM band_rules r WHERE r.day_of_week = $1'))
    expect(stamped).toBeGreaterThan(0)
    expect(stamped).toBeLessThan(deleted)
    const locked = at('SELECT id FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE')
    // W51 (W50 review L3): the re-band is from London's wall clock now, never the real now() (reband-london-now.test.ts).
    const rebanded = at("SELECT reassign_session_bands(((now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC'))")
    expect(deleted).toBeGreaterThan(0)
    expect(locked).toBeGreaterThan(deleted)
    expect(rebanded).toBeGreaterThan(locked)
    // Exactly the two sessions about to change band, in id order; never the one set by hand, the past one or the private hire.
    expect(seen[locked]?.params[0]).toEqual([afternoon, second].sort())
  })

  it('a save that changes no session locks none, and says 0', async () => {
    // Saturday re-cut at 15:00: the 14:00 session stays Core, the 18:00 one stays Peak.
    const answer = await setRules(SATURDAY, [{ bandId: core, fromTime: '00:00', toTime: '15:00' }, { bandId: peak, fromTime: '15:00', toTime: '24:00' }])
    expect(answer.data?.rebandedSessions).toBe(0)
    expect(await bandOf(afternoon)).toBe(core)
  })
})

describe('POST pricing/member-band-terms (setMembershipBandTerm)', () => {
  it('changes a term that is there and makes one that is not, and records each with what was there before', async () => {
    const changed = await setTerm(term())
    expect(changed.data).toMatchObject({ saved: true, term: { membership_level: 'core', band_id: peak, credit_eligible: false, discount_percent: '20.00' } })
    const made = await setTerm({ membershipLevel: ' all_access ', bandId: peak, creditEligible: true, discountPercent: 0 })
    expect(made.data).toMatchObject({ saved: true, term: { membership_level: 'all_access', band_id: peak, credit_eligible: true, discount_percent: '0.00' } })
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.entity_type])).toEqual([['pricing.member_term_set', 'membership_band_term'], ['pricing.member_term_set', 'membership_band_term']])
    expect(rows[0]?.details.before).toMatchObject({ membership_level: 'core', discount_percent: '15.00' })
    expect(rows[0]?.details.after).toMatchObject({ membership_level: 'core', discount_percent: '20.00' })
    expect(rows[1]?.details.before).toBeNull()
    expect(rows[1]?.details.after).toMatchObject({ membership_level: 'all_access', credit_eligible: true })
    expect(rows[1]?.entity_id).toBe(made.data?.term['id'])
  })

  it('refuses in the old words, and in plain words where the old function showed the database\'s own', async () => {
    const words = PRICING_ADMIN_WORDS.setMembershipBandTerm
    const tries: Array<[Record<string, unknown>, number, string, string]> = [
      [{ ...term(), membershipLevel: '   ' }, 400, 'level_required', words.membershipLevelRequired],
      [{ ...term(), membershipLevel: undefined }, 400, 'level_required', words.membershipLevelRequired],
      [{ ...term(), discountPercent: -1 }, 400, 'invalid_discount', words.discountPercentMustBetween0And],
      [{ ...term(), discountPercent: 101 }, 400, 'invalid_discount', words.discountPercentMustBetween0And],
      [{ ...term(), discountPercent: null }, 400, 'invalid_discount', words.discountPercentMustBetween0And],
      // New words: the old function showed "…violates check constraint…" and "…violates foreign key constraint…".
      [{ ...term(), membershipLevel: 'gold' }, 400, 'invalid_level', PRICING_ADMIN_NEW_WORDS.membershipLevelNotOne],
      [{ ...term(), bandId: UNKNOWN_ID }, 404, 'band_not_found', BAND_GONE],
      [{ ...term(), bandId: 'not-an-id' }, 404, 'band_not_found', BAND_GONE],
    ]
    for (const [body, status, reason, sentence] of tries) expect(refusedWith(await setTerm(body)), reason).toEqual({ status, reason, words: sentence })
    expect((await db.query<{ discount_percent: string }>('SELECT discount_percent::text AS discount_percent FROM membership_band_terms')).map((row) => row.discount_percent)).toEqual(['15.00'])
    expect(await auditRowsOf(db)).toEqual([])
  })
})

describe('POST postage/settings (setPostageSettings)', () => {
  it('saves the three figures and records who, with the figures before and after', async () => {
    expect((await setPostage(postage)).data).toMatchObject({ standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60 })
    // 0 means no free shipping.
    expect((await setPostage({ standardPrice: 0, expressPrice: 9.95, freeShippingThreshold: 0 })).data).toMatchObject({ standardPrice: 0, expressPrice: 9.95, freeShippingThreshold: 0 })
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.actor_id, row.entity_type])).toEqual([['postage.set', jo, 'postage_settings'], ['postage.set', jo, 'postage_settings']])
    expect(rows[0]?.details.before).toEqual({ standard_price: '4.95', express_price: '9.95', free_shipping_threshold: '50.00' })
    expect(rows[0]?.details.after).toEqual({ standard_price: '5.50', express_price: '11.00', free_shipping_threshold: '60.00' })
    expect(rows[1]?.details.before).toEqual(rows[0]?.details.after)
  })

  it('refuses each figure that is not a number of 0 or more, in the old words, first one first', async () => {
    const words = PRICING_ADMIN_WORDS.setPostageSettings
    expect(refusedWith(await setPostage({ ...postage, standardPrice: -1 }))).toEqual({ status: 400, reason: 'invalid_standard_price', words: words.standardPriceMustNonNegativeNumber })
    expect(refusedWith(await setPostage({ ...postage, expressPrice: null }))).toEqual({ status: 400, reason: 'invalid_express_price', words: words.expressPriceMustNonNegativeNumber })
    expect(refusedWith(await setPostage({ ...postage, freeShippingThreshold: -5 }))).toEqual({ status: 400, reason: 'invalid_free_shipping_threshold', words: words.freeShippingThresholdMustNonNegative })
    expect(refusedWith(await setPostage({}))).toEqual({ status: 400, reason: 'invalid_standard_price', words: words.standardPriceMustNonNegativeNumber })
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('a table with no row is refused in the old words', async () => {
    await database.pg.exec('RESET ROLE; DELETE FROM postage_settings; SET ROLE paddock_worker;')
    expect(refusedWith(await setPostage(postage))).toEqual({ status: 409, reason: 'postage_not_set_up', words: PRICING_ADMIN_WORDS.setPostageSettings.postageSettingsHaveNotBeenConfigured })
  })
})

describe('the words for the refusals that had none (brief item 11)', () => {
  it('are these two sentences, and neither is an old one', () => {
    expect(PRICING_ADMIN_NEW_WORDS).toEqual({
      bandNoLongerExists: 'That band no longer exists. Reload the page and try again.',
      membershipLevelNotOne: 'Membership level must be Core or All-Access.',
    })
    const old = Object.values(PRICING_ADMIN_WORDS).flatMap((group) => Object.values(group) as string[])
    for (const sentence of Object.values(PRICING_ADMIN_NEW_WORDS)) expect(old).not.toContain(sentence)
  })
})

// W54a (W49 + W54 review S1; the lead's call: one step G rule). Postage, a member term and a day's windows are each
// saved whole, as the page shows them, so a page loaded before someone else's change would put the old values back.
// Each save sends the stamp its read answered, and is refused under its lock when the row has changed since.
describe('a save from a page loaded before someone else\'s change is refused (W54a)', () => {
  const CHANGED_SINCE = { status: 409, reason: 'changed_since', words: 'This was changed by someone else since the page loaded. The page has been reloaded: check it and save again.' }
  const postageRow = async () => (await db.query<Record<string, string>>('SELECT standard_price::text AS standard_price, express_price::text AS express_price, free_shipping_threshold::text AS free_shipping_threshold FROM postage_settings'))[0]
  const termRow = async (level = 'core', band = peak) => (await db.query<{ credit_eligible: boolean; discount_percent: string }>('SELECT credit_eligible, discount_percent::text AS discount_percent FROM membership_band_terms WHERE membership_level = $1 AND band_id = $2', [level, band]))[0]

  describe('postage', () => {
    it("the reviewer's example: A puts standard up from £4.95 to £5.50; B, whose page still shows £4.95, changes only express and saves: refused, and standard stays £5.50", async () => {
      const pageA = await postagePage()
      const pageB = await postagePage()
      expect(pageB).toMatchObject({ standardPrice: 4.95, expressPrice: 9.95, freeShippingThreshold: 50 })
      expect((await setPostageAsSent({ standardPrice: 5.5, expressPrice: pageA?.expressPrice, freeShippingThreshold: pageA?.freeShippingThreshold, stamp: pageA?.stamp })).status).toBe(200)
      const auditAfterA = await auditRowsOf(db)

      // B's three boxes as B's page loaded them, with express changed.
      expect(refusedWith(await setPostageAsSent({ standardPrice: pageB?.standardPrice, expressPrice: 11, freeShippingThreshold: pageB?.freeShippingThreshold, stamp: pageB?.stamp }))).toEqual(CHANGED_SINCE)
      expect(await postageRow()).toEqual({ standard_price: '5.50', express_price: '9.95', free_shipping_threshold: '50.00' })
      expect(await auditRowsOf(db)).toEqual(auditAfterA)

      // B's page reloads: it shows £5.50, and B's express change is saved beside it.
      const reloaded = await postagePage()
      expect(reloaded).toMatchObject({ standardPrice: 5.5, expressPrice: 9.95 })
      expect((await setPostageAsSent({ standardPrice: reloaded?.standardPrice, expressPrice: 11, freeShippingThreshold: reloaded?.freeShippingThreshold, stamp: reloaded?.stamp })).status).toBe(200)
      expect(await postageRow()).toEqual({ standard_price: '5.50', express_price: '11.00', free_shipping_threshold: '50.00' })
      expect(await auditRowsOf(db)).toHaveLength(2)
    })

    it("a save's answer carries the new stamp, which is the read's; a press with no stamp, or with one that is not the read's text, is refused and writes nothing", async () => {
      const page = await postagePage()
      const saved = await setPostageAsSent({ ...postage, stamp: page?.stamp })
      expect(saved.data).toEqual({ standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 60, stamp: (await postagePage())?.stamp })
      expect(saved.data?.stamp).not.toBe(page?.stamp)
      // The page saves again with the answer's stamp, with no read in between.
      expect((await setPostageAsSent({ ...postage, expressPrice: 12, stamp: saved.data?.stamp })).status).toBe(200)
      const before = await postageRow()
      for (const sent of [postage, { ...postage, stamp: null }, { ...postage, stamp: '' }, { ...postage, stamp: 1 }, { ...postage, stamp: 'none' }, { ...postage, stamp: page?.stamp }, { ...postage, stamp: saved.data?.stamp }]) {
        expect(refusedWith(await setPostageAsSent(sent)), JSON.stringify(sent)).toEqual(CHANGED_SINCE)
      }
      expect(await postageRow()).toEqual(before)
      expect(await auditRowsOf(db)).toHaveLength(2)
    })

    it('a figure that is not a number is refused in the old words before the stamp is looked at, and Manage pricing before both', async () => {
      const page = await postagePage()
      await setPostage(postage)
      expect((await setPostageAsSent({ ...postage, standardPrice: -1, stamp: page?.stamp })).reason).toBe('invalid_standard_price')
      expect((await setPostageAsSent({ ...postage, stamp: page?.stamp }, TIA)).reason).toBe('no_pricing_permission')
    })
  })

  describe('a member term', () => {
    it("B switches Core's credit on in Peak; A, whose page still shows it off, changes only the discount and saves: refused, and the credit stays on", async () => {
      const stampA = await termStamp('core', peak)
      const stampB = await termStamp('core', peak)
      expect((await setTermAsSent({ membershipLevel: 'core', bandId: peak, creditEligible: true, discountPercent: 15, stamp: stampB })).status).toBe(200)
      const auditAfterB = await auditRowsOf(db)

      expect(refusedWith(await setTermAsSent({ membershipLevel: 'core', bandId: peak, creditEligible: false, discountPercent: 20, stamp: stampA }))).toEqual(CHANGED_SINCE)
      expect(await termRow()).toEqual({ credit_eligible: true, discount_percent: '15.00' })
      expect(await auditRowsOf(db)).toEqual(auditAfterB)

      // A's page reloads: the credit shows on, and A's discount is saved beside it.
      const saved = await setTermAsSent({ membershipLevel: 'core', bandId: peak, creditEligible: true, discountPercent: 20, stamp: await termStamp('core', peak) })
      expect(saved.status).toBe(200)
      expect(await termRow()).toEqual({ credit_eligible: true, discount_percent: '20.00' })
      // The answer's stamp is the read's, and the next save with it goes through with no read in between.
      expect(saved.data?.stamp).toBe(await termStamp('core', peak))
      expect((await setTermAsSent({ membershipLevel: 'core', bandId: peak, creditEligible: true, discountPercent: 25, stamp: saved.data?.stamp })).status).toBe(200)
      expect(refusedWith(await setTermAsSent({ membershipLevel: 'core', bandId: peak, creditEligible: true, discountPercent: 30, stamp: saved.data?.stamp }))).toEqual(CHANGED_SINCE)
    })

    it("a term with no row yet is saved from a page that saw none ('none'); a second first save from another page that saw none is refused", async () => {
      expect(await termStamp('all_access', peak)).toBe('none')
      // The planted bugs showed this was not held: with no row there, any text sent as the stamp was taken as right.
      // Only the stamp of no row is: a page holding another row's stamp, or a row's that has since gone, is out of date.
      const anotherRows = await termStamp('core', peak)
      for (const sent of [anotherRows, 'anything', 'undefined', 'null']) {
        expect(refusedWith(await setTermAsSent({ membershipLevel: 'all_access', bandId: peak, creditEligible: true, discountPercent: 0, stamp: sent })), String(sent)).toEqual(CHANGED_SINCE)
      }
      expect(await termRow('all_access')).toBeUndefined()
      expect(await auditRowsOf(db)).toEqual([])
      const first = await setTermAsSent({ membershipLevel: 'all_access', bandId: peak, creditEligible: true, discountPercent: 0, stamp: 'none' })
      expect(first.status).toBe(200)
      expect(first.data?.stamp).toBe(await termStamp('all_access', peak))
      expect(refusedWith(await setTermAsSent({ membershipLevel: 'all_access', bandId: peak, creditEligible: false, discountPercent: 50, stamp: 'none' }))).toEqual(CHANGED_SINCE)
      expect(await termRow('all_access')).toEqual({ credit_eligible: true, discount_percent: '0.00' })
      expect(await auditRowsOf(db)).toHaveLength(1)
    })

    it('a press with no stamp is refused; another term, a band price and a window save leave this term\'s page up to date', async () => {
      const before = await termRow()
      for (const sent of [term(), { ...term(), stamp: null }, { ...term(), stamp: '' }, { ...term(), stamp: 'none' }]) expect(refusedWith(await setTermAsSent(sent)), JSON.stringify(sent)).toEqual(CHANGED_SINCE)
      expect(await termRow()).toEqual(before)
      expect(await auditRowsOf(db)).toEqual([])

      const stamp = await termStamp('core', peak)
      // Core's term in the Core band (same level), All-Access's in Peak (same band), Peak's price, Saturday's windows.
      expect((await setTerm({ membershipLevel: 'core', bandId: core, creditEligible: true, discountPercent: 0 })).status).toBe(200)
      expect((await setTerm({ membershipLevel: 'all_access', bandId: peak, creditEligible: true, discountPercent: 0 })).status).toBe(200)
      expect((await setPrice(peak, 27)).status).toBe(200)
      expect((await setRules(SATURDAY, recut())).status).toBe(200)
      expect((await setTermAsSent({ ...term(), stamp })).status).toBe(200)
    })
  })

  describe("a day's band windows", () => {
    const earlier = () => [{ bandId: core, fromTime: '00:00', toTime: '15:00' }, { bandId: peak, fromTime: '15:00', toTime: '24:00' }]

    it("B re-cuts Saturday at 12:00; A, whose page still shows 17:00, saves Saturday at 15:00: refused, and Saturday stays as B left it", async () => {
      const stampA = await dayStamp(SATURDAY)
      const stampB = await dayStamp(SATURDAY)
      expect((await setRulesAsSent(SATURDAY, recut(), stampB)).status).toBe(200)
      const afterB = await windowsOf(SATURDAY)
      const auditAfterB = await auditRowsOf(db)
      expect(await bandOf(afternoon)).toBe(peak)

      expect(refusedWith(await setRulesAsSent(SATURDAY, earlier(), stampA))).toEqual(CHANGED_SINCE)
      // The same rows, by id: not deleted and made again. The 14:00 session is still Peak, and nothing is recorded.
      expect(await windowsOf(SATURDAY)).toEqual(afterB)
      expect(await bandOf(afternoon)).toBe(peak)
      expect(await auditRowsOf(db)).toEqual(auditAfterB)

      // A's page reloads, and A's save goes through.
      const saved = await setRulesAsSent(SATURDAY, earlier(), await dayStamp(SATURDAY))
      expect(saved.status).toBe(200)
      expect(await bandOf(afternoon)).toBe(core)
      // The answer's stamp is the read's, and the next save with it goes through with no read in between.
      expect(saved.data?.stamp).toBe(await dayStamp(SATURDAY))
      expect((await setRulesAsSent(SATURDAY, recut(), saved.data?.stamp)).status).toBe(200)
      expect(refusedWith(await setRulesAsSent(SATURDAY, earlier(), saved.data?.stamp))).toEqual(CHANGED_SINCE)
    })

    it('a save of the very windows the day already has still makes new rows, so an older page is refused after it', async () => {
      const stamp = await dayStamp(SATURDAY)
      const same = [{ bandId: core, fromTime: '00:00', toTime: '17:00' }, { bandId: peak, fromTime: '17:00', toTime: '24:00' }]
      expect((await setRulesAsSent(SATURDAY, same, stamp)).status).toBe(200)
      expect(await dayStamp(SATURDAY)).not.toBe(stamp)
      expect(refusedWith(await setRulesAsSent(SATURDAY, earlier(), stamp))).toEqual(CHANGED_SINCE)
    })

    it("each day has its own stamp: another day's save, a band price and a member term leave this day's page up to date; a press with no stamp is refused", async () => {
      const config = await configPage()
      expect(config?.bandRulesStamps).toHaveLength(7)
      expect(new Set(config?.bandRulesStamps).size).toBe(7)
      // A day's stamp is made from that day's own rows, and a window is not sent with a stamp of its own.
      for (let day = 0; day <= 6; day++) {
        for (const rule of config?.bandRules ?? []) expect(config?.bandRulesStamps[day]?.includes(rule.id), `${day} ${rule.id}`).toBe(rule.day_of_week === day)
      }
      expect(Object.keys(config?.bandRules[0] ?? {}).sort()).toEqual(['band_id', 'day_of_week', 'from_time', 'id', 'to_time'])

      const saturday = config?.bandRulesStamps[SATURDAY]
      expect((await setRules(5, recut())).status).toBe(200)
      expect((await setPrice(core, 21)).status).toBe(200)
      expect((await setTerm(term())).status).toBe(200)
      expect(await dayStamp(SATURDAY)).toBe(saturday)

      const before = await windowsOf(SATURDAY)
      for (const sent of [undefined, null, '', 'none', config?.bandRulesStamps[5]]) expect(refusedWith(await setRulesAsSent(SATURDAY, recut(), sent)), String(sent)).toEqual(CHANGED_SINCE)
      expect(await windowsOf(SATURDAY)).toEqual(before)
      expect((await setRulesAsSent(SATURDAY, recut(), saturday)).status).toBe(200)
    })

    it("a day with no windows yet has the stamp 'none', and its first save is made with it", async () => {
      await database.pg.exec('RESET ROLE; DELETE FROM band_rules WHERE day_of_week = 3; SET ROLE paddock_worker;')
      expect(await dayStamp(3)).toBe('none')
      expect((await setRulesAsSent(3, recut(), 'none')).status).toBe(200)
      expect(refusedWith(await setRulesAsSent(3, earlier(), 'none'))).toEqual(CHANGED_SINCE)
    })

    it('a window that is not valid is refused in the old words before the stamp is looked at; a band that is not there, after it', async () => {
      const stamp = await dayStamp(SATURDAY)
      await setRules(SATURDAY, recut())
      expect((await setRulesAsSent(SATURDAY, [], stamp)).error?.message).toBe(PRICING_ADMIN_WORDS.setBandRules.atLeastOneBandWindowRequired)
      expect(refusedWith(await setRulesAsSent(SATURDAY, [{ bandId: UNKNOWN_ID, fromTime: '00:00', toTime: '24:00' }], stamp))).toEqual(CHANGED_SINCE)
    })
  })

  describe("a band's price carries no stamp, on purpose: the press writes only the price typed", () => {
    it("is saved from a page loaded before someone else's price change, and from a press that sends a stamp nobody gave it", async () => {
      expect((await setPrice(core, 22)).status).toBe(200)
      // The older page's press: no stamp to send, and nothing of the other change to put back but the price itself.
      expect((await setPrice(core, 23)).data).toEqual({ updated: true, band: { id: core, code: 'core', name: 'Core', price: '23.00' } })
      const withStamp = await pressRoute(bandPriceRoute, 'POST', { email: JO, params: { bandId: core }, body: { price: 24, stamp: 'anything' } })
      expect(withStamp.status).toBe(200)
      expect(await price(core)).toBe('24.00')
      // Both changes are on record, each with the price before it.
      expect((await auditRowsOf(db)).map((row) => [(row.details.before as { price: string }).price, (row.details.after as { price: string }).price])).toEqual([['20.00', '22.00'], ['22.00', '23.00'], ['23.00', '24.00']])
    })
  })
})
