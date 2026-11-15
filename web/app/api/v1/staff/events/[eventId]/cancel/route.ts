import { cancelEventOutputSchema, cancelEventRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { cancelEvent } from '@/server/rules/events/cancel-event'
import { eventCancelPathOff } from '@/server/rules/refunds/refund-switch'

/**
 * W31 (E-plan 4.4 "Whole event"; lead call L5; bugs E6, E7): cancelEvent's first half. One transaction under the
 * event's lock: refused if the event has ended or any booking has a payment in progress; then off sale and cancelled,
 * with who and why. It answers the bookings still to cancel (the overview), and moves no money: the screen then
 * cancels each booking with its own press of POST /event-bookings/:id/cancel (`wholeEvent: true`).
 *
 * Who may: Issue refunds, as before. Then the switch (`event_cancels`): with it off the bookings couldn't be refunded,
 * so the event isn't cancelled either. Not idempotent by key: running it again changes nothing on an event already
 * cancelled and answers the bookings as they now stand, which is what a press after no answer needs.
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'issueRefunds', input: cancelEventRouteInputSchema, output: cancelEventOutputSchema },
  async ({ db, input, staff, requestId }) => {
    const off = eventCancelPathOff('card', process.env.ORDER_SWITCH)
    if (off) throw off
    const { eventId, ...body } = input
    return cancelEvent(db, eventId, body, { actor: { type: 'staff', id: staff.id }, requestId })
  }
)
