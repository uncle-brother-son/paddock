import { describe, expect, it } from 'vitest'
import { bookingDayRangeRouteInputSchema, bookingListRouteInputSchema } from '@/contracts'

// W59 (W50 review L7): the screens' calendar days are refused when the calendar doesn't have them, before the
// database is asked (it answered its own error, a 500).
describe('a London day in the step G reads', () => {
  it.each(['2026-02-30', '2026-13-01', '2026-04-31', '2026-00-10', '2025-02-29'])('%s is refused with words', (day) => {
    const parsed = bookingDayRangeRouteInputSchema.safeParse({ startDate: day, endDate: '2026-12-01' })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('Must be a date the calendar has')
  })

  it.each(['2026-02-28', '2028-02-29', '2026-12-31'])('%s passes', (day) => {
    expect(bookingListRouteInputSchema.safeParse({ startDate: day }).success).toBe(true)
  })

  it('the pattern still comes first', () => {
    expect(JSON.stringify(bookingListRouteInputSchema.safeParse({ startDate: '26-1-1' }).error?.issues)).toContain('Must be a date in the form YYYY-MM-DD')
  })
})
