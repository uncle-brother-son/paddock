import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import type { Db } from '@/server/db'
import { FakeStripe } from '@/server/stripe/fake'
import { startTestDatabase, type TestDatabase } from '../database'
import { buildRecording, TABLES, type Recording, type Row, type TableDump } from '../replay/compare'
import { replayStripe } from '../replay/stripe-binding'

/**
 * W64 (H-plan 3.3 step 1): the part of the replay harness that runs a scenario and records it, with nothing of the old
 * code in it, so the Worker's own rule tests and the all-Worker sweep can use it after the frozen copies go (W65).
 * Moved here unchanged from `replay/harness.ts`, which re-exports all of it beside the old side (`oldSide`) and the
 * golden files.
 *
 * The clock is fixed and moves 1ms per statement on the old side (and before each press on a Worker side), which also
 * moves PGlite's now(), because it reads the same Date.now. So a run is exactly repeatable, dates included, and
 * recordings don't go stale. Statements still get different created_at values, as they do in production.
 */

/** Tuesday, in winter, so London time and UTC agree. */
export const REPLAY_NOW = '2026-11-10T09:00:00.000Z'
export const REPLAY_USER = { email: 'jo@example.com' }

/** What a scenario drives. The old functions were one side (W06 to W63); the Worker is the other. */
export interface ReplaySide {
  name: string
  call(action: string, params: unknown): Promise<unknown>
  /**
   * W43: the lapse sweep this side runs where a scenario recorded the database's own (scenarios.ts, sweepLapsed).
   * Left out (the old side, and every side before W43): the database's lapse_sweep_expired_bookings, as recorded.
   */
  lapseSweep?(db: Db): Promise<void>
  /**
   * W51 (migration 032): the nightly job this side runs where a scenario runs the database's own (w48-scenarios.ts,
   * runNightlyJob). W65: a side without one can't run those scenarios (the old side's "job as it was before 032" went
   * with the golden files).
   */
  nightlyJob?(db: Db): Promise<void>
}

export interface ScenarioContext {
  side: ReplaySide
  stripe: FakeStripe
  db: Db
  /** Calls the action on this side and keeps its answer as part of the recording. */
  call(action: string, params: unknown): Promise<unknown>
  /**
   * W17: as `call`, for a step the old function answers by throwing (a lost answer, a failed write): the throw is
   * kept in the recording as `{ thrown: <its words> }`, which is what staff were shown, and the scenario carries on.
   */
  attempt(action: string, params: unknown): Promise<unknown>
}

export interface Scenario {
  name: string
  seed(db: Db, stripe: FakeStripe): Promise<void>
  run(context: ScenarioContext): Promise<void>
}

export interface ReplayEnvironment {
  database: TestDatabase
  stop(): Promise<void>
}

// W65: the two functions the old side ran under their own names (event_cancellation_quote as it was before 024, the
// nightly job as it was before 032) went with it. Every side here reads the saved schema's own.
export async function startReplay(): Promise<ReplayEnvironment> {
  // Started on the real clock: Postgres's own start-up waits on time passing.
  const database = await startTestDatabase({ schema: 'live' })
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(REPLAY_NOW) })
  return {
    database,
    async stop() {
      await database.stop()
      vi.useRealTimers()
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    },
  }
}

const quoted = (name: string) => `"${name}"`

/**
 * W64 (W45 audit row 1): `gift_card_redemptions` has no `created_at`, so it is read by `redeemed_at` and then its
 * key: two redemptions in one scenario come out in the order they were made, not by their random ids. A table with
 * neither column is read by its key alone, as before.
 */
const READ_BY: Readonly<Record<string, string>> = { gift_card_redemptions: 'redeemed_at' }

async function dumpTables(db: Db, orderBy: (table: string, orderedBy: string | null) => string | null): Promise<TableDump> {
  const dump: TableDump = {}
  for (const [table, info] of TABLES) {
    const first = orderBy(table, info.orderedBy)
    const order = [...(first ? [first] : []), ...info.primaryKey].map(quoted).join(', ')
    // Test data only: the names come from the catalog.
    const sql = `SELECT * FROM ${table}${order ? ` ORDER BY ${order}` : ''}`
    dump[table] = await db.query<Row>(sql)
  }
  return dump
}

/** As the golden files were read: by created_at (or at), then the key. */
const asTheGoldenFilesRead = (_table: string, orderedBy: string | null): string | null => orderedBy
/** As the sweep's recordings are read: the same, and gift card redemptions by when they were made (READ_BY). */
const asTheSweepReads = (table: string, orderedBy: string | null): string | null => orderedBy ?? READ_BY[table] ?? null

async function emptyTables(database: TestDatabase): Promise<void> {
  const names = [...TABLES.keys()].map((table) => `public.${table}`).join(', ')
  await database.pg.exec(`RESET ROLE; TRUNCATE ${names} CASCADE; SET ROLE paddock_worker;`)
}

export interface ReplayOptions {
  /** Runs after the scenario and before the rows are read: how tests plant a deliberate difference. */
  tamper?(db: Db, stripe: FakeStripe): Promise<void>
  /** W64: read gift card redemptions by `redeemed_at` (the sweep's recordings). Left out: as the golden files were read. */
  readRedemptionsInOrder?: boolean
}

/**
 * W39: what a scenario took out of the schema for its own run and can only put back once its rows are gone (a unique
 * index it lifted to record a duplicate: migration 027's, scenarios.ts liftEmailLowerIndex). Run by the next replay,
 * straight after it empties the tables, or by restoreSchema.
 */
const onceEmpty: Array<(db: Db) => Promise<void>> = []
export const putBackWhenEmpty = (work: (db: Db) => Promise<void>): void => void onceEmpty.push(work)
async function putBackOnceEmpty(db: Db): Promise<void> {
  for (const work of onceEmpty.splice(0)) await work(db)
}
/** Empties the tables and puts back anything a scenario lifted: the schema as it was before the last replay. */
export async function restoreSchema(environment: ReplayEnvironment): Promise<void> {
  await emptyTables(environment.database)
  await putBackOnceEmpty(environment.database.db)
}

export async function replay(
  environment: ReplayEnvironment,
  scenario: Scenario,
  makeSide: (db: Db, stripe: FakeStripe) => ReplaySide,
  options: ReplayOptions = {}
): Promise<Recording> {
  const { database } = environment
  const { db } = database
  const orderBy = options.readRedemptionsInOrder ? asTheSweepReads : asTheGoldenFilesRead
  vi.setSystemTime(new Date(REPLAY_NOW))
  await emptyTables(database)
  await putBackOnceEmpty(db)
  const stripe = new FakeStripe()
  await scenario.seed(db, stripe)
  const before = await dumpTables(db, orderBy)

  // Each run's fake, bound again by a side that charges through the order route (W10).
  replayStripe.current = null
  const side = makeSide(db, stripe)
  const results: unknown[] = []
  await scenario.run({
    side,
    stripe,
    db,
    async call(action, params) {
      const result = await side.call(action, params)
      results.push(result)
      return result
    },
    async attempt(action, params) {
      let result: unknown
      try {
        result = await side.call(action, params)
      } catch (err) {
        result = { thrown: err instanceof Error ? err.message : String(err) }
      }
      results.push(result)
      return result
    },
  })
  // W14: the old functions ask the Worker first. With every kind off its only trace is the answer stored
  // against each press's key (ORDER_PATH_OFF; `not_a_reader_order` from finalise and cancel, W25: the Worker's
  // answer for an order with no mark of its own, where it used to say the old checkout's; or, for an order
  // already gone, the Worker's own "already gone", in the old words), which is the Worker's bookkeeping, not
  // the old code's. Those rows alone are taken out before the rows are read, so the old side's recording
  // is exactly the old code's, as the golden files hold it. Anything else the Worker wrote would show.
  if (side.name === 'old') await forgetSwitchedOffAnswers(db)
  await options.tamper?.(db, stripe)

  return buildRecording({
    scenario: scenario.name,
    before,
    after: await dumpTables(db, orderBy),
    results,
    stripeCalls: stripe.calls,
  })
}

/**
 * The answers the wrappers' Worker calls stored against their keys, and nothing else (see replay): an order
 * route's ORDER_PATH_OFF, and a finalise or cancel the Worker refused as not its own reader order (`not_a_reader_order`) or
 * found the order already gone (answered by the Worker in the old words, nothing touched).
 */
export async function forgetSwitchedOffAnswers(db: Db): Promise<void> {
  await db.query(
    `DELETE FROM api_idempotency
      WHERE response->'error'->>'code' = 'ORDER_PATH_OFF'
         OR (endpoint LIKE 'POST /api/v1/staff/orders/%'
             AND (response->'data'->>'reason' IN ('not_a_reader_order', 'order_not_found') OR response->'data'->>'alreadyGone' = 'true'))`
  )
}

/**
 * W64 (H-plan 3.1, lead call L-H2): the all-Worker sweep's own recordings, one file a scenario, recorded from the Worker
 * once the bridge check had held them to the golden files (briefs/W64-report.md). `UPDATE_RECORDINGS=1` writes them
 * again: read the diff before keeping it, as a re-record accepts whatever the code now does.
 */
const recordingsDir = path.join(__dirname, '..', 'recordings')
const recordingFile = (scenario: string) => path.join(recordingsDir, `${scenario}.json`)

export function readRecording(scenario: string): Recording | null {
  const file = recordingFile(scenario)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Recording) : null
}

export function writeRecording(recording: Recording): void {
  mkdirSync(recordingsDir, { recursive: true })
  writeFileSync(recordingFile(recording.scenario), `${JSON.stringify(recording, null, 2)}\n`)
}
