import { Toggle } from '@/components/ui/form-controls/Toggle'
import type { BookView } from '@/lib/book/book'
import { dayLine } from '@/lib/dates'

/** A no-break space: a line of words not known yet keeps its height with it. */
export const HELD = ' '

type SessionsHeaderProps = {
  /** The day chosen; null until the first day with a session to book is known (WQ65). */
  day: string | null
  view: BookView
  onView: (view: BookView) => void
}

/**
 * Figma "SessionsHeader" (04 Components > Booking, 1174:13060): the day's heading in Label 12 with the Public /
 * Private toggle at its right. The toggle goes beneath the heading wherever the two don't fit on a line (Figma's
 * SessionsHeader wraps, 16px between its lines).
 */
export function SessionsHeader({ day, view, onView }: SessionsHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-12 gap-y-16">
      {/* The heading names the day once one is chosen (WQ65: the first with a session to book), and its place is held until then. */}
      {day ? (
        <h2 className="text-label-12 whitespace-nowrap text-text-primary">{dayLine(day)}</h2>
      ) : (
        <p aria-hidden="true" className="text-label-12">
          {HELD}
        </p>
      )}
      <Toggle
        label="Kind of session"
        name="book-view"
        value={view}
        options={[
          { value: 'public', label: 'Public' },
          { value: 'private', label: 'Private' },
        ]}
        onChange={onView}
      />
    </div>
  )
}
