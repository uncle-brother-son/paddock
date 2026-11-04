import * as bookingSeats from '@/app/api/v1/staff/quotes/booking-seats/route'
import * as event from '@/app/api/v1/staff/quotes/event/route'
import * as promo from '@/app/api/v1/staff/promo-codes/validate/route'
import * as creditOptions from '@/app/api/v1/staff/customers/credit-options/route'
import * as available from '@/app/api/v1/staff/sessions/available/route'
import * as dayConflict from '@/app/api/v1/staff/bookings/day-conflict/route'
import * as timeConflict from '@/app/api/v1/staff/sessions/time-conflict/route'
import * as pricing from '@/app/api/v1/staff/pricing/config/route'
import * as postage from '@/app/api/v1/staff/postage/settings/route'

type Handler = (request: Request) => Promise<Response>

/** The step B routes by path, for tests. Importing this needs @/server/db/connection mocked. */
export const stepBRoutes: Record<string, { method: 'GET' | 'POST'; handler: Handler }> = {
  '/api/v1/staff/quotes/booking-seats': { method: 'POST', handler: bookingSeats.POST },
  '/api/v1/staff/quotes/event': { method: 'POST', handler: event.POST },
  '/api/v1/staff/promo-codes/validate': { method: 'POST', handler: promo.POST },
  '/api/v1/staff/customers/credit-options': { method: 'GET', handler: creditOptions.GET },
  '/api/v1/staff/sessions/available': { method: 'GET', handler: available.GET },
  '/api/v1/staff/bookings/day-conflict': { method: 'GET', handler: dayConflict.GET },
  '/api/v1/staff/sessions/time-conflict': { method: 'GET', handler: timeConflict.GET },
  '/api/v1/staff/pricing/config': { method: 'GET', handler: pricing.GET },
  '/api/v1/staff/postage/settings': { method: 'GET', handler: postage.GET },
}
