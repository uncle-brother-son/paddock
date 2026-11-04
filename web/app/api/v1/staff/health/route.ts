import { emptyInputSchema, staffHealthOutputSchema } from '@/contracts'
import { buildVersion } from '@/server/http/build-version'
import { defineRoute } from '@/server/http/define-route'

/** A database round trip through Hyperdrive, plus the deployed version. */
export const GET = defineRoute(
  { auth: 'staff', input: emptyInputSchema, output: staffHealthOutputSchema },
  async ({ db }) => {
    await db.query('select 1 as ok')
    return { database: 'ok' as const, version: buildVersion() }
  }
)
