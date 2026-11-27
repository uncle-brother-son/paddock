'use client'

import { useEffect, useRef, useState } from 'react'

import { Icon } from '@/components/brand/Icon'
import { FRAME_BUTTON, FrameButtonLabel } from '@/components/frame/FrameButton'
import { Overlay } from '@/components/ui/media/Overlay'
import { usePopup } from '@/components/ui/usePopup'
import { BOOK_READS, type BookingDays, type BookReads, type DaySessions, type PrivateSession, type PublicSession } from '@/lib/book/api'
import { bookingSummary, chosenSession, londonToday, monthOf, type BookAddOn, type BookView, type ChosenSession } from '@/lib/book/book'
import { addToBag, type BookingLine } from '@/lib/shop/bag'

import { BookAddOns } from './BookAddOns'
import { BookSessions, type DayRead } from './BookSessions'
import { STEP_ROW } from './columns'

type BookFlowProps = {
  addOns: readonly BookAddOn[]
  reads: BookReads
  today: string
}

/**
 * What the panel holds while it is open, from the first day with a session to book (WQ65) to "Your booking". It is
 * made afresh each time the panel opens, so a visitor always starts from what can be booked now: spaces are never
 * held, and the day's sessions are read again whenever the step is come back to.
 */
function BookFlow({ addOns, reads, today }: BookFlowProps) {
  const [step, setStep] = useState<'sessions' | 'add-ons'>('sessions')
  const [view, setView] = useState<BookView>('public')
  const [minutes, setMinutes] = useState<number | null>(null)
  const [month, setMonth] = useState(monthOf(today))
  // This month's answer: the first day with a session to book, and the last day sessions are made for. Null: not read
  // yet, or it could not be read. W78b (WQ78): which days have a session is no longer asked month by month, since
  // every day from today on can be chosen and a day with none says so itself.
  const [opening, setOpening] = useState<BookingDays | null>(null)
  const [day, setDay] = useState<string | null>(null)
  // The last day read. A day is read again when Book is refused and on Change (`turn`); what it showed stays until the new answer.
  const [read, setRead] = useState<{ day: string; sessions: DaySessions | null } | null>(null)
  const [turn, setTurn] = useState(0)
  const [mostPeople, setMostPeople] = useState<DaySessions['mostPeople'] | null>(null)
  const [people, setPeople] = useState<Readonly<Record<string, number>>>({})
  const [asking, setAsking] = useState<string | null>(null)
  const [chosen, setChosen] = useState<ChosenSession | null>(null)
  const [quantities, setQuantities] = useState<Readonly<Record<string, number>>>({})

  const content = useRef<HTMLDivElement>(null)
  const summaryHeading = useRef<HTMLHeadingElement>(null)
  // The session whose Book led to the add-ons step: Change goes back to it.
  const cameFrom = useRef<string | null>(null)
  const stepShown = useRef(step)

  // This month first: its answer says which day the panel opens on (the first with a session to book, in any month).
  const thisMonth = monthOf(today)
  useEffect(() => {
    const stop = new AbortController()
    void reads.days(thisMonth, stop.signal).then((answer) => {
      if (stop.signal.aborted) return
      setOpening(answer)
      // With nothing to book on any day, it opens on today, which says so.
      const first = answer?.firstDay ?? today
      setDay(first)
      setMonth(monthOf(first))
    })
    return () => stop.abort()
  }, [reads, thisMonth, today])

  // The day's sessions, each time a day is chosen and each time it is asked for again.
  useEffect(() => {
    if (!day) return
    const stop = new AbortController()
    void reads.sessions(day, stop.signal).then((sessions) => {
      if (stop.signal.aborted) return
      setRead({ day, sessions })
      if (sessions) setMostPeople(sessions.mostPeople)
    })
    return () => stop.abort()
  }, [reads, day, turn])

  // On a change of step focus goes to the step's start: "Your booking", or back to the session that was booked.
  useEffect(() => {
    if (stepShown.current === step) return
    stepShown.current = step
    if (step === 'add-ons') summaryHeading.current?.focus()
    else (content.current?.querySelector<HTMLElement>(`[data-session="${cameFrom.current ?? ''}"] button[aria-label^="Book"]`) ?? content.current?.querySelector<HTMLElement>('[data-day][tabindex="0"]'))?.focus()
  }, [step])

  // How far the calendar goes: the month of the last day sessions are made for (W77a's `lastDay`).
  const lastDay = opening ? opening.lastDay : null
  const lastMonth = lastDay && monthOf(lastDay) > thisMonth ? monthOf(lastDay) : thisMonth
  const sessions: DayRead = !day || !read || read.day !== day ? 'loading' : (read.sessions ?? 'failed')

  const book = (session: PublicSession | PrivateSession) => {
    if (asking) return
    const count = Math.max(1, Math.min(people[session.id] ?? 1, session.mostPeople))
    setAsking(session.id)
    void reads.quote(session.id, count).then((quote) => {
      setAsking(null)
      const booked = quote ? chosenSession(view, session, count, quote) : null
      if (booked) {
        cameFrom.current = session.id
        setChosen(booked)
        setStep('add-ons')
        return
      }
      // It can't be booked for that many now (full, closed, or fewer spaces): the day is read again and shows why.
      setTurn((now) => now + 1)
    })
  }

  // What the bag is given: the session, the people and the add-ons chosen, never a price.
  const line = (): BookingLine | null =>
    chosen
      ? {
          session: chosen.session.id,
          people: chosen.people,
          addOns: addOns.flatMap((addOn) => ((quantities[addOn.id] ?? 0) > 0 ? [{ addOn: addOn.id, quantity: quantities[addOn.id] ?? 0 }] : [])),
        }
      : null

  const toBag = () => {
    const booking = line()
    if (booking) addToBag(booking)
  }

  return (
    // From 768px one row as tall as the panel, its parts on the panel's own 24 columns wherever those are wide enough
    // for them (W78b, WQ78: components/modules/booking/columns.ts), each scrolling by itself; on a phone one column, 32px between
    // its parts, that scrolls as a whole.
    <div ref={content} data-book-step={step} data-lenis-prevent="" className={`page-grid min-h-0 flex-1 content-start gap-y-32 overflow-y-auto pb-32 ${STEP_ROW}`}>
      {step === 'add-ons' && chosen ? (
        <BookAddOns
          addOns={addOns}
          quantities={quantities}
          onQuantity={(addOn, quantity) => setQuantities((now) => ({ ...now, [addOn]: quantity }))}
          summary={bookingSummary(chosen, addOns, quantities)}
          onChange={() => {
            // Back to the sessions with the day and the people kept; the day is read again, since spaces are never held.
            setTurn((now) => now + 1)
            setStep('sessions')
          }}
          onAddToBag={toBag}
          // Book now will go on to the checkout once there is one (the buying stage); until then it adds to the bag as Add to bag does.
          onBookNow={toBag}
          summaryHeading={summaryHeading}
        />
      ) : (
        <BookSessions
          today={today}
          month={month}
          firstMonth={thisMonth}
          lastMonth={lastMonth}
          onMonth={setMonth}
          day={day}
          onDay={setDay}
          view={view}
          onView={setView}
          minutes={minutes}
          onMinutes={setMinutes}
          sessions={sessions}
          mostPeople={mostPeople}
          people={people}
          onPeople={(session, count) => setPeople((now) => ({ ...now, [session]: count }))}
          onBook={book}
          asking={asking}
        />
      )}
    </div>
  )
}

type BookingPanelProps = {
  open: boolean
  onClose: () => void
  /** The add-ons on sale, with their pictures (lib/book/read.ts). */
  addOns: readonly BookAddOn[]
  /** The panel's three reads: the site's public routes unless a story gives its own. */
  reads?: BookReads
  /** Today in London ("2026-11-26"): the clock's, unless a story says. */
  today?: string
}

/**
 * The booking panel (W77; WQ64-WQ66; Figma "BookingPanel", 1174:13346, over a page 931:10453 and 1399:30343): a Dark
 * panel 12px inside every edge of the window over Wayne's Overlay, with Close at its top right (Figma's MenuButton:
 * 12px in from 768px, 24px down and 16px in on a phone). It holds two steps: the sessions (a calendar, and a day's
 * sessions to book), then the add-ons with "Your booking". For a visitor who isn't signed in; the member's, in-bag,
 * booked and move states wait for sign-in, the bag and the account (see BookSessions and BookingSummary).
 *
 * It slides straight up from below the window, with no fade of its own, while the shade fades in behind it, and
 * closing is the same backwards (Figma 04 Animations, 833:13360 to 1569:60325; on a phone 1576:62740 to 1576:62766).
 * It opens and closes over the short duration with the smooth curve, as the info panel does (W78a; Wayne, 25 Nov:
 * the panels take 320 ms, where the prototype's spring ran 667). With reduced motion on it is just there or not.
 *
 * A popup by the build standards (components/ui/usePopup.ts): focus moves in, to Close; the page behind is inert
 * and does not scroll; Esc, Close and the shade close it; focus goes back to what opened it. What opens and closes
 * it, and the history step that makes Back close it, is the frame's (components/frame/FramePanelsHost.tsx).
 *
 * Every day, session, price and limit in it is W77a's: the add-ons come with the page, and the days, sessions and
 * group prices are asked of the public routes when it opens (lib/book/api.ts).
 */
export function BookingPanel({ open, onClose, addOns, reads = BOOK_READS, today }: BookingPanelProps) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  usePopup({ open, onClose, popup: panel, firstFocus: close })

  // Each opening is a visit of its own: what the panel holds is made afresh, and stays while it slides away.
  const [visit, setVisit] = useState(open ? 1 : 0)
  const [wasOpen, setWasOpen] = useState(open)
  const [day, setDay] = useState(() => today ?? londonToday())
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setVisit(visit + 1)
      setDay(today ?? londonToday())
    }
  }

  return (
    <>
      <Overlay open={open} onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Book"
        data-theme="dark"
        data-book="panel"
        data-frame-popup=""
        // Shut, it waits just below the window: its own height and the 12px it keeps from the edge. Shown at once on
        // opening, so Close can take focus straight away; hidden only when the slide away has finished.
        className={`fixed inset-12 z-30 flex flex-col overflow-clip rounded-s bg-surface-primary pt-64 duration-short ease-smooth md:pt-80 ${open ? 'visible translate-y-0 transition-[translate]' : 'invisible translate-y-[calc(100%_+_var(--spacing-12))] transition-[translate,visibility]'}`}
      >
        {visit > 0 ? <BookFlow key={visit} addOns={addOns} reads={reads} today={day} /> : null}
        {/* Its words are its name: "Close". Outside what scrolls, so it stays put. */}
        <button ref={close} type="button" onClick={onClose} className={`absolute top-24 right-16 md:top-12 md:right-12 ${FRAME_BUTTON}`}>
          <Icon name="close" />
          <FrameButtonLabel>Close</FrameButtonLabel>
        </button>
      </div>
    </>
  )
}
