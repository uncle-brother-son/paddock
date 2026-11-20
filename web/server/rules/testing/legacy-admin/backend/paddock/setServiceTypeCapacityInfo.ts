import { requireCanManagePricing } from './shared/pricingStaff'

export type ServiceTypeBookingType = 'public' | 'private'
// The runtime globals (paddockData) are typed by the generated declarations in
// backend/resources/; globals.ts is now an empty module, kept so this import stays valid.
import './globals'

const VALID_BOOKING_TYPES: ServiceTypeBookingType[] = ['public', 'private']

export interface SetServiceTypeCapacityInfoParams {
  serviceTypeId: string
  duration: number
  capacity: number
  bookingType: ServiceTypeBookingType
}

// Direct Postgres write. Duration/capacity/booking_type have no Stripe counterpart.
export default async function setServiceTypeCapacityInfo(
  req: { params: SetServiceTypeCapacityInfoParams; user: User }
) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { serviceTypeId, duration, capacity, bookingType } = req.params

  if (!Number.isInteger(duration) || duration <= 0) {
    throw new Error('Duration must be a positive whole number of minutes')
  }
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error('Capacity must be a positive whole number')
  }
  if (!VALID_BOOKING_TYPES.includes(bookingType)) {
    throw new Error(`Invalid booking type: ${bookingType}`)
  }

  const result = await paddockData.query(
    `UPDATE service_types
     SET duration = $1, capacity = $2, booking_type = $3, updated_at = now()
     WHERE id = $4
     RETURNING id, duration, capacity, booking_type`,
    [duration, capacity, bookingType, serviceTypeId]
  )
  return result.data[0] ?? null
}
