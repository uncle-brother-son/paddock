import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import type { Db, SqlParam } from '@/server/db'
import { FakeStripe } from '@/server/stripe/fake'
import { startTestDatabase, type TestDatabase } from '../database'
import { staffAppDir } from '../staff-app-dir'
import { buildRecording, TABLES, type Recording, type Row, type TableDump } from './compare'
import { bindLegacyRoutes, bindStaffRoutes } from './legacy-routes'

/**
 * Replays a scenario from the same seed through either side, and records what it did: the rows
 * written, the Stripe calls in order, and what staff were told. See README.md beside this file.
 *
 * The clock is fixed and moves 1ms per statement, which also moves PGlite's now(), because it reads
 * the same Date.now. So a run is exactly repeatable, dates included, and golden files don't go
 * stale. Statements still get different created_at values, as they do in production.
 */

export const backendDir = path.join(staffAppDir(), 'backend/paddock')
const goldenDir = path.join(__dirname, 'golden')

/** Tuesday, in winter, so London time and UTC agree. */
export const REPLAY_NOW = '2026-11-10T09:00:00.000Z'
export const REPLAY_USER = { email: 'jo@example.com' }

/** What a scenario drives. The old functions are one side; W06 onwards adds the new routes. */
export interface ReplaySide {
  name: string
  call(action: string, params: unknown): Promise<unknown>
}

export interface ScenarioContext {
  side: ReplaySide
  stripe: FakeStripe
  db: Db
  /** Calls the action on this side and keeps its answer as part of the recording. */
  call(action: string, params: unknown): Promise<unknown>
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

function tick(): void {
  vi.setSystemTime(Date.now() + 1)
}

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

async function dumpTables(db: Db): Promise<TableDump> {
  const dump: TableDump = {}
  for (const [table, info] of TABLES) {
    const order = [...(info.orderedBy ? [info.orderedBy] : []), ...info.primaryKey].map(quoted).join(', ')
    // Test data only: the names come from the catalog.
    const sql = `SELECT * FROM ${table}${order ? ` ORDER BY ${order}` : ''}`
    dump[table] = await db.query<Row>(sql)
  }
  return dump
}

async function emptyTables(database: TestDatabase): Promise<void> {
  const names = [...TABLES.keys()].map((table) => `public.${table}`).join(', ')
  await database.pg.exec(`RESET ROLE; TRUNCATE ${names} CASCADE; SET ROLE paddock_worker;`)
}

/** The old functions, run from the staff app's checkout with paddockData on the real driver. */
export function oldSide(db: Db, stripe: FakeStripe): ReplaySide {
  const query = async (sql: string, params: unknown[] = []) => {
    // Retool maps $N to params[N-1] only if they ascend and none repeats.
    const used = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
    if (used.some((n, i) => n !== i + 1)) throw new Error(`Placeholders out of order, which Retool would swap: ${sql}`)
    tick()
    return { data: await db.query<Row>(sql, params.map((value) => value ?? null) as SqlParam[]) }
  }
  vi.stubGlobal('paddockData', { query })
  vi.stubGlobal('paddockBackendApi2', { rawRequest: bindLegacyRoutes(db, stripe) })
  vi.stubGlobal('paddockWorkerV1', { rawRequest: bindStaffRoutes() })

  return {
    name: 'old',
    async call(action, params) {
      const loaded = (await import(/* @vite-ignore */ path.join(backendDir, `${action}.ts`))) as {
        default: (req: { params: unknown; user: typeof REPLAY_USER }) => Promise<unknown>
      }
      return loaded.default({ params, user: REPLAY_USER })
    },
  }
}

export interface ReplayOptions {
  /** Runs after the scenario and before the rows are read: how tests plant a deliberate difference. */
  tamper?(db: Db, stripe: FakeStripe): Promise<void>
}

export async function replay(
  environment: ReplayEnvironment,
  scenario: Scenario,
  makeSide: (db: Db, stripe: FakeStripe) => ReplaySide,
  options: ReplayOptions = {}
): Promise<Recording> {
  const { database } = environment
  const { db } = database
  vi.setSystemTime(new Date(REPLAY_NOW))
  await emptyTables(database)
  const stripe = new FakeStripe()
  await scenario.seed(db, stripe)
  const before = await dumpTables(db)

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
  })
  await options.tamper?.(db, stripe)

  return buildRecording({
    scenario: scenario.name,
    before,
    after: await dumpTables(db),
    results,
    stripeCalls: stripe.calls,
  })
}

const goldenFile = (scenario: string) => path.join(goldenDir, `${scenario}.json`)

/**
 * The saved recording of the old function. W02 lost its promo comparison when the old code went;
 * these outlive it, so the new routes can still be held to it after W16.
 */
export function readGolden(scenario: string): Recording | null {
  const file = goldenFile(scenario)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Recording) : null
}

export function writeGolden(recording: Recording): void {
  mkdirSync(goldenDir, { recursive: true })
  writeFileSync(goldenFile(recording.scenario), `${JSON.stringify(recording, null, 2)}\n`)
}
