import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isDeadlock, type Db, type Tx } from '@/server/db'
import { EVERY_ROW, lockAdminRows } from '@/server/rules/admin/locks'
import { holdingAfter, outcomeOf, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { setBandPrice, setBandRules, setMembershipBandTerm, setPostageSettings } from './admin'
import { getPostageSettings } from './postage-settings'
import { getPricingConfig } from './pricing-config'
import { POSTAGE_STAMP_SQL } from './stamps'

// Brief W54 items 5 and 8 (GB8; W48 review S1 and L1; "Parity and tests"): the pricing races on real Postgres 17.6,
// each press on its own connection. Two band-window saves for one day; a save against Block Day on the same
// sessions; two postage saves; and what a reader sees while a save is under way. The first press is the rule itself,
// held open inside its transaction until Postgres reports the second as blocked by it.
//
// W54a (W49 + W54 review S1): each save sends the stamp its page read. Two saves at once were both made from pages
// loaded before either, so the second, after waiting its turn, now finds the row changed and is refused
// `changed_since`: it no longer writes its own page's figures over the first's. Each race shows the stamp is compared
// under the lock: while the first is held open, a read still gives the second's stamp (its change isn't committed),
// so a comparison made before the lock would have let the second through.

let pg: RealPostgres
let first: Db
let second: Db
let reader: Db
let jo = ''
let core = ''
let peak = ''
let sauna = ''

const SATURDAY = 6
// 1 March 2031 is a Saturday.
const SAT = '2031-03-01'
/** Two sessions the noon re-cut moves from Core to Peak. The one with the higher id is written first and starts earlier, so a scan of the table, or of its start-time index, meets it first: the opposite of id order. */
const LOW = '10000000-0000-4000-8000-00000000a001'
const HIGH = '10000000-0000-4000-8000-00000000b001'

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  reader = pg.connect()
  jo = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w54-race@example.com', can_issue_refunds: true, can_manage_pricing: true })
  core = await insert(first, 'session_bands', { code: 'core', name: 'Core', price: '20.00' })
  peak = await insert(first, 'session_bands', { code: 'peak', name: 'Peak', price: '25.50' })
  sauna = await insert(first, 'service_types', { name: 'Sauna', booking_type: 'public' })
  await first.query("INSERT INTO postage_settings (standard_price, express_price, free_shipping_threshold) VALUES ('4.95', '9.95', '50.00')")
})
afterAll(() => pg.stop())

/** Core until 17:00 and Peak after, every day; the two Saturday sessions, both Core; postage as seeded. */
beforeEach(async () => {
  await first.query('DELETE FROM audit_log')
  await first.query('DELETE FROM sessions')
  await first.query('DELETE FROM band_rules')
  for (let day = 0; day <= 6; day++) {
    await insert(first, 'band_rules', { band_id: core, day_of_week: day, from_time: '00:00', to_time: '17:00' })
    await insert(first, 'band_rules', { band_id: peak, day_of_week: day, from_time: '17:00', to_time: '24:00' })
  }
  await insert(first, 'sessions', { id: HIGH, service_type_id: sauna, start_time: `${SAT} 13:00:00+00`, end_time: `${SAT} 13:59:00+00`, type: 'public', capacity: 10, band_id: core })
  await insert(first, 'sessions', { id: LOW, service_type_id: sauna, start_time: `${SAT} 14:00:00+00`, end_time: `${SAT} 14:59:00+00`, type: 'public', capacity: 10, band_id: core })
  await first.query("UPDATE postage_settings SET standard_price = '4.95', express_price = '9.95', free_shipping_threshold = '50.00'")
  await first.query("UPDATE session_bands SET price = '20.00' WHERE id = $1", [core])
})

const atNoon = () => [{ bandId: core, fromTime: '00:00', toTime: '12:00' }, { bandId: peak, fromTime: '12:00', toTime: '24:00' }]
const atThree = () => [{ bandId: core, fromTime: '00:00', toTime: '15:00' }, { bandId: peak, fromTime: '15:00', toTime: '24:00' }]
const windows = async (db: Db) => (await db.query<{ band_id: string; from_time: string; to_time: string }>('SELECT band_id, from_time::text AS from_time, to_time::text AS to_time FROM band_rules WHERE day_of_week = $1 ORDER BY from_time', [SATURDAY])).map((row) => `${row.band_id === core ? 'core' : 'peak'} ${row.from_time.slice(0, 5)}-${row.to_time.slice(0, 5)}`)
const bandOf = async (session: string) => ((await first.query<{ band_id: string }>('SELECT band_id FROM sessions WHERE id = $1', [session]))[0]?.band_id === core ? 'core' : 'peak')
const audits = () => first.query<{ action: string; details: { before: unknown; after: unknown; rebandedSessions?: number } }>('SELECT action, details FROM audit_log ORDER BY at')
const backendPid = async (tx: Tx) => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number
/** W54a: the stamps a Pricing page holds after a load, read through the page's own two reads on the given connection. */
const dayStamp = async (db: Db, day = SATURDAY) => (await getPricingConfig(db, true)).bandRulesStamps[day]
const termStamp = async (db: Db, level: string, band: string) => (await getPricingConfig(db, true)).membershipTerms.find((term) => term.membership_level === level && term.band_id === band)?.stamp ?? 'none'
const postageStamp = async (db: Db) => (await getPostageSettings(db)).stamp

describe('two band-window saves for one day at once (GB8)', () => {
  it('the second waits for the first on the band guard, then is refused: the day has changed since its page loaded, and the first\'s windows stay (W54a); nobody ever sees the day without its windows', async () => {
    // Both pages were loaded before either save.
    const loaded = await dayStamp(reader)
    // The first save, held open after everything it writes: the old windows deleted, the new ones in, the sessions re-banded.
    const held = holdingAfter(first, (sql) => sql.startsWith('SELECT reassign_session_bands'))
    const one = outcomeOf(setBandRules(held.db, SATURDAY, atNoon(), loaded, pressBy(jo)))
    const holder = await held.holding
    // While it is under way a reader sees the day's old windows, whole: never none, never half.
    expect(await windows(reader)).toEqual(['core 00:00-17:00', 'peak 17:00-24:00'])
    // And the day's stamp is still the one both pages hold: a comparison made here, before the lock, would pass.
    expect(await dayStamp(reader)).toBe(loaded)

    const two = outcomeOf(setBandRules(second, SATURDAY, atThree(), loaded, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    // Still the old windows, with one save done but not committed and another waiting.
    expect(await windows(reader)).toEqual(['core 00:00-17:00', 'peak 17:00-24:00'])
    held.release()

    // Noon: both sessions (13:00, 14:00) go to Peak. The second save, made from a page that never saw noon, is refused.
    expect(await one).toMatchObject({ answered: { saved: true, rebandedSessions: 2 } })
    expect(await two).toEqual({ refused: 'changed_since' })
    expect(await windows(first)).toEqual(['core 00:00-12:00', 'peak 12:00-24:00'])
    expect([await bandOf(HIGH), await bandOf(LOW)]).toEqual(['peak', 'peak'])
    const rows = await audits()
    expect(rows.map((row) => row.action)).toEqual(['pricing.band_rules_set'])

    // The second page reloads, and its save then replaces what the first left: 15:00, both sessions back to Core.
    const reloaded = await dayStamp(reader)
    expect(reloaded).toBe((await one as { answered: { stamp: string } }).answered.stamp)
    expect(await outcomeOf(setBandRules(second, SATURDAY, atThree(), reloaded, pressBy(jo)))).toMatchObject({ answered: { saved: true, rebandedSessions: 2 } })
    expect(await windows(first)).toEqual(['core 00:00-15:00', 'peak 15:00-24:00'])
    expect([await bandOf(HIGH), await bandOf(LOW)]).toEqual(['core', 'core'])
    // Its record starts from what the first left.
    const after = await audits()
    expect(after[1]?.details.before).toEqual(after[0]?.details.after)
  })

  it('a band price change takes its turn with a save: both hold the band guard', async () => {
    const held = holdingAfter(first, (sql) => sql.startsWith('SELECT reassign_session_bands'))
    const save = outcomeOf(setBandRules(held.db, SATURDAY, atNoon(), await dayStamp(reader), pressBy(jo)))
    const holder = await held.holding
    const price = outcomeOf(setBandPrice(second, core, 22, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    held.release()
    expect(await save).toMatchObject({ answered: { saved: true } })
    expect(await price).toMatchObject({ answered: { updated: true, band: { price: '22.00' } } })
  })

  it("control: without the guard, the second save meets the first's new windows and fails in the database's words", async () => {
    // The old shape: delete the day's windows, insert the new ones, with nothing two saves queue on.
    const replace = async (tx: Tx, cut: string) => {
      await tx.query('DELETE FROM band_rules WHERE day_of_week = $1', [SATURDAY])
      await tx.query("INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, '00:00', $3::time)", [core, SATURDAY, cut])
      await tx.query("INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, $3::time, '24:00')", [peak, SATURDAY, cut])
    }
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const one = first.transaction(async (tx) => {
      await replace(tx, '12:00')
      announce(await backendPid(tx))
      await gate.promise
    })
    const holder = await holding
    const two = second.transaction((tx) => replace(tx, '15:00')).then(
      () => 'saved',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    )
    await sessionBlockedBy(pg, holder)
    gate.resolve()
    await one
    // Its delete waited for the first's, found the old rows gone and never saw the new ones; its inserts then overlap them.
    expect(await two).toMatch(/band_rules_no_overlap/)
    expect(await windows(first)).toEqual(['core 00:00-12:00', 'peak 12:00-24:00'])
  })
})

describe('a band-window save against Block Day on the same sessions (W48 review L1)', () => {
  /**
   * Block Day as W51 will make it (and as any step G write of many sessions must: admin/locks.ts): the day's
   * sessions locked in id order, then blocked. Stopped after its first session's lock, so the test can put the save
   * between its two.
   */
  function blockDayMidWay(gate: Promise<void>) {
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const pressed = first
      .transaction(async (tx) => {
        await lockAdminRows(tx, [{ table: 'sessions', ids: [LOW] }])
        announce(await backendPid(tx))
        await gate
        await lockAdminRows(tx, [{ table: 'sessions', ids: [HIGH] }])
        await tx.query("UPDATE sessions SET status = 'blocked', blocked_reason = 'Staff day', blocked_by = $1, updated_at = now() WHERE id = ANY($2::uuid[])", [jo, [LOW, HIGH]])
        return 'blocked'
      })
      .catch((err: unknown) => (isDeadlock(err) ? 'deadlock' : Promise.reject(err)))
    return { holding, pressed }
  }
  const statuses = async () => (await first.query<{ status: string }>('SELECT status FROM sessions ORDER BY id')).map((row) => row.status)

  it('the save locks the sessions it re-bands in id order before it changes them, so it waits for Block Day holding none of them, and both go through', async () => {
    const gate = deferred()
    const blockDay = blockDayMidWay(gate.promise)
    const holder = await blockDay.holding
    // The save reaches its session lock and waits there for the lower id, which Block Day has. It holds no session.
    const save = outcomeOf(setBandRules(second, SATURDAY, atNoon(), await dayStamp(reader), pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['sessions'])
    gate.resolve()
    // Block Day takes the higher id (nobody has it), blocks both and commits; then the save re-bands both.
    expect(await blockDay.pressed).toBe('blocked')
    expect(await save).toMatchObject({ answered: { saved: true, rebandedSessions: 2 } })
    expect(await statuses()).toEqual(['blocked', 'blocked'])
    expect([await bandOf(LOW), await bandOf(HIGH)]).toEqual(['peak', 'peak'])
  })

  it('control: the same save without that lock takes the sessions in the order its update meets them, each press ends up holding one the other wants, and Postgres stops one with a deadlock', async () => {
    const gate = deferred()
    const blockDay = blockDayMidWay(gate.promise)
    const holder = await blockDay.holding
    // The save as it would be without step 4's lock: the guard, the windows, then the re-band's bare multi-row update.
    const save = second
      .transaction(async (tx) => {
        await lockAdminRows(tx, [{ table: 'session_bands', ids: EVERY_ROW }])
        await tx.query('DELETE FROM band_rules WHERE day_of_week = $1', [SATURDAY])
        await tx.query("INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, '00:00', '12:00')", [core, SATURDAY])
        await tx.query("INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, '12:00', '24:00')", [peak, SATURDAY])
        await tx.query('SELECT reassign_session_bands(now()) AS n')
        return 'saved'
      })
      .catch((err: unknown) => (isDeadlock(err) ? 'deadlock' : Promise.reject(err)))
    // Its update has taken the higher id (met first) and is waiting for the lower, which Block Day has.
    await sessionBlockedBy(pg, holder)
    gate.resolve()
    // Block Day now asks for the higher id: each holds what the other wants.
    const outcomes = [await blockDay.pressed, await save]
    expect(outcomes.filter((outcome) => outcome === 'deadlock')).toHaveLength(1)
  })
})

describe('two postage saves at once (W48 review S1: the settings row can be locked; W54a: and the second is refused)', () => {
  const postageNow = async () => (await first.query<Record<string, string>>('SELECT standard_price::text AS standard_price, express_price::text AS express_price, free_shipping_threshold::text AS free_shipping_threshold FROM postage_settings'))[0]

  it("the second waits for the first on the settings row, then is refused: the settings have changed since its page loaded, and the first's standard price stays", async () => {
    // Both pages show £4.95, £9.95, £50. A puts standard up to £5.50; B changes only express.
    const loaded = await postageStamp(reader)
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE postage_settings'))
    const one = outcomeOf(setPostageSettings(held.db, { standardPrice: 5.5, expressPrice: 9.95, freeShippingThreshold: 50, stamp: loaded }, pressBy(jo)))
    const holder = await held.holding
    // A's change is written but not committed: a read still gives the stamp both pages hold, so a comparison made
    // before the lock would let B through, and B's £4.95 would go back over A's £5.50.
    expect(await postageStamp(reader)).toBe(loaded)
    const two = outcomeOf(setPostageSettings(second, { standardPrice: 4.95, expressPrice: 11, freeShippingThreshold: 50, stamp: loaded }, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['postage_settings'])
    held.release()
    expect(await one).toMatchObject({ answered: { standardPrice: 5.5, expressPrice: 9.95, freeShippingThreshold: 50 } })
    expect(await two).toEqual({ refused: 'changed_since' })
    expect(await postageNow()).toEqual({ standard_price: '5.50', express_price: '9.95', free_shipping_threshold: '50.00' })
    expect((await audits()).map((row) => row.action)).toEqual(['postage.set'])

    // B's page reloads and B's express change is saved beside A's standard; its record starts from what A left.
    const reloaded = await postageStamp(reader)
    expect(reloaded).toBe((await one as { answered: { stamp: string } }).answered.stamp)
    expect(await outcomeOf(setPostageSettings(second, { standardPrice: 5.5, expressPrice: 11, freeShippingThreshold: 50, stamp: reloaded }, pressBy(jo)))).toMatchObject({ answered: { standardPrice: 5.5, expressPrice: 11 } })
    const rows = await audits()
    expect(rows.map((row) => row.details.before)).toEqual([
      { standard_price: '4.95', express_price: '9.95', free_shipping_threshold: '50.00' },
      { standard_price: '5.50', express_price: '9.95', free_shipping_threshold: '50.00' },
    ])
    expect(rows[1]?.details.after).toEqual({ standard_price: '5.50', express_price: '11.00', free_shipping_threshold: '50.00' })
  })

  it("control: with the stamp compared before the lock (read, then lock, then write), B's save goes through and puts standard back to £4.95", async () => {
    const loaded = await postageStamp(reader)
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE postage_settings'))
    const one = outcomeOf(setPostageSettings(held.db, { standardPrice: 5.5, expressPrice: 9.95, freeShippingThreshold: 50, stamp: loaded }, pressBy(jo)))
    const holder = await held.holding
    // B's save as it would be with the comparison in the wrong place: the stamp read first, on its own, then the lock and the write.
    const two = second.transaction(async (tx) => {
      const [now] = await tx.query<{ stamp: string }>(POSTAGE_STAMP_SQL)
      if (now?.stamp !== loaded) return 'refused'
      await tx.query('SELECT id FROM postage_settings WHERE id = true FOR NO KEY UPDATE')
      await tx.query("UPDATE postage_settings SET standard_price = '4.95', express_price = '11.00', free_shipping_threshold = '50.00', updated_at = now() WHERE id = true")
      return 'saved'
    })
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['postage_settings'])
    held.release()
    expect(await one).toMatchObject({ answered: { standardPrice: 5.5 } })
    expect(await two).toBe('saved')
    // A's £5.50 is gone.
    expect(await postageNow()).toEqual({ standard_price: '4.95', express_price: '11.00', free_shipping_threshold: '50.00' })
  })
})

describe('two saves of one member term at once (W54a)', () => {
  beforeEach(async () => {
    await first.query('DELETE FROM membership_band_terms')
    await insert(first, 'membership_band_terms', { membership_level: 'core', band_id: peak, credit_eligible: false, discount_percent: '15.00' })
  })
  const termNow = async (level: string) => (await first.query<{ credit_eligible: boolean; discount_percent: string }>('SELECT credit_eligible, discount_percent::text AS discount_percent FROM membership_band_terms WHERE membership_level = $1 AND band_id = $2', [level, peak]))[0]

  it("the second waits for the first on the band's row, then is refused: the first's credit switch stays", async () => {
    const loaded = await termStamp(reader, 'core', peak)
    const held = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO membership_band_terms'))
    const one = outcomeOf(setMembershipBandTerm(held.db, { membershipLevel: 'core', bandId: peak, creditEligible: true, discountPercent: 15, stamp: loaded }, pressBy(jo)))
    const holder = await held.holding
    expect(await termStamp(reader, 'core', peak)).toBe(loaded)
    const two = outcomeOf(setMembershipBandTerm(second, { membershipLevel: 'core', bandId: peak, creditEligible: false, discountPercent: 20, stamp: loaded }, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    held.release()
    expect(await one).toMatchObject({ answered: { saved: true } })
    expect(await two).toEqual({ refused: 'changed_since' })
    expect(await termNow('core')).toEqual({ credit_eligible: true, discount_percent: '15.00' })
    expect((await audits()).map((row) => row.action)).toEqual(['pricing.member_term_set'])
  })

  it("two first saves of a term with no row yet: the second waits, then finds a row where its page saw none, and is refused", async () => {
    expect(await termStamp(reader, 'all_access', peak)).toBe('none')
    const held = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO membership_band_terms'))
    const one = outcomeOf(setMembershipBandTerm(held.db, { membershipLevel: 'all_access', bandId: peak, creditEligible: true, discountPercent: 0, stamp: 'none' }, pressBy(jo)))
    const holder = await held.holding
    const two = outcomeOf(setMembershipBandTerm(second, { membershipLevel: 'all_access', bandId: peak, creditEligible: false, discountPercent: 50, stamp: 'none' }, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    held.release()
    expect(await one).toMatchObject({ answered: { saved: true } })
    expect(await two).toEqual({ refused: 'changed_since' })
    expect(await termNow('all_access')).toEqual({ credit_eligible: true, discount_percent: '0.00' })
  })
})
