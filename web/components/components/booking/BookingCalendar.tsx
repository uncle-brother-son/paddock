'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import { IconButton } from '@/components/ui/buttons/IconButton'
import { CalendarDay, SQUARE } from '@/components/ui/calendar/CalendarDay'
import { addDays, addMonths, CALENDAR_DAYS, monthOf, monthTitle, monthWeeks } from '@/lib/book/book'

type BookingCalendarProps = {
  /** The month on show: "2026-11". */
  month: string
  /** Today in London: every day before it is past, and can't be chosen; today and every day after it can. */
  today: string
  /** The day chosen, in this month or another; null with none. */
  chosen: string | null
  /** The first and last months the arrows go to: this month, and the month of the last day sessions are made for. */
  firstMonth: string
  lastMonth: string
  onMonth: (month: string) => void
  onChoose: (day: string) => void
  className?: string
}

/**
 * Figma "BookingCalendar" (04 Components > Booking, 1150:10981): a Surface/Card card, 12px inside, holding the month's name and its
 * two arrows, then 24px beneath the days of the week and six weeks of days (6px apart), Monday first. A day outside
 * the month is blank. The card is always six weeks tall, as drawn, so nothing beneath it moves from month to month.
 *
 * W78b (WQ78): every day from today on can be chosen and is drawn as a day (State=default), whether or not it has a
 * session to book: one with none says so where its sessions would be (BookSessions, Figma's Day=none). Only the
 * days before today are past: drawn muted, and a press does nothing.
 *
 * The days are a grid for the keyboard (docs/build-standards.md, section 1): Tab stops on one day (the chosen one,
 * else the first that can be chosen), and from it Left and Right move a day, Up and Down a week, Home and End to the
 * week's ends, Page Up and Page Down a month. Moving past the month's end goes into the next month when there is
 * one. The arrows stop at this month and at the month of the last day sessions are made for.
 */
export function BookingCalendar({ month, today, chosen, firstMonth, lastMonth, onMonth, onChoose, className }: BookingCalendarProps) {
  const grid = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // The day the keyboard is on, once it has moved: it keeps the Tab stop, and takes focus when its month arrives.
  const [at, setAt] = useState<string | null>(null)
  const focusAsked = useRef(false)

  const weeks = monthWeeks(month)
  const days = weeks.flat().filter((day): day is string => day !== null)
  const canChoose = (day: string) => day >= today
  const tabStop = (at && monthOf(at) === month ? at : null) ?? (chosen && monthOf(chosen) === month ? chosen : null) ?? days.find(canChoose) ?? days[0] ?? null

  useEffect(() => {
    if (!focusAsked.current || !at || monthOf(at) !== month) return
    focusAsked.current = false
    grid.current?.querySelector<HTMLElement>(`[data-day="${at}"]`)?.focus()
  }, [at, month])

  const moveTo = (day: string) => {
    const target = monthOf(day)
    if (target < firstMonth || target > lastMonth) return
    focusAsked.current = true
    setAt(day)
    if (target !== month) onMonth(target)
  }

  // A day chosen is where the keyboard is from then on.
  const choose = (day: string) => {
    setAt(day)
    onChoose(day)
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = (event.target as HTMLElement).closest<HTMLElement>('[data-day]')?.dataset.day
    if (!from) return
    // Monday is column 0.
    const column = (new Date(`${from}T00:00:00Z`).getUTCDay() + 6) % 7
    const sameDate = (to: string) => `${to}-${String(Math.min(Number(from.slice(8)), new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5)), 0)).getUTCDate())).padStart(2, '0')}`
    const to = {
      ArrowLeft: () => addDays(from, -1),
      ArrowRight: () => addDays(from, 1),
      ArrowUp: () => addDays(from, -7),
      ArrowDown: () => addDays(from, 7),
      Home: () => addDays(from, -column),
      End: () => addDays(from, 6 - column),
      PageUp: () => sameDate(addMonths(month, -1)),
      PageDown: () => sameDate(addMonths(month, 1)),
    }[event.key]
    if (!to) return
    event.preventDefault()
    moveTo(to())
  }

  return (
    <div data-book="calendar" className={`flex flex-col gap-24 rounded-s bg-surface-card p-12 ${className ?? ''}`}>
      <div className="flex items-center justify-between">
        <h2 id={titleId} aria-live="polite" className="text-label-12 text-text-primary">
          {monthTitle(month)}
        </h2>
        <div className="flex items-center gap-8">
          {/* Figma "IconButton", Style=page: Surface/Card Selected under a mouse; at the first and last month, disabled. */}
          <IconButton icon="chevron" iconClassName="rotate-90" label="Previous month" disabled={month <= firstMonth} onClick={() => onMonth(addMonths(month, -1))} />
          <IconButton icon="chevron" iconClassName="-rotate-90" label="Next month" disabled={month >= lastMonth} onClick={() => onMonth(addMonths(month, 1))} />
        </div>
      </div>
      <div ref={grid} role="grid" aria-labelledby={titleId} onKeyDown={onKey} className="flex flex-col gap-4">
        <div role="row" className="flex items-center justify-between py-8">
          {CALENDAR_DAYS.map(({ short, name }) => (
            <span key={short} role="columnheader" aria-label={name} className={`${SQUARE} h-auto text-text-primary`}>
              {short}
            </span>
          ))}
        </div>
        <div role="rowgroup" className="flex flex-col gap-6">
          {weeks.map((week, index) => (
            // A week with no day of the month keeps its place and is nothing to a screen reader.
            <div key={index} role="row" aria-hidden={week.every((day) => day === null) ? true : undefined} className="flex items-center justify-between">
              {week.map((day, column) =>
                day ? (
                  <div key={column} role="gridcell" aria-selected={day === chosen} className="flex">
                    <CalendarDay day={day} state={day === chosen ? 'selected' : canChoose(day) ? 'default' : 'past'} tabStop={day === tabStop} onChoose={choose} />
                  </div>
                ) : (
                  <div key={column} role="gridcell" className={SQUARE} />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
