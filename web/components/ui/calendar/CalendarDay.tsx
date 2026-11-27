'use client'

import { dayName } from '@/lib/book/book'

/**
 * A day's square and a column's heading: 12px round the day's number in Label 12, which is trimmed to its capitals
 * (Figma draws 33: 12, the 9 of the capitals, 12). The number is wider than the room left for it and sits centred.
 * BookingCalendar draws its days of the week in it too.
 */
export const SQUARE = 'flex size-[calc(1cap_+_var(--spacing-24))] shrink-0 items-center justify-center text-label-12'

type CalendarDayProps = {
  /** The day: "2026-11-26". */
  day: string
  /** Figma's State. `past` is a day before today, and only that (W78b, WQ78: a day ahead with no sessions is a day like any other). */
  state: 'default' | 'selected' | 'past'
  /** The one day of the month Tab stops on; the arrow keys move from it. */
  tabStop: boolean
  onChoose: (day: string) => void
}

/**
 * Figma "CalendarDay" (03 UI > Calendar, 577:2888): a day of the month. default: Text/Primary, and Surface/Card
 * Selected under the pointer; selected: Surface/Secondary with Text/Secondary; past: Text/Muted Primary, and a press
 * does nothing. A past day can still take focus, so the keyboard and a screen reader meet every day of the month and
 * hear which can't be chosen.
 */
export function CalendarDay({ day, state, tabStop, onChoose }: CalendarDayProps) {
  const look = {
    default: 'text-text-primary hover:bg-surface-card-selected',
    selected: 'bg-surface-secondary text-text-secondary',
    past: 'cursor-default text-text-muted-primary',
  }[state]
  return (
    <button
      type="button"
      data-day={day}
      aria-label={dayName(day)}
      aria-pressed={state === 'selected'}
      aria-disabled={state === 'past'}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => {
        if (state !== 'past') onChoose(day)
      }}
      className={`${SQUARE} rounded-s transition-colors duration-short ease-smooth ${look}`}
    >
      {Number(day.slice(8))}
    </button>
  )
}
