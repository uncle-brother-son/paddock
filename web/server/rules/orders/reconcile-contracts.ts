// The zod schemas of W12's four staff routes: the reader flows' finalise and cancel, the manual reconcile
// run and the stuck list. They live here, not in contracts/, only for this slice: contracts/ is exported to
// the staff app (scripts/export-contracts.mjs), and W12 changes nothing in the staff app (brief W12, Q32
// freeze). W14, when the staff app first calls these routes, moves them into contracts/ and exports them.
import { z } from 'zod'

const id = z.guid()

export const readerFlowInputSchema = z.object({ pendingId: id })

/** finaliseReaderPayment's answer, as data, in the old shape; W12's new reasons are in reader-flow.ts. */
export const finaliseReaderFlowOutputSchema = z.object({
  finalised: z.boolean(),
  pendingId: z.string().optional(),
  flow: z.string().optional(),
  recordId: z.string().optional(),
  paymentIntentId: z.string().optional(),
  alreadyFinalised: z.boolean().optional(),
  paymentNotSucceeded: z.boolean().optional(),
  piStatus: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  warning: z.string().optional(),
})

/** cancelReaderPayment's answer, as data, in the old shape. */
export const cancelReaderFlowOutputSchema = z.object({
  cancelled: z.boolean(),
  pendingId: z.string().optional(),
  flow: z.string().optional(),
  recordId: z.string().optional(),
  alreadyDone: z.boolean().optional(),
  finalisedInstead: z.boolean().optional(),
  finaliseResult: finaliseReaderFlowOutputSchema.optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  warning: z.string().optional(),
})

export const reconcileRunInputSchema = z.object({})

/** W12a (S1): what Stripe shows for a Worker order the old screens moved out of pending (changed-elsewhere.ts). */
const findingSchema = z.object({
  state: z.enum(['taken', 'nothing_taken', 'open', 'unclear', 'other_mode']),
  amount: z.number(),
  paymentIntentIds: z.array(z.string()),
})

const reconcileItemSchema = z.object({
  kind: z.enum(['order', 'flow', 'refund']),
  id: z.string(),
  outcome: z.enum(['finalised', 'undone', 'settled_elsewhere', 'refund_pending', 'refund_confirmed', 'refund_failed', 'left']),
  reason: z.string().optional(),
  warning: z.string().optional(),
  detail: z.string().optional(),
  finding: findingSchema.optional(),
})

export const reconcileRunOutputSchema = z.object({
  checked: z.number(),
  finalised: z.number(),
  undone: z.number(),
  refunds: z.number(),
  left: z.number(),
  deferred: z.number(),
  oldLeftAlone: z.object({ orders: z.number(), flows: z.number() }),
  stripeRefused: z.boolean(),
  items: z.array(reconcileItemSchema),
})

export const stuckListInputSchema = z.object({ olderThanMinutes: z.coerce.number().int().min(1).optional() })

export const stuckListOutputSchema = z.object({
  checkout: z.array(
    z.object({
      orderId: z.string(),
      customerName: z.string(),
      amount: z.number(),
      paymentIntentId: z.string().nullable(),
      createdAt: z.string(),
      ageMinutes: z.number(),
      method: z.enum(['reader', 'card']).nullable(),
      reason: z.string(),
      words: z.string(),
      paymentStatus: z.string().optional(),
      finding: findingSchema.nullable().optional(),
    })
  ),
  flows: z.array(
    z.object({
      pendingId: z.string(),
      flow: z.enum(['move', 'settle', 'add_guest']),
      recordId: z.string(),
      customerName: z.string(),
      amount: z.number(),
      createdAt: z.string(),
      ageMinutes: z.number(),
      madeBy: z.enum(['worker', 'old']),
      reason: z.string(),
      words: z.string(),
    })
  ),
  refunds: z.array(
    z.object({
      kind: z.enum(['order', 'flow']),
      id: z.string(),
      paymentIntentId: z.string(),
      amount: z.number(),
      state: z.enum(['started', 'sent', 'failed', 'waiting']),
      words: z.string(),
    })
  ),
  warnings: z.array(z.object({ kind: z.enum(['order', 'flow']), id: z.string(), at: z.string(), warning: z.string() })),
  alert: z.object({ at: z.string(), words: z.string() }).nullable(),
})
