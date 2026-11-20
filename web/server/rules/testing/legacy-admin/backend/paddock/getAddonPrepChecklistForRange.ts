export interface AddonPrepItemRow {
  id: string
  booking_id: string
  addon_id: string
  addon_name: string
  quantity: number
  prepared: boolean
  prepared_at: string | null
  prepared_by: string | null
  session_id: string
  start_time: string
  end_time: string
  service_type_name: string
  customer_first_name: string
  customer_last_name: string
  booking_status: string
  /** The booking's special requests (dietary/accessibility needs etc.) — null when none. */
  special_requests: string | null
}

export interface GetAddonPrepChecklistForRangeParams {
  /** Inclusive, both "YYYY-MM-DD". Pass the same value for both for a single day (generalizes
   *  what used to be getAddonPrepChecklist.ts — Day view now just calls this with
   *  startDate === endDate; Week view passes the full week's bounds). */
  startDate: string
  endDate: string
}

export default async function getAddonPrepChecklistForRange(
  req: { params: GetAddonPrepChecklistForRangeParams }
): Promise<AddonPrepItemRow[]> {
  const { startDate, endDate } = req.params

  const result = await paddockData.query<AddonPrepItemRow>(
    `SELECT
       aol.id,
       aol.booking_id,
       aol.addon_id,
       a.name AS addon_name,
       aol.quantity,
       aol.prepared,
       aol.prepared_at,
       aol.prepared_by,
       s.id AS session_id,
       s.start_time,
       s.end_time,
       st.name AS service_type_name,
       c.first_name AS customer_first_name,
       c.last_name AS customer_last_name,
       b.status AS booking_status,
       b.special_requests
     FROM addon_order_lines aol
     JOIN addons a ON a.id = aol.addon_id
     JOIN bookings b ON b.id = aol.booking_id
     JOIN sessions s ON s.id = b.session_id
     JOIN service_types st ON st.id = s.service_type_id
     JOIN customers c ON c.id = b.customer_id
     WHERE s.start_time::date BETWEEN $1::date AND $2::date
       AND b.status != 'cancelled'
       AND aol.removed_at IS NULL
     ORDER BY s.start_time, a.name`,
    [startDate, endDate]
  )

  return result.data
}
