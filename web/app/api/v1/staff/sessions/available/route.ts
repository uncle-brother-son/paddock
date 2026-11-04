import { availableSessionsInputSchema, availableSessionsOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { getAvailableSessions } from '@/server/rules/sessions/available-sessions'

export const GET = defineRoute({ auth: 'staff', input: availableSessionsInputSchema, output: availableSessionsOutputSchema }, async ({ db, input }) => getAvailableSessions(db, input))
