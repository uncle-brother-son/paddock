// Ported from backend/paddock/quoteBookingSeats.ts.
import 'server-only'
import type { QuoteBookingSeatsInput, QuoteBookingSeatsOutput } from '@/contracts'
import type { Queryable } from '@/server/db'
import { getSessionBand, quoteSeats } from './band-pricing'

/**
 * Quotes a would-be public booking seat by seat, straight from the database's quote_booking
 * function (the session's band price, the account holder's membership discount and credit
 * eligibility from membership_band_terms). Read-only.
 */
export async function quoteBookingSeats(db: Queryable, input: QuoteBookingSeatsInput): Promise<QuoteBookingSeatsOutput> {
  const { sessionId, customerId, partySize, newMembershipPlanId } = input

  const band = await getSessionBand(db, sessionId)
  if (!band || !band.band_id) {
    return { seats: [], band, paidTotal: 0, unpriced: true, error: 'No band is assigned to this session.' }
  }

  try {
    const seats = await quoteSeats(db, sessionId, customerId, partySize)
    const seat1 = seats[0]
    if (newMembershipPlanId && seat1) {
      // Seat 1 as it will be once the new membership exists: covered by its credit, or (a level
      // that doesn't cover this band, e.g. Core on Peak) paid at the plan's member price.
      const terms = await db.query<{ credit_eligible: boolean; discount_percent: string; list_price: string; unit_price: string }>(
        'SELECT credit_eligible, discount_percent, list_price, unit_price FROM plan_seat_terms($1, $2)',
        [newMembershipPlanId, sessionId]
      )
      const planSeat = terms[0]
      if (planSeat) {
        seats[0] = {
          ...seat1,
          credit_eligible: planSeat.credit_eligible,
          discount_percent: planSeat.discount_percent,
          list_price: planSeat.list_price,
          unit_price: planSeat.unit_price,
        }
      }
    }
    const paidTotal = seats.reduce((sum, seat) => sum + Number.parseFloat(seat.unit_price), 0)
    return { seats, band, paidTotal, unpriced: false }
  } catch (err) {
    return { seats: [], band, paidTotal: 0, unpriced: true, error: err instanceof Error ? err.message : String(err) }
  }
}
