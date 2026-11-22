import type { Db } from '@/server/db'

/**
 * W64: the database a sweep file's routes open. Its own module, with nothing else in it, so a test file's mock of
 * @/server/db/connection can import it without loading any route (a route imports the connection module itself).
 */
export const sweepDb: { db: Db | null } = { db: null }
