import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import postgres from 'postgres'
import { createDb, type Db } from '@/server/db/client'
import { createPostgresDriver } from '@/server/db/postgres-driver'
import { LIVE_EXTENSIONS_SQL, WORKER_ROLE_SQL } from './database'

const SUPERUSER = 'postgres'
const PASSWORD = 'test-only'

export interface RealPostgres {
  /** A new Worker client, with its own connections, as a separate request would have. */
  connect(): Db
  /** The superuser, on one session, for what paddock_worker can't see (other sessions' locks). */
  admin: postgres.Sql
  stop(): Promise<void>
}

/** Asks the system for a port nothing is using. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Real Postgres 17.6, the version live runs, with live-schema.sql loaded, for what PGlite can't
 * show: one connection waiting on another's lock. Each call starts its own server on a free port
 * from a new folder, and stop() removes the folder, so suites can run side by side and nothing is
 * left behind. Durability is off, as the data only lasts for the run.
 */
export async function startRealPostgres(): Promise<RealPostgres> {
  const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'paddock-pg-'))
  const port = await freePort()
  const log: string[] = []
  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user: SUPERUSER,
    password: PASSWORD,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C', '--no-sync'],
    postgresFlags: [
      ...['-c', 'listen_addresses=127.0.0.1'],
      // A socket under the Mac's long temp path would pass the 103-character limit.
      ...['-c', 'unix_socket_directories='],
      ...['-c', 'fsync=off'],
      ...['-c', 'synchronous_commit=off'],
      ...['-c', 'full_page_writes=off'],
    ],
    onLog: (message) => log.push(String(message)),
    onError: (message) => log.push(String(message)),
  })

  try {
    await server.initialise()
    await server.start()
  } catch (err) {
    await server.stop()
    await rm(databaseDir, { recursive: true, force: true })
    throw new Error(`Postgres did not start: ${String(err)}\n${log.join('')}`)
  }

  const url = (user: string) => `postgres://${user}:${PASSWORD}@127.0.0.1:${port}/postgres`
  const admin = postgres(url(SUPERUSER), { max: 1, onnotice: () => {} })
  const clients: Db[] = []

  await admin.unsafe(LIVE_EXTENSIONS_SQL)
  await admin.unsafe(readFileSync(path.join(__dirname, 'live-schema.sql'), 'utf8'))
  await admin.unsafe(`
    ${WORKER_ROLE_SQL}
    ALTER ROLE paddock_worker PASSWORD '${PASSWORD}';
    ALTER ROLE paddock_worker SET search_path = public, extensions;
  `)

  return {
    admin,
    connect() {
      const db = createDb(createPostgresDriver(url('paddock_worker')))
      clients.push(db)
      return db
    },
    async stop() {
      await Promise.all(clients.map((db) => db.close()))
      await admin.end({ timeout: 2 })
      await server.stop()
    },
  }
}
