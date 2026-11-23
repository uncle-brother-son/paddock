import { oneOffSessionRouteInputSchema, oneOffSessionRouteOutputSchema, sessionsRouteInputSchema, sessionsRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { createOneOffSession, listSessions } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3; bug GB14): getSessionsForRange, the calendar's read (the Day, Week and Month views, Overview):
 * every session whose start is on a London day in the range, both ends included, with its band and its confirmed
 * bookings counted. Named fields. Any active staff member (the old read checked nobody). It also answers
 * `madeUpTo`, the date the nightly job has made sessions up to (migration 032), for Wayne's Q50 words on the Service
 * Types page.
 */
export const GET = defineRoute({ auth: 'staff', input: sessionsRouteInputSchema, output: sessionsRouteOutputSchema }, async ({ db, input, staff }) => listSessions(db, input, { actor: adminActor(staff) }))

/**
 * W51 (G-plan 4.3, level B; bugs GB3 and W51-1): createOneOffSession, one session outside the weekly timetable. Any
 * active staff member. One transaction: the band guard shared first (a band-window save in progress is waited for,
 * so the session's band is by the windows it leaves), the old checks with the old reasons, the session, and a
 * `session.created` audit row. Idempotent: the same press key gets the first press's answer, so a lost answer
 * pressed again never makes the session twice. W68 (Wayne's Q58): the press sends the stamp of the band and price the dialog
 * showed (`GET sessions/one-off/quote`); if they have changed, nothing is made (`changed_since`).
 */
export const POST = defineRoute({ auth: 'staff', input: oneOffSessionRouteInputSchema, output: oneOffSessionRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  createOneOffSession(db, input.serviceTypeId, input.startTime, input.stamp, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
