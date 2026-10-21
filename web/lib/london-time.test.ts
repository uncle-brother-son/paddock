import { describe, it, expect, vi, afterEach } from 'vitest'
import { londonWallClockToUtc, getLondonOffsetMinutes } from './london-time'

afterEach(() => {
  vi.useRealTimers()
})

describe('getLondonOffsetMinutes', () => {
  it('returns +60 during British Summer Time (July)', () => {
    expect(getLondonOffsetMinutes(new Date('2026-07-15T12:00:00.000Z'))).toBe(60)
  })

  it('returns 0 during GMT (January)', () => {
    expect(getLondonOffsetMinutes(new Date('2026-01-15T12:00:00.000Z'))).toBe(0)
  })
})

describe('londonWallClockToUtc', () => {
  it('converts a BST wall-clock time to the correct earlier real UTC instant', () => {
    // 09:30 London time in July is 09:30 BST = 08:30 real UTC.
    expect(londonWallClockToUtc('2026-07-15T09:30:00.000Z').toISOString()).toBe(
      '2026-07-15T08:30:00.000Z'
    )
  })

  it('leaves a GMT wall-clock time unchanged (GMT is UTC+0)', () => {
    expect(londonWallClockToUtc('2026-01-15T09:30:00.000Z').toISOString()).toBe(
      '2026-01-15T09:30:00.000Z'
    )
  })

  it('uses BST on the Saturday before the clock-change weekend (25 Oct 2026, clocks go back at 02:00)', () => {
    expect(londonWallClockToUtc('2026-10-24T09:30:00.000Z').toISOString()).toBe(
      '2026-10-24T08:30:00.000Z'
    )
  })

  it('uses GMT on the Sunday of the clock-change weekend, after the 02:00 transition', () => {
    expect(londonWallClockToUtc('2026-10-25T09:30:00.000Z').toISOString()).toBe(
      '2026-10-25T09:30:00.000Z'
    )
  })
})

// Mirrors the 24-hour refund-eligibility rule used in bookings/refund and
// bookings/partial-refund: (londonWallClockToUtc(start_time) - now) / 1h < 24 => refused.
function hoursUntilStart(storedStartTime: string): number {
  return (londonWallClockToUtc(storedStartTime).getTime() - Date.now()) / (1000 * 60 * 60)
}

describe('24-hour refund rule, applied via the helper', () => {
  it('refuses a BST session 23.5 hours away', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T09:00:00.000Z')) // 23.5h before 08:30Z real instant
    expect(hoursUntilStart('2026-07-15T09:30:00.000Z')).toBeLessThan(24)
  })

  it('allows a BST session 24.5 hours away', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T08:00:00.000Z')) // 24.5h before 08:30Z real instant
    expect(hoursUntilStart('2026-07-15T09:30:00.000Z')).toBeGreaterThanOrEqual(24)
  })

  it('refuses a GMT session 23.5 hours away', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-14T10:00:00.000Z')) // 23.5h before 09:30Z real instant
    expect(hoursUntilStart('2026-01-15T09:30:00.000Z')).toBeLessThan(24)
  })

  it('allows a GMT session 24.5 hours away', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-14T09:00:00.000Z')) // 24.5h before 09:30Z real instant
    expect(hoursUntilStart('2026-01-15T09:30:00.000Z')).toBeGreaterThanOrEqual(24)
  })

  it('correctly handles the clock-change weekend: a BST-era booking made for a session just after the transition', () => {
    // Booking made Saturday (still BST) for a Sunday session just after clocks go back —
    // the two calendar days are in different DST regimes, but each is independently converted
    // via its own wall-clock moment, not via a shared/global offset, so this is unaffected.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-24T09:30:00.000Z')) // 24h before 09:30Z real instant on the 25th
    expect(hoursUntilStart('2026-10-25T09:30:00.000Z')).toBeGreaterThanOrEqual(24)
  })
})
