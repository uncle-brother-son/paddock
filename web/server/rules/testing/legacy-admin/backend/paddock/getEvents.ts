export type EventAccess = 'public' | 'members_only' | 'members_first'

/** An event as Catalog → Events and New Order see it. Times follow the sessions convention:
 *  London wall-clock digits stored as UTC. Content (name, description, images, waiver text) is
 *  owned by Sanity and synced in — read-only here. */
export interface EventRow {
  id: string
  sanity_event_id: string | null
  name: string
  thumbnail_url: string | null
  has_extra_waiver: boolean
  starts_at: string | null
  ends_at: string | null
  capacity: number | null
  places_booked: number
  access: EventAccess
  public_release_at: string | null
  price_public: string | null
  price_pre_herd: string | null
  price_herd: string | null
  refund_cutoff_at: string | null
  /** On sale. */
  active: boolean
  cancelled_at: string | null
  cancel_reason: string | null
  created_at: string
  updated_at: string
}

/** Every event (all staff may read). Upcoming first by start time; events with no date yet last. */
export default async function getEvents(): Promise<EventRow[]> {
  const result = await paddockData.query<EventRow>(
    `SELECT id, sanity_event_id, name, thumbnail_url, has_extra_waiver, starts_at, ends_at, capacity,
            places_booked, access, public_release_at, price_public, price_pre_herd, price_herd,
            refund_cutoff_at, active, cancelled_at, cancel_reason, created_at, updated_at
     FROM events
     ORDER BY starts_at ASC NULLS LAST, name`
  )
  return result.data
}
