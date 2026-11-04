import 'server-only'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createDb, type Db } from './client'
import { DbUnavailableError } from './errors'
import { createPostgresDriver } from './postgres-driver'

declare global {
  interface CloudflareEnv {
    HYPERDRIVE?: { connectionString: string }
  }
}

// The name Wrangler reads for the HYPERDRIVE binding, reused for `npm run dev` so one line in
// .env.local covers both. `next dev` doesn't run inside Workers, so it has no binding at all.
const LOCAL_CONNECTION_STRING = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'

function connectionString(): string {
  if (process.env.NODE_ENV === 'development') {
    const local = process.env[LOCAL_CONNECTION_STRING]
    if (local) return local
    throw new DbUnavailableError(`The database connection is not set up: add ${LOCAL_CONNECTION_STRING} to .env.local.`)
  }
  const hyperdrive = getCloudflareContext().env.HYPERDRIVE
  if (!hyperdrive?.connectionString) {
    throw new DbUnavailableError('The database connection is not set up: the HYPERDRIVE binding is missing.')
  }
  return hyperdrive.connectionString
}

/**
 * A new client for this request. Workers can't share a connection between requests, so it must
 * never be kept in a module variable; Hyperdrive does the real pooling. Nothing connects until
 * the first query.
 */
export function openRequestDb(): Db {
  return createDb(createPostgresDriver(connectionString()))
}

/** Closes the request's client after the response has gone. */
export function closeRequestDb(db: Db): Promise<void> | void {
  const closing = db.close()
  if (process.env.NODE_ENV === 'development') return closing
  getCloudflareContext().ctx.waitUntil(closing)
}
