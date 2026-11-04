import { quoteEventInputSchema, quoteEventOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { quoteEvent } from '@/server/rules/events/quote-event'

/** Read-only, so not idempotent and no audit row. POST because the input is a structured body. */
export const POST = defineRoute({ auth: 'staff', input: quoteEventInputSchema, output: quoteEventOutputSchema }, async ({ db, input }) => quoteEvent(db, input))
