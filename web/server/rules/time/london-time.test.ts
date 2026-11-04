import { describe, expect, it } from 'vitest'
import { addMonthsToIsoDate, londonToday, londonWallClockToUtc, startsWithinRealHours } from './london-time'

describe('londonToday', () => {
  it.each([
    // Clocks go forward at 01:00 UTC on Sunday 29 March 2026.
    ['2026-03-28T23:59:59Z', '2026-03-28'],
    ['2026-03-29T00:00:00Z', '2026-03-29'],
    ['2026-03-29T00:59:59Z', '2026-03-29'],
    ['2026-03-29T01:00:00Z', '2026-03-29'],
    ['2026-03-29T22:59:59Z', '2026-03-29'],
    ['2026-03-29T23:00:00Z', '2026-03-30'],
    // Clocks go back at 01:00 UTC on Sunday 25 October 2026.
    ['2026-10-24T22:59:59Z', '2026-10-24'],
    ['2026-10-24T23:00:00Z', '2026-10-25'],
    ['2026-10-25T00:59:59Z', '2026-10-25'],
    ['2026-10-25T01:00:00Z', '2026-10-25'],
    ['2026-10-25T23:59:59Z', '2026-10-25'],
    ['2026-10-26T00:00:00Z', '2026-10-26'],
    // Ordinary days either side.
    ['2026-07-15T22:59:59Z', '2026-07-15'],
    ['2026-07-15T23:00:00Z', '2026-07-16'],
    ['2026-12-31T23:59:59Z', '2026-12-31'],
    ['2027-01-01T00:00:00Z', '2027-01-01'],
  ])('at %s it is %s in London', (instant, expected) => {
    expect(londonToday(new Date(instant))).toBe(expected)
  })
})

describe('londonWallClockToUtc', () => {
  it('reads the digits as London wall-clock in GMT and in BST', () => {
    expect(londonWallClockToUtc('2026-01-15T09:30:00.000Z').toISOString()).toBe('2026-01-15T09:30:00.000Z')
    expect(londonWallClockToUtc('2026-07-15T09:30:00.000Z').toISOString()).toBe('2026-07-15T08:30:00.000Z')
    expect(londonWallClockToUtc('2026-07-15 09:30:00').toISOString()).toBe('2026-07-15T08:30:00.000Z')
  })

  it('handles both clock changes', () => {
    expect(londonWallClockToUtc('2026-03-29T00:30:00Z').toISOString()).toBe('2026-03-29T00:30:00.000Z')
    expect(londonWallClockToUtc('2026-03-29T02:30:00Z').toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(londonWallClockToUtc('2026-10-25T00:30:00Z').toISOString()).toBe('2026-10-24T23:30:00.000Z')
    expect(londonWallClockToUtc('2026-10-25T02:30:00Z').toISOString()).toBe('2026-10-25T02:30:00.000Z')
    // 01:30 happens twice in October. The code (ported unchanged) resolves to the second, in GMT,
    // though its header comment says the first. Pinned as it behaves today.
    expect(londonWallClockToUtc('2026-10-25T01:30:00Z').toISOString()).toBe('2026-10-25T01:30:00.000Z')
  })

  it('refuses text with no time in it', () => {
    expect(() => londonWallClockToUtc('not a date')).toThrow('Unparseable timestamp')
  })
})

describe('startsWithinRealHours', () => {
  it('counts real hours from the London start', () => {
    const start = '2026-07-15T09:30:00.000Z' // 08:30 UTC
    expect(startsWithinRealHours(start, 24, new Date('2026-07-14T08:30:01Z'))).toBe(true)
    expect(startsWithinRealHours(start, 24, new Date('2026-07-14T08:30:00Z'))).toBe(false)
  })
})

describe('addMonthsToIsoDate', () => {
  it('adds on the digits, with the Date#setMonth overflow', () => {
    expect(addMonthsToIsoDate('2026-01-15', 1)).toBe('2026-02-15')
    expect(addMonthsToIsoDate('2026-01-31', 1)).toBe('2026-03-03')
  })
})
