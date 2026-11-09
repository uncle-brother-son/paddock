// Ported unchanged from backend/paddock/shared/londonTime.ts (one `let` became `const` for lint).
/**
 * London wall-clock helpers.
 *
 * Session times (and similar columns) are stored as London wall-clock DIGITS labelled UTC —
 * e.g. "2026-10-25T08:00:00+00:00" means 08:00 on the wall in London, not 08:00 UTC. Any rule
 * that must operate on REAL elapsed time (such as the 24-hour refund cutoff, which the payments
 * backend computes as londonWallClockToUtc(session.start_time) − now) has to convert those
 * digits to a true UTC instant using the Europe/London zone rules, including both clock changes.
 * A naive digit comparison differs by one hour on clock-change weekends.
 */

const LONDON = 'Europe/London'

/** Formats an instant into zone wall-clock parts (en-GB digits, hour12: false). */
function zoneParts(instant: Date, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const byType: Record<string, string> = {}
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') byType[part.type] = part.value
  }
  // Some runtimes emit hour '24' at midnight — normalise to 0.
  const hour = byType['hour'] === '24' ? 0 : Number(byType['hour'])
  return {
    year: Number(byType['year']),
    month: Number(byType['month']),
    day: Number(byType['day']),
    hour,
    minute: Number(byType['minute']),
    second: Number(byType['second']),
  }
}

/** The zone's offset from UTC (in minutes) that is in effect at `instant`. */
function zoneOffsetMinutes(instant: Date, zone: string): number {
  const p = zoneParts(instant, zone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - instant.getTime()) / 60000)
}

/**
 * Converts London wall-clock digits to the true UTC instant they denote.
 *
 * Accepts the forms the database driver returns for these columns — ISO-ish with a trailing
 * zone label ("2026-10-25T08:00:00.000Z", "2026-10-22T17:15:00+00:00") or a bare timestamp
 * ("2026-10-25 08:00:00") — and always reads the DIGITS as London wall-clock.
 *
 * Handles both clock changes: it derives the offset at the candidate instant and re-derives it
 * once after adjusting (one iteration converges for Europe/London's one-hour shifts). On the
 * repeated hour at the autumn change (01:00–01:59 London occurs twice) it resolves to the FIRST
 * occurrence (BST, UTC+1); the spring-forward hour that does not exist resolves via the same
 * iteration to the offset in force after the change (BST), matching what people mean by a
 * wall-clock time that morning.
 */
export function londonWallClockToUtc(value: string): Date {
  // Strip any trailing zone designator so only the digits remain.
  const digits = value.replace(/(Z|[+-]\d{2}:?\d{2})$/i, '').replace(' ', 'T')
  const asIfUtc = new Date(`${digits}Z`).getTime()
  if (Number.isNaN(asIfUtc)) {
    throw new Error(`Unparseable timestamp: ${value}`)
  }
  const offset = zoneOffsetMinutes(new Date(asIfUtc), LONDON)
  let instant = new Date(asIfUtc - offset * 60000)
  const offsetAtInstant = zoneOffsetMinutes(instant, LONDON)
  if (offsetAtInstant !== offset) {
    instant = new Date(asIfUtc - offsetAtInstant * 60000)
  }
  return instant
}

/** True when the session's real start instant is less than `hours` real hours from now. */
export function startsWithinRealHours(startWallClock: string, hours: number, now: Date = new Date()): boolean {
  return londonWallClockToUtc(startWallClock).getTime() < now.getTime() + hours * 3600_000
}

/** Today's date in London as "YYYY-MM-DD" — the same calendar date the SQL helpers get from
 *  (now() AT TIME ZONE 'Europe/London')::date. Use this for TypeScript-side comparisons against
 *  date-only columns (e.g. cancel_effective_date) so both sides use the London calendar. */
export function londonToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }).format(now)
}

/** A "YYYY-MM-DD" date plus whole months, on the date digits. A day the later month doesn't have
 *  becomes its last day (Q33): 31 Jan + 1 month = 28 Feb, 29 Feb 2028 + 12 months = 28 Feb 2029.
 *  The old staff app's copy rolls over instead (31 Jan + 1 month = 3 Mar) until W15. Use with
 *  londonToday() so expiry dates are London dates. */
export function addMonthsToIsoDate(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
  // Day 0 of the month after is the target month's last day.
  const lastDay = new Date(Date.UTC(y!, m! + months, 0)).getUTCDate()
  return new Date(Date.UTC(y!, m! - 1 + months, Math.min(d!, lastDay))).toISOString().slice(0, 10)
}
