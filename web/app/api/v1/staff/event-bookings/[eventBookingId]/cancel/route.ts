import { cancelEventPlacesOutputSchema, cancelEventPlacesRouteInputSchema } from '@/contracts'
import { requireIssueRefunds } from '@/server/auth/staff'
import { defineRoute } from '@/server/http/define-route'
import { cancelEventPlaces } from '@/server/rules/events/cancel-places'
import { eventCancelPathOff } from '@/server/rules/refunds/refund-switch'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W30 (E-plan 4.4): cancelEventPlaces. One place, several places or a whole event booking cancelled from the attendee
 * list, with the refund to the original card (capped at the order's card money left, the rest to store credit), to
 * store credit, in cash (Q42) or with no refund. R1 in one transaction (the places cancelled and released, the claim
 * written), then the card part once under `<claimId>:refund:<orderId>`, then R2 (server/rules/events/cancel-places.ts).
 * A refusal before anything changed is an error whose details carry the old reason and words; a card refund with no
 * clear answer is held for reconcile and answered as data.
 *
 * Who may: any money back needs Issue refunds; No refund is open to every active staff member, as before (bug E12:
 * someone with no staff record, or an inactive one, is refused by defineRoute whatever is chosen). Then the switch
 * (`event_cancels`), which a cancel with no refund doesn't ask. Idempotent: the same key gets the same answer.
 *
 * W31: with `wholeEvent` this is the whole-event cancel's per-booking half (one press, one key and one claim per
 * booking: lead call L5). Honoured only when the event is cancelled in the database; refused on a live event.
 */
export const POST = defineRoute(
  { auth: 'staff', input: cancelEventPlacesRouteInputSchema, output: cancelEventPlacesOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const { eventBookingId, ...body } = input
    const refund = body.refund
    const moneyBack = refund === 'card' || refund === 'credit' || refund === 'cash'
    // W31: a booking cancelled because its event was always needs Issue refunds and the switch, whatever is sent as
    // the choice (the rule then refuses anything but Card or Store credit, and a live event).
    if (moneyBack || body.wholeEvent === true) {
      requireIssueRefunds(staff)
      const off = eventCancelPathOff(moneyBack ? refund : 'card', process.env.ORDER_SWITCH)
      if (off) throw off
    }
    return cancelEventPlaces(db, eventBookingId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
