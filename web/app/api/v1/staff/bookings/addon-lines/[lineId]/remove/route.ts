import { removeBookingAddonOutputSchema, removeBookingAddonRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { bookingPathOff } from '@/server/rules/bookings/booking-switch'
import { removeAddon } from '@/server/rules/bookings/remove-addon'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W22 (D-plan 1.8, 4.3, 4.7): removeBookingAddon. Removes one add-on (before its session starts) with the refund staff
 * confirmed (`confirmed.refund`, half a penny, Q18): card first on the order that paid for it, the rest to store
 * credit; a credit add-on's credits back while its membership is active; nothing back inside 24 hours. R1 in one
 * transaction, then the card part once under `<claimId>:refund:<orderId>`, then R2 (server/rules/bookings/
 * remove-addon.ts, refunds.ts). Any active staff member; Issue refunds for a paid add-on refunded to the card or store
 * credit (the old rule). Gated by the switch when money goes back (`booking_changes`). Idempotent.
 */
export const POST = defineRoute(
  { auth: 'staff', input: removeBookingAddonRouteInputSchema, output: removeBookingAddonOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const money = (input.confirmed?.refund ?? 0) > 0 ? (input.refund === 'card' ? 'card' : 'cash') : 'none'
    const off = bookingPathOff(money, process.env.ORDER_SWITCH, 'out')
    if (off) throw off
    const { lineId, ...body } = input
    return removeAddon(db, lineId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      canIssueRefunds: staff.canIssueRefunds,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
