export interface WaiverGapRow {
  id: string
  booking_id: string
  guest_name: string
  guest_type: string
  customer_first_name: string
  customer_last_name: string
  start_time: string
  service_type_name: string
}

export interface GetWaiverGapsForRangeParams {
  /** Inclusive, both "YYYY-MM-DD". */
  startDate: string
  endDate: string
}

/**
 * Every guest on a non-cancelled booking in [startDate, endDate] who hasn't completed their
 * waiver yet \u2014 same range-params/exclude-cancelled convention as
 * getAddonPrepChecklistForRange.ts. There was previously no query that aggregated
 * booking_guests.waiver_accepted across many bookings at once (only per-single-booking lookups
 * existed), so this is net new rather than a reuse of an existing aggregate.
 */
export default async function getWaiverGapsForRange(
  req: { params: GetWaiverGapsForRangeParams }
): Promise<WaiverGapRow[]> {
  const { startDate, endDate } = req.params

  const result = await paddockData.query<WaiverGapRow>(
    `SELECT
       bg.id,
       bg.booking_id,
       bg.guest_name,
       bg.guest_type,
       c.first_name AS customer_first_name,
       c.last_name AS customer_last_name,
       s.start_time,
       st.name AS service_type_name
     FROM booking_guests bg
     JOIN bookings b ON b.id = bg.booking_id
     JOIN sessions s ON s.id = b.session_id
     JOIN service_types st ON st.id = s.service_type_id
     JOIN customers c ON c.id = b.customer_id
     WHERE s.start_time::date BETWEEN $1::date AND $2::date
       AND b.status != 'cancelled'
       AND bg.waiver_accepted IS NOT TRUE
     ORDER BY s.start_time`,
    [startDate, endDate]
  )

  return result.data
}
