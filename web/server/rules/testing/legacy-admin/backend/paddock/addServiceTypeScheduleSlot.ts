import { resolveStaffId } from './shared/resolveStaffId'

export interface AddServiceTypeScheduleSlotParams {
  serviceTypeId: string
  /** 0 = Sunday .. 6 = Saturday, matching Postgres EXTRACT(DOW). */
  dayOfWeek: number
  /** "HH:MM" or "HH:MM:SS" local time-of-day this service type should start a session on that day. */
  startTime: string
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Staff-managed replacement for the old venue-wide business_hours grid: each Service Type now
// owns its own explicit (day of week, start time) slots, edited directly here rather than
// generated from a rule. generateUpcomingSessions.ts reads this table, one row per slot per
// matching calendar day, for the actual session duration/capacity/booking_type already on the
// service type itself.
export default async function addServiceTypeScheduleSlot(
  req: { params: AddServiceTypeScheduleSlotParams; user: User }
) {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { serviceTypeId, dayOfWeek, startTime } = req.params

  if (!serviceTypeId) {
    throw new Error('serviceTypeId is required')
  }
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new Error(`dayOfWeek must be an integer 0-6 (0 = Sunday); received ${dayOfWeek}`)
  }
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(startTime)) {
    throw new Error('startTime must be in HH:MM or HH:MM:SS format')
  }

  try {
    const result = await paddockData.query(
      `INSERT INTO service_type_schedule_slots (service_type_id, day_of_week, start_time)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [serviceTypeId, dayOfWeek, startTime]
    )
    return result.data[0] ?? null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('duplicate key')) {
      throw new Error(`This service type already has a slot on ${DAY_NAMES[dayOfWeek]} at ${startTime}.`)
    }
    throw err
  }
}
