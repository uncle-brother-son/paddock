import { adminGetTodaysEventsOutputSchema, emptyInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { getTodaysEvents } from '@/server/rules/events/attendance'

/**
 * W52 (G-plan 4.3; bug GB14; W48 review L5): getTodaysEvents, Overview's events card: the events on London's today
 * that aren't cancelled, with their counts, and today's attendees with a waiver outstanding. The day is the London
 * day the event's stored digits show. Named fields. Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: adminGetTodaysEventsOutputSchema }, async ({ db, staff }) => getTodaysEvents(db, adminActor(staff)))
