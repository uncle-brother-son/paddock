import { defineRoute } from '@/server/http/define-route'
import { probeTransaction, probeTransactionInputSchema, probeTransactionOutputSchema } from '@/server/probes/transaction'

/**
 * Admin only. Runs one transaction through Hyperdrive and rolls it back. Not `idempotent`: that
 * would keep an api_idempotency row outside the transaction, and this route must leave nothing.
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'admin', input: probeTransactionInputSchema, output: probeTransactionOutputSchema },
  async ({ db, input, requestId, staff }) => probeTransaction({ db, staffId: staff.id, requestId, statements: input.statements })
)
