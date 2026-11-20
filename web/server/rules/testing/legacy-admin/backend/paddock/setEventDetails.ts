import { requireCanManagePricing } from './shared/pricingStaff'
import type { EventAccess, EventRow } from './getEvents'

export interface SetEventDetailsParams {
  eventId: string
  /** Wall-clock ISO ("YYYY-MM-DDTHH:MM:00.000Z", London digits labelled UTC), like sessions. */
  startsAt: string | null
  endsAt: string | null
  capacity: number | null
  access: EventAccess
  /** Only kept for members_first — cleared for the other access levels. */
  publicReleaseAt: string | null
  pricePublic: number | null
  pricePreHerd: number | null
  priceHerd: number | null
  refundCutoffAt: string | null
}

export type SetEventDetailsResult =
  | { updated: true; event: EventRow }
  | { updated: false; reason: 'invalid_params' | 'event_not_found' | 'event_cancelled' | 'constraint'; message: string }

const ACCESS_VALUES: EventAccess[] = ['public', 'members_only', 'members_first']

/**
 * Saves every field of the Catalog → Events edit dialog in one UPDATE. Catalogue change, so
 * Manage pricing only (27 Oct). The table's own constraints are the rules (end after start,
 * cut-off not after start, release before start, capacity not below places booked, an on-sale
 * event stays complete) — a violation comes back as a plain-words message.
 */
export default async function setEventDetails(
  req: { params: SetEventDetailsParams; user: User }
): Promise<SetEventDetailsResult> {
  await requireCanManagePricing(req.user.email)
  const p = req.params
  const invalid = (message: string): SetEventDetailsResult => ({ updated: false, reason: 'invalid_params', message })

  if (!ACCESS_VALUES.includes(p.access)) return invalid('Choose who can book: Public, Members only or Members first.')
  if (p.capacity !== null && (!Number.isInteger(p.capacity) || p.capacity < 1)) {
    return invalid('Capacity must be a whole number of at least 1.')
  }
  for (const price of [p.pricePublic, p.pricePreHerd, p.priceHerd]) {
    if (price !== null && (!Number.isFinite(price) || price < 0)) return invalid("Prices can't be negative.")
  }
  for (const value of [p.startsAt, p.endsAt, p.publicReleaseAt, p.refundCutoffAt]) {
    if (value !== null && Number.isNaN(new Date(value).getTime())) return invalid('One of the dates is not valid.')
  }
  const publicReleaseAt = p.access === 'members_first' ? p.publicReleaseAt : null

  const current = await paddockData.query<{ places_booked: number; cancelled: boolean }>(
    'SELECT places_booked, cancelled_at IS NOT NULL AS cancelled FROM events WHERE id = $1',
    [p.eventId]
  )
  const placesBooked = current.data[0]?.places_booked
  if (placesBooked === undefined) return { updated: false, reason: 'event_not_found', message: 'That event no longer exists.' }
  if (current.data[0]?.cancelled) {
    return { updated: false, reason: 'event_cancelled', message: "This event has been cancelled, so it can't be edited." }
  }

  try {
    const result = await paddockData.query<EventRow>(
      `UPDATE events
       SET starts_at = $1, ends_at = $2, capacity = $3, access = $4, public_release_at = $5,
           price_public = $6, price_pre_herd = $7, price_herd = $8, refund_cutoff_at = $9, updated_at = now()
       WHERE id = $10 AND cancelled_at IS NULL
       RETURNING id, sanity_event_id, name, thumbnail_url, has_extra_waiver, starts_at, ends_at, capacity,
                 places_booked, access, public_release_at, price_public, price_pre_herd, price_herd,
                 refund_cutoff_at, active, cancelled_at, cancel_reason, created_at, updated_at`,
      [
        p.startsAt,
        p.endsAt,
        p.capacity,
        p.access,
        publicReleaseAt,
        p.pricePublic,
        p.pricePreHerd,
        p.priceHerd,
        p.refundCutoffAt,
        p.eventId,
      ]
    )
    const row = result.data[0]
    if (!row) return { updated: false, reason: 'event_cancelled', message: "This event has been cancelled, so it can't be edited." }
    return { updated: true, event: row }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const plain: Array<[string, string]> = [
      ['events_places_within_capacity', `Capacity can't be lower than the places already booked (${placesBooked}).`],
      ['events_ends_after_start', 'The end time must be after the start time.'],
      ['events_cutoff_before_start', "The refund cut-off can't be after the event starts."],
      ['events_release_before_start', 'The public release must be before the event starts.'],
      ['events_capacity_check', 'Capacity must be at least 1.'],
      ['events_price_', "Prices can't be negative."],
      [
        'events_on_sale_complete',
        'This event is on sale, so it needs a date, capacity, all three prices and a refund cut-off (and a public release time for Members first). Take it off sale first to clear any of them.',
      ],
    ]
    const match = plain.find(([constraint]) => message.includes(constraint))
    if (match) return { updated: false, reason: 'constraint', message: match[1] }
    throw err
  }
}
