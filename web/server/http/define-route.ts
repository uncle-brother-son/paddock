import 'server-only'
import { defaultTokenVerifier } from '@/server/auth/customer'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { writeRequestLog } from './log'
import { createRouteFactory } from './route'

/**
 * Wraps an /api/v1 route: authenticates, checks the permission, validates the input, runs the
 * handler, logs, and answers in the standard envelope. See createRouteFactory.
 */
export const defineRoute = createRouteFactory({
  openDb: openRequestDb,
  closeDb: closeRequestDb,
  staffApiKey: () => process.env.STAFF_API_KEY,
  tokenVerifier: defaultTokenVerifier,
  log: writeRequestLog,
  now: () => Date.now(),
  validateOutput: process.env.NODE_ENV !== 'production',
})
