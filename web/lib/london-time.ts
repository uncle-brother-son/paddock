// Session start_time (and similar timestamp columns) are stored as London wall-clock digits
// labelled UTC — e.g. "2026-07-15T09:30:00.000Z" means 09:30 London time, every day of the
// year, regardless of BST/GMT (see supabase/migrations/007_pricing_and_credit_foundation.sql).
// Treating that string as a real UTC instant (the default behaviour of `new Date(...)`) is wrong
// for exactly the months British Summer Time is in effect, making a session look one hour
// further away than it really is. This converts those stored digits into the real UTC instant
// they represent, by asking what UTC offset Europe/London actually uses at that wall-clock
// moment — never a hard-coded offset, since it must be correct in both BST and GMT.

/**
 * Returns the UTC offset (in minutes, positive for BST) Europe/London uses at the given instant.
 */
export function getLondonOffsetMinutes(instant: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/London',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(instant)) {
    parts[part.type] = part.value
  }

  const asLondonWallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  )

  return (asLondonWallClock - instant.getTime()) / (60 * 1000)
}

/**
 * Converts a timestamp whose digits represent London wall-clock time (but is labelled/stored as
 * UTC) into the real UTC instant it represents.
 */
export function londonWallClockToUtc(storedTimestamp: string): Date {
  // Reading the stored digits literally as UTC lands within an hour of the true instant — well
  // within the same wall-clock day, so it's accurate enough to determine which DST regime
  // (BST/GMT) actually applies at that moment, except inside the one ambiguous/skipped hour on
  // the two clock-change days themselves, which the stored format has no way to disambiguate.
  const asIfUtc = new Date(storedTimestamp)
  const offsetMinutes = getLondonOffsetMinutes(asIfUtc)
  return new Date(asIfUtc.getTime() - offsetMinutes * 60 * 1000)
}
