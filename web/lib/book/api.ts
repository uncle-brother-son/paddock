import type { ShopBookingDaysRouteOutput, ShopBookingQuoteRouteOutput, ShopPrivateSession, ShopPublicSession, ShopSessionsRouteOutput } from '@/contracts/shop'

// W77: the booking panel's three reads, asked by the browser of W77a's public routes (no sign-in, never cached):
// a month's days with a session to book, a day's sessions, and what a group pays for one session. Every day, session,
// price and limit the panel shows is one of these answers; nothing here works one out.

export type BookingDays = ShopBookingDaysRouteOutput
export type DaySessions = ShopSessionsRouteOutput
export type BookingQuote = ShopBookingQuoteRouteOutput
export type PublicSession = ShopPublicSession
export type PrivateSession = ShopPrivateSession

export const bookingDaysAddress = (month: string): string => `/api/v1/shop/booking-days?month=${encodeURIComponent(month)}`
export const sessionsAddress = (date: string): string => `/api/v1/shop/sessions?date=${encodeURIComponent(date)}`
export const bookingQuoteAddress = (session: string, people: number): string => `/api/v1/shop/booking-quote?session=${encodeURIComponent(session)}&people=${people}`

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isListOf = <One>(value: unknown, isOne: (one: unknown) => one is One): value is One[] => Array.isArray(value) && value.every(isOne)

/** What a route answered (`{ ok: true, data }`), or null for a refusal or anything else. */
const dataOf = (answer: unknown): Fields | null => (isFields(answer) && answer.ok === true && isFields(answer.data) ? answer.data : null)

const isShown = (session: Fields): boolean =>
  isText(session.id) && isText(session.startsAt) && isCount(session.minutes) && isText(session.service) && isText(session.band) && (session.state === 'bookable' || session.state === 'full') && isCount(session.mostPeople)

const isPublicSession = (value: unknown): value is PublicSession => isFields(value) && isShown(value) && isCount(value.spotsLeft) && isText(value.price)

const isGroupPrice = (value: unknown): value is PrivateSession['prices'][number] => isFields(value) && isCount(value.from) && isCount(value.to) && isText(value.price)

const isPrivateSession = (value: unknown): value is PrivateSession => isFields(value) && isShown(value) && isListOf(value.prices, isGroupPrice)

const isPrivateLength = (value: unknown): value is DaySessions['private'][number] => isFields(value) && isCount(value.minutes) && isListOf(value.sessions, isPrivateSession)

const isQuoteLine = (value: unknown): value is BookingQuote['lines'][number] =>
  isFields(value) && (value.who === 'you' || value.who === 'guests' || value.who === 'group') && isCount(value.people) && (value.each === null || isText(value.each)) && isText(value.total)

const REFUSALS: readonly unknown[] = ['unavailable', 'closed', 'full', 'too_many']

/** The booking-days route's answer for that month, or null: a refusal, another month's answer, or a shape it doesn't know. */
export function bookingDaysFrom(answer: unknown, month: string): BookingDays | null {
  const data = dataOf(answer)
  if (!data || data.month !== month || !isListOf(data.publicDays, isText) || !isListOf(data.privateDays, isText)) return null
  const { publicDays, privateDays, firstDay, lastDay } = data
  if (!(firstDay === null || isText(firstDay)) || !(lastDay === null || isText(lastDay))) return null
  return { month, publicDays, privateDays, firstDay, lastDay }
}

/** The sessions route's answer for that date, or null for anything else. */
export function sessionsFrom(answer: unknown, date: string): DaySessions | null {
  const data = dataOf(answer)
  if (!data || data.date !== date || !isFields(data.mostPeople)) return null
  const { public: open, private: hire } = data
  const most = data.mostPeople
  if (!isCount(most.public) || !isCount(most.private) || !isListOf(open, isPublicSession) || !isListOf(hire, isPrivateLength)) return null
  return { date, mostPeople: { public: most.public, private: most.private }, public: open, private: hire }
}

/** The booking-quote route's answer for that session and that many people, or null for anything else. */
export function bookingQuoteFrom(answer: unknown, session: string, people: number): BookingQuote | null {
  const data = dataOf(answer)
  if (!data || data.session !== session || data.people !== people || !isCount(data.mostPeople)) return null
  const { reason, total, lines, mostPeople } = data
  if (!(reason === null || REFUSALS.includes(reason)) || !(total === null || isText(total)) || !isListOf(lines, isQuoteLine)) return null
  // Bookable means priced: a quote with no reason and no total is one the panel can't show.
  if (reason === null && total === null) return null
  return { session, people, reason: reason as BookingQuote['reason'], mostPeople, total, lines }
}

/** One of the three reads: what the route answered as the panel can use it, or null when it could not be had (no network, a refusal): never an error. */
async function ask<Answer>(address: string, from: (answer: unknown) => Answer | null, signal?: AbortSignal): Promise<Answer | null> {
  try {
    const response = await fetch(address, { cache: 'no-store', ...(signal ? { signal } : {}) })
    if (!response.ok) return null
    return from(await response.json())
  } catch {
    return null
  }
}

/** What the panel reads with: the site's three routes, or a story's own answers. */
export type BookReads = {
  /** A month ("2026-11"): its days with a session to book online, the first such day from now, and the last day sessions are made for. */
  days: (month: string, signal?: AbortSignal) => Promise<BookingDays | null>
  /** A London date ("2026-11-26"): its sessions. */
  sessions: (date: string, signal?: AbortSignal) => Promise<DaySessions | null>
  /** What that many people pay for a session, or why they can't book it. */
  quote: (session: string, people: number, signal?: AbortSignal) => Promise<BookingQuote | null>
}

export const BOOK_READS: BookReads = {
  days: (month, signal) => ask(bookingDaysAddress(month), (answer) => bookingDaysFrom(answer, month), signal),
  sessions: (date, signal) => ask(sessionsAddress(date), (answer) => sessionsFrom(answer, date), signal),
  quote: (session, people, signal) => ask(bookingQuoteAddress(session, people), (answer) => bookingQuoteFrom(answer, session, people), signal),
}
