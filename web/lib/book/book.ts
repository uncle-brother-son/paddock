import { inLondon, MONTHS, WEEKDAYS, whenLine } from '@/lib/dates'
import type { SizedImage } from '@/lib/sanity/image'
import { inPence, pounds, poundsAndPence } from '@/lib/shop/money'

import type { BookingQuote, PrivateSession, PublicSession } from './api'

// W77: what the booking panel shows, as the designs write it (Figma "BookingPanel", 1174:13346). Every day, session,
// price and limit is W77a's (lib/book/api.ts, and the add-ons through lib/book/read.ts); this file only writes them
// out, and lays a month out as weeks. The one sum made on the site is "Total to pay" and an add-on's line: W77a's
// own prices added up for the eye (see `bookingSummary`). The bag and the checkout show the Worker's figures.

/** Public sessions are shared; a private one is the whole venue (WQ64: Figma's View). */
export type BookView = 'public' | 'private'

// --- Days and months. A day is "2026-11-26" as London has it, a month "2026-11".

const two = (number: number): string => String(number).padStart(2, '0')

/** Today's date in London, whatever the visitor's own time zone. */
export function londonToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((one) => one.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export const monthOf = (day: string): string => day.slice(0, 7)

const partsOf = (month: string): [year: number, month: number] => {
  const [year = 0, number = 1] = month.split('-').map(Number)
  return [year, number]
}

/** The month that many months on (or back). */
export function addMonths(month: string, by: number): string {
  const [year, number] = partsOf(month)
  const moved = new Date(Date.UTC(year, number - 1 + by, 1))
  return `${moved.getUTCFullYear()}-${two(moved.getUTCMonth() + 1)}`
}

export const daysInMonth = (month: string): number => {
  const [year, number] = partsOf(month)
  return new Date(Date.UTC(year, number, 0)).getUTCDate()
}

/** The day that many days on (or back), in any month. */
export function addDays(day: string, by: number): string {
  const moved = new Date(`${day}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + by)
  return moved.toISOString().slice(0, 10)
}

/** The calendar's title: "November 2026". */
export function monthTitle(month: string): string {
  const [year, number] = partsOf(month)
  return `${MONTHS[number - 1] ?? ''} ${year}`
}

/** The calendar's columns, Monday first, as drawn. */
export const CALENDAR_DAYS = [
  { short: 'Mon', name: 'Monday' },
  { short: 'Tue', name: 'Tuesday' },
  { short: 'Wed', name: 'Wednesday' },
  { short: 'Thu', name: 'Thursday' },
  { short: 'Fri', name: 'Friday' },
  { short: 'Sat', name: 'Saturday' },
  { short: 'Sun', name: 'Sunday' },
] as const

/** How many rows of weeks the calendar always has, as drawn: a month never needs more, and the card keeps one height. */
export const CALENDAR_WEEKS = 6

/** A month as the calendar draws it: six weeks of seven, Monday first; null where a week has no day of the month. */
export function monthWeeks(month: string): (string | null)[][] {
  const [year, number] = partsOf(month)
  // Monday is column 0; getUTCDay() has Sunday as 0.
  const before = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7
  const last = daysInMonth(month)
  return Array.from({ length: CALENDAR_WEEKS }, (_, week) =>
    Array.from({ length: 7 }, (_, column) => {
      const date = week * 7 + column - before + 1
      return date >= 1 && date <= last ? `${month}-${two(date)}` : null
    }),
  )
}

const dayParts = (day: string): { weekday: string; date: number; month: string; year: number } => {
  const at = new Date(`${day}T00:00:00Z`)
  return { weekday: WEEKDAYS[at.getUTCDay()] ?? '', date: at.getUTCDate(), month: MONTHS[at.getUTCMonth()] ?? '', year: at.getUTCFullYear() }
}

// The heading over a day's sessions is `dayLine` (lib/dates.ts; WQ69: "Thursday 12 November").

/**
 * A day's name for a screen reader on its calendar button: "Thursday 12 November 2026". It is the calendar's own
 * (never drawn), and keeps its year: the calendar goes from one year into the next.
 */
export function dayName(day: string): string {
  const { weekday, date, month, year } = dayParts(day)
  return `${weekday} ${date} ${month} ${year}`
}

// --- A session's row (Figma "SessionRow", 775:3649).

/** When a session starts, on London's clock, 24-hour: "08:00". */
export const sessionTime = (startsAt: string): string => inLondon(startsAt)?.time ?? ''

export const sessionLength = (minutes: number): string => `${minutes} min`

/** Under a public session's price: "3 Spots Left", "1 Spot Left". */
export const spotsLine = (spotsLeft: number): string => (spotsLeft === 1 ? '1 Spot Left' : `${spotsLeft} Spots Left`)

/** Under a full session's price, public or private. */
export const FULLY_BOOKED = 'Fully booked'

/** Under a private session's name: "Private - Off-Peak". */
export const privateBand = (band: string): string => `Private - ${band}`

export type GroupPrice = PrivateSession['prices'][number]

/** The size group that many people fall in, with its price (W77a: the whole group's price); null when none has one. */
export const groupFor = (session: Pick<PrivateSession, 'prices'>, people: number): GroupPrice | null => session.prices.find((group) => people >= group.from && people <= group.to) ?? null

const peopleWord = (people: number): string => (people === 1 ? '1 Person' : `${people} People`)

/** Under a private session's price, the group it is for: "1-6 People", "7 People". */
export const groupLine = (group: Pick<GroupPrice, 'from' | 'to'>): string => (group.from === group.to ? peopleWord(group.to) : `${group.from}-${group.to} People`)

/** The line under the day's heading, with the most people a booking may hold (W77a's own number). */
export const viewNote = (view: BookView, mostPeople: number): string =>
  view === 'public' ? `Public sessions are shared. Up to ${mostPeople} guests per session.` : `You have the whole venue. Up to ${mostPeople} guests per session.`

/** A private length on its toggle: "60 min". */
export const lengthLabel = sessionLength

// --- What the panel says in place of a day's sessions.

/** Figma "Day=none" (1180:20451). */
export const NO_SESSIONS = 'There are no sessions on this day. Choose another day.'

/** Not drawn: the sessions could not be read (no network, or the route refused). In the no-sessions card's place. */
export const SESSIONS_NOT_READ = 'We couldn’t load the sessions. Please try again.'

// --- The session chosen, and "Your booking" (Figma "BookingSummary", 1178:20011, the non-member scenarios).

/** The session a visitor pressed Book on, with how many people and W77a's price for them. */
export type ChosenSession = {
  view: BookView
  session: Pick<PublicSession, 'id' | 'startsAt' | 'minutes' | 'service' | 'band'>
  people: number
  /** A private booking's size group; null for a public one. */
  group: Pick<GroupPrice, 'from' | 'to'> | null
  /** What they pay altogether for the session: booking-quote's own total. */
  total: string
}

/** The quote's answer as the session chosen, or null when that many people can't book it. */
export function chosenSession(view: BookView, session: PublicSession | PrivateSession, people: number, quote: BookingQuote): ChosenSession | null {
  if (quote.reason !== null || quote.total === null) return null
  const group = 'prices' in session ? groupFor(session, people) : null
  const { id, startsAt, minutes, service, band } = session
  return { view, session: { id, startsAt, minutes, service, band }, people, group, total: quote.total }
}

/** An add-on as its card shows it: W77a's name and price for a visitor, and its picture from Sanity (null: none). */
export type BookAddOn = {
  /** The add-on's Sanity document id: what the bag is given. */
  id: string
  name: string
  /** What a visitor pays for one, as the database's own text ("5.00"). */
  price: string
  picture: (SizedImage & { alt: string }) | null
}

/** The most of one add-on the stepper goes to. W77a gives no limit; this is the widest number its 20px holds. */
export const MOST_OF_AN_ADD_ON = 99

export type SummaryLine = { key: string; label: string; value: string }

export type BookingSummaryView = {
  service: string
  /** "08:00 Thursday 12 November 2026", with the moment it names. */
  when: string
  startsAt: string
  /** "60 min - Public - Off-Peak"; a private one "60 min - Private". */
  detail: string
  people: SummaryLine
  addOns: SummaryLine[]
  total: string
}

const groupWords = (group: Pick<GroupPrice, 'from' | 'to'>): string => (group.from === group.to ? `Group price for ${group.to}` : `Group price for ${group.from} to ${group.to}`)

/** Whole pence as money with its pence written, the site's one way: 4300 is "£43.00", 166050 "£1,660.50". Integers only, so nothing is rounded. */
const penceAsPounds = (pence: number): string => poundsAndPence(`${Math.trunc(pence / 100)}.${two(pence % 100)}`)

/**
 * "Your booking" for a visitor who isn't signed in: the session, one people line with booking-quote's total (a
 * private one says which group's price it is), a line for each add-on chosen, and "Total to pay".
 *
 * The session's figure is W77a's as it came. An add-on's line is its W77a price times how many, and the total is
 * those lines and the session's figure added up, in whole pence: W77a has no read that prices a booking with its
 * add-ons, so this one sum is made here, for the eye only. Nothing is charged from it: the bag is given the session,
 * the people and the add-ons, never a price, and the Worker prices the basket itself.
 */
export function bookingSummary(chosen: ChosenSession, addOns: readonly BookAddOn[], quantities: Readonly<Record<string, number>>): BookingSummaryView {
  const { session, people, group, view } = chosen
  const picked = addOns.flatMap((addOn) => {
    const quantity = quantities[addOn.id] ?? 0
    return quantity > 0 ? [{ addOn, quantity, pence: inPence(addOn.price) * quantity }] : []
  })
  const total = picked.reduce((sum, line) => sum + line.pence, inPence(chosen.total))
  return {
    service: session.service,
    when: whenLine(session.startsAt),
    startsAt: session.startsAt,
    detail: view === 'public' ? `${sessionLength(session.minutes)} - Public - ${session.band}` : `${sessionLength(session.minutes)} - Private`,
    people: { key: 'people', label: group ? `${peopleWord(people)} - ${groupWords(group)}` : peopleWord(people), value: poundsAndPence(chosen.total) },
    addOns: picked.map(({ addOn, quantity, pence }) => ({ key: addOn.id, label: `${addOn.name} × ${quantity}`, value: penceAsPounds(pence) })),
    total: penceAsPounds(total),
  }
}

/** A price on a session's row and on an add-on's card, as drawn: "£15", "£4.50". */
export const rowPrice = pounds
