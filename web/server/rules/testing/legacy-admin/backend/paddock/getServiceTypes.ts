export interface ServiceTypeRow {
  id: string
  sanity_service_type_id: string | null
  name: string
  thumbnail_url: string | null
  duration: number
  capacity: number
  booking_type: 'public' | 'private'
  price: string | null
  active: boolean | null
  stripe_product_id: string | null
  stripe_price_id: string | null
  created_at: string
  updated_at: string
}

export interface PriceTierRow {
  id: string
  service_type_id: string
  band_id: string
  band_code: string | null
  band_name: string | null
  min_people: number
  max_people: number
  price: string | null
  stripe_price_id: string | null
  created_at: string
  updated_at: string
}

export interface ScheduleSlotRow {
  id: string
  service_type_id: string
  /** 0 = Sunday .. 6 = Saturday, matching Postgres EXTRACT(DOW). */
  day_of_week: number
  /** "HH:MM:SS" local time-of-day this service type starts a session on the given day. */
  start_time: string
  created_at: string
  updated_at: string
}

export interface ServiceTypeWithTiers extends ServiceTypeRow {
  price_tiers: PriceTierRow[]
  /** Staff-defined (day of week, start time) slots that drive session generation for this
   *  service type — replaces the old venue-wide business_hours grid. */
  schedule_slots: ScheduleSlotRow[]
}

export default async function getServiceTypes(): Promise<ServiceTypeWithTiers[]> {
  const [serviceTypes, tiers, slots] = await Promise.all([
    paddockData.query<ServiceTypeRow>('SELECT * FROM service_types ORDER BY booking_type, duration'),
    paddockData.query<PriceTierRow>(
      `SELECT t.*, sb.code AS band_code, sb.name AS band_name
       FROM service_type_price_tiers t
       LEFT JOIN session_bands sb ON sb.id = t.band_id
       ORDER BY t.min_people, sb.code`
    ),
    paddockData.query<ScheduleSlotRow>(
      'SELECT * FROM service_type_schedule_slots ORDER BY day_of_week, start_time'
    ),
  ])

  return serviceTypes.data.map((st) => ({
    ...st,
    price_tiers: tiers.data.filter((t) => t.service_type_id === st.id),
    schedule_slots: slots.data.filter((s) => s.service_type_id === st.id),
  }))
}
