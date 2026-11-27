import { AccountBar } from '@/components/components/booking/AccountBar'
import { BookingCalendar } from '@/components/components/booking/BookingCalendar'
import { SessionRow, SessionRowLoading } from '@/components/components/booking/SessionRow'
import { HELD, SessionsHeader } from '@/components/components/booking/SessionsHeader'
import { Toggle } from '@/components/ui/form-controls/Toggle'
import type { DaySessions, PrivateSession, PublicSession } from '@/lib/book/api'
import { lengthLabel, NO_SESSIONS, SESSIONS_NOT_READ, viewNote, type BookView } from '@/lib/book/book'

import { FREE_ONE, FREE_TWO, SIX_COLUMNS, THIRTEEN_COLUMNS } from './columns'

/** How many rows stand in for a day's sessions while they are read, as drawn (Day=loading). */
const LOADING_ROWS = 5

/** A day's sessions as the step shows them: still being read, read, or not to be had. */
export type DayRead = 'loading' | 'failed' | DaySessions

type BookSessionsProps = {
  today: string
  month: string
  firstMonth: string
  lastMonth: string
  onMonth: (month: string) => void
  /** The day chosen; null until the first day with a session to book is known (WQ65). */
  day: string | null
  onDay: (day: string) => void
  view: BookView
  onView: (view: BookView) => void
  /** The private length chosen, in minutes; null takes the day's shortest. */
  minutes: number | null
  onMinutes: (minutes: number) => void
  sessions: DayRead
  /** The most people a booking of each kind may hold (W77a), once a day has been read; null before. */
  mostPeople: DaySessions['mostPeople'] | null
  /** How many people each session's stepper is on, by the session's id: 1 where none is noted. */
  people: Readonly<Record<string, number>>
  onPeople: (session: string, people: number) => void
  onBook: (session: PublicSession | PrivateSession) => void
  /** The session whose price is being asked, after Book was pressed. */
  asking: string | null
}

/**
 * The booking panel's sessions step (Figma "BookingPanel", Step=sessions, Member=no: public 1174:13206, private 60
 * 1174:13247 and 120 1174:13266, Day=none 1180:20451, Day=loading 1180:20590; on a phone 1176:17691, 1180:21136,
 * 1180:21280). From 768px it is two columns of the panel's own 24: the calendar with the log-in bar beneath it (6
 * columns, from the 2nd), and the day's sessions (13 columns, from the 10th), which scroll by themselves. On a phone
 * they are one column, 32px apart, and the panel scrolls. Between those two widths the calendar and the log-in bar
 * keep at least their phone's width and the sessions take what is left (W78b, WQ78: components/modules/booking/columns.ts),
 * each row wrapping as the phone's does when its column is too narrow for one line (SessionRow).
 *
 * W78b (WQ78): any day from today on can be chosen, and one with no sessions shows the no-sessions card.
 *
 * The day's heading has the Public / Private toggle at its right (on a phone it wraps beneath). Under them: the
 * line that says what the view is, with the most people a booking may hold; for Private the day's lengths (60 min,
 * 120 min) as a second toggle; then the sessions, 12px apart. While a day is read, five loading rows; a day with
 * none, the no-sessions card in the list's place and no line above it, as drawn.
 *
 * Not built yet (WQ64; each waits for sign-in, the bag or the account):
 * - Member=yes: the bar under the calendar becomes "Logged in as" with Log out, and a row carries the member's line;
 * - Day=in bag (1174:13281) and Day=booked (1180:20312): a notice card in the list's place, in the same card as the
 *   no-sessions one, with its "View your bag" / "View booking" button at the right;
 * - Step=move (1174:13345): a "Moving your booking" card above the list, and each row's button reads "Move here".
 */
export function BookSessions(props: BookSessionsProps) {
  const { day, view, sessions, mostPeople, people } = props
  const read = typeof sessions === 'object' ? sessions : null
  const lengths = read?.private.filter((length) => length.sessions.length > 0) ?? []
  const length = lengths.find((one) => one.minutes === props.minutes) ?? lengths[0] ?? null
  const shown: readonly (PublicSession | PrivateSession)[] = read ? (view === 'public' ? read.public : (length?.sessions ?? [])) : []
  const none = sessions !== 'loading' && shown.length === 0
  const most = mostPeople ? mostPeople[view] : null
  const [firstLength, ...moreLengths] = lengths.map((one) => ({ value: String(one.minutes), label: lengthLabel(one.minutes) }))

  return (
    <>
      <div aria-hidden="true" className={FREE_ONE} />
      <div data-book="sidebar" className={`col-span-6 flex flex-col gap-12 ${SIX_COLUMNS}`}>
        <BookingCalendar
          month={props.month}
          today={props.today}
          chosen={day}
          firstMonth={props.firstMonth}
          lastMonth={props.lastMonth}
          onMonth={props.onMonth}
          onChoose={props.onDay}
        />
        <AccountBar />
      </div>

      <div aria-hidden="true" className={FREE_TWO} />
      <section data-book="sessions" aria-label="Sessions" className={`col-span-6 flex min-h-0 flex-col ${THIRTEEN_COLUMNS} ${none ? 'gap-32' : 'gap-32 md:gap-12'}`}>
        <SessionsHeader day={day} view={view} onView={props.onView} />

        {/* From 768px this is what scrolls; it reaches 8px past its column each side so a focus ring at its edge is whole. */}
        <div data-lenis-prevent="" aria-busy={sessions === 'loading'} className="flex flex-col gap-32 md:-mx-8 md:min-h-0 md:flex-1 md:overflow-y-auto md:px-8">
          {none ? (
            <p data-book="no-sessions" role="status" className="rounded-s bg-surface-card py-16 pr-8 pl-16 text-copy-12 text-text-primary md:py-8">
              {sessions === 'failed' ? SESSIONS_NOT_READ : NO_SESSIONS}
            </p>
          ) : (
            <>
              {/* Public's line is Copy 12 and Private's Copy 14, as drawn. It holds its place until the number is known. */}
              <p data-book="note" className={`shrink-0 text-text-muted-primary ${view === 'public' ? 'text-copy-12' : 'text-copy-14'}`}>
                {most === null ? HELD : viewNote(view, most)}
              </p>
              {view === 'private' && firstLength ? (
                <Toggle
                  label="Length of session"
                  name="book-length"
                  value={String(length?.minutes ?? '')}
                  options={[firstLength, ...moreLengths]}
                  onChange={(minutes) => props.onMinutes(Number(minutes))}
                  className="shrink-0 self-start"
                />
              ) : null}
              <ul data-book="session-list" className="flex shrink-0 flex-col gap-12 pb-32">
                {sessions === 'loading'
                  ? Array.from({ length: LOADING_ROWS }, (_, index) => <SessionRowLoading key={index} />)
                  : shown.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        people={people[session.id] ?? 1}
                        onPeople={(to) => props.onPeople(session.id, to)}
                        onBook={() => props.onBook(session)}
                        asking={props.asking === session.id}
                      />
                    ))}
              </ul>
              {sessions === 'loading' ? <p className="sr-only" role="status">Loading sessions</p> : null}
            </>
          )}
        </div>
      </section>
    </>
  )
}
