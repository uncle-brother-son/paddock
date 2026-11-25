// W75: an event's date, time and spaces as the designs write them. The Worker gives an event's start as a real moment
// (W75a: ISO with the UK's own offset), so it is read here in Europe/London whatever the server's or the visitor's own
// time zone is. The names of the days and months are written here, not taken from the runtime's own lists, so the
// server and every browser write the same words ("Sep", never "Sept").

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const

type LondonTime = { time: string; weekday: string; day: number; month: string; year: number }

/** The moment as a clock and a calendar in London show it; null for something that is no moment. */
function inLondon(moment: string): LondonTime | null {
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

/** "1st", "2nd", "3rd", "4th", "11th", "22nd". */
export function ordinal(day: number): string {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'}`
}

/** An Event page's date line (Figma "CTA", Type=event): "16:00 Tuesday 27 October 2026", 24-hour, UK time. */
export function eventDateLine(startsAt: string): string {
  const at = inLondon(startsAt)
  return at ? `${at.time} ${at.weekday} ${at.day} ${at.month} ${at.year}` : ''
}

/** An EventCard's short form (Figma "EventCard", 329:7588): "16:00 — 27th Oct 2026". */
export function eventCardDate(startsAt: string): string {
  const at = inLondon(startsAt)
  return at ? `${at.time} — ${ordinal(at.day)} ${at.month.slice(0, 3)} ${at.year}` : ''
}

/**
 * Under the button of a cancelled event, in the spaces line's place and style (WQ59: a cancelled event's page stays
 * and says so). The designs have no words for it: these are the brief's.
 */
export const EVENT_CANCELLED = 'This event has been cancelled'

/** Under an Event page's button: "6 spaces left", "1 space left". */
export const spacesLine = (spacesLeft: number): string => (spacesLeft === 1 ? '1 space left' : `${spacesLeft} spaces left`)

/**
 * On an EventCard, in the card's own capitals: "6 Spaces Left", "1 Space Left". A sold-out event keeps its card
 * (WQ17) with "Sold out" in its place: the card set draws no sold-out state, so these are the brief's words.
 */
export function cardSpaces(spacesLeft: number): string {
  if (spacesLeft <= 0) return 'Sold out'
  return spacesLeft === 1 ? '1 Space Left' : `${spacesLeft} Spaces Left`
}
