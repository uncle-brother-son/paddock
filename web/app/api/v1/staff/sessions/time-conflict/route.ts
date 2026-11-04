import { sessionTimeConflictInputSchema, sessionTimeConflictOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { checkSessionTimeConflict } from '@/server/rules/sessions/session-time-conflict'

export const GET = defineRoute({ auth: 'staff', input: sessionTimeConflictInputSchema, output: sessionTimeConflictOutputSchema }, async ({ db, input }) => checkSessionTimeConflict(db, input))
