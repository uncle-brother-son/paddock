import { staffParityInputSchema, staffParityOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { recordParity } from '@/server/parity'

/** Records a mismatch found by the staff app's shadowCompare. */
export const POST = defineRoute(
  { auth: 'staff', input: staffParityInputSchema, output: staffParityOutputSchema, idempotent: true },
  async ({ db, input, requestId }) => {
    await recordParity(db, input, requestId)
    return { recorded: true as const }
  }
)
