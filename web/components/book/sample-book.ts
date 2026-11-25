import type { BookingDays, BookingQuote, BookReads, DaySessions, PrivateSession, PublicSession } from '@/lib/book/api'
import type { BookAddOn } from '@/lib/book/book'
import type { SizedImage } from '@/lib/sanity/image'

// For the Book stories only: a month, its days and their sessions as Figma draws them (November 2026, Thursday the
// 12th chosen, five public sessions at £15 with 3 spots left), with pictures drawn on the spot so a story fetches
// nothing. The site's own come from W77a's routes and reads, and from Sanity.

/** The day Figma draws as chosen: every day before it is past. */
export const SAMPLE_TODAY = '2026-11-12'
export const SAMPLE_MONTH = '2026-11'

/** November 2026 as drawn: the 18th and the 25th have nothing to book, and neither has any day before the 12th. */
const NOVEMBER_DAYS = Array.from({ length: 30 }, (_, index) => index + 1)
  .filter((date) => date >= 12 && date !== 18 && date !== 25)
  .map((date) => `2026-11-${String(date).padStart(2, '0')}`)

export const sampleDays = (month: string): BookingDays => {
  const days = month === SAMPLE_MONTH ? NOVEMBER_DAYS : month === '2026-12' ? ['2026-12-01', '2026-12-02', '2026-12-05'] : []
  return { month, publicDays: days, privateDays: days, firstDay: SAMPLE_TODAY, lastDay: '2026-12-20' }
}

const at = (date: string, time: string): string => `${date}T${time}:00+00:00`

const TIMES = ['08:00', '09:15', '10:30', '11:30', '12:45'] as const

export const samplePublic = (date: string, time: string, over: Partial<PublicSession> = {}): PublicSession => ({
  id: `public-${date}-${time}`,
  startsAt: at(date, time),
  minutes: 60,
  service: 'Contrast Therapy',
  band: 'Off-Peak',
  state: 'bookable',
  mostPeople: 3,
  spotsLeft: 3,
  price: '15.00',
  ...over,
})

/** A private session's size groups as drawn: 1 to 6 people at one price, then a price for each size up to 10. */
const groups = (first: number, step: number): PrivateSession['prices'] => [
  { from: 1, to: 6, price: `${first}.00` },
  ...[7, 8, 9, 10].map((people, index) => ({ from: people, to: people, price: `${first + step * (index + 1)}.00` })),
]

export const samplePrivate = (date: string, time: string, minutes: 60 | 120, over: Partial<PrivateSession> = {}): PrivateSession => ({
  id: `private-${minutes}-${date}-${time}`,
  startsAt: at(date, time),
  minutes,
  service: 'Contrast Therapy',
  band: 'Off-Peak',
  state: 'bookable',
  mostPeople: 10,
  prices: minutes === 60 ? groups(105, 15) : groups(210, 30),
  ...over,
})

export const sampleSessions = (date: string): DaySessions => ({
  date,
  mostPeople: { public: 6, private: 10 },
  public: TIMES.map((time) => samplePublic(date, time)),
  private: [
    { minutes: 60, sessions: TIMES.map((time) => samplePrivate(date, time, 60)) },
    { minutes: 120, sessions: ['08:00', '10:30', '12:45'].map((time) => samplePrivate(date, time, 120)) },
  ],
})

/** A day with a full session among the others: 09:15 public, and 09:15 private 60. */
export const sampleSessionsWithFull = (date: string): DaySessions => {
  const day = sampleSessions(date)
  const full = <Session extends PublicSession | PrivateSession>(session: Session): Session => (session.startsAt === at(date, '09:15') ? { ...session, state: 'full', mostPeople: 0, ...('spotsLeft' in session ? { spotsLeft: 0 } : {}) } : session)
  return { ...day, public: day.public.map(full), private: day.private.map((length) => ({ ...length, sessions: length.sessions.map(full) })) }
}

export const sampleNoSessions = (date: string): DaySessions => ({ date, mostPeople: { public: 6, private: 10 }, public: [], private: [] })

const money = (pence: number): string => (pence / 100).toFixed(2)

/** What that many people pay for one of the sample sessions, as booking-quote answers. */
export const sampleQuote = (session: string, people: number): BookingQuote => {
  if (session.startsWith('private')) {
    const prices = session.startsWith('private-60') ? groups(105, 15) : groups(210, 30)
    const group = prices.find((one) => people >= one.from && people <= one.to)
    if (!group) return { session, people, reason: 'too_many', mostPeople: 10, total: null, lines: [] }
    return { session, people, reason: null, mostPeople: 10, total: group.price, lines: [{ who: 'group', people, each: null, total: group.price }] }
  }
  if (people > 3) return { session, people, reason: 'too_many', mostPeople: 3, total: null, lines: [] }
  const guests = people - 1
  return {
    session,
    people,
    reason: null,
    mostPeople: 3,
    total: money(1500 * people),
    lines: [{ who: 'you', people: 1, each: '15.00', total: '15.00' }, ...(guests > 0 ? [{ who: 'guests' as const, people: guests, each: '15.00', total: money(1500 * guests) }] : [])],
  }
}

type SampleReads = {
  /** A day's sessions: the sample day's unless said. `never`: the read never answers, so the day stays loading. */
  sessions?: ((date: string) => DaySessions | null) | 'never'
  quote?: (session: string, people: number) => BookingQuote | null
}

/** The panel's three reads, answered here: nothing is fetched. */
export const sampleReads = ({ sessions = sampleSessions, quote = sampleQuote }: SampleReads = {}): BookReads => ({
  days: async (month) => sampleDays(month),
  sessions: async (date) => (sessions === 'never' ? new Promise<DaySessions | null>(() => undefined) : sessions(date)),
  quote: async (session, people) => quote(session, people),
})

/** A drawn stand-in for an add-on's photograph, 4 by 5. */
const drawn = (colour: string, mark: string): SizedImage => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="#d6d2c2"/><rect x="130" y="150" width="140" height="220" rx="12" fill="${colour}"/>${mark}</svg>`
  const src = `data:image/svg+xml,${encodeURIComponent(svg)}`
  return { src, srcSet: `${src} 400w`, width: 400, height: 500 }
}

const sampleAddOn = (id: string, name: string, price: string, colour: string | null): BookAddOn => ({
  id,
  name,
  price,
  picture: colour ? { ...drawn(colour, '<rect x="160" y="190" width="80" height="6" fill="#f1eee3"/>'), alt: '' } : null,
})

/** The six add-ons Figma draws; the last has no picture in Sanity, so its picture's place is empty. */
export const SAMPLE_ADD_ONS: BookAddOn[] = [
  sampleAddOn('towel-one', 'One Towel Hire', '3.00', '#6e6258'),
  sampleAddOn('towel-two', 'Two Towels Hire', '6.00', '#a7bbc8'),
  sampleAddOn('robe', 'Robe Hire', '6.00', '#f4f3ef'),
  sampleAddOn('smoothie-knoll', 'Smoothie High Brown Knoll', '6.00', '#bd9b5d'),
  sampleAddOn('smoothie-crags', 'Smoothie Hardcastle Crags', '6.00', '#7f6434'),
  sampleAddOn('coffee', 'Cold Brew Coffee with Oat Milk and Vanilla Syrup, Large', '4.50', null),
]
