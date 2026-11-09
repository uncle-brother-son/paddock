// Ported from backend/paddock/shared/eventOrders.ts (validateEventLine and eventPromoLines). The writes
// (writeEventBooking) are in place-order.ts's order statement from W08.
import 'server-only'
import type { BasketEvent, BasketEventAttendee, BasketProblem, EventBlockReason, EventQuotePlace, PromoEligibleLine } from '@/contracts'
import { EVENT_BLOCK_MESSAGES, eventBlockMessage } from '@/server/rules/events/event-blocks'
import { round2 } from './amounts'
import { GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE, isAtLeastMinimumAge } from './guest-validation'
import type { BasketEventFacts } from './load-basket'

export interface PricedEvent {
  facts: BasketEventFacts
  /** Account holder first when attending, to match quote_event's place 1. */
  attendees: BasketEventAttendee[]
  places: EventQuotePlace[]
  listTotal: number
}

const refusal = (reason: string, message: string): BasketProblem => ({ stage: 'event', reason, message })

/** The attendees in quote_event's place order: the account holder first when attending, then the rest as sent. */
export function inPlaceOrder(attendees: readonly BasketEventAttendee[]): BasketEventAttendee[] {
  return [...attendees.filter((a) => a.isAccountHolder === true), ...attendees.filter((a) => a.isAccountHolder !== true)]
}

/** The attendee list and the quote. Everything else is in `facts`. */
export function checkEvent(event: BasketEvent, facts: BasketEventFacts | null): { line: PricedEvent | null; problem: BasketProblem | null } {
  const stop = (reason: string, message: string) => ({ line: null, problem: refusal(reason, message) })

  if (!facts) return stop('event_not_found', EVENT_BLOCK_MESSAGES.event_not_found)
  if (facts.block_reason) {
    return stop(facts.block_reason, eventBlockMessage(facts.block_reason as EventBlockReason, facts.public_release_at))
  }

  const { attendees } = event
  if (attendees.length < 1) return stop('event_places_invalid', 'Add at least one place (one attendee row per place).')
  const holders = attendees.filter((a) => a.isAccountHolder === true)
  if (event.accountHolderAttending ? holders.length !== 1 : holders.length !== 0) {
    return stop(
      'event_account_holder_invalid',
      event.accountHolderAttending
        ? 'Exactly one attendee must be the account holder when the customer is attending.'
        : 'The customer is not attending, so no attendee can be the account holder.'
    )
  }

  if (attendees.some((a) => !(a.name ?? '').trim())) return stop('event_attendee_name_required', 'Every attendee needs a name.')

  const holder = holders[0]
  if (holder) {
    const name = (holder.name ?? '').trim()
    if (!holder.dateOfBirth) return stop('event_attendee_dob_required', `${name} needs a date of birth.`)
    if (Number.isNaN(new Date(holder.dateOfBirth).getTime())) return stop('event_attendee_dob_invalid', `${name}'s date of birth is not a valid date.`)
    if (!isAtLeastMinimumAge(holder.dateOfBirth, facts.event_date ?? '')) return stop('event_attendee_under_18', `${name} must be 18 or over on the event date.`)
  }
  if (attendees.length > holders.length && event.guestsOver18Confirmed !== true) {
    return stop('guests_over_18_not_confirmed', GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE)
  }

  // quote_event raises only for missing prices here, and load-basket holds it back from that.
  if (!facts.places) return stop('event_quote_failed', `The event could not be priced: Event ${facts.id} has no prices set`)
  if (facts.places.length !== attendees.length) return stop('event_quote_failed', 'The event quote did not match the number of places.')

  return {
    problem: null,
    line: {
      facts,
      attendees: inPlaceOrder(attendees),
      places: facts.places,
      listTotal: round2(facts.places.reduce((sum, place) => sum + Number.parseFloat(place.unit_price), 0)),
    },
  }
}

/** One line per paid place. A place below the public price is member-priced. */
export function eventPromoLines(line: PricedEvent): PromoEligibleLine[] {
  const publicPrice = line.facts.price_public === null ? 0 : Number.parseFloat(line.facts.price_public)
  const lines: PromoEligibleLine[] = []
  for (const place of line.places) {
    const amount = Number.parseFloat(place.unit_price)
    if (!(amount > 0.005)) continue
    lines.push({
      key: `event:${place.place_no}`,
      itemType: 'event',
      amount,
      isMemberPriced: place.price_level !== 'public' && amount < publicPrice - 0.005,
    })
  }
  return lines
}

/** createOrder's refusal when the places can't be claimed (stage 21). T1's claim refuses with it too. */
export const eventFullRefusal = (): BasketProblem => refusal('event_full', 'Not enough places are left on this event (or it has just gone off sale).')

/** The places are claimed when the order is written, so this comes after the promo. */
export function eventFullProblem(line: PricedEvent): BasketProblem | null {
  const { active, cancelled, places_left: left } = line.facts
  if (active && !cancelled && left !== null && left >= line.places.length) return null
  return eventFullRefusal()
}
