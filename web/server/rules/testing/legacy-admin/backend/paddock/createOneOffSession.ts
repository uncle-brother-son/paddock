import { resolveStaffId } from './shared/resolveStaffId'

export interface CreateOneOffSessionResult {
  created: boolean
  reason?: 'service_type_not_found' | 'service_type_incomplete' | 'slot_already_exists'
  session?: {
    id: string
    service_type_id: string
    start_time: string
    end_time: string
    capacity: number
    type: string
  }
}

export interface CreateOneOffSessionParams {
  serviceTypeId: string
  /** ISO timestamp for the new session's start_time. end_time is always computed from the
   *  service type's own duration, same as generateUpcomingSessions.ts does. */
  startTime: string
}

/**
 * Manually creates exactly one Session row for a bespoke, far-future booking (e.g. a full-day
 * private hire): staff first create a one-off Service Type for it (own price/duration, and
 * deliberately zero service_type_schedule_slots rows so the weekly generator never touches it —
 * see generateUpcomingSessions.ts, which only ever produces sessions via an INNER JOIN against
 * that table), then use this to create the single session instance, then use the existing
 * Block Day tool to close out the rest of that calendar date.
 *
 * Deliberately does NOT check this new session's time range against any other session — same
 * decision as setSessionStartTime.ts/setSessionServiceType.ts: the real, unconditional guarantee
 * against an actual double-booking is createBooking.ts's pre-check plus the atomic
 * `bookings_no_cross_session_overlap` exclusion constraint, both evaluated at the moment a real
 * booking is attempted, regardless of how any session came to exist at that time.
 */
export default async function createOneOffSession(
  req: { params: CreateOneOffSessionParams; user: User }
): Promise<CreateOneOffSessionResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { serviceTypeId, startTime } = req.params

  const serviceTypeLookup = await paddockData.query<{
    id: string
    duration: number | null
    capacity: number | null
    booking_type: string | null
    active: boolean | null
  }>(
    `SELECT id, duration, capacity, booking_type, active FROM service_types WHERE id = $1`,
    [serviceTypeId]
  )
  const serviceType = serviceTypeLookup.data[0]
  if (!serviceType || !serviceType.active) {
    return { created: false, reason: 'service_type_not_found' }
  }
  if (!serviceType.duration || serviceType.duration <= 0 || !serviceType.capacity || !serviceType.booking_type) {
    // Same completeness requirement the generator itself applies (duration > 0, capacity and
    // booking_type set) — an incomplete service type can't produce a valid session either way.
    return { created: false, reason: 'service_type_incomplete' }
  }

  try {
    const result = await paddockData.query<{
      id: string
      service_type_id: string
      start_time: string
      end_time: string
      capacity: number
      type: string
    }>(
      `INSERT INTO sessions (service_type_id, start_time, end_time, type, capacity, status)
       VALUES ($1, $2, $3::timestamptz + ($4 || ' minutes')::interval, $5, $6, 'open')
       RETURNING id, service_type_id, start_time, end_time, capacity, type`,
      [serviceTypeId, startTime, startTime, serviceType.duration, serviceType.booking_type, serviceType.capacity]
    )
    const session = result.data[0]
    if (!session) {
      throw new Error('The session was created but could not be read back.')
    }
    return { created: true, session }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('sessions_service_type_start_time_key')) {
      return { created: false, reason: 'slot_already_exists' }
    }
    throw err
  }
}
