import { emptyInputSchema, staffWhoamiOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'

/** The staff member the Worker sees for this request. */
export const GET = defineRoute(
  { auth: 'staff', input: emptyInputSchema, output: staffWhoamiOutputSchema },
  async ({ staff }) => staff
)
