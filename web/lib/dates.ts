// W78a (WQ69): the one way the site writes when a booking or an event is, everywhere it says so (a card, the Event
// page, the Book panel's heading and summary, and later the bag, the checkout and the emails):
//
//   08:00 - Thursday 12 November
//
// 24-hour time, a space, a hyphen, a space, the day of the week, the day, the month. No year, and no "th". A day with
// no time is the same without its time ("Thursday 12 November"). A membership's dates keep their year: they are not
// written here.
//
// Always in UK time. The Worker gives a start as a real moment (ISO with the UK's own offset), so it is read here in
// Europe/London whatever the server's or the visitor's own time zone is. The names of the days and months are
// written here, not taken from the runtime's own lists, so the server and every browser write the same words.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const

type LondonTime = { time: string; weekday: string; day: number; month: string; year: number }

/** The moment as a clock and a calendar in London show it; null for something that is no moment. */
export function inLondon(moment: string): LondonTime | null {
  const at = new Date(moment)
  if (Number.isNaN(at.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((one) => one.type === type)?.value ?? ''
  const [year, month, day] = [Number(part('year')), Number(part('month')), Number(part('day'))]
  const monthName = MONTHS[month - 1]
  // The day of the week of that London date: the date alone, so no time zone comes into it.
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
  if (!monthName || !weekday) return null
  return { time: `${part('hour')}:${part('minute')}`, weekday, day, month: monthName, year }
}

/** When a session or an event starts: "08:00 - Thursday 12 November". Empty for something that is no moment. */
export function whenLine(startsAt: string): string {
  const at = inLondon(startsAt)
  return at ? `${at.time} - ${at.weekday} ${at.day} ${at.month}` : ''
}

/** A London day ("2026-11-12") with no time, as the heading over a day's sessions: "Thursday 12 November". Empty for something that is no day. */
export function dayLine(day: string): string {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00Z`) : null
  if (!at || Number.isNaN(at.getTime())) return ''
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`
}
