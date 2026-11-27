import type { BookingSummaryView } from '@/lib/book/book'

type SummarySessionProps = {
  summary: Pick<BookingSummaryView, 'service' | 'startsAt' | 'when' | 'detail'>
  /** Back to the sessions step, with the day and the people kept. */
  onChange: () => void
}

/**
 * Figma "SummarySession" (04 Components > Booking, 1174:163), the session in BookingSummary's "Your Booking": the
 * service with "Change" at its right (Link 12, Text/Muted Primary), when it is (WQ69: "08:00 - Thursday 12
 * November") and what it is ("60 min - Public - Off-Peak"; private: "60 min - Private"), 8px apart.
 */
export function SummarySession({ summary, onChange }: SummarySessionProps) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-8">
        <p className="min-w-0 text-label-12 text-text-primary">{summary.service}</p>
        {/* The link is as tall as its capitals: the press reaches 8px round it. */}
        <button type="button" onClick={onChange} className="relative shrink-0 text-link-12 text-text-muted-primary after:absolute after:-inset-8">
          Change<span className="sr-only"> the session</span>
        </button>
      </div>
      <p className="text-copy-12 text-text-primary">
        <time dateTime={summary.startsAt}>{summary.when}</time>
      </p>
      <p className="text-copy-12 text-text-muted-primary">{summary.detail}</p>
    </div>
  )
}
