import { isAtLeastMinimumAge, GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE } from '../../../../legacy-booking/backend/paddock/shared/guestValidation'
import type { PromoEligibleLine } from '../../../../legacy-refund/backend/paddock/shared/promoCodes'

/**
 * Event lines in a New Order basket (stage 1: set-up and selling). The rules live in SQL —
 * event_booking_block_reason (who may book now), quote_event (one row per place: the account
 * holder's own place at their member level when attending, every other place at the public price)
 * and claim_event_places / release_event_places (atomic places counter). Nothing here
 * re-implements them; this module only validates the attendee list, calls those functions and
 * writes / undoes the event_bookings + event_attendees rows for createOrder.ts and the reader
 * order rollback/finalise.
 */

export interface CheckoutEventAttendee {
  name: string
  email?: string
  /** Account holder only (when attending). Guests give no date of birth — see guestsOver18Confirmed. */
  dateOfBirth?: string
  isAccountHolder: boolean
}

export interface CheckoutEventInput {
  eventId: string
  /** One row per place. When the account holder attends, exactly one row has isAccountHolder. */
  attendees: CheckoutEventAttendee[]
  accountHolderAttending: boolean
  /** "Everyone else in this booking is 18 or over" — required true whenever any attendee is not
   *  the account holder. */
  guestsOver18Confirmed?: boolean
}

export type EventBlockReason =
  | 'event_not_found'
  | 'event_cancelled'
  | 'event_not_on_sale'
  | 'event_started'
  | 'event_members_only'
  | 'event_not_released_yet'

export type EventOrderFailureReason =
  | EventBlockReason
  | 'event_places_invalid'
  | 'event_account_holder_invalid'
  | 'event_attendee_name_required'
  | 'event_attendee_dob_required'
  | 'event_attendee_dob_invalid'
  | 'event_attendee_under_18'
  | 'guests_over_18_not_confirmed'
  | 'event_quote_failed'
  | 'event_full'

export const EVENT_BLOCK_MESSAGES: Record<EventBlockReason, string> = {
  event_not_found: 'That event no longer exists.',
  event_cancelled: 'That event has been cancelled.',
  event_not_on_sale: 'That event is not on sale.',
  event_started: 'That event has already started.',
  event_members_only: 'This event is for members only — the customer needs an active membership.',
  event_not_released_yet: "Members can book now; public booking hasn't opened yet for this event.",
}

/** Staff-facing text for a block reason; the release time is spelled out for members-first events
 *  (wall-clock digits labelled UTC, like session times). */
export function eventBlockMessage(reason: EventBlockReason, publicReleaseAt: string | null): string {
  if (reason === 'event_not_released_yet' && publicReleaseAt) {
    const when = new Date(publicReleaseAt).toLocaleString('en-GB', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    return `Members can book now; public booking opens ${when}.`
  }
  return EVENT_BLOCK_MESSAGES[reason] ?? 'This event cannot be booked.'
}

export interface EventQuotePlace {
  place_no: number
  attendee_type: 'account_holder' | 'guest'
  price_level: 'public' | 'pre_herd' | 'herd'
  unit_price: string
}

/** A validated, server-quoted event line — everything the write and the promo need. */
export interface ValidatedEventLine {
  eventId: string
  eventName: string
  pricePublic: number
  accountHolderAttending: boolean
  /** True when any attendee is not the account holder (the 18+ tick was required and given). */
  hasGuests: boolean
  /** Attendees reordered so the account holder (when attending) is place 1, matching quote_event. */
  attendees: CheckoutEventAttendee[]
  quote: EventQuotePlace[]
  /** Sum of the quoted unit prices (before any promo). */
  listTotal: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Validation stage, before ANY money moves: the customer may book this event now, the attendee
 * list matches the place count (at most one account holder, only when attending), every attendee
 * has a name and is 18+ on the event date, and the line is quoted server-side with quote_event.
 * `newMembershipFrequency` is the billing frequency of a membership bought in the SAME order
 * (null when none): the customer then counts as a member for this event straight away (monthly =
 * Pre-Herd price, yearly = Herd price; an existing Herd membership always wins), including access
 * to members-only / members-first events.
 */
export async function validateEventLine(
  customerId: string,
  input: CheckoutEventInput,
  newMembershipFrequency: 'monthly' | 'yearly' | null
): Promise<{ ok: true; line: ValidatedEventLine } | { ok: false; reason: EventOrderFailureReason; message: string }> {
  const fail = (reason: EventOrderFailureReason, message: string) => ({ ok: false as const, reason, message })

  const block = await paddockData.query<{ reason: string | null; public_release_at: string | null }>(
    `SELECT event_booking_block_reason($1, $2, $3::text) AS reason,
            (SELECT public_release_at FROM events WHERE id = $4) AS public_release_at`,
    [input.eventId, customerId, newMembershipFrequency, input.eventId]
  )
  const blockReason = block.data[0]?.reason ?? null
  if (blockReason) {
    const reason = blockReason as EventBlockReason
    return fail(reason, eventBlockMessage(reason, block.data[0]?.public_release_at ?? null))
  }

  const attendees = Array.isArray(input.attendees) ? input.attendees : []
  if (attendees.length < 1) {
    return fail('event_places_invalid', 'Add at least one place (one attendee row per place).')
  }
  const holders = attendees.filter((a) => a.isAccountHolder === true)
  if (input.accountHolderAttending ? holders.length !== 1 : holders.length !== 0) {
    return fail(
      'event_account_holder_invalid',
      input.accountHolderAttending
        ? 'Exactly one attendee must be the account holder when the customer is attending.'
        : 'The customer is not attending, so no attendee can be the account holder.'
    )
  }

  const eventLookup = await paddockData.query<{ name: string; starts_at: string; price_public: string | null }>(
    'SELECT name, starts_at, price_public FROM events WHERE id = $1',
    [input.eventId]
  )
  const event = eventLookup.data[0]
  if (!event) return fail('event_not_found', EVENT_BLOCK_MESSAGES.event_not_found)
  // starts_at holds London wall-clock digits labelled UTC — its date part is the event's London date.
  // The event's London date (starts_at holds London wall-clock digits labelled UTC).
  const eventDate = String(event.starts_at).slice(0, 10)

  for (const attendee of attendees) {
    if (typeof attendee.name !== 'string' || !attendee.name.trim()) {
      return fail('event_attendee_name_required', 'Every attendee needs a name.')
    }
  }
  // The account holder (when attending) gives a date of birth and must be 18+ on the event date.
  // Everyone else gives none: the booking carries the "everyone else is 18 or over" tick instead.
  const holder = holders[0]
  if (holder) {
    if (!holder.dateOfBirth) {
      return fail('event_attendee_dob_required', `${holder.name.trim()} needs a date of birth.`)
    }
    if (Number.isNaN(new Date(holder.dateOfBirth).getTime())) {
      return fail('event_attendee_dob_invalid', `${holder.name.trim()}'s date of birth is not a valid date.`)
    }
    if (!isAtLeastMinimumAge(holder.dateOfBirth, eventDate)) {
      return fail('event_attendee_under_18', `${holder.name.trim()} must be 18 or over on the event date.`)
    }
  }
  const hasGuests = attendees.length > holders.length
  if (hasGuests && input.guestsOver18Confirmed !== true) {
    return fail('guests_over_18_not_confirmed', GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE)
  }

  let quote: EventQuotePlace[]
  try {
    const quoted = await paddockData.query<EventQuotePlace>(
      'SELECT place_no, attendee_type, price_level, unit_price FROM quote_event($1, $2, $3, $4, $5::text) ORDER BY place_no',
      [input.eventId, customerId, attendees.length, input.accountHolderAttending === true, newMembershipFrequency]
    )
    quote = quoted.data
  } catch (err) {
    return fail('event_quote_failed', `The event could not be priced: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (quote.length !== attendees.length) {
    return fail('event_quote_failed', 'The event quote did not match the number of places.')
  }

  // quote_event makes place 1 the account holder when attending — put that attendee first.
  const ordered = [...holders, ...attendees.filter((a) => a.isAccountHolder !== true)]
  return {
    ok: true,
    line: {
      eventId: input.eventId,
      eventName: event.name,
      pricePublic: event.price_public === null ? 0 : Number.parseFloat(event.price_public),
      accountHolderAttending: input.accountHolderAttending === true,
      hasGuests,
      attendees: ordered,
      quote,
      listTotal: round2(quote.reduce((sum, p) => sum + Number.parseFloat(p.unit_price), 0)),
    },
  }
}

/** One promo-eligible line per paid place (same shape as booking seats). A place priced below
 *  the event's public price is member-priced, for the promo's applies_on_member_prices rule. */
export function eventPromoLines(line: ValidatedEventLine): PromoEligibleLine[] {
  const lines: PromoEligibleLine[] = []
  for (const place of line.quote) {
    const amount = Number.parseFloat(place.unit_price)
    if (!(amount > 0.005)) continue
    lines.push({
      key: `event:${place.place_no}`,
      itemType: 'event',
      amount,
      isMemberPriced: place.price_level !== 'public' && amount < line.pricePublic - 0.005,
    })
  }
  return lines
}

/**
 * Claims the places and writes the event booking + one attendee row per place (unit price net of
 * that place's promo discount). Returns the new event booking id, or 'event_full' when the claim
 * fails (no room left, or the event went off sale). Registers its own compensation via
 * `pushRollback`: delete the order line pointing at it, give the places back, delete the booking
 * (attendees cascade).
 */
export async function writeEventBooking(args: {
  line: ValidatedEventLine
  customerId: string
  staffId: string | null
  status: 'confirmed' | 'pending'
  /** Per-place promo discount keyed by place_no. */
  placeDiscounts: Map<number, number>
  pushRollback: (fn: () => Promise<void>) => void
}): Promise<{ ok: true; eventBookingId: string; pricePaid: number } | { ok: false; reason: 'event_full' }> {
  const { line, customerId, staffId, status, placeDiscounts, pushRollback } = args
  const places = line.quote.length

  const claim = await paddockData.query<{ claimed: boolean }>('SELECT claim_event_places($1, $2) AS claimed', [
    line.eventId,
    places,
  ])
  if (claim.data[0]?.claimed !== true) return { ok: false, reason: 'event_full' }
  pushRollback(async () => {
    await paddockData.query('SELECT release_event_places($1, $2)', [line.eventId, places])
  })

  const discountTotal = round2([...placeDiscounts.values()].reduce((sum, d) => sum + d, 0))
  const pricePaid = Math.max(0, round2(line.listTotal - discountTotal))
  const inserted = await paddockData.query<{ id: string }>(
    `INSERT INTO event_bookings (event_id, customer_id, places, status, account_holder_attending, price_paid, created_by_staff_id,
                                 guests_over_18_confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::boolean THEN now() END)
     RETURNING id`,
    [line.eventId, customerId, places, status, line.accountHolderAttending, pricePaid, staffId, line.hasGuests]
  )
  const eventBookingId = inserted.data[0]!.id
  pushRollback(async () => {
    // The booking's own order line must go first (order_line_items.event_booking_id has no ON
    // DELETE action); event_attendees cascade from the booking delete.
    await paddockData.query('DELETE FROM order_line_items WHERE event_booking_id = $1', [eventBookingId])
    await paddockData.query('DELETE FROM event_bookings WHERE id = $1', [eventBookingId])
  })

  for (let i = 0; i < line.quote.length; i++) {
    const place = line.quote[i]!
    const attendee = line.attendees[i]!
    const unitPrice = Math.max(0, round2(Number.parseFloat(place.unit_price) - (placeDiscounts.get(place.place_no) ?? 0)))
    await paddockData.query(
      `INSERT INTO event_attendees (event_booking_id, attendee_type, name, email, date_of_birth, unit_price, price_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        eventBookingId,
        place.attendee_type,
        attendee.name.trim(),
        attendee.email?.trim() ? attendee.email.trim() : null,
        // Account holder only; guests are covered by the booking's 18+ tick.
        place.attendee_type === 'account_holder' ? attendee.dateOfBirth ?? null : null,
        unitPrice,
        place.price_level,
      ]
    )
  }
  return { ok: true, eventBookingId, pricePaid }
}

/** Undo for a pending reader order (rows-based, no in-memory closures): give the places back and
 *  delete the event booking and its order line. One statement, so the places go back exactly once:
 *  the booking row is the proof they haven't been, and a repeat finds it gone and does nothing.
 *  Foreign keys are checked when the statement ends, so the line can go with the booking. */
export async function undoEventBooking(eventBookingId: string): Promise<void> {
  await paddockData.query(
    `WITH event_line AS (DELETE FROM order_line_items WHERE event_booking_id = $1),
     undone AS (DELETE FROM event_bookings WHERE id = $2 RETURNING event_id, places)
     SELECT release_event_places(event_id, places) FROM undone`,
    [eventBookingId, eventBookingId]
  )
}
